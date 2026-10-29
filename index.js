/**
 * Host half of the "council" (小组) bundle.
 *
 * Owns: roles, members, groups, per-member usage, and the commander/worker
 * dispatch pipeline. Public surface is a small JSON HTTP API under
 * /council/api that the Client half calls with same-origin fetch.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'storages', 'council.json')
const IMAGE_DIR = path.join(DSH_HOME, 'storages', 'council-images')
const PROFILE_CANDIDATES = [
  process.env.DSH_PROFILE_DIR,
  path.join(os.homedir(), '.dsh', 'profiles', 'web'),
].filter(Boolean)
const CODEX_BIN = process.env.COUNCIL_CODEX_BIN || 'codex'

/** 命令是否存在：避免 spawn 失败时只抛 ENOENT。 */
async function commandExists(bin) {
  if (!bin) return false
  if (bin.includes('/')) return existsSync(bin)
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    if (existsSync(path.join(dir, bin))) return true
  }
  return false
}

function claudeBinary() {
  if (process.env.COUNCIL_CLAUDE_BIN) return process.env.COUNCIL_CLAUDE_BIN
  for (const dir of PROFILE_CANDIDATES) {
    const candidate = path.resolve(dir, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude')
    if (existsSync(candidate)) return candidate
  }
  return 'claude'
}

const EMPTY = { roles: [], members: [], groups: [], usage: {}, runs: [], config: undefined }

let state = structuredClone(EMPTY)
let loaded = false

async function load() {
  if (loaded) return
  try {
    state = { ...structuredClone(EMPTY), ...JSON.parse(await readFile(STATE_FILE, 'utf8')) }
  } catch {
    state = structuredClone(EMPTY)
  }
  // A restart kills in-flight runs; never leave them "running" forever.
  let repaired = 0
  for (const run of state.runs || []) {
    if (run.status !== 'running') continue
    run.status = 'done'
    run.endedAt = Date.now()
    run.interrupted = true
    for (const slot of run.members || []) {
      if (slot.status === 'running' || slot.status === 'pending') {
        slot.status = 'failed'
        slot.error = '进程重启，这次派发被中断（重发一次即可）'
        slot.endedAt = Date.now()
      }
    }
    repaired += 1
  }
  if (repaired) { try { await save() } catch { /* ignore */ } }
  loaded = true
  pruneGroups()
}

/** Drop groups nobody uses: no members and no dispatch history. */
function pruneGroups() {
  const before = state.groups.length
  state.groups = (state.groups || []).filter((group) => {
    const members = (group.memberIds || []).length
    const runs = (state.runs || []).some((run) => run.groupId === group.id)
    return members > 0 || runs
  })
  if (state.groups.length !== before) {
    if (state.activeGroupId && !state.groups.some((g) => g.id === state.activeGroupId)) state.activeGroupId = undefined
    save().catch(() => {})
  }
  return before - state.groups.length
}

let saving = Promise.resolve()
function save() {
  const body = JSON.stringify(state, null, 2)
  saving = saving.then(async () => {
    await mkdir(path.dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, body, 'utf8')
  }).catch((error) => { ctx0?.logger?.('council').warn?.(`save failed: ${error?.message ?? error}`) })
  return saving
}

let ctx0

/** Collect stdout+stderr of one child process; caller owns the timeout. */
function run(bin, args, { cwd, env, input, timeoutMs = 6 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (b) => { out += b })
    child.stderr.on('data', (b) => { err += b })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: `${err}${e.message}` }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
    if (input !== undefined) { child.stdin.write(input); child.stdin.end() }
    else child.stdin.end()
  })
}

function jsonLines(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try { rows.push(JSON.parse(trimmed)) } catch { /* skip partial */ }
  }
  return rows
}

/** One Codex turn. Resumes the stored thread when present. */
async function runCodex({ cwd, model, resume, prompt, env }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd]
  if (model) args.push('--model', model)
  if (resume) args.push('resume', resume, prompt)
  else args.push(prompt)
  const { code, out, err } = await run(CODEX_BIN, args, { cwd, env })
  const events = jsonLines(out)
  const started = events.find((e) => e.type === 'thread.started')
  const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
  const done = [...events].reverse().find((e) => e.type === 'turn.completed')
  const text = messages.map((e) => e.item.text).join('\n').trim()
  const usage = done?.usage ?? {}
  return {
    ok: code === 0 && text.length > 0,
    text,
    convId: resume ?? started?.thread_id,
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      costUsd: 0,
    },
    error: code === 0 ? undefined : (err.trim().slice(-600) || `codex exited ${code}`),
  }
}

/** One Claude Code turn. Resumes the stored session when present. */
async function runClaude({ cwd, model, resume, prompt, env, noTools }) {
  const claudeBin = claudeBinary()
  if (!(await commandExists(claudeBin))) {
    return { ok: false, text: '', error: '未找到 claude CLI（' + claudeBin + '）。装 dsh-subagent-claude-code bundle，或用 COUNCIL_CLAUDE_BIN 指定绝对路径。', usage: null }
  }
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions']
  if (model) args.push('--model', model)
  if (noTools) args.push('--disallowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit')
  if (resume) args.push('--resume', resume)
  const { code, out, err } = await run(claudeBin, args, { cwd, env })
  const events = jsonLines(out)
  const texts = []
  for (const event of events) {
    if (event.type !== 'assistant') continue
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }
  const result = events.find((e) => e.type === 'result')
  const sessionId = result?.session_id ?? events.find((e) => e.session_id)?.session_id
  const text = (result?.result ?? texts.join('\n')).trim()
  const usage = result?.usage ?? {}
  return {
    ok: code === 0 && Boolean(result) && result.is_error !== true,
    text,
    convId: resume ?? sessionId,
    usage: {
      input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      output: usage.output_tokens ?? 0,
      costUsd: result?.total_cost_usd ?? 0,
    },
    error: code === 0 ? undefined : (err.trim().slice(-600) || `claude exited ${code}`),
  }
}

/** One image-generation turn against the relay; stores a PNG the page can show. */
async function runImage(member, prompt, config) {
  const token = apiSettings(config).imageKey
  if (!token) return { ok: false, text: '', error: 'no image api key configured', usage: null }
  const model = member.model || 'gpt-image-2.5-flare'
  try {
    const response = await fetch(rootUrl(apiSettings(config).codexBase || defaultBase('openai', apiSettings(config).imageKey)) + '/v1/images/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024' }),
      signal: AbortSignal.timeout(240_000),
    })
    const data = await response.json()
    const b64 = data?.data?.[0]?.b64_json
    if (!response.ok || !b64) {
      return { ok: false, text: '', error: JSON.stringify(data).slice(0, 400), usage: null }
    }
    const name = randomUUID() + '.png'
    await mkdir(IMAGE_DIR, { recursive: true })
    const file = path.join(IMAGE_DIR, name)
    await writeFile(file, Buffer.from(b64, 'base64'))
    return { ok: true, text: '已生成图片（' + model + '）', image: '/council/api/image/' + name, file, usage: { input: 0, output: 0, costUsd: 0 } }
  } catch (error) {
    return { ok: false, text: '', error: String(error?.message ?? error), usage: null }
  }
}

/** Read a session's committed events through whichever reader this build exposes. */
function sessionEvents(session) {
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
    if (typeof session.ownEvents === 'function') return session.ownEvents()
  } catch { /* fall through */ }
  return []
}

/** Resolve the deployment's default agent preset and the setup that mounts it. */
async function agentComposition(ctx) {
  const presets = ctx.get('agentPresets')
  if (!presets) return {}
  try {
    const resolved = await presets.resolve(undefined)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => { await presets.mount(agentCtx, resolved.id) },
    }
  } catch { return {} }
}

/** One turn on a real DSH agent session (DeepSeek family). */
/** Run one DeepSeek member through the subagent seam (concurrency + cancellation owned by it). */

/** Continue an already-created child agent instead of spawning a new one. */
async function continueChild(ctx, parent, member, prompt, timeoutMs) {
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')
  if (!subagents || !agents || typeof subagents.sendMessage !== 'function') return null
  try {
    await subagents.sendMessage(parent, member.convId, [{ type: 'text', text: prompt }], { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    console.error('[council] reuse sendMessage failed:', String((error && error.stack) || error))
    return null
  }
  const deadline = Date.now() + timeoutMs
  await new Promise((resolve) => setTimeout(resolve, 800))
  while (Date.now() < deadline) {
    const agent = agents.get(member.convId)
    if (agent && agent.status === 'idle') {
      // a continued child can answer across several steps: keep every assistant
      // message of THIS turn, otherwise a long delivery gets cut to its last chunk
      let text = ''
      let truncated = false
      let marker = -1
      try {
        const events = sessionEvents(agent.session)
        // walk back to the message we sent, then forward to the end
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const ev = events[i]
          if (ev.type === 'user/message') { marker = i; break }
        }
        const sliceStart = marker >= 0 ? marker + 1 : 0
        const parts = []
        for (let i = sliceStart; i < events.length; i += 1) {
          const ev = events[i]
          if (ev.type === 'turn/end') {
            const reason = ev.data && ev.data.reason
            if (reason && (reason.kind === 'max-tokens' || reason.kind === 'maxTokens')) truncated = true
          }
          if (ev.type !== 'assistant/message') continue
          const chunk = (ev.data.message.content || [])
            .filter((b) => b && b.type === 'text')
            .map((b) => b.text).join('\n').trim()
          if (chunk) parts.push(chunk)
        }
        text = parts.join('\n\n').trim()
      } catch { /* ignore */ }
      return {
        ok: Boolean(text),
        text,
        convId: member.convId,
        error: text ? undefined : '复用子 agent 没有产出文本',
        truncated,
        usage: null,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

async function runDeepseekViaSeam(ctx, member, prompt, config, parent, timeoutMs = 6 * 60_000, presetId) {
  const subagents = ctx.get('subagents')
  if (!subagents || !parent) {
    return { ok: false, text: '', error: 'DSH subagent seam unavailable (no parent agent)', usage: null }
  }
  if (!subagents.getProvider('spawn')) {
    return { ok: false, text: '', error: 'spawn subagent provider is not registered', usage: null }
  }
  const reuseEnabled = Boolean((state.config && state.config.reuseAgents) || (config && config.reuseAgents) || member.__reuse)
  const reviewSlot = presetId === 'minimal'
  if (reviewSlot && reuseEnabled && member.__reviewConvId) {
    member.convId = member.__reviewConvId
  }
  if (reuseEnabled && member.convId) {
    const reused = await continueChild(ctx, parent, member, prompt, timeoutMs)
    if (reused && reused.truncated) {
      return { ok: false, text: reused.text, error: '成员回复被 max-tokens 截断（本轮产出不完整）', usage: null }
    }
    if (reused) return reused
  }
  try {
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: member.name,
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        ...presetId === undefined ? {} : { agentPreset: presetId },
        cwd: member.cwd || config.defaultWorkspace || process.cwd(),
        agentOptions: {
          provider: member.provider || 'deepseek-official',
          model: member.model || 'deepseek-flash',
          // reviews only need a verdict: drop the default high reasoning effort
          ...presetId === 'minimal' ? { reasoningEffort: 'low' } : {},
        },
      },
      signal: AbortSignal.timeout(timeoutMs),
      delivery: 'caller',
    })
    try {
      const result = await activation.result
      const text = (result.output || [])
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      return {
        ok: Boolean(text) && result.stopReason === 'completed',
        text,
        convId: activation.childId,
        error: text ? undefined : ('stop: ' + result.stopReason + (result.diagnostic ? ' · ' + result.diagnostic : '')),
        usage: null,
      }
    } finally {
      // keep the child resident when reuse is enabled, otherwise it cannot be continued
      if (!reuseEnabled) {
        try { await activation.dispose() } catch { /* already gone */ }
      }
    }
  } catch (error) {
    return { ok: false, text: '', error: 'subagent failed: ' + String(error?.message ?? error), usage: null }
  }
}

async function runDeepseek(ctx, member, prompt, config) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, text: '', error: 'DSH agent service unavailable', usage: null }
  }
  const agentOptions = { provider: member.provider || 'deepseek-official', model: member.model || 'deepseek-flash' }
  const composition = await agentComposition(ctx)
  let handle
  try {
    handle = member.convId
      ? await agents.resume({
        resumeSessionId: member.convId,
        agentOptions,
        ...composition.setup === undefined ? {} : { setup: composition.setup },
      })
      : await agents.create({
        sessionId: 'session-' + randomUUID(),
        meta: {
          cwd: member.cwd || config.defaultWorkspace || process.cwd(),
          origin: 'subagent',
          ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
        },
        agentOptions,
        ...composition.setup === undefined ? {} : { setup: composition.setup },
      })
  } catch (error) {
    return { ok: false, text: '', error: 'agent start failed: ' + String(error?.message ?? error), usage: null }
  }
  try {
    const agent = handle.agent
    const before = sessionEvents(agent.session).length
    agent.followup({
      id: 'msg_' + randomUUID(),
      time: Date.now(),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: prompt }],
    })
    await agent.whenIdle()
    const replies = sessionEvents(agent.session).slice(before).filter((e) => e.type === 'assistant/message')
    const last = replies[replies.length - 1]
    const text = last
      ? (last.data.message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      : ''
    const usage = last?.data?.usage ?? {}
    member.convId = agent.id
    return {
      ok: Boolean(text),
      text,
      convId: agent.id,
      usage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, costUsd: 0 },
    }
  } catch (error) {
    return { ok: false, text: '', error: 'agent turn failed: ' + String(error?.message ?? error), usage: null }
  } finally {
    try { await handle.dispose() } catch { /* already gone */ }
  }
}

/** Ask an Anthropic-family member whether an image matches the group style. */
async function reviewImage(ctx, group, result, config, styleOverride) {
  const inGroup = (m) => (group.memberIds || []).indexOf(m.id) >= 0
  const reviewerId = (group.reviewerId && inGroup({ id: group.reviewerId }) ? group.reviewerId : undefined)
    || (state.members.find((m) => inGroup(m) && m.kind === 'claude') || {}).id
  const reviewer = state.members.find((m) => m.id === reviewerId)
  if (!reviewer || reviewer.kind !== 'claude' || !result.file) return null
  const prompt = [
    '你是这个小组的总画师审校。统一风格规范：',
    String(styleOverride || group.style || ''),
    '',
    '只允许用 Read 打开这一个文件（不要用其它工具、不要浏览目录）：' + result.file,
    '画面要求：' + (result.task || ''),
    '',
    '只输出一个 JSON 对象，不要其它文字：',
    '{"ok":true 或 false,"reason":"不超过 80 字的中文理由"}',
  ].join('\n')
  const review = await runClaude({
    cwd: group.workspacePath || config.defaultWorkspace || process.cwd(),
    model: reviewer.model,
    prompt,
    env: await envFor('claude', config),
  })
  const match = String(review.text || '').match(/\{[\s\S]*\}/)
  let parsed = null
  if (match) {
    try {
      const value = JSON.parse(match[0])
      parsed = { ok: value.ok === true, reason: String(value.reason ?? '') }
    } catch { parsed = null }
  }
  const verdict = parsed ?? { ok: null, reason: review.ok ? '审校输出无法解析' : (review.error || '审校失败') }
  verdict.by = reviewer.name
  return verdict
}

/** Effective API settings: the page's own config first, the profile config second. */
function apiSettings(config) {
  const own = (state && state.config) || {}
  return {
    claudeKey: own.claudeKey || config.claudeApiKey || '',
    claudeBase: rootUrl(own.claudeBase || config.claudeBaseUrl || '') || defaultBase('claude', own.claudeKey || config.claudeApiKey),
    imageKey: own.imageKey || config.imageApiKey || '',
    codexToken: own.codexToken || '',
    codexBase: rootUrl(own.codexBase || config.codexBaseUrl || '') || defaultBase('openai', own.codexToken),
  }
}




/* ── 代理支持：只影响插件自己发出的 HTTP 请求（官方端点在国内需要它） ── */
let proxyApplied = null

async function loadUndici() {
  const argv1 = process.argv[1] ? path.dirname(process.argv[1]) : ''
  const candidates = []
  if (argv1) candidates.push(path.join(argv1, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'undici', 'index.js'))
  for (const file of candidates) {
    if (existsSync(file)) {
      try { return await import(pathToFileURL(file).href) } catch { /* 试下一个 */ }
    }
  }
  try { return await import('undici') } catch { return null }
}

/** 配置了 proxyUrl 就把它设成全局 dispatcher；返回实际生效的代理地址。 */
async function applyProxy(config) {
  const url = String((state.config && state.config.proxyUrl) || config.proxyUrl || '').trim()
  if (!url) { proxyApplied = null; return '' }
  if (proxyApplied === url) return url
  // 代理没起来时不要让所有请求一起死：先探一下端口，连不上就直连
  const reachable = await new Promise((resolve) => {
    try {
      const u = new URL(url)
      const socket = net.connect({ host: u.hostname, port: Number(u.port) || 80, timeout: 800 }, () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
      socket.on('timeout', () => { socket.destroy(); resolve(false) })
    } catch { resolve(false) }
  })
  if (!reachable) {
    console.error('[council] 代理不可达，本次直连：' + url)
    proxyApplied = null
    return ''
  }
  const undici = await loadUndici()
  if (!undici || !undici.ProxyAgent) {
    console.error('[council] proxyUrl 已配置但 undici 不可用，请求将继续直连')
    return ''
  }
  try {
    undici.setGlobalDispatcher(new undici.ProxyAgent(url))
    proxyApplied = url
    return url
  } catch (error) {
    console.error('[council] 代理设置失败:', String(error?.message ?? error))
    return ''
  }
}

/** 只填了 key 时的官方默认地址推断（填了 URL 的一律用填的） */
function defaultBase(kind, key) {
  const k = String(key || '')
  if (kind === 'claude') return k.startsWith('sk-ant-') ? 'https://api.anthropic.com' : ''
  if (kind === 'openai') return k ? 'https://api.openai.com' : ''
  return ''
}

/** 把用户填的 base 归一成根地址（去掉尾部 / 与 /v1），各处调用时再拼自己的路径 */
function proxyEnv(config) {
  const url = String((state.config && state.config.proxyUrl) || config.proxyUrl || '').trim()
  return url ? { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url } : {}
}

function rootUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '')
}


/** 用插件配置里的 base/key 生成一个独立 CODEX_HOME，官方 OpenAI 与中转站都能直接登录。 */
async function ensureCodexHome(config) {
  const settings = apiSettings(config)
  const key = settings.codexToken || await codexToken()
  const base = rootUrl(settings.codexBase)
  if (!key && !base) return config.codexHome || undefined   // 完全没配 → 用用户自己的 ~/.codex
  const dir = path.join(os.homedir(), '.dsh', 'storages', 'council-codex')
  const wire = String(config.codexWireApi || 'responses')
  const model = String(config.codexDefaultModel || '')
  const authKey = key || ''
  const lines = []
  if (model) lines.push(`model = "${model}"`)
  lines.push('model_provider = "council"')
  lines.push('sandbox_mode = "danger-full-access"')
  lines.push('')
  lines.push('[model_providers.council]')
  lines.push('name = "council"')
  lines.push(`base_url = "${base ? base + '/v1' : 'https://api.openai.com/v1'}"`)
  lines.push(`wire_api = "${wire}"`)
  if (authKey) lines.push(`experimental_bearer_token = "${authKey.replace(/"/g, '')}"`)
  const content = lines.join('\n') + '\n'
  try {
    const prev = await readFile(path.join(dir, 'config.toml'), 'utf8').catch(() => null)
    if (prev !== content) {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'config.toml'), content, 'utf8')
    }
  } catch (error) {
    console.error('[council] codex home 生成失败:', String(error?.message ?? error))
  }
  return dir
}

async function envFor(kind, config) {
  if (kind === 'claude') {
    const settings = apiSettings(config)
    return Object.assign({
      ANTHROPIC_BASE_URL: rootUrl(settings.claudeBase) || undefined,
      ANTHROPIC_API_KEY: settings.claudeKey || undefined,
    }, proxyEnv(config))
  }
  const home = await ensureCodexHome(config)
  return Object.assign({}, home ? { CODEX_HOME: home } : {}, proxyEnv(config))
}

/** The member playing a named role inside one group (指挥 / 审校). */
function memberWithRole(group, roleName) {
  const role = (state.roles || []).find((r) => r.name === roleName || r.name.indexOf(roleName) === 0)
  if (!role) return undefined
  return (group.memberIds || [])
    .map((id) => state.members.find((m) => m.id === id))
    .find((m) => m && m.roleId === role.id)
}

function roleOf(member) {
  return state.roles.find((r) => r.id === member.roleId)
}

function memberPrompt(member, task) {
  const role = roleOf(member)
  const head = role
    ? `[你的职位] ${role.name}\n[职位职责与风格]\n${role.prompt || '（未填写）'}\n\n`
    : ''
  return `${head}[任务]\n${task}`
}

function account(memberId, usage) {
  const row = state.usage[memberId] ?? { calls: 0, input: 0, output: 0, costUsd: 0 }
  row.calls += 1
  row.input += usage.input ?? 0
  row.output += usage.output ?? 0
  row.costUsd += usage.costUsd ?? 0
  state.usage[memberId] = row
}

const WORK_STYLE = '\n\n【工作方式】你可以使用你所在框架的全部工具（读写文件、跑命令、联网等），上下文和工具不会被裁剪；任务适合并行时，鼓励你自行开子代理分担，最后由你汇总。'

/** Parse one {"ok":boolean,"reason":string} verdict from free text. */
function verdictOf(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const value = JSON.parse(match[0])
    return { ok: value.ok === true, reason: String(value.reason ?? '') }
  } catch { return null }
}

/** One turn on the member's own framework, preserving its session and tools. */


async function runKind(ctx, member, prompt, config, group, styleOverride, parent, timeoutMs) {
  await applyProxy(config)
  const cwd = member.cwd || config.defaultWorkspace || process.cwd()
  let result
  if (member.kind === 'image') {
    const style = String(styleOverride || (group && group.style) || '')
    const imagePrompt = style ? `[统一风格规范]\n${style}\n\n[画面]\n${prompt}` : prompt
    result = await runImage(member, imagePrompt, config)
  } else if (member.kind === 'deepseek') {
    result = await runDeepseekViaSeam(ctx, member, prompt, config, parent, timeoutMs, member.__preset)
  } else {
    if (member.kind === 'claude') {
      const cfgCheck = apiSettings(config)
      if (!cfgCheck.claudeBase || !cfgCheck.claudeKey) {
        return { ok: false, text: '', error: '未配置 claude 的 API 地址或密钥（在「小组」页 ① 里填 claude base URL + key）' }
      }
    }
    const runner = member.kind === 'claude' ? runClaude : runCodex
    result = await runner({
      cwd,
      model: member.model || undefined,
      resume: member.convId || undefined,
      prompt,
      env: await envFor(member.kind, config),
      noTools: Boolean(member.__noTools),
    })
  }
  if (result.convId) member.convId = result.convId
  if (result.usage) account(member.id, result.usage)
  return result
}

/** Stage one: the producing agent reviews its own output in its own session. */
async function selfReview(ctx, member, task, output, config, group, styleOverride, parent) {
  if (member.kind === 'image') {
    const verdict = await reviewImage(ctx, group, { file: output.file, task }, config, styleOverride)
    return verdict ? { ok: verdict.ok, reason: verdict.reason, by: verdict.by } : null
  }
  const prompt = [
    '【自审】检查你刚才的产出是否满足任务要求。',
    '[原任务]',
    task,
    '[你的产出]',
    output.text,
    '只输出一个 JSON：{"ok":true 或 false,"reason":"不超过 60 字"}',
  ].join('\n')
  const result = await runKind(ctx, member, prompt, config, group, undefined, parent)
  let parsed = verdictOf(result.text)
  if (parsed === null && result.ok) {
    const retry = await runKind(ctx, member, prompt + '\n\n注意：只输出 JSON，不要任何解释或前后缀。', config, group)
    parsed = verdictOf(retry.text)
  }
  const verdict = parsed ?? { ok: null, reason: result.ok ? '自审输出无法解析（已重试一次）' : (result.error || '自审失败') }
  verdict.by = member.name
  return verdict
}

/** Preliminary check by the member holding the 审校 role. */
async function prelimReview(ctx, group, member, task, output, config, styleOverride, parent, brief) {
  const reviewer = memberWithRole(group, '审校')
  if (!reviewer) return null
  if (output && output.image) {
    return reviewImage(ctx, group, { file: output.file, task }, config, styleOverride)
  }
  const prompt = [
    '你是这个小组的审校，做初步校验（之后还有指挥的最终审核）。',
    '禁止使用任何工具（bash / read / glob / 搜索等），也不要浏览文件系统；只根据下面的信息判断，立即只输出 JSON。',
    '注意：你看不到磁盘，所以不要以"缺截图/缺文件/缺附件"为由判不通过；只要产出文本里说明了产物路径与验证结果，就按已交付处理，只挑文本层面的缺失（漏项、口径矛盾、阈值不符）。',
    ...(brief ? ['[背景]', brief, ''] : []),
    `成员 ${member.name}（${member.kind}）完成了任务：${task}`,
    '[产出]',
    String((output && output.text) || output || '').slice(0, 4000),
    '只输出一个 JSON：{"ok":true 或 false,"reason":"不超过 60 字"}',
  ].join('\n')
  const reviewChildKey = '__reviewConvId'
  reviewer[reviewChildKey] = (state.reviewChildren || {})[reviewer.id]
  const result = await runKind(ctx, Object.assign({}, reviewer, { convId: reviewer[reviewChildKey], __preset: 'minimal', __noTools: true }), prompt, config, group, undefined, parent, 120_000)
  if (result && result.convId) { state.reviewChildren = state.reviewChildren || {}; state.reviewChildren[reviewer.id] = result.convId; save().catch(() => {}) }
  let parsed = verdictOf(result.text)
  if (parsed === null && result.ok) {
    const retry = await runKind(ctx, Object.assign({}, reviewer, { convId: reviewer[reviewChildKey], __preset: 'minimal', __noTools: true }), prompt + '\n\n注意：只输出 JSON，不要任何解释或前后缀。', config, group, undefined, parent, 120_000)
    parsed = verdictOf(retry.text)
  }
  const verdict = parsed ?? { ok: null, reason: result.ok ? '审校输出无法解析（已重试一次）' : (result.error || '审校失败') }
  verdict.by = reviewer.name
  return verdict
}

/** Stage two: the commander accepts or rejects the delivered work. */
async function commanderReview(ctx, group, member, task, output, config, parent, brief, styleOverride) {
  // 指挥 is whichever member holds the 指挥 role in this group.
  const commanderMember = memberWithRole(group, '指挥')
  if (commanderMember && output && output.image && output.file) {
    // 图片产出：任何腿都要真看图（claude 用 Read，deepseek 子代理用 read_image）
    const style = String(styleOverride || (group && group.style) || '')
    const filePath = JSON.stringify(String(output.file))
    const imagePrompt = [
      '你是这个小组的指挥，现在对这张图做最终验收。',
      '统一风格规范：' + (style || '（未指定，按画面要求判断）'),
      '',
      '只允许读取下面这一个文件（不要浏览目录、不要对其余文件调用任何工具）：' + filePath,
      '画面要求：' + task,
      '',
      '只输出一个 JSON：{"ok":true 或 false,"reason":"不超过 80 字的中文理由"}',
    ].join('\n')
    const imgReviewer = Object.assign({}, commanderMember, { convId: commanderMember.convId, __reuse: true })
    let seen = await runKind(ctx, imgReviewer, imagePrompt, config, group, styleOverride, parent, 120_000)
    let parsed = verdictOf(seen.text)
    if (parsed === null && seen.ok) {
      const retry = await runKind(ctx, imgReviewer, imagePrompt + '\n\n注意：只输出 JSON，不要任何解释。', config, group, styleOverride, parent, 120_000)
      parsed = verdictOf(retry.text)
    }
    const verdict = parsed ?? { ok: null, reason: seen.ok ? '指挥看图后输出无法解析（已重试一次）' : (seen.error || '指挥读图失败') }
    verdict.by = commanderMember.name
    if (parsed === null) console.error('[council] commander image review unparsed:', String(seen.text || '').slice(0, 200))
    return verdict
  }
  if (commanderMember) {
    const prompt = [
      '你是这个小组的指挥，现在做验收。',
      '禁止使用任何工具，也不要浏览文件系统；只根据下面的信息判断，立即只输出 JSON。',
      '注意：你看不到磁盘，不要以"缺截图/缺文件"为由驳回；只判文本层面的缺失与矛盾。',
      ...(brief ? ['[背景]', brief, ''] : []),
      `成员 ${member.name}（${member.kind}）完成了任务：${task}`,
      '[产出]',
      String((output && output.text) || output || '').slice(0, 4000),
      '只输出一个 JSON：{"ok":true 或 false,"reason":"不超过 60 字"}',
    ].join('\n')
    // Never resume the commander member's own thread: reviews are side-channel.
    const reviewMember = Object.assign({}, commanderMember, { convId: commanderMember.convId, __preset: 'minimal', __noTools: true, __reuse: true })
    const result = await runKind(ctx, reviewMember, prompt, config, group, undefined, parent, 120_000)
    let parsed = verdictOf(result.text)
    if (parsed === null && result.ok) {
      const retry = await runKind(ctx, reviewMember, prompt + '\n\n注意：只输出 JSON，不要任何解释或前后缀。', config, group, undefined, parent, 120_000)
      parsed = verdictOf(retry.text)
    }
    const verdict = parsed ?? { ok: null, reason: result.ok ? '指挥审核输出无法解析（已重试一次）' : (result.error || '审核失败') }
    verdict.by = commanderMember.name
    return verdict
  }
  return null
}

/** Ask the acceptance-commander member to decompose the user's request. */
async function planWithCommander(ctx, group, request, config, parent) {
  const commander = memberWithRole(group, '指挥')
  if (!commander) return { assignments: [], raw: '', error: '这个小组还没有分配「指挥」职位给任何成员' }
  const prompt = [
    '你是这个小组的指挥。把用户的要求拆成给成员的自包含任务。',
    rosterText(group),
    '',
    '只输出一个 JSON 对象，不要其它文字：',
    '{"assignments":[{"member":"成员id或名字","task":"自包含任务，含背景/目标/验收标准"}]}',
    '',
    '[用户要求]',
    request,
  ].join('\n')
  const cmem = (state.memberMemory || {})[commander.id]
  const cdigest = cmem && cmem.digest && (state.config || {}).memoryInject !== false
    ? '\n\n[你之前为这个小组做过的事（摘要）]\n' + cmem.digest
    : ''
  const commanderOpts = { convId: commander.convId, __preset: 'minimal', __noTools: true, __reuse: true }
  const planned = await runKind(ctx, Object.assign({}, commander, commanderOpts), prompt + cdigest, config, group, undefined, parent)
  if (planned && planned.convId) { commander.convId = planned.convId; save().catch(() => {}) }
  const plan = parsePlan(planned.text)
  return {
    assignments: plan ? plan.assignments : [],
    raw: planned.text || planned.error || '',
    error: planned.ok ? undefined : (planned.error || '指挥调用失败'),
  }
}

async function callMember(ctx, member, task, config, group, styleOverride, parent, brief, onStage, onWork) {
  const role = roleOf(member)
  const memory = (state.memberMemory || {})[member.id]
  const memoryBlock = memory && memory.digest && (state.config || {}).memoryInject !== false
    ? '\n\n[你之前为这个小组做过的事（摘要）]\n' + memory.digest
    : ''
  const prompt = memberPrompt(member, task) + (brief ? '\n\n[背景]\n' + brief : '') + memoryBlock + WORK_STYLE
  if (onStage) onStage('执行中（' + member.kind + '）')
  let result = await runKind(ctx, member, prompt, config, group, styleOverride, parent)
  // watchdog retry: a timeout / dead agent gets one more attempt on the same member
  const maxAttempts = 2
  let attempt = 1
  while (!result.ok && attempt < maxAttempts) {
    attempt += 1
    const why = String(result.error || '无输出')
    if (onStage) onStage('重试中（第 ' + attempt + ' 次，上次：' + why.slice(0, 40) + '）')
    const retryPrompt = prompt + '\n\n[上次失败] ' + why + '\n请重新完成任务，直接给出结果。'
    result = await runKind(ctx, member, retryPrompt, config, group, styleOverride, parent)
    await save().catch(() => {})
  }
  if (attempt > 1) result = Object.assign({}, result, { attempts: attempt })
  if (onWork) { try { onWork(result) } catch { /* ignore */ } }
  if (result && result.ok) {
    // 用完即弃的子 agent：把这次的关键结论压成摘要，下一轮重新注入
    const text = String(result.text || '').replace(/\s+/g, ' ').trim()
    const head = text.slice(0, 600)
    const tail = text.length > 800 ? ' … ' + text.slice(-200) : ''
    state.memberMemory = state.memberMemory || {}
    state.memberMemory[member.id] = { digest: head + tail, at: Date.now() }
    save().catch(() => {})
  }
  const review = { self: null, commander: null, attempts: 1 }
  const verdictOf = (v) => (v ? (v.ok === true ? 'passed' : v.ok === false ? 'rejected' : 'unverified') : null)
  const acceptanceOf = () => {
    const list = [review.self, review.commander].map(verdictOf).filter(Boolean)
    if (!list.length) return 'none'            // 本组没配审校/指挥 → 不做验收
    if (list.includes('rejected')) return 'rejected'
    if (list.includes('unverified')) return 'unverified'
    return 'passed'
  }
  let acceptance = result.ok ? 'none' : 'skipped'
  let reworkError
  let reworkFailed = false

  if (result.ok) {
    if (onStage) onStage('初审（审校）')
    review.prelim = await prelimReview(ctx, group, member, task, result, config, styleOverride, parent, brief)
    review.self = review.prelim || await selfReview(ctx, member, task, result, config, group, styleOverride, parent)
    if (onStage) onStage('终审（指挥）')
    review.commander = await commanderReview(ctx, group, member, task, result, config, parent, brief, styleOverride)
    acceptance = acceptanceOf()

    // 被否 / 未判定 都要返工一次（之前 null 被当成通过）
    if (acceptance === 'rejected' || acceptance === 'unverified') {
      const blocks = []
      if (verdictOf(review.self) === 'rejected') blocks.push(`[自审未通过] ${review.self.reason}`)
      if (verdictOf(review.self) === 'unverified') blocks.push(`[自审未判定] ${review.self.reason}`)
      if (verdictOf(review.commander) === 'rejected') blocks.push(`[指挥验收未通过] ${review.commander.reason}`)
      if (verdictOf(review.commander) === 'unverified') blocks.push(`[指挥验收未判定] ${review.commander.reason}`)
      const rework = `${memberPrompt(member, task)}${WORK_STYLE}\n\n${blocks.join('\n')}\n请修正后重新提交。`
      review.attempts = 2                      // 先记次数：返工即使失败也算尝试过
      const second = await runKind(ctx, member, rework, config, group, styleOverride, parent)
      if (second.ok) {
        result = second
        review.prelim = await prelimReview(ctx, group, member, task, result, config, styleOverride, parent, brief)
        review.self = review.prelim || await selfReview(ctx, member, task, result, config, group, styleOverride, parent)
        if (onStage) onStage('终审（指挥）')
        review.commander = await commanderReview(ctx, group, member, task, result, config, parent, brief, styleOverride)
        acceptance = acceptanceOf()
      } else {
        reworkFailed = true
        reworkError = String(second.error || '返工未返回产出')
        acceptance = 'rework-failed'           // 保留首次产出，但明确标记返工失败
      }
    }
  }

  return {
    memberId: member.id,
    name: member.name,
    role: role?.name,
    kind: member.kind,
    model: member.model,
    ok: result.ok,
    // accepted 只表示「验收是否通过」；ok 仍表示「成员是否产出了东西」
    accepted: acceptance === 'passed' || acceptance === 'none',
    acceptance,
    ...reworkError === undefined ? {} : { reworkError },
    text: result.text,
    error: result.error,
    ...result.image === undefined ? {} : { image: result.image },
    review,
    ...review.attempts > 1 ? { attempts: review.attempts } : {},
  }
}

function parsePlan(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const value = JSON.parse(match[0])
    if (!Array.isArray(value.assignments)) return null
    return {
      confirmation: String(value.confirmation ?? ''),
      assignments: value.assignments
        .filter((a) => a && typeof a.member === 'string' && typeof a.task === 'string')
        .map((a) => ({ member: a.member, task: a.task })),
    }
  } catch { return null }
}

function commanderBrief(group, config) {
  const members = group.memberIds
    .map((id) => state.members.find((m) => m.id === id))
    .filter(Boolean)
  const roster = members.map((m) => {
    const role = roleOf(m)
    return `- ${m.name}（id=${m.id}，模型=${m.kind}/${m.model || '默认'}，职位=${role?.name ?? '未分配'}）`
  }).join('\n')
  return [
    '你是这个小组的指挥（commander）。你的职责是理解用户消息、复述确认，然后把任务拆给成员。',
    `小组：${group.name}`,
    `工作区：${group.workspacePath || config.defaultWorkspace || ''}`,
    '成员名册：',
    roster || '（暂无成员）',
    '',
    '只输出一个 JSON 对象，不要输出其它文字，格式：',
    '{"confirmation":"用一两句话复述你的理解并说明打算怎么分工","assignments":[{"member":"成员id","task":"自包含的任务描述"}]}',
    '规则：只派给名册里的成员；每个任务要自包含（背景+目标+验收标准）；不需要某成员就省略。',
  ].join('\n')
}

async function commanderTurn(group, text, config, sessionKey) {
  const sessions = group.commanderSessions || (group.commanderSessions = {})
  const resumeId = sessionKey ? sessions[sessionKey] : group.commanderConvId
  const brief = commanderBrief(group, config)
  const prompt = `${brief}\n\n[用户消息]\n${text}`
  const runner = group.commander?.kind === 'claude' ? runClaude : runCodex
  const result = await runner({
    cwd: group.workspacePath || config.defaultWorkspace || process.cwd(),
    model: group.commander?.model || undefined,
    resume: resumeId || undefined,
    prompt,
    env: await envFor(group.commander?.kind === 'claude' ? 'claude' : 'codex', config),
  })
  if (result.convId) {
    if (sessionKey) sessions[sessionKey] = result.convId
    if (!sessionKey || !resumeId) group.commanderConvId = result.convId
  }
  if (result.usage) account(`commander:${group.id}`, result.usage)
  const plan = parsePlan(result.text)
  return {
    ok: result.ok,
    raw: result.text,
    error: result.error,
    plan: plan ?? { confirmation: result.text.slice(0, 1500), assignments: [] },
  }
}

function send(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req) {
  if (req.__councilBody !== undefined) return req.__councilBody
  let raw = ''
  for await (const chunk of req) raw += chunk
  let parsed = {}
  if (raw) { try { parsed = JSON.parse(raw) } catch { parsed = {} } }
  req.__councilBody = parsed
  return parsed
}

function findGroup(id) { return state.groups.find((g) => g.id === id) }

function activeGroup() {
  return findGroup(state.activeGroupId) ?? state.groups[0]
}

export function apply(ctx, config = {}) {
  ctx0 = ctx
  ctx.inject(['webServer'], (scope) => {
    scope.webServer.register({ kind: 'prefix', path: '/council/api', handler: createHandler(ctx, config) })
  })
  ctx.inject(['sessions'], (scope) => {
    scope.on('session/disposed', (session) => {
      load().then(async () => {
        const group = state.groups.find((g) => g.sessionId === session.id)
        if (!group) return
        for (const memberId of group.memberIds || []) {
          state.members = state.members.filter((m) => m.id !== memberId)
          delete state.usage[memberId]
        }
        state.groups = state.groups.filter((g) => g.id !== group.id)
        await save()
      })
    })
  })
  ctx.on('workspace/session-stop', (request) => {
    const sid = request && (request.sessionId || (request.session && request.session.id))
    if (!sid) return
    load().then(async () => {
      const group = state.groups.find((g) => g.sessionId === sid)
      if (!group || group.archived) return
      group.archived = true
      group.sessionId = undefined
      const cleanupKey = boundAgents.get(group.id + '\u0000' + sid)
      if (cleanupKey) { try { cleanupKey() } catch { /* ignore */ } }
      await save()
    })
  })
  ctx.inject(['agents'], (scope) => {
    scope.on('agent/created', ({ agent }) => {
      load().then(() => {
        const group = state.groups.find((g) => g.sessionId === agent.id)
        if (group) { try { bindAgent(ctx, config, group, agent) } catch { /* keep the session usable */ } }
      })
    })
  })
}

/** Build the JSON handler; exported so a plain Node harness can exercise it. */
export function createHandler(ctx, config = {}) {
  return async function councilHandler(req, res) {
        await load()
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.replace(/^\/council\/api/, '') || '/'
        try {
          await applyProxy(config)
          if (req.method === 'GET' && route === '/state') {
            return send(res, 200, { state, config: publicConfig(config) })
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            if (route === '/roles') {
              if (body.id) {
                const role = state.roles.find((r) => r.id === body.id)
                if (role) Object.assign(role, pick(body, ['name', 'prompt', 'color']))
                await save()
                return send(res, 200, { state })
              }
              const role = { id: `r_${randomUUID().slice(0, 8)}`, name: body.name || '新职位', prompt: body.prompt || '', color: body.color }
              state.roles.push(role)
              await save()
              return send(res, 200, { state, role })
            }
            if (route === '/roles/delete') {
              state.roles = state.roles.filter((r) => r.id !== body.id)
              for (const m of state.members) if (m.roleId === body.id) delete m.roleId
              await save()
              return send(res, 200, { state })
            }
            if (route === '/members') {
              if (body.id) {
                const member = state.members.find((m) => m.id === body.id)
                if (!member) return send(res, 404, { error: 'member not found: ' + body.id })
                if (member) {
                  const kindChanged = body.kind !== undefined && body.kind !== member.kind
                  Object.assign(member, pick(body, ['name', 'kind', 'model', 'provider', 'providerId', 'roleId', 'cwd']))
                  if (kindChanged) delete member.convId
                }
                await save()
                return send(res, 200, { state })
              }
              const defaultModels = {
                codex: 'gpt-6.1-sol',
                claude: 'claude-sonnet-5',
                deepseek: 'deepseek-flash',
                image: 'gpt-image-2.5-flare',
              }
              const kind = defaultModels[body.kind] ? body.kind : 'codex'
              const member = {
                id: `m_${randomUUID().slice(0, 8)}`,
                name: body.name || '新成员',
                kind,
                model: body.model || defaultModels[kind],
                provider: kind === 'deepseek' ? (body.provider || 'deepseek-official') : undefined,
                roleId: body.roleId,
                cwd: body.cwd || undefined,
              }
              state.members.push(member)
              const group = (body.groupId ? findGroup(body.groupId) : undefined) || activeGroup()
              if (group && !group.memberIds.includes(member.id)) group.memberIds.push(member.id)
              await save()
              return send(res, 200, { state, member })
            }
            if (route === '/members/delete') {
              state.members = state.members.filter((m) => m.id !== body.id)
              for (const g of state.groups) g.memberIds = g.memberIds.filter((id) => id !== body.id)
              delete state.usage[body.id]
              await save()
              return send(res, 200, { state })
            }
            if (route === '/members/role') {
              const member = state.members.find((m) => m.id === body.id)
              if (member) member.roleId = body.roleId || undefined
              await save()
              return send(res, 200, { state })
            }
            if (route === '/groups') {
              if (body.id) {
                const group = findGroup(body.id)
                if (group) {
                  const nextCommander = body.commander
                  if (nextCommander && group.commander && nextCommander.kind && nextCommander.kind !== group.commander.kind) {
                    delete group.commanderConvId
                  }
                  Object.assign(group, pick(body, ['name', 'workspacePath', 'commander', 'memberIds', 'style', 'reviewerId']))
                }
                await save()
                return send(res, 200, { state })
              }
              const group = {
                id: `g_${randomUUID().slice(0, 8)}`,
                name: body.name || '新小组',
                workspacePath: body.workspacePath || config.defaultWorkspace || os.homedir(),
                commander: {},
                memberIds: [],
              }
              state.groups.push(group)
              state.activeGroupId = group.id
              await ensureWorkspace(ctx, group)
              await save()
              return send(res, 200, { state, group })
            }
            if (route === '/groups/bind') {
              const group = findGroup(body.id)
              if (!group) return send(res, 404, { error: 'group not found' })
              const previous = group.sessionId
              if (previous && previous !== body.sessionId) {
                const cleanup = boundAgents.get(group.id + '\u0000' + previous)
                if (cleanup) { try { cleanup() } catch { /* ignore */ } }
              }
              group.sessionId = body.sessionId || undefined
              delete group.commanderConvId
              group.commanderSessions = {}
              await save()
              const agents = ctx.get('agents')
              const agent = group.sessionId && agents ? agents.get(group.sessionId) : undefined
              let bound = null
              if (agent) {
                try { bound = bindAgent(ctx, config, group, agent) } catch (error) { bound = { bound: false, error: String(error?.message ?? error) } }
              }
              return send(res, 200, { state, bound, live: Boolean(agent) })
            }
            if (route === '/groups/prune') {
              const removed = pruneGroups()
              await save()
              return send(res, 200, { state, removed })
            }
            if (route === '/groups/select') {
              if (findGroup(body.id)) state.activeGroupId = body.id
              await save()
              return send(res, 200, { state })
            }
            if (route === '/groups/delete') {
              const doomed = findGroup(body.id)
              if (doomed) {
                // members belong to their group; deleting the group deletes its roster
                for (const memberId of doomed.memberIds || []) {
                  state.members = state.members.filter((m) => m.id !== memberId)
                  delete state.usage[memberId]
                }
              }
              state.groups = state.groups.filter((g) => g.id !== body.id)
              await save()
              return send(res, 200, { state })
            }
            if (route === '/groups/workspace') {
              const group = findGroup(body.id)
              if (group) {
                group.workspacePath = body.workspacePath
                await ensureWorkspace(ctx, group)
              }
              await save()
              return send(res, 200, { state })
            }
            if (route === '/message') {
              const group = findGroup(body.id)
              if (!group) return send(res, 404, { error: 'group not found' })
              const sessionKey = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined
              const turn = await commanderTurn(group, String(body.text ?? ''), config, sessionKey)
              state.pending = {
                groupId: group.id,
                sessionId: sessionKey,
                text: String(body.text ?? ''),
                confirmation: turn.plan.confirmation,
                assignments: turn.plan.assignments,
                raw: turn.raw,
                error: turn.error,
                at: Date.now(),
              }
              await save()
              return send(res, turn.ok ? 200 : 500, { state, plan: turn.plan, error: turn.error })
            }
            if (route === '/confirm') {
              const group = findGroup(body.id)
              if (!group) return send(res, 404, { error: 'group not found' })
              const pending = state.pending && state.pending.groupId === group.id ? state.pending : undefined
              const assignments = Array.isArray(body.assignments) ? body.assignments : (pending ? pending.assignments : [])
              const run = {
                id: `run_${randomUUID().slice(0, 8)}`,
                groupId: group.id,
                sessionId: body.sessionId ?? (pending ? pending.sessionId : undefined),
                status: 'running',
                text: body.text ?? (pending ? pending.text : ''),
                confirmation: body.confirmation ?? (pending ? pending.confirmation : ''),
                raw: pending ? pending.raw : undefined,
                members: assignments.map((item) => ({ memberId: item.member, task: item.task, status: 'pending' })),
                at: Date.now(),
              }
              state.runs.unshift(run)
              state.runs = state.runs.slice(0, 30)
              state.pending = undefined
              await save()
              executeRun(ctx, config, run).catch(() => {})
              return send(res, 200, { state, runId: run.id })
            }
          }
          if (req.method === 'GET' && route.startsWith('/image/')) {
            const name = path.basename(route.slice('/image/'.length))
            try {
              const bytes = await readFile(path.join(IMAGE_DIR, name))
              res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
              res.end(bytes)
              return
            } catch {
              return send(res, 404, { error: 'image not found' })
            }
          }
          if (req.method === 'GET' && route === '/progress') {
            const out = {}
            for (const [id, entry] of progressMap) out[id] = entry
            return send(res, 200, { progress: out })
          }
          if (req.method === 'GET' && route === '/agents') {
            const agents = ctx.get('agents')
            const live = agents ? agents.list().map((a) => a.id) : []
            return send(res, 200, { live })
          }
          if (req.method === 'POST' && route === '/config/mode') {
            const body = await readBody(req)
            const next = Object.assign({}, state.config || {})
            if (typeof body.reuseChildren === 'boolean') next.reuseAgents = body.reuseChildren
            if (typeof body.memoryInject === 'boolean') next.memoryInject = body.memoryInject
            state.config = next
            await save()
            return send(res, 200, { reuseChildren: Boolean(next.reuseChildren), memoryInject: next.memoryInject !== false })
          }
          if (route === '/config') {
            if (req.method === 'GET') {
              const own = state.config || {}
              const settings = apiSettings(config)
              return send(res, 200, {
                config: {
                  hasCodexToken: Boolean(settings.codexToken),
                  hasClaudeKey: Boolean(settings.claudeKey),
                  hasImageKey: Boolean(settings.imageKey),
                  reuseChildren: Boolean((state.config || {}).reuseChildren),
                  claudeBase: own.claudeBase || '',
                  codexBase: own.codexBase || '',
                  proxyUrl: own.proxyUrl || '',
                  hasProxy: Boolean(own.proxyUrl),
                  claudeBaseFromProfile: Boolean(!own.claudeBase && config.claudeBaseUrl),
                  codexBaseFromProfile: Boolean(!own.codexBase && config.codexBaseUrl),
                  proxyUrl: own.proxyUrl || '',
                  hasProxy: Boolean(own.proxyUrl),
                  source: own.claudeKey || own.imageKey || own.codexToken ? 'page' : 'profile',
                },
              })
            }
            if (req.method === 'POST') {
              const body = await readBody(req)
              const next = Object.assign({}, state.config || {})
              for (const key of ['codexToken', 'claudeKey', 'imageKey', 'claudeBase', 'codexBase', 'proxyUrl']) {
                if (typeof body[key] === 'string') {
                  if (body[key] === '') delete next[key]
                  else next[key] = body[key]
                }
              }
              if (typeof body.reuseChildren === 'boolean') next.reuseAgents = body.reuseChildren
              state.config = Object.keys(next).length ? next : undefined
              usageCache = null
              catalog = null
              await save()
              const settings = apiSettings(config)
              const own = state.config || {}
              return send(res, 200, {
                config: {
                  hasCodexToken: Boolean(settings.codexToken),
                  hasClaudeKey: Boolean(settings.claudeKey),
                  hasImageKey: Boolean(settings.imageKey),
                  reuseChildren: Boolean((state.config || {}).reuseChildren),
                  claudeBase: own.claudeBase || '',
                  codexBase: own.codexBase || '',
                  proxyUrl: own.proxyUrl || '',
                  hasProxy: Boolean(own.proxyUrl),
                  claudeBaseFromProfile: Boolean(!own.claudeBase && config.claudeBaseUrl),
                  codexBaseFromProfile: Boolean(!own.codexBase && config.codexBaseUrl),
                  proxyUrl: own.proxyUrl || '',
                  hasProxy: Boolean(own.proxyUrl),
                  source: 'page',
                },
              })
            }
          }
          if (req.method === 'GET' && route === '/usage') {
            return send(res, 200, await keyUsage(config))
          }
          if (req.method === 'GET' && route === '/models') {
            if (url.searchParams.get('refresh')) catalog = null
            return send(res, 200, await modelCatalog(ctx, config))
          }
          if (req.method === 'GET' && route === '/balance') {
            return send(res, 200, await deepseekBalance(ctx, config))
          }
          return send(res, 404, { error: `no route ${req.method} ${route}` })
        } catch (error) {
          return send(res, 500, { error: String(error?.stack ?? error) })
        }
  }
}

/** Run every assignment concurrently, publishing each member's result as it lands. */
async function executeRun(ctx, config, run) {
  await Promise.all(run.members.map(async (slot) => {
    const member = state.members.find((m) => m.id === slot.memberId)
    if (!member) {
      slot.status = 'failed'
      slot.error = 'member not found'
      await save()
      return
    }
    slot.status = 'running'
    slot.name = member.name
    slot.kind = member.kind
    slot.startedAt = Date.now()
    await save()
    let result
    try {
      result = await callMember(ctx, member, slot.task, config, state.groups.find((g) => g.id === run.groupId))
    } catch (error) {
      result = { ok: false, text: '', error: String(error?.message ?? error) }
    }
    // 执行成功 ≠ 验收通过：被否 / 未判定 / 返工失败都要在状态里体现
    slot.status = !result.ok
      ? 'failed'
      : (result.accepted === false ? (result.acceptance === 'rework-failed' ? 'failed' : 'rejected') : 'done')
    slot.acceptance = result.acceptance
    slot.text = result.text ?? ''
    slot.error = result.error ?? result.reworkError
    if (result.image) slot.image = result.image
    if (result.review) slot.review = result.review
    if (result.attempts) slot.attempts = result.attempts
    slot.endedAt = Date.now()
    await save()
  }))
  run.status = 'done'
  run.endedAt = Date.now()
  await save()
}

const boundAgents = new Map()
/** Live delegation progress keyed by tool call id, so the card can show stages. */
const progressMap = new Map()

function progressInit(callId, sessionId) {
  if (!callId) return
  progressMap.set(callId, { startedAt: Date.now(), sessionId: sessionId, members: {} })
  if (progressMap.size > 30) progressMap.delete(progressMap.keys().next().value)
}

function progressSet(callId, memberId, patch) {
  if (!callId) return
  const entry = progressMap.get(callId)
  if (!entry) return
  entry.members[memberId] = Object.assign({ at: Date.now() }, entry.members[memberId] || {}, patch)
}

/** Human/roster text injected into a bound chat session's system prompt. */
function rosterText(group) {
  const members = (group.memberIds || [])
    .map((id) => state.members.find((m) => m.id === id))
    .filter(Boolean)
    .map((m) => {
      const role = roleOf(m)
      return `- ${m.name}（id=${m.id}，框架=${m.kind}，模型=${m.model || '默认'}，职位=${role ? role.name : '未分配'}${role && role.prompt ? '：' + role.prompt : ''}）`
    })
    .join('\n')
  return [
    `你是小组「${group.name}」的指挥，正在一个群聊会话里。需要成员干活时调用 council_delegate，一次把全部任务派下去。`,
    `工作区：${group.workspacePath || ''}`,
    group.style ? `统一风格规范（出图默认用这条）：${group.style}` : '',
    '派图任务时如需换风格，给该条 assignment 加 style 字段覆盖默认值；审校会按实际使用的风格判定。',
    '图片回执由工具卡直接展示；如果要在回答里引用，用 /council/api/image/… 这种地址，不要写本地文件路径（前端预览不了本地路径）。',
    '成员名册：',
    members || '（暂无成员）',
    '成员会跑在各自的原生框架里，回执会以工具结果的形式回到这个对话。',
    '需要拆解时，把用户原话作为 request 传给 council_delegate：会由持有「指挥」职位的成员拆解、成员干活、持有「审校」职位的成员初审，最后指挥终审。',
  ].filter(Boolean).join('\n')
}

/** Register the delegate tool and roster prompt on one live chat session. */
function bindAgent(ctx, config, group, agent) {
  const key = group.id + '\u0000' + agent.id
  if (boundAgents.has(key)) return { bound: true, reused: true }
  const agentCtx = agent.ctx || ctx
  const disposers = []
  try {
    disposers.push(agentCtx.systemPrompt.section({
      name: 'council:roster:' + group.id,
      order: 1500,
      text: () => rosterText(state.groups.find((g) => g.id === group.id) || group),
    }))
    disposers.push(agentCtx.tools.register({
      name: 'council_delegate',
      description: '把任务派给这个小组的成员（各自跑在自己的框架里），返回每个成员的产出、图片与两段审校结论。一次调用可以派多个成员，它们并发执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          request: { type: 'string', description: '用户的原话。给了它就由“验收指挥”成员先拆解成任务，再派给成员。' },
          assignments: {
            type: 'array',
            description: '要派发的任务；每个任务都必须自包含（背景+目标+验收标准）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                member: { type: 'string', description: '成员名字或 id' },
                task: { type: 'string', description: '给这个成员的任务' },
                style: { type: 'string', description: '可选：覆盖本组默认的统一风格（用于这次任务的画面风格）' },
              },
              required: ['member', 'task'],
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            plan: { type: 'object', additionalProperties: true },
            members: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  kind: { type: 'string' },
                  ok: { type: 'boolean' },
                  text: { type: 'string' },
                  image: { type: 'string' },
                  error: { type: 'string' },
                  review: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
          required: ['members'],
        },
        render(_args, value) {
          const verdict = (v) => (v ? (v.ok === true ? '通过' : v.ok === false ? '不通过' : '未判定') + (v.reason ? '（' + v.reason + '）' : '') : '无')
          const planLine = value.plan
            ? (value.plan.assignments && value.plan.assignments.length
              ? '## 指挥拆分（commander）\n' + value.plan.assignments.map((a, i) => `${i + 1}. ${a.member}：${a.task}`).join('\n')
              : '## 指挥拆分（commander）\n未能拆解：' + (value.plan.reason || value.plan.raw || '未知原因'))
            : ''
          const rows = (value.members || []).map((m) => {
            const body = m.ok ? (m.text || '') : '失败：' + (m.error || '')
            const image = m.image ? `\n[image] ${m.image}` : ''
            const review = m.review
              ? `\n${m.review.prelim ? '审校：' : '自审：'}${verdict(m.review.self)} · 指挥审核：${verdict(m.review.commander)}`
              : ''
            const accept = m.accepted === false
              ? `\n验收：未通过（${m.acceptance === 'rework-failed' ? '返工失败：' + (m.reworkError || '未返回产出') : m.acceptance === 'unverified' ? '审核未判定' : '审核拒绝'}）`
              : ''
            return `## ${m.name}（${m.kind}）\n${body}${image}${review}${accept}`
          })
          const body = rows.join('\n\n') || (planLine ? '（没有成员回执）' : '（没有成员回执：既没给 assignments，也没能由指挥拆解）')
          return [{ type: 'text', text: planLine ? planLine + '\n\n' + body : body }]
        },
      },
      async execute(args, exec) {
        const live = state.groups.find((g) => g.id === group.id) || group
        const callId = exec && exec.callId
        progressInit(callId, exec && exec.agent && exec.agent.id)
        let assignments = Array.isArray(args && args.assignments) ? args.assignments : []
        let planRaw
        const requestText = args && typeof args.request === 'string' ? args.request.trim() : ''
        if ((!assignments.length) && requestText) {
          const planned = await planWithCommander(ctx, live, args.request.trim(), config, exec && exec.agent)
          planRaw = planned.raw
          assignments = planned.assignments
          if (!assignments.length) {
            return { plan: { ok: false, raw: planned.raw || '', reason: planned.error || '指挥没有给出可用的拆分' }, members: [] }
          }
        }
        const sid = exec && exec.agent && exec.agent.id
        let userText = requestText
        if (!userText && exec && exec.agent && exec.agent.session) {
          try {
            const events = sessionEvents(exec.agent.session)
            for (let i = events.length - 1; i >= 0; i -= 1) {
              const ev = events[i]
              if (ev.type !== 'user/message') continue
              const text = (ev.data.message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
              if (text) { userText = text; break }
            }
          } catch { /* ignore */ }
        }
        const verdict = (v) => (v ? (v.ok === true ? '通过' : v.ok === false ? '不通过' : '未判定') + (v.reason ? '（' + v.reason + '）' : '') : '无')
        const reviewer = memberWithRole(live, '审校')
        const commanderMember = memberWithRole(live, '指挥')

        // one history entry, filled in as members come back (visible while running)
        state.delegations = state.delegations || {}
        const history = state.delegations[sid || 'local'] || { entries: [] }
        const firstTask = String((assignments[0] && assignments[0].task) || '').split('\n').find((line) => line.trim()) || ''
        const entry = { at: Date.now(), request: userText || '', brief: firstTask.trim().slice(0, 80), text: '', running: true }
        history.entries = (history.entries || []).concat([entry])
        if (history.entries.length > 50) history.entries = history.entries.slice(-50)
        history.at = Date.now()
        state.delegations[sid || 'local'] = history
        const append = (chunk) => {
          entry.text = entry.text ? entry.text + '\n\n' + chunk : chunk
          history.at = Date.now()
          history.text = entry.text
          save().catch(() => {})
        }

        const results = await Promise.all(assignments.map(async (item) => {
          const inGroup = (m) => (live.memberIds || []).indexOf(m.id) >= 0
          const roleNamed = (m) => {
            const role = (state.roles || []).find((r) => r.id === m.roleId)
            return role && role.name === item.member
          }
          const member = state.members.find((m) => inGroup(m) && m.id === item.member)
            || state.members.find((m) => inGroup(m) && roleNamed(m))
            || state.members.find((m) => inGroup(m) && m.name === item.member)
          if (!member) return { name: String(item.member), kind: 'unknown', ok: false, error: 'member not found' }
          const briefParts = []
          if (requestText) briefParts.push('用户原话：' + requestText)
          if (assignments.length > 1) {
            briefParts.push('指挥的分工：' + assignments.map((a, i) => `${i + 1}. ${a.member}：${String(a.task || '').slice(0, 160)}`).join(' / '))
          }
          const brief = briefParts.join('\n')
          progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: '排队中' })
          const result = await callMember(ctx, member, String(item.task || ''), config, live, item.style, exec && exec.agent, brief,
            (stage) => progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: stage }),
            (work) => {
              progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: '审校中' })
              const body = work.ok ? (work.text || '') : '失败：' + (work.error || '')
              append('## ' + member.name + '（' + member.kind + '）\n' + body + (work.image ? '\n[image] ' + work.image : ''))
            })
          const reviewChunks = []
          if (result.review && result.review.self) {
            const who = result.review.prelim && reviewer ? reviewer : member
            reviewChunks.push('## ' + who.name + '（' + who.kind + '）\n'
              + (who.model ? '模型 ' + who.model + ' · ' : '')
              + (result.review.prelim ? '审校：' : '自审：') + verdict(result.review.self))
          }
          if (result.review && result.review.commander) {
            const who = commanderMember || member
            reviewChunks.push('## ' + who.name + '（' + who.kind + '）\n'
              + (who.model ? '模型 ' + who.model + ' · ' : '') + '指挥审核：' + verdict(result.review.commander))
          }
          if (reviewChunks.length) append(reviewChunks.join('\n\n'))
          if (result.accepted === false) {
            const why = result.acceptance === 'rework-failed'
              ? '返工失败：' + (result.reworkError || '未返回产出')
              : result.acceptance === 'unverified'
                ? '审核未判定（按未通过处理）'
                : '验收未通过'
            append('## 验收（小组）\n' + why)
          }
          return {
            name: member.name,
            kind: member.kind,
            ok: Boolean(result.ok),
            text: result.text || '',
            ...result.image === undefined ? {} : { image: result.image },
            ...result.error === undefined ? {} : { error: String(result.error) },
            ...result.review === undefined ? {} : { review: result.review },
            ...result.accepted === undefined ? {} : { accepted: result.accepted },
            ...result.acceptance === undefined ? {} : { acceptance: result.acceptance },
            ...result.reworkError === undefined ? {} : { reworkError: String(result.reworkError) },
          }
        }))
        for (const item of assignments) {
          const done = state.members.find((m) => m.id === item.member || m.name === item.member)
          if (done) progressSet(callId, done.id, { stage: '完成' })
        }
        if (callId) {
          const progressEntry = progressMap.get(callId)
          if (progressEntry) progressEntry.finishedAt = Date.now()
        }
        entry.running = false
        history.at = Date.now()
        history.text = entry.text
        await save()
        return { members: results }
      },
    }))
  } catch (error) {
    for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
    throw error
  }
  const cleanup = () => {
    for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* ignore */ } }
    boundAgents.delete(key)
  }
  boundAgents.set(key, cleanup)
  agentCtx.effect?.(() => cleanup)
  return { bound: true, reused: false }
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

let catalog = null

/** Read the relay token Codex already uses, so the model list needs no extra secret. */
async function codexToken() {
  if (state && state.config && state.config.codexToken) return state.config.codexToken
  try {
    const text = await readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')
    const match = text.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)
    return match ? match[1] : undefined
  } catch { return undefined }
}

/** Live model ids per family, cached; empty arrays when the relay cannot be read. */

/** codex 成员走的是 ~/.codex/config.toml；拉模型列表时沿用它配置的中转地址。 */
async function codexCliBase() {
  try {
    const raw = await readFile(path.join(process.env.HOME || '', '.codex', 'config.toml'), 'utf8')
    const match = raw.match(/base_url\s*=\s*"([^"]+)"/)
    return match ? match[1].replace(/\/v1\/?$/, '') : ''
  } catch { return '' }
}

async function modelCatalog(ctx, config) {
  if (catalog && Date.now() - catalog.at < 10 * 60_000) return catalog.value
  const value = { codex: [], claude: [], deepseek: [], image: [], error: null }
  // settings must live in function scope: the later claude/image branches use it too.
  const settings = apiSettings(config)
  try {
    const token = settings.codexToken || await codexToken()
    const codexBase = settings.codexBase || await codexCliBase()
    if (!codexBase) throw new Error('未配置 codex/gpt 中转地址（base）')
    const response = await fetch(rootUrl(codexBase) + '/v1/models', {
      headers: token ? { authorization: 'Bearer ' + token } : {},
    })
    if (response.ok) {
      const data = await response.json()
      const ids = (data.data ?? []).map((m) => m.id)
      value.codex = ids.filter((id) => !String(id).startsWith('claude') && !String(id).startsWith('gpt-image'))
      value.image = ids.filter((id) => String(id).startsWith('gpt-image'))
    }
  } catch (error) { value.error = String(error?.message ?? error) }
  try {
    const claudeModelsBase = (apiSettings(config).claudeBase || '').replace(/\/$/, '')
    if (!claudeModelsBase) throw new Error('未配置 claude base URL')
    const response = await fetch(claudeModelsBase + '/v1/models', {
      headers: { 'x-api-key': settings.claudeKey, 'anthropic-version': '2023-06-01' },
    })
    if (!response.ok) throw new Error('HTTP ' + response.status + '（claude 模型列表）')
    if (response.ok) {
      const data = await response.json()
      value.claude = (data.data ?? []).map((m) => m.id).filter((id) => String(id).startsWith('claude'))
    }
  } catch (error) { value.error = value.error || String(error?.message ?? error) }
  try {
    // listModels(provider) is async and throws NO_ADAPTER for an unknown route, so the
    // provider id must be checked first — a bare listModels() rejects unhandled and takes
    // the whole host process down with it.
    const llm = ctx.get('llm')
    if (llm && typeof llm.listModels === 'function' && typeof llm.listProviders === 'function') {
      const ids = llm.listProviders()
        .map((entry) => entry?.id ?? entry?.provider?.id)
        .filter(Boolean)
      if (ids.includes('deepseek-official')) {
        value.deepseek = (await llm.listModels('deepseek-official')).map((m) => m.id)
      }
    }
  } catch { /* keep empty */ }
  if (!value.deepseek.length) value.deepseek = ['deepseek-flash']
  if (config.imageApiKey) {
    try {
      const response = await fetch(settings.codexBase + '/v1/models', {
        headers: { authorization: 'Bearer ' + settings.imageKey },
      })
      if (response.ok) {
        const data = await response.json()
        value.image = (data.data ?? []).map((m) => m.id).filter((id) => String(id).startsWith('gpt-image'))
      }
    } catch (error) { value.error = value.error || String(error?.message ?? error) }
  }
  if (!value.image.length) value.image = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2']
  if (value.codex.length || value.claude.length) catalog = { at: Date.now(), value }
  return value
}

let usageCache = null

/** Real per-key usage from the relay's /v1/usage endpoint, cached briefly. */
async function keyUsage(config) {
  if (usageCache && Date.now() - usageCache.at < 60_000) return usageCache.value
  const settings = apiSettings(config)
  const trimBase = (value) => String(value || '').replace(/\/$/, '')
  // 页面里不再保存 base（由 profile 提供），所以这里必须用「有效 base」：codex 缺失时回落到同一个中转
  const relayBase = trimBase(settings.codexBase) || trimBase(await codexCliBase()) || trimBase(settings.claudeBase)
  const sources = [
    { id: 'gpt-llm', label: 'gpt-llm（codex 成员）', token: settings.codexToken || await codexToken(), base: relayBase },
    { id: 'claude-llm', label: 'claude-llm（claude 成员）', token: settings.claudeKey, base: trimBase(settings.claudeBase) },
    { id: 'gpt-image', label: 'gpt-image（出图成员）', token: settings.imageKey, base: relayBase },
  ]
  const keys = []
  for (const source of sources) {
    if (!source.token) { keys.push({ id: source.id, label: source.label, ok: false, error: 'no key' }); continue }
    if (!source.base) { keys.push({ id: source.id, label: source.label, ok: false, error: 'no base URL' }); continue }
    try {
      const response = await fetch(rootUrl(source.base) + '/v1/usage', { headers: { authorization: 'Bearer ' + source.token } })
      if (!response.ok) { keys.push({ id: source.id, label: source.label, ok: false, error: 'HTTP ' + response.status }); continue }
      const data = await response.json()
      const days = Array.isArray(data.daily_usage) ? data.daily_usage : []
      const today = days[days.length - 1] ?? null
      const totals = days.reduce((acc, day) => ({
        requests: acc.requests + (day.requests ?? 0),
        tokens: acc.tokens + (day.total_tokens ?? 0),
        cost: acc.cost + (day.actual_cost ?? day.cost ?? 0),
      }), { requests: 0, tokens: 0, cost: 0 })
      keys.push({
        id: source.id,
        label: source.label,
        ok: true,
        valid: data.isValid !== false,
        balance: typeof data.balance === 'number' ? data.balance : null,
        today: today ? { date: today.date, requests: today.requests ?? 0, tokens: today.total_tokens ?? 0, cost: today.actual_cost ?? today.cost ?? 0 } : null,
        totals,
        models: (data.model_stats ?? []).slice(0, 6).map((m) => ({ model: m.model, requests: m.requests ?? 0, tokens: m.total_tokens ?? 0 })),
      })
    } catch (error) {
      keys.push({ id: source.id, label: source.label, ok: false, error: String(error?.message ?? error) })
    }
  }
  const value = { keys, at: Date.now() }
  usageCache = { at: Date.now(), value }
  return value
}

function publicConfig(config) {
  return {
    defaultWorkspace: config.defaultWorkspace,
    hasClaudeKey: Boolean(config.claudeApiKey),
    lowBalanceThreshold: config.lowBalanceThreshold ?? 20,
  }
}

/** DeepSeek account wallet balance, or a reason we cannot show one. */
async function deepseekBalance(ctx, config) {
  const account = ctx.get('deepseekAccount')
  if (!account) return { deepseek: null, reason: 'no-account-service' }
  try {
    const view = await account.getState()
    if (view?.status !== 'credential-stored') return { deepseek: null, reason: 'signed-out' }
    const result = await account.getBalance({
      version: 'council/0.1.0',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    if (!result || result.status !== 'ready') return { deepseek: null, reason: 'failed' }
    const wallets = (result.value ?? []).map((w) => ({ currency: w.currency, balance: Number(w.balance) }))
    return { deepseek: { wallets, threshold: config.lowBalanceThreshold ?? 20 } }
  } catch (error) {
    return { deepseek: null, reason: String(error?.message ?? error) }
  }
}

async function ensureWorkspace(ctx, group) {
  if (group.workspacePath) {
    try { await mkdir(group.workspacePath, { recursive: true }) } catch { /* best effort */ }
  }
  const registry = ctx.get('workspaceRegistry')
  if (!registry || !group.workspacePath) return
  try {
    const existing = registry.list().find((w) => w.path === group.workspacePath)
    group.workspaceId = existing?.id ?? (await registry.create(group.workspacePath, group.name)).id
  } catch (error) {
    ctx.logger?.('council')?.warn?.(`workspace failed: ${error?.message ?? error}`)
  }
}


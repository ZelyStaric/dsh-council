/**
 * Host half of the "council" (小组) bundle.
 *
 * Owns: roles, members, groups, per-member usage, and the commander/worker
 * dispatch pipeline. Public surface is a small JSON HTTP API under
 * /council/api that the Client half calls with same-origin fetch.
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'storages', 'council.json')
const WORKSPACE_FILE = path.join(DSH_HOME, 'storages', 'workspace.json')
const IMAGE_DIR = path.join(DSH_HOME, 'storages', 'council-images')
/** 归档真源是 workspace.json 的 global.archivedSessionIds；10 秒缓存避免高频 IO。 */
const ARCHIVED_CACHE_MS = 10_000
const normalizeSessionId = (value) => String(value || '').replace(/^session-/, '')
let archivedIdsCache = { at: 0, ids: null }
const PROFILE_CANDIDATES = [
  process.env.DSH_PROFILE_DIR,
  path.join(os.homedir(), '.dsh', 'profiles', 'web'),
].filter(Boolean)
const CODEX_BIN = process.env.COUNCIL_CODEX_BIN || 'codex'

/**
 * 子会话清理路由：内层路径（handler 已经剥掉 `/council/api`），
 * HTTP 实际地址 = `/council/api` + 本值 = `POST /council/api/sessions/prune`。
 * 前端 `client.js` 的 `SESSIONS_PRUNE_PATH` 必须与本值**逐字相同**；
 * `tests/staffing-test.mjs` 会解析两半源码断言一致，防「前后端路由漂移」。
 */
const SESSIONS_PRUNE_ROUTE = '/sessions/prune'

/**
 * 归档组清理路由：HTTP 实际地址 = `POST /council/api/groups/prune-archived`。
 * 前端 `client.js` 的 `ARCHIVED_PRUNE_PATH` 必须与本值**逐字相同**；
 * `tests/staffing-test.mjs` 会解析两半源码断言一致，防「前后端路由漂移」。
 */
const ARCHIVED_PRUNE_ROUTE = '/groups/prune-archived'
/** 默认只清理「归档超过 7 天」的组（前端按钮文案也用这个数）。 */
const ARCHIVED_KEEP_DAYS = 7

/**
 * 审核 prompt 里贴的成员产出：**完整传入，不再截断**。
 * 旧实现是 `.slice(0, 4000)`——长产出只有前 4000 字能被审校/指挥看到，
 * 后面明明写了的内容也会被判「缺项」。这里只保留 20 万字符的兜底保护，
 * 防单次 prompt 畸形膨胀（正常产出远小于该值）。
 */
const REVIEW_TEXT_HARD_CAP = 200_000

/** 成员单次运行的默认时间预算（分钟）：页面配置 → profile 配置 → 30 分钟。 */
const DEFAULT_MEMBER_TIMEOUT_MINUTES = 30

/**
 * deepseek 成员被 max-tokens / max-turns 截断时，最多续跑几次（同一个子会话里接着跑）。
 * 超时仍走 callMember 原有的「重试一次」。
 */
const MEMBER_CONTINUE_LIMIT = 5

/** 会被当作「这轮没跑完、可以续跑」的 stopReason。 */
const TRUNCATED_STOP_REASONS = new Set(['max-tokens', 'maxTokens', 'max-turns', 'maxTurns'])

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

/**
 * 删掉一个组的名册成员和它们的 usage（组本身由调用方从 state.groups 移除）。
 * `/groups/delete` 与 `pruneArchivedGroups` 共用，保证「删组」语义只有一份。
 * @returns {number} 实际从 state.members 里移走的人数
 */
function dropGroupRoster(group) {
  let dropped = 0
  for (const memberId of (group && group.memberIds) || []) {
    const before = state.members.length
    state.members = state.members.filter((member) => member.id !== memberId)
    if (state.members.length !== before) dropped += 1
    delete state.usage[memberId]
  }
  return dropped
}

/**
 * 只清理「已归档且归档时长 > keepDays 天」的小组。
 *
 * 入选条件（三条同时满足）：`archived === true`、`archivedAt` 是有限数字、
 * `now - archivedAt > keepDays * 86400e3`。**缺 `archivedAt` 的归档组一律保留** ——
 * 判不出归档时长就保守处理，宁可留一个空壳也不误删。
 * 删除语义与 `POST /groups/delete` 完全一致（连名册成员与 usage 一起清），dryRun 只预览不动 state。
 *
 * @param {{dryRun?: boolean, keepDays?: number, now?: number}} [options]
 * @returns {Promise<{removed: Array<{id: string, name: string, archivedAt: number, members: number}>, kept: number, dryRun: boolean}>}
 *   `kept` = 归档组里本次没删的数量（含未满 keepDays 的、缺 archivedAt 的）。
 */
async function pruneArchivedGroups({ dryRun = false, keepDays = ARCHIVED_KEEP_DAYS, now = Date.now() } = {}) {
  await load()
  const windowMs = keepDays * 86_400_000
  const archivedGroups = (state.groups || []).filter((group) => group && group.archived === true)
  const doomed = archivedGroups.filter((group) =>
    typeof group.archivedAt === 'number'
    && Number.isFinite(group.archivedAt)
    && (now - group.archivedAt) > windowMs)
  // members 是名册成员数（与删除动作一一对应；重复 id 极罕见，仍按名册长度报）
  const removed = doomed.map((group) => ({
    id: group.id,
    name: group.name,
    archivedAt: group.archivedAt,
    members: (group.memberIds || []).length,
  }))
  if (!dryRun && doomed.length) {
    const ids = new Set(doomed.map((group) => group.id))
    for (const group of doomed) dropGroupRoster(group)
    state.groups = state.groups.filter((group) => !ids.has(group.id))
    if (state.activeGroupId && ids.has(state.activeGroupId)) state.activeGroupId = undefined
    await save()
  }
  return { removed, kept: archivedGroups.length - removed.length, dryRun: Boolean(dryRun) }
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

/** 读 workspace.json 的 global.archivedSessionIds（归一化去掉 `session-` 前缀），10 秒缓存。 */
async function archivedSessionIds() {
  const now = Date.now()
  if (archivedIdsCache.ids && now - archivedIdsCache.at < ARCHIVED_CACHE_MS) return archivedIdsCache.ids
  const ids = new Set()
  try {
    const parsed = JSON.parse(await readFile(WORKSPACE_FILE, 'utf8'))
    const list = parsed && parsed.global && Array.isArray(parsed.global.archivedSessionIds)
      ? parsed.global.archivedSessionIds
      : []
    for (const value of list) {
      const norm = normalizeSessionId(value)
      if (norm) ids.add(norm)
    }
  } catch { /* 读不到就跳过，不报错 */ }
  archivedIdsCache = { at: now, ids }
  return ids
}

/**
 * 让「组」跟着会话的归档状态走：会话进 archivedSessionIds → 组 archived=true；
 * 从列表里移除（取消归档）→ 清掉 archived/archivedAt。无 sessionId 的组不动。
 *
 * **重新计时**：取消归档会把 `archived` 与 `archivedAt` 一起删掉，所以再次归档时
 * `desired === Boolean(group.archived)` 必然不相等、会走到下面的归档分支，写入**新的**
 * `archivedAt = Date.now()`，保留期从这次归档重新算（不会沿用旧时间）。
 * 缺 `archivedAt` 的已归档旧数据保持原样：prune 的保守规则是「判不出时长就保留」，
 * 这里不擅自补时间。
 * @returns {Promise<number>} 变更的组数
 */
async function syncArchivedGroups() {
  try {
    await load()
    const ids = await archivedSessionIds()
    let changed = 0
    for (const group of state.groups || []) {
      if (!group || !group.sessionId) continue
      const desired = ids.has(normalizeSessionId(group.sessionId))
      if (desired === Boolean(group.archived)) continue
      if (desired) {
        group.archived = true
        // 每次归档都取当前时间；取消归档已把旧 archivedAt 删掉，所以这是全新计时起点。
        group.archivedAt = Date.now()
      } else {
        delete group.archived
        delete group.archivedAt
      }
      changed += 1
    }
    if (changed) await save()
    return changed
  } catch (error) {
    try { ctx0?.logger?.('council').warn?.(`syncArchivedGroups failed: ${error?.message ?? error}`) } catch { /* ignore */ }
    return 0
  }
}

let ctx0

/** 正在跑的小组派活：callId → { cancelled, reason }；供 /runs/cancel 停止。 */
const activeCalls = new Map()
function callCancelled(callId) {
  const entry = callId && activeCalls.get(callId)
  return Boolean(entry && entry.cancelled)
}
function signalFor(callId, timeoutMs) {
  const parts = [AbortSignal.timeout(timeoutMs)]
  const entry = callId && activeCalls.get(callId)
  if (entry && entry.controller) parts.push(entry.controller.signal)
  return parts.length > 1 ? AbortSignal.any(parts) : parts[0]
}

/**
 * 成员单次运行预算（分钟）。
 * 新增的可配项：profile 配置 `config.memberTimeoutMinutes`（cordis.patch.yml 的 config 里写）；
 * 取值顺序与 apiSettings 一致：页面已保存的 `state.config.memberTimeoutMinutes`
 * → profile 的 `config.memberTimeoutMinutes` → 默认 30 分钟。
 * 非正数/非数字一律当「没配」，回落到默认值（避免 0 分钟立刻 SIGTERM）。
 */
function memberTimeoutMinutes(config) {
  const own = (state && state.config) || {}
  const raw = own.memberTimeoutMinutes ?? (config && config.memberTimeoutMinutes)
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MEMBER_TIMEOUT_MINUTES
}

/** 成员单次运行预算（毫秒）：run() / signalFor() / runDeepseekViaSeam 统一用它。 */
function memberTimeoutMs(config) {
  return Math.round(memberTimeoutMinutes(config) * 60_000)
}

/**
 * 审核 prompt 里贴的成员产出。
 * 默认整段传入；只有超过 REVIEW_TEXT_HARD_CAP 才截（防畸形 prompt），
 * 保证「前 4000 字之后的内容」审核也能看到。
 */
function reviewText(output) {
  const text = String((output && output.text) || output || '')
  return text.length > REVIEW_TEXT_HARD_CAP ? text.slice(0, REVIEW_TEXT_HARD_CAP) : text
}

/** Collect stdout+stderr of one child process; caller owns the timeout. */
function run(bin, args, { cwd, env, input, timeoutMs = memberTimeoutMs(), signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    const hardKill = () => { try { child.kill('SIGKILL') } catch { /* ignore */ } }
    const onAbort = () => { try { child.kill('SIGTERM') } catch { /* ignore */ } setTimeout(hardKill, 3000) }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
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
async function runCodex({ cwd, model, resume, prompt, env, noTools, signal }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd]
  if (model) args.push('--model', model)
  if (resume) args.push('resume', resume, prompt)
  else args.push(prompt)
  const { code, out, err } = await run(CODEX_BIN, args, { cwd, env, signal })
  const events = jsonLines(out)
  const started = events.find((e) => e.type === 'thread.started')
  const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
  const done = [...events].reverse().find((e) => e.type === 'turn.completed')
  const text = messages.map((e) => e.item.text).join('\n').trim()
  const usage = done?.usage ?? {}
  return {
    ok: code === 0 && text.length > 0,
    text,
    error: text.length ? undefined : 'codex 没有返回任何消息（检查 base/key 或网络）',
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
async function runClaude({ cwd, model, resume, prompt, env, noTools, signal }) {
  const claudeBin = claudeBinary()
  if (!(await commandExists(claudeBin))) {
    return { ok: false, text: '', error: '未找到 claude CLI（' + claudeBin + '）。装 dsh-subagent-claude-code bundle，或用 COUNCIL_CLAUDE_BIN 指定绝对路径。', usage: null }
  }
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions']
  if (model) args.push('--model', model)
  if (noTools) args.push('--disallowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit')
  if (resume) args.push('--resume', resume)
  const { code, out, err } = await run(claudeBin, args, { cwd, env, signal })
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
async function continueChild(ctx, parent, member, prompt, timeoutMs, callId) {
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')
  if (!subagents || !agents || typeof subagents.sendMessage !== 'function') return null
  try {
    await subagents.sendMessage(parent, member.convId, [{ type: 'text', text: prompt }], { signal: callId ? signalFor(callId, timeoutMs) : AbortSignal.timeout(timeoutMs) })
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
      let stopReason
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
            const kind = String((reason && reason.kind) || '')
            if (TRUNCATED_STOP_REASONS.has(kind)) { truncated = true; stopReason = kind }
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
        ...truncated ? { stopReason: stopReason || 'max-tokens' } : {},
        usage: null,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

async function runDeepseekViaSeam(ctx, member, prompt, config, parent, timeoutMs, presetId, callId, childSink) {
  // 成员单次预算：调用方没显式给（undefined）时走 config.memberTimeoutMinutes（默认 30 分钟）
  const budgetMs = timeoutMs ?? memberTimeoutMs(config)
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
  // `__continue`：截断续跑时即使没开 reuseAgents，也要接着同一个子会话跑（保住上下文）
  if ((reuseEnabled || member.__continue) && member.convId) {
    const reused = await continueChild(ctx, parent, member, prompt, budgetMs, callId)
    // truncated 原样带出（ok 仍按是否有文本算），由 runDeepseekWithContinuation 决定续跑
    if (reused) return reused
    // 续跑请求拿不到原子会话就停：不要拿「继续未完成的部分」去开一个全新的子会话（上下文已丢）
    if (member.__continue) {
      return { ok: false, text: '', error: '续跑失败：原子会话不可用（未产出新内容）', usage: null }
    }
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
      signal: callId ? signalFor(callId, budgetMs) : AbortSignal.timeout(budgetMs),
      delivery: 'caller',
    })
    // 先登记再等结果：即使子会话失败/被取消，本轮清理也要能回收它的目录
    if (childSink && typeof childSink.add === 'function' && activation.childId) childSink.add(activation.childId)
    // 被 max-tokens / max-turns 截断时不能 dispose：续跑要接着这个子会话。
    let keepChild = reuseEnabled
    try {
      const result = await activation.result
      const text = (result.output || [])
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      const stopReason = String(result.stopReason || '')
      const truncated = TRUNCATED_STOP_REASONS.has(stopReason)
      keepChild = reuseEnabled || truncated
      return {
        ok: Boolean(text) && !truncated && stopReason === 'completed',
        text,
        convId: activation.childId,
        error: text ? undefined : ('stop: ' + result.stopReason + (result.diagnostic ? ' · ' + result.diagnostic : '')),
        ...truncated ? { truncated: true, stopReason } : {},
        usage: null,
      }
    } finally {
      // keep the child resident when reuse is enabled (or when it must be continued)
      if (!keepChild) {
        try { await activation.dispose() } catch { /* already gone */ }
      }
    }
  } catch (error) {
    return { ok: false, text: '', error: 'subagent failed: ' + String(error?.message ?? error), usage: null }
  }
}

/**
 * deepseek 成员的「继续未完成的部分」循环。
 *
 * 子会话被 max-tokens / max-turns 截断（`truncated: true`）时**不重开任务**，
 * 而是把上次未完成的原因拼进提示、在同一个子会话里接着跑（`__continue` 强制走
 * continueChild，即使没开 reuseAgents），最多续跑 MEMBER_CONTINUE_LIMIT 次。
 * - 各段产出按顺序拼成完整 text：审核拿到的是全文，不是最后一段；
 * - 回执里带 `continued: n`（续跑次数）；到上限仍截断则 ok:false，交给 callMember 原有的重试。
 *
 * 续跑本身失败（子会话没了 / 超时）时保留已有产出并停下。
 * seam 参数只为测试注入（默认就是真实的 runDeepseekViaSeam）。
 */
async function runDeepseekWithContinuation(ctx, member, prompt, config, parent, timeoutMs, callId, childSink, seam = runDeepseekViaSeam) {
  const first = await seam(ctx, member, prompt, config, parent, timeoutMs, member.__preset, callId, childSink)
  if (!first) return first
  // 只有拿到子会话 id 才能续跑；先写回成员，后续 seam 调用靠它走 continueChild
  if (first.convId) member.convId = first.convId
  const parts = []
  const remember = (value) => {
    const text = String((value && value.text) || '').trim()
    if (text) parts.push(text)
  }
  remember(first)
  let result = first
  let continued = 0
  while (result.truncated && member.convId && continued < MEMBER_CONTINUE_LIMIT) {
    continued += 1
    const reason = String(result.stopReason || result.error || 'max-tokens')
    const nextPrompt = [
      `[续跑 ${continued}/${MEMBER_CONTINUE_LIMIT}] 上一轮没有跑完（原因：${reason}）。`,
      '请继续未完成的部分：不要重复已完成的工作，直接接着做剩下的，最后给出完整结论。',
    ].join('\n')
    const next = await seam(ctx, Object.assign({}, member, { __continue: true }), nextPrompt, config, parent, timeoutMs, member.__preset, callId, childSink)
    if (!next) break
    result = next
    if (result.convId) member.convId = result.convId
    remember(result)
  }
  if (!continued) return result
  const merged = Object.assign({}, result, { text: parts.join('\n\n'), continued })
  if (merged.truncated) {
    merged.ok = false
    merged.error = `成员回复被 ${merged.stopReason || 'max-tokens'} 截断（已续跑 ${continued} 次仍未完成）`
  }
  return merged
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
async function reviewImage(ctx, group, result, config, styleOverride, callId) {
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
  const base = rootUrl(settings.codexBase) || rootUrl(await codexCliBase())
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

function commanderRole(group) {
  if (group.commanderPrompt) {
    return { name: '指挥', prompt: group.commanderPrompt }
  }
  const roles = state.roles || []
  return roles.find((r) => r.name === '指挥' || r.name.indexOf('指挥') === 0) || { name: '指挥', prompt: '' }
}

function account(memberId, usage) {
  const member = state.members.find((m) => m.id === memberId)
  if (member) member.updatedAt = Date.now()
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
  const raw = String(text || '').trim()
  if (!raw) return null
  const stripped = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim()
  const pick = (obj) => (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, 'ok')
    ? { ok: obj.ok === true, reason: String(obj.reason ?? '') }
    : null)
  // 1) 整段就是 JSON
  try { const whole = pick(JSON.parse(stripped)); if (whole) return whole } catch { /* 继续 */ }
  // 2) 扫描所有「大括号配平」片段，从后往前取第一个带 ok 字段的
  const candidates = []
  for (let i = 0; i < stripped.length; i += 1) {
    if (stripped[i] !== '{') continue
    let depth = 0
    for (let j = i; j < stripped.length; j += 1) {
      if (stripped[j] === '{') depth += 1
      else if (stripped[j] === '}') {
        depth -= 1
        if (depth === 0) { candidates.push(stripped.slice(i, j + 1)); i = j; break }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    try { const parsed = pick(JSON.parse(candidate)); if (parsed) return parsed } catch { /* 继续 */ }
  }
  // 3) 兜底：reason 里带裸双引号会让 JSON 非法，用正则把结论捞出来
  const okMatch = stripped.match(/"ok"\s*:\s*(true|false)/i)
  if (okMatch) {
    const reasonMatch = stripped.match(/"reason"\s*:\s*"([\s\S]*?)"\s*[,}]/)
    return { ok: okMatch[1].toLowerCase() === 'true', reason: reasonMatch ? reasonMatch[1].replace(/\\"/g, '"') : '' }
  }
  return null
}

/** One turn on the member's own framework, preserving its session and tools. */
let runKindOverride = null

/** 测试可替换的成员执行器入口；生产环境恒走 runKindImpl。 */
function runKind(ctx, member, prompt, config, group, styleOverride, parent, timeoutMs, callId, childSink) {
  return (runKindOverride || runKindImpl)(ctx, member, prompt, config, group, styleOverride, parent, timeoutMs, callId, childSink)
}

async function runKindImpl(ctx, member, prompt, config, group, styleOverride, parent, timeoutMs, callId, childSink) {
  await applyProxy(config)
  const cwd = member.cwd || config.defaultWorkspace || process.cwd()
  // 单次运行预算：显式传了（审核等有界调用）就用传的，否则走 memberTimeoutMinutes
  const budgetMs = timeoutMs ?? memberTimeoutMs(config)
  let result
  if (member.kind === 'image') {
    const style = String(styleOverride || (group && group.style) || '')
    const imagePrompt = style ? `[统一风格规范]\n${style}\n\n[画面]\n${prompt}` : prompt
    result = await runImage(member, imagePrompt, config)
  } else if (member.kind === 'deepseek') {
    // max-tokens / max-turns 截断时在同一个子会话里续跑（最多 MEMBER_CONTINUE_LIMIT 次）
    result = await runDeepseekWithContinuation(ctx, member, prompt, config, parent, budgetMs, callId, childSink)
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
      signal: callId ? signalFor(callId, budgetMs) : undefined,
    })
  }
  if (result.convId) member.convId = result.convId
  if (result.usage) account(member.id, result.usage)
  return result
}

/** Stage one: the producing agent reviews its own output in its own session. */
async function selfReview(ctx, member, task, output, config, group, styleOverride, parent, callId) {
  if (member.kind === 'image') {
    const verdict = await reviewImage(ctx, group, { file: output.file, task }, config, styleOverride, callId)
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
  const result = await runKind(ctx, member, prompt, config, group, undefined, parent, undefined, callId)
  let parsed = verdictOf(result.text)
  if (parsed === null && result.ok) {
    const retry = await runKind(ctx, member, prompt + '\n\n注意：只输出 JSON，不要任何解释或前后缀。', config, group, undefined, parent, undefined, callId)
    parsed = verdictOf(retry.text)
  }
  if (parsed === null) console.error('[council] selfReview unparsed raw:', JSON.stringify(String(result.text || '').slice(0, 400)))
  const verdict = parsed ?? { ok: null, reason: result.ok ? '自审输出无法解析（已重试一次）' : (result.error || '自审失败') }
  verdict.by = member.name
  return verdict
}

/** Preliminary check by the member holding the 审校 role. */
async function prelimReview(ctx, group, member, task, output, config, styleOverride, parent, brief, callId) {
  const reviewer = memberWithRole(group, '审校')
  if (!reviewer) return null
  if (output && output.image) {
    return reviewImage(ctx, group, { file: output.file, task }, config, styleOverride, callId)
  }
  const prompt = [
    '你是这个小组的审校，做初步校验（之后还有指挥的最终审核）。',
    '禁止使用任何工具（bash / read / glob / 搜索等），也不要浏览文件系统；只根据下面的信息判断，立即只输出 JSON。',
    '注意：你看不到磁盘，所以不要以"缺截图/缺文件/缺附件"为由判不通过；只要产出文本里说明了产物路径与验证结果，就按已交付处理，只挑文本层面的缺失（漏项、口径矛盾、阈值不符）。',
    ...(brief ? ['[背景]', brief, ''] : []),
    `成员 ${member.name}（${member.kind}）完成了任务：${task}`,
    '[产出]',
    reviewText(output),
    '只输出一个 JSON：{"ok":true 或 false,"reason":"不超过 60 字"}',
  ].join('\n')
  const reviewChildKey = '__reviewConvId'
  reviewer[reviewChildKey] = (state.reviewChildren || {})[reviewer.id]
  const result = await runKind(ctx, Object.assign({}, reviewer, { convId: reviewer[reviewChildKey], __preset: 'minimal', __noTools: true }), prompt, config, group, undefined, parent, 120_000, callId)
  if (result && result.convId) { state.reviewChildren = state.reviewChildren || {}; state.reviewChildren[reviewer.id] = result.convId; save().catch(() => {}) }
  let parsed = verdictOf(result.text)
  if (parsed === null && result.ok) {
    const retry = await runKind(ctx, Object.assign({}, reviewer, { convId: reviewer[reviewChildKey], __preset: 'minimal', __noTools: true }), prompt + '\n\n注意：只输出 JSON，不要任何解释或前后缀。', config, group, undefined, parent, 120_000, callId)
    parsed = verdictOf(retry.text)
  }
  const verdict = parsed ?? { ok: null, reason: result.ok ? '审校输出无法解析（已重试一次）' : (result.error || '审校失败') }
  verdict.by = reviewer.name
  return verdict
}

/** Stage two: the commander accepts or rejects the delivered work. */
async function commanderReview(ctx, group, member, task, output, config, parent, brief, styleOverride, callId) {
  // 指挥 is whichever member holds the 指挥 role in this group.
  const commanderMember = memberWithRole(group, '指挥')
  if (commanderMember && output && output.image && output.file) {
    // 图片产出：任何腿都要真看图（claude 用 Read，deepseek 子代理用 read_image）
    const style = String(styleOverride || (group && group.style) || '')
    const filePath = JSON.stringify(String(output.file))
    const cmdRole = commanderRole(group)
    const imagePrompt = [
      `[你的职位] ${cmdRole.name}`,
      cmdRole.prompt ? `[职位职责与风格]\n${cmdRole.prompt}\n` : '',
      '你是这个小组的指挥，现在对这张图做最终验收。',
      '统一风格规范：' + (style || '（未指定，按画面要求判断）'),
      '',
      '只允许读取下面这一个文件（不要浏览目录、不要对其余文件调用任何工具）：' + filePath,
      '画面要求：' + task,
      '',
      '只输出一个 JSON：{"ok":true 或 false,"reason":"不超过 80 字的中文理由"}',
    ].join('\n')
    const imgReviewer = Object.assign({}, commanderMember, { convId: commanderMember.convId, __reuse: true })
    let seen = await runKind(ctx, imgReviewer, imagePrompt, config, group, styleOverride, parent, 120_000, callId)
    let parsed = verdictOf(seen.text)
    if (parsed === null && seen.ok) {
      const retry = await runKind(ctx, imgReviewer, imagePrompt + '\n\n注意：只输出 JSON，不要任何解释。', config, group, styleOverride, parent, 120_000, callId)
      parsed = verdictOf(retry.text)
    }
    const verdict = parsed ?? { ok: null, reason: seen.ok ? '指挥看图后输出无法解析（已重试一次）' : (seen.error || '指挥读图失败') }
    verdict.by = commanderMember.name
    if (parsed === null) console.error('[council] commander image review unparsed:', String(seen.text || '').slice(0, 200))
    return verdict
  }
  if (commanderMember) {
    const cmdRole = commanderRole(group)
    const prompt = [
      `[你的职位] ${cmdRole.name}`,
      cmdRole.prompt ? `[职位职责与风格]\n${cmdRole.prompt}\n` : '',
      '你是这个小组的指挥，现在做验收。',
      '禁止使用任何工具，也不要浏览文件系统；只根据下面的信息判断，立即只输出 JSON。',
      '注意：你看不到磁盘，不要以"缺截图/缺文件"为由驳回；只判文本层面的缺失与矛盾。',
      ...(brief ? ['[背景]', brief, ''] : []),
      `成员 ${member.name}（${member.kind}）完成了任务：${task}`,
      '[产出]',
      reviewText(output),
      '只输出一个 JSON：{"ok":true 或 false,"reason":"不超过 60 字"}',
    ].join('\n')
    // Never resume the commander member's own thread: reviews are side-channel.
    const reviewMember = Object.assign({}, commanderMember, { convId: commanderMember.convId, __preset: 'minimal', __noTools: true, __reuse: true })
    const result = await runKind(ctx, reviewMember, prompt, config, group, undefined, parent, 120_000, callId)
    let parsed = verdictOf(result.text)
    if (parsed === null && result.ok) {
      const retry = await runKind(ctx, reviewMember, prompt + '\n\n注意：只输出 JSON，不要任何解释或前后缀。', config, group, undefined, parent, 120_000, callId)
      parsed = verdictOf(retry.text)
    }
    const verdict = parsed ?? { ok: null, reason: result.ok ? '指挥审核输出无法解析（已重试一次）' : (result.error || '审核失败') }
    verdict.by = commanderMember.name
    return verdict
  }
  return null
}

/** Ask the acceptance-commander member to decompose the user's request. */
async function planWithCommander(ctx, group, request, config, parent, callId) {
  const commander = memberWithRole(group, '指挥')
  if (!commander) return { assignments: [], raw: '', error: '这个小组还没有分配「指挥」职位给任何成员' }
  // 先按 10 分钟缓存刷新模型清单，再拼同步文本（section/提示词都必须同步返回）。
  await modelCatalog(ctx, config).catch(() => {})
  const prompt = [
    '你是这个小组的指挥。把用户的要求拆成给成员的自包含任务。',
    rosterText(group),
    catalogText(),
    '',
    '只输出一个 JSON 对象，不要其它文字：',
    '{"staffing":[{"role":"职位名","kind":"codex|claude|deepseek|image","model":"模型id"}],"assignments":[{"member":"成员id、名字或职位名","task":"自包含任务，含背景/目标/验收标准"}]}',
    '',
    '[用户要求]',
    request,
  ].join('\n')
  const cmem = (state.memberMemory || {})[commander.id]
  const cdigest = cmem && cmem.digest && (state.config || {}).memoryInject !== false
    ? '\n\n[你之前为这个小组做过的事（摘要）]\n' + cmem.digest
    : ''
  const commanderOpts = { convId: commander.convId, __preset: 'minimal', __noTools: true, __reuse: true }
  const planned = await runKind(ctx, Object.assign({}, commander, commanderOpts), prompt + cdigest, config, group, undefined, parent, undefined, callId)
  if (planned && planned.convId) { commander.convId = planned.convId; save().catch(() => {}) }
  const plan = parsePlan(planned.text)
  return {
    assignments: plan ? plan.assignments : [],
    staffing: plan ? plan.staffing : [],
    raw: planned.text || planned.error || '',
    error: planned.ok ? undefined : (planned.error || '指挥调用失败'),
  }
}

async function callMember(ctx, member, task, config, group, styleOverride, parent, brief, onStage, onWork, callId, childSink) {
  const role = roleOf(member)
  const memory = (state.memberMemory || {})[member.id]
  const memoryBlock = memory && memory.digest && (state.config || {}).memoryInject !== false
    ? '\n\n[你之前为这个小组做过的事（摘要）]\n' + memory.digest
    : ''
  const standardBlock = group.standard ? '\n\n[验收标准]\n' + group.standard : ''
  const prompt = memberPrompt(member, task) + standardBlock + (brief ? '\n\n[背景]\n' + brief : '') + memoryBlock + WORK_STYLE
  if (onStage) onStage('执行中（' + member.kind + '）')
  let result = await runKind(ctx, member, prompt, config, group, styleOverride, parent, undefined, callId, childSink)
  // watchdog retry: a timeout / dead agent gets one more attempt on the same member
  const maxAttempts = 2
  let attempt = 1
  while (!result.ok && attempt < maxAttempts) {
    attempt += 1
    const why = String(result.error || '无输出')
    if (onStage) onStage('重试中（第 ' + attempt + ' 次，上次：' + why.slice(0, 40) + '）')
    const retryPrompt = prompt + '\n\n[上次失败] ' + why + '\n请重新完成任务，直接给出结果。'
    result = await runKind(ctx, member, retryPrompt, config, group, styleOverride, parent, undefined, callId, childSink)
    await save().catch(() => {})
  }
  if (attempt > 1) result = Object.assign({}, result, { attempts: attempt })
  if (callCancelled(callId)) return { memberId: member.id, name: member.name, role: role?.name, kind: member.kind, model: member.model, ok: false, accepted: false, acceptance: 'cancelled', text: '', error: '已被用户停止' }
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
  const requirePrelim = group.requirePrelim ?? true
  const requireCommander = group.requireCommander ?? true
  const maxRework = group.maxRework ?? 1
  const hasPrelimReviewer = Boolean(memberWithRole(group, '审校'))
  const hasCommanderReviewer = Boolean(memberWithRole(group, '指挥'))
  const expectReviews = (requirePrelim && hasPrelimReviewer) || (requireCommander && hasCommanderReviewer)
  const acceptanceOf = () => {
    const list = [review.self, review.commander].map(verdictOf).filter(Boolean)
    // 本组根本没有审核位 → 不做验收；配了审核却一粒结论都没拿到 → 未判定（必须返工）
    if (!list.length) return expectReviews ? 'unverified' : 'none'
    if (list.includes('rejected')) return 'rejected'
    if (list.includes('unverified')) return 'unverified'
    return 'passed'
  }
  let acceptance = result.ok ? 'none' : 'skipped'
  let reworkError
  let reworkFailed = false

  if (result.ok) {
    if (requirePrelim) {
      if (onStage) onStage('初审（审校）')
      review.prelim = await prelimReview(ctx, group, member, task, result, config, styleOverride, parent, brief, callId)
      review.self = review.prelim || await selfReview(ctx, member, task, result, config, group, styleOverride, parent, callId)
    }
    if (requireCommander) {
      if (onStage) onStage('终审（指挥）')
      review.commander = await commanderReview(ctx, group, member, task, result, config, parent, brief, styleOverride, callId)
    }
    acceptance = acceptanceOf()

    // 被否 / 未判定 一律返工，次数由 maxRework 控制（0 = 不返工，仅标记）
    let round = 0
    while ((acceptance === 'rejected' || acceptance === 'unverified') && round < maxRework) {
      round += 1
      const blocks = []
      if (verdictOf(review.self) === 'rejected') blocks.push(`[自审未通过] ${review.self.reason}`)
      if (verdictOf(review.self) === 'unverified') blocks.push(`[自审未判定] ${review.self.reason}`)
      if (verdictOf(review.commander) === 'rejected') blocks.push(`[指挥验收未通过] ${review.commander.reason}`)
      if (verdictOf(review.commander) === 'unverified') blocks.push(`[指挥验收未判定] ${review.commander.reason}`)
      if (onStage) onStage('返工（第 ' + round + ' 次）')
      const rework = `${memberPrompt(member, task)}${standardBlock}${WORK_STYLE}\n\n${blocks.join('\n')}\n请修正后重新提交。`
      review.attempts = 1 + round              // 先记次数：返工即使失败也算尝试过
      const second = await runKind(ctx, member, rework, config, group, styleOverride, parent, undefined, callId, childSink)
      if (!second.ok) {
        reworkFailed = true
        reworkError = String(second.error || '返工未返回产出')
        acceptance = 'rework-failed'           // 保留上一次产出，但明确标记返工失败
        break
      }
      result = second
      review.reworkError = undefined
      if (requirePrelim) {
        review.prelim = await prelimReview(ctx, group, member, task, result, config, styleOverride, parent, brief, callId)
        review.self = review.prelim || await selfReview(ctx, member, task, result, config, group, styleOverride, parent, callId)
      }
      if (requireCommander) {
        if (onStage) onStage('终审（指挥）')
        review.commander = await commanderReview(ctx, group, member, task, result, config, parent, brief, styleOverride, callId)
      }
      acceptance = acceptanceOf()
      reworkFailed = false
      reworkError = undefined
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
    // 被截断后续跑过几次（0/无 → 不带该字段，回执保持原样）
    ...result.continued === undefined ? {} : { continued: result.continued },
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
      staffing: Array.isArray(value.staffing) ? value.staffing : [],
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

/**
 * 拥有这个会话的小组（1:1 绑定）。**归档组不算「当前组」**：
 * 重新打开一个已归档的会话时不能自动进它的旧小组（组归档只打标、不清 sessionId）。
 * @param {object} stateLike 组状态（默认取模块 state）
 * @param {string} sessionId 会话 id，`session-` 前缀可有可无
 */
function groupForSession(stateLike, sessionId) {
  const target = normalizeSessionId(sessionId)
  if (!stateLike || !target) return null
  return (stateLike.groups || []).find((group) =>
    group && group.sessionId && !group.archived && normalizeSessionId(group.sessionId) === target) || null
}

/**
 * 会话归档（`workspace/session-stop`）的回调：只打 `archived` + `archivedAt` 标记，
 * **保留 `sessionId`** —— 否则用户取消归档时 syncArchivedGroups() 找不到这个组，
 * 自动恢复绑定就断了。绑定的 council_* 工具在这里照旧清理。
 * @param {string} sessionId 被归档的会话 id
 * @returns {Promise<object|null>} 被归档的组（没有就不动）
 */
async function archiveGroupForSession(sessionId) {
  await load()
  const group = groupForSession(state, sessionId)
  if (!group) return null
  if (!group.archived) {
    group.archived = true
    group.archivedAt = Date.now()
  }
  // 绑定键是 `group.id\0<agent.id>`，agent.id 未必等于事件里的 sessionId：
  // 按组前缀把这个组的绑定全部清掉（cleanup 自己会从 boundAgents 里删）。
  const prefix = group.id + '\u0000'
  for (const [key, cleanup] of [...boundAgents]) {
    if (!key.startsWith(prefix)) continue
    try { cleanup() } catch { /* ignore */ }
  }
  await save()
  return group
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
    archiveGroupForSession(sid)
      .catch((error) => console.error('[council] archive on session-stop failed:', String(error?.message ?? error)))
  })
  // 进程重启后，已存在的会话不会再触发 agent/created：启动时补绑一次，
  // 否则“恢复的会话”会丢掉 council_* 工具（2026-11-02 实测踩到）。
  // 已归档的组不补绑：归档会话不该再拿到 council_* 工具。
  const rebindExisting = () => {
    load().then(() => {
      const agents = ctx.get('agents')
      if (!agents || typeof agents.list !== 'function') return
      let list = []
      try { list = agents.list() || [] } catch { list = [] }
      for (const agent of list) {
        const aid = agent && agent.id
        if (!aid) continue
        const group = groupForSession(state, aid)
        if (!group) continue
        try { bindAgent(ctx, config, group, agent) } catch (error) {
          console.error('[council] rebind failed:', String((error && error.stack) || error))
        }
      }
    }).catch((error) => console.error('[council] rebind load failed:', String(error?.message ?? error)))
  }
  rebindExisting()
  // 每 20 秒自愈一次：重启/恢复的会话能重新拿到 council_* 工具（绑定是幂等的）
  setInterval(rebindExisting, 20_000).unref?.()
  // 会话归档 → 对应小组跟着归档：初始化后一次 + 每 30 秒自愈（/state 里也会同步）
  // 归档同步之后安静地清一次「归档超过 7 天」的小组：启动一次 + 跟着 30 秒循环走。
  // 失败只记一行日志，绝不影响同步/页面；没有可清理的组时完全静默。
  const syncAndPruneArchived = async () => {
    try { await syncArchivedGroups() } catch { /* syncArchivedGroups 内部已记日志 */ }
    try {
      const result = await pruneArchivedGroups({ dryRun: false })
      if (result.removed.length) {
        try {
          ctx0?.logger?.('council').info?.(
            `archived prune: removed ${result.removed.length} group(s) archived > ${ARCHIVED_KEEP_DAYS}d, kept ${result.kept}`,
          )
        } catch { /* logger 不可用时不影响清理 */ }
      }
    } catch (error) {
      try { ctx0?.logger?.('council').warn?.(`archived prune failed: ${error?.message ?? error}`) } catch { /* ignore */ }
    }
  }
  syncAndPruneArchived().catch(() => {})
  setInterval(() => { syncAndPruneArchived().catch(() => {}) }, 30_000).unref?.()
  ctx.inject(['agents'], (scope) => {
    scope.on('agent/created', ({ agent }) => {
      load().then(() => {
        const group = groupForSession(state, agent && agent.id)
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
            // 归档状态随 /state 一起刷新（10 秒缓存内只是一次 Set 查找）
            try { await syncArchivedGroups() } catch { /* 同步失败不影响状态读取 */ }
            try {
              const sid = url.searchParams.get('sessionId')
              if (sid) {
                // 已归档的组不惰性补绑：归档会话不该再注册 council_* 工具
                const group = groupForSession(state, sid)
                const agents = ctx.get('agents')
                const agent = agents && group && (agents.get?.(group.sessionId) || agents.get?.(sid))
                if (group && agent) bindAgent(ctx, config, group, agent)
              }
            } catch { /* 绑定失败不影响状态读取 */ }
            return send(res, 200, { state, config: publicConfig(config) })
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            if (route === '/roles') {
              // kind 只接受四种框架；空字符串表示“回到默认（claude）”并清掉模型。
              if (body.kind !== undefined && body.kind !== '' && !STAFF_KINDS.includes(body.kind)) {
                return send(res, 400, { error: 'unknown kind: ' + body.kind + '（可用：' + STAFF_KINDS.join('/') + '）' })
              }
              if (body.id) {
                const role = state.roles.find((r) => r.id === body.id)
                if (role) {
                  const patch = pick(body, ['name', 'prompt', 'color', 'kind', 'model'])
                  // 换框架但没给模型：清掉旧框架的模型，回落到新框架的默认模型
                  if (patch.kind !== undefined && patch.kind !== role.kind && patch.model === undefined) delete role.model
                  Object.assign(role, patch)
                }
                await save()
                return send(res, 200, { state })
              }
              const role = { id: `r_${randomUUID().slice(0, 8)}`, name: body.name || '新职位', prompt: body.prompt || '', color: body.color, ...pick(body, ['kind', 'model']) }
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
                  member.updatedAt = Date.now()
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
                updatedAt: Date.now(),
              }
              state.members.push(member)
              const group = (body.groupId ? findGroup(body.groupId) : undefined) || activeGroup()
              if (group && !group.memberIds.includes(member.id)) group.memberIds.push(member.id)
              await save()
              return send(res, 200, { state, member })
            }
            if (route === '/members/delete') {
              // 与 council_member 工具同样保护：不许把组里最后一个成员删光（面板误点会直接废掉小组）
              const owning = state.groups.filter((g) => (g.memberIds || []).includes(body.id))
              const wouldEmpty = owning.find((g) => (g.memberIds || []).length <= 1)
              if (wouldEmpty) return send(res, 409, { error: 'cannot delete the last member of group ' + wouldEmpty.id })
              state.members = state.members.filter((m) => m.id !== body.id)
              for (const g of state.groups) g.memberIds = g.memberIds.filter((id) => id !== body.id)
              delete state.usage[body.id]
              await save()
              return send(res, 200, { state })
            }
            if (route === SESSIONS_PRUNE_ROUTE) {
              // 历史子会话清理（POST /council/api/sessions/prune）：只删 $DSH_HOME/sessions/<桶>/<uuid>/
              // （两层直接子目录、非符号链接、不在保留集合、keepDays 内目录没动过）；dryRun 只预览。默认保留 7 天。
              const keepDays = Number(body.keepDays)
              const result = await pruneSessionDirs(ctx, {
                dryRun: Boolean(body.dryRun),
                keepDays: Number.isFinite(keepDays) && keepDays >= 0 ? keepDays : 7,
              })
              return send(res, 200, result)
            }
            if (route === '/members/prune') {
              // 手动清理：不属于任何组、且从未跑过 / 30 天没动过的成员；dryRun 只预览
              const result = pruneOrphanMembers({ dryRun: Boolean(body.dryRun) })
              if (!result.dryRun && result.removed.length) await save()
              return send(res, 200, result)
            }
            if (route === '/members/role') {
              const member = state.members.find((m) => m.id === body.id)
              if (member) { member.roleId = body.roleId || undefined; member.updatedAt = Date.now() }
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
                archived: false,
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
              // members belong to their group; deleting the group deletes its roster
              if (doomed) dropGroupRoster(doomed)
              state.groups = state.groups.filter((g) => g.id !== body.id)
              await save()
              return send(res, 200, { state })
            }
            if (route === ARCHIVED_PRUNE_ROUTE) {
              // 只清理「已归档且归档时长 > keepDays 天」的小组（HTTP: POST /council/api/groups/prune-archived）。
              // 缺 archivedAt 的归档组一律保留；dryRun 只预览。返回 { removed, kept, dryRun }。
              const keepDays = Number(body.keepDays)
              const result = await pruneArchivedGroups({
                dryRun: Boolean(body.dryRun),
                keepDays: Number.isFinite(keepDays) && keepDays >= 0 ? keepDays : ARCHIVED_KEEP_DAYS,
              })
              return send(res, 200, result)
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
            if (route === '/runs/cancel') {
              console.error('[council] cancel requested at ' + Date.now() + ' running=' + JSON.stringify([...activeCalls.keys()]))
              const target = body.callId || body.id
              const at = Date.now()
              let stopped = 0
              if (!target || body.all) {
                for (const [id, entry] of activeCalls) { entry.cancelled = true; try { entry.controller.abort() } catch { /* */ } stopped += 1 }
              } else if (activeCalls.has(target)) {
                const entry = activeCalls.get(target)
                entry.cancelled = true
                try { entry.controller.abort() } catch { /* */ }
                stopped = 1
              }
              // activeCalls 只管得到「已在执行」的调用；卡在选成员/拆解/子代理启动、或进程重启打断的
              // 进度条目不在里面，必须一起收尾，否则进度条永远停在「准备中」。
              let clearedProgress = 0
              if (!target || body.all) {
                for (const entry of progressMap.values()) {
                  if (finishProgressEntry(entry, at, { cancelled: true })) clearedProgress += 1
                }
              } else if (finishProgressEntry(progressMap.get(target), at, { cancelled: true })) {
                clearedProgress = 1
              }
              return send(res, 200, { stopped, clearedProgress, running: [...activeCalls.keys()], at })
            }
            if (route === '/groups/policy') {
              const group = findGroup(body.id)
              if (!group) return send(res, 404, { error: 'group not found' })
              if (body.maxRework !== undefined) group.maxRework = Math.max(0, Math.floor(body.maxRework))
              if (body.requirePrelim !== undefined) group.requirePrelim = Boolean(body.requirePrelim)
              if (body.requireCommander !== undefined) group.requireCommander = Boolean(body.requireCommander)
              if (body.autoPrune !== undefined) group.autoPrune = Boolean(body.autoPrune)
              if (body.standard !== undefined) group.standard = String(body.standard)
              if (body.commanderPrompt !== undefined) group.commanderPrompt = String(body.commanderPrompt)
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
            // 读取时自愈：陈旧的未完成项在这里收尾，不指望派活自己回来写 finishedAt
            healProgress()
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
                  strictDelegate: own.strictDelegate !== false,
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
              if (typeof body.strictDelegate === 'boolean') next.strictDelegate = body.strictDelegate
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
                  strictDelegate: own.strictDelegate !== false,
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

/** 未完成且启动超过 10 分钟 → 当陈旧项自动收尾（派活卡在选成员/拆解/子代理启动时不会永远「准备中」）。 */
const PROGRESS_STALE_MS = 10 * 60_000
/** 陈旧项标完后最多再留 5 分钟，够前端看到一次就删。 */
const PROGRESS_STALE_KEEP_MS = 5 * 60_000
/** 已完成项最多留 24 小时。 */
const PROGRESS_DONE_KEEP_MS = 24 * 60 * 60_000
/** 指挥占位阶段的成员 id：没有真正成员时用它显示「拆解中 / 派活中」。 */
const PROGRESS_STAGE_ID = '__stage__'

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

/** 写「指挥」占位阶段：成员还没拆出来时进度条也有东西可显示。 */
function progressStage(callId, stage, name = '指挥') {
  progressSet(callId, PROGRESS_STAGE_ID, { name, stage, stageOnly: true })
}

/** 把一条进度标成结束；已结束（含 cancel 先标过）返回 false，避免把 clearedProgress 算重。 */
function finishProgressEntry(entry, now, patch) {
  if (!entry || entry.finishedAt) return false
  entry.finishedAt = now
  if (patch) Object.assign(entry, patch)
  return true
}

/**
 * `/progress` 读取时自愈，返回本次新标成陈旧的条数：
 *  - 未完成且 startedAt 超过 10 分钟 → 写 finishedAt + stale:true（staleAt 记标记时间）
 *  - 已标 stale 的 entry 超过 5 分钟 → 从 Map 删除（前端最多看到一次）
 *  - 已完成的 entry 超过 24 小时 → 删除
 */
function healProgress(now = Date.now()) {
  let markedStale = 0
  for (const [id, entry] of progressMap) {
    if (!entry) { progressMap.delete(id); continue }
    if (!entry.finishedAt && now - (entry.startedAt || 0) > PROGRESS_STALE_MS) {
      entry.finishedAt = now
      entry.stale = true
      entry.staleAt = now
      markedStale += 1
    }
    if (entry.finishedAt && entry.stale && now - (entry.staleAt || entry.finishedAt) > PROGRESS_STALE_KEEP_MS) {
      progressMap.delete(id)
      continue
    }
    if (entry.finishedAt && now - entry.finishedAt > PROGRESS_DONE_KEEP_MS) progressMap.delete(id)
  }
  return markedStale
}

/** Human/roster text injected into a bound chat session's system prompt. */
function mandateText(group) {
  return [
    '【小组模式约束】',
    '本会话已开启「小组模式」。凡是用户提出的任务类请求（写代码、改文件、跑命令、出图、做音乐、建模、调研等），必须用 council_delegate 工具派给成员完成。',
    '你自己不得编写实现代码、不得直接修改文件或执行构建命令来完成任务（只能读取、检查、验收）。',
    '例外只有三种：① 用户明确说"你自己做"或"你直接改"；② 只是回答关于小组本身的问题（怎么用、成员有谁、为什么失败）；③ 需要检查文件/日志/状态来验收或排障（只读操作）。',
    '若你发现自己在写代码或跑构建命令，立即停下，改用 council_delegate 派给成员。',
    '违反这条 = 任务失败。',
  ].join('\n')
}

/**
 * 硬拦截（方案 A）：小组模式下父会话自己执行「写操作」的守卫。
 *
 * 系统提示词拦不住（实测：一个 2.5D 会话里父会话自己跑了 bash 120 次 / edit 12 次 /
 * blender_python 6 次 / blender_render 10 次，只派活 25 次），所以在 `agent.ctx.tools.guard()`
 * 上加一道单调守卫：写类工具直接拒绝，只读工具与 bash 放行（bash 只计审计数）。
 * 逃生口：state.config.strictDelegate=false，或本轮最后一条用户消息里明确让父会话自己动手。
 */
const WRITE_TOOLS = new Set([
  'edit', 'write', 'apply_patch',
  'blender_python', 'blender_import', 'blender_export',
  'blender_render', 'blender_render_frames',
])

/** 用户明确放行父会话自己动手的说法（只看最后一条用户消息）。 */
const SELF_WORK_ESCAPE = /你自己做|你直接改|你亲自动手|放行/

/** 拒绝理由：与 mandateText 的措辞一致，并给出两条逃生路径。 */
const SELF_WORK_DENY_REASON = '小组模式：不要自己执行写操作。用 council_delegate 派给成员；确需亲自动手请用户说“你自己做”，或把 config.strictDelegate 设为 false。'

/** 按组累加的越权审计：{ blocked, tools: { [name]: count }, bash, lastAt }。 */
const selfWorkAudit = new Map()
/** 按组缓存的本轮「用户已放行」判定（守卫里读它；delegate 开始时也会刷新一次）。 */
const selfWorkPermits = new Map()

function selfWorkAuditFor(groupId) {
  let entry = selfWorkAudit.get(groupId)
  if (!entry) {
    entry = { blocked: 0, tools: {}, bash: 0, lastAt: 0 }
    selfWorkAudit.set(groupId, entry)
  }
  return entry
}

/** 清空审计（不传 groupId 清全部；测试与重新开始一轮时用）。 */
function resetSelfWorkAudit(groupId) {
  if (groupId === undefined) selfWorkAudit.clear()
  else selfWorkAudit.delete(groupId)
}

/** 「edit×2、blender_render×1」这种可读分布（次数降序，同次数按名字）。 */
function selfWorkBlockedDetail(entry) {
  return Object.entries(entry && entry.tools ? entry.tools : {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => name + '×' + count)
    .join('、')
}

/** 本轮是否允许父会话自己动手：页面配置 > profile 配置 > 默认 true。 */
function strictDelegateEnabled(config) {
  const own = state.config
  if (own && typeof own.strictDelegate === 'boolean') return own.strictDelegate
  if (config && typeof config.strictDelegate === 'boolean') return config.strictDelegate
  return true
}

/** 取会话里最后一条用户消息的文本（同步；sessionEvents 本身就是同步读）。 */
function lastUserMessageText(session) {
  try {
    const events = sessionEvents(session)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (!ev || ev.type !== 'user/message') continue
      const text = (ev.data?.message?.content || [])
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text).join('\n').trim()
      return { seq: ev.seq, text }
    }
    const last = events[events.length - 1]
    return { seq: last && last.seq, text: '' }
  } catch {
    return { seq: undefined, text: '' }
  }
}

/**
 * 刷新「本轮用户已放行」置位变量：最后一条用户消息含逃生词 → allowed=true。
 * delegate 开始时调用一次；守卫里在缓存失效时也会补算（会话 seq 变了才重算）。
 */
function noteSelfWorkPermit(group, agent) {
  const { seq, text } = lastUserMessageText(agent && agent.session)
  const cached = selfWorkPermits.get(group.id)
  if (cached && seq !== undefined && cached.seq === seq) return cached
  const permit = { seq, text: text.slice(0, 200), allowed: SELF_WORK_ESCAPE.test(text), at: Date.now() }
  selfWorkPermits.set(group.id, permit)
  return permit
}

/**
 * 造一个绑定到某小组会话的守卫。只有 `execution.agent.id === 该组 sessionId` 时生效，
 * 其他 agent 一律放行；返回字符串 = 拒绝，undefined = 放行。
 */
function makeSelfWorkGuard(group, config) {
  const groupId = group.id
  return (execution) => {
    if (!execution || !execution.agent) return undefined
    // 组被删 / 归档清理后，旧绑定不应再拦任何东西
    const live = state.groups.find((g) => g.id === groupId)
    if (!live || !live.sessionId) return undefined
    if (normalizeSessionId(execution.agent.id) !== normalizeSessionId(live.sessionId)) return undefined
    if (!strictDelegateEnabled(config)) return undefined
    const name = String(execution.name || '')
    // bash 只计入审计，不拦截（否则连只读排障都做不了）
    if (name === 'bash') {
      const audit = selfWorkAuditFor(groupId)
      audit.bash += 1
      audit.lastAt = Date.now()
      return undefined
    }
    if (!WRITE_TOOLS.has(name)) return undefined
    // 用户本轮已明确放行 → 不拦
    if (noteSelfWorkPermit(live, execution.agent).allowed) return undefined
    const audit = selfWorkAuditFor(groupId)
    audit.blocked += 1
    audit.tools[name] = (audit.tools[name] || 0) + 1
    audit.lastAt = Date.now()
    return SELF_WORK_DENY_REASON
  }
}

const STAFF_MODELS = { codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5', deepseek: 'deepseek-flash', image: 'gpt-image-2.5-flare' }
const STAFF_KINDS = Object.keys(STAFF_MODELS)

/** 职位的有效默认框架：只认四种，缺省/未知都按 claude。 */
function roleKind(role) {
  return STAFF_MODELS[role?.kind] ? role.kind : 'claude'
}

/** 补员目标的 kind/model：staffing 显式值 > 职位默认 > 框架默认模型。 */
function staffTarget(role, kind, model) {
  const nextKind = STAFF_KINDS.includes(kind) ? kind : roleKind(role)
  const roleModel = roleKind(role) === nextKind ? role.model : undefined
  return { kind: nextKind, model: model || roleModel || STAFF_MODELS[nextKind] }
}

/**
 * 可用模型清单。systemPrompt 的 section.text 必须是同步字符串，所以这里只读
 * modelCatalog() 的 10 分钟缓存（bindAgent 时预热），没有缓存就用框架默认模型兜底。
 */
function catalogText() {
  const value = (catalog && catalog.value) || {}
  return [
    '当前可用模型清单（按框架分组，来自实时缓存）：',
    ...STAFF_KINDS.map((kind) => {
      const ids = (value[kind] || []).filter(Boolean)
      return `- ${kind}: ${(ids.length ? ids : [STAFF_MODELS[kind]]).join('、')}`
    }),
    'assignments[].member 可写职位名；缺人时按职位默认自动补员。需要补员或调整模型时在 staffing 中声明 {role, kind?, model?}。',
    '需要长期保留的成员：在 staffing 里写 `persistent:true`（默认用完即回收）。',
  ].join('\n')
}

/** 在组内按 id / 职位名 / 成员名解析派活目标。 */
function resolveMember(group, key) {
  const inGroup = (m) => (group.memberIds || []).includes(m.id)
  const label = String(key ?? '')
  return state.members.find((m) => inGroup(m) && m.id === label)
    || state.members.find((m) => inGroup(m) && roleOf(m)?.name === label)
    || state.members.find((m) => inGroup(m) && m.name === label)
}

/**
 * 按 staffing 补员（不重复造人）：
 *   1) 组内已有人持有该职位 → 直接复用；
 *   2) 只有别的组有同名成员 → 拉进本组（不新建）；
 *   3) 都没有 → 新建，name = 职位名；默认打 ephemeral 标记（派活结束后回收），
 *      staffing 项写 persistent:true 时改打持久成员：不打 ephemeral、不进回收名单。
 * 显式给了不相同 kind/model 时更新该成员（并删掉 convId，换模型后不续旧线程）。
 *
 * createdIds：可选收集器，本次新建且会被回收的临时成员 id 会 push 进去（council_delegate 用来回收）。
 * 持久成员（persistent:true）不进这个收集器；复用到的旧临时成员被标成持久时也会从收集器里摘掉。
 * 返回值就是「补员变更」字符串数组（调用方用 push(...) 展开），不带任何附加属性——
 * 这个数组会链进工具返回值，必须保持纯 JSON 安全（DSH 会做 lossless JSON 校验）。
 */
async function ensureStaffing(group, staffing, createdIds) {
  const changes = []
  const created = Array.isArray(createdIds) ? createdIds : []
  let dirty = false
  const inGroup = (m) => (group.memberIds || []).includes(m.id)
  if (!Array.isArray(group.memberIds)) group.memberIds = []
  for (const item of Array.isArray(staffing) ? staffing : []) {
    const changesBefore = changes.length
    const roleName = item && typeof item.role === 'string' ? item.role.trim() : ''
    if (!roleName) { changes.push('- 跳过：staffing 项缺少 role'); continue }
    const role = (state.roles || []).find((r) => r.name === roleName)
    if (!role) { changes.push(`- 跳过：职位「${roleName}」不存在`); continue }
    // 空串表示“用默认”，与没填等价
    const wantKind = item.kind === '' ? undefined : item.kind
    const wantModel = item.model === '' ? undefined : item.model
    // 是否建持久成员：默认 false（用完即回收）。只认显式 true，字符串 "true" 之类一律按 false。
    const wantPersistent = Boolean(item) && item.persistent === true
    if (wantKind !== undefined && !STAFF_KINDS.includes(wantKind)) {
      changes.push(`- 跳过：职位「${roleName}」的框架「${wantKind}」未知`)
      continue
    }
    let member = state.members.find((m) => inGroup(m) && m.roleId === role.id)
    let reused = false
    if (!member) {
      const sibling = state.members.find((m) => m.name === role.name && (!m.roleId || m.roleId === role.id))
      if (sibling) { member = sibling; reused = !inGroup(sibling) }
    }
    if (!member) {
      const target = staffTarget(role, wantKind, wantModel)
      member = {
        id: `m_${randomUUID().slice(0, 8)}`, name: role.name, roleId: role.id,
        kind: target.kind, model: target.model,
        provider: target.kind === 'deepseek' ? 'deepseek-official' : undefined,
        updatedAt: Date.now(),
      }
      if (!wantPersistent) member.ephemeral = true // 持久成员不打临时标记
      state.members.push(member)
      if (!wantPersistent) created.push(member.id) // 持久成员不进自动回收名单
      changes.push(`- 新建 ${role.name}（${target.kind} / ${target.model}）${wantPersistent ? '（持久）' : ''}`)
      dirty = true
    } else {
      if (wantPersistent) {
        // 显式要持久：清掉临时标记，并从本轮回收名单摘掉（即便本轮刚建也保留）
        if (member.ephemeral) {
          const wasTracked = created.includes(member.id)
          delete member.ephemeral
          dirty = true
          if (!wasTracked) changes.push(`- ${role.name}（${member.name}）改为持久成员`)
        }
        const at = created.indexOf(member.id)
        if (at >= 0) created.splice(at, 1)
      } else if (member.ephemeral && !created.includes(member.id)) {
        // 复用 = 转正：本次新建的（仍在 created 里）不算，别的临时成员不再带标记
        delete member.ephemeral
        dirty = true
      }
      if (member.roleId !== role.id) {
        member.roleId = role.id
        changes.push(`- 指派 ${member.name} → 职位 ${role.name}`)
        dirty = true
      }
      if (wantKind !== undefined || wantModel !== undefined) {
        // 只改 kind 且与现状相同 → 不动模型（保留成员自己选的模型）；
        // 换 kind 才回落到职位默认/框架默认，除非显式给了新模型。
        const nextKind = wantKind || member.kind
        const target = nextKind === member.kind
          ? { kind: nextKind, model: wantModel || member.model }
          : staffTarget(role, nextKind, wantModel)
        if (member.kind !== target.kind || member.model !== target.model) {
          delete member.convId
          member.kind = target.kind
          member.model = target.model
          member.provider = target.kind === 'deepseek' ? 'deepseek-official' : undefined
          changes.push(`- 调整 ${role.name}（${member.name}）→ ${target.kind} / ${target.model}`)
          dirty = true
        }
      }
      if (reused) {
        changes.push(`- 复用已有成员 ${member.name}，加入本组`)
        dirty = true
      }
    }
    if (!group.memberIds.includes(member.id)) { group.memberIds.push(member.id); dirty = true }
    if (changes.length > changesBefore) member.updatedAt = Date.now()
  }
  if (dirty) await save()
  // 纯字符串数组：新建的 id 已由 createdIds 收集，不在返回值上挂任何非枚举属性
  return changes
}

/**
 * 回收本次派活临时新建的成员（任务 A）：
 * 从本组 memberIds 移除 + 从 state.members 删除 + 清 state.usage；
 * 若该成员仍被别的组引用 → 只从本组移除，保留成员本身。
 * group.autoPrune === false 时整体跳过（默认 true）。
 * 返回回执里要列出的名字（如「建模（临时）」）。
 */
async function pruneEphemeralMembers(group, ids) {
  const pruned = []
  if (!Array.isArray(ids) || !ids.length) return pruned
  if (group.autoPrune === false) return pruned
  let dirty = false
  for (const id of ids) {
    const member = state.members.find((m) => m.id === id)
    if (!member) continue // 已被别人删掉
    if (member.persistent === true) continue // 显式持久成员：永不自动回收
    if (!Array.isArray(group.memberIds) || !group.memberIds.includes(id)) continue // 已不在本组
    const others = state.groups.filter((g) => g.id !== group.id && (g.memberIds || []).includes(id))
    group.memberIds = group.memberIds.filter((x) => x !== id)
    if (others.length) {
      pruned.push(`${member.name}（临时，仍被其他组引用）`)
    } else {
      state.members = state.members.filter((m) => m.id !== id)
      delete state.usage[id]
      if (state.memberMemory) delete state.memberMemory[id]
      pruned.push(`${member.name}（临时）`)
    }
    dirty = true
  }
  if (dirty) await save()
  return pruned
}

/**
 * 工具返回值必须过 DSH 的 lossless JSON 校验：
 * 递归只保留「普通对象 / 数组 / 字符串 / 有限数字 / 布尔 / null」，
 * 丢掉 undefined、函数、Symbol、Set/Map/类实例与循环引用。
 */
function jsonSafeClone(value, depth = 0, seen = new Set()) {
  if (value === null) return { ok: true, value: null }
  const type = typeof value
  if (type === 'string' || type === 'boolean') return { ok: true, value }
  if (type === 'number') return Number.isFinite(value) ? { ok: true, value } : { ok: false }
  if (type !== 'object') return { ok: false } // undefined / function / symbol / bigint
  if (depth > 32 || seen.has(value)) return { ok: false }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = []
      for (const item of value) {
        const cloned = jsonSafeClone(item, depth + 1, seen)
        if (cloned.ok) out.push(cloned.value)
      }
      return { ok: true, value: out }
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return { ok: false } // Set/Map/Date/类实例
    const out = {}
    for (const key of Object.keys(value)) { // 只取可枚举自有字段
      const cloned = jsonSafeClone(value[key], depth + 1, seen)
      if (cloned.ok) out[key] = cloned.value
    }
    return { ok: true, value: out }
  } finally {
    seen.delete(value)
  }
}

function jsonRoundTrip(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

/** 往返后逐字段比对；哪个字段/元素不一致就把那个丢掉，而不是让整个工具调用失败。 */
function keepLosslessFields(value, roundTripped) {
  if (Array.isArray(value)) {
    if (!Array.isArray(roundTripped)) return undefined
    const out = []
    for (let i = 0; i < value.length; i += 1) {
      const kept = keepLosslessFields(value[i], roundTripped[i])
      if (kept !== undefined) out.push(kept)
    }
    return out
  }
  if (value !== null && typeof value === 'object') {
    if (roundTripped === null || typeof roundTripped !== 'object' || Array.isArray(roundTripped)) return undefined
    const out = {}
    for (const key of Object.keys(value)) {
      const kept = keepLosslessFields(value[key], roundTripped[key])
      if (kept !== undefined) out[key] = kept
    }
    return out
  }
  return Object.is(value, roundTripped) ? value : undefined
}

/**
 * council_delegate.execute() 的统一出口：
 * 纯 JSON、无 undefined、无 Set/Map/类实例，`JSON.parse(JSON.stringify(value))` 与 value 在
 * 可枚举字段上 deep-equal。自检不通过时丢字段（最坏返回 {}），绝不因为“回执不好看”再抛一次错。
 */
function losslessToolResult(value) {
  const cloned = jsonSafeClone(value)
  if (!cloned.ok) return {}
  const roundTripped = jsonRoundTrip(cloned.value)
  if (roundTripped === undefined) return {}
  return keepLosslessFields(cloned.value, roundTripped)
}

/** 孤立成员判定：30 天没动过。 */
const ORPHAN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 手动清理历史孤立成员（任务 B）：
 * 「不属于任何组」且「无 convId（从未跑过）或 updatedAt 超过 30 天」→ 删除（清 usage）。
 * 有 convId 但没有 updatedAt 的老数据无法判断年龄 → 保守保留。
 * 返回 { removed: [{id,name,kind,reason}], kept: 清理后成员总数, dryRun }。
 */
function pruneOrphanMembers({ dryRun = false, now = Date.now() } = {}) {
  const inAnyGroup = new Set()
  for (const group of state.groups || []) for (const id of group.memberIds || []) inAnyGroup.add(id)
  const removed = []
  const doomed = new Set()
  for (const member of state.members || []) {
    if (member.persistent === true) continue // 显式持久成员不清（staffing persistent:true / council_member persistent:true）
    if (inAnyGroup.has(member.id)) continue
    const lastActive = Number(member.updatedAt) || 0
    const neverRan = !member.convId
    const stale = lastActive > 0 && now - lastActive > ORPHAN_TTL_MS
    if (!neverRan && !stale) continue
    doomed.add(member.id)
    removed.push({ id: member.id, name: member.name, kind: member.kind, reason: neverRan ? 'never-ran' : 'stale-30d' })
  }
  if (!dryRun && doomed.size) {
    state.members = (state.members || []).filter((m) => !doomed.has(m.id))
    for (const id of doomed) {
      delete state.usage[id]
      if (state.memberMemory) delete state.memberMemory[id]
    }
  }
  const total = (state.members || []).length
  return { removed, kept: dryRun ? total - removed.length : total, dryRun: Boolean(dryRun) }
}

/* ── 子会话目录清理（方案 C）───────────────────────────────────────────────
 *
 * 每次 council_delegate 都会经 DSH subagent seam 建一批子会话，目录留在
 * $DSH_HOME/sessions/<项目桶>/<uuid>/ 且从不删除（实测累积 300+）。
 *
 * 两道清理（保留集合都是 `sessionKeepIds()`，不各自另算）：
 *   1) 本轮清理：council_delegate 结束时只删「本轮新建、且没有任何持久引用」的子会话；
 *   2) 历史清理：`POST /council/api/sessions/prune` 扫 sessions 目录，
 *      删「uuid 名 + 不在保留集合 + keepDays 内没动」的目录。
 *      路由内层常量 = `SESSIONS_PRUNE_ROUTE`，与前端 `SESSIONS_PRUNE_PATH` 逐字一致。
 *
 * 删除前的硬性校验（两条路径共用）：
 *   - 路径必须是 $DSH_HOME/sessions/<桶>/<目录> 的**直接两层子目录**；
 *   - 桶与目录都不得是符号链接（用 realpath 反查，任一层是符号链接就拒绝）；
 *   - 目录名必须是 uuid 形式（兼容 `session-<uuid>` 前缀）。
 */
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions')
const SESSION_DIR_NAME_RE = /^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** 目录名 / 会话 id → 归一化小写 uuid；不是 uuid 形式返回 null。 */
function sessionDirUuid(value) {
  const match = SESSION_DIR_NAME_RE.exec(String(value || '').trim())
  return match ? match[1].toLowerCase() : null
}

/** 仍在 registry 里的活跃 agent（复用模式下的子会话就在这里，绝不能删）。 */
function liveAgentIds(ctx) {
  const ids = new Set()
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        const uuid = sessionDirUuid(agent && agent.id)
        if (uuid) ids.add(uuid)
      }
    }
  } catch { /* 拿不到活跃列表时只依赖静态保留集合 */ }
  return ids
}

/**
 * 保留集合（两条清理路径**共用同一份**，不允许各自另算）：
 *   - 每个组的 `sessionId`（组的主会话）；
 *   - 每个组的 `commanderConvId`（指挥子会话）；
 *   - **每个成员的 `convId`**（deepseek 成员当前挂着的子会话；本轮写回的也算，写回即受保护）；
 *   - 审校角色专用的子会话（`state.reviewChildren`）；
 *   - registry 里仍然活着的 agent（复用模式下的子会话都在这里）。
 * 这些 id 一律不删，历史清理与本轮清理都从这里取。
 */
function sessionKeepIds(ctx) {
  const keep = new Set()
  const add = (value) => { const uuid = sessionDirUuid(value); if (uuid) keep.add(uuid) }
  for (const group of state.groups || []) {
    add(group.sessionId)
    add(group.commanderConvId)
  }
  for (const member of state.members || []) add(member && member.convId)
  for (const value of Object.values(state.reviewChildren || {})) add(value)
  for (const id of liveAgentIds(ctx)) keep.add(id)
  return keep
}

/**
 * 校验并解析一个候选会话目录。rootReal = realpath($DSH_HOME/sessions)。
 * 只有 realpath 恰好等于「根 + 桶 + 目录」时才返回，借此拒绝任意深度的路径与符号链接。
 */
async function resolveSessionDir(rootReal, bucket, name) {
  if (!rootReal || !bucket || !name) return null
  if (bucket === '.' || bucket === '..' || name === '.' || name === '..') return null
  if (bucket.includes('/') || name.includes('/') || bucket.includes(path.sep) || name.includes(path.sep)) return null
  const resolved = path.resolve(path.join(SESSIONS_DIR, bucket, name))
  if (path.dirname(path.dirname(resolved)) !== path.resolve(SESSIONS_DIR)) return null // 必须正好两层
  const linkStat = await lstat(resolved).catch(() => null)
  if (!linkStat || linkStat.isSymbolicLink() || !linkStat.isDirectory()) return null
  const real = await realpath(resolved).catch(() => null)
  if (real !== path.join(rootReal, bucket, name)) return null // 桶或目录是符号链接 → 拒绝
  return { dir: resolved, stat: linkStat }
}

/** 目录占用字节数（不跟随符号链接）。 */
async function dirSizeBytes(dir, depth = 0) {
  if (depth > 8) return 0
  let total = 0
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSizeBytes(entryPath, depth + 1)
    else if (entry.isFile()) {
      const stat = await lstat(entryPath).catch(() => null)
      if (stat && stat.isFile()) total += stat.size
    }
  }
  return total
}

/**
 * 历史一次性清理：扫 $DSH_HOME/sessions/<桶>/<目录>/，只删同时满足
 * 「uuid 名 + 不在保留集合（sessionKeepIds）+ 目录 mtime 早于 keepDays」的直接两层子目录。
 * 删除失败（权限/被占用）默默跳过。`kept` = 扫到的会话目录里没删掉（含删失败）的个数。
 */
async function pruneSessionDirs(ctx, { dryRun = false, keepDays = 7, now = Date.now() } = {}) {
  const days = Number(keepDays)
  const windowDays = Number.isFinite(days) && days >= 0 ? days : 7
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000
  const keep = sessionKeepIds(ctx)
  const result = { removed: [], kept: 0, dryRun: Boolean(dryRun) }
  let total = 0
  const rootReal = await realpath(SESSIONS_DIR).catch(() => null)
  if (!rootReal) return result
  let buckets = []
  try { buckets = await readdir(SESSIONS_DIR, { withFileTypes: true }) } catch { return result }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) continue
    let entries = []
    try { entries = await readdir(path.join(SESSIONS_DIR, bucket.name), { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const uuid = sessionDirUuid(entry.name)
      if (!uuid || !entry.isDirectory() || entry.isSymbolicLink()) continue
      const target = await resolveSessionDir(rootReal, bucket.name, entry.name)
      if (!target) continue
      total += 1
      if (keep.has(uuid) || target.stat.mtimeMs > cutoff) continue
      const sizeMb = Math.round(((await dirSizeBytes(target.dir)) / 1048576) * 100) / 100
      if (!dryRun) {
        try {
          await rm(target.dir, { recursive: true, force: true })
        } catch {
          continue // 删不掉就跳过（计入 kept）
        }
      }
      result.removed.push({ id: uuid, sizeMb, mtime: target.stat.mtimeMs })
    }
  }
  result.kept = total - result.removed.length
  return result
}

/** 在任意项目桶里找一个会话目录（本轮新建的子会话不知道落在哪个 cwd 桶）。 */
async function findSessionDir(uuid) {
  const rootReal = await realpath(SESSIONS_DIR).catch(() => null)
  if (!rootReal) return null
  let buckets = []
  try { buckets = await readdir(SESSIONS_DIR, { withFileTypes: true }) } catch { return null }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) continue
    for (const name of [uuid, 'session-' + uuid]) {
      const target = await resolveSessionDir(rootReal, bucket.name, name)
      if (target) return target
    }
  }
  return null
}

/**
 * 本轮清理：只删「本轮新建、且没有任何持久引用」的子会话目录，删不掉的默默跳过。
 *
 * 硬约束（与历史清理**共用** sessionKeepIds，不另算）：任何组 `sessionId`、任何成员
 * `convId`、任何 `group.commanderConvId`、审校子会话、活跃 agent 一律不删。
 * 注意这条约束是字面执行的：deepseek 成员本轮最后写回的 `convId` 就一定被保住；
 * 真正被回收的是「重试 / 返工多出来的那几条子会话」以及失败后没有被任何引用记住的子会话。
 */
async function pruneChildSessionDirs(ctx, ids) {
  const removed = []
  if (!ids || typeof ids[Symbol.iterator] !== 'function') return removed
  // 必须在成员 convId 写回之后取，才能保护「本轮最后一次子会话」
  const keep = sessionKeepIds(ctx)
  for (const value of ids) {
    const uuid = sessionDirUuid(value)
    if (!uuid || keep.has(uuid)) continue
    const target = await findSessionDir(uuid)
    if (!target) continue
    try {
      await rm(target.dir, { recursive: true, force: true })
      removed.push(uuid)
    } catch { /* 删不掉（占用/权限）就跳过 */ }
  }
  return removed
}

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
    `你是小组「${group.name}」的指挥，正在群聊会话里。任务类请求必须用 council_delegate 派给成员。`,
    `工作区：${group.workspacePath || ''}`,
    group.style ? `统一风格规范（出图默认用这条）：${group.style}` : '',
    '派图任务时如需换风格，给该条 assignment 加 style 字段覆盖默认值；审校会按实际使用的风格判定。',
    '图片回执由工具卡直接展示；如果要在回答里引用，用 /council/api/image/… 这种地址，不要写本地文件路径（前端预览不了本地路径）。',
    '成员名册：',
    members || '（暂无成员）',
    '岗位目录：',
    ...(state.roles || []).map((r) => `- ${r.name}（默认框架=${roleKind(r)}，默认模型=${staffTarget(r, undefined, undefined).model}）${r.prompt ? '：' + r.prompt : ''}`),
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
      name: 'council:mandate:' + group.id,
      order: 100,
      text: () => mandateText(state.groups.find((g) => g.id === group.id) || group),
    }))
    disposers.push(agentCtx.systemPrompt.section({
      name: 'council:catalog:' + group.id,
      order: 1200,
      text: () => catalogText(),
    }))
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
          staffing: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['role'], properties: {
            role: { type: 'string' }, kind: { type: 'string', enum: ['codex', 'claude', 'deepseek', 'image'] }, model: { type: 'string' },
            persistent: { type: 'boolean', description: 'true = 建持久成员（派活结束后不回收）；默认 false = 临时成员，用完即回收' },
          } } },
          assignments: {
            type: 'array',
            description: '要派发的任务；每个任务都必须自包含（背景+目标+验收标准）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                member: { type: 'string', description: '成员名字、id 或职位名' },
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
            staffing: { type: 'array', items: { type: 'string' } },
            staffingCreated: { type: 'array', items: { type: 'string' }, description: '本次新建（并会被回收）的临时成员 id' },
            pruned: { type: 'array', items: { type: 'string' }, description: '本次回收的临时成员（如“建模（临时）”）' },
            prunedSessions: { type: 'array', items: { type: 'string' }, description: '本次清理的子会话目录 id（pruneChildSessions:false 时不清理）' },
            selfWorkBlocked: { type: 'integer', description: '本组累计被守卫拦下的父会话写操作次数（0 表示没有越权）' },
            selfWorkBlockedDetail: { type: 'string', description: '被拦工具分布，如 edit×2、blender_render×1' },
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
                  continued: { type: 'integer', description: '被 max-tokens / max-turns 截断后续跑了几次（未续跑不带该字段）' },
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
            const noReview = m.acceptance === 'none' ? '\n验收：无审核位（本组没有审校/指挥），本轮未做验收' : ''
            const cont = m.continued ? `\n续跑：${m.continued} 次（上一轮被截断，已在同一子会话里接着跑）` : ''
            return `## ${m.name}（${m.kind}）\n${body}${image}${review}${accept}${noReview}${cont}`
          })
          const body = rows.join('\n\n') || (planLine ? '（没有成员回执）' : '（没有成员回执：既没给 assignments，也没能由指挥拆解）')
          const staffing = value.staffing?.length ? '\n\n## 补员\n' + value.staffing.join('\n') : ''
          const pruned = value.pruned?.length ? '\n\n## 回收\n已回收：' + value.pruned.join('、') : ''
          const prunedSessions = value.prunedSessions?.length
            ? '\n\n## 子会话\n已清理 ' + value.prunedSessions.length + ' 个子会话目录'
            : ''
          const selfWorkBlocked = Number(value.selfWorkBlocked) || 0
          const blocked = selfWorkBlocked > 0
            ? '\n\n## 越权拦截\n- 父会话尝试自行执行 ' + selfWorkBlocked + ' 次写操作，已拦截'
              + (value.selfWorkBlockedDetail ? '（' + value.selfWorkBlockedDetail + '）' : '')
            : ''
          return [{ type: 'text', text: (planLine ? planLine + '\n\n' + body : body) + staffing + pruned + prunedSessions + blocked }]
        },
      },
      async execute(args, exec) {
        const live = state.groups.find((g) => g.id === group.id) || group
        // 本次派活新建的临时成员：成功 / 失败 / 取消都在 finally 里回收
        const ephemeral = []
        // 本次派活新建的 deepseek 子会话（subagent seam 的 childId）：结束时回收目录
        const childSessions = new Set()
        // 在 try 外声明：finally 要用它收尾 progressMap / activeCalls（提前 break、抛错、取消都要收）
        let callId
        const response = { members: [], staffing: [] }
        try {
        // 用标签块收住主流程：没有可派任务时 break 出去，让 finally 仍能回收 + 末尾统一 JSON 安全化
        delegate: {
        // progress + 取消登记必须早于 ensureStaffing：选成员（补员）本身也可能卡住，
        // 等它之后才建进度条就会出现「一直准备中，停止键还没生效」的空窗。
        callId = exec && exec.callId
        progressInit(callId, exec && exec.agent && exec.agent.id)
        progressStage(callId, '拆解中')
        // 越权审计快照 + 刷新「用户本轮已放行」：进度条与回执都从这里取数
        noteSelfWorkPermit(live, exec && exec.agent)
        const blockedSoFar = selfWorkAuditFor(live.id)
        const blockedProgress = progressMap.get(callId)
        if (blockedProgress) blockedProgress.selfWorkBlocked = blockedSoFar.blocked
        response.selfWorkBlocked = blockedSoFar.blocked
        response.selfWorkBlockedDetail = selfWorkBlockedDetail(blockedSoFar)
        if (callId) activeCalls.set(callId, { cancelled: false, controller: new AbortController() })
        const staffing = await ensureStaffing(live, args?.staffing, ephemeral)
        let assignments = Array.isArray(args && args.assignments) ? args.assignments : []
        let planRaw
        const requestText = args && typeof args.request === 'string' ? args.request.trim() : ''
        if ((!assignments.length) && requestText) {
          const planned = await planWithCommander(ctx, live, args.request.trim(), config, exec && exec.agent, callId)
          staffing.push(...await ensureStaffing(live, planned.staffing, ephemeral))
          planRaw = planned.raw
          assignments = planned.assignments
          if (!assignments.length) {
            Object.assign(response, { plan: { ok: false, raw: planned.raw || '', reason: planned.error || '指挥没有给出可用的拆分' }, members: [], staffing })
            break delegate
          }
        }
        // assignments 里直接写职位名、但本组还没人持有该职位 → 按职位默认自动补员
        const missingRoles = assignments
          .filter((a) => typeof a.member === 'string'
            && (state.roles || []).some((r) => r.name === a.member)
            && !resolveMember(live, a.member))
          .map((a) => ({ role: a.member }))
        staffing.push(...await ensureStaffing(live, missingRoles, ephemeral))
        // 成员已经定下来了，占位阶段从「拆解中」推进到「派活中」
        progressStage(callId, '派活中')
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
        const currentSeq = () => {
          try {
            const evs = sessionEvents(exec.agent.session)
            const last = evs[evs.length - 1]
            return last && typeof last.seq === 'number' ? last.seq : undefined
          } catch { return undefined }
        }
        const startSeq = currentSeq()
        const entry = { at: Date.now(), request: userText || '', brief: firstTask.trim().slice(0, 80), text: '', running: true, startSeq }
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
          const member = resolveMember(live, item.member)
          if (!member) return { name: String(item.member), kind: 'unknown', ok: false, error: 'member not found' }
          const briefParts = []
          if (requestText) briefParts.push('用户原话：' + requestText)
          if (assignments.length > 1) {
            briefParts.push('指挥的分工：' + assignments.map((a, i) => `${i + 1}. ${a.member}：${String(a.task || '').slice(0, 160)}`).join(' / '))
          }
          const brief = briefParts.join('\n')
          progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: '排队中' })
          if (callCancelled(callId)) {
            progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: '已停止' })
            return { name: member.name, kind: member.kind, ok: false, text: '', error: '已被用户停止', accepted: false, acceptance: 'cancelled' }
          }
          const result = await callMember(ctx, member, String(item.task || ''), config, live, item.style, exec && exec.agent, brief,
            (stage) => progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: stage }),
            (work) => {
              progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: '审校中' })
              const body = work.ok ? (work.text || '') : '失败：' + (work.error || '')
              append('## ' + member.name + '（' + member.kind + '）\n' + body + (work.image ? '\n[image] ' + work.image : ''))
            }, callId, childSessions)
          if (result && result.acceptance === 'cancelled') console.error('[council] member cancelled at ' + Date.now() + ' member=' + member.name)
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
        entry.endSeq = currentSeq()
        entry.running = false
        history.at = Date.now()
        history.text = entry.text
        await save()
        response.members = results
        response.staffing = staffing
        } // delegate
        } finally {
          // 进度条 / 取消登记统一在 finally 收尾：成功、抛错、提前 break、被停止都不能留下
          // 一条永远没有 finishedAt 的 entry（前端会一直显示「准备中」）。
          if (callId) {
            const progressEntry = progressMap.get(callId)
            if (progressEntry) {
              if (progressEntry.members) delete progressEntry.members[PROGRESS_STAGE_ID]
              finishProgressEntry(progressEntry, Date.now())
            }
            activeCalls.delete(callId)
          }
          // 回收本次临时新建的成员（失败/取消也会走到这里）
          response.pruned = await pruneEphemeralMembers(live, ephemeral)
          // 本轮子会话清理：只删本轮新建、且没有任何持久引用的子会话目录，删不掉的默默跳过。
          // 保留集合由 pruneChildSessionDirs 内部统一取 sessionKeepIds（含所有成员 convId），这里不另算。
          if (config.pruneChildSessions !== false) {
            try {
              response.prunedSessions = await pruneChildSessionDirs(ctx, childSessions)
            } catch {
              response.prunedSessions = []
            }
          }
        }
        // created 改成普通字段；pruned 保持字符串数组。出口再做一次 JSON 往返自检。
        response.staffingCreated = ephemeral.filter((id) => typeof id === 'string')
        return losslessToolResult(response)
      },
    }))
    disposers.push(agentCtx.tools.register({
      name: 'council_member',
      description: '管理小组成员：列出、创建、更新或删除成员。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'prune'], description: '操作类型（prune = 清理不属于任何组的孤立成员）' },
          id: { type: 'string', description: 'update/delete 时的成员 id' },
          name: { type: 'string', description: '成员名字' },
          kind: { type: 'string', enum: ['codex', 'claude', 'deepseek', 'image'], description: '成员类型' },
          model: { type: 'string', description: '模型名称' },
          roleId: { type: 'string', description: '职位 id' },
          cwd: { type: 'string', description: '工作目录' },
          persistent: { type: 'boolean', description: 'create 时是否建持久成员（默认 true）；显式 false = 临时成员，派活结束后自动回收' },
          dryRun: { type: 'boolean', description: 'prune 时只预览、不删除' },
        },
        required: ['action'],
      },
            output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {members: { type: 'array', items: { type: 'object', additionalProperties: true } }, ok: { type: 'boolean' }, error: { type: 'string' }, removed: { type: 'array', items: { type: 'object', additionalProperties: true } }, kept: { type: 'number' }, dryRun: { type: 'boolean' }},
        },
        render(_args, value) {
          if (value.dryRun !== undefined) {
            const names = (value.removed || []).map((m) => m.name + (m.kind ? '（' + m.kind + '）' : ''))
            const head = value.dryRun ? '可清理 ' + names.length + ' 个' : '已清理 ' + names.length + ' 个'
            return [{ type: 'text', text: head + (names.length ? '：' + names.join('、') : '') + '\n剩余成员 ' + (value.kept ?? 0) + ' 个' }]
          }
          const rows = (value.members || []).map((m) => `- ${m.name}（${m.kind}${m.model ? ' / ' + m.model : ''}${m.roleName ? ' / ' + m.roleName : ''}）`)
          return [{ type: 'text', text: value.error ? ('失败：' + value.error) : (rows.join('\n') || '（无成员）') }]
        },
      },
async execute(args) {
        const live = state.groups.find((g) => g.id === group.id) || group
        if (args.action === 'prune') {
          const result = pruneOrphanMembers({ dryRun: Boolean(args.dryRun) })
          if (!result.dryRun && result.removed.length) await save()
          return result
        }
        if (args.action === 'list') {
          const members = (live.memberIds || [])
            .map((id) => state.members.find((m) => m.id === id))
            .filter(Boolean)
            .map((m) => {
              const role = m.roleId ? state.roles.find((r) => r.id === m.roleId) : undefined
              return { id: m.id, name: m.name, kind: m.kind, model: m.model, roleId: m.roleId, roleName: role?.name, cwd: m.cwd }
            })
          return { members }
        }
        if (args.action === 'create') {
          const defaultModels = { codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5', deepseek: 'deepseek-flash', image: 'gpt-image-2.5-flare' }
          const kind = args.kind && defaultModels[args.kind] ? args.kind : 'codex'
          // 默认建持久成员（现有行为）；显式 persistent:false 才建临时成员，与 staffing 的 persistent 语义一致
          const persistent = args.persistent !== false
          const member = {
            id: `m_${randomUUID().slice(0, 8)}`,
            name: args.name || '新成员',
            kind,
            model: args.model || defaultModels[kind],
            provider: kind === 'deepseek' ? 'deepseek-official' : undefined,
            roleId: args.roleId,
            cwd: args.cwd || undefined,
            updatedAt: Date.now(),
          }
          if (!persistent) member.ephemeral = true
          state.members.push(member)
          if (!live.memberIds.includes(member.id)) live.memberIds.push(member.id)
          await save()
          return { ok: true, persistent, member: { id: member.id, name: member.name, kind: member.kind, model: member.model, persistent } }
        }
        if (args.action === 'update') {
          if (!args.id) return { ok: false, error: 'id required for update' }
          const member = state.members.find((m) => m.id === args.id)
          if (!member) return { ok: false, error: 'member not found: ' + args.id }
          if (args.name !== undefined) member.name = args.name
          if (args.kind !== undefined && args.kind !== member.kind) {
            member.kind = args.kind
            delete member.convId
          }
          if (args.model !== undefined) member.model = args.model
          if (args.roleId !== undefined) member.roleId = args.roleId || undefined
          if (args.cwd !== undefined) member.cwd = args.cwd || undefined
          member.updatedAt = Date.now()
          await save()
          return { ok: true, member: { id: member.id, name: member.name, kind: member.kind, model: member.model } }
        }
        if (args.action === 'delete') {
          if (!args.id) return { ok: false, error: 'id required for delete' }
          const inGroup = (live.memberIds || []).includes(args.id)
          if (!inGroup) return { ok: false, error: 'member not in this group' }
          if (live.memberIds.length <= 1) return { ok: false, error: 'cannot delete the last member' }
          const agents = ctx.get('agents')
          const parentAgent = agents ? agents.get(live.sessionId) : undefined
          if (parentAgent && args.id === parentAgent.id) return { ok: false, error: 'cannot delete the parent session' }
          state.members = state.members.filter((m) => m.id !== args.id)
          live.memberIds = live.memberIds.filter((id) => id !== args.id)
          delete state.usage[args.id]
          await save()
          return { ok: true }
        }
        return { ok: false, error: 'unknown action' }
      },
    }))
    disposers.push(agentCtx.tools.register({
      name: 'council_role',
      description: '管理职位：列出、创建、更新（含改名）、删除或分配职位。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'assign'], description: '操作类型' },
          id: { type: 'string', description: 'update/delete/assign 时的职位 id' },
          name: { type: 'string', description: '职位名称' },
          prompt: { type: 'string', description: '职位提示词' },
          color: { type: 'string', description: '职位颜色' },
          kind: { type: 'string', enum: ['codex', 'claude', 'deepseek', 'image'] },
          model: { type: 'string', description: '职位默认模型' },
          memberId: { type: 'string', description: 'assign 时的成员 id' },
        },
        required: ['action'],
      },
            output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {roles: { type: 'array', items: { type: 'object', additionalProperties: true } }, ok: { type: 'boolean' }, error: { type: 'string' }},
        },
        render(_args, value) { const rows = (value.roles || []).map((r) => `- ${r.name}（默认：${r.defaultKind || r.kind || 'claude'} / ${r.defaultModel || r.model || '默认'}）`); return [{ type: 'text', text: value.error ? ('失败：' + value.error) : (rows.join('\n') || '（无职位）') }] },
      },
async execute(args) {
        if (args.action === 'list') {
          const roles = state.roles.map((r) => ({
            id: r.id, name: r.name, prompt: r.prompt, color: r.color, kind: r.kind, model: r.model,
            defaultKind: roleKind(r), defaultModel: staffTarget(r, undefined, undefined).model,
          }))
          return { roles }
        }
        if (args.action === 'create') {
          const role = {
            id: `r_${randomUUID().slice(0, 8)}`,
            name: args.name || '新职位',
            prompt: args.prompt || '',
            color: args.color || undefined,
            ...pick(args, ['kind', 'model']),
          }
          state.roles.push(role)
          await save()
          return { ok: true, role: { id: role.id, name: role.name } }
        }
        if (args.action === 'update') {
          if (!args.id) return { ok: false, error: 'id required for update' }
          const role = state.roles.find((r) => r.id === args.id)
          if (!role) return { ok: false, error: 'role not found: ' + args.id }
          if (args.name !== undefined) role.name = args.name
          if (args.prompt !== undefined) role.prompt = args.prompt
          if (args.color !== undefined) role.color = args.color
          // 换框架但没给模型：清掉旧框架的模型，回落到新框架的默认模型
          if (args.kind !== undefined && args.kind !== role.kind && args.model === undefined) delete role.model
          Object.assign(role, pick(args, ['kind', 'model']))
          await save()
          return { ok: true, role: { id: role.id, name: role.name } }
        }
        if (args.action === 'delete') {
          if (!args.id) return { ok: false, error: 'id required for delete' }
          state.roles = state.roles.filter((r) => r.id !== args.id)
          for (const m of state.members) if (m.roleId === args.id) delete m.roleId
          await save()
          return { ok: true }
        }
        if (args.action === 'assign') {
          if (!args.id) return { ok: false, error: 'role id required for assign' }
          if (!args.memberId) return { ok: false, error: 'memberId required for assign' }
          const role = state.roles.find((r) => r.id === args.id)
          if (!role) return { ok: false, error: 'role not found: ' + args.id }
          const member = state.members.find((m) => m.id === args.memberId)
          if (!member) return { ok: false, error: 'member not found: ' + args.memberId }
          member.roleId = args.id
          await save()
          return { ok: true, member: { id: member.id, name: member.name, roleName: role.name } }
        }
        return { ok: false, error: 'unknown action' }
      },
    }))
    disposers.push(agentCtx.tools.register({
      name: 'council_policy',
      description: '获取或设置小组的验收策略（maxRework, requirePrelim, requireCommander, standard, commanderPrompt）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: '操作类型' },
          maxRework: { type: 'number', description: '最多返工次数（0 表示不返工）' },
          requirePrelim: { type: 'boolean', description: '是否需要初审' },
          requireCommander: { type: 'boolean', description: '是否需要指挥审核' },
          standard: { type: 'string', description: '验收标准文本' },
          commanderPrompt: { type: 'string', description: '指挥提示词' },
        },
        required: ['action'],
      },
            output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {maxRework: { type: 'number' }, requirePrelim: { type: 'boolean' }, requireCommander: { type: 'boolean' }, standard: { type: 'string' }, commanderPrompt: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' }},
        },
        render(_args, value) { if (value.error) return [{ type: 'text', text: '失败：' + value.error }]; return [{ type: 'text', text: `返工次数=${value.maxRework} 初审=${Boolean(value.requirePrelim)} 指挥审核=${Boolean(value.requireCommander)} 规范=${value.standard ? '已设置' : '空'} 指挥提示词=${value.commanderPrompt ? '已覆盖' : '默认'}` }] },
      },
async execute(args) {
        const live = state.groups.find((g) => g.id === group.id) || group
        if (args.action === 'get') {
          return {
            maxRework: live.maxRework ?? 1,
            requirePrelim: live.requirePrelim ?? true,
            requireCommander: live.requireCommander ?? true,
            standard: live.standard ?? '',
            commanderPrompt: live.commanderPrompt ?? '',
          }
        }
        if (args.action === 'set') {
          if (args.maxRework !== undefined) live.maxRework = Math.max(0, Math.floor(args.maxRework))
          if (args.requirePrelim !== undefined) live.requirePrelim = Boolean(args.requirePrelim)
          if (args.requireCommander !== undefined) live.requireCommander = Boolean(args.requireCommander)
          if (args.standard !== undefined) live.standard = String(args.standard)
          if (args.commanderPrompt !== undefined) live.commanderPrompt = String(args.commanderPrompt)
          await save()
          return {
            ok: true,
            maxRework: live.maxRework ?? 1,
            requirePrelim: live.requirePrelim ?? true,
            requireCommander: live.requireCommander ?? true,
            standard: live.standard ?? '',
            commanderPrompt: live.commanderPrompt ?? '',
          }
        }
        return { ok: false, error: 'unknown action' }
      },
    }))
    // 方案 A：父会话（本组会话的 agent）不得自己执行写操作，由守卫硬拦截。
    // 通过 agent.ctx 注册即只作用于该 agent；守卫内部再按 sessionId 校验一次，其它 agent 一律放行。
    if (agentCtx.tools && typeof agentCtx.tools.guard === 'function') {
      disposers.push(agentCtx.tools.guard(makeSelfWorkGuard(group, config)))
    }
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
  // 预热模型清单缓存：section.text 必须同步返回，不能在里面 await 网络。
  modelCatalog(ctx, config).catch(() => {})
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


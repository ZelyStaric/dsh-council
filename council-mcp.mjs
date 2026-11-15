#!/usr/bin/env node
/**
 * 团队模式（Team Mode）大脑侧 MCP 服务器 —— **只暴露编排工具，不给 bash / 编辑能力**。
 *
 * 这个进程由 claude CLI（或别的宿主）通过 `--mcp-config` 拉起，走 stdio + JSON-RPC 2.0：
 *   initialize → tools/list → tools/call
 * 每次 tools/call 都**转发**给 dsh-council 插件的 HTTP 接口（默认
 * `http://127.0.0.1:3080/council/api`，可用 `COUNCIL_API` 覆盖；有 `COUNCIL_TOKEN` 就带 `?token=`）。
 *
 * 设计取舍：
 *   - 本文件**不 import index.js**：MCP 服务器是独立进程，只做转发，保证「大脑无手」。
 *   - 没有 fetch 依赖也要能跑（Node ≥ 18 自带 fetch）；失败一律回结构化 JSON 而不是抛栈，
 *     因为抛栈会让模型误以为工具被禁用。
 *   - stdout **只准**写 JSON-RPC 帧；所有日志走 stderr。
 */

const COUNCIL_API = (process.env.COUNCIL_API || 'http://127.0.0.1:3080/council/api').replace(/\/+$/, '')
const COUNCIL_TOKEN = process.env.COUNCIL_TOKEN || ''
/** 内部 token：插件用 IP 判断不可靠（loopback 反代会改写源地址），改用共享令牌鉴权。 */
const INTERNAL_TOKEN = process.env.COUNCIL_INTERNAL_TOKEN || ''
const SERVER_NAME = 'council'
const SERVER_VERSION = '0.3.0'

/** 短描述：给模型的可见文本越短，越不容易被当成「可以随便调」的万能工具。 */
const TOOLS = [
  {
    name: 'council_delegate',
    description: '把任务派给小组里的成员（可以多个），返回每个成员的产出与审校结论。多步任务用 request 交给指挥拆解。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request: { type: 'string', description: '用户原话；给了就由指挥拆解成任务再派给成员' },
        assignments: {
          type: 'array',
          description: '直派任务（仅单成员单任务用），每个任务必须自包含背景+目标+验收标准',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              member: { type: 'string', description: '成员名字' },
              task: { type: 'string', description: '任务正文' },
            },
          },
        },
        background: { type: 'boolean', description: 'true = 后台跑，立刻返回 runId' },
      },
    },
  },
  {
    name: 'council_collect',
    description: '取回后台派活的结果（可带等待秒数）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string', description: '派活返回的 runId；不填取本会话最近一个后台任务' },
        waitSeconds: { type: 'number', description: '最多等待多少秒，默认 0（只查状态）' },
      },
    },
  },
  {
    name: 'council_tell',
    description: '给正在运行的成员插话/纠偏（相当于 /btw）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要转达的话' },
        member: { type: 'string', description: '可选：成员名字' },
        callId: { type: 'string', description: '可选：派活 id' },
      },
      required: ['text'],
    },
  },
  {
    name: 'council_member',
    description: '管理小组成员：list / create / update / delete / prune。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'prune'] },
        id: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['codex', 'claude', 'deepseek', 'image'] },
        model: { type: 'string' },
        roleId: { type: 'string' },
        cwd: { type: 'string' },
        persistent: { type: 'boolean' },
        dryRun: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    name: 'council_status',
    description: '查看当前小组：成员、正在跑的派活、用量。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
]

/** 每个工具 → 转发给插件的内部入口（POST /internal/tool，仅 localhost）。 */
const FORWARD = {
  council_delegate: 'council_delegate',
  council_collect: 'council_collect',
  council_tell: 'council_tell',
  council_member: 'council_member',
  council_status: 'council_status',
}

function apiUrl(route) {
  const base = COUNCIL_API + route
  if (!COUNCIL_TOKEN) return base
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(COUNCIL_TOKEN)
}

/**
 * 转发一次工具调用。
 * @param {string} tool 插件侧工具名
 * @param {object} args 模型给的参数
 * @param {string} sessionId 宿主传进来的会话提示（团队会话 id），可为空
 * @returns {Promise<{ok: boolean, status: number, body: any}>}
 */
async function forward(tool, args, sessionId) {
  const payload = { tool, args: args && typeof args === 'object' ? args : {}, sessionId: sessionId || undefined }
  let res
  try {
    res = await fetch(apiUrl('/internal/tool'), {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        INTERNAL_TOKEN ? { 'x-council-token': INTERNAL_TOKEN } : {},
      ),
      body: JSON.stringify(payload),
    })
  } catch (error) {
    return { ok: false, status: 0, body: { error: '无法连接 council 服务：' + String(error?.message ?? error) + '（' + COUNCIL_API + '）' } }
  }
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { ok: res.ok, status: res.status, body }
}

/** 把插件返回的 body 压成 MCP content 数组（永远是一段 JSON 文本，模型好读也好解析）。 */
function toContent(result) {
  const value = result.ok ? (result.body?.result ?? result.body) : (result.body || { error: 'HTTP ' + result.status })
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

function write(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

let sessionHint = ''

async function handle(frame) {
  const { id, method, params } = frame || {}
  if (method === 'initialize') {
    // 宿主可能在 clientInfo / _meta 里带会话提示，存下来一起转发
    const meta = params?._meta || {}
    sessionHint = String(meta.sessionId || meta.session_id || params?.clientInfo?.sessionId || '') || sessionHint
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: '你是这个小组的大脑。你**没有**执行权：读代码、跑命令、改文件都必须 council_delegate 派给成员。别假装自己看过文件。',
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return undefined
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name
    if (!name || !TOOLS.some((tool) => tool.name === name)) {
      return replyError(id, -32602, 'unknown tool: ' + String(name))
    }
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    if (name === 'council_status') {
      // 状态不走工具执行，读插件的 /state 更直接
      let res
      try {
        res = await fetch(apiUrl('/state'), { method: 'GET' })
      } catch (error) {
        return reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: '无法连接 council 服务：' + String(error?.message ?? error) }) }], isError: true })
      }
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
      const view = {
        ok: res.ok,
        members: (body.members || []).map((m) => ({ id: m.id, name: m.name, kind: m.kind, model: m.model ?? null })),
        running: (body.progress && Object.keys(body.progress).length) || 0,
      }
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] })
    }
    const result = await forward(FORWARD[name] || name, args, sessionHint)
    return reply(id, { content: toContent(result), isError: !result.ok })
  }
  if (typeof id !== 'undefined') return replyError(id, -32601, 'method not found: ' + String(method))
  return undefined // 通知类帧没有 id，静默忽略
}

/** 逐行解析 stdin 上的 JSON-RPC 帧（MCP stdio 是一行一帧）。 */
function start() {
  let buffer = ''
  let chain = Promise.resolve()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let frame
      try { frame = JSON.parse(line) } catch {
        process.stderr.write('[council-mcp] 忽略非 JSON 行\n')
        continue
      }
      // 串行处理：保证 stdout 帧不交错
      chain = chain.then(() => handle(frame)).catch((error) => {
        process.stderr.write('[council-mcp] ' + String(error?.stack ?? error) + '\n')
        if (frame && typeof frame.id !== 'undefined') replyError(frame.id, -32603, String(error?.message ?? error))
      })
    }
  })
  process.stdin.on('end', () => { chain.then(() => process.exit(0)) })
  process.stderr.write('[council-mcp] ready → ' + COUNCIL_API + '\n')
}

start()

export { TOOLS, forward, apiUrl, handle }

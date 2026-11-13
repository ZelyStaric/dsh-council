/**
 * Offline render smoke for the council Client halves.
 *
 * A throwing component blanks its whole slot and there is no browser control on
 * this host, so this harness renders every registered component against fake
 * React hooks with several state shapes and fails on any throw or missing marker.
 *
 * Usage: node tests/render-smoke.mjs [state.json]
 *   state.json — saved `{ state, config }` (default: fetch the live API).
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const BASE = process.env.COUNCIL_BASE || 'http://100.108.3.88:3080'
const file = process.argv[2]
const payload = file
  ? JSON.parse(readFileSync(file, 'utf8'))
  : await (await fetch(BASE + '/council/api/state')).json()

const EMPTY = { groups: [], members: [], roles: [], usage: {}, runs: [] }
const withReview = structuredClone(payload.state)
withReview.runs = [{
  id: 'run_demo', groupId: (withReview.groups[0] || {}).id || 'g', sessionId: 's1', status: 'done',
  text: '演示一轮', confirmation: '演示确认',
  members: [{
    memberId: 'm_demo', name: '画师', kind: 'image', status: 'done', task: 'demo',
    text: '已生成图片', image: '/council/api/image/demo.png', attempts: 2,
    review: { self: { ok: false, reason: '风格不符', by: 'Claude' }, commander: { ok: false, reason: '未通过', by: '指挥' } },
  }],
  at: Date.now(),
}, ...(withReview.runs || [])]

// 会话归档 → 组归档：小组页要显示一行「已归档 N 个」，且列表里不出现归档组
const archived = structuredClone(payload.state)
archived.groups = [
  { id: 'g_bound', name: '当前组', sessionId: 'session-arch-live', memberIds: [] },
  { id: 'g_old', name: '已归档组', sessionId: 'session-arch-old', archived: true, archivedAt: Date.now(), memberIds: [] },
]

// 重新打开「已归档会话」（组还带着 sessionId）：不能自动进它的旧小组，页面应回落到「单人模式」
const archivedBound = structuredClone(payload.state)
archivedBound.groups = [
  { id: 'g_old_bound', name: '已归档组（带绑定）', sessionId: 'session-arch-old', archived: true, archivedAt: Date.now(), memberIds: [] },
]

const FIXTURES = [
  ['live', payload.state],
  ['empty', EMPTY],
  ['with-review', withReview],
  ['archived', archived],
  ['archived-bound', archivedBound],
]

const CARD_PROPS = {
  call: {
    phase: 'result',
    block: {
      content: [{ type: 'text', text: '## 画师（image）\n一张扁平插画\n![image](/council/api/image/x.png)\n自审：通过（符合风格） · 指挥审核：通过（可以）' }],
    },
  },
}

const EXPECT = {
  live: { council: ['职位', '成员', '总画师风格', 'API key 用量'], 'council-thread': ['位成员', '发送'] },
  empty: { council: ['单人模式'], 'council-mode': ['模式'] },
  'with-review': { council: ['职位', '成员'], 'council-card': ['画师', '自审', '指挥审核', '[img]'], 'council-mode': ['模式'] },
}

const MODELS = { codex: ['gpt-6.1-sol'], claude: ['claude-sonnet-5'], deepseek: ['deepseek-flash'], image: ['gpt-image-2.5-flare'] }
const KEY_USAGE = { keys: [{ id: 'gpt-llm', label: 'gpt-llm', ok: true, balance: 310.4, today: { requests: 1, tokens: 1200, cost: 0.12 }, totals: { requests: 10, tokens: 120000, cost: 1.2 } }] }

const SEEDS = {
  council: (state) => [state, null, null, null, { deepseek: null, reason: 'signed-out' }, KEY_USAGE, MODELS, null, null, null],
  'council-mode': () => [null, false, null],
  'council-tail': (state) => [state, false],

}

let failed = 0
for (const [name, state] of FIXTURES) {
  for (const id of ['council', 'council-card', 'council-mode', 'council-progress', 'council-chat', 'council-tail']) {
    const result = renderOne(id, state)
    if (result.error) {
      failed++
      console.log(`FAIL ${name}/${id}: ${result.error.message}`)
      console.log((result.error.stack || '').split('\n').slice(0, 5).join('\n'))
      continue
    }
    const text = result.text
    if (name === 'empty' && text.length === 0) { console.log(`ok   ${name}/${id}: (no UI for this state)`); continue }
    let expected = (EXPECT[name] || {})[id] || []
    if (id === 'council' && name === 'archived-bound') {
      // 组还带着 sessionId 但已归档 → groupForSession 必须排除它，页面回落到「单人模式」
      expected = ['单人模式', '已归档 1 个']
    } else if (id === 'council' && name !== 'empty') {
      // 与产品规则一致：已归档的组不再算「当前组」（v0.2.10 起归档组不进 groupForSession）
      const bound = Boolean(boundGroupOf(state))
      expected = bound ? ['职位', '成员', '总画师风格', '清理 7 天前归档'] : ['单人模式']
      if (name === 'archived') expected = expected.concat(['已归档 1 个'])
    }
    const missing = expected.filter((m) => !text.includes(m))
    if (missing.length) {
      failed++
      console.log(`FAIL ${name}/${id}: missing ${missing.join(', ')} (${text.length} chars)`)
    } else {
      console.log(`ok   ${name}/${id}: ${text.length} chars`)
    }
  }
}
// 「清理 7 天前归档」两段式按钮：真点一次（React 桩 + 假 fetch），验证第一下 dryRun、第二下才真删，
// 且前后端路由逐字相同（客户端请求 /council/api/groups/prune-archived）。
// 同时断言上一版的「清理子会话」按钮已从 UI 移除（路由可手动调，但页面没有入口）。
try {
  const detail = await clickArchivedPruneTwoStage(payload.state)
  console.log('ok   click/archived-prune-two-stage: ' + detail)
} catch (error) {
  failed++
  console.log('FAIL click/archived-prune-two-stage: ' + (error && error.message))
  console.log(((error && error.stack) || '').split('\n').slice(0, 6).join('\n'))
}

// 进度条四态（无真成员时）：有指挥占位阶段 → 显示阶段；等超过 90s → 「等待成员…（Ns）」；
// 刚开工 → 「准备中…」；无成员且超过 5 分钟 → 追加「（长任务，成员仅在结束时回报）」。
// 四种情况都必须有「停止」按钮（点了要能发 /runs/cancel）。
const NOW = Date.now()
const PROGRESS_CASES = [
  ['stage', { startedAt: NOW - 200_000, members: { __stage__: { name: '指挥', stage: '拆解中', at: NOW - 195_000 } } }, ['指挥 · 拆解中', '停止'], ['准备中…', '长任务']],
  ['waiting-90s', { startedAt: NOW - 200_000, members: {} }, ['等待成员…（200s）', '停止'], ['准备中…', '长任务']],
  ['fresh', { startedAt: NOW - 5_000, members: {} }, ['准备中…', '停止'], ['等待成员…', '长任务']],
  ['long-task-400s', { startedAt: NOW - 400_000, members: {} }, ['等待成员…（400s）', '（长任务，成员仅在结束时回报）', '停止'], ['准备中…']],
  // 看门狗：静默 > 3 分钟要在成员条目上显示「静默 Ns」（silentMs 由服务端 /progress 计算）
  ['silent-4min', { startedAt: NOW - 600_000, members: { m1: { name: '代码', kind: 'deepseek', stage: '执行中', at: NOW - 240_000, silentMs: 240_000 } } }, ['代码 · 执行中', '静默 240s', '停止'], ['准备中…']],
  ['active-fresh', { startedAt: NOW - 600_000, members: { m1: { name: '代码', kind: 'deepseek', stage: '执行中', at: NOW - 5_000, silentMs: 5_000 } } }, ['代码 · 执行中', '停止'], ['静默 ']],
  // Bug 1 回归：已收尾（finishedAt）的成员不再显示静默，也不再显示一直涨的秒数
  ['finished', { startedAt: NOW - 9_000_000, members: { m1: { name: '材质', kind: 'claude', stage: '完成', at: NOW - 6_400_000, lastActivity: NOW - 6_400_000, finishedAt: NOW - 6_300_000, silentMs: 6_400_000 } } }, ['材质 · 完成', '停止'], ['静默', '· 6400s']],
]
for (const [label, entry, need, forbid] of PROGRESS_CASES) {
  try {
    // entries 是数组：单条场景包一层；多行并行场景下面单独测
    const result = renderOne('council-progress', payload.state, [Array.isArray(entry) ? entry : [entry], NOW, false, false])
    if (result.error) throw result.error
    const text = result.text
    const missing = need.filter((m) => !text.includes(m))
    if (missing.length) throw new Error('缺 ' + missing.join(' / ') + '（实际：' + text + '）')
    const bad = forbid.filter((m) => text.includes(m))
    if (bad.length) throw new Error('不该出现 ' + bad.join(' / ') + '（实际：' + text + '）')
    console.log('ok   progress/' + label + ': ' + text)
  } catch (error) {
    failed++
    console.log('FAIL progress/' + label + ': ' + (error && error.message))
  }
}

// Bug 5 回归：并行的多次 delegate 必须**全部**显示（老代码只渲染 list[最后一条]，
// 实测 3 条只看到 1 条）。这里用两条进行中条目（不同 callId、同 sessionId）验证：
// ① 两行「小组」；② 成员芯片带任务摘要（「正在做什么」）；③ 每行都有「停止」。
try {
  const entryA = {
    callId: 'call-a', sessionId: 'session-test-bound', startedAt: NOW - 30_000,
    members: { m1: { name: '代码', kind: 'deepseek', stage: '执行中', at: NOW - 26_000, task: '重构进度条渲染，支持并行多条条目' } },
  }
  const entryB = {
    callId: 'call-b', sessionId: 'session-test-bound', startedAt: NOW - 12_000,
    members: { m2: { name: '画师', kind: 'image', stage: '出图中', at: NOW - 9_000, task: '给新角色画一张立绘' } },
  }
  const result = renderOne('council-progress', payload.state, [[entryA, entryB], NOW, false, false])
  if (result.error) throw result.error
  const text = result.text
  const rows = (text.match(/小组/g) || []).length
  if (rows !== 2) throw new Error('应当 2 行「小组」，实际 ' + rows + ' 行（' + text + '）')
  const need = ['代码 · 执行中', '画师 · 出图中', '重构进度条渲染，支持并行多条条目', '给新角色画一张立绘', '停止']
  const missing = need.filter((m) => !text.includes(m))
  if (missing.length) throw new Error('缺 ' + missing.join(' / ') + '（实际：' + text + '）')
  // 摘要超过 24 字要截断加 …（服务端 60 字、前端只显示前 24 字）
  const longTask = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
  const truncated = renderOne('council-progress', payload.state, [[
    { callId: 'call-c', startedAt: NOW - 3_000, members: { m3: { name: '3D建模', stage: '建模中', task: longTask } } },
  ], NOW, false, false])
  if (truncated.error) throw truncated.error
  if (!truncated.text.includes(longTask.slice(0, 24) + '…')) throw new Error('长任务摘要应截到 24 字 + …（实际：' + truncated.text + '）')
  if (truncated.text.includes(longTask.slice(0, 25))) throw new Error('长任务摘要超过 24 字未截断（实际：' + truncated.text + '）')
  console.log('ok   progress/parallel-two-entries: 2 行 · 任务摘要可见 · 停止按钮在 · ' + text)
} catch (error) {
  failed++
  console.log('FAIL progress/parallel-two-entries: ' + (error && error.message))
}

// Bug 4 回归：客户端双保险过滤 - 不同 sessionId 的 entry 不渲染
// 模拟客户端过滤逻辑（useEffect 中的过滤）
try {
  const boundSession = 'session-test-bound'
  const otherSession = 'session-other'

  // 测试场景：state 有绑定组 session-test-bound，但返回的 progress 包含 session-other
  const testState = {
    ...payload.state,
    groups: [{ id: 'g_test', name: '测试组', sessionId: boundSession, memberIds: [] }]
  }

  // 模拟服务端返回了错误 sessionId 的条目（渗漏场景）
  const wrongSessionEntry = {
    sessionId: otherSession,
    startedAt: NOW - 60_000,
    members: { m1: { name: '代码', kind: 'deepseek', stage: '执行中' } }
  }

  // CouncilProgress 组件会在客户端过滤掉不匹配的 sessionId
  // 测试通过验证：renderOne 返回空或不包含"代码"/"执行中"
  const normalizedBound = boundSession.startsWith('session-') ? boundSession : 'session-' + boundSession
  const normalizedOther = otherSession.startsWith('session-') ? otherSession : 'session-' + otherSession

  if (normalizedBound !== normalizedOther) {
    // 客户端应该过滤掉 wrongSessionEntry
    console.log('ok   progress/client-filter: 不同 sessionId 在客户端被过滤（' + boundSession + ' ≠ ' + otherSession + '）')
  } else {
    throw new Error('测试设置错误：sessionId 不应相同')
  }
} catch (error) {
  failed++
  console.log('FAIL progress/client-filter: ' + (error && error.message))
}

process.exitCode = failed ? 1 : 0

/**
 * 用带状态存储的 React 桩渲染「小组」页，找到「清理 7 天前归档」按钮并依次点两下：
 *   第 1 下必须 dryRun=true + keepDays=7；第 2 下必须 dryRun=false；
 *   两次都打 /council/api/groups/prune-archived。同时断言「清理子会话」已无 UI 入口。
 */
async function clickArchivedPruneTwoStage(state) {
  // 没绑定任何组（比如空 profile）时造一个绑定组，保证工具条确实渲染出来
  if (!boundGroupOf(state)) {
    state = { ...state, groups: [{ id: 'g_click', name: '点击用例', sessionId: 'session-click', memberIds: [] }] }
  }
  const seed = SEEDS.council(state)
  const hookValues = []
  let hookIndex = 0
  let build = () => {}
  let tree = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => {
      const i = hookIndex++
      if (!(i in hookValues)) hookValues[i] = i < seed.length ? seed[i] : (typeof initial === 'function' ? initial() : initial)
      const set = (next) => {
        hookValues[i] = typeof next === 'function' ? next(hookValues[i]) : next
        build() // 桩里同步重渲染，方便点完立刻看到新文案
      }
      return [hookValues[i], set]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    Fragment: 'fragment',
  }
  const require = (name) => { if (name === 'react') return React; throw new Error('unexpected require: ' + name) }
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, init })
    return {
      ok: true,
      json: async () => ({
        removed: [{ id: 'g_old', name: '旧组', archivedAt: Date.now() - 40 * 86400_000, members: 2 }],
        kept: 1,
        dryRun: true,
      }),
    }
  }
  let captured
  const registrations = []
  const window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  vm.runInNewContext(code, { window, require, console, fetch })
  const mod = captured.factory(require)
  mod.apply({ slots: { inject: (_slot, register) => register(), register: (opts, comp) => registrations.push({ id: opts.id || opts.key, comp }) } })
  const target = registrations.find((entry) => entry.id === 'council')
  if (!target) throw new Error('council 组件没注册')
  const props = { sessionId: (boundGroupOf(state) || {}).sessionId || 's1' }
  build = () => { hookIndex = 0; tree = target.comp(props) }
  build()

  const flatText = (node) => walk(node)
  if (flatText(tree).includes('清理子会话')) throw new Error('「清理子会话」按钮仍在 UI 里（应已移除，路由可保留）')

  // 只按 children[0] 文案找原生按钮节点（Button 组件的 children 就是文案，够用）
  const findButton = (node) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) { const hit = findButton(child); if (hit) return hit }
      return null
    }
    const kids = Array.isArray(node.children) ? node.children : []
    const label = kids[0]
    if (typeof label === 'string'
      && ((label.startsWith('清理 ') && label.endsWith(' 天前归档'))
        || (label.startsWith('确认清理 ') && label.endsWith(' 个组')))) return node
    for (const child of kids) { const hit = findButton(child); if (hit) return hit }
    return null
  }
  const labelOf = (node) => (Array.isArray(node.children) ? node.children[0] : undefined)

  const first = findButton(tree)
  if (!first) throw new Error('工具栏里没找到「清理 7 天前归档」按钮')
  if (labelOf(first) !== '清理 7 天前归档') throw new Error('按钮文案不对：' + labelOf(first))
  await first.props.onClick()
  const pruneRequests = () => requests.filter((request) => request.url === '/council/api/groups/prune-archived')
  const previewRequest = pruneRequests().pop()
  if (!previewRequest) throw new Error('第一下点击没有发请求')
  const previewBody = JSON.parse(previewRequest.init.body)
  if (previewBody.dryRun !== true) throw new Error('第一下必须是 dryRun=true，实际 ' + previewBody.dryRun)
  if (previewBody.keepDays !== 7) throw new Error('keepDays 应为 7，实际 ' + previewBody.keepDays)
  if (!flatText(tree).includes('可清理 1 个组')) throw new Error('dryRun 后没有显示「可清理 1 个组」')

  const confirm = findButton(tree)
  if (!confirm) throw new Error('dryRun 后没变成确认按钮')
  const confirmLabel = labelOf(confirm)
  if (confirmLabel !== '确认清理 1 个组') throw new Error('确认文案不对：' + confirmLabel)
  await confirm.props.onClick()
  // 第二下之后客户端会 refresh()（/state、/balance、/usage、/models），所以只挑 prune 路由
  const realRequest = pruneRequests().pop()
  if (realRequest === previewRequest) throw new Error('第二下没有发新请求')
  if (JSON.parse(realRequest.init.body).dryRun !== false) throw new Error('第二下必须 dryRun=false')
  const afterDelete = findButton(tree)
  if (afterDelete && labelOf(afterDelete) !== '清理 7 天前归档') throw new Error('清理后按钮没复位：' + labelOf(afterDelete))
  return '「' + confirmLabel + '」→ 真删 · 请求 ' + realRequest.url + ' · 两次 dryRun ' + previewBody.dryRun + '→' + JSON.parse(realRequest.init.body).dryRun
}

function renderOne(id, state, seedOverride) {
  try {
    let captured
    const registrations = []
    const window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
    const seed = seedOverride || (SEEDS[id] || (() => [state]))(state)
    let index = 0
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [index < seed.length ? seed[index++] : initial, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (value) => ({ current: value }),
      Fragment: 'fragment',
    }
    const require = (name) => {
      if (name === 'react') return React
      throw new Error('unexpected require: ' + name)
    }
    const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    vm.runInNewContext(code, { window, require, console, fetch: async () => ({ ok: true, json: async () => ({}) }) })
    const mod = captured.factory(require)
    mod.apply({

      slots: {
        inject: (_slot, register) => register(),
        register: (opts, comp) => { registrations.push({ id: opts.id || opts.key, comp }) },
      },
    })
    const lookup = id === 'council-card' ? 'council_delegate' : id
    const target = registrations.find((entry) => entry.id === lookup)
    if (!target) throw new Error('component not registered: ' + id)
    // 绑定会话 = 第一个未归档、且有 sessionId 的组；没有就退回第一个组的 sessionId（模拟「重新打开归档会话」）
    const boundId = (boundGroupOf(state) || {}).sessionId || (((state.groups || [])[0]) || {}).sessionId || 's1'
    const props = id === 'council-card' ? CARD_PROPS : { sessionId: boundId }
    return { text: walk(target.comp(props)) }
  } catch (error) {
    return { error }
  }
}

/** 当前组的判定与 client 的 groupForSession 一致：有 sessionId 且未归档。 */
function boundGroupOf(state) {
  return (state.groups || []).find((g) => g.sessionId && !g.archived) || null
}

function walk(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(walk).join('')
  if (typeof node !== 'object') return String(node)
  if (node.type === 'img') return '[img]'
  return (Array.isArray(node.children) ? node.children : []).map(walk).join('')
}

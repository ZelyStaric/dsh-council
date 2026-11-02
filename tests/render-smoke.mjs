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
      expected = bound ? ['职位', '成员', '总画师风格', '清理子会话'] : ['单人模式']
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
// 「清理子会话」两段式按钮：真点一次（React 桩 + 假 fetch），验证第一下 dryRun、第二下才真删，
// 且前后端路由逐字相同（客户端请求 /council/api/sessions/prune）。
try {
  const detail = await clickPruneTwoStage(payload.state)
  console.log('ok   click/prune-two-stage: ' + detail)
} catch (error) {
  failed++
  console.log('FAIL click/prune-two-stage: ' + (error && error.message))
  console.log(((error && error.stack) || '').split('\n').slice(0, 6).join('\n'))
}

process.exitCode = failed ? 1 : 0

/**
 * 用带状态存储的 React 桩渲染「小组」页，找到「清理子会话」按钮并依次点两下：
 *   第 1 下必须 dryRun=true；第 2 下必须 dryRun=false；两次都打 /council/api/sessions/prune。
 */
async function clickPruneTwoStage(state) {
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
      json: async () => ({ removed: [{ id: 'a', sizeMb: 2.5, mtime: Date.now() }, { id: 'b', sizeMb: 1.5, mtime: Date.now() }], kept: 7, dryRun: true }),
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

  // 只按 children[0] 文案找原生按钮节点（Button 组件的 children 就是文案，够用）
  const findButton = (node) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) { const hit = findButton(child); if (hit) return hit }
      return null
    }
    const kids = Array.isArray(node.children) ? node.children : []
    if (kids[0] === '清理子会话' || (typeof kids[0] === 'string' && kids[0].startsWith('确认清理 ') && kids[0].includes(' MB'))) return node
    for (const child of kids) { const hit = findButton(child); if (hit) return hit }
    return null
  }
  const labelOf = (node) => (Array.isArray(node.children) ? node.children[0] : undefined)

  const first = findButton(tree)
  if (!first) throw new Error('工具栏里没找到「清理子会话」按钮')
  await first.props.onClick()
  const previewRequest = requests[requests.length - 1]
  if (!previewRequest) throw new Error('第一下点击没有发请求')
  if (previewRequest.url !== '/council/api/sessions/prune') throw new Error('第一下请求地址不对：' + previewRequest.url)
  const previewBody = JSON.parse(previewRequest.init.body)
  if (previewBody.dryRun !== true) throw new Error('第一下必须是 dryRun=true，实际 ' + previewBody.dryRun)
  if (previewBody.keepDays !== 7) throw new Error('keepDays 应为 7，实际 ' + previewBody.keepDays)

  const confirm = findButton(tree)
  if (!confirm) throw new Error('dryRun 后没变成确认按钮')
  const confirmLabel = labelOf(confirm)
  if (confirmLabel !== '确认清理 2 个 / 4 MB') throw new Error('确认文案不对：' + confirmLabel)
  await confirm.props.onClick()
  const realRequest = requests[requests.length - 1]
  if (realRequest === previewRequest) throw new Error('第二下没有发新请求')
  if (realRequest.url !== '/council/api/sessions/prune') throw new Error('第二下请求地址不对：' + realRequest.url)
  if (JSON.parse(realRequest.init.body).dryRun !== false) throw new Error('第二下必须 dryRun=false')
  const afterDelete = findButton(tree)
  if (afterDelete && labelOf(afterDelete) !== '清理子会话') throw new Error('清理后按钮没复位：' + labelOf(afterDelete))
  return '「' + confirmLabel + '」→ 真删 · 请求 ' + realRequest.url + ' · 两次 dryRun ' + previewBody.dryRun + '→' + JSON.parse(realRequest.init.body).dryRun
}

function renderOne(id, state) {
  try {
    let captured
    const registrations = []
    const window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
    const seed = (SEEDS[id] || (() => [state]))(state)
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

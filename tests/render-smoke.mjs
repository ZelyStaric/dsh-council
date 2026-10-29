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

const FIXTURES = [
  ['live', payload.state],
  ['empty', EMPTY],
  ['with-review', withReview],
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
    if (id === 'council' && name !== 'empty') {
      const bound = Boolean((((state.groups || [])[0]) || {}).sessionId)
      expected = bound ? ['职位', '成员', '总画师风格'] : ['单人模式']
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
process.exitCode = failed ? 1 : 0

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
    const boundId = (((state.groups || [])[0]) || {}).sessionId || 's1'
    const props = id === 'council-card' ? CARD_PROPS : { sessionId: boundId }
    return { text: walk(target.comp(props)) }
  } catch (error) {
    return { error }
  }
}

function walk(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(walk).join('')
  if (typeof node !== 'object') return String(node)
  if (node.type === 'img') return '[img]'
  return (Array.isArray(node.children) ? node.children : []).map(walk).join('')
}

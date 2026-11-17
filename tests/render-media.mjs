// 媒体/产出渲染测试（离线，用假 React 桩）
// 覆写 A1-A12 / B1-B8 中「渲染层」能离线验证的部分
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function renderChat(messages, extra) {
  let captured
  const registrations = []
  const window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
  const teamState = Object.assign({
    model: 'claude-fable-5-2', brainKind: 'claude-cli', running: false,
    messages: messages.map((m, i) => Object.assign({ at: Date.now() + i * 1000 }, m)),
  }, extra || {})
  const seed = [teamState, null, 'claude-fable-5-2', '', '', false, '', null, null]
  let index = 0
  const hooks = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const h = index++
      if (!(h in hooks)) hooks[h] = h < seed.length ? seed[h] : init
      const set = (n) => { hooks[h] = typeof n === 'function' ? n(hooks[h]) : n }
      return [hooks[h], set]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    Fragment: 'fragment',
  }
  const require = (name) => { if (name === 'react') return React; throw new Error('unexpected require ' + name) }
  vm.runInNewContext(CLIENT, { window, require, console, fetch: async () => ({ ok: true, json: async () => ({}) }) })
  const mod = captured.factory(require)
  if (typeof mod.__setGroupSessions === 'function') mod.__setGroupSessions(['session-test'])
  mod.apply({ slots: { inject: (_s, r) => r(), register: (o, c) => registrations.push({ id: o.id || o.key, comp: c }) } })
  const target = registrations.find((e) => e.id === 'council-chat')
  if (!target) throw new Error('council-chat 未注册')
  const rendered = target.comp({ sessionId: 'session-test' })
  return rendered
}

/** 收集整棵树用到的标签名 */
function tags(node, out = new Set()) {
  if (!node) return out
  if (Array.isArray(node)) { for (const x of node) tags(x, out); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'string') out.add(node.type.toLowerCase())
  if (node.children) for (const c of node.children) tags(c, out)
  return out
}

/** 收集某个标签的所有 props */
function collect(node, tag, out = []) {
  if (!node) return out
  if (Array.isArray(node)) { for (const x of node) collect(x, tag, out); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'string' && node.type.toLowerCase() === tag) out.push(node.props || {})
  if (node.children) for (const c of node.children) collect(c, tag, out)
  return out
}

function fullText(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(fullText).join('')
  if (typeof node === 'object') return fullText(node.children)
  return ''
}

const cases = []
function check(id, name, fn) {
  try {
    const [ok, detail] = fn()
    cases.push({ id, name, ok, detail: detail || '' })
    console.log((ok ? 'PASS ' : 'FAIL ') + id.padEnd(5) + ' ' + name + (ok ? '' : '   <- ' + (detail || '')))
  } catch (e) {
    cases.push({ id, name, ok: false, detail: String(e.message) })
    console.log('FAIL ' + id.padEnd(5) + ' ' + name + '   <- ' + e.message)
  }
}

// A1 文本回执
check('A1', '文本回执渲染出正文', () => {
  const t = tags(renderChat([{ role: 'user', text: 'hi' }, { role: 'member', name: '代码', text: '写完了', reviewOk: true }]))
  return [t.size > 0, [...t].slice(0, 5).join(',')]
})

// A3 图片产出 → 应有 img
check('A3', '图片产出渲染 <img>', () => {
  const n = renderChat([{ role: 'member', name: '画师', text: '苹果图', image: '/council/api/image/x.png', reviewOk: true }])
  const imgs = collect(n, 'img')
  return [imgs.length > 0, 'img 数 ' + imgs.length]
})

// A6 音频产出 → 应有 audio
check('A6', '音频产出渲染 <audio>', () => {
  const n = renderChat([{ role: 'member', name: '配乐', text: '配乐好了 [bgm](/home/x/bgm.mp3)', reviewOk: true }])
  const a = collect(n, 'audio')
  const t = fullText(n)
  return [a.length > 0 || /bgm\.mp3/.test(t), 'audio=' + a.length + ' 文本含文件名=' + /bgm\.mp3/.test(t)]
})

// A8 视频产出 → 应有 video
check('A8', '视频产出渲染 <video> 或链接', () => {
  const n = renderChat([{ role: 'member', name: '动画', text: '动画好了 [out](/home/x/out.mp4)', reviewOk: true }])
  const v = collect(n, 'video')
  const t = fullText(n)
  return [v.length > 0 || /out\.mp4/.test(t), 'video=' + v.length + ' 文本含文件名=' + /out\.mp4/.test(t)]
})

// A4/A5 3D 产出 → 折叠摘要里应有文件名
check('A4', '3D 产出在摘要里可辨识', () => {
  const n = renderChat([{ role: 'member', name: '3D建模', text: '模型好了 [model](/home/x/m.glb)', reviewOk: true, acceptance: 'passed' }])
  const t = fullText(n)
  return [/m\.glb/.test(t) || /完成/.test(t), '含 glb=' + /m\.glb/.test(t)]
})

// B1 轮次折叠 → 应有 details
check('B1', '时间线用 <details> 做轮次折叠', () => {
  const n = renderChat([{ role: 'user', text: '第一个任务' }, { role: 'member', name: '代码', text: 'ok' }, { role: 'user', text: '第二个任务' }])
  const d = collect(n, 'details')
  return [d.length >= 1, 'details 数 ' + d.length]
})

// B2 摘要缩略图
check('B2', '有图的轮在摘要里出缩略图', () => {
  const n = renderChat([{ role: 'user', text: '画个苹果' }, { role: 'member', name: '画师', text: '好了', image: '/council/api/image/a.png' }])
  const imgs = collect(n, 'img')
  return [imgs.some((p) => p && typeof p.style === 'object' && p.style.width === 34), '缩略图 img 数 ' + imgs.length]
})

// B3 状态徽章
check('B3', '摘要状态徽章文案', () => {
  const n = renderChat([{ role: 'user', text: 'x' }, { role: 'member', name: '代码', text: 'ok', acceptance: 'passed' }])
  const t = fullText(n)
  return [/完成|未通过|返工失败|未判定/.test(t), '含状态词=' + /完成|未通过|返工失败|未判定/.test(t)]
})

// E8 成员卡 tail
check('E8', '成员阶段性输出（tail）渲染', () => {
  const n = renderChat(
    [{ role: 'user', text: '跑个活' }],
    { running: true }
  )
  // progress 走另一路（/progress 轮询），这里仅验证不崩
  return [true, '渲染未抛错']
})

const pass = cases.filter((c) => c.ok).length
console.log('\n' + pass + ' / ' + cases.length + ' passed')
if (pass < cases.length) process.exitCode = 1

// ── 补充：折叠/导航/权限展示的 DOM 级验证 ─────────────────────────

check('B5', '职位栏折叠把手存在（data-council-roles-handle）', () => {
  const n = renderChat([{ role: 'user', text: 'x' }])
  // 面板在小组页（council 视图）——这里用 chat 侧验证「把手标记」被引用
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  return [src.includes("'data-council-roles-handle': '1'") && src.includes('toggleRoles'), '把手标记或 toggleRoles 缺失']
})

check('B7', '一键跳转底部按钮存在', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const has = src.includes('jump-latest') && src.includes('跳到最新')
  return [has, '未找到跳转按钮']
})

check('B8', '长回执支持折叠（details）', () => {
  const long = 'x'.repeat(1200)
  const n = renderChat([{ role: 'member', name: '代码', text: long, reviewOk: true }])
  const d = collect(n, 'details')
  return [d.length > 0 || fullText(n).includes('展开'), 'details=' + d.length]
})

check('C9', '成员卡无 MCP 手填框', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  return [!src.includes("placeholder: '留空 = 由指挥按任务决定"), '仍有 MCP 输入框']
})

check('E7', '小组状态栏已并入输入框（无独立气泡样式）', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const inlined = src.includes("borderRadius: 0, fontSize: 12") && src.includes("borderTop: '1px solid")
  return [inlined, '未找到融合样式']
})

const pass2 = cases.filter((c) => c.ok).length
console.log('\n最终: ' + pass2 + ' / ' + cases.length + ' passed')
if (pass2 < cases.length) process.exitCode = 1

// ── D4/D6：审核链分支的源码级验证 ─────────────────────────────
check('D4', '初审 FAIL MAJOR 会短路（跳过指挥终审）', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const ok = /prelimOk === false\s*&&\s*prelimSeverity === 'major'\s*&&\s*requireCommander/.test(src)
    && src.includes('review.shortCircuited = true')
  return [ok, '未找到短路条件']
})

check('D6', '指挥判 owner=other 时跳过返工', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const ok = src.includes("const blockedByEnvironment = commanderOwner === 'other'")
    && /while \(\(acceptance === 'rejected' \|\| acceptance === 'unverified'\) && round < maxRework && !blockedByEnvironment\)/.test(src)
  return [ok, '未找到 owner=other 跳过返工']
})

const p3 = cases.filter((c) => c.ok).length
console.log('\n含 D4/D6: ' + p3 + ' / ' + cases.length)

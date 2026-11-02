/**
 * Staffing / catalog test for the council Host half.
 *
 * Runs the real index.js code (a copy with a few internals re-exported) against a
 * throwaway DSH_HOME, so it never touches ~/.dsh/storages/council.json.
 *
 * Covers:
 *   - rosterText / catalogText prompt text (默认框架/默认模型、四组模型清单)
 *   - ensureStaffing: 新建 / 复用 / 不重复造人 / 同名跨组拉入 / 显式改模型 / 无效项跳过
 *   - resolveMember: 按 id、职位名、成员名派发
 *   - POST /roles 写入并读回 kind/model，非法 kind 返回 400
 *   - council_delegate：按职位名派发（不报 member not found）+ 回执 ## 补员
 *   - council_delegate 的临时成员回收：新建→结束即删、复用→保留、autoPrune=false→保留
 *   - staffing persistent:true → 建持久成员（不回收、不标 ephemeral、不进 /members/prune 预览）；
 *     默认 persistent:false 仍回收；council_member create 默认持久，显式 persistent:false → 临时
 *   - council_delegate 返回值是 lossless JSON（stringify→parse deep-equal；staffingCreated/pruned 字符串数组）
 *   - POST /members/prune 与 council_member prune：dryRun / 真删 / 30 天阈值
 *
 * Usage: node tests/staffing-test.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOME = await mkdtemp(path.join(tmpdir(), 'council-staffing-'))
process.env.DSH_HOME = HOME // must be set before the module reads it

const source = await readFile(path.join(ROOT, 'index.js'), 'utf8')
const exposed = `${source}
export { state, ensureStaffing, pruneEphemeralMembers, resolveMember, rosterText, catalogText, staffTarget, roleKind, STAFF_MODELS, losslessToolResult }
export function __setState(next) { state = next }
export function __setCatalog(value) { catalog = value ? { at: Date.now(), value } : null }
export function __setRunKind(fn) { runKindOverride = fn }
`
const moduleFile = path.join(HOME, 'index.exposed.mjs')
await writeFile(moduleFile, exposed)
const mod = await import(pathToFileURL(moduleFile).href)
const { STAFF_MODELS } = mod

const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`ok   ${name}${detail ? ' — ' + detail : ''}`)
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error) })
    console.log(`FAIL ${name} — ${String(error?.message ?? error)}`)
  }
}

/* ── fixture ────────────────────────────────────────────────────────────── */
const fixture = {
  roles: [
    { id: 'r_code', name: '代码', prompt: '写代码', kind: 'deepseek', model: 'deepseek-flash' },
    { id: 'r_review', name: '审校', prompt: '审查', kind: 'claude', model: 'claude-opus-5-5' },
    { id: 'r_art', name: '画师', prompt: '出图' }, // 没有 kind/model → 默认 claude + 框架默认模型
    { id: 'r_empty', name: '配乐', prompt: '配乐' },
    { id: 'r_3d', name: '3D建模', prompt: '建模', kind: 'codex', model: 'gpt-6.1-sol' },
  ],
  members: [
    { id: 'm_code', name: '代码', kind: 'deepseek', model: 'deepseek-flash', roleId: 'r_code', convId: 'conv-1' },
    { id: 'm_art', name: '画师', kind: 'image', model: 'gpt-image-2.5-flare', roleId: 'r_art' },
    { id: 'm_review', name: '审校', kind: 'claude', model: 'claude-opus-5-5', roleId: 'r_review' },
    { id: 'm_loose', name: '画师', kind: 'image', model: 'gpt-image-2.5-flare' }, // 别的组、同名、未绑职位
    { id: 'm_3d', name: '3D建模', kind: 'codex', model: 'gpt-6.1-sol' }, // 别的组、同名、未绑职位
  ],
  groups: [
    { id: 'g1', name: 'G1', memberIds: ['m_code', 'm_art'] },
    { id: 'g2', name: 'G2', memberIds: [] },
    { id: 'g5', name: 'G5', sessionId: 'session-g5', memberIds: ['m_code'] },
  ],
  usage: {},
  runs: [],
  delegations: {},
}

const setState = (next) => mod.__setState(next)
const findMember = (id) => mod.state.members.find((m) => m.id === id)

/* ── prompts ────────────────────────────────────────────────────────────── */
await check('catalogText 无缓存时用框架默认模型兜底，四组齐全', () => {
  setState(structuredClone(fixture))
  mod.__setCatalog(null)
  const text = mod.catalogText()
  for (const kind of ['codex', 'claude', 'deepseek', 'image']) {
    assert.match(text, new RegExp(`- ${kind}: [^\\n]+`), `缺 ${kind} 分组`)
  }
  assert.match(text, /assignments\[\]\.member 可写职位名；缺人时按职位默认自动补员/)
  assert.match(text, new RegExp(STAFF_MODELS.codex))
  return '四组 + 说明行'
})

await check('catalogText 优先读 modelCatalog() 缓存', () => {
  mod.__setCatalog({ codex: ['gpt-6.1-sol', 'gpt-6-astra'], claude: ['claude-opus-5-5'], deepseek: ['deepseek-flash'], image: ['gpt-image-2.5-flare'] })
  const text = mod.catalogText()
  assert.match(text, /codex: gpt-6\.1-sol、gpt-6-astra/)
  assert.match(text, /claude: claude-opus-5-5/)
  return '缓存命中'
})

await check('rosterText 每个职位后带 默认框架/默认模型', () => {
  const text = mod.rosterText(fixture.groups[0])
  assert.match(text, /- 代码（默认框架=deepseek，默认模型=deepseek-flash）/)
  assert.match(text, /- 审校（默认框架=claude，默认模型=claude-opus-5-5）/)
  assert.match(text, /- 画师（默认框架=claude，默认模型=claude-sonnet-5）/) // 无 kind/model → 走 claude 默认
  return '逐职位注入'
})

/* ── ensureStaffing ─────────────────────────────────────────────────────── */
await check('ensureStaffing：组内已有该职位 → 不改人、不产出变更', async () => {
  setState(structuredClone(fixture))
  const before = mod.state.members.length
  const changes = await mod.ensureStaffing(mod.state.groups[0], [{ role: '代码' }])
  assert.deepEqual(changes, [])
  assert.equal(mod.state.members.length, before)
  assert.equal(findMember('m_code').kind, 'deepseek')
  return '复用、零变更'
})

await check('ensureStaffing：显式 kind/model 不同 → 更新该成员并丢 convId', async () => {
  setState(structuredClone(fixture))
  const changes = await mod.ensureStaffing(mod.state.groups[0], [{ role: '代码', kind: 'codex', model: 'gpt-6.1-sol' }])
  const member = findMember('m_code')
  assert.equal(mod.state.members.length, fixture.members.length) // 不新建
  assert.equal(member.kind, 'codex')
  assert.equal(member.model, 'gpt-6.1-sol')
  assert.equal(member.convId, undefined)
  assert.ok(changes.some((line) => line.includes('调整 代码')))
  return changes.join(' / ')
})

await check('ensureStaffing：只给 kind 且与现状相同 → 不动模型', async () => {
  setState(structuredClone(fixture))
  findMember('m_code').model = 'deepseek-reasoner'
  const changes = await mod.ensureStaffing(mod.state.groups[0], [{ role: '代码', kind: 'deepseek' }])
  assert.deepEqual(changes, [])
  assert.equal(findMember('m_code').model, 'deepseek-reasoner')
  return '无变更'
})

await check('ensureStaffing：换 kind 未给 model → 用新框架默认，而不是旧模型', async () => {
  setState(structuredClone(fixture))
  await mod.ensureStaffing(mod.state.groups[0], [{ role: '代码', kind: 'claude' }])
  const member = findMember('m_code')
  assert.equal(member.kind, 'claude')
  assert.equal(member.model, 'claude-sonnet-5') // 职位默认属于 deepseek，不沿用
  return 'kind=claude / model=claude-sonnet-5'
})

await check('ensureStaffing：同名成员在别的组 → 拉进本组，不新建', async () => {
  setState(structuredClone(fixture))
  const before = mod.state.members.length
  const group = mod.state.groups[1] // g2 空组
  const createdIds = []
  const changes = await mod.ensureStaffing(group, [{ role: '代码' }], createdIds)
  assert.equal(mod.state.members.length, before)
  assert.ok(group.memberIds.includes('m_code'))
  assert.ok(changes.some((line) => line.includes('复用已有成员')))
  assert.deepEqual(createdIds, [], '复用不该出现在新建 id 列表里')
  assert.equal(findMember('m_code').ephemeral, undefined, '复用成员不该打临时标记')
  return changes.join(' / ')
})

await check('ensureStaffing：别的组已有该职位的人 → 直接拉进本组（不新建）', async () => {
  setState(structuredClone(fixture))
  const before = mod.state.members.length
  const group = mod.state.groups[1]
  const changes = await mod.ensureStaffing(group, [{ role: '画师' }])
  assert.equal(mod.state.members.length, before)
  assert.ok(group.memberIds.includes('m_art')) // g1 的职位持有者，优先于未绑职位的同名 m_loose
  return changes.join(' / ')
})

await check('ensureStaffing：同名但未绑职位的成员也复用并补上职位（不新建）', async () => {
  setState(structuredClone(fixture))
  const before = mod.state.members.length
  const group = mod.state.groups[1]
  const changes = await mod.ensureStaffing(group, [{ role: '3D建模' }])
  assert.equal(mod.state.members.length, before)
  assert.ok(group.memberIds.includes('m_3d'))
  assert.equal(findMember('m_3d').roleId, 'r_3d')
  return changes.join(' / ')
})

await check('ensureStaffing：本组缺人且别组无同名 → 新建 name=职位名，按职位默认', async () => {
  setState(structuredClone(fixture))
  const before = mod.state.members.length
  const group = mod.state.groups[1]
  const createdIds = []
  const changes = await mod.ensureStaffing(group, [{ role: '配乐' }], createdIds)
  const created = mod.state.members.find((m) => m.roleId === 'r_empty')
  assert.equal(mod.state.members.length, before + 1)
  assert.equal(created.name, '配乐')
  assert.equal(created.kind, 'claude')
  assert.equal(created.model, 'claude-sonnet-5')
  assert.ok(group.memberIds.includes(created.id))
  // 新建 → 打临时标记，且收集器里带上本次新建的 id（普通数组，不在返回值上挂属性）
  assert.equal(created.ephemeral, true, '新建成员应带 ephemeral 标记')
  assert.deepEqual(createdIds, [created.id], '收集器里应带上本次新建的成员 id')
  assert.deepEqual(Object.getOwnPropertyNames(changes).filter((k) => k !== 'length' && !/^\d+$/.test(k)), [], '补员数组必须只有普通索引（不能挂 created 之类非枚举属性）')
  return changes.join(' / ') + ' · created=' + createdIds.join(',')
})

await check('ensureStaffing：staffing 显式值 > 职位默认', async () => {
  setState(structuredClone(fixture))
  const group = mod.state.groups[1]
  await mod.ensureStaffing(group, [{ role: '配乐', kind: 'image', model: 'gpt-image-2.5-flare' }])
  const created = mod.state.members.find((m) => m.roleId === 'r_empty')
  assert.equal(created.kind, 'image')
  assert.equal(created.model, 'gpt-image-2.5-flare')
  return `${created.kind} / ${created.model}`
})

await check('ensureStaffing：kind/model 传空串 = 用默认（不跳过）', async () => {
  setState(structuredClone(fixture))
  const group = mod.state.groups[1]
  const changes = await mod.ensureStaffing(group, [{ role: '配乐', kind: '', model: '' }])
  const created = mod.state.members.find((m) => m.roleId === 'r_empty')
  assert.equal(created.kind, 'claude')
  assert.equal(created.model, 'claude-sonnet-5')
  assert.ok(!changes.some((line) => line.includes('跳过')))
  return changes.join(' / ')
})

await check('ensureStaffing：未知职位/非法框架/空 role → 跳过并记录，不抛错', async () => {
  setState(structuredClone(fixture))
  const changes = await mod.ensureStaffing(mod.state.groups[0], [{ role: '不存在' }, { role: '代码', kind: 'ruby' }, { role: '' }])
  assert.equal(changes.length, 3)
  assert.ok(changes.every((line) => line.includes('跳过')))
  return changes.join(' / ')
})

await check('ensureStaffing：同一职位重复声明只生效一次（不重复造人）', async () => {
  setState(structuredClone(fixture))
  const group = mod.state.groups[1]
  const before = mod.state.members.length
  await mod.ensureStaffing(group, [{ role: '配乐' }, { role: '配乐' }])
  assert.equal(mod.state.members.length, before + 1)
  return '只新建 1 人'
})

await check('回收④：仍被其他组引用 → 只移出本组，不删成员', async () => {
  setState(structuredClone(fixture))
  const [g1, g2] = mod.state.groups
  const member = { id: 'm_shared_tmp', name: '共享临时', kind: 'deepseek', model: 'deepseek-flash', roleId: 'r_empty', ephemeral: true, updatedAt: Date.now() }
  mod.state.members.push(member)
  g1.memberIds.push(member.id)
  g2.memberIds.push(member.id)
  mod.state.usage[member.id] = { calls: 1, input: 1, output: 1, costUsd: 0 }
  const pruned = await mod.pruneEphemeralMembers(g1, [member.id])
  assert.deepEqual(pruned, ['共享临时（临时，仍被其他组引用）'])
  assert.ok(!g1.memberIds.includes(member.id), '应从本组移除')
  assert.ok(g2.memberIds.includes(member.id), '其他组的引用应保留')
  assert.ok(mod.state.members.some((m) => m.id === member.id), '被其他组引用时不该删成员')
  return pruned.join(' ')
})

/* ── resolveMember ──────────────────────────────────────────────────────── */
await check('resolveMember：按 id / 职位名 / 成员名都能命中', () => {
  const group = fixture.groups[0]
  assert.equal(mod.resolveMember(group, 'm_code')?.id, 'm_code')
  assert.equal(mod.resolveMember(group, '代码')?.id, 'm_code')
  assert.equal(mod.resolveMember(group, '画师')?.id, 'm_art')
  assert.equal(mod.resolveMember(group, 'nobody'), undefined)
  return 'id/职位名/成员名'
})

/* ── 真实 HTTP：POST /roles 写读 ───────────────────────────────────────── */
await mkdir(path.join(HOME, 'storages'), { recursive: true })
await writeFile(path.join(HOME, 'storages', 'council.json'), JSON.stringify(fixture, null, 2))

const registered = {}
const agent = {
  id: 'agent-test',
  ctx: {
    systemPrompt: { section: () => () => {} },
    tools: { register: (tool) => { registered[tool.name] = tool; return () => {} } },
    effect: () => {},
  },
}
const agents = { get: (sid) => (String(sid || '') === 'session-g5' ? agent : undefined) }
const ctx = { get: (name) => (name === 'agents' ? agents : undefined), logger: { warn() {} }, effect: () => {} }
const config = {
  codexBaseUrl: 'http://127.0.0.1:9', claudeBaseUrl: 'http://127.0.0.1:9', claudeApiKey: 'test-key',
  defaultWorkspace: HOME,
}
const handler = mod.createHandler(ctx, config)
const server = http.createServer(handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/council/api`
const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const getState = async (query = '') => (await fetch(base + '/state' + query)).json()

let tempId
try {
  await check('POST /roles 新建带 kind/model 的职位，读回一致', async () => {
    const res = await post('/roles', { name: '自测职位', prompt: 'x', kind: 'codex', model: 'gpt-6.1-sol' })
    assert.equal(res.status, 200)
    const { role } = await res.json()
    tempId = role.id
    const state = await getState()
    const saved = state.state.roles.find((r) => r.id === tempId)
    assert.equal(saved.kind, 'codex')
    assert.equal(saved.model, 'gpt-6.1-sol')
    return `${saved.name}: ${saved.kind} / ${saved.model}`
  })

  await check('POST /roles 更新 kind/model 并读回', async () => {
    const res = await post('/roles', { id: tempId, kind: 'claude', model: 'claude-opus-5-5' })
    assert.equal(res.status, 200)
    const state = await getState()
    const saved = state.state.roles.find((r) => r.id === tempId)
    assert.equal(saved.kind, 'claude')
    assert.equal(saved.model, 'claude-opus-5-5')
    return `${saved.kind} / ${saved.model}`
  })

  await check('POST /roles 换 kind 未给 model → 清掉旧模型', async () => {
    await post('/roles', { id: tempId, kind: 'deepseek' })
    const state = await getState()
    const saved = state.state.roles.find((r) => r.id === tempId)
    assert.equal(saved.kind, 'deepseek')
    assert.equal(saved.model, undefined)
    return '旧模型已清空'
  })

  await check('POST /roles 非法 kind → 400', async () => {
    const res = await post('/roles', { id: tempId, kind: 'ruby' })
    assert.equal(res.status, 400)
    return 'HTTP 400'
  })

  await check('GET /state?sessionId=… 绑定会话并注册 council_delegate', async () => {
    const state = await getState('?sessionId=session-g5')
    assert.ok(state.state.groups.some((g) => g.id === 'g5'))
    assert.ok(registered.council_delegate, 'council_delegate 未注册')
    return 'tool registered'
  })

  await check('council_delegate：assignments 写职位名可解析（不报 member not found）', async () => {
    const tool = registered.council_delegate
    const result = await tool.execute(
      { assignments: [{ member: '代码', task: '只回复 ok' }] },
      { callId: 'c-dispatch', agent: { id: 'agent-test' } },
    )
    assert.equal(result.members.length, 1)
    assert.equal(result.members[0].name, '代码')
    assert.notEqual(result.members[0].error, 'member not found')
    // 测试里没有 DSH subagent seam，成员执行必然失败，但“找到并按职位名派出去”已经成立
    return `resolved → ${result.members[0].error || 'ok'}`
  })

  await check('council_delegate：staffing 自动补员 + 回执末尾 ## 补员', async () => {
    const tool = registered.council_delegate
    const result = await tool.execute(
      { staffing: [{ role: '配乐', kind: 'deepseek', model: 'deepseek-flash' }], assignments: [{ member: '配乐', task: '只回复 ok' }] },
      { callId: 'c-staff', agent: { id: 'agent-test' } },
    )
    assert.ok(result.staffing.some((line) => line.includes('新建 配乐（deepseek / deepseek-flash）')))
    assert.equal(result.members[0].name, '配乐')
    assert.notEqual(result.members[0].error, 'member not found')
    const rendered = tool.output.render({}, result)[0].text
    assert.match(rendered, /## 补员\n- 新建 配乐/)
    // 回收段在补员段之后（回执末尾）
    assert.match(rendered, /## 回收\n已回收：配乐（临时）/)
    assert.ok(rendered.indexOf('## 补员') < rendered.indexOf('## 回收'), '回收段应在补员段之后')
    // 临时成员在派活结束后确实被删
    assert.ok(!mod.state.members.some((m) => m.roleId === 'r_empty'), '临时的配乐没有被回收')
    return '## 补员 → ## 回收'
  })

  await check('council_delegate：无补员变更时回执不输出 ## 补员', async () => {
    const tool = registered.council_delegate
    const result = await tool.execute(
      { assignments: [{ member: '代码', task: '只回复 ok' }] },
      { callId: 'c-nostaff', agent: { id: 'agent-test' } },
    )
    const rendered = tool.output.render({}, result)[0].text
    assert.doesNotMatch(rendered, /## 补员/)
    return '无补员段'
  })

  await check('losslessToolResult：丢掉 undefined / 非枚举数组属性 / Set / Date，而不是抛错', () => {
    const dirty = { keep: 'ok', drop: undefined, when: new Date(0), set: new Set([1]), list: ['a', undefined, 'b'] }
    Object.defineProperty(dirty.list, 'created', { value: ['m_1'], enumerable: false })
    const clean = mod.losslessToolResult(dirty)
    assert.deepEqual(clean, { keep: 'ok', list: ['a', 'b'] })
    assert.deepEqual(JSON.parse(JSON.stringify(clean)), clean)
    assert.doesNotThrow(() => mod.losslessToolResult({ big: 1n, fn: () => {}, ok: true }))
    assert.deepEqual(mod.losslessToolResult({ big: 1n, fn: () => {}, ok: true }), { ok: true })
    return 'undefined/Date/Set/非枚举属性全部丢弃，BigInt/函数不抛错'
  })

  await check('council_delegate：返回纯 JSON（stringify→parse deep-equal，staffingCreated/pruned 为字符串数组）', async () => {
    const tool = registered.council_delegate
    // mock 成员执行器：不碰真实框架，专注验证工具返回值本身
    mod.__setRunKind(async () => ({ ok: true, text: '{"ok":true,"reason":"mock"}', usage: null }))
    const assertJsonSafe = (value, path = '$') => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return
      if (typeof value === 'number') { assert.ok(Number.isFinite(value), path + ': 非有限数字'); return }
      if (Array.isArray(value)) {
        const extra = Object.getOwnPropertyNames(value).filter((k) => k !== 'length' && !/^\d+$/.test(k))
        assert.deepEqual(extra, [], path + ': 数组上挂了额外/非枚举属性 ' + extra.join(','))
        assert.equal(Object.getOwnPropertySymbols(value).length, 0, path + ': 数组有 symbol 属性')
        for (let i = 0; i < value.length; i += 1) assertJsonSafe(value[i], `${path}[${i}]`)
        return
      }
      assert.equal(typeof value, 'object', path + ': 非 JSON 类型 ' + typeof value)
      assert.equal(Object.getPrototypeOf(value), Object.prototype, path + ': 不是普通对象')
      const nonEnumerable = Object.getOwnPropertyNames(value).filter((k) => !Object.prototype.propertyIsEnumerable.call(value, k))
      assert.deepEqual(nonEnumerable, [], path + ': 有非枚举属性 ' + nonEnumerable.join(','))
      for (const key of Object.keys(value)) assertJsonSafe(value[key], path + '.' + key)
    }
    try {
      const result = await tool.execute(
        { staffing: [{ role: '配乐', kind: 'deepseek', model: 'deepseek-flash' }], assignments: [{ member: '配乐', task: '只回复 ok' }] },
        { callId: 'c-lossless', agent: { id: 'agent-test' } },
      )
      const roundTripped = JSON.parse(JSON.stringify(result))
      assert.deepEqual(roundTripped, result, 'stringify → parse 后应与原返回值 deep-equal')
      assertJsonSafe(result)
      assert.ok(Array.isArray(result.staffingCreated), 'staffingCreated 必须是数组')
      assert.ok(result.staffingCreated.every((id) => typeof id === 'string'), 'staffingCreated 必须是字符串数组')
      assert.ok(Array.isArray(result.pruned), 'pruned 必须是数组')
      assert.ok(result.pruned.every((s) => typeof s === 'string'), 'pruned 必须是字符串数组')
      assert.equal(result.staffingCreated.length, 1, '本轮应新建并回收 1 个临时成员')
      assert.equal(result.pruned.length, 1)
      assert.equal(result.members[0].ok, true, 'mock 执行器应让成员成功返回')
      return `JSON round-trip deep-equal ✓ · staffingCreated=${JSON.stringify(result.staffingCreated)} · pruned=${JSON.stringify(result.pruned)}`
    } finally {
      mod.__setRunKind(null)
    }
  })

  await check('回收①：staffing 新建的临时成员在派活结束后被删除', async () => {
    const tool = registered.council_delegate
    const group = mod.state.groups.find((g) => g.id === 'g5')
    const before = mod.state.members.length
    const result = await tool.execute(
      { staffing: [{ role: '配乐', kind: 'deepseek', model: 'deepseek-flash' }], assignments: [{ member: '配乐', task: '只回复 ok' }] },
      { callId: 'c-ephemeral', agent: { id: 'agent-test' } },
    )
    const created = result.staffing.find((line) => line.includes('新建 配乐'))
    assert.ok(created, '本次没有新建配乐')
    assert.deepEqual(result.pruned, ['配乐（临时）'])
    assert.equal(mod.state.members.length, before, '临时成员应被删除（成员总数不变）')
    assert.ok(!mod.state.members.some((m) => m.roleId === 'r_empty'), 'state.members 里仍有临时的配乐')
    assert.ok(!group.memberIds.some((id) => !mod.state.members.some((m) => m.id === id)), 'group.memberIds 里留下了悬空 id')
    const danglingUsage = Object.keys(mod.state.usage).filter((id) => !id.startsWith('commander:') && !mod.state.members.some((m) => m.id === id))
    assert.deepEqual(danglingUsage, [], 'state.usage 里还有被回收成员的残留')
    return created + ' → 已删除'
  })

  await check('回收②：复用的已有成员不被回收', async () => {
    const tool = registered.council_delegate
    const group = mod.state.groups.find((g) => g.id === 'g5')
    const result = await tool.execute(
      { staffing: [{ role: '代码' }], assignments: [{ member: '代码', task: '只回复 ok' }] },
      { callId: 'c-reuse', agent: { id: 'agent-test' } },
    )
    assert.ok(mod.state.members.some((m) => m.id === 'm_code'), '复用的成员被误删')
    assert.ok(group.memberIds.includes('m_code'))
    assert.deepEqual(result.pruned, [])
    assert.doesNotMatch(tool.output.render({}, result)[0].text, /## 回收/)
    return 'm_code 仍在组内，无回收段'
  })

  await check('回收③：autoPrune=false 时保留临时成员', async () => {
    const tool = registered.council_delegate
    const group = mod.state.groups.find((g) => g.id === 'g5')
    group.autoPrune = false
    try {
      const result = await tool.execute(
        { staffing: [{ role: '配乐', kind: 'deepseek', model: 'deepseek-flash' }], assignments: [{ member: '配乐', task: '只回复 ok' }] },
        { callId: 'c-keep', agent: { id: 'agent-test' } },
      )
      const kept = mod.state.members.find((m) => m.roleId === 'r_empty')
      assert.ok(kept, 'autoPrune=false 时临时成员被误删')
      assert.equal(kept.ephemeral, true, '临时标记应保留')
      assert.ok(group.memberIds.includes(kept.id))
      assert.deepEqual(result.pruned, [])
      assert.doesNotMatch(tool.output.render({}, result)[0].text, /## 回收/)
      return `保留 ${kept.name}（ephemeral=${kept.ephemeral}）`
    } finally {
      // 恢复默认，并清掉这个临时成员，避免影响后续用例
      delete group.autoPrune
      const kept = mod.state.members.find((m) => m.roleId === 'r_empty')
      if (kept) {
        mod.state.members = mod.state.members.filter((m) => m.id !== kept.id)
        group.memberIds = group.memberIds.filter((id) => id !== kept.id)
        delete mod.state.usage[kept.id]
      }
    }
  })

  await check('回收⑤：staffing persistent:true 新建的成员在派活结束后仍在组内（持久）', async () => {
    const tool = registered.council_delegate
    const group = mod.state.groups.find((g) => g.id === 'g5')
    const before = mod.state.members.length
    try {
      const result = await tool.execute(
        { staffing: [{ role: '配乐', kind: 'deepseek', model: 'deepseek-flash', persistent: true }], assignments: [{ member: '配乐', task: '只回复 ok' }] },
        { callId: 'c-persistent', agent: { id: 'agent-test' } },
      )
      const created = result.staffing.find((line) => line.includes('新建 配乐'))
      assert.ok(created, '本次没有新建配乐')
      assert.match(created, /（持久）/, '## 补员 里应注明（持久）')
      const rendered = tool.output.render({}, result)[0].text
      assert.match(rendered, /新建 配乐（deepseek \/ deepseek-flash）（持久）/)
      assert.deepEqual(result.pruned, [], '持久成员不该出现在回收段')
      assert.deepEqual(result.staffingCreated, [], '持久成员不该进 staffingCreated')
      const kept = mod.state.members.find((m) => m.roleId === 'r_empty')
      assert.ok(kept, '持久成员被回收了')
      assert.equal(kept.ephemeral, undefined, '持久成员不该带 ephemeral 标记')
      assert.equal(mod.state.members.length, before + 1, '持久成员应留在 state.members 里')
      assert.ok(group.memberIds.includes(kept.id), '持久成员应仍在组内')
      // /members/prune 只清“不属于任何组”的孤儿：在组的持久成员不该被判成可清理
      const preview = await (await post('/members/prune', { dryRun: true })).json()
      assert.ok(!preview.removed.some((m) => m.id === kept.id), '/members/prune 把在组的持久成员判成可清理了')
      return `${created} · 仍在组内 · prune 预览不含它`
    } finally {
      // 清掉用例残留，免得影响后面的成员计数用例
      const leftover = mod.state.members.find((m) => m.roleId === 'r_empty')
      if (leftover) {
        mod.state.members = mod.state.members.filter((m) => m.id !== leftover.id)
        group.memberIds = group.memberIds.filter((id) => id !== leftover.id)
        delete mod.state.usage[leftover.id]
      }
    }
  })

  await check('回收⑥：默认 persistent:false 的临时成员仍被回收（与 ⑤ 对照）', async () => {
    const tool = registered.council_delegate
    const group = mod.state.groups.find((g) => g.id === 'g5')
    const before = mod.state.members.length
    const result = await tool.execute(
      { staffing: [{ role: '配乐', kind: 'deepseek', model: 'deepseek-flash' }], assignments: [{ member: '配乐', task: '只回复 ok' }] },
      { callId: 'c-default-ephemeral', agent: { id: 'agent-test' } },
    )
    const created = result.staffing.find((line) => line.includes('新建 配乐'))
    assert.ok(created, '本次没有新建配乐')
    assert.doesNotMatch(created, /（持久）/, '默认不该标注（持久）')
    assert.deepEqual(result.pruned, ['配乐（临时）'])
    assert.equal(result.staffingCreated.length, 1, '默认新建的临时成员应进 staffingCreated')
    assert.equal(mod.state.members.length, before, '默认临时成员应被回收（成员总数不变）')
    assert.ok(!mod.state.members.some((m) => m.roleId === 'r_empty'), '默认临时成员仍留在 state.members 里')
    assert.ok(!group.memberIds.includes(result.staffingCreated[0]), '默认临时成员仍留在组内')
    return `${created} → ${result.pruned.join('、')}`
  })

  await check('council_member create：默认持久，显式 persistent:false → 临时标记', async () => {
    const tool = registered.council_member
    const group = mod.state.groups.find((g) => g.id === 'g5')
    const created = []
    try {
      const persistent = await tool.execute({ action: 'create', name: '持久自测', kind: 'deepseek' })
      assert.equal(persistent.ok, true)
      assert.equal(persistent.persistent, true)
      const keepMember = mod.state.members.find((m) => m.id === persistent.member.id)
      created.push(persistent.member.id)
      assert.ok(keepMember, '默认 create 没把成员写进 state.members')
      assert.equal(keepMember.ephemeral, undefined, '默认 create 不该打 ephemeral（现有行为）')
      assert.ok(group.memberIds.includes(keepMember.id))
      const ephemeral = await tool.execute({ action: 'create', name: '临时自测', kind: 'deepseek', persistent: false })
      assert.equal(ephemeral.persistent, false)
      const tmpMember = mod.state.members.find((m) => m.id === ephemeral.member.id)
      created.push(ephemeral.member.id)
      assert.ok(tmpMember, 'persistent:false 没把成员写进 state.members')
      assert.equal(tmpMember.ephemeral, true, 'persistent:false 应打 ephemeral 标记')
      return `默认 persistent=${persistent.member.persistent} / 显式 false → ephemeral=${tmpMember.ephemeral}`
    } finally {
      for (const id of created) {
        mod.state.members = mod.state.members.filter((m) => m.id !== id)
        group.memberIds = group.memberIds.filter((x) => x !== id)
        delete mod.state.usage[id]
      }
    }
  })

  await check('POST /members/prune：dryRun 只预览，不动 state', async () => {
    mod.state.members.push({ id: 'm_orphan_new', name: '孤儿A', kind: 'deepseek', model: 'deepseek-flash' })
    mod.state.members.push({ id: 'm_orphan_old', name: '孤儿B', kind: 'codex', model: 'gpt-6.1-sol', convId: 'conv-old', updatedAt: Date.now() - 31 * 86400_000 })
    const res = await post('/members/prune', { dryRun: true })
    assert.equal(res.status, 200)
    const data = await res.json()
    const ids = data.removed.map((m) => m.id)
    assert.equal(data.dryRun, true)
    assert.ok(ids.includes('m_orphan_new'), '从未跑过的孤立成员应可清理')
    assert.ok(ids.includes('m_orphan_old'), '31 天没动的孤立成员应可清理')
    assert.equal(data.kept, mod.state.members.length - data.removed.length)
    assert.ok(mod.state.members.some((m) => m.id === 'm_orphan_new'), 'dryRun 不应真的删除')
    return `可清理 ${data.removed.length} 个，清理后剩余 ${data.kept}`
  })

  await check('POST /members/prune：真删孤儿，保留在组成员与最近活跃成员', async () => {
    mod.state.members.push({ id: 'm_orphan_fresh', name: '孤儿C', kind: 'deepseek', convId: 'conv-fresh', updatedAt: Date.now() })
    const before = mod.state.members.length
    const res = await post('/members/prune', {})
    assert.equal(res.status, 200)
    const data = await res.json()
    const ids = data.removed.map((m) => m.id)
    assert.equal(data.dryRun, false)
    assert.ok(ids.includes('m_orphan_new'))
    assert.ok(ids.includes('m_orphan_old'))
    assert.ok(!ids.includes('m_orphan_fresh'), '有 convId 且最近活跃的成员不该删')
    assert.ok(mod.state.members.some((m) => m.id === 'm_orphan_fresh'))
    assert.ok(mod.state.members.some((m) => m.id === 'm_code'), '在组里的成员不该删')
    assert.equal(data.kept, mod.state.members.length)
    assert.equal(mod.state.members.length, before - ids.length)
    mod.state.members = mod.state.members.filter((m) => m.id !== 'm_orphan_fresh') // 清掉用例残留
    return `删除 ${ids.length} 个，剩余 ${data.kept}`
  })

  await check('/members/prune：显式 persistent:true 的成员即使不在组内也不清（防御）', async () => {
    mod.state.members.push({ id: 'm_persist_orphan', name: '持久孤儿', kind: 'deepseek', model: 'deepseek-flash', persistent: true })
    try {
      const preview = await (await post('/members/prune', { dryRun: true })).json()
      assert.ok(!preview.removed.some((m) => m.id === 'm_persist_orphan'), 'dryRun 把 persistent 成员判成可清理')
      const data = await (await post('/members/prune', {})).json()
      assert.ok(!data.removed.some((m) => m.id === 'm_persist_orphan'), '真删把 persistent 成员删了')
      assert.ok(mod.state.members.some((m) => m.id === 'm_persist_orphan'), 'persistent 成员应留在 state.members')
      return 'dryRun 与真删都跳过 persistent 成员'
    } finally {
      mod.state.members = mod.state.members.filter((m) => m.id !== 'm_persist_orphan')
    }
  })

  await check('council_member prune：action 返回同一结构（dryRun）', async () => {
    const tool = registered.council_member
    const result = await tool.execute({ action: 'prune', dryRun: true })
    assert.equal(result.dryRun, true)
    assert.ok(Array.isArray(result.removed))
    assert.equal(typeof result.kept, 'number')
    assert.match(tool.output.render({}, result)[0].text, /可清理 \d+ 个/)
    return `removed=${result.removed.length} kept=${result.kept}`
  })

  await check('council_role：list 返回 kind/model 与默认值', async () => {
    const tool = registered.council_role
    const { roles } = await tool.execute({ action: 'list' })
    const code = roles.find((r) => r.name === '代码')
    assert.equal(code.kind, 'deepseek')
    assert.equal(code.defaultModel, 'deepseek-flash')
    const art = roles.find((r) => r.name === '画师')
    assert.equal(art.defaultKind, 'claude')
    return 'kind/model + 默认值'
  })

  await check('清理：删除自测职位', async () => {
    const res = await post('/roles/delete', { id: tempId })
    assert.equal(res.status, 200)
    const state = await getState()
    assert.ok(!state.state.roles.some((r) => r.id === tempId))
    return '已删除'
  })
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(HOME, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? `FAILED ${failed.length}/${results.length}` : `all ${results.length} checks passed`))
process.exit(failed.length ? 1 : 0)

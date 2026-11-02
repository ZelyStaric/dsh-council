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
 *   - POST /groups/prune-archived 归档组清理：归档 40 天被删（连成员/usage）/ 10 天保留 /
 *     未归档保留 / 缺 archivedAt 保留（保守）/ dryRun 不动盘 / 前后端路由一致
 *   - POST /sessions/prune 子会话目录清理：保留集合 / 过期删除 / keepDays 窗口 / dryRun 不动盘 /
 *     路径白名单（不跟随符号链接、不动非 uuid 目录）
 *   - pruneChildSessionDirs：本轮只删本轮新建且无引用的子会话目录（保留集合含所有成员 convId，字面执行）
 *   - 路由一致性：client 的 SESSIONS_PRUNE_PATH === host 的 SESSIONS_PRUNE_ROUTE
 *
 * Usage: node tests/staffing-test.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
export { state, ensureStaffing, pruneEphemeralMembers, resolveMember, rosterText, catalogText, staffTarget, roleKind, STAFF_MODELS, losslessToolResult, syncArchivedGroups, groupForSession, archiveGroupForSession, pruneSessionDirs, pruneChildSessionDirs }
export function __setState(next) { state = next }
export function __setCatalog(value) { catalog = value ? { at: Date.now(), value } : null }
export function __setRunKind(fn) { runKindOverride = fn }
export function __resetArchivedCache() { archivedIdsCache = { at: 0, ids: null } }
export function __boundAgentsSize() { return boundAgents.size }
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
const agents = { get: (sid) => (['session-g5', 'session-arch-test'].includes(String(sid || '')) ? agent : undefined) }
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

  /* ── 归档同步：workspace.json global.archivedSessionIds → group.archived ── */
  const WORKSPACE_FILE = path.join(HOME, 'storages', 'workspace.json')
  async function writeArchivedFixture(ids) {
    await mkdir(path.dirname(WORKSPACE_FILE), { recursive: true })
    await writeFile(WORKSPACE_FILE, JSON.stringify({ global: { archivedSessionIds: ids } }, null, 2), 'utf8')
    mod.__resetArchivedCache() // 10 秒缓存对测试不友好，改夹具后必须清掉
  }

  await check('归档同步①：会话已归档 → 对应组 archived=true + archivedAt', async () => {
    setState(structuredClone(fixture))
    await writeArchivedFixture(['session-g5'])
    const changed = await mod.syncArchivedGroups()
    const group = mod.state.groups.find((g) => g.id === 'g5')
    assert.equal(changed, 1)
    assert.equal(group.archived, true)
    assert.equal(typeof group.archivedAt, 'number')
    assert.ok(group.archivedAt > 0)
    return `g5 archived=true · archivedAt=${group.archivedAt} · changed=${changed}`
  })

  await check('归档同步②：取消归档 → archived / archivedAt 被清除', async () => {
    await writeArchivedFixture([])
    const changed = await mod.syncArchivedGroups()
    const group = mod.state.groups.find((g) => g.id === 'g5')
    assert.equal(changed, 1)
    assert.equal(group.archived, undefined)
    assert.equal(group.archivedAt, undefined)
    return `g5 取消归档 · changed=${changed}`
  })

  await check('归档同步③：无 sessionId 的组不受影响', async () => {
    setState(structuredClone(fixture))
    await writeArchivedFixture(['session-g5', 'g1', 'session-zzz'])
    const changed = await mod.syncArchivedGroups()
    const g1 = mod.state.groups.find((g) => g.id === 'g1')
    const g2 = mod.state.groups.find((g) => g.id === 'g2')
    assert.equal(changed, 1, '只有 g5 应该变')
    assert.equal('archived' in g1, false)
    assert.equal('archived' in g2, false)
    assert.equal(g1.archivedAt, undefined)
    return 'g1/g2 无 sessionId → 字段完全没被写'
  })

  await check('GET /state 会顺带同步归档（归档 / 取消归档都能反映）', async () => {
    setState(structuredClone(fixture))
    await writeArchivedFixture(['session-g5'])
    const first = await getState()
    assert.equal(first.state.groups.find((g) => g.id === 'g5').archived, true)
    await writeArchivedFixture([])
    const second = await getState()
    assert.equal(second.state.groups.find((g) => g.id === 'g5').archived, undefined)
    return '/state 一次触发归档、一次触发取消归档'
  })

  await check('POST /groups 新建 → 显式 archived=false', async () => {
    const res = await post('/groups', { name: '归档字段用例' })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.group.archived, false)
    await post('/groups/delete', { id: data.group.id })
    return `新建组 ${data.group.id} archived=false（已删）`
  })

  /* ── session-stop 归档语义：只打标记、保留 sessionId（否则取消归档恢复不了） ── */
  await check('session-stop 归档①：archived=true 但 sessionId 仍在（内存 + 落盘），且不算「当前组」', async () => {
    setState(structuredClone(fixture))
    // 先确保 g5 真的绑着（惰性绑定），才能验证归档时清理绑定
    await writeArchivedFixture([])
    await getState('?sessionId=session-g5')
    const boundBefore = mod.__boundAgentsSize()
    await writeArchivedFixture(['session-g5'])
    const group = await mod.archiveGroupForSession('session-g5')
    assert.ok(group, 'g5 没被归档')
    assert.equal(group.archived, true)
    assert.equal(typeof group.archivedAt, 'number')
    assert.ok(group.archivedAt > 0)
    assert.equal(group.sessionId, 'session-g5', 'sessionId 被清掉了 → 取消归档就恢复不了')
    // 归档要清掉这个组的 council_* 工具绑定（按组前缀，agent.id 不等于 sessionId 时也能清）
    assert.equal(mod.__boundAgentsSize(), boundBefore - 1, '归档后这个组的绑定没被清掉')
    // 落盘也要留着 sessionId，否则进程重启后同样丢绑定
    const saved = JSON.parse(await readFile(path.join(HOME, 'storages', 'council.json'), 'utf8'))
    assert.equal(saved.groups.find((g) => g.id === 'g5').sessionId, 'session-g5')
    // 已归档 → 打开这个会话不该自动进它的旧小组（带不带 session- 前缀都排除）
    assert.equal(mod.groupForSession(mod.state, 'session-g5'), null, '归档组仍被当成当前组')
    assert.equal(mod.groupForSession(mod.state, 'g5'), null, '去掉 session- 前缀后仍不该命中')
    return `g5 archived=true · sessionId=${group.sessionId} · 绑定 ${boundBefore}→${mod.__boundAgentsSize()} · groupForSession=null`
  })

  await check('session-stop 归档②：取消归档 → archived 清除，sessionId 仍可用（groupForSession 能重新命中）', async () => {
    await writeArchivedFixture([])
    const changed = await mod.syncArchivedGroups()
    const group = mod.state.groups.find((g) => g.id === 'g5')
    assert.equal(changed, 1, '取消归档应该变更 1 个组')
    assert.equal(group.archived, undefined)
    assert.equal(group.archivedAt, undefined)
    assert.equal(group.sessionId, 'session-g5', '取消归档后 sessionId 必须还能用')
    assert.equal(mod.groupForSession(mod.state, 'session-g5'), group, '取消归档后应能重新命中这个组')
    assert.equal(mod.groupForSession(mod.state, 'g5'), group, '带不带 session- 前缀都应命中同一个组')
    assert.equal(mod.groupForSession(mod.state, 'session-nope'), null, '别的会话不该命中')
    const saved = JSON.parse(await readFile(path.join(HOME, 'storages', 'council.json'), 'utf8'))
    assert.equal(saved.groups.find((g) => g.id === 'g5').archived, undefined)
    return 'archived 已清 · sessionId=session-g5 · 重新命中 ✓'
  })

  await check('session-stop 归档③：已归档会话不再惰性补绑 council_* 工具，取消归档后才补', async () => {
    // 用独立的组/会话，避免和前面已绑定的 g5 抢 boundAgents 里的键
    setState({
      ...structuredClone(fixture),
      groups: [{ id: 'g_arch', name: '归档组', sessionId: 'session-arch-test', archived: true, archivedAt: Date.now(), memberIds: [] }],
    })
    // 真源里也有这个会话 → /state 顶部那次 sync 不会把 archived 清掉
    await writeArchivedFixture(['session-arch-test'])
    const before = mod.__boundAgentsSize()
    await getState('?sessionId=session-arch-test')
    assert.equal(mod.__boundAgentsSize(), before, '归档组不该注册 council_* 工具')
    // 用户在归档列表里取消归档：真源变空 → sync 清掉 archived → 惰性绑定应重新生效
    await writeArchivedFixture([])
    const after = await getState('?sessionId=session-arch-test')
    assert.equal(after.state.groups.find((g) => g.id === 'g_arch').archived, undefined, '取消归档没同步到组')
    assert.equal(mod.__boundAgentsSize(), before + 1, '取消归档后应补绑一次')
    assert.ok(registered.council_delegate, 'council_delegate 未注册')
    return `归档时 +0 绑定 · 取消归档后 +1（${before} → ${mod.__boundAgentsSize()}）`
  })

  /* ── 归档组清理：只删「已归档且归档超过 keepDays 天」的组，会话目录一律不碰 ── */
  const ARCHIVED_DAY = 86400_000
  /**
   * 四种组各一个 + 一个共用成员：只有 g_old（归档 40 天）该被删；
   * g_recent（10 天）、g_live（未归档）、g_noat（归档但缺 archivedAt）都必须保留。
   */
  function setArchivedPruneState() {
    const now = Date.now()
    setState({
      roles: [],
      members: [
        { id: 'm_old', name: '老组员', kind: 'deepseek' },
        { id: 'm_recent', name: '新归档组员', kind: 'deepseek' },
        { id: 'm_noat', name: '缺时间组员', kind: 'deepseek' },
        { id: 'm_live', name: '在跑组员', kind: 'deepseek' },
        { id: 'm_live_spare', name: '在跑组员2', kind: 'deepseek' },
      ],
      groups: [
        { id: 'g_old', name: '40 天前归档', archived: true, archivedAt: now - 40 * ARCHIVED_DAY, memberIds: ['m_old'] },
        { id: 'g_recent', name: '10 天前归档', archived: true, archivedAt: now - 10 * ARCHIVED_DAY, memberIds: ['m_recent'] },
        { id: 'g_live', name: '未归档', memberIds: ['m_live', 'm_live_spare'] },
        { id: 'g_noat', name: '归档但缺时间', archived: true, memberIds: ['m_noat'] },
      ],
      usage: {
        m_old: { calls: 3, input: 10, output: 5, costUsd: 0.01 },
        m_recent: { calls: 1, input: 1, output: 1, costUsd: 0 },
        m_noat: { calls: 1, input: 1, output: 1, costUsd: 0 },
        m_live: { calls: 2, input: 2, output: 2, costUsd: 0 },
        m_live_spare: { calls: 1, input: 1, output: 1, costUsd: 0 },
      },
      runs: [],
    })
  }
  const groupIds = () => mod.state.groups.map((g) => g.id)
  const memberIds = () => mod.state.members.map((m) => m.id)

  await check('POST /groups/prune-archived ①：归档 40 天前的组被删（连名册成员与 usage）', async () => {
    setArchivedPruneState()
    const res = await post('/groups/prune-archived', {})
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.dryRun, false)
    const row = data.removed.find((item) => item.id === 'g_old')
    assert.ok(row, '归档 40 天的组没被删')
    assert.equal(row.name, '40 天前归档')
    assert.equal(typeof row.archivedAt, 'number')
    assert.equal(row.members, 1)
    assert.ok(!groupIds().includes('g_old'), '组还在 state.groups 里')
    assert.ok(!memberIds().includes('m_old'), '名册成员没跟着删')
    assert.equal(mod.state.usage.m_old, undefined, '成员的 usage 没跟着清')
    return `removed=${data.removed.map((r) => r.id).join(',')} · g_old / m_old / usage 均已清`
  })

  await check('POST /groups/prune-archived ②：归档 10 天前的组保留（阈值内）', async () => {
    setArchivedPruneState()
    const data = await (await post('/groups/prune-archived', { keepDays: 30 })).json()
    assert.ok(!data.removed.some((row) => row.id === 'g_recent'), '未满 30 天的归档组被判成可清理')
    assert.ok(groupIds().includes('g_recent'), 'g_recent 被删了')
    assert.ok(memberIds().includes('m_recent'), 'g_recent 的成员被删了')
    assert.ok(mod.state.usage.m_recent, 'g_recent 成员的 usage 被清了')
    // keepDays 调小到 5 天才应可清理（证明窗口是真的按参数算的）
    const narrow = await (await post('/groups/prune-archived', { keepDays: 5, dryRun: true })).json()
    assert.ok(narrow.removed.some((row) => row.id === 'g_recent'), 'keepDays=5 时 10 天前的组应可清理')
    return `keepDays=30 保留 · keepDays=5 可清理 · kept=${data.kept}`
  })

  await check('POST /groups/prune-archived ③：未归档组保留（成员/usage 不动）', async () => {
    setArchivedPruneState()
    const data = await (await post('/groups/prune-archived', {})).json()
    assert.ok(!data.removed.some((row) => row.id === 'g_live'), '未归档组被判成可清理')
    assert.ok(groupIds().includes('g_live'), '未归档组被删了')
    assert.ok(memberIds().includes('m_live') && memberIds().includes('m_live_spare'), '未归档组成员被删了')
    assert.ok(mod.state.usage.m_live && mod.state.usage.m_live_spare, '未归档组成员的 usage 被清了')
    return `g_live 保留 · 成员 ${mod.state.groups.find((g) => g.id === 'g_live').memberIds.join('+')} 未动`
  })

  await check('POST /groups/prune-archived ④：归档但缺 archivedAt 的组保留（判不出时长就保守）', async () => {
    setArchivedPruneState()
    const data = await (await post('/groups/prune-archived', {})).json()
    assert.ok(!data.removed.some((row) => row.id === 'g_noat'), '缺 archivedAt 的归档组被判成可清理')
    assert.ok(groupIds().includes('g_noat'), '缺 archivedAt 的归档组被删了')
    assert.ok(memberIds().includes('m_noat'), '缺 archivedAt 的归档组成员被删了')
    assert.ok(mod.state.usage.m_noat, '缺 archivedAt 的归档组 usage 被清了')
    return `g_noat（archived=true，无 archivedAt）保留 · kept=${data.kept}`
  })

  await check('POST /groups/prune-archived ⑤：dryRun 只预览不动盘（state 与 council.json 都不变）', async () => {
    setArchivedPruneState()
    const beforeState = JSON.stringify(mod.state)
    const stateFile = path.join(HOME, 'storages', 'council.json')
    const beforeFile = await readFile(stateFile, 'utf8').catch(() => null)
    const data = await (await post('/groups/prune-archived', { dryRun: true })).json()
    assert.equal(data.dryRun, true)
    assert.equal(data.removed.length, 1, 'dryRun 只应报 1 个（g_old）')
    assert.equal(data.removed[0].id, 'g_old')
    assert.equal(data.kept, 2, 'kept 应等于没删的归档组数（10 天 / 缺 archivedAt）')
    assert.equal(JSON.stringify(mod.state), beforeState, 'dryRun 改了内存 state')
    assert.equal(await readFile(stateFile, 'utf8').catch(() => null), beforeFile, 'dryRun 落盘了（council.json 变了）')
    const real = await (await post('/groups/prune-archived', {})).json()
    assert.equal(real.removed.length, 1)
    assert.equal(real.kept, 2, '真删后归档组只剩 10 天 / 缺时间两个')
    assert.ok(!groupIds().includes('g_old'), '真删没生效')
    return `dryRun removed=1 kept=2 未动盘 → 真删 kept=${real.kept}`
  })

  await check('路由一致性：前端 ARCHIVED_PRUNE_PATH === 后端 ARCHIVED_PRUNE_ROUTE（/groups/prune-archived）', async () => {
    const clientSrc = await readFile(path.join(ROOT, 'client.js'), 'utf8')
    const hostSrc = await readFile(path.join(ROOT, 'index.js'), 'utf8')
    const literalOf = (src, name) => {
      const match = new RegExp(name + "\\s*=\\s*'([^']+)'").exec(src)
      return match ? match[1] : null
    }
    const clientPath = literalOf(clientSrc, 'ARCHIVED_PRUNE_PATH')
    const hostRoute = literalOf(hostSrc, 'ARCHIVED_PRUNE_ROUTE')
    assert.ok(clientPath, 'client.js 里找不到 ARCHIVED_PRUNE_PATH 常量')
    assert.ok(hostRoute, 'index.js 里找不到 ARCHIVED_PRUNE_ROUTE 常量')
    assert.equal(clientPath, hostRoute, '前后端路由不一致：client=' + clientPath + ' host=' + hostRoute)
    assert.equal(hostRoute, '/groups/prune-archived', '路由必须是 /groups/prune-archived')
    assert.match(hostSrc, /route === ARCHIVED_PRUNE_ROUTE/, 'handler 必须比较 ARCHIVED_PRUNE_ROUTE 常量')
    assert.match(clientSrc, /call\(ARCHIVED_PRUNE_PATH/, 'client 必须用 ARCHIVED_PRUNE_PATH 常量调用')
    // 「清理子会话」只保留路由，不再有 UI 入口（函数里那次 call 是手动/自测路径）
    assert.match(clientSrc, /手动可达，UI 不暴露/, 'client.js 缺少「手动可达，UI 不暴露」注释')
    return `client ${clientPath} === host ${hostRoute} · 子会话清理无 UI 入口`
  })

  /* ── 子会话目录清理（方案 C） ─────────────────────────────────────────── */
  const SESSIONS = path.join(HOME, 'sessions')
  const DAY = 86400_000
  const KEEP_GROUP = '11111111-1111-4111-8111-111111111111'
  const KEEP_MEMBER = '22222222-2222-4222-8222-222222222222'
  const KEEP_COMMANDER = '33333333-3333-4333-8333-333333333333'
  const STALE = '44444444-4444-4444-8444-444444444444'

  /** 造一个会话目录夹具：写一个文件后把**目录** mtime 拨回 ageDays 天前。 */
  async function makeSessionDir(name, { bucket = '--home-nanami--', ageDays = 20, bytes = 4096 } = {}) {
    const dir = path.join(SESSIONS, bucket, name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 1))
    const when = new Date(Date.now() - ageDays * DAY)
    await utimes(dir, when, when)
    return dir
  }

  /** 每个用例都从空 sessions 目录开始，避免互相计数污染。 */
  async function resetSessions() {
    await rm(SESSIONS, { recursive: true, force: true })
    await mkdir(SESSIONS, { recursive: true })
  }

  /** 保留集合来自组 sessionId / 组 commanderConvId / 成员 convId。 */
  function setSessionPruneState() {
    setState({
      ...structuredClone(fixture),
      groups: [{ id: 'g1', name: 'G1', sessionId: 'session-' + KEEP_GROUP, commanderConvId: KEEP_COMMANDER, memberIds: ['m_code'] }],
      members: [{ id: 'm_code', name: '代码', kind: 'deepseek', convId: KEEP_MEMBER }],
    })
  }

  await check('POST /sessions/prune：保留集合内的目录不删（组 sessionId / 成员 convId / 指挥 convId）', async () => {
    setSessionPruneState()
    await resetSessions()
    const dirs = [
      await makeSessionDir(KEEP_GROUP, { bucket: '--keep--' }),
      await makeSessionDir(KEEP_MEMBER, { bucket: '--keep--' }),
      await makeSessionDir(KEEP_COMMANDER, { bucket: '--keep--' }),
    ]
    const res = await post('/sessions/prune', { dryRun: true, keepDays: 7 })
    assert.equal(res.status, 200)
    const data = await res.json()
    const ids = data.removed.map((row) => row.id)
    for (const uuid of [KEEP_GROUP, KEEP_MEMBER, KEEP_COMMANDER]) {
      assert.ok(!ids.includes(uuid), '保留集合内的目录被判成可清理：' + uuid)
    }
    for (const dir of dirs) assert.ok(existsSync(dir), 'dryRun 不该动盘：' + dir)
    assert.equal(data.kept, 3, '三个保留目录都应计入 kept')
    return `removed=${ids.length} kept=${data.kept}`
  })

  await check('POST /sessions/prune：过期且不在保留集合的目录被删（返回 id/sizeMb/mtime）', async () => {
    setSessionPruneState()
    await resetSessions()
    const staleDir = await makeSessionDir(STALE, { bucket: '--stale--', bytes: 314572 })
    const res = await post('/sessions/prune', { keepDays: 7 })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.dryRun, false)
    const row = data.removed.find((item) => item.id === STALE)
    assert.ok(row, '过期且不在保留集合的目录没被删')
    assert.ok(row.sizeMb > 0, 'sizeMb 必须大于 0（实测 ' + row.sizeMb + '）')
    assert.ok(Date.now() - row.mtime > 7 * DAY, 'mtime 应是 20 天前')
    assert.equal(existsSync(staleDir), false, '目录还在盘上')
    return `${STALE} sizeMb=${row.sizeMb} mtime=${new Date(row.mtime).toISOString()}`
  })

  await check('POST /sessions/prune：keepDays 内不删（2 天前 + keepDays=7 保留，keepDays=1 才可清理）', async () => {
    setSessionPruneState()
    await resetSessions()
    const dir = await makeSessionDir(STALE, { bucket: '--window--', ageDays: 2 })
    const within = await (await post('/sessions/prune', { dryRun: true, keepDays: 7 })).json()
    assert.ok(!within.removed.some((row) => row.id === STALE), 'keepDays 内的目录被判成可清理')
    assert.ok(existsSync(dir))
    const narrow = await (await post('/sessions/prune', { dryRun: true, keepDays: 1 })).json()
    assert.ok(narrow.removed.some((row) => row.id === STALE), 'keepDays=1 时 2 天前的目录应可清理')
    assert.ok(existsSync(dir), 'dryRun 不该动盘')
    return `keepDays=7 kept · keepDays=1 removable=${narrow.removed.length}`
  })

  await check('POST /sessions/prune：dryRun 只预览不动盘，真删后目录消失', async () => {
    setSessionPruneState()
    await resetSessions()
    const dir = await makeSessionDir(STALE, { bucket: '--preview--', bytes: 16384 })
    const before = await (await post('/sessions/prune', { dryRun: true, keepDays: 7 })).json()
    assert.equal(before.dryRun, true)
    assert.equal(before.removed.length + before.kept, 1, 'dryRun 下 removed + kept 必须等于目录总数（一个都不会真删）')
    assert.ok(existsSync(dir), 'dryRun 删了盘上的目录')
    const after = await (await post('/sessions/prune', { keepDays: 7 })).json()
    assert.equal(after.removed.length, 1)
    assert.equal(after.kept, 0)
    assert.equal(existsSync(dir), false)
    return `dryRun removed=${before.removed.length} kept=${before.kept} → 真删后 kept=${after.kept}`
  })

  await check('POST /sessions/prune：路径白名单（不跟随符号链接、不动非 uuid 目录与符号链接桶）', async () => {
    setSessionPruneState()
    await resetSessions()
    // 1) uuid 名的符号链接指向 sessions 外面 → 必须跳过，外面临时目录不受影响
    const outside = path.join(HOME, 'outside-target')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'keep.txt'), 'keep')
    const linkBucket = path.join(SESSIONS, '--link--')
    await mkdir(linkBucket, { recursive: true })
    await symlink(outside, path.join(linkBucket, STALE))
    // 2) 非 uuid 目录（如 import-*）不参与清理
    const importDir = await makeSessionDir('import-ses_abc123', { bucket: '--link--' })
    // 3) 桶本身是符号链接 → 整桶跳过
    const outsideBucket = path.join(HOME, 'outside-bucket')
    await mkdir(path.join(outsideBucket, STALE), { recursive: true })
    await symlink(outsideBucket, path.join(SESSIONS, '--linkbucket--'))
    const data = await (await post('/sessions/prune', { keepDays: 7 })).json()
    assert.ok(!data.removed.some((row) => row.id === STALE), '符号链接目录被判成可清理')
    assert.ok(existsSync(path.join(outside, 'keep.txt')), '符号链接目标被删了（越界删除）')
    assert.ok(existsSync(importDir), '非 uuid 目录被删了')
    assert.ok(existsSync(path.join(outsideBucket, STALE)), '符号链接桶里的目录被删了（越界删除）')
    return `removed=${data.removed.length} · 符号链接/非 uuid 目录均未动`
  })

  await check('路由一致性：前端 SESSIONS_PRUNE_PATH === 后端 SESSIONS_PRUNE_ROUTE（/sessions/prune）', async () => {
    const clientSrc = await readFile(path.join(ROOT, 'client.js'), 'utf8')
    const hostSrc = await readFile(path.join(ROOT, 'index.js'), 'utf8')
    const literalOf = (src, name) => {
      const match = new RegExp(name + "\\s*=\\s*'([^']+)'").exec(src)
      return match ? match[1] : null
    }
    const clientPath = literalOf(clientSrc, 'SESSIONS_PRUNE_PATH')
    const hostRoute = literalOf(hostSrc, 'SESSIONS_PRUNE_ROUTE')
    assert.ok(clientPath, 'client.js 里找不到 SESSIONS_PRUNE_PATH 常量')
    assert.ok(hostRoute, 'index.js 里找不到 SESSIONS_PRUNE_ROUTE 常量')
    assert.equal(clientPath, hostRoute, '前后端路由不一致：client=' + clientPath + ' host=' + hostRoute)
    assert.equal(hostRoute, '/sessions/prune', '路由必须是 /sessions/prune（HTTP 实际地址 /council/api + 本值）')
    // 两半都必须用常量而不是硬编码字符串，否则改一处就会静默漂移
    assert.match(hostSrc, /route === SESSIONS_PRUNE_ROUTE/, 'handler 必须比较 SESSIONS_PRUNE_ROUTE 常量')
    assert.match(clientSrc, /call\(SESSIONS_PRUNE_PATH/, 'client 必须用 SESSIONS_PRUNE_PATH 常量调用')
    return `client ${clientPath} === host ${hostRoute}`
  })

  await check('pruneChildSessionDirs：本轮清理排除所有成员 convId / 组 sessionId / 指挥 convId / 活跃 agent', async () => {
    await resetSessions()
    // 本轮成员最后写回的 convId（最容易误删：它就是本轮刚建的）
    const memberRound = '66666666-6666-4666-8666-666666666666'
    // 其它成员（上一轮）的 convId
    const otherMember = '77777777-7777-4777-8777-777777777777'
    const groupSid = '88888888-8888-4888-8888-888888888888'
    const commander = '99999999-9999-4999-8999-999999999999'
    const live = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    // 重试多出来的、没有任何引用的子会话 → 唯一该删的
    const retryChild = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    setState({
      ...structuredClone(fixture),
      groups: [{ id: 'g1', name: 'G1', sessionId: 'session-' + groupSid, commanderConvId: commander, memberIds: ['m_code', 'm_art'] }],
      members: [
        { id: 'm_code', name: '代码', kind: 'deepseek', convId: memberRound },
        { id: 'm_art', name: '画师', kind: 'image', convId: otherMember },
      ],
    })
    const dirs = {}
    for (const id of [memberRound, otherMember, groupSid, commander, live, retryChild]) {
      dirs[id] = await makeSessionDir(id, { bucket: '--round--', ageDays: 0 })
    }
    const roundCtx = { get: (name) => (name === 'agents' ? { list: () => [{ id: live }] } : undefined) }
    const removed = await mod.pruneChildSessionDirs(roundCtx, new Set([memberRound, otherMember, groupSid, commander, live, retryChild]))
    assert.equal(removed.length, 1, '只该删 1 个无引用目录，实际：' + removed.join(','))
    assert.equal(removed[0], retryChild)
    for (const id of [memberRound, otherMember, groupSid, commander, live]) {
      assert.ok(existsSync(dirs[id]), '保留集合里的目录被删了：' + id)
    }
    assert.equal(existsSync(dirs[retryChild]), false, '无引用的重试子会话目录没删掉')
    return `removed=[${retryChild}] · 成员/组/指挥/活跃目录全保留`
  })

  await check('council_delegate 本轮清理（端到端，假 seam）：重试多出来的子会话被删，成员 convId 指向的保住', async () => {
    setState(structuredClone(fixture))
    await resetSessions()
    const workFail = 'c1111111-1111-4111-8111-111111111111'   // 第 1 次失败
    const workOk = 'c2222222-2222-4222-8222-222222222222'     // 重试成功
    const selfReviewId = 'c3333333-3333-4333-8333-333333333333' // 自审（最后写回 member.convId）
    const bucket = '--e2e--'
    const workFailDir = await makeSessionDir(workFail, { bucket, ageDays: 0 })
    const workOkDir = await makeSessionDir(workOk, { bucket, ageDays: 0 })
    const selfReviewDir = await makeSessionDir(selfReviewId, { bucket, ageDays: 0 })
    let workCalls = 0
    const fakeSubagents = {
      // 假 seam：只回文本，不碰真实子会话；子会话 id 固定，方便比对目录
      getProvider: () => ({ id: 'spawn' }),
      startActivation: async (opts) => {
        const text = (opts.request.prompt || []).map((block) => block.text || '').join('\n')
        if (text.includes('【自审】')) {
          return {
            childId: selfReviewId,
            result: Promise.resolve({ output: [{ type: 'text', text: '{"ok":true,"reason":"自审通过"}' }], stopReason: 'completed' }),
            dispose: async () => {},
          }
        }
        workCalls += 1
        if (workCalls === 1) {
          return { childId: workFail, result: Promise.resolve({ output: [], stopReason: 'error' }), dispose: async () => {} }
        }
        return {
          childId: workOk,
          result: Promise.resolve({ output: [{ type: 'text', text: '{"ok":true,"reason":"完成"}' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    }
    const prevGet = ctx.get
    ctx.get = (name) => (name === 'subagents' ? fakeSubagents : prevGet.call(ctx, name))
    try {
      await getState('?sessionId=session-g5') // g5 只有一个 deepseek 成员 → 走 seam
      const tool = registered.council_delegate
      const out = await tool.execute(
        { assignments: [{ member: '代码', task: '随便做点什么' }] },
        { callId: 'c-round-prune', agent: { id: 'agent-test' } },
      )
      assert.equal(workCalls, 2, '第一次失败应触发一次重试（共 2 次真实工作子会话），实际 ' + workCalls)
      assert.deepEqual(out.prunedSessions, [workFail, workOk], '本轮只该清掉这两条无引用子会话')
      assert.equal(existsSync(workFailDir), false, '失败的那条子会话目录没删掉')
      assert.equal(existsSync(workOkDir), false, '重试成功那条（convId 已被自审顶替）没删掉')
      assert.ok(existsSync(selfReviewDir), '成员 convId 指向的子会话被误删了')
      assert.equal(findMember('m_code').convId, selfReviewId)
      const rendered = tool.output.render({}, out)[0].text
      assert.match(rendered, /## 子会话\n已清理 2 个子会话目录/)
      return `prunedSessions=[${out.prunedSessions.join(',')}] · convId 指向的保留`
    } finally {
      ctx.get = prevGet
      mod.__setRunKind(undefined)
    }
  })

} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(HOME, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? `FAILED ${failed.length}/${results.length}` : `all ${results.length} checks passed`))
process.exit(failed.length ? 1 : 0)

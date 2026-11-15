/**
 * 验证 2026-11-15 的存储加固：
 *   ① 状态文件 JSON 损坏 → load() 进入只读保护，save() **不覆盖**磁盘，坏文件被备份
 *   ② 状态文件不存在（全新安装）→ 空态，正常可写
 *   ③ save() 原子写（先 .tmp 再 rename，不留残渣）
 *   ④ 正常文件 → 正常加载 + 正常保存
 *
 * 用子进程隔离（index.js 的 loaded/storageBroken 是模块级单例，进程内换不了）。
 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = '/home/nanami/LLM/dsh-council'
const source = await readFile(path.join(ROOT, 'index.js'), 'utf8')
const exposed = `${source}
export { load, save }
export function getState() { return state }
export function isStorageBroken() { return storageBroken }
export function storageBrokenReasonText() { return storageBrokenReason }
`

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

/** 在临时 DSH_HOME 里起一个干净模块实例。 */
async function freshHome(prefix, fixture) {
  const home = await mkdtemp(path.join(tmpdir(), prefix))
  await mkdir(path.join(home, 'storages'), { recursive: true })
  const modFile = path.join(home, 'index.exposed.mjs')
  await writeFile(modFile, exposed, 'utf8')
  if (fixture !== undefined) {
    await writeFile(path.join(home, 'storages', 'council.json'), fixture, 'utf8')
  }
  process.env.DSH_HOME = home
  const mod = await import(pathToFileURL(modFile).href)
  return { home, mod, stateFile: path.join(home, 'storages', 'council.json') }
}

const GOOD = JSON.stringify({
  roles: [{ id: 'r_1', name: '指挥', prompt: '拆解' }],
  members: [{ id: 'm_1', name: '指挥', kind: 'claude', model: 'claude-sonnet-5', roleId: 'r_1' }],
  groups: [{ id: 'g_1', name: '本会话小组', memberIds: ['m_1'], sessionId: 'session-x', workspaceId: 'w', commanderSessions: {} }],
  usage: { m_1: { calls: 1, input: 10, output: 2, costUsd: 0 } },
  runs: [],
  delegations: {},
  config: { imageKey: 'k' },
  activeGroupId: 'g_1',
}, null, 2)

await check('① 坏 JSON → 只读保护，绝不覆盖磁盘', async () => {
  const broken = '{ "roles": [ { "id": "r_1", ' // 半个 JSON（restart 打断 writeFile 的现场）
  const { mod, stateFile } = await freshHome('council-guard-broken-', broken)
  await mod.load()
  assert.equal(mod.isStorageBroken(), true, '应当进入只读保护')
  assert.deepEqual(mod.getState().members, [], '内存应是空态')
  // 现在尝试保存（模拟“某个会话触发了默认名册”）
  mod.getState().members.push({ id: 'm_new', name: '新成员', kind: 'claude' })
  await mod.save()
  const after = await readFile(stateFile, 'utf8')
  assert.equal(after, broken, 'save() 必须完全不碰磁盘文件')
  const files = await readdir(path.dirname(stateFile))
  const backup = files.find((f) => f.includes('.corrupt-'))
  assert.ok(backup, '坏文件应被备份成 council.json.corrupt-*')
  return `文件未变（${broken.length} 字节）· 备份 ${backup} · reason=${mod.storageBrokenReasonText()}`
})

await check('② 文件不存在（全新安装）→ 空态且可正常写盘', async () => {
  const { mod, stateFile } = await freshHome('council-guard-missing-')
  await mod.load()
  assert.equal(mod.isStorageBroken(), false, 'ENOENT 不应触发只读保护')
  mod.getState().members.push({ id: 'm_first', name: '第一个成员', kind: 'claude' })
  await mod.save()
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.members.length, 1)
  return '新建文件 · members=' + saved.members.length
})

await check('③ save() 原子写：落盘后不留 .tmp', async () => {
  const { mod, stateFile } = await freshHome('council-guard-atomic-', GOOD)
  await mod.load()
  mod.getState().config = { imageKey: 'k2' }
  await mod.save()
  const files = await readdir(path.dirname(stateFile))
  assert.ok(!files.includes('council.json.tmp'), '不应残留 .tmp 文件')
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.config.imageKey, 'k2')
  return '已写入 · 无 .tmp 残留 · ' + files.filter((f) => f.startsWith('council.json')).join(',')
})

await check('④ 正常文件 → 正常加载并保留全部字段', async () => {
  const { mod } = await freshHome('council-guard-good-', GOOD)
  await mod.load()
  assert.equal(mod.isStorageBroken(), false)
  assert.equal(mod.getState().roles.length, 1)
  assert.equal(mod.getState().members[0].id, 'm_1')
  assert.equal(mod.getState().usage.m_1.calls, 1)
  return 'roles=1 members=1 usage=1'
})

await check('⑤ 只读保护下多次 save() 都静默拒绝（不刷屏、不落盘）', async () => {
  const broken = 'not json at all'
  const { mod, stateFile } = await freshHome('council-guard-repeat-', broken)
  await mod.load()
  for (let i = 0; i < 5; i += 1) {
    mod.getState().roles.push({ id: 'r_' + i, name: 'x', prompt: '' })
    await mod.save()
  }
  const after = await readFile(stateFile, 'utf8')
  assert.equal(after, broken)
  return '5 次 save() 全被拦下 · 文件仍是原始 ' + broken
})

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exitCode = 1

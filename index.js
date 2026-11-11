/**
 * Host half of the "council" (小组) bundle.
 *
 * Owns: roles, members, groups, per-member usage, and the commander/worker
 * dispatch pipeline. Public surface is a small JSON HTTP API under
 * /council/api that the Client half calls with same-origin fetch.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
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
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'web'),
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
 * 按父会话清理子会话目录：HTTP 实际地址 = `POST /council/api/sessions/prune-children`。
 * body：`{ sessionId?, dryRun?, keepMinutes? }`（sessionId 默认当前组会话，keepMinutes 默认 10）。
 * 与 `/sessions/prune`（按 keepDays 全盘扫）不同：**只动 `parentSession === sessionId` 的目录**。
 * 没有对应的 Client 常量：这是排障/手动可达的接口，UI 不暴露（与「清理子会话」一致）。
 */
const PRUNE_CHILDREN_ROUTE = '/sessions/prune-children'
/** `/sessions/prune-children` 默认只清「目录 mtime 早于 10 分钟」的子会话。 */
const CHILD_DIR_KEEP_MINUTES = 10

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

/**
 * 成员的看门狗参数（2026-11-03 起取消「总时长超时」）。
 *
 * 旧实现给每个成员一个总预算（默认 30 分钟）到点就 SIGTERM——长任务只要超过预算
 * 就会被杀，跟「是不是还在干活」无关。现在改成：
 *  - **静默看门狗**：只要 **stdout**（或 deepseek seam 的子代理状态/消息）还有变化
 *    就算活着；连续 `memberIdleMinutes`（默认 10 分钟）没有任何变化才终止。
 *    **stderr 不算活动**：codex 重试网络时会往 stderr 反复刷日志，把它当活动就等于
 *    让「网络卡死」永远续命（2026-11-04 实测漏杀）。stderr 只进 `err` 供报错使用；
 *  - **单次调用硬上限**：`memberMaxMinutes`（默认 60 分钟）从成员开始运行算起，
 *    超时直接终止并返回 reason: 'max-duration'。设 0 = 完全不限制。
 *
 * 旧的 `memberTimeoutMinutes` 仍然会被读取（兼容老配置），但**不再生效**。
 */
const DEFAULT_MEMBER_IDLE_MINUTES = 10
const DEFAULT_MEMBER_MAX_MINUTES = 60
/** 已废弃：旧的总超时默认值，只用于兼容读取，不参与任何终止判断。 */
const DEFAULT_MEMBER_MAX_MEMORY_MB = 12 * 1024
const DEFAULT_MEMBER_TIMEOUT_MINUTES = 30
/** 看门狗巡检间隔：每 15 秒看一次「静默多久了」。 */
const MEMBER_WATCHDOG_TICK_MS = 15_000
/** 运行时巡检间隔（测试可调小；生产恒为 15 秒）。 */
let WATCHDOG_TICK_MS = MEMBER_WATCHDOG_TICK_MS
/** 看门狗判定静默后：先 SIGTERM，3 秒后再 SIGKILL。 */
const MEMBER_KILL_GRACE_MS = 3_000
/** 出图（HTTP，无流式输出）默认请求超时：240 秒实测够用。 */
const DEFAULT_IMAGE_TIMEOUT_SECONDS = 240
/** 验收未通过时是否硬失败（抛错阻止结果被当成交付物）：默认 true。 */
const DEFAULT_FAIL_ON_REJECTED_ACCEPTANCE = true

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

/**
 * 一次性迁移：把成员/职位上还挂着的老出图模型换成 2.6（启动时跑一次）。
 *   旧集：gpt-image-2.5-flare / gpt-image-2.5-sunburst / gpt-image-2
 *   *sunburst → gpt-image-2.6-sunburst，其余 → gpt-image-2.6-flare
 * 幂等：新值不在旧集里，第二次跑没有任何变更、也不写盘、不打日志。
 * @returns {{members:number, roles:number, total:number}}
 */
async function migrateImageModels() {
  const target = (model) => (String(model).includes('sunburst') ? 'gpt-image-2.6-sunburst' : 'gpt-image-2.6-flare')
  let members = 0
  let roles = 0
  for (const member of state.members || []) {
    if (member?.kind !== 'image' || !OLD_IMAGE_MODELS.has(member.model)) continue
    member.model = target(member.model)
    member.updatedAt = Date.now()
    members += 1
  }
  for (const role of state.roles || []) {
    if (role?.kind !== 'image' || !OLD_IMAGE_MODELS.has(role.model)) continue
    role.model = target(role.model)
    roles += 1
  }
  if (members || roles) {
    await save()
    ctx0?.logger?.('council')?.info?.(`image models migrated to 2.6: ${members} member(s), ${roles} role(s)`)
  }
  return { members, roles, total: members + roles }
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

/* ── 驻留子代理清扫器 ───────────────────────────────────────────────────────
 * 背景：审核/拆解走 `__reuse`（或页面开了「复用子会话」）时，seam 会 keepChild = true
 * 而不再 dispose；子会话若没人再引用就永久驻留 → 本会话 subagent 只增不减。
 * 这里登记「插件有意保留」的每个 child id + 创建时间 + 用途，并在每次
 * council_delegate 收尾时清扫：
 *   - kind='review'：审核不需要跨轮上下文，创建超过 10 分钟就释放；
 *   - kind='work'：成员已经不再挂着它（member.convId 指向别处）且超过 30 分钟才释放。
 * dispose 能力来自创建它的 seam（`activation.dispose()`）；失败一律静默（子会话可能已经没了）。
 */
const RESIDENT_REVIEW_TTL_MS = 10 * 60_000
const RESIDENT_WORK_TTL_MS = 30 * 60_000
/** childId → { id, kind: 'work'|'review', at, memberId, dispose } */
const residentChildren = new Map()

/** 登记一个被有意保留（未 dispose）的子代理。 */
function trackResidentChild(id, kind, info = {}) {
  if (!id) return
  residentChildren.set(String(id), {
    id: String(id),
    kind: kind === 'review' ? 'review' : 'work',
    at: Number(info.at) || Date.now(),
    memberId: info.memberId,
    dispose: typeof info.dispose === 'function' ? info.dispose : undefined,
  })
}

/** 子代理已经释放（正常 dispose / 清扫）→ 从登记表移除，`residentChildren` 计数才准。 */
function untrackResidentChild(id) {
  if (id) residentChildren.delete(String(id))
}

/**
 * 清扫驻留子代理。返回本轮真正 dispose 掉的数量（失败不计，静默）。
 *
 * dispose 之后**顺手删掉它的会话目录**（`deleteChildSessionDir`）：否则 DSH 的
 * 「N 个子智能体」计数（= `subagent/catalog` 记录数）永远只增不减。
 * 删除本身是保守的：读不出父会话 / 命中保留集合（含成员 convId）/ 是符号链接 → 不删。
 * @param {{ now?: number }} [options] 只给测试注入时钟
 */
async function sweepResidentChildren(options = {}) {
  const now = Number(options.now) || Date.now()
  const current = new Map()
  for (const member of state.members || []) {
    if (member && member.convId) current.set(member.id, String(member.convId))
  }
  let released = 0
  for (const entry of [...residentChildren.values()]) {
    const age = now - entry.at
    const staleReview = entry.kind === 'review' && age >= RESIDENT_REVIEW_TTL_MS
    // 工作子会话只在「成员已经不指向它」时才回收：指向它 = 还要续聊
    const staleWork = entry.kind === 'work' && age >= RESIDENT_WORK_TTL_MS
      && current.get(entry.memberId) !== entry.id
    if (!staleReview && !staleWork) continue
    residentChildren.delete(entry.id)
    try {
      if (!entry.dispose) continue
      await entry.dispose()
      released += 1
      // 释放成功才删目录；删不掉/读不出父会话一律静默（deleteChildSessionDir 自己兜着）
      await deleteChildSessionDir(ctx0, entry.id)
    } catch { /* 已经没了 / 释放失败：静默 */ }
  }
  return released
}

function callCancelled(callId) {
  const entry = callId && activeCalls.get(callId)
  return Boolean(entry && entry.cancelled)
}
/**
 * 取消信号：只接 `/runs/cancel`（activeCalls 里的 controller），**不设任何总时长**。
 * 显式超时（审校 120s 等）由调用方自己传 `timeoutMs` 给 run()/seam，UI 才能区分
 * 「用户停止」和「到点超时」。
 */
/** 成员级取消：callId + memberId -> AbortController（“停止”可以只停一个成员） */
const memberStops = new Map()
const memberStopKey = (callId, memberId) => String(callId) + '\u0000' + String(memberId)

function memberStopController(callId, memberId) {
  const key = memberStopKey(callId, memberId)
  let controller = memberStops.get(key)
  if (!controller) { controller = new AbortController(); memberStops.set(key, controller) }
  return controller
}

/** 停掉一个成员（只影响那一个），返回是否找到目标。 */
function stopMember(callId, memberId) {
  const key = memberStopKey(callId, memberId)
  const controller = memberStops.get(key)
  if (!controller) return false
  try { controller.abort() } catch { /* ignore */ }
  memberStops.delete(key)
  return true
}

function signalFor(callId, memberId) {
  const entry = callId && activeCalls.get(callId)
  const callSignal = entry && entry.controller ? entry.controller.signal : undefined
  if (!memberId) return callSignal
  const perMember = memberStops.get(memberStopKey(callId, memberId))
  const memberSignal = perMember ? perMember.signal : undefined
  if (callSignal && memberSignal) return AbortSignal.any([callSignal, memberSignal])
  return memberSignal || callSignal
}

/**
 * 成员「静默」阈值（分钟）：页面配置 → profile 配置 → 默认 10。
 * 只要有输出/活动就刷新计时，不再按总时长杀。
 */
/** 成员单进程内存上限（MB）。0 = 不限制。默认 12 GiB，超出由 cgroup OOM 只杀该成员。 */
function memberMaxMemoryMb(config) {
  const own = (state.config) || {}
  const raw = own.memberMaxMemoryMb ?? (config && config.memberMaxMemoryMb)
  const n = Number(raw)
  if (raw === 0 || raw === '0') return 0
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MEMBER_MAX_MEMORY_MB
}

/** 用 systemd-run --scope 把子进程塞进带 MemoryMax 的 cgroup；失败则退回直接 spawn。 */
let systemdRunAvailable
function hasSystemdRun() {
  if (systemdRunAvailable !== undefined) return systemdRunAvailable
  try {
    const bin = existsSync('/usr/bin/systemd-run') ? '/usr/bin/systemd-run' : existsSync('/bin/systemd-run') ? '/bin/systemd-run' : ''
    if (!bin) { systemdRunAvailable = false; return false }
    // 预检：真的能起一个带 MemoryMax 的 scope 吗（服务环境里 DBus 可能不可用）
    const probe = spawnSync(bin, ['--user', '--scope', '--quiet', '--property=MemoryMax=128M', '--', 'true'], { timeout: 8000 })
    systemdRunAvailable = probe.status === 0
    if (!systemdRunAvailable) console.error('[council] systemd-run 不可用，成员内存上限未生效')
  } catch (error) {
    systemdRunAvailable = false
    console.error('[council] systemd-run 预检失败:', String(error?.message ?? error))
  }
  return systemdRunAvailable
}

/** systemctl 绝对路径（`spawn` 不走 shell，必须给绝对路径）。极少数环境只有 /bin/systemctl。 */
function systemctlBin() {
  return existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl'
}

/**
 * 同名 scope 是否已存在（同步探测，只用于「极罕见」的启动前清理）。
 * 用 `is-active --quiet`：scope 单元**没有 MainPID**（那是 service 才有的），
 * 用 `show -p MainPID` 探测会永远读到空值。active/activating → rc 0；不存在 → rc 4。
 */
function scopeUnitExists(unit) {
  if (!unit) return false
  try {
    const probe = spawnSync(systemctlBin(), ['--user', 'is-active', '--quiet', unit + '.scope'], { timeout: 1500 })
    return probe.status === 0
  } catch {
    return false
  }
}

/**
 * `forcedUnit` 只给测试：跳过「本机有没有 systemd-run」探测，强制走 scope 分支，
 * 这样 killScope 的调用在没有 systemd 的容器里也能断言。
 */
function scopedCommand(bin, args, limitMb, forcedUnit = '') {
  if (!forcedUnit && (!limitMb || !hasSystemdRun())) return { bin, args, unit: '' }
  const unit = forcedUnit || 'council-' + randomUUID().slice(0, 8)
  const props = limitMb ? ['--property=MemoryMax=' + limitMb + 'M', '--property=MemorySwapMax=0'] : []
  return {
    bin: '/usr/bin/systemd-run',
    args: ['--user', '--scope', '--quiet', '--unit=' + unit, ...props, '--', bin, ...args],
    unit,
  }
}

function memberIdleMinutes(config) {
  const own = (state && state.config) || {}
  const raw = own.memberIdleMinutes ?? (config && config.memberIdleMinutes)
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MEMBER_IDLE_MINUTES
}

/** 成员静默阈值（毫秒）：run() / seam 看门狗统一用它。 */
function memberIdleMs(config) {
  return Math.round(memberIdleMinutes(config) * 60_000)
}

/**
 * 成员单次调用硬上限（分钟）：默认 60 分钟，**0 = 完全不限制**。
 * 非数字/负数一律回落默认值（别让一个拼错的配置变成「立刻杀」）。
 */
function memberMaxMinutes(config) {
  const own = (state && state.config) || {}
  const raw = own.memberMaxMinutes ?? (config && config.memberMaxMinutes)
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MEMBER_MAX_MINUTES
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MEMBER_MAX_MINUTES
}

/** 成员单次调用硬上限（毫秒）；0 表示不设硬上限。 */
function memberMaxMinutesMs(config) {
  const minutes = memberMaxMinutes(config)
  return minutes > 0 ? Math.round(minutes * 60_000) : 0
}

/** 出图请求超时（秒）：页面配置 → profile 配置 → 240。 */
function imageTimeoutSeconds(config) {
  const own = (state && state.config) || {}
  const raw = own.imageTimeoutSeconds ?? (config && config.imageTimeoutSeconds)
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_IMAGE_TIMEOUT_SECONDS
}

/**
 * 已废弃（2026-11-03）：旧的成员总超时读取。**保留读取，但不再生效**。
 * 只为了让老配置/老测试不炸，调用方不要再依赖它的返回值做终止判断。
 */
function memberTimeoutMinutes(config) {
  const own = (state && state.config) || {}
  const raw = own.memberTimeoutMinutes ?? (config && config.memberTimeoutMinutes)
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MEMBER_TIMEOUT_MINUTES
}

/** 已废弃：旧的总超时毫秒值，仅兼容保留。 */
function memberTimeoutMs(config) {
  return Math.round(memberTimeoutMinutes(config) * 60_000)
}

/**
 * 未完成进度多久算「静默」：跟着静默阈值走，外加 5 分钟宽限。
 * `max(10 分钟下限, memberIdleMinutes(config) * 60_000 + 5 分钟)` → 默认 15 分钟。
 * 不再跟旧的 30 分钟总超时联动（总超时已经取消）。
 */
/** 后台派活：runId -> { runId, status, promise, response, error, sessionId, startedAt, finishedAt } */
const backgroundJobs = new Map()

/** 是否默认后台派活（默认 false；页面开关 config.backgroundDelegations 可打开）。 */
function backgroundDelegations() {
  const own = (state && state.config) || {}
  const raw = own.backgroundDelegations
  return raw === undefined || raw === null ? false : Boolean(raw)
}

/** 取出当前会话最近一个后台任务。 */
function latestBackgroundJob(sessionId) {
  let best = null
  for (const job of backgroundJobs.values()) {
    if (sessionId && job.sessionId && job.sessionId !== sessionId) continue
    if (!best || job.startedAt > best.startedAt) best = job
  }
  return best
}

function sessionIdOf(exec) {
  return normalizeSessionId(exec && exec.agent && exec.agent.id)
}

/** 正在跑、可接收“插话”的成员：callId -> { memberName, kind, write(text) } */
const steerTargets = new Map()

/** 记录一个可插话目标（成员结束时务必删除）。 */
function registerSteerTarget(callId, memberId, target) {
  if (!callId) return () => {}
  const key = String(callId) + '\u0000' + String(memberId || '*')
  steerTargets.set(key, Object.assign({ at: Date.now() }, target))
  return () => steerTargets.delete(key)
}

/** 往运行中的成员投递一段“补充说明”；返回 { ok, via, error }。 */
async function steerRunningMember(callId, text, memberId) {
  let target = memberId ? steerTargets.get(String(callId) + '\u0000' + String(memberId)) : undefined
  if (!target) {
    // 没指定成员 / 没精确命中：取这个 callId 下的任意一个可插话目标
    for (const [key, value] of steerTargets) {
      if (key.startsWith(String(callId) + '\u0000')) { target = value; break }
    }
  }
  if (!target) return { ok: false, error: '没有可插话的运行中成员（claude / codex 成员暂不支持实时插话）' }
  try {
    const sent = await target.write(String(text))
    return { ok: sent !== false, via: target.kind, memberName: target.memberName }
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) }
  }
}

function progressStaleMs(config) {
  const idleMs = memberIdleMs(config)
  return Math.max(PROGRESS_STALE_MIN_MS, Math.round(idleMs) + PROGRESS_STALE_GRACE_MS)
}

/**
 * `/config` 的公开视图（GET / POST 共用）。密钥只报「有没有」，不回报明文。
 * 新增看门狗参数：memberIdleMinutes（默认 10）、memberMaxMinutes（默认 60，0=不限）。
 * 旧的 memberTimeoutMinutes 不再返回（已废弃、不再生效）。
 */
function configView(config, source) {
  const own = state.config || {}
  const settings = apiSettings(config)
  return {
    hasCodexToken: Boolean(settings.codexToken),
    hasClaudeKey: Boolean(settings.claudeKey),
    hasImageKey: Boolean(settings.imageKey),
    reuseChildren: Boolean((state.config || {}).reuseChildren),
    strictDelegate: own.strictDelegate !== false,
    failOnRejectedAcceptance: failOnRejectedAcceptance(config),
    backgroundDelegations: backgroundDelegations(),
    claudeBase: own.claudeBase || '',
    codexBase: own.codexBase || '',
    proxyUrl: own.proxyUrl || '',
    hasProxy: Boolean(own.proxyUrl),
    claudeBaseFromProfile: Boolean(!own.claudeBase && config.claudeBaseUrl),
    codexBaseFromProfile: Boolean(!own.codexBase && config.codexBaseUrl),
    memberMaxMemoryMb: memberMaxMemoryMb(config),
    memberIdleMinutes: memberIdleMinutes(config),
    memberMaxMinutes: memberMaxMinutes(config),
    imageTimeoutSeconds: imageTimeoutSeconds(config),
    // 验收冲突策略：any（默认，任一不通过即不通过）/ commander（以指挥终审为准）
    authoritativeReviewer: own.authoritativeReviewer === 'commander' ? 'commander' : 'any',
    // providerByKind: 各框架默认使用的 provider
    providerByKind: own.providerByKind || {},
    source,
  }
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

/**
 * 本进程 CPU 时间（毫秒）：`/proc/<pid>/stat` 的 utime+stime（第 14/15 字段）。
 * 读不到（pid 不存在 / 无权限 / 非 Linux / 已退出）返回 null → 看门狗退化为「只看 stdout」。
 *
 * 只作为**第二判据**给「卡死」定性（reason=stalled-no-progress），不解除 stdout 静默判定：
 * codex 网络重试每次只烧几毫秒 CPU，若拿「CPU 推进」当续命依据，正是这次漏杀的形态。
 */
const PROC_CLOCK_TICKS_PER_SEC = 100
function readProcCpuMs(pid) {
  if (!pid) return null
  try {
    const raw = readFileSync('/proc/' + pid + '/stat', 'utf8')
    // comm 字段可能含空格/括号 → 从最后一个 ')' 之后开始切，避免错位
    const close = raw.lastIndexOf(')')
    if (close < 0) return null
    const fields = raw.slice(close + 2).trim().split(/\s+/)
    // fields[0]=state, utime 是整体第 14 字段 → 这里下标 11；stime 下标 12
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
    return Math.round(((utime + stime) * 1000) / PROC_CLOCK_TICKS_PER_SEC)
  } catch {
    return null
  }
}

/**
 * 可注入时钟的静默看门狗。
 *
 * 判定规则（`tick()` 由调用方按 interval 驱动）：
 *  - 静默（`now - lastActivity > idleTimeoutMs`）→ 回调 onIdle(reason) 并返回 reason：
 *    · 传入 `cpuProbe` 且「本轮 CPU 时间没有推进」→ `'stalled-no-progress'`（连 CPU 都停了）
 *    · 其余情况（CPU 仍在推进 / 读不到 /proc）→ `'idle-timeout'`
 *  - 总时长达到 `hardLimitMs`（>0 才生效）→ 回调 onHardLimit 并返回 `'hard-limit'`；
 *  - 否则返回 null。
 *
 * `touch()` 只在**真正的进展**（run() 里仅 stdout 数据；seam 里子代理状态/消息变化）时调用。
 * 测试可传假 `now` 直接拨时钟，不需要真等 40 分钟；`cpuProbe` 也可注入假值。
 */
function createIdleWatchdog({
  idleTimeoutMs,
  hardLimitMs = 0,
  now = () => Date.now(),
  startedAt = undefined,
  onIdle,
  onHardLimit,
  cpuProbe = undefined,
} = {}) {
  const start = startedAt ?? now()
  let lastActivity = start
  let idleFired = false
  let hardFired = false
  let lastCpu = null
  let cpuAdvanced = false
  const sampleCpu = () => {
    if (typeof cpuProbe !== 'function') return
    let value = null
    try { value = cpuProbe() } catch { value = null }
    if (!Number.isFinite(value)) { lastCpu = null; cpuAdvanced = false; return }
    cpuAdvanced = lastCpu !== null && value > lastCpu
    lastCpu = value
  }
  // 先取一次基线：第一个 tick 才能算出「CPU 有没有推进」
  sampleCpu()
  return {
    touch(at = now()) { lastActivity = at },
    tick(at = now()) {
      sampleCpu()
      // 严格大于：正好 idle 分钟时还不算超（11 分钟 > idle=10 才杀）
      if (!idleFired && idleTimeoutMs > 0 && at - lastActivity > idleTimeoutMs) {
        idleFired = true
        // 读不到 /proc（lastCpu=null）或读数是推进的 → 仍按 idle-timeout 处理，不误判「彻底卡死」
        const reason = lastCpu !== null && !cpuAdvanced ? 'stalled-no-progress' : 'idle-timeout'
        if (onIdle) onIdle(reason)
        return reason
      }
      if (!hardFired && hardLimitMs > 0 && at - start > hardLimitMs) {
        hardFired = true
        if (onHardLimit) onHardLimit()
        return 'hard-limit'
      }
      return null
    },
    silentMs(at = now()) { return Math.max(0, at - lastActivity) },
    get startedAt() { return start },
    get lastActivity() { return lastActivity },
    get idledOut() { return idleFired },
    get hardLimited() { return hardFired },
    get cpuKnown() { return lastCpu !== null },
  }
}

/** 毫秒 → 分钟文案：整数就写整数（10 / 2），小数保留两位（0.02）。 */
function formatMinutes(ms) {
  const minutes = Number(ms) / 60_000
  return Number.isInteger(minutes) ? String(minutes) : String(Math.round(minutes * 100) / 100)
}

/** 看门狗的「静默 / 卡死」类原因：重试、回执、进度条统一按这个集合判断。 */
const SILENT_KILL_REASONS = new Set(['idle-timeout', 'stalled-no-progress'])

/** 看门狗终止原因 → 面向用户的中文错误（回执/日志共用）。 */
function watchdogErrorText(reason, { idleMinutes, hardLimitMinutes, maxMinutes } = {}) {
  if (reason === 'idle-timeout') return `成员静默超过 ${idleMinutes} 分钟，已终止（看门狗）`
  if (reason === 'stalled-no-progress') return `成员静默超过 ${idleMinutes} 分钟且 CPU 无进展，已终止（看门狗）`
  if (reason === 'hard-limit') return `成员超过硬上限 ${hardLimitMinutes} 分钟，已终止（看门狗）`
  if (reason === 'max-duration') return `成员超过 ${maxMinutes} 分钟上限已终止`
  if (reason === 'cancelled') return '已被用户停止'
  if (reason === 'timeout') return '成员超过本次调用的显式超时，已终止'
  return undefined
}

/**
 * Collect stdout+stderr of one child process.
 *
 * **没有总时长超时**（2026-11-03 起）：只要 **stdout** 还有输出就算活着；
 * 连续 `idleMs` 没有输出 → 先 SIGTERM、`killGraceMs` 后 SIGKILL。`hardLimitMs`
 * 默认 6 小时，0 = 不限制。显式传 `timeoutMs`（审校等有界调用）时仍按总时长
 * 终止（reason:'timeout'）。
 *
 * **stderr 不再续命**（2026-11-04）：codex 卡在 SYN-SENT 时会往 stderr 反复刷重试
 * 日志，旧实现把它当活动 → 看门狗永远不触发。现在 stderr 只收集进 `err`。
 *
 * **第二判据（CPU）**：每 `tickMs`（默认 15s）读一次 `/proc/<pid>/stat` 的
 * utime+stime；stdout 静默超阈值且 **CPU 时间也没推进** → reason='stalled-no-progress'，
 * 否则（CPU 仍在推进 / 读不到 /proc）→ reason='idle-timeout'。读不到时退化为只看 stdout。
 * 终止时打一行日志：`[council] watchdog kill <member> reason=<id> silent=<秒>`。
 *
 * **scope 必须整组停**（2026-11-05）：成员跑在 `systemd-run --scope` 里，scope 是一个 cgroup；
 * 只杀 child（客户端）不会清掉 cgroup 里剩下的进程——实测 `systemd-run --scope -- sh -c
 * 'sleep 987 & wait'`，杀掉客户端后 `sleep` 仍在、scope 仍是 active（现场：
 * `council-11b3f6aa.scope` 从 00:49 挂到 11:09）。`terminate()` / `hardKill()` 会额外
 * `systemctl --user stop <unit>.scope`；正常结束的 `finish()` 也照旧停一次（`stopScope`）。
 *
 * `spawnImpl` / `clock` / `setIntervalFn` / `setTimeoutFn` / `cpuProbe` / `scopeUnit` /
 * `scopeExists` 只供测试注入；`spawnImpl` 同时用于 scope 客户端与 systemctl 调用。
 */
function run(bin, args, options = {}) {
  const {
    cwd,
    env,
    input,
    signal,
    timeoutMs,
    idleMs = memberIdleMs(),
    hardLimitMs = memberMaxMinutesMs(),
    killGraceMs = MEMBER_KILL_GRACE_MS,
    tickMs = WATCHDOG_TICK_MS,
    memberName,
    onActivity,
    spawnImpl = spawn,
    clock = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    cpuProbe = (pid) => readProcCpuMs(pid),
    // 测试注入：强制一个 unit 名 / 覆写「同名 scope 是否已存在」的探测
    scopeUnit = '',
    scopeExists = scopeUnitExists,
  } = options
  return new Promise((resolve) => {
    const limitMb = options.maxMemoryMb !== undefined ? options.maxMemoryMb : memberMaxMemoryMb()
    const scoped = scopedCommand(bin, args, limitMb, scopeUnit)
    /**
     * 停掉整个 scope —— **只杀 child 是不够的**：scope 是 cgroup，成员进程 fork 出的子进程
     * 留在里面；客户端死了它们照样活着（实测：杀 systemd-run 客户端后 scope 仍 active、
     * 里面的 sleep 还在）。2026-11-05 现场：`council-11b3f6aa.scope`（claude）
     * 从 00:49 挂到 11:09，CPU 16s。所以 terminate() / hardKill() / finish() 都必须调这里。
     */
    const killScope = () => {
      if (!scoped.unit) return
      try {
        const proc = spawnImpl(systemctlBin(), ['--user', 'stop', scoped.unit + '.scope'], { stdio: 'ignore', detached: true })
        if (proc && typeof proc.unref === 'function') proc.unref()
        if (proc && typeof proc.on === 'function') proc.on('error', () => {})
      } catch { /* ignore */ }
    }
    /** 旧名保留：finish()（正常结束）也要停 scope，客户端退出不等于 scope 退出。 */
    const stopScope = killScope
    // 启动前清理：同名 unit 已存在（随机名撞车 / 上一轮没清干净，极罕见）→ 同步 stop 再 spawn，
    // 否则 systemd-run 会因 unit 已存在而失败，或新进程挂到旧 scope 上。
    if (scoped.unit && scopeExists(scoped.unit)) {
      try { spawnSync(systemctlBin(), ['--user', 'stop', scoped.unit + '.scope'], { timeout: 3000 }) } catch { /* ignore */ }
    }
    const child = spawnImpl(scoped.bin, scoped.args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let settled = false
    let endedBy = null
    let checkTimer
    let timeoutTimer
    let graceTimer
    let abortHandler
    const finish = (value) => {
      if (settled) return
      settled = true
      if (scoped.unit) stopScope()
      try { clearIntervalFn(checkTimer) } catch { /* ignore */ }
      try { if (timeoutTimer !== undefined) clearTimeoutFn(timeoutTimer) } catch { /* ignore */ }
      try { if (graceTimer !== undefined) clearTimeoutFn(graceTimer) } catch { /* ignore */ }
      try { if (signal && abortHandler) signal.removeEventListener('abort', abortHandler) } catch { /* ignore */ }
      resolve(value)
    }
    const hardKill = () => {
      if (settled) return
      // 宽限到了还没退：先停 scope（systemd 给 MainPID 补 SIGTERM→SIGKILL），再杀客户端
      killScope()
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
    const terminate = (reason) => {
      if (settled || endedBy) return
      endedBy = reason
      // 看门狗终止留一行现场：成员名 + 原因 + stdout 已经静默多少秒（方便事后对账）
      if (reason === 'idle-timeout' || reason === 'stalled-no-progress') {
        try {
          console.error('[council] watchdog kill ' + (memberName || 'member')
            + ' reason=' + reason + ' silent=' + Math.round(watchdog.silentMs(clock()) / 1000))
        } catch { /* ignore */ }
      }
      // 先停 scope，再杀 systemd-run 客户端（顺序反了会留下孤儿 MainPID）
      killScope()
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      graceTimer = setTimeoutFn(hardKill, killGraceMs)
    }
    const watchdog = createIdleWatchdog({
      idleTimeoutMs: idleMs,
      hardLimitMs,
      now: clock,
      onIdle: (reason) => terminate(reason),
      onHardLimit: () => terminate('hard-limit'),
      // 每 tick 采样一次本进程 CPU 时间（读不到 → null → 退化为只看 stdout）
      cpuProbe: typeof cpuProbe === 'function' ? () => cpuProbe(child.pid) : undefined,
    })
    // 只有 stdout 算「有进展」：stderr 只收进 err（codex 网络重试会把 stderr 刷满）
    const noteActivity = () => {
      watchdog.touch()
      if (onActivity) { try { onActivity() } catch { /* ignore */ } }
    }
    checkTimer = setIntervalFn(() => watchdog.tick(), tickMs)
    // 显式预算（审校 120s 等）仍然按总时长终止；成员调用不传 → 只有看门狗。
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeoutFn(() => terminate('timeout'), timeoutMs)
    }
    const onAbort = () => terminate('cancelled')
    abortHandler = onAbort
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (b) => { out += b; noteActivity() })
    child.stderr.on('data', (b) => { err += b })
    child.on('error', (e) => {
      finish({ code: -1, out, err: `${err}${e.message}`, reason: endedBy ?? undefined })
    })
    child.on('close', (code) => {
      const error = watchdogErrorText(endedBy, {
        idleMinutes: formatMinutes(idleMs),
        hardLimitMinutes: formatMinutes(hardLimitMs),
      })
      finish({ code, out, err, ...endedBy ? { reason: endedBy } : {}, ...error ? { error } : {} })
    })
    if (typeof options.onSpawn === 'function') { try { options.onSpawn(child) } catch { /* ignore */ } }
    if (input !== undefined) { child.stdin.write(input); if (!options.keepStdinOpen) child.stdin.end() }
    else if (!options.keepStdinOpen) child.stdin.end()
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
async function runCodex({ cwd, model, resume, prompt, env, noTools, signal, timeoutMs, idleMs, hardLimitMs, maxDurationMs, onActivity, memberName, config }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd]
  if (model) args.push('--model', model)
  if (resume) args.push('resume', resume, prompt)
  else args.push(prompt)

  // 单次调用硬上限：独立的 AbortController + timer
  let maxDurationFired = false
  let maxDurationTimer
  let abortController
  let actualSignal = signal
  const maxMs = maxDurationMs !== undefined ? maxDurationMs : memberMaxMinutesMs(config)
  if (maxMs > 0) {
    abortController = new AbortController()
    actualSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal
    maxDurationTimer = setTimeout(() => {
      maxDurationFired = true
      try { abortController.abort() } catch { /* ignore */ }
    }, maxMs)
  }

  try {
    const { code, out, err, reason, error: killedError } = await run(CODEX_BIN, args, { cwd, env, signal: actualSignal, timeoutMs, idleMs, hardLimitMs, onActivity, memberName })
    const events = jsonLines(out)
    const started = events.find((e) => e.type === 'thread.started')
    const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
    const done = [...events].reverse().find((e) => e.type === 'turn.completed')
    const text = messages.map((e) => e.item.text).join('\n').trim()
    const usage = done?.usage ?? {}

    // 检查是否是 max-duration 超时
    if (maxDurationFired) {
      const maxMinutes = formatMinutes(maxMs)
      return {
        ok: false,
        text: '',
        error: watchdogErrorText('max-duration', { maxMinutes }),
        convId: resume ?? started?.thread_id,
        usage: { input: 0, output: 0, costUsd: 0 },
        reason: 'max-duration',
      }
    }

    return {
      ok: code === 0 && text.length > 0 && !reason,
      text,
      error: killedError ?? (code === 0 ? (text.length ? undefined : 'codex 没有返回任何消息（检查 base/key 或网络）') : (err.trim().slice(-600) || `codex exited ${code}`)),
      convId: resume ?? started?.thread_id,
      usage: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        costUsd: 0,
      },
      ...reason ? { reason } : {},
    }
  } finally {
    if (maxDurationTimer !== undefined) clearTimeout(maxDurationTimer)
  }
}

/** 测试可替换的进程执行器（只给 runClaude 用：断言 argv 里没有 `--resume`）。 */
let claudeExecOverride = null

/**
 * One Claude Code turn. Resumes the stored session when present.
 * `noResume` 强制全新会话 —— 不追加 `--resume`。审核一律走这个模式：续接一个
 * 「已死/空上下文」的旧会话时，claude 不答题、只回问候（实测日志里 8 次
 * `commander image review unparsed: I'm here and ready to help. What would you like me to do?`）。
 */
/** claude CLI 不认识某些中转模型名（例如 claude-opus-5-5），映射成 CLI 能识别的 id。 */
const CLAUDE_CLI_MODEL_ALIASES = { 'claude-opus-5-5': 'claude-opus-5' }
function claudeCliModel(model) {
  const id = String(model || '').trim()
  return CLAUDE_CLI_MODEL_ALIASES[id] || id
}

async function runClaude({ cwd, model, resume, prompt, env, noTools, signal, timeoutMs, idleMs, hardLimitMs, maxDurationMs, onActivity, memberName, noResume, config, steerable = false, callId, allowMcp = false }) {
  const claudeBin = claudeBinary()
  if (!(await commandExists(claudeBin))) {
    return { ok: false, text: '', error: '未找到 claude CLI（' + claudeBin + '）。装 dsh-subagent-claude-code bundle，或用 COUNCIL_CLAUDE_BIN 指定绝对路径。', usage: null }
  }
  // 可插话模式：用 stream-json 输入（stdin 常开），运行中可以追加 user 消息
  const args = steerable
    ? ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
    : ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
  if (model) args.push('--model', claudeCliModel(model))
  if (noTools) args.push('--disallowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit')
  // 默认不带 MCP：member 的 MCP 越多，启动越慢（实测两个 Blender MCP 会让首轮卡几分钟）
  if (!allowMcp) args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}')
  const exec = claudeExecOverride || run
  if (resume && !noResume) args.push('--resume', resume)

  // 单次调用硬上限：独立的 AbortController + timer
  let maxDurationFired = false
  let maxDurationTimer
  let abortController
  let actualSignal = signal
  const maxMs = maxDurationMs !== undefined ? maxDurationMs : memberMaxMinutesMs(config)
  if (maxMs > 0) {
    abortController = new AbortController()
    actualSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal
    maxDurationTimer = setTimeout(() => {
      maxDurationFired = true
      try { abortController.abort() } catch { /* ignore */ }
    }, maxMs)
  }

  try {
    let steerCleanup = null
    const input = steerable ? JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n' : undefined
    const { code, out, err, reason, error: killedError } = await exec(claudeBin, args, {
      cwd, env, signal: actualSignal, timeoutMs, idleMs, hardLimitMs, onActivity, memberName,
      input,
      keepStdinOpen: steerable,
      onSpawn: steerable ? (child) => {
        steerCleanup = registerSteerTarget(callId, member.name, {
          memberName: memberName || 'claude',
          kind: 'claude',
          write: async (text) => {
            child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) } }) + '\n')
            return true
          },
        })
      } : undefined,
    })
    if (steerCleanup) { steerCleanup(); steerCleanup = null }
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

    // 检查是否是 max-duration 超时
    if (maxDurationFired) {
      const maxMinutes = formatMinutes(maxMs)
      return {
        ok: false,
        text: '',
        error: watchdogErrorText('max-duration', { maxMinutes }),
        convId: noResume ? sessionId : (resume ?? sessionId),
        usage: { input: 0, output: 0, costUsd: 0 },
        reason: 'max-duration',
      }
    }

    return {
      ok: code === 0 && Boolean(result) && result.is_error !== true && !reason,
      text,
      convId: noResume ? sessionId : (resume ?? sessionId),
      usage: {
        input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        output: usage.output_tokens ?? 0,
        costUsd: result?.total_cost_usd ?? 0,
      },
      error: killedError ?? (code === 0 ? undefined : (err.trim().slice(-600) || `claude exited ${code}`)),
      ...reason ? { reason } : {},
    }
  } finally {
    if (maxDurationTimer !== undefined) clearTimeout(maxDurationTimer)
  }
}

/** One image-generation turn against the relay; stores a PNG the page can show. */
async function runImage(member, prompt, config, options = {}) {
  const settings = apiSettings(config)
  // 成员选了 provider → 只认该 provider 的 baseURL/key（relay-image 之类）；
  // 没选 → 沿用页面里配置的 imageKey / codexBase（旧行为不变）。
  // ⚠️ provider 存在但解析不到时直接报错，**不**静默回落到 imageKey/codexBase：
  // 否则会拿着 A 的 key 去打 B 的地址，出图花了钱还找不到是哪条腿。
  let token = ''
  let base = ''
  if (member && member.provider) {
    let endpoint = null
    let reason = ''
    try {
      endpoint = await providerEndpoint(member.provider)
    } catch (error) {
      reason = String(error && error.message || error)
    }
    if (!endpoint || !endpoint.baseURL || !endpoint.key) {
      return {
        ok: false, text: '', usage: null,
        error: `出图 provider「${member.provider}」未取到 baseURL/key（${reason || 'provider 未注册或缺少 Authorization'}）`,
      }
    }
    // base 去掉结尾 /v1，下面统一拼 /v1/images/generations|edits
    token = endpoint.key
    base = rootUrl(endpoint.baseURL)
  } else {
    token = settings.imageKey
    base = rootUrl(settings.codexBase || defaultBase('openai', settings.imageKey))
  }
  if (!token) return { ok: false, text: '', error: 'no image api key configured', usage: null }
  const model = member.model || 'gpt-image-2.6-flare'
  // 出图是普通 HTTP 请求、没有流式输出，没法用「静默看门狗」；
  // 保留一个宽松的请求超时（默认 240s，config.imageTimeoutSeconds 可改）。
  const imageTimeoutMs = imageTimeoutSeconds(config) * 1000
  // 有参考图 → 走 /v1/images/edits（multipart），让模型以这张图为参考重绘
  const reference = options && options.reference
  if (reference) {
    try {
      const { readFile } = await import('node:fs/promises')
      const bytes = await readFile(reference)
      const form = new FormData()
      form.append('model', model)
      form.append('prompt', prompt)
      form.append('n', '1')
      form.append('size', '1024x1024')
      form.append('image', new Blob([bytes], { type: 'image/png' }), 'reference.png')
      const response = await fetch(base + '/v1/images/edits', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        body: form,
        signal: AbortSignal.timeout(imageTimeoutMs),
      })
      const data = await response.json()
      const b64 = data?.data?.[0]?.b64_json
      if (response.ok && b64) {
        const name = randomUUID() + '.png'
        await mkdir(IMAGE_DIR, { recursive: true })
        const file = path.join(IMAGE_DIR, name)
        await writeFile(file, Buffer.from(b64, 'base64'))
        return { ok: true, text: '已按参考图重绘（' + model + '）', image: '/council/api/image/' + name, file, usage: { input: 0, output: 0, costUsd: 0 } }
      }
      console.error('[council] images/edits failed, fallback to generations:', JSON.stringify(data).slice(0, 200))
    } catch (error) {
      console.error('[council] images/edits error, fallback:', String(error && error.message || error))
    }
  }
  try {
    const response = await fetch(base + '/v1/images/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024' }),
      signal: AbortSignal.timeout(imageTimeoutMs),
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

/**
 * 子代理活动指纹：仅统计 assistant 真实输出事件数。
 * 只有真正收到 assistant 消息/输出才算活动，纯 status 变化不刷新心跳。
 * 这样可以防止请求挂死时仍因 status 变化而刷新 lastActivity，导致看门狗永远不触发。
 */
function agentActivityStamp(agent) {
  if (!agent) return ''
  let count = 0
  try {
    if (agent.session) {
      const events = sessionEvents(agent.session)
      count = events.filter((e) => e && e.type === 'assistant/message').length
    }
  } catch { /* ignore */ }
  return String(count)
}

/** Continue an already-created child agent instead of spawning a new one. */
async function continueChild(ctx, parent, member, prompt, timeoutMs, callId, config, onActivity) {
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')
  if (!subagents || !agents || typeof subagents.sendMessage !== 'function') return null
  // 没有父 agent（例如页面「确认并分发」这条执行路径）时不能走 reuse：
  // sendMessage 的第一个参数是父 agent，缺了它内部会直接抛错。
  if (!parent) return null
  // signal 必须是真 AbortSignal：DSH 内部会调 signal.throwIfAborted()，
  // 传 undefined 会抛 "Cannot read properties of undefined (reading 'throwIfAborted')"。
  const signal = signalFor(callId) || new AbortController().signal
  try {
    await subagents.sendMessage(parent, member.convId, [{ type: 'text', text: prompt }], { signal })
  } catch (error) {
    console.error('[council] reuse sendMessage failed:', String((error && error.stack) || error))
    return null
  }
  // 显式预算（有界调用）仍按 deadline；成员调用（timeoutMs 未给）改用静默看门狗。
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : 0
  const idleMs = memberIdleMs(config)
  const watch = createIdleWatchdog({ idleTimeoutMs: idleMs })
  await new Promise((resolve) => setTimeout(resolve, 800))
  let lastStamp = ''
  while (true) {
    const now = Date.now()
    if (deadline && now >= deadline) return null
    const agent = agents.get(member.convId)
    const stamp = agentActivityStamp(agent)
    if (stamp !== lastStamp) {
      lastStamp = stamp
      watch.touch(now)
      if (onActivity) { try { onActivity() } catch { /* ignore */ } }
    }
    if (agent && agent.status === 'idle') {
      // 子代理已经交回结果：这不是「静默」，优先按完成处理。
      return readContinuedText(agent, member)
    }
    if (watch.tick(now) === 'idle-timeout') {
      return {
        ok: false,
        text: '',
        convId: member.convId,
        error: watchdogErrorText('idle-timeout', { idleMinutes: formatMinutes(idleMs) }),
        reason: 'idle-timeout',
        usage: null,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** 取「续跑这一轮」的全部 assistant 文本（跨多个 step 也不能只剩最后一段）。 */
function readContinuedText(agent, member) {
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

/**
 * 小组的 deepseek 成员默认跑在 **`deepseek-official`**（与主对话同一个官方 API）；
 * 若本地 profile 自建了第三方中转 provider（例如 `relay-deepseek`），可用
 * `config.deepseekProvider` 把成员切过去，主对话仍由 `agent-default-model` 指向官方，互不影响。
 *
 * - `deepseekMemberProvider(config)`：默认 `deepseek-official`（主对话同款官方 API）；`config.deepseekProvider` 可指向自建中转
 *   （或页面 /config 写在 state.config 里的同名字段）可覆盖。
 *   **不可用判定**：读 DSH `llm.listProviders()`。列表里没有首选 id → 回退
 *   `deepseek-official`（例如 profile patch 还没 HMR 进去 / 被禁用）。拿不到 llm 服务或
 *   列表为空（服务刚启动）时**不判死**，仍用首选 id —— 宁可乐观一次，也不要因为探测
 *   时机把小组静默降级到官方；真启动失败还有下面 seam 里的一次性回退兜底。
 * - `deepseekMemberModel(config, member, provider)`：默认 deepseek-v4.1-flash；成员的旧值
 *   `deepseek-flash` / `deepseek-v4-pro` 映射到新值；其它显式配置一律尊重。
 */
const DEEPSEEK_MEMBER_PROVIDER = 'deepseek-official'
const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official'
const DEEPSEEK_MEMBER_MODEL = 'deepseek-flash'
const DEEPSEEK_LEGACY_MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro'])
let deepseekProviderWarnedFor = ''

/** 验收未通过时是否”硬失败”（工具抛错）：默认 true，避免把未通过的结果当成交付物。 */
function failOnRejectedAcceptance(config) {
  const own = (state && state.config) || {}
  // 只认显式 true（页面开关/持久配置）；未设置即关闭，避免误伤
  if (own.failOnRejectedAcceptance !== undefined) return own.failOnRejectedAcceptance === true
  return Boolean(config && config.failOnRejectedAcceptance === true)
}

/** 页面 /config 的值优先于 profile 配置，与其它 council 设置一致。 */
function deepseekMemberSettings(config) {
  const own = (state && state.config) || {}
  const provider = String(own.deepseekProvider || (config && config.deepseekProvider) || DEEPSEEK_MEMBER_PROVIDER).trim()
  const model = String(own.deepseekModel || (config && config.deepseekModel) || DEEPSEEK_MEMBER_MODEL).trim()
  return {
    provider: provider || DEEPSEEK_MEMBER_PROVIDER,
    model: model || DEEPSEEK_MEMBER_MODEL,
  }
}

/** 当前进程里注册的 provider id 列表；拿不到（没有 llm 服务 / 列表为空）返回 null = 无法判定。 */
function liveProviderIds(ctx = ctx0) {
  try {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (!llm || typeof llm.listProviders !== 'function') return null
    const ids = (llm.listProviders() || [])
      .map((entry) => entry?.id ?? entry?.provider?.id)
      .filter(Boolean)
      .map(String)
    return ids.length ? ids : null
  } catch {
    return null
  }
}

function deepseekMemberProvider(config, ctx = ctx0) {
  const preferred = deepseekMemberSettings(config).provider
  // 直接返回配置值或默认 deepseek-official，不再预检 listProviders()；
  // 启动失败时由 runDeepseekViaSeam 的回退逻辑处理（已会换成 official + deepseek-flash）。
  return preferred
}

/**
 * 从 ctx.llm 或 profile YAML 读取 provider 的 baseURL 和 key。
 *
 * 优先级：
 * 1. ctx.get('llm')?.getProvider?.(id) 获取运行时 provider 信息
 * 2. 读取 ~/.dsh/profiles/web/cordis.patch.yml 解析 llm-pi-ai.config.providers.<id>
 *
 * @param {string} id - provider id
 * @param {object} [ctx] - DSH context
 * @returns {Promise<{baseURL: string, key: string} | null>}
 */
async function providerEndpoint(id, ctx = ctx0) {
  if (!id) return null

  // 优先从 ctx.llm 获取
  try {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm && typeof llm.getProvider === 'function') {
      const provider = llm.getProvider(id)
      if (provider) {
        const baseURL = provider.baseURL || provider.endpoint || provider.url
        const key = provider.apiKey || provider.key || provider.token
        if (baseURL && key) {
          return { baseURL: String(baseURL), key: String(key) }
        }
      }
    }
  } catch {
    // ctx.llm 不可用，继续尝试读取 profile
  }

  // 回退：读取 profile YAML
  for (const profileDir of PROFILE_CANDIDATES) {
    if (!profileDir) continue
    const yamlPath = path.join(profileDir, 'cordis.patch.yml')
    if (!existsSync(yamlPath)) continue

    try {
      const content = await readFile(yamlPath, 'utf8')
      const endpoint = parseProviderFromYaml(content, id)
      if (endpoint) return endpoint
    } catch {
      // 解析失败，继续下一个候选
    }
  }

  return null
}

/**
 * 简单的 YAML 解析：提取 llm-pi-ai.config.providers.<id> 的 baseURL 和 headers.Authorization。
 * 不依赖外部库，只处理本用例需要的嵌套路径。
 *
 * @param {string} content - YAML 文件内容
 * @param {string} providerId - provider id
 * @returns {{baseURL: string, key: string} | null}
 */
function parseProviderFromYaml(content, providerId) {
  try {
    const lines = content.split('\n')
    let inConfig = false
    let inProviders = false
    let inTargetProvider = false
    let configIndent = -1
    let providersIndent = -1
    let targetProviderIndent = -1
    let baseURL = null
    let key = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue

      // 计算缩进级别
      const indent = line.search(/\S/)
      if (indent < 0) continue

      // 查找 config: 节点（任意缩进层级）
      if (!inConfig && (trimmed === 'config:' || trimmed.startsWith('config:'))) {
        inConfig = true
        configIndent = indent
        continue
      }

      // 在 config 内查找 providers:
      if (inConfig && !inProviders) {
        // 如果缩进小于等于 config 缩进且不是 providers，说明已退出 config 块
        if (indent <= configIndent && trimmed !== 'config:' && trimmed !== 'providers:') {
          inConfig = false
          continue
        }

        if (trimmed === 'providers:' || trimmed.startsWith('providers:')) {
          inProviders = true
          providersIndent = indent
          continue
        }
      }

      // 在 providers 内查找目标 provider id
      if (inProviders && !inTargetProvider) {
        // 如果缩进小于等于 providers 缩进，退出 providers 块
        if (indent <= providersIndent) {
          inProviders = false
          continue
        }

        if (trimmed === `${providerId}:` || trimmed.startsWith(`${providerId}:`)) {
          inTargetProvider = true
          targetProviderIndent = indent
          continue
        }
      }

      // 在目标 provider 内提取 baseURL 和 Authorization
      if (inTargetProvider) {
        // 如果缩进小于等于 provider 缩进，退出当前 provider
        if (indent <= targetProviderIndent) {
          break
        }

        // 提取 baseURL
        const baseURLMatch = trimmed.match(/^baseURL:\s*(.+)/)
        if (baseURLMatch) {
          baseURL = baseURLMatch[1].replace(/^["']|["']$/g, '').trim()
          continue
        }

        // 检测 headers: 块
        if (trimmed === 'headers:' || trimmed.startsWith('headers:')) {
          const headersIndent = indent

          // 查找后续行的 Authorization
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j]
            const nextTrimmed = nextLine.trim()
            const nextIndent = nextLine.search(/\S/)

            if (nextIndent < 0 || !nextTrimmed || nextTrimmed.startsWith('#')) continue

            // 如果缩进小于等于 headers，退出 headers 块
            if (nextIndent <= headersIndent) break

            const authMatch = nextTrimmed.match(/^Authorization:\s*(.+)/)
            if (authMatch) {
              let authValue = authMatch[1].replace(/^["']|["']$/g, '').trim()
              // 折行写法：`Authorization: Bearer` 下一行缩进更深的 `sk-xxx`。
              // YAML 层这是两个 token（key 会变成空/`Bearer`）→ 请求 401，所以这里自己向下拼一行。
              if (authValue === 'Bearer') {
                let folded = ''
                for (let k = j + 1; k < lines.length; k++) {
                  const contLine = lines[k]
                  const contTrimmed = contLine.trim()
                  const contIndent = contLine.search(/\S/)
                  if (contIndent < 0 || !contTrimmed || contTrimmed.startsWith('#')) continue
                  // 只有缩进更深（continuation）才拼；否则放弃，避免把下一个字段当成 key（如 `compat:`）
                  if (contIndent > nextIndent) folded = contTrimmed.replace(/^["']|["']$/g, '')
                  break
                }
                // 折行 token 不能再含 `:`（那是下一个 YAML 字段，不是 key）
                if (folded && !folded.includes(':')) authValue = 'Bearer ' + folded
              }
              // 移除 "Bearer " 前缀（如果有）
              if (authValue.startsWith('Bearer ')) {
                authValue = authValue.slice(7).trim()
              }
              // 只剩 "Bearer"（折行但没拼到 token）= 没有 key，别让下游拼出 `Bearer Bearer`
              if (authValue === 'Bearer') authValue = ''
              key = authValue
              break
            }
          }
        }
      }
    }

    if (baseURL && key) {
      return { baseURL, key }
    }

    return null
  } catch {
    return null
  }
}

function deepseekMemberModel(config, member, provider) {
  const settings = deepseekMemberSettings(config)
  const effective = provider || DEEPSEEK_MEMBER_PROVIDER
  // 官方链路只认 deepseek-flash（显式别的也回落，避免拿官方打不存在的模型）
  if (effective === DEEPSEEK_OFFICIAL_PROVIDER) return 'deepseek-flash'
  // relay 链路用 v4.1-flash（config.deepseekModel 可覆盖）
  const relayModel = settings.model && settings.model !== 'deepseek-flash' ? settings.model : 'deepseek-v4.1-flash'
  const target = relayModel
  const explicit = String((member && member.model) || '').trim()
  if (!explicit) return target
  // 旧别名（deepseek-flash / deepseek-v4-pro）按当前链路换成语义正确的模型
  return DEEPSEEK_LEGACY_MODELS.has(explicit) ? target : explicit
}

/**
 * 一次性迁移（启动时跑，幂等）：所有 `kind === 'deepseek'` 成员换到
 * `deepseek-official` + `deepseek-flash`；`STAFF_MODELS.deepseek` 同步。
 *
 * **迁移策略**：
 * - 只迁移空配置、失效配置（deepseek-flash/deepseek-v4-pro）、或指向不存在链路的成员
 * - 保留用户显式配置的 provider（如自建中转 'relay-deepseek'）
 * - 只动 deepseek 成员与这条框架默认值：职位/其它框架/主会话默认模型都不碰。
 *
 * `agent-default-model` 在 profile patch 里独立配置，插件这边不会改它。
 * @returns {{members:number,total:number}}
 */
async function migrateDeepseekMembers() {
  STAFF_MODELS.deepseek = DEEPSEEK_MEMBER_MODEL
  let members = 0
  const liveProviders = liveProviderIds()
  const invalidLegacyProviders = new Set(['deepseek-flash', 'deepseek-v4-pro'])

  for (const member of state.members || []) {
    if (member?.kind !== 'deepseek') continue

    // 已经是目标配置，跳过
    if (member.provider === DEEPSEEK_MEMBER_PROVIDER && member.model === DEEPSEEK_MEMBER_MODEL) continue

    const currentProvider = String(member.provider || '').trim()

    // 白名单：明确保留的 provider（用户可能手配的，不迁移其模型）
    const preserveProviders = new Set(['relay-deepseek'])

    // 如果 provider 在白名单中，保留用户显式配置，不迁移
    if (preserveProviders.has(currentProvider)) continue

    // 其他情况都需要迁移到标准配置
    // 包括：空 provider、失效 provider、deepseek-official 的旧模型等

    member.provider = DEEPSEEK_MEMBER_PROVIDER
    member.model = DEEPSEEK_MEMBER_MODEL
    member.updatedAt = Date.now()
    members += 1
  }

  // 迁移职位（roles）
  let roles = 0
  for (const role of state.roles || []) {
    if (role?.kind !== 'deepseek') continue

    // 已经是目标配置，跳过
    if (role.model === DEEPSEEK_MEMBER_MODEL) continue

    const currentProvider = String(role.provider || '').trim()

    // 白名单：明确保留的 provider（用户可能手配的，不迁移其模型）
    const preserveProviders = new Set(['relay-deepseek'])

    // 如果 provider 在白名单中，保留用户显式配置，不迁移
    if (preserveProviders.has(currentProvider)) continue

    // 职位通常没有 provider 字段，直接迁移模型
    role.model = DEEPSEEK_MEMBER_MODEL
    role.updatedAt = Date.now()
    roles += 1
  }

  if (members || roles) {
    await save()
    ctx0?.logger?.('council')?.info?.(`deepseek migrated to ${DEEPSEEK_MEMBER_PROVIDER} / ${DEEPSEEK_MEMBER_MODEL}: ${members} member(s) + ${roles} role(s)`)
  }
  return { members, roles, total: members + roles }
}

async function runDeepseekViaSeam(ctx, member, prompt, config, parent, timeoutMs, presetId, callId, childSink, onActivity) {
  // 显式预算（有界调用）照旧；成员调用不再有总时长，靠下面的静默看门狗。
  const budgetMs = timeoutMs
  const idleMs = memberIdleMs(config)
  const subagents = ctx.get('subagents')
  if (!subagents || !parent) {
    return { ok: false, text: '', error: 'DSH subagent seam unavailable (no parent agent)', usage: null }
  }
  if (!subagents.getProvider('spawn')) {
    return { ok: false, text: '', error: 'spawn subagent provider is not registered', usage: null }
  }
  const reuseEnabled = Boolean((state.config && state.config.reuseAgents) || (config && config.reuseAgents) || member.__reuse)
  const reviewSlot = presetId === 'minimal'
  // 审核位（`__noResume`）一律全新子会话：不复用历史审核会话，也不续接成员自己的会话。
  if (!member.__noResume && reviewSlot && reuseEnabled && member.__reviewConvId) {
    member.convId = member.__reviewConvId
  }
  // `__continue`：截断续跑时即使没开 reuseAgents，也要接着同一个子会话跑（保住上下文）
  if ((reuseEnabled || member.__continue) && member.convId) {
    // 复用/续跑用的是既有子会话：它可能被 sendMessage 冷恢复，或清扫后又被复活，
    // 登记表里未必有它 → 补登记（不清零已有创建时间），否则它会变成清扫器看不见的孤儿驻留。
    if (reuseEnabled && !residentChildren.has(String(member.convId))) {
      const reusedKind = member.__residentKind || (presetId === 'minimal' ? 'review' : 'work')
      const reusedId = member.convId
      trackResidentChild(reusedId, reusedKind, {
        memberId: member.id,
        // 复用路径没有 activation 句柄了，用 subagent 服务自己的 drainChildren 释放
        dispose: () => (typeof subagents.drainChildren === 'function'
          ? subagents.drainChildren(parent, [reusedId])
          : Promise.reject(new Error('drainChildren unavailable'))),
      })
    }
    const reused = await continueChild(ctx, parent, member, prompt, budgetMs, callId, config, onActivity)
    // truncated 原样带出（ok 仍按是否有文本算），由 runDeepseekWithContinuation 决定续跑
    if (reused) return reused
    // 续跑请求拿不到原子会话就停：不要拿「继续未完成的部分」去开一个全新的子会话（上下文已丢）
    if (member.__continue) {
      return { ok: false, text: '', error: '续跑失败：原子会话不可用（未产出新内容）', usage: null }
    }
  }
  // 深寻 seam 的看门狗：把「子代理状态 / 已提交消息数变化」当活动信号；
  // 只按静默判死（不再有总时长 kill）。取消仍走 activeCalls 的 controller。
  let childId = null
  let idleFired = false
  let timedOut = false
  let cancelled = false
  let maxDurationFired = false
  let lastSeamStamp = ''
  const controller = new AbortController()
  const cancelSignal = signalFor(callId)
  const activationSignal = cancelSignal ? AbortSignal.any([controller.signal, cancelSignal]) : controller.signal
  // 监听取消信号：立即 resolve 并标记 cancelled
  if (cancelSignal && !cancelSignal.aborted) {
    cancelSignal.addEventListener('abort', () => { cancelled = true }, { once: true })
  }
  // 显式预算（审校等有界调用）才设总计时；成员调用没有总时长，只有静默看门狗。
  const budgetTimer = Number.isFinite(budgetMs) && budgetMs > 0
    ? setTimeout(() => { timedOut = true; try { controller.abort() } catch { /* ignore */ } }, budgetMs)
    : undefined
  // 单次调用硬上限：独立 timer，到期时 abort
  const maxMs = memberMaxMinutesMs(config)
  const maxDurationTimer = maxMs > 0
    ? setTimeout(() => { maxDurationFired = true; try { controller.abort() } catch { /* ignore */ } }, maxMs)
    : undefined
  const seamAgents = ctx.get('agents')
  // 只有能观察到子代理（agents.get）时才做静默判定；观察不到就退化成只等结果，
  // 宁可少杀一次，也不要把正在干活的长任务误杀。
  const canObserve = Boolean(seamAgents && typeof seamAgents.get === 'function')
  const watchdog = createIdleWatchdog({ idleTimeoutMs: idleMs })
  const watchTimer = setInterval(() => {
    if (!canObserve) return
    const now = Date.now()
    let agent
    try {
      agent = childId ? seamAgents.get(childId) : undefined
    } catch { /* ignore */ }
    const stamp = agentActivityStamp(agent)
    if (stamp !== lastSeamStamp) {
      lastSeamStamp = stamp
      watchdog.touch(now)
      if (onActivity) { try { onActivity() } catch { /* ignore */ } }
    }
    if (watchdog.tick(now) === 'idle-timeout') {
      idleFired = true
      try { controller.abort() } catch { /* ignore */ }
    }
  }, WATCHDOG_TICK_MS)
  // 成员该用哪个 provider/model：优先级 = member.provider → providerByKind[kind] → 旧 key 字段 → 默认
  const providerByKind = (state.config && state.config.providerByKind) || {}
  let provider = member.provider || providerByKind[member.kind] || deepseekMemberProvider(config, ctx)
  let model = deepseekMemberModel(config, member, provider)
  // 回执/日志要能看出**实际**走的是哪条链路（主会话与小组不是同一个 provider）。
  try { ctx0?.logger?.('council')?.info?.(`deepseek member "${member.name}" → ${provider} / ${model}`) } catch { /* ignore */ }
  const idleResult = () => ({
    ok: false,
    text: '',
    convId: childId ?? member.convId,
    error: watchdogErrorText('idle-timeout', { idleMinutes: formatMinutes(idleMs) }),
    reason: 'idle-timeout',
    provider,
    model,
    usage: null,
  })
  const timeoutResult = () => ({
    ok: false,
    text: '',
    convId: childId ?? member.convId,
    error: watchdogErrorText('timeout'),
    reason: 'timeout',
    provider,
    model,
    usage: null,
  })
  const maxDurationResult = () => ({
    ok: false,
    text: '',
    convId: childId ?? member.convId,
    error: watchdogErrorText('max-duration', { maxMinutes: formatMinutes(maxMs) }),
    reason: 'max-duration',
    provider,
    model,
    usage: null,
  })
  const cancelledResult = () => ({
    ok: false,
    text: '',
    convId: childId ?? member.convId,
    error: '已取消',
    reason: 'cancelled',
    provider,
    model,
    usage: null,
  })
  const startSeam = (providerId, modelId, includeReasoningEffort = true) => subagents.startActivation({
    provider: 'spawn',
    label: member.name,
    request: {
      prompt: Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }],
      parent,
      ...presetId === undefined ? {} : { agentPreset: presetId },
      cwd: member.cwd || config.defaultWorkspace || process.cwd(),
      agentOptions: {
        provider: providerId,
        model: modelId,
        // reviews only need a verdict: drop the default high reasoning effort
        // 只有 deepseek-official 才支持 reasoningEffort；其它 provider（如 relay-deepseek）不传
        ...presetId === 'minimal' && includeReasoningEffort && providerId === DEEPSEEK_OFFICIAL_PROVIDER ? { reasoningEffort: 'low' } : {},
      },
    },
    signal: activationSignal,
    delivery: 'caller',
  })
  try {
    let activation
    let reasoningEffortRetried = false
    try {
      activation = await startSeam(provider, model, true)
    } catch (error) {
      const errorMsg = String(error?.message ?? error)
      // 第一层：捕获 UNSUPPORTED_REASONING_EFFORT，去掉 reasoningEffort 重试一次（同 provider/model）
      if (!reasoningEffortRetried && errorMsg.includes('UNSUPPORTED_REASONING_EFFORT')) {
        console.error('[council] seam retry-without-effort:', provider, model, errorMsg)
        try { ctx0?.logger?.('council')?.info?.(`deepseek provider "${provider}" does not support reasoningEffort; retrying without it`) } catch { /* ignore */ }
        reasoningEffortRetried = true
        try {
          activation = await startSeam(provider, model, false)
        } catch (retryError) {
          // 去掉 reasoningEffort 后仍失败 → 回退到 deepseek-official（如果还没用官方）
          if (idleFired || timedOut || maxDurationFired || provider === DEEPSEEK_OFFICIAL_PROVIDER) throw retryError
          const retryMsg = String(retryError?.message ?? retryError)
          console.error('[council] seam fallback:', provider, model, retryMsg)
          try { ctx0?.logger?.('council')?.warn?.(`deepseek provider "${provider}" failed after removing reasoningEffort (${retryMsg}); retrying with ${DEEPSEEK_OFFICIAL_PROVIDER}`) } catch { /* ignore */ }
          provider = DEEPSEEK_OFFICIAL_PROVIDER
          model = 'deepseek-flash'
          activation = await startSeam(provider, model, true)
        }
      } else {
        // 第二层：不是 UNSUPPORTED_REASONING_EFFORT（profile 里没注册该 provider / adapter 起不来）
        // → 直接用 DeepSeek 官方再开一次（只在「启动阶段」失败时回退；看门狗/取消不重试）
        if (idleFired || timedOut || maxDurationFired || provider === DEEPSEEK_OFFICIAL_PROVIDER) throw error
        console.error('[council] seam fallback:', provider, model, errorMsg)
        try { ctx0?.logger?.('council')?.warn?.(`deepseek provider "${provider}" failed to start (${errorMsg}); retrying with ${DEEPSEEK_OFFICIAL_PROVIDER}`) } catch { /* ignore */ }
        provider = DEEPSEEK_OFFICIAL_PROVIDER
        model = 'deepseek-flash'
        activation = await startSeam(provider, model, true)
      }
    }
    childId = activation.childId ?? null
    // 先登记再等结果：即使子会话失败/被取消，本轮清理也要能回收它的目录
    if (childSink && typeof childSink.add === 'function' && activation.childId) childSink.add(activation.childId)
    // 可插话：把父会话的新指示直接送进这个子会话（deepseek 腿支持实时插话）
    let steerCleanup = null
    try {
      const seamSubagents = ctx && typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
      if (callId && childId && seamSubagents && typeof seamSubagents.sendMessage === 'function') {
        steerCleanup = registerSteerTarget(callId, member.id || member.name, {
          memberName: member.name,
          kind: 'deepseek',
          write: async (text) => {
            await seamSubagents.sendMessage(parent, childId, [{ type: 'text', text: String(text) }], {})
            return true
          },
        })
      }
    } catch { /* ignore */ }
    // 被 max-tokens / max-turns 截断时不能 dispose：续跑要接着这个子会话。
    let keepChild = reuseEnabled
    // 只有「正常拿到结果且决定保留」才登记为驻留（抛错路径不登记，清理交给调用方）
    let keepResident = false
    let degraded = false
    try {
      const result = await activation.result
      if (maxDurationFired) { keepChild = false; return maxDurationResult() }
      if (idleFired) { keepChild = false; return idleResult() }
      if (timedOut) { keepChild = false; return timeoutResult() }
      const text = (result.output || [])
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      const stopReason = String(result.stopReason || '')
      const truncated = TRUNCATED_STOP_REASONS.has(stopReason)
      // relay 账号池耗尽/上游错误 → 自动降级 deepseek-official 重跑一次
      // 触发条件：stopReason='error' 且非官方 provider → 直接降级（不依赖 text）
      const needsDegrade = stopReason === 'error' && provider !== DEEPSEEK_OFFICIAL_PROVIDER
      if (needsDegrade) {
        // 日志细节：优先用 diagnostic，其次 text 里的 error 片段，最后用 stopReason
        const degradeReason = result.diagnostic
          || text.match(/error[^}]*/i)?.[0]
          || `stop: ${stopReason}`
        console.error('[council] seam degrade:', provider, model, degradeReason)
        try { ctx0?.logger?.('council')?.warn?.(`deepseek provider "${provider}" failed with ${stopReason} (${degradeReason}); degrading to ${DEEPSEEK_OFFICIAL_PROVIDER}`) } catch { /* ignore */ }
        // 降级：先 dispose 原 activation，用官方重跑（不改成员配置，只本次生效）
        try { await activation.dispose() } catch { /* ignore */ }
        const officialProvider = DEEPSEEK_OFFICIAL_PROVIDER
        const officialModel = 'deepseek-flash'
        activation = await startSeam(officialProvider, officialModel, presetId === 'minimal')
        childId = activation.childId ?? null
        if (childSink && typeof childSink.add === 'function' && activation.childId) childSink.add(activation.childId)
        const officialResult = await activation.result
        const officialText = (officialResult.output || [])
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
        const officialStopReason = String(officialResult.stopReason || '')
        const officialTruncated = TRUNCATED_STOP_REASONS.has(officialStopReason)
        keepChild = reuseEnabled || officialTruncated
        keepResident = keepChild && Boolean(childId)
        degraded = true
        provider = officialProvider
        model = officialModel
        return {
          ok: Boolean(officialText) && !officialTruncated && officialStopReason === 'completed',
          text: officialText,
          convId: activation.childId,
          error: officialText ? undefined : ('stop: ' + officialResult.stopReason + (officialResult.diagnostic ? ' · ' + officialResult.diagnostic : '')),
          ...officialTruncated ? { truncated: true, stopReason: officialStopReason } : {},
          provider: officialProvider,
          model: officialModel,
          degraded: `relay 不可用（${degradeReason}），本次已改用官方 deepseek-flash`,
          usage: null,
        }
      }
      keepChild = reuseEnabled || truncated
      keepResident = keepChild && Boolean(childId)
      return {
        ok: Boolean(text) && !truncated && stopReason === 'completed',
        text,
        convId: activation.childId,
        error: text ? undefined : ('stop: ' + result.stopReason + (result.diagnostic ? ' · ' + result.diagnostic : '')),
        ...truncated ? { truncated: true, stopReason } : {},
        provider,
        model,
        usage: null,
      }
    } catch (error) {
      if (cancelled) { keepChild = false; return cancelledResult() }
      if (maxDurationFired) { keepChild = false; return maxDurationResult() }
      if (idleFired) { keepChild = false; return idleResult() }
      if (timedOut) { keepChild = false; return timeoutResult() }
      throw error
    } finally {
      if (steerCleanup) { try { steerCleanup() } catch { /* ignore */ } steerCleanup = null }
      // keep the child resident when reuse is enabled (or when it must be continued)
      if (!keepChild) {
        try { await activation.dispose() } catch { /* already gone */ }
        untrackResidentChild(childId)
        // dispose 之后顺手删掉这个**我们自己创建**的子会话目录：
        // DSH 的「N 个子智能体」数的是 `subagent/catalog` 记录，不删记录计数就只增不减。
        // 两条硬性跳过：
        //   ① reuse 模式不删 —— 这个子会话 id 马上会被调用方写回 `member.convId`，
        //      成员下一轮要接着它续聊（删了就断上下文）；
        //   ② `deleteChildSessionDir` 内部再挡一层：父会话对不上 / 命中任何成员 convId /
        //      审校子会话 / 活跃 agent / 驻留表 → 一律不删。
        if (!reuseEnabled) {
          await deleteChildSessionDir(ctx, childId, {
            parentSession: parentIdOf(parent),
            extraKeep: member.convId ? [member.convId] : [],
          })
        }
      } else if (keepResident) {
        // 登记用途：minimal preset = 审核位（10 分钟清扫），其余 = 干活的成员（30 分钟 + 失联才清扫）；
        // `__residentKind` 只给「指挥拆解」这种 minimal 但需要跨轮保留的线程用。
        trackResidentChild(childId, member.__residentKind || (presetId === 'minimal' ? 'review' : 'work'), {
          memberId: member.id,
          dispose: () => activation.dispose(),
        })
      }
    }
  } catch (error) {
    if (cancelled) return cancelledResult()
    if (maxDurationFired) return maxDurationResult()
    if (idleFired) return idleResult()
    if (timedOut) return timeoutResult()
    return { ok: false, text: '', error: 'subagent failed: ' + String(error?.message ?? error), provider, model, usage: null }
  } finally {
    clearInterval(watchTimer)
    if (budgetTimer !== undefined) clearTimeout(budgetTimer)
    if (maxDurationTimer !== undefined) clearTimeout(maxDurationTimer)
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
async function runDeepseekWithContinuation(ctx, member, prompt, config, parent, timeoutMs, callId, childSink, seam = runDeepseekViaSeam, onActivity) {
  const first = await seam(ctx, member, prompt, config, parent, timeoutMs, member.__preset, callId, childSink, onActivity)
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
    const next = await seam(ctx, Object.assign({}, member, { __continue: true }), nextPrompt, config, parent, timeoutMs, member.__preset, callId, childSink, onActivity)
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
  const provider = member.provider || deepseekMemberProvider(config, ctx)
  const agentOptions = {
    provider,
    model: deepseekMemberModel(config, member, provider),
  }
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
  const configured = state.members.find((m) => m.id === group.reviewerId)
  const claudeMember = state.members.find((m) => inGroup(m) && m.kind === 'claude')
  // 图片审核必须用能 Read 文件的 claude 腿：配置的审校不是 claude 时改选组内 claude 成员
  const reviewer = configured && configured.kind === 'claude' ? configured : claudeMember
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
  const env = await envFor(reviewer || { kind: 'claude' }, config)
  // 审核看图也是旁路：`noResume: true` → 绝不追加 --resume（旧会话已死时只会拿到问候）
  const ask = (text) => runClaude({
    cwd: group.workspacePath || config.defaultWorkspace || process.cwd(),
    model: reviewer.model,
    prompt: text,
    env,
    noResume: true,
  })
  const parse = (review) => {
    const match = String((review && review.text) || '').match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      const value = JSON.parse(match[0])
      return { ok: value.ok === true, reason: String(value.reason ?? '') }
    } catch { return null }
  }
  let review = await ask(prompt)
  let parsed = parse(review)
  let retried = false
  if (!parsed && (looksLikeGreeting(review && review.text) || (review && review.ok))) {
    retried = true
    console.error('[council] reviewImage ' + (looksLikeGreeting(review && review.text) ? '疑似问候/空炮' : '输出无法解析')
      + '，换新会话（无 resume）重试 · 首次原文=' + reviewRawSnippet(review && review.text))
    review = await ask(prompt + REVIEW_JSON_NOTE)
    parsed = parse(review)
    console.error('[council] reviewImage 重试' + (parsed ? '成功' : '仍失败') + ' · 重试原文=' + reviewRawSnippet(review && review.text))
  }
  const verdict = parsed
    ?? (retried || (review && review.ok) ? { ok: false, reason: REVIEW_UNPARSED_REASON } : { ok: false, reason: (review && review.error) || '审校失败' })
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
async function ensureCodexHome(config, override) {
  const settings = apiSettings(config)
  const key = (override && override.key) || settings.codexToken || await codexToken()
  const base = rootUrl((override && override.base) || settings.codexBase) || rootUrl(await codexCliBase())
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

/** 成员默认 provider（页面配置的 providerByKind[kind] 或成员自带）。 */
function providerIdFor(member) {
  const byKind = (state.config && state.config.providerByKind) || {}
  return (member && (member.provider || byKind[member.kind])) || ''
}

/** 成员 provider 对应的 base/key（来自 DSH 设置/ profile）；没有 provider 时返回 null。 */
async function memberEndpoint(member, config) {
  const id = providerIdFor(member)
  if (!id) return null
  const endpoint = await providerEndpoint(id)
  return endpoint ? Object.assign({ provider: id }, endpoint) : null
}

async function envFor(kindOrMember, config) {
  const member = kindOrMember && typeof kindOrMember === 'object' ? kindOrMember : { kind: kindOrMember }
  const endpoint = await memberEndpoint(member, config).catch(() => null)
  if (endpoint && member.kind === 'claude') {
    return Object.assign({ ANTHROPIC_BASE_URL: rootUrl(endpoint.baseURL) || undefined, ANTHROPIC_API_KEY: endpoint.key || undefined }, proxyEnv(config))
  }
  if (endpoint && member.kind === 'codex') {
    const home = await ensureCodexHome(config, { base: endpoint.baseURL, key: endpoint.key })
    return Object.assign({}, home ? { CODEX_HOME: home } : {}, proxyEnv(config))
  }
  return envForLegacy(member.kind, config)
}

async function envForLegacy(kind, config) {
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

/**
 * 问候 / 空炮识别：claude 在「已死/空上下文」的旧会话上 `--resume` 时不答题，
 * 只回一句 `I'm here and ready to help.` / `How can I help you?` / `你希望我做什么？`。
 * 这类输出长度都在一两百字符以内，而且**永远不含 JSON 结论** —— 所以调用方只在
 * verdictOf() 拿不到结论时才用它，避免误伤「reason 里恰好带了这句话」的正常 JSON。
 */
const GREETING_PATTERNS = [
  /ready to help/i,
  /how can i help/i,
  /what would you like/i,
  /what can i do for you/i,
  /let me know what you/i,
  /你希望我/,
  /请告诉我/,
  /有什么可以帮/,
  /有什么需要/,
  /需要我做什么/,
  /我能帮你/,
]
function looksLikeGreeting(text) {
  const raw = String(text ?? '').trim()
  if (!raw || raw.length >= 200) return false
  return GREETING_PATTERNS.some((re) => re.test(raw))
}

/** 审核重试用语：明确要求只回 JSON（全新会话里没有历史上下文，必须自带指令）。 */
const REVIEW_JSON_NOTE = '\n\n注意：只输出 JSON，不要任何解释或前后缀。'
/** 审核输出无法解析时的兜底理由（不再产出「未判定」）。 */
const REVIEW_UNPARSED_REASON = '审核输出无法解析（已重试）'

/** 截断到 200 字符用于日志（去掉换行，便于一行对账）。 */
function reviewRawSnippet(text) {
  return JSON.stringify(String(text || '').replace(/\s+/g, ' ').slice(0, 200))
}

/**
 * 审核调用统一入口（审校 / 自审 / 指挥文本审核 / 指挥看图 / 看图审校都走这里）。
 *
 * 三条硬规则：
 *  ① **绝不续接历史会话**：成员 convId 一律置空 + `__noResume`（runClaude 不追加 --resume）。
 *     审核是旁路；续接「已死/空上下文」的旧会话只会拿到问候。
 *  ② 输出命中问候/空炮 → 丢掉本次结果，**强制新会话重试一次**（仍无 resume）。
 *  ③ 重试后仍解析不出 JSON → verdict 归一为 `{ok:false}`（不再产出 `unverified`/「未判定」）。
 *
 * 返回 `{ verdict, result, parsed, retried }`：verdict 恒为 `{ok:boolean, reason}`（不会 ok:null），
 * `result` 是最后一次调用的原始结果（调用方据此判失败原因）。
 */

/** 把本地图片发布为 DSH attachment，组装成 [image, text] 多模态 prompt；失败返回 null。 */
async function imagePromptParts(ctx, file, text) {
  try {
    const { readFile } = await import('node:fs/promises')
    const store = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
    if (!store || typeof store.saveImages !== 'function' || !file) return null
    const bytes = await readFile(file)
    const lower = String(file).toLowerCase()
    const mediaType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
    const refs = await store.saveImages([{ data: new Uint8Array(bytes), mediaType, name: 'review' }])
    const ref = refs && refs[0]
    if (!ref) return null
    return [{ type: 'image', attachment: ref }, { type: 'text', text }]
  } catch (error) {
    console.error('[council] imagePromptParts failed:', String(error && error.message || error))
    return null
  }
}

/** 数组型 prompt 追加一段文本（重试时用）。 */
function appendPromptText(prompt, extra) {
  if (!Array.isArray(prompt)) return prompt + extra
  return prompt.concat([{ type: 'text', text: extra }])
}

async function runReviewTurn(ctx, member, prompt, config, group, styleOverride, parent, timeoutMs, callId, label) {
  const clean = () => Object.assign({}, member, { convId: undefined, __noResume: true })
  let result = await runKind(ctx, clean(), prompt, config, group, styleOverride, parent, timeoutMs, callId)
  let raw = String(result && result.text || '')
  let parsed = verdictOf(raw)
  let retried = false
  // 只有「拿不到 JSON 结论」时才看问候：正常 JSON 的 reason 里出现这些词不受影响。
  if (parsed === null && (looksLikeGreeting(raw) || (result && result.ok))) {
    const why = looksLikeGreeting(raw) ? '疑似问候/空炮（旧会话不答题）' : '输出无法解析'
    retried = true
    console.error('[council] ' + label + ' ' + why + '，换新会话（无 resume）重试 · 首次原文=' + reviewRawSnippet(raw))
    result = await runKind(ctx, clean(), appendPromptText(prompt, REVIEW_JSON_NOTE), config, group, styleOverride, parent, timeoutMs, callId)
    raw = String(result && result.text || '')
    parsed = verdictOf(raw)
    console.error('[council] ' + label + ' 重试' + (parsed ? '成功' : '仍失败') + ' · 重试原文=' + reviewRawSnippet(raw))
  }
  let verdict
  if (parsed) verdict = parsed
  else if (!retried && result && result.ok === false) verdict = { ok: false, reason: String(result.error || '') || (label + '调用失败') }
  else verdict = { ok: false, reason: REVIEW_UNPARSED_REASON }
  return { verdict, result, parsed: Boolean(parsed), retried }
}

/** One turn on the member's own framework, preserving its session and tools. */
let runKindOverride = null

/** 测试可替换的成员执行器入口；生产环境恒走 runKindImpl。 */
function runKind(ctx, member, prompt, config, group, styleOverride, parent, timeoutMs, callId, childSink, onActivity) {
  return (runKindOverride || runKindImpl)(ctx, member, prompt, config, group, styleOverride, parent, timeoutMs, callId, childSink, onActivity)
}

async function runKindImpl(ctx, member, prompt, config, group, styleOverride, parent, timeoutMs, callId, childSink, onActivity) {
  await applyProxy(config)
  const cwd = member.cwd || config.defaultWorkspace || process.cwd()
  // 成员调用不再有总时长预算（timeoutMs 只在审校等有界调用里显式给）；
  // 终止交给 run() / seam 的静默看门狗。
  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined
  const idleMs = memberIdleMs(config)
  const hardLimitMs = memberMaxMinutesMs(config)
  const maxDurationMs = memberMaxMinutesMs(config)
  let result
  if (member.kind === 'image') {
    const style = String(styleOverride || (group && group.style) || '')
    const imagePrompt = style ? `[统一风格规范]\n${style}\n\n[画面]\n${prompt}` : prompt
    result = await runImage(member, imagePrompt, config, { reference: member.__reference })
  } else if (member.kind === 'deepseek') {
    // max-tokens / max-turns 截断时在同一个子会话里续跑（最多 MEMBER_CONTINUE_LIMIT 次）
    result = await runDeepseekWithContinuation(ctx, member, prompt, config, parent, budgetMs, callId, childSink, undefined, onActivity)
  } else {
    if (member.kind === 'claude') {
      const endpoint = await memberEndpoint(member, config).catch(() => null)
      const cfgCheck = apiSettings(config)
      const hasBase = Boolean(endpoint && endpoint.baseURL) || Boolean(cfgCheck.claudeBase)
      const hasKey = Boolean(endpoint && endpoint.key) || Boolean(cfgCheck.claudeKey)
      if (!hasBase || !hasKey) {
        return { ok: false, text: '', error: '未配置 claude 的 API 地址或密钥（在「小组」页 ① 选一个 provider，或填 claude base URL + key）' }
      }
    }
    const runner = member.kind === 'claude' ? runClaude : runCodex
    result = await runner({
      cwd,
      model: member.model || undefined,
      // `__noResume`（审核调用）：强制全新会话，不追加 --resume
      resume: member.__noResume ? undefined : (member.convId || undefined),
      noResume: Boolean(member.__noResume),
      prompt,
      env: await envFor(member, config),
      noTools: Boolean(member.__noTools),
      // 审核调用不插话（__noTools 且 minimal）；工作成员可实时插话
      // claude CLI 的 --input-format stream-json 在 stdin 常开时会等 EOF（实测挂住），
      // 所以 claude 腿暂不实时插话；deepseek 腿的插话走 seam 的 sendMessage，不受影响。
      // 3D/建模类成员保留 MCP（要 Blender 工具）；其它成员关闭 MCP，避免工具表膨胀/启动卡住
      allowMcp: /建模|材质|3D/i.test(String(member.name || '') + ' ' + String((roleOf(member) || {}).name || '')),
      steerable: false,
      callId,
      signal: signalFor(callId, member && member.id),
      timeoutMs: budgetMs,
      idleMs,
      hardLimitMs,
      maxDurationMs,
      onActivity,
      memberName: member.name,
      config,
    })
  }
  if (result.convId) member.convId = result.convId
  if (result.usage) account(member.id, result.usage)
  return result
}

/**
 * Stage one: the producing agent reviews its own output.
 * ⚠️ 审核不续接历史会话：即使自审过去「在成员自己的会话里跑」，那个会话一旦已死/空上下文，
 * `--resume` 只会换来一句问候。所以这里传的是**成员副本**（convId 清空 + `__noResume`），
 * 既不复用它的线程，也不会把审核子会话写回 `member.convId`。
 */
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
  const { verdict } = await runReviewTurn(ctx, member, prompt, config, group, undefined, parent, undefined, callId, 'selfReview')
  verdict.by = member.name
  return verdict
}

/** Preliminary check by the member holding the 审校 role. */
async function prelimReview(ctx, group, member, task, output, config, styleOverride, parent, brief, callId) {
  const reviewer = memberWithRole(group, '审校')
  if (!reviewer) return null
  if (output && output.image) {
    // 1) 先让「配置的审校」自己看图（deepseek 也有视觉能力）：把图片作为多模态块塞进审核请求。
    const imageText = [
      '你是这个小组的审校，做初步校验。下面这张图就是成员的产出，请**实际看图**后判断，不要凭文字推测。',
      '禁止使用任何工具（bash / read / 搜索等），图片已经附在消息里。',
      ...(brief ? ['[背景]', brief, ''] : []),
      `成员 ${member.name}（${member.kind}）完成了任务：${task}`,
      '请逐条对照任务要求检查画面里到底有没有，只输出一个 JSON：{"ok":true 或 false,"reason":"不超过 60 字"}',
    ].join('\n')
    const parts = output.file ? await imagePromptParts(ctx, output.file, imageText) : null
    if (parts) {
      const { verdict } = await runReviewTurn(
        ctx, Object.assign({}, reviewer, { __preset: 'minimal', __noTools: true }),
        parts, config, group, styleOverride, parent, 120_000, callId, 'prelimReview(image)',
      )
      if (verdict) { verdict.by = reviewer.name; verdict.sawImage = true; return verdict }
    }
    // 2) 拿不到多模态块时，退回 claude 腿 Read 图片
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
  // 审核位一律全新会话（不再复用 state.reviewChildren / __reviewConvId）：见 runReviewTurn。
  const { verdict } = await runReviewTurn(
    ctx, Object.assign({}, reviewer, { __preset: 'minimal', __noTools: true }),
    prompt, config, group, undefined, parent, 120_000, callId, 'prelimReview',
  )
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
    // 审核是旁路：不强制保留子会话，也不续接指挥自己的旧会话（见 runReviewTurn）。
    const { verdict } = await runReviewTurn(
      ctx, commanderMember, imagePrompt, config, group, styleOverride, parent, 120_000, callId, 'commanderReview(image)',
    )
    verdict.by = commanderMember.name
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
    // 审核不强制保留子会话（`__reuse` 会让 keepChild 恒为 true，审核子会话就永久驻留）。
    const { verdict } = await runReviewTurn(
      ctx, Object.assign({}, commanderMember, { __preset: 'minimal', __noTools: true }),
      prompt, config, group, undefined, parent, 120_000, callId, 'commanderReview',
    )
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
    `补员/换模型时按「模型定位速查」选；一个任务只用一个主力模型；${MODEL_GUIDE_TIEBREAK}。`,
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
  // 拆解是「指挥自己的工作线程」（`commander.convId` 会写回、下一轮接着用），所以：
  //   ① 不再强制 `__reuse`——页面没开「复用子会话」时，这一次性子会话用完即弃；
  //   ② 页面开了复用才把子会话写回，避免留下指向已释放子会话的死 convId；
  //   ③ 保留下来时按 work 登记（清扫器只在「指挥不指向它」时回收）。
  const reuseChildren = Boolean((state.config && state.config.reuseAgents) || (config && config.reuseAgents))
  const commanderOpts = { convId: commander.convId, __preset: 'minimal', __noTools: true, __residentKind: 'work' }
  const planned = await runKind(ctx, Object.assign({}, commander, commanderOpts), prompt + cdigest, config, group, undefined, parent, undefined, callId)
  if (planned && planned.convId && reuseChildren) { commander.convId = planned.convId; save().catch(() => {}) }
  const plan = parsePlan(planned.text)
  return {
    assignments: plan ? plan.assignments : [],
    staffing: plan ? plan.staffing : [],
    raw: planned.text || planned.error || '',
    error: planned.ok ? undefined : (planned.error || '指挥调用失败'),
  }
}

/** 成员终态：onStage 与进度条一起写；`finishedAt` 一落，前端就不再显示「静默 Ns」。 */
function finishMemberStage(callId, member, onStage, stage) {
  if (onStage) onStage(stage)
  if (callId) progressSet(callId, member.id, { finishedAt: Date.now(), stage })
}

/** 终态文案里的原因：压成一行并截短（进度条只有一行可放）。 */
function shortStageText(value, max = 48) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

/* ── 验收结论（结构化字段 + 回执硬标记） ─────────────────────────────────────
 * 一次 council_delegate 只有一个回执，所以验收结论是「整次调用」级别的；
 * 成员级的原始 acceptance 仍留在 members[].acceptance
 * （none / passed / rejected / rework-failed / unverified / skipped / cancelled）。
 *
 * 现场事故：2.5D 会话的回执末尾明明写着「## 验收（小组）验收未通过」，父会话却继续往下跑，
 * 把它当成果报给了用户。所以「验收没通过」必须同时出现在
 * ①回执第一行（模型最先读到的字）和 ②结构化字段 acceptanceStatus（程序/父会话都能判断），
 * 两处同源（都由 summarizeAcceptance 得出）。
 */

/** 回执里允许出现的验收状态（与 output schema 的 enum 一致）。 */
const ACCEPTANCE_STATUSES = ['passed', 'rejected', 'rework-failed', 'unverified', 'none']
/** 只有这三种算「未通过验收」——回执顶部必须打 ⛔ 硬标记。 */
const ACCEPTANCE_BLOCKED = new Set(['rejected', 'rework-failed', 'unverified'])

/**
 * 成员 acceptance → 回执状态。
 * skipped（成员根本没产出）/ cancelled（被用户停止）都不能算通过：一律按未通过上报，
 * 否则父会话又能把「什么都没交付」当成果。返回 'none' 只表示本组没有审核位。
 */
function acceptanceStatusOf(acceptance) {
  if (acceptance === 'passed') return 'passed'
  if (acceptance === 'rejected') return 'rejected'
  if (acceptance === 'rework-failed') return 'rework-failed'
  if (acceptance === 'unverified') return 'unverified'
  if (acceptance === 'skipped' || acceptance === 'cancelled') return 'rejected'
  return 'none'
}

/** 返工轮次：review.attempts = 1 + 返工次数（callMemberImpl 里先记次数再跑返工）。 */
function reworkRoundsOf(member) {
  const attempts = Number((member && member.review && member.review.attempts) || (member && member.attempts) || 1)
  return Number.isFinite(attempts) && attempts > 1 ? Math.floor(attempts) - 1 : 0
}

/** 成员名单（最多三个 + 等）。 */
function memberNamesOf(list) {
  const names = [...new Set((list || []).map((m) => String((m && m.name) || '成员')))]
  return names.length > 3 ? names.slice(0, 3).join('、') + ' 等' : names.join('、')
}

/** 成员条目的验收状态：连跑都没跑起来的（member not found 等）也绝不算通过。 */
function acceptanceStatusOfMember(member) {
  const status = acceptanceStatusOf(member && member.acceptance)
  return status === 'none' && member && member.ok === false ? 'rejected' : status
}

/**
 * 汇总整次调用的验收结论：rework-failed > rejected > unverified > passed > none。
 * 返回 { acceptanceStatus, acceptanceNote, acceptanceRounds }；note 是一句中文，
 * 与回执顶部 ⛔ 提示、结尾「## 验收（本次调用）」是同一个结论。
 */
function summarizeAcceptance(members) {
  const list = (Array.isArray(members) ? members : []).filter(Boolean)
  const statuses = list.map((m) => acceptanceStatusOfMember(m))
  const failed = list.filter((m) => ACCEPTANCE_BLOCKED.has(acceptanceStatusOfMember(m)))
  const rounds = failed.reduce((max, m) => Math.max(max, reworkRoundsOf(m)), 0)
  const status = statuses.includes('rework-failed') ? 'rework-failed'
    : statuses.includes('rejected') ? 'rejected'
      : statuses.includes('unverified') ? 'unverified'
        : statuses.includes('passed') ? 'passed'
          : 'none'
  const allCancelled = list.length > 0 && list.every((m) => m.acceptance === 'cancelled')
  const note = !list.length
    ? '本次没有成员回执（没派活或指挥没拆解出任务），未做验收'
    : allCancelled
      ? '本轮被用户停止，成员没有产出，不是交付物'
      : status === 'rework-failed'
        ? memberNamesOf(failed) + '返工后没有返回产出（已返工 ' + rounds + ' 次），保留的上一轮产出不算交付'
        : status === 'rejected'
          ? memberNamesOf(failed) + '未通过验收（返工 ' + rounds + ' 次后仍不通过）'
          : status === 'unverified'
            ? memberNamesOf(failed) + '的审核没有给出结论，按未通过处理'
            : status === 'passed'
              ? '本次调用通过验收'
              : '本组没有审校/指挥审核位，本轮未做验收'
  return { acceptanceStatus: status, acceptanceNote: note, acceptanceRounds: rounds }
}

/** 回执最开头的硬标记：验收没过就不是交付物（防父会话把它当成果汇报给用户）。 */
function acceptanceBlockedLine(rounds) {
  return '⛔ 本次未通过验收（返工 ' + Math.max(0, Math.floor(Number(rounds) || 0)) + ' 次后仍不通过）。'
    + '这不是交付物：不得描述为已完成；必须继续派返工，或如实告知用户失败原因。'
}

/**
 * 成员执行入口：只做异常兜底。
 * **终态（完成 / 失败（原因）/ 已停止 / 静默超时）由 callMemberImpl 的每条 return 路径写**，
 * 这里补的是「审核 / 子会话直接抛错」那条路径——否则进度条会永远停在中途阶段。
 */
async function callMember(ctx, member, task, config, group, styleOverride, parent, brief, onStage, onWork, callId, childSink) {
  if (callId && member && member.id) memberStopController(callId, member.id)
  try {
    return await callMemberImpl(ctx, member, task, config, group, styleOverride, parent, brief, onStage, onWork, callId, childSink)
  } catch (error) {
    finishMemberStage(callId, member, onStage, '失败（内部错误：' + (shortStageText(error?.message) || '未知错误') + '）')
    throw error
  } finally {
    if (callId && member && member.id) memberStops.delete(memberStopKey(callId, member.id))
  }
}

async function callMemberImpl(ctx, member, task, config, group, styleOverride, parent, brief, onStage, onWork, callId, childSink) {
  const role = roleOf(member)
  // 回执要写「实际用的 provider + model」：deepseek 成员按小组默认解析（relay），
  // 成员自己显式配的 provider/model 优先；旧模型名由 deepseekMemberModel 映射。
  const deepseekRoute = member.kind === 'deepseek'
    ? (() => {
        const provider = deepseekMemberProvider(config, ctx)
        return { provider, model: deepseekMemberModel(config, member, provider) }
      })()
    : null
  const memory = (state.memberMemory || {})[member.id]
  const memoryBlock = memory && memory.digest && (state.config || {}).memoryInject !== false
    ? '\n\n[你之前为这个小组做过的事（摘要）]\n' + memory.digest
    : ''
  const standardBlock = group.standard ? '\n\n[验收标准]\n' + group.standard : ''
  const prompt = memberPrompt(member, task) + standardBlock + (brief ? '\n\n[背景]\n' + brief : '') + memoryBlock + WORK_STYLE
  if (onStage) onStage('执行中（' + member.kind + '）')
  // 任何 stdout / 子代理消息变化都刷新进度条的 lastActivity（前端据此显示「静默 Ns」）。
  // 走 createProgressBeat：≥1s 节流（stdout 每几十毫秒一块，不能每块都写进度表）。
  const onActivity = callId ? createProgressBeat(callId, member.id) : undefined
  let result = await runKind(ctx, member, prompt, config, group, styleOverride, parent, undefined, callId, childSink, onActivity)
  // watchdog retry: a timeout / dead agent gets one more attempt on the same member
  const maxAttempts = 2
  let attempt = 1
  // 静默超时（看门狗）不重试：再发一次大概率还是静默，先把「静默超时终止」如实回报。
  while (!result.ok && attempt < maxAttempts && !SILENT_KILL_REASONS.has(result.reason) && result.reason !== 'cancelled') {
    attempt += 1
    const why = String(result.error || '无输出')
    if (onStage) onStage('重试中（第 ' + attempt + ' 次，上次：' + why.slice(0, 40) + '）')
    const retryPrompt = prompt + '\n\n[上次失败] ' + why + '\n请重新完成任务，直接给出结果。'
    result = await runKind(ctx, member, retryPrompt, config, group, styleOverride, parent, undefined, callId, childSink, onActivity)
    await save().catch(() => {})
  }
  if (attempt > 1) result = Object.assign({}, result, { attempts: attempt })
  if (callCancelled(callId)) {
    finishMemberStage(callId, member, onStage, '已停止')
    return {
      memberId: member.id,
      name: member.name,
      role: role?.name,
      kind: member.kind,
      model: deepseekRoute ? deepseekRoute.model : member.model,
      ...deepseekRoute ? { provider: deepseekRoute.provider } : {},
      ok: false,
      accepted: false,
      acceptance: 'cancelled',
      text: '',
      error: '已被用户停止',
    }
  }
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
  // 验收冲突策略（state.config.authoritativeReviewer，页面 /config 可改）：
  //   any（默认）= 任一不通过即不通过；commander = 以指挥终审为准（审校与指挥冲突时不再判失败）。
  const commanderAuthoritative = (state.config && state.config.authoritativeReviewer) === 'commander'
    && requireCommander && hasCommanderReviewer
  const acceptanceOf = () => {
    const prelim = verdictOf(review.self)
    const commander = verdictOf(review.commander)
    // commander 模式：指挥有结论时它就是唯一权威（审校的拒绝/未判定不再拖失败）
    if (commanderAuthoritative && commander) return commander
    const list = [prelim, commander].filter(Boolean)
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
      // commander 模式（且指挥给了结论）：只把指挥不通过的理由写进返工单，审校的否决不再算数
      const skipSelfBlocks = commanderAuthoritative && Boolean(verdictOf(review.commander))
      if (!skipSelfBlocks) {
        if (verdictOf(review.self) === 'rejected') blocks.push(`[自审未通过] ${review.self.reason}`)
        if (verdictOf(review.self) === 'unverified') blocks.push(`[自审未判定] ${review.self.reason}`)
      }
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

  // ── 终态：所有 return 路径都必须落一次（旧实现只写「终审（指挥）」，UI 会永远停在那里）──
  const finalStage = (() => {
    if (callCancelled(callId) || result.reason === 'cancelled') return '已停止'
    if (SILENT_KILL_REASONS.has(result.reason)) return '静默超时'
    if (!result.ok) return '失败（' + (shortStageText(result.error) || '成员没有产出') + '）'
    if (reworkFailed) return '失败（返工失败：' + (shortStageText(reworkError) || '未返回产出') + '）'
    if (acceptance === 'rejected') return '失败（验收未通过）'
    if (acceptance === 'unverified') return '失败（审核未判定）'
    return '完成'
  })()
  finishMemberStage(callId, member, onStage, finalStage)

  return {
    memberId: member.id,
    name: member.name,
    role: role?.name,
    kind: member.kind,
    // 实际使用的 provider/model（deepseek 成员会带回 seam 真正启动的那一组；
    // seam 在启动失败时回退到官方，所以不能只写成员记录里的旧值）。
    model: result.model || (deepseekRoute ? deepseekRoute.model : member.model),
    ...(result.provider || (deepseekRoute && deepseekRoute.provider))
      ? { provider: result.provider || deepseekRoute.provider }
      : {},
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
    // 看门狗终止原因（idle-timeout / hard-limit / cancelled）：回执据此写「静默超时终止」
    ...result.reason === undefined ? {} : { reason: result.reason },
    ...SILENT_KILL_REASONS.has(result.reason) ? { idleTimeout: true } : {},
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
    env: await envFor(Object.assign({ kind: group.commander?.kind === 'claude' ? 'claude' : 'codex' }, group.commander || {}), config),
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
  // 启动时跑一次性迁移（幂等）：deepseek 成员 → relay。
  // 出图模型迁移已停用：用户要自己选 2.5 或 2.6，不再自动改成 2.6。
  // 先 load 再迁移，补绑也挂在这条链上 —— 两个 load() 并发会把迁移后的内存状态覆盖回旧值。
  const boot = load()
    // .then(() => migrateImageModels())  // 已停用：让用户自己选模型
    .then(() => migrateDeepseekMembers())
    .catch((error) => console.error('[council] startup migration failed:', String(error?.message ?? error)))
  // 进程重启后，已存在的会话不会再触发 agent/created：启动时补绑一次，
  // 否则“恢复的会话”会丢掉 council_* 工具（2026-11-02 实测踩到）。
  // 已归档的组不补绑：归档会话不该再拿到 council_* 工具。
  const rebindExisting = () => {
    boot.then(() => {
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

/** 带 ETag 的 JSON 响应：客户端带着 If-None-Match 来就回 304，正文 0 字节。
 *  /state 有 500KB+（delegations 占大头），小组界面又是 1.5~6 秒轮询一次，
 *  远程访问时这点流量足以把链路堵满 —— 304 之后每次轮询只要几百字节头。 */
function sendTagged(req, res, body) {
  const text = JSON.stringify(body)
  const tag = '"' + createHash('sha1').update(text).digest('base64url').slice(0, 22) + '"'
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, { etag: tag, 'cache-control': 'no-cache' })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    etag: tag,
  })
  res.end(text)
}

/** 轮询用的精简状态：delegations 只留每个会话最近 N 条，避免正文无限膨胀。 */
function pollStateView(state) {
  const MAX = 40
  const delegations = {}
  for (const [sid, value] of Object.entries(state.delegations || {})) {
    if (value && Array.isArray(value.entries)) delegations[sid] = { ...value, entries: value.entries.slice(-MAX) }
    else delegations[sid] = value
  }
  return { ...state, delegations }
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
            // residentChildren：当前被插件有意保留（未 dispose）的子代理数，只读观测值。
            // subagentSessions / childDirs：同一个「子智能体」计数的两个口径，方便对照——
            //   subagentSessions = 本会话 `subagent/catalog` 记录数（页面显示的就是它，dispose 不减）；
            //   childDirs        = 磁盘上 parentSession === 本会话的子会话目录数。
            // 目标会话：?sessionId=... → 当前组 → 第一个组。取不到就给 null（不骗成 0）。
            const statsSession = normalizeSessionId(url.searchParams.get('sessionId') || (activeGroup() || {}).sessionId)
            const childStats = await childSessionStats(ctx, statsSession)
            return sendTagged(req, res, {
              state: pollStateView(state),
              config: publicConfig(config),
              residentChildren: residentChildren.size,
              subagentSessions: childStats.subagentSessions,
              childDirs: childStats.childDirs,
            })
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
                deepseek: DEEPSEEK_MEMBER_MODEL,
                image: 'gpt-image-2.6-flare',
              }
              const kind = defaultModels[body.kind] ? body.kind : 'codex'
              const member = {
                id: `m_${randomUUID().slice(0, 8)}`,
                name: body.name || '新成员',
                kind,
                model: body.model || defaultModels[kind],
                provider: kind === 'deepseek' ? (body.provider || deepseekMemberProvider(config)) : undefined,
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
            if (route === PRUNE_CHILDREN_ROUTE) {
              // 按父会话清理子会话目录（POST /council/api/sessions/prune-children）：
              // body = { sessionId?（默认当前组会话）, dryRun?, keepMinutes?（默认 10） }。
              // 与 /sessions/prune 的区别：只删 parentSession === sessionId 的目录；
              // 当前会话自己、成员 convId、驻留登记表里的子会话一律保留。
              const requested = body.sessionId ? String(body.sessionId) : ''
              const target = normalizeSessionId(requested) || normalizeSessionId((activeGroup() || {}).sessionId)
              if (!target) return send(res, 400, { error: 'no sessionId: pass sessionId or open a group session first' })
              const keepMinutes = Number(body.keepMinutes)
              const result = await pruneChildDirsByParent(ctx, {
                sessionId: target,
                dryRun: Boolean(body.dryRun),
                keepMinutes: Number.isFinite(keepMinutes) && keepMinutes >= 0 ? keepMinutes : CHILD_DIR_KEEP_MINUTES,
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
              // 成员级停止：只停那一个成员（UI 每个成员的 ✕ 走这条路）
              if (body.member) {
                const memberKey = String(body.member)
                let hit = 0
                for (const [id, entry] of activeCalls) {
                  if (body.callId && id !== body.callId) continue
                  if (stopMember(id, memberKey)) hit += 1
                  const progressEntry = progressMap.get(id)
                  if (progressEntry && progressEntry.members && progressEntry.members[memberKey]) {
                    progressSet(id, memberKey, { stage: '已停止（用户）', finishedAt: Date.now() })
                  }
                }
                return send(res, 200, { stoppedMembers: hit, at })
              }
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
            // 读取时自愈：陈旧的未完成项在这里收尾，不指望派活自己回来写 finishedAt。
            // 阈值跟着静默阈值走（见 progressStaleMs），activeCalls 里的条目不会被误收。
            const now = progressNow()
            healProgress(now, config)
            const sessionIdFilter = url.searchParams.get('sessionId')
            const includeFinished = url.searchParams.get('includeFinished') === '1'
            // 规范化 sessionId：兼容 session- 前缀（前端可能带或不带）
            const normalizedFilter = sessionIdFilter
              ? (sessionIdFilter.startsWith('session-') ? sessionIdFilter : 'session-' + sessionIdFilter)
              : null
            const out = {}
            for (const [id, entry] of progressMap) {
              // 支持 ?sessionId=xxx 过滤：2.5D 等无组绑定场景仍能按会话查进度
              // 比对时双向规范化：entry.sessionId 和 filter 都补齐 session- 前缀
              if (normalizedFilter) {
                const entrySessionId = entry.sessionId
                  ? (entry.sessionId.startsWith('session-') ? entry.sessionId : 'session-' + entry.sessionId)
                  : null
                if (entrySessionId !== normalizedFilter) continue
              }
              // 默认不返回已完成的条目（除非 includeFinished=1）
              // 但 stale 条目即使有 finishedAt 也返回（保留 5 分钟供前端看到一次）
              if (!includeFinished && entry.finishedAt && !entry.stale) continue
              // 既有字段名一律保留；只追加只读派生字段：
              //  - runningMs：跑了多久
              //  - silentMs（每个成员条目）：距最后一次活动（= 最近一次 stdout/子代理活动）过了多久，
              //    前端 >3 分钟显示「静默 Ns」（活动心跳由 createProgressBeat 节流刷新）
              //  - stageChangedAt / stageAgeMs：阶段是什么时候变的、这个阶段停了多久（新增，前端可选）
              //  - 成员已有 finishedAt（终态已写）→ silentMs 与 stageAgeMs 固定 0：它不是在等，只是记录还在
              const members = {}
              for (const [memberId, slot] of Object.entries(entry.members || {})) {
                // 最后活动时间：成员条目 → 整条 entry → 开工时间（老条目没有 lastActivity）
                const last = (slot && (slot.lastActivity ?? slot.at)) ?? entry.lastActivity ?? entry.startedAt ?? 0
                const silentMs = slot && slot.finishedAt ? 0 : Math.max(0, now - last)
                // 阶段时间：新条目有 stageChangedAt；老条目回落 at（旧版 at 就是阶段变化时间）
                const stageChangedAt = (slot && (slot.stageChangedAt ?? slot.at)) ?? entry.startedAt ?? now
                const stageAgeMs = slot && slot.finishedAt ? 0 : Math.max(0, now - stageChangedAt)
                members[memberId] = Object.assign({ id: memberId }, slot, { silentMs, stageChangedAt, stageAgeMs })
              }
              out[id] = Object.assign({}, entry, {
                members,
                runningMs: Math.max(0, now - (entry.startedAt || 0)),
              })
            }
            // residentChildren：当前被插件有意保留（未 dispose）的子代理数，只读观测值。
            return send(res, 200, { progress: out, residentChildren: residentChildren.size })
          }
          if (req.method === 'GET' && route === '/jobs') {
            const jobs = [...backgroundJobs.values()].map((job) => ({
              runId: job.runId, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt,
              error: job.error || null, sessionId: job.sessionId || null,
            }))
            return send(res, 200, { jobs })
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
              const source = own.claudeKey || own.imageKey || own.codexToken ? 'page' : 'profile'
              return send(res, 200, { config: configView(config, source) })
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
              if (typeof body.failOnRejectedAcceptance === 'boolean') next.failOnRejectedAcceptance = body.failOnRejectedAcceptance
              if (typeof body.backgroundDelegations === 'boolean') next.backgroundDelegations = body.backgroundDelegations
              // 看门狗参数可写：memberIdleMinutes > 0；memberMaxMinutes >= 0（0 = 不限制）
              if (body.memberIdleMinutes !== undefined && Number.isFinite(Number(body.memberIdleMinutes)) && Number(body.memberIdleMinutes) > 0) {
                next.memberIdleMinutes = Number(body.memberIdleMinutes)
              }
              if (body.memberMaxMinutes !== undefined && Number.isFinite(Number(body.memberMaxMinutes)) && Number(body.memberMaxMinutes) >= 0) {
                next.memberMaxMinutes = Number(body.memberMaxMinutes)
              }
              if (body.imageTimeoutSeconds !== undefined && Number.isFinite(Number(body.imageTimeoutSeconds)) && Number(body.imageTimeoutSeconds) > 0) {
                next.imageTimeoutSeconds = Number(body.imageTimeoutSeconds)
              }
              // 成员内存上限：> 0 生效；0 = 不限制
              if (body.memberMaxMemoryMb !== undefined && Number.isFinite(Number(body.memberMaxMemoryMb)) && Number(body.memberMaxMemoryMb) >= 0) {
                if (Number(body.memberMaxMemoryMb) === 0) next.memberMaxMemoryMb = 0
                else next.memberMaxMemoryMb = Math.floor(Number(body.memberMaxMemoryMb))
              }
              // 验收冲突策略：any（默认，任一不通过即不通过）/ commander（以指挥终审为准）
              if (body.authoritativeReviewer === 'any' || body.authoritativeReviewer === 'commander') {
                if (body.authoritativeReviewer === 'any') delete next.authoritativeReviewer
                else next.authoritativeReviewer = 'commander'
              }
              // providerByKind: 各框架默认使用的 provider
              if (body.providerByKind && typeof body.providerByKind === 'object') {
                next.providerByKind = {}
                for (const kind of ['claude', 'codex', 'deepseek', 'image']) {
                  if (typeof body.providerByKind[kind] === 'string' && body.providerByKind[kind]) {
                    next.providerByKind[kind] = body.providerByKind[kind]
                  }
                }
                if (Object.keys(next.providerByKind).length === 0) delete next.providerByKind
              }
              state.config = Object.keys(next).length ? next : undefined
              usageCache = null
              catalog = null
              await save()
              return send(res, 200, { config: configView(config, 'page') })
            }
          }
          if (req.method === 'GET' && route === '/usage') {
            return send(res, 200, await keyUsage(config))
          }
          if (req.method === 'GET' && route === '/models') {
            if (url.searchParams.get('refresh')) catalog = null
            return send(res, 200, await modelCatalog(ctx, config))
          }
          if (req.method === 'POST' && route === '/models/refresh') {
            const body = await readBody(req)
            const source = typeof body?.source === 'string' && body.source ? body.source : 'all'
            if (source !== 'all' && CATALOG_KINDS.indexOf(source) < 0) {
              return send(res, 400, { error: `unknown source ${source}` })
            }
            return send(res, 200, await refreshCatalog(ctx, config, source))
          }
          if (req.method === 'GET' && route === '/balance') {
            return send(res, 200, await deepseekBalance(ctx, config))
          }
          if (req.method === 'GET' && route === '/providers') {
            const refresh = /(?:^|&)refresh=1(?:&|$)/.test(String(req.url || '').split('?')[1] || '')
            return send(res, 200, await listProviders(ctx, config, { refresh }))
          }
          if (req.method === 'POST' && route === '/providers/refresh') {
            return send(res, 200, await listProviders(ctx, config, { refresh: true }))
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
    // 看门狗终止要能跟普通失败区分开（前端/回执都靠这个字段）
    if (result.reason) slot.reason = result.reason
    if (SILENT_KILL_REASONS.has(result.reason)) slot.silentTimeout = true
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

/** 陈旧阈值下限：任何配置下都不会比 10 分钟更早把未完成项收尾。 */
const PROGRESS_STALE_MIN_MS = 10 * 60_000
/** 成员超时之上再宽限 5 分钟：成员可能正在收尾/续跑，别把活的当死的。 */
const PROGRESS_STALE_GRACE_MS = 5 * 60_000
/** 旧名保留（= 10 分钟下限），测试/外部引用仍可继续用。 */
const PROGRESS_STALE_MS = PROGRESS_STALE_MIN_MS
/** 陈旧项标完后最多再留 5 分钟，够前端看到一次就删。 */
const PROGRESS_STALE_KEEP_MS = 5 * 60_000
/** 已完成项最多留 24 小时。 */
const PROGRESS_DONE_KEEP_MS = 24 * 60 * 60_000
/** 指挥占位阶段的成员 id：没有真正成员时用它显示「拆解中 / 派活中」。 */
const PROGRESS_STAGE_ID = '__stage__'
/** 活动心跳节流：stdout 每几十毫秒来一块，≥1s 才写一次 lastActivity。 */
const PROGRESS_ACTIVITY_THROTTLE_MS = 1000

/**
 * 进度子系统时钟。默认 `Date.now()`；测试用 `__setProgressClock` 拨表，
 * 这样「每 2 秒一行输出 / 停 30 秒」这类断言不用真的等 30 秒。
 */
let progressClock = () => Date.now()
function progressNow() { return progressClock() }

function progressInit(callId, sessionId) {
  if (!callId) return
  progressMap.set(callId, { startedAt: progressNow(), sessionId: sessionId, members: {} })
  if (progressMap.size > 30) progressMap.delete(progressMap.keys().next().value)
}

/**
 * 写成员进度。
 *  - 阶段/状态类 patch（stage / name / finishedAt …）→ 刷新 `at` 与 `stageChangedAt`
 *  - 只带 lastActivity 的 patch = 活动心跳 → **不动阶段时间**，只刷新最后活动时间
 * 这样 /progress 才能同时回答「多久没输出（silentMs）」和「这个阶段停了多久（stageAgeMs）」，
 * 不会把「codex 一直在输出」误报成「静默 1207s」。
 */
function progressSet(callId, memberId, patch = {}, at = progressNow()) {
  if (!callId) return
  const entry = progressMap.get(callId)
  if (!entry) return
  const prev = entry.members[memberId] || {}
  const activityOnly = Object.keys(patch).every((key) => key === 'lastActivity')
  const next = Object.assign({ at: at }, prev, patch)
  if (activityOnly) {
    // 心跳不动 `at`（阶段变化时间）；老条目没有 stageChangedAt 时用 at 兜底
    next.at = prev.at ?? at
    next.stageChangedAt = prev.stageChangedAt ?? prev.at ?? at
  } else {
    next.stageChangedAt = at
  }
  entry.members[memberId] = next
  if (patch.lastActivity !== undefined) entry.lastActivity = patch.lastActivity
}

/**
 * 活动心跳（run() 的 stdout 数据回调 / seam 的子代理活动回调）：
 * ≥`throttleMs` 才写一次 lastActivity，避免每一块 stdout 都改进度表。
 * 返回的闭包返回 true 表示这次真的写了。
 */
function createProgressBeat(callId, memberId, { throttleMs = PROGRESS_ACTIVITY_THROTTLE_MS, now = progressNow } = {}) {
  let lastBeat = 0
  return function beat() {
    if (!callId) return false
    const at = now()
    if (at - lastBeat < throttleMs) return false
    lastBeat = at
    // 成员条目：/progress 的 silentMs 读它；整条 entry：healProgress 的陈旧判定读它
    progressSet(callId, memberId, { lastActivity: at }, at)
    progressTouch(callId, memberId, at)
    return true
  }
}

/**
 * 记录「这个成员还在动」：刷新它的 lastActivity（以及整条 entry 的 lastActivity）。
 * 由 run() 的 stdout/stderr 数据回调、seam 的子代理状态/消息变化回调触发。
 * 只有 entry 已存在时才写——不凭空造进度条。
 */
function progressTouch(callId, memberId, at = progressNow()) {
  if (!callId) return
  const entry = progressMap.get(callId)
  if (!entry) return
  entry.lastActivity = at
  const slot = entry.members && entry.members[memberId]
  if (slot) slot.lastActivity = at
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
 *  - 仍在本进程 activeCalls 里的 callId 一律不动（正在跑就是活着，哪怕跑了 40 分钟）
 *  - 未完成且「静默」超过 progressStaleMs(config) → 写 finishedAt + stale:true（staleAt 记标记时间）
 *    （静默 = now - lastActivity；lastActivity 由 progressTouch 在每次输出/子代理活动时刷新，
 *      没有 lastActivity 的老条目回落到 startedAt）
 *  - 已标 stale 的 entry 超过 5 分钟 → 从 Map 删除（前端最多看到一次）
 *  - 已完成的 entry 超过 24 小时 → 删除
 */
function healProgress(now = Date.now(), config) {
  let markedStale = 0
  const staleAfterMs = progressStaleMs(config)
  for (const [id, entry] of progressMap) {
    if (!entry) { progressMap.delete(id); continue }
    // 正在执行：既不标 stale，也不删（activeCalls 由 finally 收尾）
    if (activeCalls.has(id)) continue
    if (!entry.finishedAt && now - (entry.lastActivity || entry.startedAt || 0) > staleAfterMs) {
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
    '『验收未通过』≠ 交付：若 council_delegate 回执标了未通过验收，禁止把它当成果汇报给用户；要么继续派返工（最多 maxRework 次），要么明确告诉用户哪里没过。',
    '违反这条 = 任务失败。',
  ].join('\n')
}

/**
 * 硬拦截（方案 A）：小组模式下父会话自己执行「写操作」的守卫。
 *
 * 系统提示词拦不住（实测：一个 2.5D 会话里父会话自己跑了 bash 120 次 / edit 12 次 /
 * blender_python 6 次 / blender_render 10 次，只派活 25 次），所以在 `agent.ctx.tools.guard()`
 * 上加一道单调守卫：写类工具直接拒绝；只读工具、read_image 与 bash 放行，但计入
 * `selfRan`（方案 B：bash / read_image / grep+glob+read 自己跑也要审计，只是不拦）。
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

/**
 * 方案 B：只读工具分组 —— 放行但计数。父会话自己 grep/读代码/看图判读，
 * 用户同样看不到，所以和 bash 一样进回执审计（只审计、不拦截）。
 */
const READ_TOOLS = new Set(['grep', 'glob', 'read', 'read_file'])

/**
 * 按组累加的越权审计：{ blocked, tools: { [name]: count }, bash, readImage, read, lastAt }。
 *
 * 累计的是「本组从会话开始到现在的全部计数」；回执只报「上次回执之后」的增量，口径固定为
 * **水位线**：`council_delegate.execute` 收尾时 Δ = 当前累计计数 − 本组水位，报完立刻把水位
 * 推到当前计数（已经报过的不再重复报）。
 *
 * 为什么基线不能放在 execute 开头：父会话最常见的顺序是「先跑 bash 排查、再派活」，那样
 * 基线在 bash 之后才取，Δ 恒为 0 —— 用户要的是「父会话又自己干了什么」，只要发生了就该在
 * 下一次回执里看到。
 */
const selfWorkAudit = new Map()
/**
 * 按组的「已报水位」：{ bash, readImage, read }。纯内存，随组首次使用时初始化，
 * 只由 council_delegate 收尾推进；resetSelfWorkAudit 会一并清掉，避免复位后的旧水位把新计数吃掉。
 */
const selfRanWatermark = new Map()
/** 按组缓存的本轮「用户已放行」判定（守卫里读它；delegate 开始时也会刷新一次）。 */
const selfWorkPermits = new Map()

function selfWorkAuditFor(groupId) {
  let entry = selfWorkAudit.get(groupId)
  if (!entry) {
    entry = { blocked: 0, tools: {}, bash: 0, readImage: 0, read: 0, lastAt: 0 }
    selfWorkAudit.set(groupId, entry)
  }
  return entry
}

/** 本组的已报水位（缺就建 {0,0,0}；随组初始化，纯内存）。 */
function selfRanWatermarkFor(groupId) {
  let mark = selfRanWatermark.get(groupId)
  if (!mark) {
    mark = { bash: 0, readImage: 0, read: 0 }
    selfRanWatermark.set(groupId, mark)
  }
  return mark
}

/** 只取「父会话自行执行」的三组计数（缺字段按 0：老数据、被复位、无 entry 都不出 undefined）。 */
function selfRanOf(entry) {
  return {
    bash: Number(entry && entry.bash) || 0,
    readImage: Number(entry && entry.readImage) || 0,
    read: Number(entry && entry.read) || 0,
  }
}

/** Δ = 当前累计计数 − 已报水位；计数被复位/倒退时按 0 兜底，绝不出负数。 */
function selfRanDelta(now, watermark) {
  const after = selfRanOf(now)
  const before = selfRanOf(watermark)
  return {
    bash: Math.max(0, after.bash - before.bash),
    readImage: Math.max(0, after.readImage - before.readImage),
    read: Math.max(0, after.read - before.read),
  }
}

/** 清空审计与水位（不传 groupId 清全部；测试与重新开始一轮时用）。 */
function resetSelfWorkAudit(groupId) {
  if (groupId === undefined) {
    selfWorkAudit.clear()
    selfRanWatermark.clear()
  } else {
    selfWorkAudit.delete(groupId)
    selfRanWatermark.delete(groupId)
  }
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
    // 以下三类只计入审计、不拦截（否则连只读排障都做不了）：
    //   bash → selfRan.bash；read_image → selfRan.readImage；grep/glob/read/read_file → selfRan.read
    if (name === 'bash') {
      const audit = selfWorkAuditFor(groupId)
      audit.bash += 1
      audit.lastAt = Date.now()
      return undefined
    }
    if (name === 'read_image') {
      const audit = selfWorkAuditFor(groupId)
      audit.readImage += 1
      audit.lastAt = Date.now()
      return undefined
    }
    if (READ_TOOLS.has(name)) {
      const audit = selfWorkAuditFor(groupId)
      audit.read += 1
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

const STAFF_MODELS = { codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5', deepseek: DEEPSEEK_MEMBER_MODEL, image: 'gpt-image-2.6-flare' }
const STAFF_KINDS = Object.keys(STAFF_MODELS)

/**
 * 「模型定位速查」表：模型 id → 定位（**来源是用户经验，不是官方基准，未做线上核实**）。
 *
 * 为什么要有它：`catalogText()` 原来只列「各框架有哪些 id」，指挥（拆解者）不知道它们擅长什么，
 * 只能凭旧印象选模型 → 过时。这张表随 `catalogText()` 一起进系统提示与拆解提示词。
 *
 * 维护约定：键 = 模型 id（小写、精确匹配）；描述按用户原话写，别在这里加"核实结论"
 * （要核实另开一轮，核实结果放 docs，不放提示词）。
 */
const MODEL_GUIDE = [
  ['claude-opus-5-5', '代码顶尖（理论最强；有可能降智，长任务要复核）'],
  ['claude-fable-5-2', '审美 + 代码顶尖（贵；也可能降智，重活优先但控制次数）'],
  ['gpt-6-astra', '操作电脑/工具编排顶尖（多步 GUI/CLI、长流程）'],
  ['gpt-6.1-sol', '性价比高，接近 gpt-6-astra 水平（多数编码/执行任务的默认选择）'],
  ['deepseek-flash', '官方 API 名（即 V4.1-Flash-1017），编程性价比顶尖'],
  ['deepseek-v4.1-flash', '同一模型（V4.1-Flash-1017）的中转站名 relay-deepseek，价格约 3 折，优先选'],
  ['gpt-image-2.6-flare', '性价比出图（默认）'],
  ['gpt-image-2.6-sunburst', '旗舰出图（质量优先、贵）'],
]

/** 选模型没把握时的兜底（目录说明与拆解提示词共用，避免两处漂移）。 */
const MODEL_GUIDE_TIEBREAK = '不确定就选 gpt-6.1-sol 或 deepseek-v4.1-flash'

/**
 * 传给指挥的「模型定位速查」整段。
 * 纯同步字符串拼接（systemPrompt 的 section.text 不能是 Promise）。
 */
function modelGuideText() {
  return [
    '## 模型定位速查（来源：用户经验，不是官方基准；选模型时优先看这里，不要凭旧印象）',
    ...MODEL_GUIDE.map(([id, desc]) => `- ${id}：${desc}`),
  ].join('\n')
}

/**
 * 出图模型换代（2.5 / gpt-image-2 → 2.6 flare/sunburst）：
 * 中转现在同时列 2.5 与 2.6，页面与默认值**只用 2.6**，老的等启动迁移换掉。
 */
const IMAGE_MODEL_FALLBACK = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']
const IMAGE_NEW_PREFIX = 'gpt-image-2.6-'
const IMAGE_LEGACY_PREFIX = 'gpt-image-2.5-'
/** 启动迁移要换掉的历史值（gpt-image-2 也归到 flare）。 */
const OLD_IMAGE_MODELS = new Set(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'])
/** 同一代内的展示顺序：flare 在前、sunburst 次之，其余按字典序。 */
const IMAGE_VARIANT_ORDER = ['flare', 'sunburst']
function imageVariantRank(id) {
  const index = IMAGE_VARIANT_ORDER.indexOf(String(id).slice(IMAGE_NEW_PREFIX.length))
  return index === -1 ? IMAGE_VARIANT_ORDER.length : index
}
/**
 * 保留中转返回的全部 gpt-image-* 模型，按中转返回顺序原样输出（只去重）。
 * 不做筛选、不排序、不优先某个版本——让用户自己选。
 */
function pickImageModels(ids) {
  const seen = new Set()
  const result = []
  for (const id of ids || []) {
    const str = String(id)
    if (str.startsWith('gpt-image') && !seen.has(str)) {
      seen.add(str)
      result.push(str)
    }
  }
  return result
}

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
    '',
    modelGuideText(),
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
async function ensureStaffing(group, staffing, createdIds, config) {
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
        provider: target.kind === 'deepseek' ? deepseekMemberProvider(config) : undefined,
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
          member.provider = target.kind === 'deepseek' ? deepseekMemberProvider(config) : undefined
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

/**
 * 所有工具 `execute()` 的统一出口别名（council_delegate / council_member / council_role / council_policy）。
 * 语义与 losslessToolResult 完全一致：递归只留 JSON 安全值（丢 undefined / function / Symbol /
 * BigInt / Set/Map / 类实例 / 循环引用 / 非有限数字），保证 DSH 的 lossless JSON 校验必过。
 * 单独留一个名字是为了让「工具返回值」在调用点上一眼可辨，将来要加内容过滤也只改这一处。
 */
function toolResult(value) {
  return losslessToolResult(value)
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
    if (!target) {
      // 目录已经不在盘上（dispose 时已顺手删掉，见 deleteChildSessionDir）——
      // 回执里的「已清理 N 个子会话目录」仍然要算上它，否则会从 N 变成 0。
      removed.push(uuid)
      continue
    }
    try {
      await rm(target.dir, { recursive: true, force: true })
      removed.push(uuid)
    } catch { /* 删不掉（占用/权限）就跳过 */ }
  }
  return removed
}

/* ── 子会话目录：按父会话「精确清除」（2026-11-05）─────────────────────────
 *
 * 背景：DSH 会话页那个「N 个子智能体」统计的是**本会话的 `subagent/catalog` 记录数**
 * （每条记录对应一个 `parentSession` = 本会话的子会话目录）。`dispose()` 只释放内存、
 * **不删会话记录**，所以计数只增不减。
 *
 * 三条出路（保留下面第 1 条的硬约束）：
 *   1) 插件自己 dispose 掉**自己创建**的子会话后，顺手删它的目录（精确、即时，见
 *      `deleteChildSessionDir`，调用点在 seam 的 finally 与驻留清扫器里）；
 *   2) `POST /council/api/sessions/prune-children`：按父会话 + 目录 mtime 批量清历史
 *      （`pruneChildDirsByParent`），默认只清 10 分钟以前的；
 *   3) `GET /council/api/state` 里给 `subagentSessions`（记录数）与 `childDirs`（磁盘目录数），
 *      方便对照「计数涨得比目录快还是慢」。
 *
 * 硬约束（与 `/sessions/prune` 共用同一份 `sessionKeepIds`，不另算）：
 *   - 只删 `$DSH_HOME/sessions/<桶>/<uuid>/` 这种**两层直接子目录**，目录名必须是 uuid；
 *   - 桶与目录**都不跟符号链接**（`resolveSessionDir` 用 realpath 反查）；非 uuid 一律不动；
 *   - 删除前必须读出 `session.v4.jsonl.zstd` 首行的 `parentSession`，且它（归一化掉
 *     `session-` 前缀后）必须等于期望的父会话；**读不出 / 对不上就不删**；
 *   - 当前会话自己、任何组 `sessionId` / 成员 `convId` / 指挥 `commanderConvId` /
 *     审校子会话 / 活跃 agent / 驻留登记表里的子会话，一律不删。
 */
const SESSION_LOG_NAME_RE = /^session(\.[a-z0-9]+)*\.jsonl(\.zstd)?$/
/** 只读首帧：会话首行（header）通常压在几百字节里，避免为了一行 header 去读整个 4MB 日志。 */
const SESSION_LOG_HEAD_BYTES = 4096
/** `/state` 里的目录扫描缓存（桶 mtime 一变就失效），避免每次轮询都扫 300+ 目录。 */
const CHILD_DIR_CACHE_MS = 10_000
/** 磁盘上按 `subagent/catalog` 计数（多帧 zstd）比较贵，单独缓存 30 秒。 */
const CATALOG_COUNT_CACHE_MS = 30_000
let childDirCache = { stamp: null, at: 0, rows: [] }
let catalogCountCache = { key: '', at: 0, count: null }

/** 会话目录里优先读哪个日志文件：`session.v4.jsonl.zstd` > 其它 `session*.jsonl[.zstd]`。 */
async function sessionLogFile(dir) {
  let names = []
  try { names = await readdir(dir) } catch { return null }
  const logs = names.filter((name) => SESSION_LOG_NAME_RE.test(name))
  if (!logs.length) return null
  logs.sort((a, b) => Number(b.includes('.v4.')) - Number(a.includes('.v4.')))
  return path.join(dir, logs[0])
}

/** 读日志文件开头 SESSION_LOG_HEAD_BYTES 字节（不整读）；失败返回 null。 */
async function readSessionLogHead(dir, bytes = SESSION_LOG_HEAD_BYTES) {
  const file = await sessionLogFile(dir)
  if (!file) return null
  let handle
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    if (!bytesRead) return null
    return { file, name: path.basename(file), buffer: buffer.subarray(0, bytesRead) }
  } catch {
    return null
  } finally {
    if (handle) { try { await handle.close() } catch { /* ignore */ } }
  }
}

/** 日志首行 JSON（多帧 zstd 只解第一帧；解析失败返回 null）。 */
function firstLogRecord(head) {
  if (!head) return null
  let text = null
  if (head.name.endsWith('.zstd')) {
    try { text = zstdDecompressSync(head.buffer).toString('utf8') } catch { return null }
  } else {
    text = head.buffer.toString('utf8')
  }
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { return JSON.parse(trimmed) } catch { return null }
  }
  return null
}

/** 会话目录首行里的 { id, parent }（都已归一化：去掉 `session-` 前缀；读不出为 null）。 */
async function sessionDirHeader(dir) {
  const record = firstLogRecord(await readSessionLogHead(dir))
  if (!record) return { id: null, parent: null }
  return {
    id: normalizeSessionId(record.id) || null,
    parent: record.parentSession ? normalizeSessionId(record.parentSession) : null,
  }
}

/** 父 agent 的会话 id（`Agent.id` 就是 SessionId；兼容 `agent.session.id` 形态）。 */
function parentIdOf(parent) {
  return String(parent?.id || parent?.session?.id || '') || undefined
}

/** 本插件所有组的会话 id（归一化）——「这个子会话是不是我们派出去的」的兜底判据。 */
function groupSessionIdSet() {  const set = new Set()
  for (const group of state.groups || []) {
    const uuid = sessionDirUuid(group.sessionId)
    if (uuid) set.add(uuid)
  }
  return set
}

/**
 * 扫 `$DSH_HOME/sessions/<桶>/<uuid>/`，返回每条的 `{ id, dir, mtime, parent }`。
 * `parent` = 日志首行的 `parentSession`（归一化）；读不出 header 的目录 **不计入**——
 * 计不出来就不该出现在「可清理」候选里。
 */
async function scanSessionDirRows() {
  const rows = []
  const rootReal = await realpath(SESSIONS_DIR).catch(() => null)
  if (!rootReal) return rows
  let buckets = []
  try { buckets = await readdir(SESSIONS_DIR, { withFileTypes: true }) } catch { return rows }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) continue
    let entries = []
    try { entries = await readdir(path.join(SESSIONS_DIR, bucket.name), { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const uuid = sessionDirUuid(entry.name)
      if (!uuid || !entry.isDirectory() || entry.isSymbolicLink()) continue
      const target = await resolveSessionDir(rootReal, bucket.name, entry.name)
      if (!target) continue
      const header = await sessionDirHeader(target.dir)
      if (!header.parent) continue
      rows.push({ id: uuid, dir: target.dir, mtime: target.stat.mtimeMs, parent: header.parent })
    }
  }
  return rows
}

/** 桶名 + 桶 mtime 的指纹：加/删子会话目录会改桶 mtime，据此自动失效缓存。 */
async function sessionBucketStamp() {
  let stamp = ''
  let buckets = []
  try { buckets = await readdir(SESSIONS_DIR, { withFileTypes: true }) } catch { return '' }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) continue
    const stat = await lstat(path.join(SESSIONS_DIR, bucket.name)).catch(() => null)
    stamp += bucket.name + ':' + (stat ? stat.mtimeMs : 0) + ';'
  }
  return stamp
}

/** 带缓存的全量扫描（只给 `/state` 这种高频只读路径用；清理路径必须走无缓存的 scanSessionDirRows）。 */
async function cachedSessionDirRows() {
  const stamp = await sessionBucketStamp()
  const now = Date.now()
  if (childDirCache.stamp === stamp && now - childDirCache.at < CHILD_DIR_CACHE_MS) return childDirCache.rows
  const rows = await scanSessionDirRows()
  childDirCache = { stamp, at: Date.now(), rows }
  return rows
}

/** 清空两处缓存（测试夹具换了 sessions 目录时用；也由 `__resetChildDirCache` 暴露给测试）。 */
function resetChildDirCache() {
  childDirCache = { stamp: null, at: 0, rows: [] }
  catalogCountCache = { key: '', at: 0, count: null }
}

/* ── 多帧 zstd：会话日志是一串独立帧，Node 的一次性 API 只解第一帧 ──────────
 * 这里只做一个「找帧边界」的最小扫描器（读 header + block header，不解压内容，
 * 所以很便宜）：坏帧/半截帧就停，返回已经找到的完整帧。没有引入任何依赖。
 */
const ZSTD_MAGIC = 0xfd2fb528

/** 找出 buffer 里所有完整 zstd 帧的 [start, end)；结构异常/半截帧就停下（不抛）。 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, corruptAt: offset }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, corruptAt: offset - 1 }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, corruptAt: offset - 3 }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 一个会话目录的日志里有多少条 `subagent/catalog`（解不出来返回 null）。 */
async function countCatalogRecordsInDir(dir) {
  const file = await sessionLogFile(dir)
  if (!file) return null
  const stat = await lstat(file).catch(() => null)
  if (!stat || !stat.isFile()) return null
  const key = file + ':' + stat.size + ':' + stat.mtimeMs
  const now = Date.now()
  if (catalogCountCache.key === key && now - catalogCountCache.at < CATALOG_COUNT_CACHE_MS) {
    return catalogCountCache.count
  }
  if (stat.size > 64 * 1024 * 1024) return null // 超大日志不扫，避免拖垮 /state
  let buffer
  try { buffer = await readFile(file) } catch { return null }
  const { frames } = scanZstdFrames(buffer)
  let count = 0
  for (const frame of frames) {
    let text = null
    try { text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8') } catch { continue }
    if (!text.includes('subagent/catalog')) continue
    for (const line of text.split('\n')) {
      if (!line.includes('subagent/catalog')) continue
      try { if (JSON.parse(line).type === 'subagent/catalog') count += 1 } catch { /* 半截行 */ }
    }
  }
  catalogCountCache = { key, at: Date.now(), count }
  return count
}

/**
 * 当前会话的两个对照数字：
 *   - `subagentSessions`：会话事件里 `subagent/catalog` 的条数（= 页面那个「N 个子智能体」）。
 *     会话在内存里就直接数事件（零 IO、口径与 UI 一致）；不在内存里才去读日志（多帧 zstd）。
 *   - `childDirs`：磁盘上 `parentSession === 本会话` 的子会话目录数。
 * 拿不到就给 `null`（不要骗成 0）。
 */
async function childSessionStats(ctx, sessionId) {
  const normalized = normalizeSessionId(sessionId)
  const stats = { subagentSessions: null, childDirs: null }
  if (!normalized) return stats
  let liveCount = null
  try {
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    if (sessions && typeof sessions.get === 'function') {
      const raw = String(sessionId || '')
      const candidates = raw.startsWith('session-') ? [raw] : ['session-' + raw, raw]
      const session = candidates.map((id) => { try { return sessions.get(id) } catch { return undefined } }).find(Boolean)
      if (session) liveCount = sessionEvents(session).filter((event) => event && event.type === 'subagent/catalog').length
    }
  } catch { liveCount = null }
  if (liveCount !== null) {
    stats.subagentSessions = liveCount
  } else {
    const dir = await findSessionDir(normalized)
    stats.subagentSessions = dir ? await countCatalogRecordsInDir(dir.dir) : null
  }
  try {
    const rows = await cachedSessionDirRows()
    stats.childDirs = rows.filter((row) => row.parent === normalized).length
  } catch { stats.childDirs = null }
  return stats
}

/**
 * dispose 掉一个**插件自己创建**的子会话之后，删掉它留在磁盘上的会话目录。
 *
 * 保守到「宁可不删」：读不出首行 `parentSession`、或它跟期望的父会话对不上、
 * 或 id 命中任何保留集合 → 直接返回 null（不删）。
 * @param {object} ctx 插件 ctx（取活跃 agent 保留集合）
 * @param {string} childId 子会话 id（uuid，`session-` 前缀可选）
 * @param {{ parentSession?: string, extraKeep?: Iterable<string> }} [options]
 *        parentSession = 期望的父会话（seam 里就是 `parent.id`）；不给就只认「本插件任何组的会话」。
 * @returns {Promise<string|null>} 删掉的 uuid，没删返回 null
 */
async function deleteChildSessionDir(ctx, childId, options = {}) {
  const uuid = sessionDirUuid(childId)
  if (!uuid) return null
  // 驻留登记表里的子会话是「有意保留」的，绝不能在这里删
  if (residentChildren.has(String(childId)) || residentChildren.has(uuid)) return null
  const keep = sessionKeepIds(ctx)
  if (options.extraKeep) {
    for (const value of options.extraKeep) {
      const extra = sessionDirUuid(value)
      if (extra) keep.add(extra)
    }
  }
  if (keep.has(uuid)) return null
  const expected = normalizeSessionId(options.parentSession) || null
  const target = await findSessionDir(uuid)
  if (!target) return null
  const header = await sessionDirHeader(target.dir)
  if (!header.parent) return null // 读不出父会话 → 不删
  if (expected) {
    if (header.parent !== expected) return null
  } else if (!groupSessionIdSet().has(header.parent)) {
    return null // 不是本插件任一组派出去的 → 不删
  }
  try {
    await rm(target.dir, { recursive: true, force: true })
    return uuid
  } catch {
    return null // 占用/权限失败：静默
  }
}

/**
 * `POST /council/api/sessions/prune-children` 的实现：只清「父会话 === sessionId」的
 * 子会话目录，且目录 mtime 早于 keepMinutes 分钟、且不在保留集合/驻留表里。
 *
 * @param {object} ctx 插件 ctx
 * @param {{ sessionId?: string, dryRun?: boolean, keepMinutes?: number, now?: number }} [options]
 * @returns {Promise<{ removed: Array<{ id: string, sizeMb: number, mtime: number }>, kept: number, dryRun: boolean }>}
 */
async function pruneChildDirsByParent(ctx, { sessionId, dryRun = false, keepMinutes = CHILD_DIR_KEEP_MINUTES, now = Date.now() } = {}) {
  const normalized = normalizeSessionId(sessionId)
  const minutes = Number(keepMinutes)
  const windowMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : CHILD_DIR_KEEP_MINUTES
  const cutoff = now - windowMinutes * 60_000
  const result = { removed: [], kept: 0, dryRun: Boolean(dryRun) }
  if (!normalized) return result
  const keep = sessionKeepIds(ctx)
  const own = sessionDirUuid(normalized)
  if (own) keep.add(own) // 当前会话自己（哪怕它恰好是某个组的 sessionId 之外的写法）
  for (const id of residentChildren.keys()) {
    const uuid = sessionDirUuid(id)
    if (uuid) keep.add(uuid)
  }
  const rows = await scanSessionDirRows()
  let total = 0
  for (const row of rows) {
    if (row.parent !== normalized) continue
    total += 1
    if (keep.has(row.id) || row.mtime > cutoff) continue
    const sizeMb = Math.round(((await dirSizeBytes(row.dir)) / 1048576) * 100) / 100
    if (!dryRun) {
      try { await rm(row.dir, { recursive: true, force: true }) } catch { continue } // 删不掉就计入 kept
    }
    result.removed.push({ id: row.id, sizeMb, mtime: row.mtime })
  }
  result.kept = total - result.removed.length
  return result
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
  // 重复绑定时先释放旧的 disposer，避免"already registered"错误
  if (boundAgents.has(key)) {
    const oldCleanup = boundAgents.get(key)
    try { oldCleanup() } catch { /* ignore */ }
  }
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
/** 把 council_delegate 的返回对象渲染成回执文本（render 与“验收硬失败”错误消息共用）。 */
function delegateReceiptText(value) {
  const input = value || {}
  const verdict = (v) => (v ? (v.ok === true ? '通过' : v.ok === false ? '不通过' : '未判定') + (v.reason ? '（' + v.reason + '）' : '') : '无')
  const summary = summarizeAcceptance(input.members || [])
  const acceptanceStatus = ACCEPTANCE_STATUSES.includes(input.acceptanceStatus) ? input.acceptanceStatus : summary.acceptanceStatus
  const acceptanceNote = String(input.acceptanceNote || summary.acceptanceNote || '')
  const notAccepted = ACCEPTANCE_BLOCKED.has(acceptanceStatus)
  const head = notAccepted ? acceptanceBlockedLine(summary.acceptanceRounds) + '\n\n' : ''
  const body = (input.members || []).map((m) => {
    const link = m.image ? '\n[image] ' + m.image : ''
    const error = m.error ? '\n失败：' + m.error : ''
    const text = String(m.text || '').trim()
    const reviews = [m.review ? '审校：' + verdict(m.review) : '', m.commanderVerdict ? '指挥审核：' + verdict(m.commanderVerdict) : ''].filter(Boolean).join(' · ')
    const acceptance = m.acceptance ? '\n验收：' + acceptanceStatusOfMember(m) : ''
    return '## ' + m.name + '（' + m.kind + (m.provider ? ' / ' + m.provider : '') + (m.model ? ' / ' + m.model : '') + '）\n' + (text || error || '（无产出）') + link + (reviews ? '\n' + reviews : '') + acceptance
  }).join('\n\n')
  const acceptanceSection = notAccepted
    ? '\n\n## 验收（本次调用）\n结论：' + acceptanceStatus + ' —— ' + acceptanceNote
      + '\n这不是交付物：不得描述为已完成；必须继续派返工，或如实告知用户失败原因。'
    : ''
  // 补员 / 回收 / 子会话 / 越权拦截 / 越权审计 / 子进程回收（与原 render 一致）
  const staffing = (input.staffingCreated || []).length
    ? '\n\n## 补员\n' + input.staffingCreated.map((line) => '- ' + line).join('\n')
    : ''
  const pruned = (input.pruned || []).length
    ? '\n\n## 回收\n已回收：' + input.pruned.map((m) => m.name + '（临时）').join('、')
    : ''
  const prunedSessions = Number(input.prunedSessions) > 0
    ? '\n\n## 子会话\n已清理 ' + input.prunedSessions + ' 个子会话目录'
    : ''
  const blockedDetail = String(input.selfWorkBlockedDetail || '')
  const blocked = Number(input.selfWorkBlocked) > 0
    ? '\n\n## 越权拦截\n- 父会话尝试自行执行 ' + input.selfWorkBlocked + ' 次写操作，已拦截' + (blockedDetail ? '（' + blockedDetail + '）' : '')
    : ''
  const selfRan = input.selfRan || {}
  const selfRanTotal = (Number(selfRan.bash) || 0) + (Number(selfRan.readImage) || 0) + (Number(selfRan.read) || 0)
  const selfRanSection = selfRanTotal > 0
    ? '\n\n## 越权审计\n- 父会话本次自行执行：bash×' + (Number(selfRan.bash) || 0) + '、read_image×' + (Number(selfRan.readImage) || 0) + '、read×' + (Number(selfRan.read) || 0)
      + '\n- 提示：这些应在小组内派给成员；如必要请说明理由'
    : ''
  const swept = Number(input.sweptChildren) > 0
    ? '\n\n## 子进程回收\n- 已释放 ' + input.sweptChildren + ' 个驻留子代理'
    : ''
  const planLine = input.plan && input.plan.confirmation ? '**指挥确认**：' + String(input.plan.confirmation) : ''
  return head + (planLine ? planLine + '\n\n' : '') + (body || '（本轮没有成员产出）') + staffing + pruned + prunedSessions + blocked + acceptanceSection + selfRanSection + swept
}

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
                reference: { type: 'string', description: '可选：参考图路径（仅 image 成员）；给了就按这张图重绘' },
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
            selfRan: {
              type: 'object',
              description: '自上次 council_delegate 回执以来，父会话自行执行的放行工具增量（只审计、不拦截）：bash / read_image / grep+glob+read+read_file。没有则全 0。',
              properties: {
                bash: { type: 'integer', description: '自上次回执以来自行执行的 bash 次数' },
                readImage: { type: 'integer', description: '自上次回执以来自行调用的 read_image 次数（自己看图判读）' },
                read: { type: 'integer', description: '自上次回执以来自行调用的 grep/glob/read/read_file 次数' },
              },
              additionalProperties: true,
            },
            plan: { type: 'object', additionalProperties: true },
            acceptanceStatus: {
              type: 'string',
              enum: ACCEPTANCE_STATUSES.slice(),
              description: '本次调用整体的验收结论：passed=通过；rejected=被否；rework-failed=返工没产出；unverified=审核没结论；none=本组没有审核位。非 passed 一律不是交付物。',
            },
            acceptanceNote: { type: 'string', description: '一句中文说明（与回执顶部的 ⛔ 提示同源）' },
            members: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  kind: { type: 'string' },
                  provider: { type: 'string', description: 'deepseek 成员实际使用的 provider（relay-deepseek / 回退 deepseek-official）' },
                  model: { type: 'string', description: 'deepseek 成员实际使用的模型 id' },
                  ok: { type: 'boolean' },
                  text: { type: 'string' },
                  image: { type: 'string' },
                  error: { type: 'string' },
                  acceptance: { type: 'string', description: '成员原始验收结论：none/passed/rejected/rework-failed/unverified/skipped/cancelled' },
                  acceptanceStatus: { type: 'string', enum: ACCEPTANCE_STATUSES.slice(), description: '归一后的验收状态（skipped/cancelled 归为 rejected）' },
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
          // 整次调用的验收结论：顶部 ⛔ 硬标记 + 结尾「## 验收（本次调用）」+ 结构化字段 acceptanceStatus
          // 全部由这一个 summary 得出，保证「回执文本」与「字段」永远一致。
          const summary = summarizeAcceptance(value.members || [])
          const acceptanceStatus = ACCEPTANCE_STATUSES.includes(value.acceptanceStatus) ? value.acceptanceStatus : summary.acceptanceStatus
          const acceptanceNote = String(value.acceptanceNote || summary.acceptanceNote || '')
          const notAccepted = ACCEPTANCE_BLOCKED.has(acceptanceStatus)
          const planLine = value.plan
            ? (value.plan.assignments && value.plan.assignments.length
              ? '## 指挥拆分（commander）\n' + value.plan.assignments.map((a, i) => `${i + 1}. ${a.member}：${a.task}`).join('\n')
              : '## 指挥拆分（commander）\n未能拆解：' + (value.plan.reason || value.plan.raw || '未知原因'))
            : ''
          const rows = (value.members || []).map((m) => {
            // 被看门狗静默终止 ≠ 普通失败：写明原因，别让回执看起来像代码/网络错误
            const idleTimeout = SILENT_KILL_REASONS.has(m.reason)
            const body = m.ok ? (m.text || '') : ((idleTimeout ? '静默超时终止：' : '失败：') + (m.error || ''))
            const image = m.image ? `\n[image] ${m.image}` : ''
            const review = m.review
              ? `\n${m.review.prelim ? '审校：' : '自审：'}${verdict(m.review.self)} · 指挥审核：${verdict(m.review.commander)}`
              : ''
            const accept = m.accepted === false
              ? `\n验收：未通过（${m.acceptance === 'rework-failed' ? '返工失败：' + (m.reworkError || '未返回产出') : m.acceptance === 'unverified' ? '审核未判定' : '审核拒绝'}）`
              : ''
            const noReview = m.acceptance === 'none' ? '\n验收：无审核位（本组没有审校/指挥），本轮未做验收' : ''
            const cont = m.continued ? `\n续跑：${m.continued} 次（上一轮被截断，已在同一子会话里接着跑）` : ''
            const watchdog = idleTimeout ? '\n状态：静默超时终止（看门狗判定成员长时间没有任何输出，不是普通失败）' : ''
            // deepseek 成员在回执里写明实际链路（provider / model），主会话默认模型另有配置
            const route = m.kind === 'deepseek' && (m.provider || m.model)
              ? ' / ' + [m.provider, m.model].filter(Boolean).join(' / ')
              : ''
            return `## ${m.name}（${m.kind}${route}）\n${body}${image}${review}${accept}${noReview}${cont}${watchdog}`
          })
          const body = rows.join('\n\n') || (planLine ? '（没有成员回执）' : '（没有成员回执：既没给 assignments，也没能由指挥拆解）')
          const head = notAccepted ? acceptanceBlockedLine(summary.acceptanceRounds) + '\n\n' : ''
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
          // 方案 B：父会话本次自行执行了放行工具（bash / read_image / 只读）→ 末尾审计一节。
          // 只审计、不拦截；三项全 0 时不输出，避免每条回执都挂一段噪音。
          const selfRan = {
            bash: Number(value.selfRan?.bash) || 0,
            readImage: Number(value.selfRan?.readImage) || 0,
            read: Number(value.selfRan?.read) || 0,
          }
          const selfRanTotal = selfRan.bash + selfRan.readImage + selfRan.read
          const selfRanSection = selfRanTotal > 0
            ? '\n\n## 越权审计\n- 父会话本次自行执行：bash×' + selfRan.bash + '、read_image×' + selfRan.readImage + '、read×' + selfRan.read
              + '\n- 提示：这些应在小组内派给成员；如必要请说明理由'
            : ''
          // 驻留子代理清扫：只有本轮真的 dispose 了东西才输出这一节（否则不挂噪音）
          const sweptChildren = Number(value.sweptChildren) || 0
          const sweptSection = sweptChildren > 0
            ? '\n\n## 子进程回收\n- 已释放 ' + sweptChildren + ' 个驻留子代理'
            : ''
          // 验收没通过：结尾再落一处结构化结论（与顶部 ⛔ 同一结论），父会话/程序都能对上
          const acceptanceSection = notAccepted
            ? '\n\n## 验收（本次调用）\n结论：' + acceptanceStatus + ' —— ' + acceptanceNote
              + '\n这不是交付物：不得描述为已完成；必须继续派返工，或如实告知用户失败原因。'
            : ''
          // ⛔ 必须是最开头的第一行（模型先看到它，不容易把失败当成果接着往下跑）
          if (value && value.background) {
            return [{ type: 'text', text: '已在后台派活（' + value.runId + '）：成员在后台跑，你随时可以继续说话；完成后用 council_collect 收结果。' }]
          }
          return [{ type: 'text', text: head + (planLine ? planLine + '\n\n' + body : body) + staffing + pruned + prunedSessions + blocked + acceptanceSection + selfRanSection + sweptSection }]
        },
      },
      async execute(args, exec) {
        const background = args && args.background !== undefined ? Boolean(args.background) : backgroundDelegations()
        const runId = 'job_' + randomUUID().slice(0, 8)
        const runOnce = async () => {
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
        const staffing = await ensureStaffing(live, args?.staffing, ephemeral, config)
        let assignments = Array.isArray(args && args.assignments) ? args.assignments : []
        let planRaw
        const requestText = args && typeof args.request === 'string' ? args.request.trim() : ''
        if ((!assignments.length) && requestText) {
          const planned = await planWithCommander(ctx, live, args.request.trim(), config, exec && exec.agent, callId)
          staffing.push(...await ensureStaffing(live, planned.staffing, ephemeral, config))
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
        staffing.push(...await ensureStaffing(live, missingRoles, ephemeral, config))
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
          // 放弃等待兜底：取消后 2 秒内强制结束，避免永久挂起
          const abortPromise = new Promise((resolve) => {
            if (!callId) return
            const signal = signalFor(callId)
            if (!signal) return
            const handler = () => {
              setTimeout(() => {
                resolve({ name: member.name, kind: member.kind, ok: false, text: '', error: '已取消，成员未完成', accepted: false, acceptance: 'cancelled' })
              }, 2000)
            }
            if (signal.aborted) handler()
            else signal.addEventListener('abort', handler, { once: true })
          })
          if (item && item.reference && member.kind === 'image') member.__reference = String(item.reference)
          const memberPromise = callMember(ctx, member, String(item.task || ''), config, live, item.style, exec && exec.agent, brief,
            (stage) => progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: stage }),
            (work) => {
              progressSet(callId, member.id, { name: member.name, kind: member.kind, stage: '审校中' })
              const body = work.ok
                ? (work.text || '')
                : ((SILENT_KILL_REASONS.has(work.reason) ? '静默超时终止：' : '失败：') + (work.error || ''))
              const route = member.kind === 'deepseek' && (work.provider || work.model)
                ? ' / ' + [work.provider, work.model].filter(Boolean).join(' / ')
                : ''
              append('## ' + member.name + '（' + member.kind + route + '）\n' + body + (work.image ? '\n[image] ' + work.image : ''))
            }, callId, childSessions)
          const result = await Promise.race([memberPromise, abortPromise])
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
            // 只有 deepseek 成员会带 provider（回执里写明 relay / 回退官方）
            ...result.provider === undefined ? {} : { provider: String(result.provider) },
            ...result.model === undefined ? {} : { model: String(result.model) },
            ok: Boolean(result.ok),
            text: result.text || '',
            ...result.image === undefined ? {} : { image: result.image },
            ...result.error === undefined ? {} : { error: String(result.error) },
            ...result.review === undefined ? {} : { review: result.review },
            ...result.accepted === undefined ? {} : { accepted: result.accepted },
            ...result.acceptance === undefined ? {} : { acceptance: result.acceptance },
            ...result.acceptance === undefined ? {} : { acceptanceStatus: acceptanceStatusOf(result.acceptance) },
            ...result.reworkError === undefined ? {} : { reworkError: String(result.reworkError) },
            ...result.reason === undefined ? {} : { reason: result.reason },
            ...SILENT_KILL_REASONS.has(result.reason) ? { idleTimeout: true } : {},
          }
        }))
        // 终态（含失败原因）已由 callMember 写；这里只给「没走到 callMember」的条目兜底补
        // finishedAt，绝不覆盖已有终态（旧实现无条件写「完成」，会把「终审（指挥）」洗成假完成）。
        for (const item of assignments) {
          const done = state.members.find((m) => m.id === item.member || m.name === item.member)
          if (!done) continue
          const slot = progressMap.get(callId)?.members?.[done.id]
          if (slot && slot.finishedAt) continue
          progressSet(callId, done.id, { finishedAt: Date.now(), stage: slot?.stage && slot.stage !== '排队中' ? slot.stage : '完成' })
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
              // 成员槽兜底：异常/崩溃路径没走到终态时也别留一个永远「静默 Ns」的成员条
              const nowMs = Date.now()
              for (const slot of Object.values(progressEntry.members || {})) {
                if (!slot || slot.finishedAt) continue
                slot.finishedAt = nowMs
                if (!slot.stage || slot.stage === '排队中') slot.stage = '已结束'
              }
              finishProgressEntry(progressEntry, nowMs)
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
          // 驻留子代理清扫：审核位 10 分钟、失联的工作子会话 30 分钟后释放（失败静默）。
          // 放在 finally：成功 / 抛错 / 提前 break 都会走到；回执「## 子进程回收」只报本轮真正释放数。
          try { response.sweptChildren = await sweepResidentChildren() } catch { response.sweptChildren = 0 }
        }
        // created 改成普通字段；pruned 保持字符串数组。出口再做一次 JSON 往返自检。
        response.staffingCreated = ephemeral.filter((id) => typeof id === 'string')
        // 方案 B：水位线口径 —— Δ = 当前累计 − 本组已报水位（只审计、不拦截）。
        // 放在出口统一算：提前 break / 正常返回都有值；没有就是全 0，不出 undefined。
        // 报完立刻把水位推到当前计数，于是「先跑 bash 再派活」会进下一次回执，
        // 而紧接着再派一次（期间无新调用）Δ 必为 0、不重复报。
        const selfRanNow = selfRanOf(selfWorkAuditFor(live.id))
        const selfRanMark = selfRanWatermarkFor(live.id)
        response.selfRan = selfRanDelta(selfRanNow, selfRanMark)
        Object.assign(selfRanMark, selfRanNow)
        // 验收结论（结构化）：与回执顶部 ⛔ 标记、结尾「## 验收（本次调用）」同源。
        // 放在出口统一算，保证每条 return 路径（提前 break / 抛错进了 finally）也带这两个字段。
        const acceptanceSummary = summarizeAcceptance(response.members)
        response.acceptanceStatus = acceptanceSummary.acceptanceStatus
        response.acceptanceNote = acceptanceSummary.acceptanceNote
        if (ACCEPTANCE_BLOCKED.has(acceptanceSummary.acceptanceStatus) && failOnRejectedAcceptance()) {
          const receipt = delegateReceiptText(response)
          throw new Error(
            acceptanceBlockedLine(acceptanceSummary.acceptanceRounds) + '\n\n' + receipt
            + '\n\n【硬性规则】验收未通过 ≠ 交付：本轮结果不能作为成果汇报；必须继续派返工（最多 maxRework 次），或如实告知用户失败原因。',
          )
        }
          return response
        }
        if (!background) return toolResult(await runOnce())
        const job = { runId, startedAt: Date.now(), status: 'running', sessionId: sessionIdOf(exec), promise: null, response: null, error: null }
        backgroundJobs.set(runId, job)
        job.promise = runOnce().then((value) => {
          job.status = 'done'; job.response = value; job.finishedAt = Date.now(); return value
        }).catch((error) => {
          job.status = 'failed'; job.error = String(error && error.message || error); job.finishedAt = Date.now(); throw error
        })
        if (job.promise && typeof job.promise.catch === 'function') job.promise.catch(() => {})
        return toolResult({ background: true, runId, status: 'running', members: [] })
      },
    }))
    disposers.push(agentCtx.tools.register({
      name: 'council_collect',
      description: '取回后台派活的结果：council_delegate 以 background 模式派活时会立刻返回 runId，成员在后台跑；完成后用这个工具收结果（可带等待秒数）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '派活返回的 runId；不填则取本会话最近一个后台任务' },
          waitSeconds: { type: 'number', description: '最多等待多少秒（默认 0 = 只查状态）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { status: { type: 'string' }, runId: { type: 'string' }, error: { type: 'string' }, members: { type: 'array', items: { type: 'object', additionalProperties: true } }, acceptanceStatus: { type: 'string' } },
        },
        render(_args, value) {
          if (!value || !value.runId) return [{ type: 'text', text: '没有后台派活记录' }]
          if (value.status === 'failed') return [{ type: 'text', text: '后台派活失败：' + String(value.error || '') }]
          if (value.status !== 'done') {
            return [{ type: 'text', text: '后台派活仍在进行（' + String(value.runId) + '）：' + (value.message || '') }]
          }
          return [{ type: 'text', text: delegateReceiptText(value) }]
        },
      },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const job = args && args.runId ? backgroundJobs.get(String(args.runId)) : latestBackgroundJob(sessionId)
        if (!job) return { status: 'none', error: '没有后台派活记录' }
        const waitSeconds = Math.max(0, Math.min(600, Number(args && args.waitSeconds) || 0))
        if (waitSeconds > 0 && job.promise) {
          await Promise.race([
            job.promise.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000)),
          ])
        }
        if (job.status === 'done') return toolResult(Object.assign({ runId: job.runId, status: 'done' }, job.response))
        if (job.status === 'failed') return { status: 'failed', runId: job.runId, error: job.error }
        return { status: 'running', runId: job.runId, message: '成员还在跑，稍后再收（或加 waitSeconds 等待）' }
      },
    }))
    disposers.push(agentCtx.tools.register({
      name: 'council_tell',
      description: '给正在运行的成员插话（相当于 “/btw”）：把用户的补充说明/纠正实时送进当前派活。deepseek 成员支持实时插话；claude 成员通过流式输入实时插话；codex 成员运行中不支持注入，只能排队到下一轮。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '要转达给成员的话（用户的补充指令/纠正）' },
          member: { type: 'string', description: '可选：指定成员名字；不填则投给本轮唯一在跑的成员' },
          callId: { type: 'string', description: '可选：指定派活 id' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { ok: { type: 'boolean' }, via: { type: 'string' }, memberName: { type: 'string' }, error: { type: 'string' } },
        },
        render(_args, value) {
          if (value && value.ok) return [{ type: 'text', text: '已转达给 ' + (value.memberName || '成员') + '（' + (value.via || '') + '）' }]
          return [{ type: 'text', text: '未能转达：' + String(value && value.error || '未知原因') }]
        },
      },
      async execute(args) {
        const text = String(args && args.text || '').trim()
        if (!text) return { ok: false, error: 'text 不能为空' }
        const sessionId = normalizeSessionId(exec && exec.agent && exec.agent.id)
        const live = Array.from(progressMap.entries())
          .filter(([, entry]) => !entry.finishedAt && (!sessionId || normalizeSessionId(entry.sessionId) === sessionId))
        if (!live.length) return { ok: false, error: '当前没有正在运行的派活' }
        const targetCallId = args.callId || live[live.length - 1][0]
        // member 可以是成员名 / 成员 id：从进度条目里找出对应 slot
        let memberKey
        if (args.member) {
          const wanted = String(args.member)
          const entry = progressMap.get(targetCallId)
          const slots = entry && entry.members ? entry.members : {}
          for (const [id, slot] of Object.entries(slots)) {
            if (id === '__stage__') continue
            if (id === wanted || (slot && slot.name === wanted)) { memberKey = id; break }
          }
          if (!memberKey) memberKey = wanted
        }
        const result = await steerRunningMember(targetCallId, text, memberKey)
        return toolResult(result)
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
          return toolResult(result)
        }
        if (args.action === 'list') {
          const members = (live.memberIds || [])
            .map((id) => state.members.find((m) => m.id === id))
            .filter(Boolean)
            .map((m) => {
              const role = m.roleId ? state.roles.find((r) => r.id === m.roleId) : undefined
              // 宁可给 null 也不产 undefined：成员缺 model / roleId / roleName / cwd 时，
              // undefined 会让 DSH 判「value is not lossless JSON」并整条工具调用失败。
              return { id: m.id, name: m.name, kind: m.kind, model: m.model ?? null, roleId: m.roleId ?? null, roleName: role?.name ?? null, cwd: m.cwd ?? null }
            })
          return toolResult({ members })
        }
        if (args.action === 'create') {
          const defaultModels = { codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5', deepseek: DEEPSEEK_MEMBER_MODEL, image: 'gpt-image-2.6-flare' }
          const kind = args.kind && defaultModels[args.kind] ? args.kind : 'codex'
          // 默认建持久成员（现有行为）；显式 persistent:false 才建临时成员，与 staffing 的 persistent 语义一致
          const persistent = args.persistent !== false
          const member = {
            id: `m_${randomUUID().slice(0, 8)}`,
            name: args.name || '新成员',
            kind,
            model: args.model || defaultModels[kind],
            provider: kind === 'deepseek' ? deepseekMemberProvider(config) : undefined,
            roleId: args.roleId,
            cwd: args.cwd || undefined,
            updatedAt: Date.now(),
          }
          if (!persistent) member.ephemeral = true
          state.members.push(member)
          if (!live.memberIds.includes(member.id)) live.memberIds.push(member.id)
          await save()
          return toolResult({ ok: true, persistent, member: { id: member.id, name: member.name, kind: member.kind, model: member.model, persistent } })
        }
        if (args.action === 'update') {
          if (!args.id) return toolResult({ ok: false, error: 'id required for update' })
          const member = state.members.find((m) => m.id === args.id)
          if (!member) return toolResult({ ok: false, error: 'member not found: ' + args.id })
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
          return toolResult({ ok: true, member: { id: member.id, name: member.name, kind: member.kind, model: member.model ?? null } })
        }
        if (args.action === 'delete') {
          if (!args.id) return toolResult({ ok: false, error: 'id required for delete' })
          const inGroup = (live.memberIds || []).includes(args.id)
          if (!inGroup) return toolResult({ ok: false, error: 'member not in this group' })
          if (live.memberIds.length <= 1) return toolResult({ ok: false, error: 'cannot delete the last member' })
          const agents = ctx.get('agents')
          const parentAgent = agents ? agents.get(live.sessionId) : undefined
          if (parentAgent && args.id === parentAgent.id) return toolResult({ ok: false, error: 'cannot delete the parent session' })
          state.members = state.members.filter((m) => m.id !== args.id)
          live.memberIds = live.memberIds.filter((id) => id !== args.id)
          delete state.usage[args.id]
          await save()
          return toolResult({ ok: true })
        }
        return toolResult({ ok: false, error: 'unknown action' })
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
            id: r.id, name: r.name, prompt: r.prompt ?? null, color: r.color ?? null,
            kind: r.kind ?? null, model: r.model ?? null,
            defaultKind: roleKind(r) ?? null, defaultModel: staffTarget(r, undefined, undefined).model ?? null,
          }))
          return toolResult({ roles })
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
          return toolResult({ ok: true, role: { id: role.id, name: role.name } })
        }
        if (args.action === 'update') {
          if (!args.id) return toolResult({ ok: false, error: 'id required for update' })
          const role = state.roles.find((r) => r.id === args.id)
          if (!role) return toolResult({ ok: false, error: 'role not found: ' + args.id })
          if (args.name !== undefined) role.name = args.name
          if (args.prompt !== undefined) role.prompt = args.prompt
          if (args.color !== undefined) role.color = args.color
          // 换框架但没给模型：清掉旧框架的模型，回落到新框架的默认模型
          if (args.kind !== undefined && args.kind !== role.kind && args.model === undefined) delete role.model
          Object.assign(role, pick(args, ['kind', 'model']))
          await save()
          return toolResult({ ok: true, role: { id: role.id, name: role.name } })
        }
        if (args.action === 'delete') {
          if (!args.id) return toolResult({ ok: false, error: 'id required for delete' })
          state.roles = state.roles.filter((r) => r.id !== args.id)
          for (const m of state.members) if (m.roleId === args.id) delete m.roleId
          await save()
          return toolResult({ ok: true })
        }
        if (args.action === 'assign') {
          if (!args.id) return toolResult({ ok: false, error: 'role id required for assign' })
          if (!args.memberId) return toolResult({ ok: false, error: 'memberId required for assign' })
          const role = state.roles.find((r) => r.id === args.id)
          if (!role) return toolResult({ ok: false, error: 'role not found: ' + args.id })
          const member = state.members.find((m) => m.id === args.memberId)
          if (!member) return toolResult({ ok: false, error: 'member not found: ' + args.memberId })
          member.roleId = args.id
          await save()
          return toolResult({ ok: true, member: { id: member.id, name: member.name, roleName: role.name } })
        }
        return toolResult({ ok: false, error: 'unknown action' })
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
          return toolResult({
            maxRework: live.maxRework ?? 1,
            requirePrelim: live.requirePrelim ?? true,
            requireCommander: live.requireCommander ?? true,
            standard: live.standard ?? '',
            commanderPrompt: live.commanderPrompt ?? '',
          })
        }
        if (args.action === 'set') {
          if (args.maxRework !== undefined) live.maxRework = Math.max(0, Math.floor(args.maxRework))
          if (args.requirePrelim !== undefined) live.requirePrelim = Boolean(args.requirePrelim)
          if (args.requireCommander !== undefined) live.requireCommander = Boolean(args.requireCommander)
          if (args.standard !== undefined) live.standard = String(args.standard)
          if (args.commanderPrompt !== undefined) live.commanderPrompt = String(args.commanderPrompt)
          await save()
          return toolResult({
            ok: true,
            maxRework: live.maxRework ?? 1,
            requirePrelim: live.requirePrelim ?? true,
            requireCommander: live.requireCommander ?? true,
            standard: live.standard ?? '',
            commanderPrompt: live.commanderPrompt ?? '',
          })
        }
        return toolResult({ ok: false, error: 'unknown action' })
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

const CATALOG_KINDS = ['codex', 'claude', 'deepseek', 'image']

/**
 * 拉一份完整模型目录，同时按框架收集各自的报错。
 * 返回 { value, errors }：value 就是 /models 的老结构（含合并后的 error 字段）。
 * `only` 只重算命中的框架，其余沿用 `base` 里的旧值（给 POST /models/refresh 用）。
 */
async function fetchCatalog(ctx, config, only, base) {
  const picked = Array.isArray(only) && only.length ? only : CATALOG_KINDS
  const want = (kind) => picked.indexOf(kind) >= 0
  const value = Object.assign({ codex: [], claude: [], deepseek: [], image: [], error: null }, base || {})
  value.error = null
  const errors = {}
  const fail = (kind, error) => {
    const message = String(error?.message ?? error)
    errors[kind] = errors[kind] || message
    value.error = value.error || message
  }
  // settings must live in function scope: the later claude/image branches use it too.
  const settings = apiSettings(config)
  if (want('codex') || want('image')) try {
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
      value.image = pickImageModels(ids)
    }
  } catch (error) { fail('codex', error) }
  if (want('claude')) try {
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
  } catch (error) { fail('claude', error) }
  if (want('deepseek')) try {
    // listModels(provider) is async and throws NO_ADAPTER for an unknown route, so the
    // provider id must be checked first — a bare listModels() rejects unhandled and takes
    // the whole host process down with it.
    const llm = ctx.get('llm')
    if (llm && typeof llm.listModels === 'function') {
      // 先试 relay-deepseek，失败再试 deepseek-official（静态列表，不再预检 listProviders）
      const provider = deepseekMemberProvider(config, ctx)
      try {
        value.deepseek = (await llm.listModels(provider)).map((m) => m.id)
      } catch {
        // relay 失败 → 回退官方
        if (provider !== DEEPSEEK_OFFICIAL_PROVIDER) {
          try {
            value.deepseek = (await llm.listModels(DEEPSEEK_OFFICIAL_PROVIDER)).map((m) => m.id)
          } catch { /* keep empty */ }
        }
      }
    }
  } catch { /* keep empty */ }
  if (want('deepseek') && !value.deepseek.length) value.deepseek = [DEEPSEEK_MEMBER_MODEL]
  if (want('image') && config.imageApiKey) {
    try {
      const response = await fetch(settings.codexBase + '/v1/models', {
        headers: { authorization: 'Bearer ' + settings.imageKey },
      })
      if (response.ok) {
        const data = await response.json()
        value.image = pickImageModels((data.data ?? []).map((m) => m.id))
      }
    } catch (error) { fail('image', error) }
  }
  if (want('image') && !value.image.length) value.image = [...IMAGE_MODEL_FALLBACK]
  return { value, errors }
}

/** 缓存未命中（或超过 10 分钟 TTL）时才真的重拉。 */
async function modelCatalog(ctx, config) {
  if (catalog && Date.now() - catalog.at < 10 * 60_000) return catalog.value
  const { value } = await fetchCatalog(ctx, config)
  if (value.codex.length || value.claude.length) catalog = { at: Date.now(), value }
  return value
}

/**
 * 丢掉缓存重拉（POST /models/refresh）。
 * source='all'（默认）拉全部；其余只重算那一份框架，其它沿用缓存/上次结果，
 * 这样「只刷出图」不会因为 claude base 没配而被一条错误整体污染。
 */
async function refreshCatalog(ctx, config, source) {
  const picked = source && source !== 'all' ? [source] : CATALOG_KINDS
  for (const kind of picked) if (CATALOG_KINDS.indexOf(kind) < 0) throw new Error('unknown source ' + kind)
  const base = catalog ? catalog.value : null
  const { value, errors } = await fetchCatalog(ctx, config, picked, base)
  catalog = { at: Date.now(), value }
  return { catalog: value, errors, at: catalog.at }
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

/**
 * GET /providers: 返回可用的 provider 列表，优先从 ctx.llm 获取，失败则返回空数组。
 *
 * 返回格式：{ providers: [{ id, name, models }] }
 * - 优先使用 ctx.get('llm')?.listProviders() 获取 provider 列表
 * - 对每个 provider，尝试用 llm.listModels(providerId) 获取模型列表
 * - 如果获取失败，models 返回空数组（不影响其他 provider）
 *
 * 降级行为：
 * - 无 ctx.llm：返回空数组
 * - listProviders() 失败：返回空数组
 * - listModels() 失败：该 provider 的 models 为空数组
 */
/** provider 模型列表缓存：id -> { at, models }（默认 5 分钟；refresh 强制重探） */
const providerModelCache = new Map()
const PROVIDER_MODELS_TTL_MS = 5 * 60_000

async function listProviders(ctx, config, options = {}) {
  const providers = []

  try {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (!llm || typeof llm.listProviders !== 'function') {
      return { providers: [] }
    }

    const providerList = llm.listProviders()
    if (!Array.isArray(providerList) || providerList.length === 0) {
      return { providers: [] }
    }

    for (const provider of providerList) {
      const id = provider?.id || provider?.provider?.id
      const name = provider?.name || provider?.provider?.name || id

      if (!id) continue

      const cached = providerModelCache.get(String(id))
      if (!options.refresh && cached && Date.now() - cached.at < PROVIDER_MODELS_TTL_MS) {
        providers.push({ id: String(id), name: String(name), models: cached.models })
        continue
      }
      let models = []
      // 尝试获取该 provider 的模型列表
      try {
        if (typeof llm.listModels === 'function') {
          const modelList = await llm.listModels(id)
          if (Array.isArray(modelList)) {
            models = modelList.map(m => typeof m === 'string' ? m : (m?.id || m?.name || String(m)))
          }
        }
      } catch {
        models = []
      }
      // 刷新模式或没有缓存（冷启动）：用该 provider 的 base/key 去问 /v1/models
      if (!cached || options.refresh) {
        try {
          const endpoint = await providerEndpoint(id, ctx)
          if (endpoint && endpoint.baseURL) {
            const url = rootUrl(endpoint.baseURL) + '/v1/models'
            const response = await fetch(url, { headers: endpoint.key ? { authorization: 'Bearer ' + endpoint.key } : {} })
            if (response.ok) {
              const data = await response.json()
              const ids = (data.data ?? []).map((m) => m && (m.id || m.name)).filter(Boolean)
              const remote = ids.filter((x) => !String(x).startsWith('gpt-image'))
              if (remote.length) models = remote
            }
          }
        } catch { /* 探测失败就沿用已有列表 */ }
      }

      if (models.length) providerModelCache.set(String(id), { at: Date.now(), models })
      // 没有模型的 provider（例如尚未授权的账号型 provider）不列出来，避免选到空列表
      if (!models.length) continue
      providers.push({
        id: String(id),
        name: String(name),
        models,
      })
    }

    return { providers }
  } catch {
    return { providers: [] }
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


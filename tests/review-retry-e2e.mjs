/**
 * 审校「非 JSON → 自动换新会话重试一次」的**端到端**验证。
 *
 * ⚠️ 这个脚本会**真实调用 LLM**（claude 腿，约 20–25 秒 / 场景），**不要**放进常规测试套件。
 * 单测请跑 tests/staffing-test.mjs（审核③④⑤，纯 mock，秒级）。
 *
 * 它验证的是单测覆盖不到的部分：真实模型真的会拿纯文本/问候糊弄审校，
 * 而 runReviewTurn 必须在这时换新会话重试，并且：
 *   - 两次都拿不到 {ok,reason} → {ok:false, reason:'审核输出无法解析（已重试）'}（绝不是 ok:null）
 *   - 第一次问候、第二次成功  → 按第二次判定
 *
 * 用法：node tests/review-retry-e2e.mjs [--case=both|unparsed|greeting]
 * 环境：用临时 DSH_HOME + 真实 council.json 副本，**不碰** ~/.dsh 的生产数据。
 */
import { mkdtemp, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const STATE = path.join(process.env.HOME || '/home/nanami', '.dsh', 'storages', 'council.json')
const arg = process.argv.find((a) => a.startsWith('--case='))
const only = arg ? arg.slice('--case='.length) : 'both'
const TIMEOUT_MS = 150_000

const source = await readFile(path.join(ROOT, 'index.js'), 'utf8')
const home = await mkdtemp(path.join(tmpdir(), 'council-review-e2e-'))
await mkdir(path.join(home, 'storages'), { recursive: true })
// 用真实配置（providerByKind → relay-claude 的 base/key 从 profile 读），但写在临时 HOME 里
await copyFile(STATE, path.join(home, 'storages', 'council.json'))
const modFile = path.join(home, 'index.exposed.mjs')
await writeFile(modFile, `${source}
export { load, runReviewTurn, selfReview }
`, 'utf8')
process.env.DSH_HOME = home
const mod = await import(pathToFileURL(modFile).href)
await mod.load()

const ctx = { get: () => undefined }
// deepseek 腿要活的父 agent；这里统一用 claude 腿跑审校，和真实审校位的行为一致
const member = {
  id: 'm_review_e2e', name: '审校', kind: 'claude', model: 'claude-fable-5-2',
  provider: 'relay-claude', __noTools: true,
}
const group = { id: 'g_e2e', memberIds: [], standard: '', style: '' }

const results = []
function report(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

/* ── 场景 A：纯文本且内容没有 ok 字段 → 重试后仍是无效结构 → ok:false +「已重试」 ── */
if (only === 'both' || only === 'unparsed') {
  const started = Date.now()
  // 这个 prompt 故意不要求 {ok,reason} 结构
  const out = await mod.runReviewTurn(
    ctx, member, '用一句中文说说你觉得代码审查最重要的是什么。',
    {}, group, undefined, undefined, TIMEOUT_MS, 'e2e-unparsed', 'selfReview',
  )
  const ok = out.retried === true
    && out.verdict && out.verdict.ok === false
    && String(out.verdict.reason).includes('已重试')
  report('A 非 JSON → 重试一次 → ok:false +「已重试」（无 ok:null）', ok,
    `${((Date.now() - started) / 1000).toFixed(1)}s · retried=${out.retried} · verdict=${JSON.stringify(out.verdict)}`)
}

/* ── 场景 B：真实 selfReview（自带 {ok,reason} 模板）→ 必须拿到布尔判定 ── */
if (only === 'both' || only === 'greeting') {
  const started = Date.now()
  const verdict = await mod.selfReview(
    ctx, member, '只输出数字：9 的平方。不要解释。', { text: '81' },
    {}, group, undefined, undefined, 'e2e-self-ok',
  )
  const ok = typeof verdict.ok === 'boolean'
  report('B 正常路径 → 判定是布尔（问候会被重试兜住）', ok,
    `${((Date.now() - started) / 1000).toFixed(1)}s · verdict=${JSON.stringify(verdict)}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 场景通过`)
if (failed.length) process.exitCode = 1

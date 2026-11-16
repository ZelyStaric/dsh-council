// dsh-council 全量测试套件
// 用法: node tests/full-suite.mjs --phase=1|2|all
// Phase 2 用 Playwright（headless，不依赖物理显示器）+ 原生录屏

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const API = 'http://100.108.3.88:3080/council/api'
const ROOT = '/home/nanami/LLM/dsh-council'
const SHOTS = '/tmp/council-test-shots'
const VIDEO = '/tmp/council-test-video'
const REPORT = '/home/nanami/docs/dsh-council-test-report.md'
for (const d of [SHOTS, VIDEO]) if (!existsSync(d)) mkdirSync(d, { recursive: true })

const results = []
function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail: detail || '' })
  console.log((ok ? 'PASS ' : 'FAIL ') + id.padEnd(6) + ' ' + name + (ok ? '' : '   <- ' + (detail || '')))
}

async function get(p) {
  try {
    const r = await fetch(API + p)
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, json, text }
  } catch (e) {
    // 连接被服务端断掉（例如 /file 的 200 分支 pipe 失败）——不要把整个测试带崩
    return { status: 0, json: null, text: '', error: String(e.message || e) }
  }
}

const src = readFileSync(ROOT + '/index.js', 'utf8')
const client = readFileSync(ROOT + '/client.js', 'utf8')

async function phase1() {
  console.log('\n=== Phase 1: API / data / static permissions ===')
  const f1 = await get('/team/state?sessionId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  record('F1', '/team/state no-group -> 400', f1.status === 400, 'got ' + f1.status)

  const f2a = await get('/file?path=' + encodeURIComponent('/etc/passwd'))
  const f2b = await get('/file?path=' + encodeURIComponent('/home/nanami/.dsh/storages/council.json'))
  record('F2', '/file rejects /etc, allows HOME', f2a.status === 403 && f2b.status === 200,
    '/etc=' + f2a.status + ' HOME=' + f2b.status + (f2b.status === 0 ? ' (connection dropped: ' + f2b.error + ')' : ''))

  const f2c = await get('/file?path=' + encodeURIComponent('/home/nanami/../../../etc/shadow'))
  record('F2b', '/file rejects traversal', f2c.status === 403 || f2c.status === 404, 'got ' + f2c.status)

  const f2d = await get('/file?path=' + encodeURIComponent('/tmp'))
  record('F2c', '/file allows /tmp (not 403)', f2d.status !== 403, 'got ' + f2d.status)

  let storeFiles = []
  try { storeFiles = readdirSync('/home/nanami/.dsh/storages/council-team').filter((f) => f.endsWith('.json')) } catch {}
  record('F3', 'team messages persisted', storeFiles.length > 0, 'files ' + storeFiles.length)

  let logOk = 0, logBad = 0
  try {
    const dirs = readdirSync('/home/nanami/.dsh/sessions/--home-nanami--').filter((d) => d.startsWith('session-')).slice(-3)
    for (const d of dirs) {
      const f = '/home/nanami/.dsh/sessions/--home-nanami--/' + d + '/session.v4.jsonl.zstd'
      if (!existsSync(f)) continue
      try {
        const out = execFileSync('zstd', ['-d', '-c', f], { maxBuffer: 256 * 1024 * 1024 }).toString()
        let bad = 0
        for (const line of out.split('\n').filter(Boolean)) {
          try {
            const ev = JSON.parse(line)
            if (ev.type === 'user/message' && (!ev.data || !ev.data.id || !ev.data.role)) bad += 1
          } catch { bad += 1 }
        }
        if (bad === 0) logOk += 1; else logBad += 1
      } catch { logBad += 1 }
    }
  } catch {}
  record('F4', 'session logs loadable, no missing id/role', logBad === 0 && logOk > 0, 'ok=' + logOk + ' bad=' + logBad)

  let jsonOk = false
  try {
    const j = JSON.parse(readFileSync('/home/nanami/.dsh/storages/council.json', 'utf8'))
    jsonOk = Array.isArray(j.groups) && Array.isArray(j.members)
  } catch { jsonOk = false }
  record('F5', 'council.json parseable', jsonOk, 'parse failed')

  record('C1', 'main session whitelist council_* only', src.includes("startsWith('council_')") && src.includes('SELF_WORK_DENY_REASON'), 'no guard')
  record('C9', 'member MCP input removed', !client.includes("placeholder: '留空 = 由指挥按任务决定"), 'input still there')
  record('C10', 'commander MCP follows brainPermissions', src.includes('mcpServers: brainOpen ? undefined : []'), 'no mapping')

  const c2 = src.includes("'--disallowedTools', 'Bash', 'Edit', 'Write'") && !src.includes("'--disallowedTools', 'Bash', 'Read'")
  record('C2', 'claude keeps Read/Grep/Glob', c2, 'Read still disallowed')
  record('C3', 'codex uses read-only sandbox', src.includes("args.push('--sandbox', 'read-only')"), 'not found')
  record('C4', 'gemini uses plan mode', src.includes("args.push('--approval-mode', noTools ? 'plan' : 'yolo')"), 'not found')
  record('C5', 'deepseek commander uses council-readonly', src.includes("'council-readonly'"), 'not found')

  record('D3', 'prelim review has hard timeout', src.includes('withHardLimit'), 'not found')
  record('D7', 'review chain is serial', /selfReview[\s\S]{0,3000}?prelimReview[\s\S]{0,3000}?commanderReview/.test(src), 'order wrong')

  let d2ok = false, d2detail = ''
  const m = src.match(/function verdictOf\(text\) \{[\s\S]*?\n\}/)
  if (m) {
    try {
      const fn = new Function('return ' + m[0])()
      d2ok = fn('x\nVERDICT: PASS') && fn('x\nVERDICT: PASS').ok === true
        && fn('x\nVERDICT: FAIL') && fn('x\nVERDICT: FAIL').ok === false
        && fn('x\nVERDICT: FAIL MAJOR') && fn('x\nVERDICT: FAIL MAJOR').severity === 'major'
        && fn('x\nVERDICT: FAIL\nOWNER: OTHER') && fn('x\nVERDICT: FAIL\nOWNER: OTHER').owner === 'other'
    } catch (e) { d2detail = String(e.message) }
  } else d2detail = 'extract failed'
  record('D2', 'VERDICT 3 states + OWNER parse', d2ok, d2detail)

  record('C11', 'self-work audit present', src.includes('selfWorkAuditFor') && src.includes('selfWorkNotePermit') || src.includes('noteSelfWorkPermit'), 'not found')
}

function tokenUrl() {
  const log = readFileSync('/home/nanami/dsh-web.log', 'utf8')
  const m = log.match(new RegExp('http://[^ ]*token=[A-Za-z0-9_-]*', 'g'))
  if (!m || !m.length) throw new Error('no token url')
  return m[m.length - 1]
}

async function phase2() {
  console.log('\n=== Phase 2: browser UI (headless + video) ===')
  const { chromium } = await import('/home/nanami/.cache/pw/node_modules/playwright-core/index.mjs')
  const url = tokenUrl()
  const browser = await chromium.launch({
    executablePath: '/home/nanami/.cache/ms-playwright/chromium-1148/chrome-linux/chrome',
    args: ['--no-sandbox'],
  })

  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      colorScheme: scheme,
      recordVideo: { dir: VIDEO, size: { width: 1400, height: 900 } },
    })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)))
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(2800)

    await page.screenshot({ path: SHOTS + '/home-' + scheme + '.png' })
    record('E5-' + scheme, scheme + ' home no JS error', errs.length === 0, errs.join(' | '))

    const st = await get('/state')
    const bound = ((st.json && st.json.state && st.json.state.groups) || [])
      .filter((g) => g.sessionId && !g.archived).map((g) => g.sessionId)
    // 用**完整** sessionId（短 id 会让 /team/state 匹配不到）
    const shortId = bound.length ? String(bound[0]) : null

    // 遍历所有绑定组，找**真的有消息**的那个（第一个组常常是空的）
    let best = null
    for (const sid of bound) {
      const ts = await get('/team/state?sessionId=' + sid)
      if (ts.status !== 200) continue
      const ms = (ts.json && ts.json.messages) || []
      if (!best || ms.length > best.count) best = { sid, count: ms.length, msgs: ms }
    }
    record('E1-' + scheme, 'group session /team/state ok', Boolean(best), best ? 'best=' + best.sid.slice(0, 12) + ' msgs=' + best.count : 'no readable group')
    if (best) {
      record('E2-' + scheme, 'timeline has messages', best.count > 0, 'count ' + best.count)
      const plans = best.msgs.filter((x) => x.plan)
      record('B1-' + scheme, 'timeline has plan entries', plans.length > 0, 'plans ' + plans.length)
      const thumbs = best.msgs.filter((x) => x.image || /!?\[[^\]]*\]\([^)]+\.(png|jpe?g|webp)/i.test(String(x.text || '')))
      record('A3-' + scheme, 'timeline has image outputs', thumbs.length > 0, 'images ' + thumbs.length)
    }

    const video = page.video()
    await ctx.close()
    try {
      const v = await video.path()
      record('V-' + scheme, scheme + ' video recorded', Boolean(v && existsSync(v)), String(v))
    } catch { record('V-' + scheme, scheme + ' video recorded', false, 'path failed') }
  }

  await browser.close()
}

function writeReport(label) {
  const pass = results.filter((r) => r.ok).length
  const fail = results.length - pass
  const lines = []
  lines.push('\n### ' + label + ' (' + new Date().toLocaleString('zh-CN') + ')\n')
  lines.push('**' + pass + ' passed / ' + fail + ' failed** (' + results.length + ' total)\n')
  lines.push('| # | item | result | evidence |')
  lines.push('|---|---|---|---|')
  for (const r of results) {
    lines.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.ok ? 'PASS' : '**FAIL**') + ' | ' + String(r.detail).replace(/\|/g, '/').slice(0, 140) + ' |')
  }
  lines.push('')
  const header = existsSync(REPORT) ? '' : '# dsh-council full test report\n\n> generated by tests/full-suite.mjs; no bug fixes and no restarts during testing.\n'
  writeFileSync(REPORT, header + lines.join('\n'), { flag: existsSync(REPORT) ? 'a' : 'w' })
  console.log('\nreport -> ' + REPORT + ' (' + pass + ' PASS / ' + fail + ' FAIL)')
}

const phaseArg = (process.argv.find((a) => a.startsWith('--phase=')) || '--phase=all').split('=')[1]
if (phaseArg === '1' || phaseArg === 'all') {
  await phase1()
  writeReport('Phase 1: API and data')
}
if (phaseArg === '2' || phaseArg === 'all') {
  const before = results.length
  try { await phase2() } catch (e) { console.error('Phase2 error:', e.message) }
  if (results.length > before) writeReport('Phase 2: browser UI')
}

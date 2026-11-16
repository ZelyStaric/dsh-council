#!/usr/bin/env node
/**
 * tab 可见性冒烟测试（v0.4.29）
 *
 * 断言（用户需求 2026-11-16）：
 *   单人模式  → 显示 对话 + 轨迹，**隐藏** 团队 / 小组
 *   小组模式  → 显示 团队 + 轨迹 + 小组，**隐藏** 对话
 *   切换后 3 秒内状态必须稳定（不得「闪一下就没了」）
 *
 * 用法：
 *   node tests/tab-visibility-smoke.mjs                # 用默认会话「测试团队 tab 显隐」
 *   node tests/tab-visibility-smoke.mjs --session=xxx  # 指定会话标题片段
 *   node tests/tab-visibility-smoke.mjs --new          # 新建一个会话从单人开始测
 *
 * 依赖：playwright-core + 本机 chromium 缓存（见 handoff 文档）、服务在跑。
 * 这是**集成测试**（需要真服务 + 浏览器），不进 `node tests/staffing-test.mjs` 那一套单元测试。
 */
import { readFileSync } from 'node:fs'

// playwright-core 不是本包的依赖（它是**集成测试**工具）。按顺序找：
//   ① 本目录 node_modules（npm i --no-save playwright-core）
//   ② PW_DIR 指定的目录
//   ③ /tmp/pw（本机临时装过一次的位置）
let chromium
{
  const candidates = [
    'playwright-core',
    process.env.PW_DIR ? process.env.PW_DIR + '/node_modules/playwright-core/index.mjs' : '',
    '/tmp/pw/node_modules/playwright-core/index.mjs',
  ].filter(Boolean)
  let lastError = null
  for (const spec of candidates) {
    try { ({ chromium } = await import(spec)); break } catch (e) { lastError = e }
  }
  if (!chromium) {
    console.error('需要 playwright-core 才能跑本集成测试。装一下：')
    console.error('  cd ~/LLM/dsh-council && npm i --no-save playwright-core')
    console.error('  # 或  PW_DIR=/some/dir node tests/tab-visibility-smoke.mjs')
    console.error('原始错误：', String(lastError && lastError.message || lastError))
    process.exit(2)
  }
}

const CHROME = '/home/nanami/.cache/ms-playwright/chromium-1148/chrome-linux/chrome'
const DSH = process.env.DSH_BASE || 'http://100.108.3.88:3080'
const args = process.argv.slice(2)
const wantNew = args.includes('--new')
const sessionHint = (args.find((a) => a.startsWith('--session=')) || '').split('=')[1] || '测试团队 tab 显隐'

/** 从 ~/dsh-web.log 里取带 token 的启动 URL（没有就走 DSH_BASE） */
function tokenUrl() {
  try {
    const log = readFileSync('/home/nanami/dsh-web.log', 'utf8')
    const m = log.match(/http:\/\/[^\s]*token=[A-Za-z0-9_-]+/g)
    if (m && m.length) return m[m.length - 1]
  } catch { /* ignore */ }
  return DSH + '/'
}

const SHOT_DIR = process.env.SHOT_DIR || '/tmp/pw/shots'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
const tabLogs = []
page.on('console', (m) => { const t = m.text(); if (t.includes('[council:tab]')) tabLogs.push(t) })

/** 读当前 tab 状态：{ 对话: 'show'|'hidden', ... } */
const readTabs = () => page.evaluate(() => {
  const list = document.querySelector('[data-conversation-tabs]')
  if (!list) return null
  const out = {}
  for (const b of list.querySelectorAll('button[role="tab"]')) {
    out[(b.textContent || '').trim()] = b.style.display === 'none' ? 'hidden' : 'show'
  }
  return out
})

/** 整屏截图（证据）：动作与断言分开，截图只在采样结束后拍 */
async function shot(name) {
  try {
    await page.screenshot({ path: `${SHOT_DIR}/tab-${name}.png` })
    console.log(`shot ${SHOT_DIR}/tab-${name}.png`)
  } catch (e) {
    console.log(`shot ${name} FAILED: ${e && e.message}`)
  }
}

/** 连续采样，返回是否出现过抖动（同一签名在 3 秒内变化过） */
async function sampleStability(ms = 3000, step = 150) {
  const sigs = []
  for (let t = 0; t < ms; t += step) {
    const tabs = await readTabs()
    sigs.push(JSON.stringify(tabs))
    await page.waitForTimeout(step)
  }
  const uniq = [...new Set(sigs)]
  return { stable: uniq.length === 1, signatures: uniq, final: JSON.parse(sigs[sigs.length - 1]) }
}

try {
  await page.goto(tokenUrl(), { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(2500)
  await page.evaluate(() => { window.__councilTabDebug = true })

  if (wantNew) {
    await page.getByText('新会话', { exact: true }).first().click().catch(() => {})
    await page.waitForTimeout(1500)
    const box = page.locator('textarea, [contenteditable="true"]').first()
    await box.click()
    await box.fill('tab 可见性冒烟')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(9000)
  } else {
    // 会话多了以后侧边栏会折叠（「展开其余 N 个会话」），旧会话直接点不到 → 先展开
    for (let i = 0; i < 8; i++) {
      const visible = await page.getByText(sessionHint, { exact: false }).first().isVisible().catch(() => false)
      if (visible) break
      const expand = page.getByText(/^展开其余/).first()
      if (!(await expand.isVisible().catch(() => false))) break
      await expand.click().catch(() => {})
      await page.waitForTimeout(600)
    }
    await page.getByText(sessionHint, { exact: false }).first().click()
    await page.waitForTimeout(3500)
  }

  // 先切成单人（保证起点确定）
  await page.getByText('单人', { exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(2000)

  /* ── ① 单人模式 ─────────────────────────────────────── */
  {
    const s = await sampleStability(2400)
    const t = s.final || {}
    check('① 单人模式：状态稳定', s.stable, s.stable ? '' : '出现抖动：' + s.signatures.join(' → '))
    check('① 单人模式：对话可见', t['对话'] === 'show', `对话=${t['对话']}`)
    check('① 单人模式：轨迹可见', t['轨迹'] === 'show', `轨迹=${t['轨迹']}`)
    check('① 单人模式：团队隐藏', t['团队'] === 'hidden', `团队=${t['团队']}`)
    check('① 单人模式：小组隐藏', t['小组'] === 'hidden', `小组=${t['小组']}`)
    await shot('1-solo')
  }

  /* ── ② 切到小组 ─────────────────────────────────────── */
  tabLogs.length = 0
  await page.getByText('小组', { exact: true }).first().click()
  await page.waitForTimeout(400)
  {
    const s = await sampleStability(3000)
    const t = s.final || {}
    check('② 切小组后 3 秒内状态稳定（不闪退）', s.stable,
      s.stable ? '' : '出现抖动：' + s.signatures.join(' → '))
    check('② 小组模式：团队可见', t['团队'] === 'show', `团队=${t['团队']}`)
    check('② 小组模式：小组可见', t['小组'] === 'show', `小组=${t['小组']}`)
    check('② 小组模式：轨迹可见（用户要求保留）', t['轨迹'] === 'show', `轨迹=${t['轨迹']}`)
    check('② 小组模式：对话隐藏', t['对话'] === 'hidden', `对话=${t['对话']}`)
    await shot('2-group')
  }

  /* ── ③ 切回单人 ─────────────────────────────────────── */
  await page.getByText('单人', { exact: true }).first().click()
  await page.waitForTimeout(400)
  {
    const s = await sampleStability(3000)
    const t = s.final || {}
    check('③ 切回单人后状态稳定', s.stable, s.stable ? '' : '抖动：' + s.signatures.join(' → '))
    check('③ 切回单人：对话恢复', t['对话'] === 'show', `对话=${t['对话']}`)
    check('③ 切回单人：团队/小组隐藏', t['团队'] === 'hidden' && t['小组'] === 'hidden',
      `团队=${t['团队']} 小组=${t['小组']}`)
    await shot('3-back-solo')
  }

  /* ── ④ 刷新后保持一致 ───────────────────────────────── */
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(4000)
  {
    const s = await sampleStability(2400)
    const t = s.final || {}
    check('④ 刷新后状态稳定', s.stable, s.stable ? '' : '抖动：' + s.signatures.join(' → '))
    check('④ 刷新后仍是单人形态', t['对话'] === 'show' && t['团队'] === 'hidden',
      `对话=${t['对话']} 团队=${t['团队']}`)
    await shot('4-after-reload')
  }
} catch (error) {
  check('冒烟执行', false, String(error && error.message || error))
  await shot('x-failure')
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  if (tabLogs.length) {
    console.log('\n--- [council:tab] 调试日志（最后 16 条）---')
    console.log(tabLogs.slice(-16).join('\n'))
  }
  process.exitCode = 1
}

// Full-page PNG screenshots through headless Chrome (DevTools protocol; no npm install).
//   node docs/design-system/tools/shoot.mjs <jobs.json>
// jobs.json: [{ "url", "out", "width"?, "height"?, "theme"?, "click"?, "wait"?, "fullPage"? }]
//   theme  — sets localStorage "loomwatch:theme" on the URL's origin before loading (the app's key)
//   click  — exact text of a button to press after load (e.g. "Build")
// Set CHROME_BIN when Chrome is not at the standard macOS path.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const jobsFile = process.argv[2]
if (!jobsFile) { console.error('usage: node shoot.mjs <jobs.json>'); process.exit(2) }
const jobs = JSON.parse(readFileSync(jobsFile, 'utf8'))
const base = dirname(resolve(jobsFile))

const chromeBin = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = await new Promise((ok, fail) => {
  const s = createServer(); s.once('error', fail)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) })
})
const profile = mkdtempSync(join(tmpdir(), 'lw-shoot-'))
const chrome = spawn(chromeBin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--allow-file-access-from-files', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 100 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page') } catch {}
  if (!target) await sleep(60)
}
if (!target) throw new Error('Chrome DevTools endpoint did not start')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }) })
let id = 0
const pending = new Map()
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result) }
})
const send = (method, params = {}) => new Promise((ok, fail) => { const n = ++id; pending.set(n, { ok, fail }); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value
async function load(url) {
  await send('Page.navigate', { url })
  for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState') === 'complete') break; await sleep(100) }
  await evaluate('document.fonts.ready.then(() => true)')
}

await send('Page.enable'); await send('Runtime.enable')
try {
  for (const job of jobs) {
    const width = job.width ?? 1440, height = job.height ?? 900
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: job.scale ?? 1, mobile: false })
    const url = /^[a-z]+:/.test(job.url) ? job.url : `file://${resolve(base, job.url)}`
    if (job.theme && url.startsWith('http')) {
      await load(new URL(url).origin + '/')
      await evaluate(`localStorage.setItem('loomwatch:theme', ${JSON.stringify(job.theme)})`)
    }
    await load(url)
    await sleep(job.wait ?? 600)
    if (job.click) {
      const ok = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(job.click)}); if (b) b.click(); return !!b })()`)
      if (!ok) throw new Error(`${job.out}: no button "${job.click}"`)
      await sleep(job.wait ?? 900)
    }
    let clip
    if (job.fullPage) {
      const h = await evaluate('Math.ceil(document.documentElement.scrollHeight)')
      await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: job.scale ?? 1, mobile: false })
      await sleep(200)
      clip = { x: 0, y: 0, width, height: h, scale: 1 }
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) })
    const out = resolve(base, job.out)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, Buffer.from(data, 'base64'))
    console.log(`${job.out}  ${width}px`)
  }
} finally {
  ws.close(); chrome.kill()
  await sleep(200)
  rmSync(profile, { recursive: true, force: true })
}

// Renders the favicon fallbacks from site/favicon.svg through headless Chrome (DevTools protocol; no npm install):
//   favicon.ico           16, 32 and 48 px, for browsers and tools that skip SVG icons or ask for /favicon.ico
//   apple-touch-icon.png  180 px and full bleed, for Safari's Favorites and the iOS home screen
// Run it after changing favicon.svg, and commit what it writes:
//   node site/icons.mjs
// Set CHROME_BIN when Chrome is not at the standard macOS path.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = dirname(fileURLToPath(import.meta.url))
const svg = readFileSync(join(site, 'favicon.svg')).toString('base64')
// favicon.svg's tile colour. The touch icon paints it edge to edge, because iOS and Safari round the corners themselves.
const tile = '#08080A'

const chromeBin = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = await new Promise((ok, fail) => {
  const s = createServer(); s.once('error', fail)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) })
})
const profile = mkdtempSync(join(tmpdir(), 'lw-icons-'))
const chrome = spawn(chromeBin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
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

// Chrome draws the vector at each size, so the small icons are rasterised for their own pixel grid rather than shrunk.
async function render(size, { inset = 0, fill } = {}) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise((ok, fail) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = ${size}
      const g = c.getContext('2d')
      ${fill ? `g.fillStyle = ${JSON.stringify(fill)}; g.fillRect(0, 0, ${size}, ${size})` : ''}
      g.drawImage(img, ${inset}, ${inset}, ${size - 2 * inset}, ${size - 2 * inset})
      ok(c.toDataURL('image/png').split(',')[1])
    }
    img.onerror = () => fail(new Error('favicon.svg did not load'))
    img.src = 'data:image/svg+xml;base64,${svg}'
  })` })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return Buffer.from(result.value, 'base64')
}

// An ICO file is a directory of images; every browser since IE 9 accepts PNG entries.
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(([size, png], i) => {
    const at = 6 + 16 * i
    head.writeUInt8(size, at); head.writeUInt8(size, at + 1)
    head.writeUInt16LE(1, at + 4); head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(png.length, at + 8); head.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map(([, png]) => png)])
}

try {
  const sizes = [16, 32, 48]
  writeFileSync(join(site, 'favicon.ico'), ico(await Promise.all(sizes.map(async (s) => [s, await render(s)]))))
  writeFileSync(join(site, 'apple-touch-icon.png'), await render(180, { inset: 18, fill: tile }))
  console.log(`Wrote site/favicon.ico (${sizes.join(', ')} px) and site/apple-touch-icon.png (180 px)`)
} finally {
  ws.close(); chrome.kill()
  await sleep(200)
  rmSync(profile, { recursive: true, force: true })
}

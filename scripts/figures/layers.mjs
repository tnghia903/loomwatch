import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
const cam = readFileSync('cam.json', 'utf8').trim()
const shift = { yarn: [4.2, 8.7], spool: [4.2, 8.5], button: [0.7, 1.3], thimble: [4.9, 8.6], pincushion: [4.6, 8.8], cone: [4.6, 8.9], scissors: [0, 0], bobbin: [0, 0] }
const items = ['band', 'chalk', 'patch', 'pin', 'monocle', 'cushion', 'shuttle']
mkdirSync('wear', { recursive: true })
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const shot = async (query, size, out) => {
  const p = await b.newPage({ viewport: { width: size, height: size } })
  p.on('pageerror', (e) => console.log('err', out, e.message))
  await p.goto('http://localhost:8765/layers.html?' + query)
  await p.waitForFunction(() => window.done, null, { timeout: 90000 })
  await p.locator('canvas').screenshot({ path: out, omitBackground: true, scale: 'css' })
  await p.close()
}
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
for (const kind of Object.keys(shift)) for (const item of items) {
  await shot(q({ mode: 'layer', kind, wear: item, cam, nudge: JSON.stringify(shift[kind]), size: 320, ss: 2 }), 320, `wear/${kind}-${item}.png`)
}
await b.close()
console.log('done')

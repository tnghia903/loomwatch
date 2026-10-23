import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
const cam = readFileSync('cam.json', 'utf8').trim()
const shift = { yarn: [-0.9, -4.5], spool: [-0.7, -4.2], button: [1, -0.6], thimble: [-0.4, -3.8], pincushion: [-0.5, -4.4], cone: [-0.9, -3.5], scissors: [0, 0], bobbin: [0, 0] }
const items = ['tee', 'overalls', 'apron', 'vest', 'band', 'chalk', 'patch', 'pin', 'monocle', 'cushion', 'shuttle']
// Clothes in the figure's own colour (a tee is a deeper shade of it) get a layer per colour.
const inColor = new Set(['tee'])
const colors = { clay: '#E3A386', butter: '#F1D488', sage: '#9FBF9E', sky: '#9EC3E6', lilac: '#BDB0E6', rose: '#EBB3C0', oat: '#E8DFCF' }
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
  const base = { mode: 'layer', kind, wear: item, cam, nudge: JSON.stringify(shift[kind]), size: 320, ss: 2 }
  if (!inColor.has(item)) await shot(q(base), 320, `wear/${kind}-${item}.png`)
  else for (const [name, hex] of Object.entries(colors)) await shot(q({ ...base, color: hex }), 320, `wear/${kind}-${item}-${name}.png`)
}
await b.close()
console.log('done')

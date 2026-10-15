import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage(); p.on('pageerror', e => console.log('err', e.message))
await p.goto('http://localhost:8765/calib.html'); await p.waitForFunction(() => window.ready, null, { timeout: 60000 })
const x0 = [-0.25, 0.55, 3.0, 20.5, 0.47, 0, 0]
console.log('start', await p.evaluate((x) => window.score(x), x0))
const r = await p.evaluate(([x, s]) => window.run(x, s, 160), [x0, [0.08, 0.1, 0.15, 1, 0.05, 0.03, 0.15]])
console.log(JSON.stringify(r))
await b.close()

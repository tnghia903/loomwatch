import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage(); p.on('pageerror', e => console.log('err', e.message))
await p.goto('http://localhost:8765/calib.html'); await p.waitForFunction(() => window.ready, null, { timeout: 60000 })
// rotation, camera y, z, fov, target y, x; the pose comes from pose.js
const x0 = [-0.195, 0.674, 2.992, 21.08, 0.439, 0]
console.log('start', await p.evaluate((x) => window.score(x), x0))
const r = await p.evaluate(([x, s]) => window.run(x, s, 160), [x0, [0.08, 0.1, 0.15, 1, 0.05, 0.03]])
console.log(JSON.stringify(r))
await b.close()

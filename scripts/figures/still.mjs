import { chromium } from 'playwright'
const [,, out, query] = process.argv
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 320, height: 320 } })
p.on('console', m => console.log('console', m.text())); p.on('pageerror', e => console.log('err', e.message))
await p.goto('http://localhost:8765/render.html?' + query)
await p.waitForFunction(() => window.done, null, { timeout: 60000 })
await p.locator('canvas').screenshot({ path: out, omitBackground: true })
console.log(JSON.stringify(await p.evaluate(() => window.measure)))
await b.close()

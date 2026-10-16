import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage(); p.on('pageerror', e => console.log('err', e.message))
await p.goto('http://localhost:8765/export.html'); await p.waitForFunction(() => window.done, null, { timeout: 60000 })
writeFileSync(process.argv[2], Buffer.from(await p.evaluate(() => window.glb), 'base64')); await b.close()

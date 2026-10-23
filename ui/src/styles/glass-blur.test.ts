import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Lightning CSS (Tailwind's build pass and Vite's minifier) reads a `-webkit-backdrop-filter`
// written after the standard property as overriding it and keeps only the prefixed one. Chromium
// (Chrome, Edge, Windows WebView2) knows only the standard property, so every e1 glass panel lost
// its blur there. Written prefix first, both survive the build.
// The prose here never spells the standard name alone: Tailwind scans this file for class names,
// and the bare word adds an unused utility to the app's CSS.
// Read from disk: vitest hands a `?raw` stylesheet import back empty.
const src = resolve(process.cwd(), 'src')
const sheets = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.css'))
  .map((name) => name.replaceAll('\\', '/'))
  .map((name) => ({ name, css: readFileSync(resolve(src, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }))

describe('glass blurs in every engine', () => {
  it('writes -webkit-backdrop-filter before the standard property, never alone or after it', () => {
    const wrong = sheets.flatMap(({ name, css }) => css.split(/[{}]/).flatMap((block) => {
      const props = [...block.matchAll(/(?:^|[;\s])(-webkit-)?backdrop-filter\s*:/g)].map((match) => (match[1] ? 'prefixed' : 'standard'))
      return props.flatMap((prop, at) => (prop === 'prefixed' && !props.slice(at + 1).includes('standard') ? [`${name}: ${block.trim()}`] : []))
    }))
    expect(wrong).toEqual([])
  })

  it('finds the glass rules it guards', () => {
    const both = sheets.filter(({ css }) => /-webkit-backdrop-filter\s*:[^;}]*;\s*backdrop-filter\s*:/.test(css)).map(({ name }) => name)
    expect(both).toEqual(expect.arrayContaining(['styles/tokens.css', 'styles/floating-workspace.css', 'styles/app.css', 'styles/ask.css']))
  })
})

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The logo is drawn in several places that can't import one file: the app's favicon and React glyphs,
// the landing page's symbols and social card, and the macOS icon. docs/assets/brand holds the masters;
// these checks fail when a copy drifts from them.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (file: string) => readFileSync(path.join(repo, file), 'utf8')
const shapes = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((match) => match[1])

const mark = shapes(read('docs/assets/brand/mark.svg'))
const small = shapes(read('docs/assets/brand/mark-small.svg'))
const wordmark = shapes(read('docs/assets/brand/wordmark-dark.svg'))

function drawsAll(file: string, paths: string[]) {
  const source = read(file)
  for (const d of paths) expect(source, `${file} lacks ${d.slice(0, 40)}…`).toContain(d)
}

describe('every copy of the logo draws the masters', () => {
  it('reads the stitch and the mouth of each mark, and the two strokes of the name', () => {
    expect(mark).toHaveLength(2)
    expect(small).toHaveLength(2)
    expect(wordmark).toHaveLength(2)
  })

  it('serves the small mark as the favicon, unchanged', () => {
    const master = read('docs/assets/brand/mark-small.svg')
    for (const file of ['ui/public/icon.svg', 'ui/public/favicon.svg', 'site/favicon.svg']) expect(read(file), file).toBe(master)
  })

  it('draws the same paths in the app', () => {
    drawsAll('ui/src/components/ui/glyphs.tsx', [...mark, ...small, ...wordmark])
    drawsAll('ui/src/lib/story/useNeedsYou.ts', small)
    drawsAll('ui/src/components/chat/TeamChat.tsx', mark)
  })

  it('draws the same paths on the landing page and its social card', () => {
    drawsAll('site/index.html', [...small, ...wordmark])
    drawsAll('site/social-card.html', [...mark, ...wordmark])
  })

  it('draws the same paths in the macOS icon', () => {
    drawsAll('packaging/macos/AppIcon.svg', mark)
    drawsAll('packaging/macos/AppIcon-small.svg', small)
  })
})

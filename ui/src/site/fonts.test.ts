import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The landing page (site/) sets type in the app's own fonts: the same files, the same @font-face
// rules and the same stacks. These checks fail when one side changes and the other does not.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (file: string) => readFileSync(path.join(repo, file), 'utf8')
const fontsDir = 'ui/public/fonts'

function stacks(css: string, names: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [role, name] of Object.entries(names)) {
    const match = css.match(new RegExp(`${name}:\\s*([^;]+);`))
    if (!match) throw new Error(`no ${name} declared`)
    out[role] = match[1].trim()
  }
  return out
}

describe('the landing page and the app share their fonts', () => {
  it('names the same font stacks', () => {
    const app = stacks(read('ui/src/styles/tokens.css'), { serif: '--font-serif', sans: '--font-sans', mono: '--font-mono' })
    const site = stacks(read('site/styles.css'), { serif: '--serif', sans: '--sans', mono: '--mono' })
    expect(site).toEqual(app)
  })

  it('builds the page from the app font folder', () => {
    expect(read('site/build.sh')).toContain(`"$root"/${fontsDir}/fonts.css "$root"/${fontsDir}/*.woff2 "$root"/${fontsDir}/OFL.txt`)
  })

  it('points every @font-face at a file in that folder, by a path that works from both places', () => {
    const urls = [...read(`${fontsDir}/fonts.css`).matchAll(/url\(([^)]+)\)/g)].map((match) => match[1])
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url).toMatch(/^\.\/[\w-]+\.woff2$/)
      expect(existsSync(path.join(repo, fontsDir, url))).toBe(true)
    }
  })

  it('preloads a font the folder has', () => {
    const preload = read('site/index.html').match(/<link rel="preload" href="assets\/fonts\/([^"]+)"/)
    expect(preload).not.toBeNull()
    expect(existsSync(path.join(repo, fontsDir, preload![1]))).toBe(true)
  })

  it('sets Home’s headline in the landing headline’s type', () => {
    const type = (file: string, selector: string) => {
      const rule = read(file).match(new RegExp(`^${selector.replace(/\./g, '\\.')} \\{([^}]+)\\}`, 'm'))
      if (!rule) throw new Error(`no ${selector} in ${file}`)
      const font = rule[1].match(/font: (\d+) [^;]*var\(--(?:font-)?(\w+)\)/)
      return { weight: font?.[1], family: font?.[2], tracking: rule[1].match(/letter-spacing: ([^;]+);/)?.[1] }
    }
    expect(type('ui/src/styles/home.css', '.home-headline')).toEqual(type('site/styles.css', '.hero h1'))
    expect(type('site/styles.css', '.hero h1')).toEqual({ weight: '400', family: 'serif', tracking: '-.015em' })
  })
})

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// What search engines read on the site (site/): each page's title, description and canonical
// address, the structured data in the landing page's head, robots.txt and the sitemap
// site/sitemap.sh writes. They all name the same addresses, and every file they point at is one the
// site publishes.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (file: string) => readFileSync(path.join(repo, file), 'utf8')
const site = 'https://loomwatch.github.io/'
const page = read('site/index.html')

function attr(pattern: RegExp, html = page, file = 'site/index.html'): string {
  const match = html.match(pattern)
  if (!match) throw new Error(`${file} has no ${pattern}`)
  return match[1]
}

const canonical = attr(/<link rel="canonical" href="([^"]+)">/)

// Every page: the landing page, and each guide in a folder of its own, served at /<guide>/.
const guides = readdirSync(path.join(repo, 'site'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(repo, 'site', entry.name, 'index.html')))
  .map((entry) => entry.name)
const pages = [
  { file: 'site/index.html', url: site },
  ...guides.map((guide) => ({ file: `site/${guide}/index.html`, url: `${site}${guide}/` })),
]

// The sitemap as site/build.sh writes it, into a folder of its own.
function sitemap(): string {
  const out = mkdtempSync(path.join(tmpdir(), 'loomwatch-sitemap-'))
  try {
    execFileSync('bash', [path.join(repo, 'site/sitemap.sh'), out])
    return readFileSync(path.join(out, 'sitemap.xml'), 'utf8')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

// The file in the repository a published path is built from: site/, apart from the folders
// site/build.sh copies in from where they live.
const borrowed: [string, string][] = [
  ['assets/readme/', 'docs/assets/readme/'],
  ['assets/figures/', 'ui/public/agent/figures/'],
  ['assets/fonts/', 'ui/public/fonts/'],
]
function source(published: string): string {
  const file = published === '' || published.endsWith('/') ? `${published}index.html` : published
  for (const [from, to] of borrowed) if (file.startsWith(from)) return to + file.slice(from.length)
  return `site/${file}`
}

type Node = Record<string, unknown> & { '@type': string }
function structuredData(): Node[] {
  const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  expect(blocks).toHaveLength(1)
  const data = JSON.parse(blocks[0][1]) as { '@context': string; '@graph': Node[] }
  expect(data['@context']).toBe('https://schema.org')
  return data['@graph']
}
const node = (type: string) => {
  const found = structuredData().find((n) => n['@type'] === type)
  if (!found) throw new Error(`no ${type} in the structured data`)
  return found
}

describe('what search engines read on the landing page', () => {
  it('names one address for the page everywhere', () => {
    expect(canonical).toBe(site)
    expect(attr(/<meta property="og:url" content="([^"]+)">/)).toBe(canonical)
    expect(node('WebSite').url).toBe(canonical)
    expect(node('SoftwareApplication').url).toBe(canonical)
  })

  it('gives the site and the app the name the title starts with', () => {
    const title = attr(/<title>([^<]+)<\/title>/)
    for (const type of ['WebSite', 'Organization', 'SoftwareApplication']) {
      expect(title.startsWith(`${node(type).name} `)).toBe(true)
    }
  })

  it('says the app is free', () => {
    expect(node('SoftwareApplication').offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'USD' })
  })

  it('points only at files the site publishes', () => {
    const urls = JSON.stringify(structuredData()).match(/https:\/\/loomwatch\.github\.io\/[\w.-]+\.\w+/g) ?? []
    expect(urls.length).toBeGreaterThan(0)
    const build = read('site/build.sh')
    for (const url of urls) {
      const file = new URL(url).pathname.slice(1)
      expect(existsSync(path.join(repo, 'site', file))).toBe(true)
      expect(build).toContain(`"$root"/site/${file}`)
    }
  })

  it('names the sitemap in robots.txt, and publishes both', () => {
    expect(read('site/robots.txt')).toContain(`Sitemap: ${canonical}sitemap.xml`)
    const build = read('site/build.sh')
    expect(build).toContain('cp "$root"/site/robots.txt "$out/"')
    expect(build).toContain('"$root"/site/sitemap.sh "$out"')
  })

  it('publishes the file Google Search Console asked for, to prove the site is ours', () => {
    const proofs = readdirSync(path.join(repo, 'site')).filter((name) => /^google[0-9a-f]+\.html$/.test(name))
    expect(proofs).toHaveLength(1)
    // Search Console reads the file at the top of the site, and wants exactly this line in it.
    expect(read(`site/${proofs[0]}`).trim()).toBe(`google-site-verification: ${proofs[0]}`)
    expect(read('site/build.sh')).toContain('cp "$root"/site/google*.html "$out/"')
  })
})

describe('what search engines read on every page', () => {
  it('finds the guides', () => {
    expect(guides.length).toBeGreaterThan(0)
  })

  it('lists every page in the sitemap by its canonical address, with the day it changed, and nothing else', () => {
    const xml = sitemap()
    const entries = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>\s*<\/url>/g)]
    expect(entries).toHaveLength([...xml.matchAll(/<url>/g)].length)
    const listed = entries.map((entry) => entry[1])
    expect(listed[0]).toBe(site)
    const canonicals = pages.map(({ file }) => attr(/<link rel="canonical" href="([^"]+)">/, read(file), file))
    expect([...listed].sort()).toEqual([...canonicals].sort())
  })

  it('publishes every guide, with its stylesheet and script', () => {
    const build = read('site/build.sh')
    expect(build).toContain('for page in "$root"/site/*/index.html; do')
    expect(build).toContain('cp "$root"/site/guides.css "$root"/site/guides.js "$out/"')
  })

  it('gives each page its own title and description, and keeps a guide’s short enough to show in full', () => {
    const titles = new Set<string>()
    const descriptions = new Set<string>()
    for (const { file } of pages) {
      const html = read(file)
      const title = attr(/<title>([^<]+)<\/title>/, html, file)
      const description = attr(/<meta name="description" content="([^"]+)">/, html, file)
      expect(title, file).toContain('LoomWatch')
      if (file !== 'site/index.html') {
        expect(title.length, file).toBeLessThanOrEqual(60)
        expect(description.length, file).toBeGreaterThanOrEqual(70)
        expect(description.length, file).toBeLessThanOrEqual(160)
      }
      titles.add(title)
      descriptions.add(description)
    }
    expect(titles.size).toBe(pages.length)
    expect(descriptions.size).toBe(pages.length)
  })

  for (const { file, url } of pages.slice(1)) {
    describe(file, () => {
      const html = read(file)

      it('names its own address, and shares the link preview of the landing page', () => {
        expect(attr(/<link rel="canonical" href="([^"]+)">/, html, file)).toBe(url)
        expect(attr(/<meta property="og:url" content="([^"]+)">/, html, file)).toBe(url)
        expect(attr(/<meta property="og:title" content="([^"]+)">/, html, file)).toBe(attr(/<title>([^<]+)<\/title>/, html, file))
        const image = /<meta property="og:image" content="([^"]+)">/
        expect(attr(image, html, file)).toBe(attr(image))
      })

      it('links back to the home page and to every other guide', () => {
        const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => new URL(match[1], url).href)
        expect(links).toContain(site)
        for (const guide of guides) expect(links, guide).toContain(`${site}${guide}/`)
      })

      it('points only at files the site publishes, and at places on them that exist', () => {
        const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((match) => new URL(match[1], url))
        for (const ref of refs.filter((r) => r.origin === new URL(site).origin)) {
          const target = source(decodeURIComponent(ref.pathname.slice(1)))
          expect(existsSync(path.join(repo, target)), `${ref.href} → ${target}`).toBe(true)
          if (ref.hash) expect(read(target), ref.href).toContain(`id="${ref.hash.slice(1)}"`)
        }
      })
    })
  }
})

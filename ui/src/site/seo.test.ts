import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// What search engines read on the landing page (site/): the canonical address, the structured data
// in the page's head, robots.txt and the sitemap site/build.sh writes. They all name the same
// address, and every file they point at is one the site publishes.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (file: string) => readFileSync(path.join(repo, file), 'utf8')
const page = read('site/index.html')

function attr(pattern: RegExp): string {
  const match = page.match(pattern)
  if (!match) throw new Error(`site/index.html has no ${pattern}`)
  return match[1]
}

const canonical = attr(/<link rel="canonical" href="([^"]+)">/)

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
    expect(canonical).toBe('https://loomwatch.github.io/')
    expect(attr(/<meta property="og:url" content="([^"]+)">/)).toBe(canonical)
    expect(node('WebSite').url).toBe(canonical)
    expect(node('SoftwareApplication').url).toBe(canonical)
    expect(read('site/build.sh')).toContain(`<loc>${canonical}</loc>`)
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
    expect(build).toContain('cat >"$out/sitemap.xml"')
  })
})

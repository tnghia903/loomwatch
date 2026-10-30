import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import * as icons from '.'
import { Icon, ICON_PATHS, type IconComponent } from '.'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('our own icons', () => {
  it('draws every icon as one path that starts with a move', () => {
    for (const [name, d] of Object.entries(ICON_PATHS)) {
      expect(d, name).toMatch(/^M/)
      const { container, unmount } = render(<Icon name={name as keyof typeof ICON_PATHS} />)
      expect(container.querySelector('path')?.getAttribute('d'), name).toBe(d)
      unmount()
    }
  })

  it('gives every named icon one of our pictures', () => {
    const named = Object.entries(icons).filter(([key]) => /^[A-Z]/.test(key) && key !== 'Icon' && key !== 'ICON_PATHS') as [string, IconComponent][]
    expect(named.length).toBeGreaterThan(100)
    for (const [key, One] of named) {
      const { container, unmount } = render(<One size={14} />)
      const svg = container.querySelector('svg')
      expect(svg?.getAttribute('class'), key).toMatch(/^lw-icon lw-icon-[a-z-]+$/)
      expect(svg?.querySelector('path')?.getAttribute('d'), key).toMatch(/^M/)
      expect(svg?.getAttribute('width'), key).toBe('14')
      unmount()
    }
  })

  it('is hidden from screen readers unless it is labelled', () => {
    const plain = render(<Icon name="check" />).container.querySelector('svg')
    expect(plain?.getAttribute('aria-hidden')).toBe('true')
    const labelled = render(<Icon name="check" aria-label="Approved" />).container.querySelector('svg')
    expect(labelled?.getAttribute('aria-hidden')).toBeNull()
    expect(labelled?.getAttribute('aria-label')).toBe('Approved')
  })

  it('is the only icon set the app uses', () => {
    const src = resolve(process.cwd(), 'src')
    const stock = sources(src).filter((path) => /from ['"]lucide-react['"]/.test(readFileSync(path, 'utf8')))
    expect(stock).toEqual([])
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('lucide-react')
  })
})

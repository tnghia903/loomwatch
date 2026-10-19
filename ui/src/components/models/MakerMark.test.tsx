import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { makerOf } from '../../lib/ai/makers'
import { MakerMark } from './MakerMark'

afterEach(cleanup)

describe('MakerMark', () => {
  it('draws a maker in its own colours, each tile with gradients of its own', () => {
    const { container } = render(<><MakerMark maker={makerOf('meta-llama/llama-4')} /><MakerMark maker={makerOf('meta/muse')} /></>)
    const tiles = [...container.querySelectorAll('.maker-mark.colour')]
    expect(tiles).toHaveLength(2)
    const ids = tiles.map((tile) => [...tile.querySelectorAll('[id]')].map((node) => node.id))
    expect(ids[0].length).toBeGreaterThan(0)
    // Same maker twice, and not one id shared: a gradient never points into another tile.
    expect(ids[0].filter((id) => ids[1].includes(id))).toEqual([])
    for (const [index, tile] of tiles.entries()) {
      const used = [...tile.innerHTML.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1])
      expect(used.length).toBeGreaterThan(0)
      for (const id of used) expect(ids[index]).toContain(id)
    }
  })

  it('carries a dark-theme version where the maker gives one, and stays one colour or a letter otherwise', () => {
    const { container } = render(<>
      <MakerMark maker={makerOf('openrouter/auto')} />
      <MakerMark maker={makerOf('openai/gpt-5.5')} />
      <MakerMark maker={makerOf('acme/plain-1')} />
    </>)
    const [openrouter, openai, acme] = [...container.querySelectorAll('.maker-mark')]
    expect(openrouter.querySelector('svg.on-light')?.innerHTML).toContain('#7624F4')
    expect(openrouter.querySelector('svg.on-dark')?.innerHTML).toContain('#C8FF00')
    expect(openai).not.toHaveClass('colour')
    expect(openai.querySelector('svg')).toHaveAttribute('fill', 'currentColor')
    expect(acme).toHaveClass('letter')
    expect(acme).toHaveTextContent('A')
  })
})

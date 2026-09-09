import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { YamlSheet } from './YamlSheet'

describe('YamlSheet', () => {
  afterEach(cleanup)

  it('renders the ordinary YAML preview with only a close control', () => {
    render(<YamlSheet title="YAML preview" yaml="agents: []" onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'YAML preview' })).toHaveTextContent('agents: []')
    expect(screen.getByRole('button', { name: 'Close YAML' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Keep mine' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use disk' })).not.toBeInTheDocument()
  })

  it('renders provided recovery actions at the sheet foot', () => {
    const footer = (
      <>
        <button type="button">Keep mine</button>
        <button type="button">Use disk</button>
      </>
    )
    render(<YamlSheet title="Disk ↔ in-memory YAML" yaml="" onClose={vi.fn()} footer={footer} />)

    expect(screen.getByRole('dialog', { name: 'Disk ↔ in-memory YAML' })).toHaveTextContent('Keep mine')
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use disk' })).toBeInTheDocument()
  })
})

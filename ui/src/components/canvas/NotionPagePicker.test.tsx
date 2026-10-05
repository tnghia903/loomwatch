import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotionPagePicker } from './NotionPagePicker'

const ROADMAP = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const NOTES = '1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
let searches: string[] = []

beforeEach(() => {
  searches = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== '/api/notion/pages') return new Response('{}', { status: 404 })
    const { query } = JSON.parse(String(init?.body)) as { query: string }
    searches.push(query)
    const pages = query === ''
      ? [{ id: ROADMAP, title: 'Roadmap' }, { id: NOTES, title: 'Meeting notes' }]
      : [{ id: NOTES, title: 'Meeting notes' }].filter((page) => page.title.toLowerCase().includes(query.toLowerCase()))
    return new Response(JSON.stringify({ pages, nextCursor: null }), { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('NotionPagePicker', () => {
  /**
   * ADR 0050: it opens on recent pages, so the usual choice is one click; a page the agent already
   * reads is listed but cannot be chosen twice; typing searches Notion once the typing pauses.
   */
  it('opens on recent pages, marks those already given, and searches as you type', async () => {
    const choose = vi.fn()
    render(<NotionPagePicker agentName="Researcher" given={new Set([ROADMAP.replace(/-/g, '')])} onChoose={choose} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Give Researcher a Notion page' })).toBeInTheDocument()
    const roadmap = await screen.findByRole('button', { name: /Roadmap.*Already reads it/ })
    expect(roadmap).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Meeting notes' }))
    expect(choose).toHaveBeenCalledWith({ id: NOTES, title: 'Meeting notes' })

    fireEvent.change(screen.getByRole('textbox', { name: 'Search your Notion pages' }), { target: { value: 'zzz' } })
    expect(await screen.findByText('No pages match. Try another word.')).toBeInTheDocument()
    expect(searches).toEqual(['', 'zzz'])
  })

  it('says why when Notion cannot be searched, and closes on Escape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Connect your Notion workspace first.' }), { status: 409 })))
    const close = vi.fn()
    render(<NotionPagePicker onChoose={() => {}} onClose={close} />)
    expect(screen.getByRole('dialog', { name: 'Add a Notion page' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Connect your Notion workspace first.'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })
})

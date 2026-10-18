import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import { ByHand } from './ByHand'

// The bench's 3D figure is beside the point here.
vi.mock('./AgentFigure', () => ({ default: () => null }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The daemon, as much of it as giving an agent something to read asks of it. */
function daemon({ notion = true }: { notion?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('/api/notion/connection')) return json(notion ? { connected: true, name: 'Notion' } : { connected: false })
    if (url.includes('/api/notion/pages')) return json({ pages: [{ id: 'page-1', title: 'Roadmap' }], nextCursor: null })
    if (url.includes('/api/folders')) return json({ path: '/Users/me/brand', name: 'brand', parent: '/Users/me', folders: [], files: ['logo.svg'], moreFiles: 0, places: [] })
    if (url.includes('/api/agents/files')) return json({ name: 'plan.md', path: '/Users/me/LoomWatch/teams/.jobs/.files/plan.md', bytes: 7, chars: 7, excerpted: false })
    throw new Error(`no daemon for ${url}`)
  }))
  return calls
}

/** ByHand as the builder holds it: every change is kept, so what it shows next is what was set. */
function Builder({ start, onChange, ...rest }: { start: Partial<AgentDraft>; onChange?: (draft: AgentDraft) => void; readOnly?: boolean }) {
  const [draft, setDraft] = useState<AgentDraft>({ ...BLANK_DRAFT, name: 'Writer', ...start })
  return <ByHand {...rest} draft={draft} set={(key, value) => setDraft((current) => { const next = { ...current, [key]: value }; onChange?.(next); return next })} skills={[]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'yarn', color: 'sage' }} record={null} />
}

const readsBlock = () => screen.getByRole('region', { name: 'What it reads' })
const drawer = () => within(readsBlock()).getAllByRole('listitem').map((item) => item.querySelector('b')?.textContent)

describe('By hand: what one of Your agents reads, in every team it joins', () => {
  it('starts reading nothing, and says what it is given here it reads in every team', () => {
    daemon()
    render(<Builder start={{}} />)
    expect(within(readsBlock()).getByText('Nothing yet')).toBeInTheDocument()
    expect(readsBlock()).toHaveTextContent('What you give it here, it reads in every team it joins.')
    expect(within(readsBlock()).queryByRole('list')).toBeNull()
    expect(screen.getByText(/and reads nothing yet\./)).toBeInTheDocument()
  })

  it('is given a folder, linked where it is', async () => {
    daemon()
    const changes = vi.fn()
    render(<Builder start={{}} onChange={changes} />)
    fireEvent.click(within(readsBlock()).getByRole('button', { name: 'Folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Give Writer a folder' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add “brand”' }))
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ reads: [{ name: 'brand', path: '/Users/me/brand' }] }))
    expect(drawer()).toEqual(['brand'])
    expect(readsBlock()).toHaveTextContent('Reads 1 folder in every team it joins')
    // The same folder again is the one it already reads.
    fireEvent.click(within(readsBlock()).getByRole('button', { name: 'Folder' }))
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Add “brand”' }))
    expect(drawer()).toEqual(['brand'])
  })

  it('is given a file, kept in the teams folder and named by its full path', async () => {
    const calls = daemon()
    const changes = vi.fn()
    render(<Builder start={{}} onChange={changes} />)
    const input = within(readsBlock()).getByLabelText('Files it reads')
    fireEvent.change(input, { target: { files: [new File(['# Plan\n'], 'plan.md', { type: 'text/markdown' })] } })
    await waitFor(() => expect(drawer()).toEqual(['plan.md']))
    const upload = calls.find((call) => call.url.includes('/api/agents/files'))!
    expect(upload.url).toContain('name=plan.md')
    expect(upload.init).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } })
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ reads: [{ name: 'plan.md', path: '/Users/me/LoomWatch/teams/.jobs/.files/plan.md' }] }))
    expect(readsBlock()).toHaveTextContent('File · /Users/me/LoomWatch/teams/.jobs/.files/plan.md')
  })

  it('is given a Notion page once Notion is connected, and sends you to connect it when it isn’t', async () => {
    daemon()
    const changes = vi.fn()
    render(<Builder start={{}} onChange={changes} />)
    fireEvent.click(await within(readsBlock()).findByRole('button', { name: 'Notion page' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Roadmap' }))
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ reads: [{ name: 'Roadmap', notion: { page: 'page-1' } }] }))
    expect(readsBlock()).toHaveTextContent('Reads 1 Notion page in every team it joins')
    cleanup()

    daemon({ notion: false })
    render(<Builder start={{}} />)
    expect(await within(readsBlock()).findByRole('link', { name: 'Notion page' })).toHaveAttribute('href', '/connections?tool=notion')
  })

  it('stops reading one, and keeps each label once', async () => {
    daemon()
    const changes = vi.fn()
    render(<Builder start={{ reads: [{ name: 'brand', path: '/Users/me/old-brand' }, { name: 'Roadmap', notion: { page: 'page-9' } }] }} onChange={changes} />)
    expect(readsBlock()).toHaveTextContent('Reads 1 folder and 1 Notion page in every team it joins')
    // Another folder with a name it already reads is labelled apart.
    fireEvent.click(within(readsBlock()).getByRole('button', { name: 'Folder' }))
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Add “brand”' }))
    expect(drawer()).toEqual(['brand', 'Roadmap', 'brand (2)'])
    fireEvent.click(within(readsBlock()).getByRole('button', { name: 'Stop reading Roadmap' }))
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ reads: [{ name: 'brand', path: '/Users/me/old-brand' }, { name: 'brand (2)', path: '/Users/me/brand' }] }))
  })

  it('gives nothing and takes nothing away where changes can’t be kept', () => {
    daemon()
    render(<Builder start={{ reads: [{ name: 'brand', path: '/Users/me/brand' }] }} readOnly />)
    expect(drawer()).toEqual(['brand'])
    expect(within(readsBlock()).queryByRole('group', { name: 'Give it something to read' })).toBeNull()
    expect(within(readsBlock()).queryByRole('button', { name: 'Stop reading brand' })).toBeNull()
  })
})

describe('By hand: what it hands back, written right in its block', () => {
  const role = (draft: AgentDraft | undefined) => draft?.instructions
  const shaped = 'You are the researcher.\n\nHow to work:\n- Read every source.\n\nReply in this shape:\n## Summary\nThree sentences.\n## Sources\nEach source as a link.'

  it('shows the whole shape it replies in, and says its parts', () => {
    daemon()
    render(<Builder start={{ instructions: shaped }} />)
    const block = screen.getByRole('region', { name: 'What it hands back' })
    expect(block).toHaveTextContent('Replies in 2 parts: Summary, Sources')
    expect(within(block).getByRole('textbox', { name: 'What it hands back' })).toHaveValue('Reply in this shape:\n## Summary\nThree sentences.\n## Sources\nEach source as a link.')
  })

  it('changes that part of its instructions, and nothing else', () => {
    daemon()
    const changes = vi.fn()
    render(<Builder start={{ instructions: shaped }} onChange={changes} />)
    const field = within(screen.getByRole('region', { name: 'What it hands back' })).getByRole('textbox', { name: 'What it hands back' })
    fireEvent.change(field, { target: { value: 'Reply with a short summary.' } })
    expect(role(changes.mock.lastCall?.[0])).toBe('You are the researcher.\n\nHow to work:\n- Read every source.\n\nReply with a short summary.')
    // While you write, it keeps to that part even when it no longer reads like a reply.
    fireEvent.change(field, { target: { value: 'A' } })
    fireEvent.change(field, { target: { value: 'A table.' } })
    expect(role(changes.mock.lastCall?.[0])).toBe('You are the researcher.\n\nHow to work:\n- Read every source.\n\nA table.')
  })

  it('adds what it hands back after the rest when its instructions don’t say yet', () => {
    daemon()
    const changes = vi.fn()
    render(<Builder start={{ instructions: 'You are the researcher.' }} onChange={changes} />)
    const block = screen.getByRole('region', { name: 'What it hands back' })
    expect(block).toHaveTextContent('Its instructions don’t say yet')
    const field = within(block).getByRole('textbox', { name: 'What it hands back' })
    expect(field).toHaveValue('')
    fireEvent.change(field, { target: { value: 'R' } })
    fireEvent.change(field, { target: { value: 'Reply with the list.' } })
    expect(role(changes.mock.lastCall?.[0])).toBe('You are the researcher.\n\nReply with the list.')
    expect(block).toHaveTextContent('Reply with the list.')
  })
})

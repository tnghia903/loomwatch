import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MarkdownRenderer from './MarkdownRenderer'
import { FileCard } from './FileCard'

const REPORT = '/teams/.loomwatch/launch-plan/writer/design-report.docx'
const facts = (overrides: Record<string, unknown> = {}) => ({
  path: REPORT, name: 'design-report.docx', exists: true, isDir: false, sizeBytes: 48_213,
  modifiedAt: new Date(Date.now() - 5 * 60_000).toISOString(), kind: 'document',
  folder: '.loomwatch/launch-plan/writer', openable: true, ...overrides,
})
const respond = (status: number, body: unknown) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }))
let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>
let stat: (path: string) => Promise<Response>

beforeEach(() => {
  // Answers for whichever file is asked about, named after it.
  stat = (path) => respond(200, facts({ path, name: path.split('/').at(-1) }))
  fetchMock = vi.fn((url: string) => (url.startsWith('/api/files/stat') ? stat(new URL(url, 'http://x').searchParams.get('path')!) : respond(204, null)))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('FileCard', () => {
  it('shows what the file is and where the team put it, and opens it in its app', async () => {
    render(<FileCard path={REPORT} />)
    expect(screen.getByText('Checking…')).toBeInTheDocument()
    expect(await screen.findByText('Word document · 47 KB · changed 5 minutes ago')).toBeInTheDocument()
    expect(screen.getByText('launch-plan › writer')).toBeInTheDocument()
    expect(screen.getByText('Design report')).toBeInTheDocument()
    expect(screen.getByText('Ready to open')).toBeInTheDocument()
    expect(screen.getByText('DOCX')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open design-report.docx' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Opened'))
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/files/open')!
    expect(JSON.parse(String(init?.body))).toEqual({ path: REPORT, reveal: false })

    fireEvent.click(screen.getByRole('button', { name: 'Show design-report.docx in its folder' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Shown in its folder'))
  })

  it('says a file is gone instead of offering to open it', async () => {
    stat = () => respond(200, facts({ exists: false, sizeBytes: null, modifiedAt: null, folder: null }))
    render(<FileCard path={REPORT} />)
    expect(await screen.findByText('Not on this computer any more')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open design-report.docx' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Show design-report.docx in its folder' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copy the path of design-report.docx' })).toBeEnabled()
  })

  it('still offers the path when the daemon refuses the folder or predates file support', async () => {
    stat = () => respond(403, { error: 'outside' })
    const { unmount } = render(<FileCard path="/etc/hosts.txt" />)
    expect(await screen.findByText(/Outside your teams folder/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open hosts.txt' })).toBeDisabled()
    unmount()

    stat = () => respond(404, {})
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<FileCard path={REPORT} />)
    expect(await screen.findByText('Word document')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy the path of design-report.docx' })) })
    expect(writeText).toHaveBeenCalledWith(REPORT)
  })
})

describe('files named in a reply', () => {
  it('turns a path in inline code or a link into a file chip, and leaves code blocks alone', async () => {
    const { container } = render(<MarkdownRenderer>{[
      `**File:** \`${REPORT}\``,
      'The [slides](/teams/out/deck.pptx) are ready. Ran `npm test`.',
      '```\n/teams/out/not-a-chip.pdf\n```',
    ].join('\n\n')}</MarkdownRenderer>)
    const chip = await screen.findByRole('button', { name: 'Open design-report.docx (Word document)' })
    expect(chip.closest('p')).toHaveTextContent('File: design-report.docx')
    expect(container.querySelector('p')).not.toHaveTextContent('/teams/.loomwatch')
    expect(screen.getByRole('button', { name: /deck\.pptx/ })).toBeInTheDocument()
    expect(screen.getByText('npm test', { selector: 'code' })).toBeInTheDocument()
    expect(screen.getByText('/teams/out/not-a-chip.pdf', { selector: 'pre code' })).toBeInTheDocument()

    fireEvent.click(chip)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/files/open', expect.objectContaining({ body: JSON.stringify({ path: REPORT, reveal: false }) })))
  })

  it('keeps a chip, and what it said, when the reply around it re-renders', async () => {
    const reply = `**File:** \`${REPORT}\``
    const { rerender } = render(<MarkdownRenderer>{reply}</MarkdownRenderer>)
    fireEvent.click(await screen.findByRole('button', { name: 'Open design-report.docx (Word document)' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Opened'))
    for (let count = 0; count < 3; count += 1) rerender(<MarkdownRenderer>{reply}</MarkdownRenderer>)
    expect(screen.getByRole('status')).toHaveTextContent('Opened')
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/files/stat'))).toHaveLength(1)
  })

  it('shows a file LoomWatch will not open in its folder instead', async () => {
    stat = () => respond(200, facts({ path: '/teams/out/build.sh', name: 'build.sh', kind: 'code', openable: false }))
    render(<MarkdownRenderer>{'Wrote `/teams/out/build.sh`.'}</MarkdownRenderer>)
    fireEvent.click(await screen.findByRole('button', { name: 'Show build.sh (SH file)' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/files/open', expect.objectContaining({ body: JSON.stringify({ path: '/teams/out/build.sh', reveal: true }) })))
  })
})

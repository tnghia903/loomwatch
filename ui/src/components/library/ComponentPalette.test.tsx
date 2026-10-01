import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import { ComponentPalette } from './ComponentPalette'

const codex: DetectedHarness = { id: 'codex', name: 'Codex', command: 'codex', executablePath: '/bin/codex', spawn: { cmd: 'codex', args: ['acp'] }, acpAvailable: true }

let jobs: object[] = []
let problems: object[] = []
const removed: string[] = []

beforeEach(() => {
  jobs = []
  problems = []
  removed.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs, problems }), { status: 200 })
    if (url.startsWith('/api/jobs/') && init?.method === 'DELETE') {
      const id = decodeURIComponent(url.slice('/api/jobs/'.length))
      removed.push(id)
      jobs = jobs.filter((job) => (job as { id: string }).id !== id)
      return new Response(JSON.stringify({ id, movedTo: `.jobs/.removed/x-${id}.yaml` }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const palette = () => render(<ComponentPalette harnesses={[codex]} harnessesLoading={false} harnessesError={null} />)
const section = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement

describe('ComponentPalette jobs', () => {
  it('shows the built-in jobs and, before any is saved, how to save one', async () => {
    palette()
    expect(within(section('Hire by job')).getByText('Researcher')).toBeInTheDocument()
    expect(await screen.findByText(/select it and choose/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Your jobs' })).toBeNull()
  })

  it('lists saved jobs first and places one with its skills, as the built-in jobs are placed', async () => {
    jobs = [{ id: 'release-notes', name: 'Release notes', does: 'Drafts release notes', instructions: 'Write the notes.', apps: ['codex'], skills: ['release-style'], file: '.jobs/release-notes.yaml' }]
    const added = vi.fn()
    window.addEventListener('loomwatch:add-agent', added)
    palette()
    const yours = await waitFor(() => section('Your jobs'))
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings.indexOf('Your jobs')).toBeLessThan(headings.indexOf('Hire by job'))
    fireEvent.click(within(yours).getByRole('button', { name: /^Release notes/ }))
    const payload = JSON.parse((added.mock.calls[0][0] as CustomEvent<string>).detail)
    expect(payload).toMatchObject({ label: 'Release notes', role: 'Write the notes.', spawn: { cmd: 'codex' }, capabilities: [{ kind: 'skill', name: 'release-style' }] })
    window.removeEventListener('loomwatch:add-agent', added)
  })

  it('removes a saved job only on a second click', async () => {
    jobs = [{ id: 'release-notes', name: 'Release notes', instructions: 'Write the notes.', file: '.jobs/release-notes.yaml' }]
    palette()
    const remove = await screen.findByRole('button', { name: 'Remove the job Release notes' })
    fireEvent.click(remove)
    expect(removed).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing Release notes' }))
    await waitFor(() => expect(removed).toEqual(['release-notes']))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your jobs' })).toBeNull())
  })

  it('says which job file it could not read instead of hiding it', async () => {
    problems = [{ file: '.jobs/broken.yaml', message: 'A job needs instructions: what should the agent do?' }]
    palette()
    expect(await screen.findByText(/Can’t read \.jobs\/broken\.yaml/)).toBeInTheDocument()
  })
})

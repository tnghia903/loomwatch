import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSpec, SavedJob } from '../../lib/library/jobs'
import type { AgentConfig } from '../../lib/team-file/types'
import { LinkedAgent } from './LinkedAgent'

const v1: JobSpec = { name: 'Reader', instructions: 'Check every story.', version: 1 }
const v2: JobSpec = { name: 'Reader', instructions: 'Check every story, and its date.', version: 2, note: 'Checks dates too' }
const job: SavedJob = { ...v2, id: 'reader', file: '.jobs/reader.yaml' }
const agent = (role: string): AgentConfig => ({ id: 'reader', name: 'Reader', role, from: { agent: 'reader', version: 1 } })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/jobs/reader/versions') return new Response(JSON.stringify({ versions: [{ version: 2, spec: v2, note: v2.note }, { version: 1, spec: v1 }] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// Versions stay behind the scenes: a team says it has an update, never which number.
describe('LinkedAgent', () => {
  it('offers Update when the agent changed in My agents, with no version number', async () => {
    const onApply = vi.fn()
    const { container } = render(<LinkedAgent agent={agent('Check every story.')} link={{ job, version: 1, latest: 2, behind: true }} onApply={onApply} onUnlink={vi.fn()} />)
    // What Update brings, from the copy it has to the newest: the instructions changed.
    expect(await screen.findByText('Changed in My agents: its instructions.')).toBeInTheDocument()
    expect(screen.getByText(/Checks dates too/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(onApply).toHaveBeenCalledWith(job, v1)
    expect(container.textContent).not.toMatch(/\bv\d/)
  })

  it('says it is up to date, and what this team changed in its copy, with no number', async () => {
    const onApply = vi.fn()
    const { container } = render(<LinkedAgent agent={agent('Check every story twice.')} link={{ job: { ...v1, id: 'reader', file: '.jobs/reader.yaml' }, version: 1, latest: 1, behind: false }} onApply={onApply} onUnlink={vi.fn()} />)
    expect(await screen.findByText(/This team changed its instructions from the copy it was given/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo this team’s changes' }))
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'Check every story.' }), v1)
    expect(container.textContent).not.toMatch(/\bv\d/)
  })

  it('keeps its copy when the agent left My agents', () => {
    const { container } = render(<LinkedAgent agent={agent('Check every story.')} link={{ job: null, version: 3, latest: null, behind: false }} onApply={vi.fn()} onUnlink={vi.fn()} />)
    expect(screen.getByText('It is no longer in My agents. This team keeps its copy.')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/\bv\d/)
  })
})

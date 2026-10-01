import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentConfig } from '../../lib/team-file/types'
import { SaveAsJob } from './SaveAsJob'

const agent: AgentConfig = {
  id: 'writer', name: 'Writer', role: 'Write release notes.', model: 'gpt-5.6',
  spawn: { cmd: 'codex', args: ['acp'], env: {}, cwd: '.' }, capabilities: [{ kind: 'skill', name: 'release-style' }],
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function daemon(existing: Set<string>) {
  const saves: { id: string; body: Record<string, unknown>; createOnly: boolean }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const id = decodeURIComponent(String(input).slice('/api/jobs/'.length))
    const createOnly = ((init?.headers ?? {}) as Record<string, string>)['If-None-Match'] === '*'
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    saves.push({ id, body, createOnly })
    if (createOnly && existing.has(id)) return new Response(JSON.stringify({ error: 'taken' }), { status: 412 })
    existing.add(id)
    return new Response(JSON.stringify({ ...body, id, file: `.jobs/${id}.yaml` }), { status: 200 })
  }))
  return saves
}

describe('SaveAsJob', () => {
  it('saves the agent’s instructions, app, model and skills under the name given', async () => {
    const saves = daemon(new Set())
    render(<SaveAsJob agent={agent} appId="codex" />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as job' }))
    fireEvent.change(screen.getByLabelText('Job name'), { target: { value: 'Release notes writer' } })
    fireEvent.change(screen.getByLabelText(/What it does/), { target: { value: 'Drafts release notes' } })
    expect(screen.getByText(/Keeps its instructions, app and model and its skill/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved “Release notes writer” to Your jobs.')
    expect(saves).toEqual([{ id: 'release-notes-writer', createOnly: true, body: { name: 'Release notes writer', does: 'Drafts release notes', instructions: 'Write release notes.', icon: 'write', apps: ['codex'], model: 'gpt-5.6', skills: ['release-style'] } }])
  })

  it('asks before replacing a job of the same name', async () => {
    const saves = daemon(new Set(['writer']))
    render(<SaveAsJob agent={agent} appId="codex" />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as job' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }))
    expect(await screen.findByText('You already have a job called “Writer”. Replace it?')).toBeInTheDocument()
    expect(saves).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved “Writer”'))
    expect(saves[1]).toMatchObject({ id: 'writer', createOnly: false })
  })

  it('cannot save an agent with no instructions', () => {
    render(<SaveAsJob agent={{ ...agent, role: '  ' }} appId="codex" />)
    expect(screen.getByRole('button', { name: 'Save as job' })).toBeDisabled()
  })
})

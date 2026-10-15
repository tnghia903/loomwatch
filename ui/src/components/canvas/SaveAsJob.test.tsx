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
  it('keeps the agent’s instructions, app, model, skills and switches under the name given, and links the agent to it', async () => {
    const saves = daemon(new Set())
    const linked = vi.fn()
    render(<SaveAsJob agent={{ ...agent, allow: { web: true } }} appId="codex" onLinked={linked} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to Your agents' }))
    fireEvent.change(screen.getByLabelText('Name in Your agents'), { target: { value: 'Release notes writer' } })
    fireEvent.change(screen.getByLabelText(/What it does/), { target: { value: 'Drafts release notes' } })
    expect(screen.getByText(/Keeps its instructions, app and model, its skill and what it may do without asking/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Added “Release notes writer” to Your agents as v1. This agent now follows it.')
    expect(saves).toEqual([{ id: 'release-notes-writer', createOnly: true, body: { name: 'Release notes writer', does: 'Drafts release notes', instructions: 'Write release notes.', icon: 'write', apps: ['codex'], model: 'gpt-5.6', skills: ['release-style'], allow: { web: true } } }])
    expect(linked).toHaveBeenCalledWith({ agent: 'release-notes-writer', version: 1 })
  })

  it('asks before saving over an agent of the same name, as its next version', async () => {
    const saves = daemon(new Set(['writer']))
    render(<SaveAsJob agent={agent} appId="codex" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to Your agents' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText(/You already have an agent called “Writer”. Save this as its next version\?/)).toBeInTheDocument()
    expect(saves).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Save as next version' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added “Writer”'))
    expect(saves[1]).toMatchObject({ id: 'writer', createOnly: false })
  })

  it('cannot save an agent with no instructions', () => {
    render(<SaveAsJob agent={{ ...agent, role: '  ' }} appId="codex" />)
    expect(screen.getByRole('button', { name: 'Add to Your agents' })).toBeDisabled()
  })
})

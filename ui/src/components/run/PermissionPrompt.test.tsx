import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionPrompt } from './PermissionPrompt'
import type { PermissionRequest } from '../../lib/runs/client'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const request = (extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'p1', agent: 'researcher', name: 'Researcher', title: 'Web search', kind: 'fetch', switch: 'web', detail: 'Model Cards for Model Reporting 2019',
  since: new Date().toISOString(), expiresAt: new Date(Date.now() + 9.5 * 60000).toISOString(), ...extra,
})

describe('the permission card (ADR 0040)', () => {
  it('asks in plain words, says the agent is paused, and sends the chosen answer', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ runId: 'r1' })))
    vi.stubGlobal('fetch', fetch)
    render(<PermissionPrompt run={{ runId: 'r1', permissionRequests: [request()] }} />)
    expect(screen.getByText('Researcher wants to use the web')).toBeInTheDocument()
    expect(screen.getByText('Web search · Model Cards for Model Reporting 2019')).toBeInTheDocument()
    expect(screen.getByText(/Researcher is paused until you answer\. Declines by itself in 9 min/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this run' }))
    await vi.waitFor(() => expect(screen.queryByText('Researcher wants to use the web')).toBeNull())
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/runs/r1/permissions')
    expect(JSON.parse(String(init.body))).toEqual({ requestId: 'p1', decision: 'allow_run' })
  })

  // A command you'd run a little differently: change it on the card, and that is what runs.
  it('lets you change a command before allowing it, starting from the whole command', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ runId: 'r1' })))
    vi.stubGlobal('fetch', fetch)
    const whole = 'rm -rf build && npm run build -- --mode production'
    render(<PermissionPrompt run={{ runId: 'r1', permissionRequests: [request({ title: 'Run: rm -rf build', kind: 'execute', switch: 'commands', detail: 'rm -rf build…', edit: { field: 'command', value: whole } })] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit, then allow' }))
    const field = screen.getByLabelText('The command to allow instead')
    expect(field).toHaveValue(whole)
    expect(screen.getByText('Researcher runs it as you wrote it, this once.')).toBeInTheDocument()
    fireEvent.change(field, { target: { value: '  rm -rf build/tmp ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Allow it changed' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ requestId: 'p1', decision: 'edit', text: 'rm -rf build/tmp' })
  })

  it('offers no edit for a request with nothing to change, and answers in its place instead', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ runId: 'r1' })))
    vi.stubGlobal('fetch', fetch)
    render(<PermissionPrompt run={{ runId: 'r1', permissionRequests: [request({ title: 'Write notes.md', kind: 'edit', switch: 'edits', detail: 'notes.md' })] }} />)
    expect(screen.queryByRole('button', { name: 'Edit, then allow' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Answer instead' }))
    const send = screen.getByRole('button', { name: 'Send answer' })
    expect(send).toBeDisabled()
    // Back to the answers, nothing sent.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Answer instead' }))
    fireEvent.change(screen.getByLabelText('Your answer to Researcher, in place of what it asked to do'), { target: { value: 'Put it in the reply instead of a file.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ requestId: 'p1', decision: 'answer', text: 'Put it in the reply instead of a file.' })
  })

  it('offers "Always allow" only for a request a switch covers, and switches it on as it lets the run through', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ runId: 'r1' })))
    vi.stubGlobal('fetch', fetch)
    const onAlwaysAllow = vi.fn()
    render(<PermissionPrompt run={{ runId: 'r1', permissionRequests: [request(), request({ id: 'p2', kind: 'delete', switch: null, title: 'Delete notes.md', detail: null })] }} onAlwaysAllow={onAlwaysAllow} />)
    expect(screen.getAllByRole('button', { name: /Always allow/ })).toHaveLength(1)
    expect(screen.getByText('Researcher wants to do this: Delete notes.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Always allow web' }))
    expect(onAlwaysAllow).toHaveBeenCalledWith('researcher', 'web')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ requestId: 'p1', decision: 'allow_run' })
    await vi.waitFor(() => expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ requestId: 'p2', decision: 'deny' })
    await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Waiting for your permission' })).toBeNull())
  })

  it('says so when the request had already gone, and renders nothing with nothing open', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: 'That request is no longer waiting: it was answered, or declined when nobody answered in time.' }, 404))))
    const { rerender } = render(<PermissionPrompt run={{ runId: 'r1', permissionRequests: [request(), request({ id: 'p2' })] }} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Allow' })[0])
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer waiting')
    rerender(<PermissionPrompt run={{ runId: 'r1', permissionRequests: [] }} />)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('offers "Allow for the whole team" only for a team, and sends it', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ runId: 'r1' })))
    vi.stubGlobal('fetch', fetch)
    const { unmount } = render(<PermissionPrompt run={{ runId: 'r1', permissionRequests: [request()] }} />)
    expect(screen.queryByRole('button', { name: 'Allow for the whole team' })).toBeNull()
    unmount()
    render(<PermissionPrompt team run={{ runId: 'r1', permissionRequests: [request()] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow for the whole team' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ requestId: 'p1', decision: 'allow_team' })
  })
})

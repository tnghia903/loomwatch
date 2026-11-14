import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CatalogEntry, ConnectedTool } from '../../../lib/tools/client'
import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { AnswerWidgets } from './AnswerWidgets'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const calendarEntry: CatalogEntry = { name: 'Apple Calendar', url: 'loomwatch:apple-calendar', does: 'See, add, change and delete your events', auth: 'onThisMac', topic: 'onThisMac' }
const calendar = (extra: Partial<ConnectedTool> = {}): ConnectedTool => ({
  id: 'c1', name: 'Apple Calendar', url: 'loomwatch:apple-calendar', auth: 'onThisMac', calls: [], checkedAt: null, pending: false, problem: null, tokenHelp: null, ...extra,
})
const suggested = (title = 'Apple Calendar', extra: Partial<KeptWidget> = {}): KeptWidget => ({ n: 1, spec: { kind: 'connect', title }, ...extra })

type Sent = { method: string; url: string; body?: Record<string, unknown> }

/** The daemon: its tools as `connected`, the starter list, and `answer` for everything else. */
function daemon(connected: ConnectedTool[], answer: (sent: Sent) => Response | undefined = () => undefined) {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined }
    sent.push(request)
    if (request.method === 'GET' && request.url === '/api/tools') return json({ tools: connected, catalog: [calendarEntry], keptIn: 'keychain' })
    return answer(request) ?? json({ error: 'no route' }, 404)
  }))
  return sent
}

/** What the chat keeps for the widget: `onChange`, answering as the daemon does. */
function keeper() {
  const kept: WidgetState[] = []
  const onChange = vi.fn(async (n: number, state: WidgetState) => {
    kept.push(state)
    return { ...suggested(), n, state, changedAt: new Date().toISOString() }
  })
  return { kept, onChange }
}

describe('a tool an agent suggests connecting (ADR 0126)', () => {
  it('connects a Mac app with one tap, gives it to the agent that suggested it, then replies so it carries on', async () => {
    const sent = daemon([], (request) => (request.method === 'POST' && request.url === '/api/tools' ? json({ tool: calendar() }) : undefined))
    const { kept, onChange } = keeper()
    const onGive = vi.fn(async () => {})
    const onCarryOn = vi.fn(async () => true)
    render(<AnswerWidgets widgets={[suggested()]} onChange={onChange} onGive={onGive} onCarryOn={onCarryOn} by="Coby" />)
    const card = screen.getByRole('region', { name: 'Connect Apple Calendar' })
    expect(await within(card).findByText('See, add, change and delete your events')).toBeTruthy()
    expect(sent.filter((request) => request.method === 'POST')).toHaveLength(0)
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Connect' })).not.toBeDisabled())

    fireEvent.click(within(card).getByRole('button', { name: 'Connect' }))
    expect(await within(card).findByText('Connected. Coby is carrying on.')).toBeTruthy()
    expect(sent.find((request) => request.method === 'POST')).toMatchObject({ url: '/api/tools', body: { url: 'loomwatch:apple-calendar', name: 'Apple Calendar' } })
    expect(onGive).toHaveBeenCalledWith('Apple Calendar')
    expect(kept).toEqual([{ connected: true }])
    await waitFor(() => expect(onCarryOn).toHaveBeenCalledWith('I connected Apple Calendar.'))
    expect(onCarryOn).toHaveBeenCalledTimes(1)
    expect(onGive.mock.invocationCallOrder[0]).toBeLessThan(onCarryOn.mock.invocationCallOrder[0])
    expect(within(card).queryByRole('button', { name: 'Connect' })).toBeNull()
  })

  it('sends the reply only once the chat has drawn again with the tool given, so the work it starts has it', async () => {
    daemon([calendar()])
    const { onChange } = keeper()
    const replies: { label: string; tools: readonly string[] }[] = []
    // As an agent's own chat does: the tool goes into its draft, which the next send is set up from.
    function Chat() {
      const [tools, setTools] = useState<readonly string[]>([])
      return (
        <AnswerWidgets widgets={[suggested()]} onChange={onChange} by="Coby"
          onGive={async (tool) => { setTools((now) => [...now, tool]) }}
          onCarryOn={async (label) => { replies.push({ label, tools }); return true }} />
      )
    }
    render(<Chat />)
    const connect = await screen.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(connect).not.toBeDisabled())
    fireEvent.click(connect)
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toEqual({ label: 'I connected Apple Calendar.', tools: ['Apple Calendar'] })
  })

  it('opens the Mac’s permission step when it hasn’t allowed LoomWatch yet, and finishes after Check again', async () => {
    const sent = daemon([], (request) => {
      if (request.method === 'POST' && request.url === '/api/tools') return json({ tool: calendar({ pending: true }), needs: 'macPermission' })
      if (request.method === 'POST' && request.url === '/api/tools/c1/check') return json({ tool: calendar() })
      return undefined
    })
    const { kept, onChange } = keeper()
    const onGive = vi.fn(async () => {})
    const onCarryOn = vi.fn(async () => true)
    render(<AnswerWidgets widgets={[suggested()]} onChange={onChange} onGive={onGive} onCarryOn={onCarryOn} by="Coby" />)
    const card = screen.getByRole('region', { name: 'Connect Apple Calendar' })
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Connect' })).not.toBeDisabled())
    fireEvent.click(within(card).getByRole('button', { name: 'Connect' }))
    expect(await within(card).findByText(/Your Mac hasn’t let LoomWatch use Apple Calendar/)).toBeTruthy()
    // Connections' own step, with nothing given or said yet.
    expect(within(card).queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(onGive).not.toHaveBeenCalled()
    expect(kept).toEqual([])

    fireEvent.click(within(card).getByRole('button', { name: 'Check again' }))
    expect(await within(card).findByText('Connected. Coby is carrying on.')).toBeTruthy()
    expect(sent.some((request) => request.url === '/api/tools/c1/check')).toBe(true)
    expect(onGive).toHaveBeenCalledWith('Apple Calendar')
    await waitFor(() => expect(onCarryOn).toHaveBeenCalledWith('I connected Apple Calendar.'))
  })

  it('gives a tool connected already without connecting it again, and with no reply to send says so', async () => {
    const sent = daemon([calendar()])
    const { kept, onChange } = keeper()
    // As an agent's own chat in My agents: the tool goes into its changes, and Save keeps it.
    const onGive = vi.fn(async () => 'Save to keep it.')
    render(<AnswerWidgets widgets={[suggested('apple calendar')]} onChange={onChange} onGive={onGive} by="Coby" />)
    const connect = await screen.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(connect).not.toBeDisabled())
    fireEvent.click(connect)
    expect(await screen.findByText('Connected. Coby has it from your next message. Save to keep it.')).toBeTruthy()
    expect(sent.filter((request) => request.method === 'POST')).toHaveLength(0)
    expect(onGive).toHaveBeenCalledWith('Apple Calendar')
    expect(kept).toEqual([{ connected: true }])
  })

  it('says where to connect a tool it was given that LoomWatch can’t connect by its name, with no button that can’t work', async () => {
    daemon([])
    const { kept, onChange } = keeper()
    const onGive = vi.fn(async () => {})
    render(<AnswerWidgets widgets={[suggested('Acme CRM')]} onChange={onChange} onGive={onGive} by="Coby" />)
    const card = screen.getByRole('region', { name: 'Connect Acme CRM' })
    expect((await within(card).findByText(/isn’t connected yet/)).textContent).toBe('Acme CRM isn’t connected yet. Connect it under Tools in Connections.')
    expect(within(card).getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '/connections')
    expect(within(card).queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(within(card).queryByRole('alert')).toBeNull()
    expect(onGive).not.toHaveBeenCalled()
    expect(kept).toEqual([])
  })

  it('opens a tool it was given that is waiting for its token on that step, never on the list to pick from', async () => {
    const sent = daemon([calendar({ id: 'a1', name: 'Acme CRM', url: 'https://mcp.acme.test/mcp', auth: 'token', pending: true })])
    const { onChange } = keeper()
    render(<AnswerWidgets widgets={[suggested('Acme CRM')]} onChange={onChange} onGive={vi.fn(async () => {})} by="Coby" />)
    const card = screen.getByRole('region', { name: 'Connect Acme CRM' })
    const connect = await within(card).findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(connect).not.toBeDisabled())
    fireEvent.click(connect)
    expect(await within(card).findByLabelText('Acme CRM token')).toBeTruthy()
    expect(within(card).queryByRole('search')).toBeNull()
    // Nothing is asked of the daemon until the token is sent.
    expect(sent.filter((request) => request.method === 'POST')).toHaveLength(0)
  })

  it('sends the reply only once the tool is given, and not at all when giving it fails', async () => {
    daemon([calendar()])
    const { kept, onChange } = keeper()
    let given: () => void = () => {}
    const onGive = vi.fn(() => new Promise<void>((done) => { given = done }))
    const onCarryOn = vi.fn(async () => true)
    const { unmount } = render(<AnswerWidgets widgets={[suggested()]} onChange={onChange} onGive={onGive} onCarryOn={onCarryOn} by="Planner" />)
    const connect = await screen.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(connect).not.toBeDisabled())
    fireEvent.click(connect)
    await waitFor(() => expect(onGive).toHaveBeenCalledWith('Apple Calendar'))
    // The team file is still being saved: nothing is kept or said yet.
    await new Promise((settle) => setTimeout(settle, 20))
    expect(onCarryOn).not.toHaveBeenCalled()
    expect(kept).toEqual([])
    given()
    await waitFor(() => expect(onCarryOn).toHaveBeenCalledWith('I connected Apple Calendar.'))
    expect(kept).toEqual([{ connected: true }])
    unmount()

    const failing = keeper()
    const refused = vi.fn(async () => { throw new Error('Couldn’t save the team, so Planner doesn’t have Apple Calendar yet. Click Connect to try again.') })
    const notSent = vi.fn(async () => true)
    render(<AnswerWidgets widgets={[suggested()]} onChange={failing.onChange} onGive={refused} onCarryOn={notSent} by="Planner" />)
    const again = await screen.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(again).not.toBeDisabled())
    fireEvent.click(again)
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t save the team, so Planner doesn’t have Apple Calendar yet. Click Connect to try again.')
    expect(failing.kept).toEqual([])
    expect(notSent).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Connect' })).not.toBeDisabled()
  })

  it('says so when the chat can’t give the tool, and sends no reply', async () => {
    daemon([calendar()])
    const { kept, onChange } = keeper()
    const onCarryOn = vi.fn(async () => true)
    render(<AnswerWidgets widgets={[suggested()]} onChange={onChange} onCarryOn={onCarryOn} by="Planner" />)
    const connect = await screen.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(connect).not.toBeDisabled())
    fireEvent.click(connect)
    expect(await screen.findByText('Connected. This team can’t be changed here, so Planner doesn’t have it yet.')).toBeTruthy()
    expect(kept).toEqual([{ connected: true }])
    expect(onCarryOn).not.toHaveBeenCalled()
  })

  it('says the agent has it from your next message when the reply couldn’t go', async () => {
    daemon([calendar()])
    const { onChange } = keeper()
    const onCarryOn = vi.fn(async () => false)
    render(<AnswerWidgets widgets={[suggested()]} onChange={onChange} onGive={vi.fn(async () => {})} onCarryOn={onCarryOn} by="Coby" />)
    const connect = await screen.findByRole('button', { name: 'Connect' })
    await waitFor(() => expect(connect).not.toBeDisabled())
    fireEvent.click(connect)
    await waitFor(() => expect(onCarryOn).toHaveBeenCalledWith('I connected Apple Calendar.'))
    expect(await screen.findByText('Connected. Coby has it from your next message.')).toBeTruthy()
  })

  it('shows one connected before as connected, and waits while the answer is written', async () => {
    daemon([])
    const { onChange } = keeper()
    const { rerender } = render(<AnswerWidgets widgets={[suggested('Apple Calendar', { state: { connected: true }, changedAt: '2026-11-14T10:00:00Z' })]} onChange={onChange} by="Coby" />)
    expect(screen.getByRole('status').textContent).toBe('Connected.')
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    rerender(<AnswerWidgets widgets={[suggested('Notion', { n: 2 })]} onChange={onChange} by="Coby" live />)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  })
})

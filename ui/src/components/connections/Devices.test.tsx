import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { Reach } from '../../lib/devices/client'
import { Devices } from './Devices'

// Switching reloads the page once LoomWatch is back; jsdom can't navigate, so the wait is skipped.
const reloaded = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../../lib/devices/client', async (original) => ({ ...(await original<typeof import('../../lib/devices/client')>()), reloadWhen: reloaded }))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); reloaded.mockClear() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ready: Reach = { state: 'ready', address: 'https://my-mac.tail1234.ts.net:8443' }
const phone = { id: 'p1', name: 'Nghia’s iPhone', kind: 'phone', pairedAt: '2026-10-30T09:00:00Z', lastSeen: '2026-10-30T09:05:00Z' }
const macbook = { id: 'c1', name: 'MacBook', kind: 'computer', pairedAt: '2026-10-30T09:00:00Z', lastSeen: null }

/**
 * The daemon's device routes (ADR 0102), with what Tailscale says now, and the connector's own
 * state when this page is shown from another computer. Every request is recorded.
 */
function daemon({ devices = [phone] as unknown[], door = '127.0.0.1:3440' as string | null, doorOff = false, reach = ready as Reach, shared = ready as Reach, shownFrom = null as { address: string; hostName: string } | null } = {}) {
  let listed = devices
  let now = reach
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/connector/v0/state') return Promise.resolve(shownFrom ? response(shownFrom) : response({ error: 'Not Found' }, 404))
    if (url === '/connector/v0/stop' && method === 'POST') return Promise.resolve(new Response(null, { status: 204 }))
    if (url === '/api/connection' && method === 'POST') return Promise.resolve(response({ address: 'https://mac-mini.tail1234.ts.net:8443', hostName: 'mac-mini' }))
    if (url === '/api/devices') return Promise.resolve(response({ devices: listed, door, doorOff }))
    if (url === '/api/devices/codes' && method === 'POST') {
      const kind = (JSON.parse(String(init?.body)) as { kind: string }).kind
      const link = now.state === 'ready' ? `loomwatch://pair?address=x&code=${kind}-code` : null
      return Promise.resolve(response({ code: `${kind}-code`, kind, expiresAt: '2026-10-30T10:10:00Z', link, qr: link ? { size: 29, path: 'M4 4h1v1h-1z' } : null, reach: now }))
    }
    if (url === '/api/devices/reach' && method === 'POST') { now = shared; return Promise.resolve(response(now)) }
    if (url.startsWith('/api/devices/') && method === 'DELETE') {
      listed = listed.filter((device) => !url.endsWith((device as { id: string }).id))
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return Promise.resolve(response({ error: 'Not Found' }, 404))
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, arrive: (device: unknown) => { listed = [...listed, device] } }
}

const sent = (fetch: ReturnType<typeof daemon>['fetch'], url: string, method: string) =>
  fetch.mock.calls.filter(([input, init]) => String(input) === url && (init?.method ?? 'GET') === method)

it('lists the connected devices, and Remove stops one at once', async () => {
  const { fetch } = daemon({ devices: [phone, macbook] })
  render(<Devices />)
  const list = await screen.findByRole('list', { name: 'Connected devices' })
  expect(within(list).getByText('Nghia’s iPhone')).toBeInTheDocument()
  expect(within(list).getByText(/^iPhone · last used/)).toBeInTheDocument()
  expect(within(list).getByText('Computer')).toBeInTheDocument()

  fireEvent.click(within(list).getByRole('button', { name: 'Remove MacBook' }))
  await waitFor(() => expect(screen.queryByText('MacBook')).toBeNull())
  const removed = sent(fetch, '/api/devices/c1', 'DELETE')
  expect(removed).toHaveLength(1)
  expect(removed[0][1]?.headers).toMatchObject({ 'X-LoomWatch-Request': '1' })
})

it('connects an iPhone with a code its camera reads, and a computer with a link to send it', async () => {
  const { fetch } = daemon({ devices: [] })
  render(<Devices />)
  expect(await screen.findByText('No devices connected.')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Connect a device' }))
  expect(await screen.findByRole('img', { name: 'Code for your iPhone’s camera' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'iPhone' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText(/Your iPhone needs the LoomWatch app and Tailscale/)).toBeInTheDocument()
  expect(screen.getByText(/^Works once, until/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Computer' }))
  const link = await screen.findByRole('textbox', { name: 'Link for your other computer' })
  expect(link).toHaveValue('loomwatch://pair?address=x&code=computer-code')
  expect(screen.getByText(/^Send this link to your other computer/)).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: 'Code for your iPhone’s camera' })).toBeNull()

  const asked = sent(fetch, '/api/devices/codes', 'POST').map(([, init]) => JSON.parse(String(init?.body)) as { kind: string })
  expect(asked).toEqual([{ kind: 'phone' }, { kind: 'computer' }])
})

it('says when the device has connected, and closes the code', async () => {
  const { arrive } = daemon({ devices: [phone] })
  render(<Devices />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a device' }))
  expect(await screen.findByRole('img', { name: 'Code for your iPhone’s camera' })).toBeInTheDocument()

  arrive({ id: 'p2', name: 'Work iPhone', kind: 'phone', pairedAt: '2026-10-30T10:01:00Z', lastSeen: null })
  expect(await screen.findByText('Work iPhone is connected.', {}, { timeout: 4000 })).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: 'Code for your iPhone’s camera' })).toBeNull()
})

it('lets the devices in on Tailscale only when asked, then shows the code', async () => {
  const { fetch } = daemon({ devices: [], reach: { state: 'notShared' } })
  render(<Devices />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a device' }))
  const share = await screen.findByRole('button', { name: 'Let my devices in' })
  expect(screen.getByText(/No one else can/)).toBeInTheDocument()
  expect(sent(fetch, '/api/devices/reach', 'POST')).toHaveLength(0)
  expect(screen.queryByRole('img', { name: 'Code for your iPhone’s camera' })).toBeNull()

  fireEvent.click(share)
  expect(await screen.findByRole('img', { name: 'Code for your iPhone’s camera' })).toBeInTheDocument()
  expect(sent(fetch, '/api/devices/reach', 'POST')).toHaveLength(1)
})

it('says what stands in the way, with the one thing to do about it', async () => {
  daemon({ devices: [], reach: { state: 'noTailscale' } })
  render(<Devices />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a device' }))
  expect(await screen.findByRole('link', { name: 'Get Tailscale' })).toHaveAttribute('href', 'https://tailscale.com/download')
  expect(screen.getByText(/on this computer and on your iPhone\. Sign in to both with the same account/)).toBeInTheDocument()
})

it('gives Tailscale’s own words as detail, under what to do', async () => {
  daemon({ devices: [], reach: { state: 'failed', message: 'Permission denied (os error 13)' } })
  render(<Devices />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a device' }))
  expect(await screen.findByText(/^Tailscale couldn’t let your devices in\. Quit Tailscale, open it again/)).toBeInTheDocument()
  expect(screen.getByText('Tailscale said: Permission denied (os error 13)')).toBeInTheDocument()
})

it('says so, and the page stays, when the answer isn’t a list of devices', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response({ connected: false }))))
  render(<Devices />)
  expect(await screen.findByText('Connecting other devices isn’t available in this LoomWatch.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Connect a device' })).toBeNull()
})

it('offers no code when other devices can’t connect to this computer, and says what to do', async () => {
  daemon({ devices: [], door: null })
  render(<Devices />)
  expect(await screen.findByText('Other devices can’t connect right now. Quit LoomWatch and open it again.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Connect a device' })).toBeNull()
})

it('says connecting is turned off when it was turned off on purpose', async () => {
  daemon({ devices: [], door: null, doorOff: true })
  render(<Devices />)
  expect(await screen.findByText('Connecting other devices is turned off on this computer.')).toBeInTheDocument()
  expect(screen.queryByText(/Quit LoomWatch and open it again/)).toBeNull()
})

it('connects this computer to LoomWatch on another one with the link made there', async () => {
  const { fetch } = daemon({ devices: [] })
  render(<Devices />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect to another computer' }))
  const connect = screen.getByRole('button', { name: 'Connect' })
  expect(connect).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Link from the other computer' }), { target: { value: 'loomwatch://pair?address=a&code=b' } })
  fireEvent.click(connect)

  expect(await screen.findByText('Connecting to mac-mini…')).toBeInTheDocument()
  const asked = sent(fetch, '/api/connection', 'POST')
  expect(asked).toHaveLength(1)
  expect(JSON.parse(String(asked[0][1]?.body))).toEqual({ link: 'loomwatch://pair?address=a&code=b' })
  await waitFor(() => expect(reloaded).toHaveBeenCalledTimes(1))
})

it('shown from another computer, says which, and goes back to this one’s own', async () => {
  const { fetch } = daemon({ devices: [macbook], shownFrom: { address: 'https://mac-mini.tail1234.ts.net:8443', hostName: 'mac-mini' } })
  render(<Devices />)
  expect(await screen.findByText('This computer shows LoomWatch on mac-mini.')).toBeInTheDocument()
  // It can't hand the other computer to a third one.
  expect(screen.queryByRole('button', { name: 'Connect to another computer' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Use LoomWatch on this computer instead' }))
  await waitFor(() => expect(sent(fetch, '/connector/v0/stop', 'POST')).toHaveLength(1))
  await waitFor(() => expect(reloaded).toHaveBeenCalledTimes(1))
})

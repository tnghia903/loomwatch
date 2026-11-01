// Devices connected to LoomWatch on this computer (ADR 0102): a phone, or another computer that
// shows this one. This computer keeps everything; a device keeps only a key of its own, which the
// app never sees. Devices reach this computer through the person's own Tailscale.
import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'

export type DeviceKind = 'phone' | 'computer'

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  pairedAt: string
  lastSeen: string | null
}

/** Whether other devices can reach this computer, and what stands in the way (`devices::reach`). */
export type Reach =
  | { state: 'ready'; address: string }
  | { state: 'notShared' }
  | { state: 'noTailscale' }
  | { state: 'tailscaleOff'; said?: string }
  | { state: 'signedOut'; url: string | null }
  | { state: 'needsOk'; url: string }
  | { state: 'portsTaken' }
  | { state: 'failed'; message: string }

/** A pairing code, its link when devices can reach this computer, and that link as a QR code. */
export interface CodeMade {
  code: string
  kind: DeviceKind
  expiresAt: string
  link: string | null
  /** The QR code's dark modules as one SVG path on a `size` by `size` square. */
  qr: { size: number; path: string } | null
  reach: Reach
}

export type DevicesState =
  | { state: 'loading' }
  | { state: 'unavailable'; message: string }
  | { state: 'ready'; devices: Device[]; doorOpen: boolean; doorOff: boolean }

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const response = await daemonFetch(path, {
    ...rest,
    cache: 'no-store',
    headers: { 'X-LoomWatch-Request': '1', ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
  if (response.status === 204) return undefined as T
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok || !body) throw new Error(body?.error ?? 'LoomWatch couldn’t do that. Try again.')
  return body
}

/** What the section says when this LoomWatch doesn't answer for devices as expected. */
export const DEVICES_UNAVAILABLE = 'Connecting other devices isn’t available in this LoomWatch.'

export async function fetchDevices(): Promise<{ devices: Device[]; doorOpen: boolean; doorOff: boolean }> {
  const body = await request<{ devices?: unknown; door?: unknown; doorOff?: unknown }>('/api/devices')
  if (!Array.isArray(body.devices)) throw new Error(DEVICES_UNAVAILABLE)
  return { devices: body.devices as Device[], doorOpen: typeof body.door === 'string', doorOff: body.doorOff === true }
}

/** Reads Tailscale; changes nothing. */
export function readReach(): Promise<Reach> {
  return request('/api/devices/reach')
}

/** Shares this computer's door on Tailscale: the person pressed the button for it. */
export function shareOnTailscale(): Promise<Reach> {
  return request('/api/devices/reach', { method: 'POST' })
}

/** A new code for one kind of device. It works once, for ten minutes, and ends the one before. */
export function makeCode(kind: DeviceKind): Promise<CodeMade> {
  return request('/api/devices/codes', { method: 'POST', json: { kind } })
}

export function removeDevice(id: string): Promise<void> {
  return request(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Where this computer is connected, when it shows LoomWatch on another computer. */
export interface ShownFrom {
  address: string
  hostName: string
}

/**
 * The computer this page's LoomWatch runs on, when it isn't this one: `loomwatchd connect` answers
 * `/connector/v0/state` itself. LoomWatch on its own computer has no such route.
 */
export async function readShownFrom(): Promise<ShownFrom | null> {
  try {
    const response = await daemonFetch('/connector/v0/state', { cache: 'no-store' })
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return null
    const body = (await response.json()) as Partial<ShownFrom>
    return typeof body.hostName === 'string' && typeof body.address === 'string' ? { address: body.address, hostName: body.hostName } : null
  } catch {
    return null
  }
}

/** Connects this computer to LoomWatch on the one the link was made on. LoomWatch then restarts. */
export function connectTo(link: string): Promise<{ address: string; hostName: string }> {
  return request('/api/connection', { method: 'POST', json: { link } })
}

/** Stops showing the other computer: LoomWatch restarts as this computer's own. */
export function switchToThisComputer(): Promise<void> {
  return request('/connector/v0/stop', { method: 'POST' })
}

/** Waits until `ready` says LoomWatch is back after switching, then reloads the page. */
export async function reloadWhen(ready: () => Promise<boolean>, tries = 40): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1000))
    if (await ready().catch(() => false)) break
  }
  window.location.reload()
}

/** LoomWatch on this computer answers for itself (not through another computer). */
export async function ownLoomWatchAnswers(): Promise<boolean> {
  const response = await fetch('/api/health', { cache: 'no-store' })
  return response.ok && (await readShownFrom()) === null
}

export function useDevices(): DevicesState & { refresh: () => void } {
  const [devices, setDevices] = useState<DevicesState>({ state: 'loading' })
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    let current = true
    fetchDevices().then(
      (read) => { if (current) setDevices({ state: 'ready', ...read }) },
      (error: unknown) => { if (current) setDevices({ state: 'unavailable', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { current = false }
  }, [generation])

  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  return { ...devices, refresh }
}

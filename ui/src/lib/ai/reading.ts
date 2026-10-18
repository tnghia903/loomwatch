// Reading an agent's whole setup for its model suggestion, as the daemon serves it
// (`crates/loomwatch-backend/src/ai/reading.rs`). Each reading uses a little of the operator's
// OpenRouter credit, so one is had only when they tap Sharpen under an agent's suggestion, or on
// its own once they turn that on; only from an open model list, only for an agent the free reading
// can't place (agentSetup.ts `needsReading`), and once per setup: the daemon keeps every answer,
// and the app remembers the ones it has seen. Looking at what was kept is free.

import { useEffect, useState } from 'react'

import { JOB_KINDS, type AgentSetup, type JobKind, type SetupReading, type SuggestedAgent, needsReading, setupOf } from '../team-file/agentSetup'
import { useKeyStatus } from './useKeyStatus'

export interface ReadingStatus {
  enabled: boolean
  /** Setups read, ever. */
  readings: number
  /** Dollars those readings cost, as OpenRouter reported. */
  spent: number
  /** Calls made today, and the most made in a day. */
  today: number
  dailyLimit: number
}

/** Why a setup wasn't read: `off`, `not_kept`, `no_key`, `limit`, `resting`, `empty` or `failed`. */
export class ReadingRefused extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

const PATH = '/api/models/reading'

async function call<T>(method: string, body?: unknown): Promise<T> {
  const response = await fetch(PATH, {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new ReadingRefused(result?.error ?? 'LoomWatch couldn’t answer. Restart LoomWatch and try again.', result?.code ?? 'failed')
  return result as T
}

export const fetchReadingStatus = () => call<ReadingStatus>('GET')
export const saveReadingEnabled = (enabled: boolean) => call<ReadingStatus>('PUT', { enabled })

/** Who asks for a reading: the app on its own (only while that is on), a tap on Sharpen, or only a
    free look at what was kept. */
export type ReadAsk = 'auto' | 'once' | 'kept'

/** One setup read, or answered from what the daemon kept. */
export async function readSetup(setup: AgentSetup, ask: ReadAsk = 'auto'): Promise<{ reading: SetupReading; kept: boolean }> {
  const answer = await call<{ reading?: { kind?: string; probabilities?: Record<string, number>; confidence?: number }; kept?: boolean }>('POST', { setup, ...(ask === 'auto' ? {} : { ask }) })
  const kind = answer.reading?.kind
  if (!kind || !(JOB_KINDS as readonly string[]).includes(kind)) throw new ReadingRefused('The reading didn’t say what the agent does.', 'failed')
  const probabilities: Partial<Record<JobKind, number>> = {}
  for (const name of JOB_KINDS) {
    const value = answer.reading?.probabilities?.[name]
    if (typeof value === 'number') probabilities[name] = value
  }
  const confidence = answer.reading?.confidence
  return { reading: { kind: kind as JobKind, probabilities, ...(typeof confidence === 'number' ? { confidence } : {}) }, kept: answer.kept === true }
}

// Whether reading on its own is on, shared by every model list: turning it on in one shows in all.
let known: ReadingStatus | null = null
let pending: Promise<ReadingStatus> | null = null
const listeners = new Set<(status: ReadingStatus) => void>()

export function announceReadingStatus(status: ReadingStatus) {
  known = status
  for (const listener of listeners) listener(status)
}

function load(): Promise<ReadingStatus> {
  pending ??= fetchReadingStatus().then(
    (status) => { announceReadingStatus(status); return status },
    (error: unknown) => { pending = null; throw error },
  )
  return pending
}

/** Whether reading is on, and what it has cost; null until the daemon has answered. */
export function useReadingStatus(): ReadingStatus | null {
  const [status, setStatus] = useState<ReadingStatus | null>(known)
  useEffect(() => {
    listeners.add(setStatus)
    if (!known) load().catch(() => { /* reading stays off */ })
    return () => { listeners.delete(setStatus) }
  }, [])
  return status
}

// One reading per setup for the whole app: two pickers open on one agent wait on the same answer.
const read = new Map<string, SetupReading>()
const reading = new Map<string, Promise<SetupReading>>()

function readOnce(id: string, setup: AgentSetup, ask: ReadAsk): Promise<SetupReading> {
  const flight = `${ask}\n${id}`
  let promise = reading.get(flight)
  if (!promise) {
    promise = readSetup(setup, ask).then(
      (answer) => {
        read.set(id, answer.reading)
        reading.delete(flight)
        // A new reading cost something, and offers reading on its own from then on.
        if (!answer.kept) fetchReadingStatus().then(announceReadingStatus, () => {})
        return answer.reading
      },
      (error: unknown) => { reading.delete(flight); throw error },
    )
    reading.set(flight, promise)
  }
  return promise
}

export interface SetupReadingState {
  reading: SetupReading | null
  /** A reading is on its way. */
  pending: boolean
  /** Why it couldn't be read, in words; empty when nothing went wrong. */
  problem: string
  /** Reads this one agent's setup now, for a little credit: set while that could change something. */
  sharpen?: () => void
}

/**
 * The reading of `agent`'s whole setup while `active` (its model list is open), a key is set and
 * the free reading can't place the agent; else null and nothing is asked. With reading on its own,
 * it is read straight away; without, what was kept is looked at for free, and `sharpen` reads it.
 */
export function useSetupReading(agent: SuggestedAgent | undefined, active: boolean): SetupReadingState {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const wanted = Boolean(active && agent && status && key?.connected && needsReading(agent))
  const setup = wanted && agent ? setupOf(agent) : null
  const id = setup ? JSON.stringify(setup) : ''
  // The setup the operator tapped Sharpen on, while this list is open.
  const [tapped, setTapped] = useState('')
  const ask: ReadAsk = status?.enabled ? 'auto' : tapped === id ? 'once' : 'kept'
  const [answer, setAnswer] = useState<{ id: string; ask: ReadAsk; reading: SetupReading | null; problem: string }>({ id: '', ask: 'kept', reading: null, problem: '' })

  useEffect(() => {
    if (!id || !setup || read.has(id)) return
    let live = true
    readOnce(id, setup, ask).then(
      (found) => { if (live) setAnswer({ id, ask, reading: found, problem: '' }) },
      (error: unknown) => {
        if (!live) return
        const code = error instanceof ReadingRefused ? error.code : 'failed'
        // Never read, turned off, or no key: nothing to say; Sharpen or the key card is there.
        const quiet = code === 'not_kept' || code === 'off' || code === 'no_key'
        setAnswer({ id, ask, reading: null, problem: quiet ? '' : error instanceof Error ? error.message : 'The setup couldn’t be read.' })
      },
    )
    return () => { live = false }
    // `setup` is `id` parsed; the id and who asks say when to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ask])

  if (!id) return { reading: null, pending: false, problem: '' }
  const kept = read.get(id)
  if (kept) return { reading: kept, pending: false, problem: '' }
  const sharpen = ask === 'kept' ? () => setTapped(id) : undefined
  if (answer.id === id && answer.ask === ask) return { reading: answer.reading, pending: false, problem: answer.problem, ...(answer.problem ? {} : { sharpen }) }
  // A free look at what was kept is not a reading on its way.
  return { reading: null, pending: ask !== 'kept', problem: '', sharpen }
}

/** For tests: forget what was read and whether reading is on. */
export function forgetReadings() {
  known = null
  pending = null
  read.clear()
  reading.clear()
}

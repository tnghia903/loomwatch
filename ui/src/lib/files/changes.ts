import { useCallback, useEffect, useState } from 'react'

import type { ReplyTo } from '../chat/client'
import { daemonFetch } from '../daemonFetch'
import type { AskedPassage } from './passage'
import { refusal } from './reader'

/**
 * Changes left on a file for its agents (ADR 0107, step 3): a part of the file marked while Make
 * changes is on, and what should change there, for one agent. They wait on the file until Send;
 * then each agent gets one message with all of its changes on the file, and the agents on one file
 * take turns. The daemon keeps them (`GET /api/changes`); once sent, how each went is read from its
 * message in the chat, as an asked part's answer is.
 */

/** Where a change is: waiting for Send, sent and waiting its turn on the file, or sent. */
export type ChangeState = 'waiting' | 'queued' | 'sent'

export interface FileChange {
  id: string
  teamPath: string
  /** The file, by its full path. */
  file: string
  /** Who makes it. */
  agent: string
  /** What should change, as you typed it. */
  words: string
  /** The part of the file it is about, as Ask names one. */
  part: ReplyTo
  /** Pictures of the part, sent with it. */
  files: { path: string }[]
  createdAt: string
  state: ChangeState
  /** The chat message it went in, once sent. */
  messageId: string | null
  /** That message's work, once it started. */
  runId: string | null
  /** The copy of the file kept before that work, which Put back writes. */
  kept: string | null
  /** Its number in its message. */
  number: number | null
}

/** A change as its chat message carries it. */
export interface SentChange {
  id: string
  number: number
  words: string
  part: ReplyTo
}


const WRITE = { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' }

/** The changes left on a file, oldest first. */
export async function listChanges(teamPath: string, file: string, signal?: AbortSignal): Promise<FileChange[]> {
  const query = new URLSearchParams({ teamPath, file })
  const response = await daemonFetch(`/api/changes?${query.toString()}`, { signal, cache: 'no-store' })
  if (!response.ok) throw await refusal(response)
  // A daemon from before changes for agents answers no list: none are left.
  return ((await response.json()) as { changes?: FileChange[] }).changes ?? []
}

/** Leave a change on a part of a file, for an agent. */
export async function addChange(change: { teamPath: string; file: string; agent: string; words: string; part: ReplyTo; files: { path: string }[] }): Promise<FileChange> {
  const response = await daemonFetch('/api/changes', { method: 'POST', headers: WRITE, body: JSON.stringify(change) })
  if (!response.ok) throw await refusal(response)
  return (await response.json()) as FileChange
}

/** Take back a change not sent yet. */
export async function removeChange(id: string): Promise<void> {
  const response = await daemonFetch(`/api/changes/${encodeURIComponent(id)}`, { method: 'DELETE', headers: WRITE })
  if (!response.ok) throw await refusal(response)
}

/** Send every change waiting on a file: one message for each agent, in turns on the file. */
export async function sendChanges(teamPath: string, file: string): Promise<void> {
  const response = await daemonFetch('/api/changes/send', { method: 'POST', headers: WRITE, body: JSON.stringify({ teamPath, file }) })
  if (!response.ok) throw await refusal(response)
}

/** How often the changes on an open file are read again while any is waiting its turn or at work. */
const BUSY_MS = 2_000
/** And otherwise, for changes left from another device or tab. */
const IDLE_MS = 8_000

/**
 * The changes left on `file`, read again now and then, and at once after `refresh`. Nothing for no
 * team or no file.
 */
export function useFileChanges(teamPath: string | null, file: string | null): { changes: readonly FileChange[]; refresh: () => void } {
  const [read, setRead] = useState<{ key: string; changes: readonly FileChange[] }>({ key: '', changes: [] })
  const [asked, setAsked] = useState(0)
  const refresh = useCallback(() => setAsked((count) => count + 1), [])
  const key = teamPath && file ? `${teamPath}\u0000${file}` : ''
  const busy = read.key === key && read.changes.some((change) => change.state !== 'waiting')
  useEffect(() => {
    if (!teamPath || !file) return
    const controller = new AbortController()
    let timer = 0
    const again = () => {
      void listChanges(teamPath, file, controller.signal).then(
        (changes) => setRead({ key: `${teamPath}\u0000${file}`, changes }),
        () => undefined,
      ).finally(() => {
        if (!controller.signal.aborted) timer = window.setTimeout(again, busy ? BUSY_MS : IDLE_MS)
      })
    }
    again()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [teamPath, file, asked, busy])
  return { changes: read.key === key ? read.changes : NONE, refresh }
}

const NONE: readonly FileChange[] = []

/**
 * A file's parts asked about, with the changes left on it (ADR 0107): a change the chat already
 * has goes as its message goes, with where it is and its kept copy from the daemon; one waiting for
 * Send, or for its turn, is held at its part; one sent a moment ago, not in the chat yet, is at work.
 */
export function withChanges(asks: readonly AskedPassage[], changes: readonly FileChange[], file: string): AskedPassage[] {
  const left = new Map(changes.map((change) => [change.id, change]))
  const inChat = new Set<string>()
  const shown = asks.map((passage): AskedPassage => {
    if (!passage.change) return passage
    inChat.add(passage.change.id)
    const known = left.get(passage.change.id)
    if (!known) return passage
    const change = { ...passage.change, state: known.state, kept: known.kept }
    return known.state === 'sent' ? { ...passage, change } : { ...passage, change, answer: { state: 'held', why: known.state === 'waiting' ? 'send' : 'turn' } }
  })
  // The daemon answers for this file alone, by its canonical path, which may be spelled otherwise here.
  const rest = changes.filter((change) => !inChat.has(change.id)).map((change): AskedPassage => ({
    file, text: change.part.text, ...(change.part.at ? { at: change.part.at } : {}), from: change.agent, asked: change.words,
    runId: change.runId, messageId: change.messageId, onItsOwn: false,
    answer: change.state === 'sent' ? { state: 'working', by: change.agent } : { state: 'held', why: change.state === 'waiting' ? 'send' : 'turn' },
    change: { id: change.id, state: change.state, number: change.number, kept: change.kept },
  }))
  return [...shown, ...rest]
}

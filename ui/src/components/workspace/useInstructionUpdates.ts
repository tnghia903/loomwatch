// Instructions that still name a source the person removed, and their rewrite (ADR 0059).
//
// Removing a card, or the line from one agent to it, marks every agent whose instructions name the
// source: found by matching text, so it costs nothing. The agent can no longer use the source
// whatever its instructions say (ADR 0060); the mark is so the instructions can be made to match.
// Rewriting them is the person's call, because it is a turn of their Ask app. What comes back is
// applied as one ordinary edit, so one ⌘Z puts it all back and nothing is saved until the team is,
// and each change stays marked until the person keeps it or puts the old instructions back.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rewriteInstructions } from '../../lib/ask/client'
import { namesSource, type RemovedSource } from '../../lib/team-file/mentions'
import type { AgentConfig } from '../../lib/team-file/types'

/** `stale`: still names the source, nothing asked yet. */
export type InstructionUpdateState = 'stale' | 'working' | 'updated' | 'failed'

export interface InstructionUpdate {
  agentId: string
  source: RemovedSource
  /** The instructions when the source was removed. */
  before: string
  /** What LoomWatch put in their place, once it has. */
  after: string | null
  state: InstructionUpdateState
  /** Why they still name the source, in plain words. */
  error?: string
}

export interface InstructionUpdatesInput {
  agents: readonly AgentConfig[]
  teamPath: string | null
  /** The Ask app and model the person chose; null for the daemon's default. */
  app: string | null
  model: string | null
  /** Why no AI app can rewrite them here, or null when one can. */
  unavailable: string | null
  /** Whether the source is given again (an undo): the card is back, or the line for `source.from`. */
  isBack: (source: RemovedSource) => boolean
  setRoles: (roles: ReadonlyMap<string, string>) => void
  setRole: (agentId: string, role: string) => void
  rewrite?: typeof rewriteInstructions
}

export interface InstructionUpdates {
  /** The source was just taken from these agents: every agent for a card, one for a line. */
  removed: (source: RemovedSource, from: readonly AgentConfig[]) => void
  entries: readonly InstructionUpdate[]
  forAgent: (agentId: string) => InstructionUpdate | null
  /** The change is fine: stop marking it. */
  keep: (agentId: string) => void
  keepAll: () => void
  /** Put back the instructions as they were when the source was removed. */
  putBack: (agentId: string) => void
  /** Have the Ask app rewrite every agent whose instructions still name a removed source. */
  rewrite: () => void
  /** What each marked agent's card says. */
  notes: ReadonlyMap<string, string>
}

export const shortName = (source: RemovedSource) => source.name.replace(/^[^\p{L}\p{N}]+/u, '').split(/\s+[—–-]\s+|:\s+/)[0]?.trim() || source.name

const CHANGED_MEANWHILE = 'You changed them while they were being rewritten, so they are as you wrote them.'

export function useInstructionUpdates(input: InstructionUpdatesInput): InstructionUpdates {
  const [entries, setEntries] = useState<InstructionUpdate[]>([])
  const latest = useRef(input)
  useEffect(() => { latest.current = input })
  const entriesRef = useRef(entries)
  useEffect(() => { entriesRef.current = entries })

  // Another team is another set of agents.
  const [teamPath, setTeamPath] = useState(input.teamPath)
  if (teamPath !== input.teamPath) {
    setTeamPath(input.teamPath)
    setEntries([])
  }

  const ask = useCallback((source: RemovedSource, agents: readonly AgentConfig[]) => {
    const ids = new Set(agents.map((agent) => agent.id))
    const { unavailable, app, model, rewrite = rewriteInstructions } = latest.current
    const start = (agent: AgentConfig): InstructionUpdate => unavailable
      ? { agentId: agent.id, source, before: agent.role, after: null, state: 'failed', error: unavailable }
      : { agentId: agent.id, source, before: agent.role, after: null, state: 'working' }
    const started = agents.map(start)
    setEntries((current) => [...current.filter((entry) => !ids.has(entry.agentId)), ...started])
    if (unavailable) return
    const settle = (change: (entry: InstructionUpdate) => InstructionUpdate | null) => setEntries((current) => current.flatMap((entry) => {
      const mine = ids.has(entry.agentId) && entry.source.cardId === source.cardId && entry.state === 'working'
      if (!mine) return [entry]
      const next = change(entry)
      return next ? [next] : []
    }))
    void rewrite({ app, model, removed: { name: source.name, kind: source.kind }, agents: agents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })) })
      .then((answers) => {
        const now = latest.current
        if (now.isBack(source)) return settle(() => null)
        const roles = new Map<string, string>()
        const outcome = new Map<string, InstructionUpdate | null>()
        for (const entry of entriesRef.current) {
          if (!ids.has(entry.agentId) || entry.source.cardId !== source.cardId || entry.state !== 'working') continue
          const current = now.agents.find((agent) => agent.id === entry.agentId)
          const answer = answers.find((item) => item.id === entry.agentId)?.role
          if (!current) outcome.set(entry.agentId, null)
          else if (current.role !== entry.before) outcome.set(entry.agentId, { ...entry, state: 'failed', error: CHANGED_MEANWHILE })
          // Instructions that do not depend on the source come back as they were: nothing to mark.
          else if (answer === undefined || answer.trim() === entry.before.trim()) outcome.set(entry.agentId, null)
          else {
            // A block of instructions keeps its closing line break, so the file reads the same way.
            const after = entry.before.endsWith('\n') && !answer.endsWith('\n') ? `${answer}\n` : answer
            roles.set(entry.agentId, after)
            outcome.set(entry.agentId, { ...entry, after, state: 'updated' })
          }
        }
        now.setRoles(roles)
        settle((entry) => outcome.has(entry.agentId) ? outcome.get(entry.agentId) ?? null : entry)
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error && error.message ? error.message : 'The AI app did not answer.'
        settle((entry) => ({ ...entry, state: 'failed', error: reason }))
      })
  }, [])

  const removed = useCallback((source: RemovedSource, from: readonly AgentConfig[]) => {
    const naming = from.filter((agent) => agent.role.trim() !== '' && namesSource(agent, source))
    if (naming.length === 0) return
    const ids = new Set(naming.map((agent) => agent.id))
    setEntries((current) => [
      ...current.filter((entry) => !ids.has(entry.agentId)),
      ...naming.map((agent): InstructionUpdate => ({ agentId: agent.id, source, before: agent.role, after: null, state: 'stale' })),
    ])
  }, [])

  // An undo that put the old instructions back, an agent removed, or a mention the person edited
  // out themselves: nothing is left to mark.
  const { agents } = input
  const [seenAgents, setSeenAgents] = useState(agents)
  if (seenAgents !== agents) {
    setSeenAgents(agents)
    const settled = entries.filter((entry) => {
      const agent = agents.find((candidate) => candidate.id === entry.agentId)
      if (!agent) return false
      if (entry.state === 'updated') return agent.role !== entry.before
      if (entry.state === 'failed' || entry.state === 'stale') return namesSource(agent, entry.source)
      return true
    })
    if (settled.length !== entries.length) setEntries(settled)
  }

  const forAgent = useCallback((agentId: string) => entries.find((entry) => entry.agentId === agentId) ?? null, [entries])
  const keep = useCallback((agentId: string) => setEntries((current) => current.filter((entry) => entry.agentId !== agentId)), [])
  const keepAll = useCallback(() => setEntries((current) => current.filter((entry) => entry.state !== 'updated')), [])
  const putBack = useCallback((agentId: string) => {
    const entry = entriesRef.current.find((candidate) => candidate.agentId === agentId)
    if (!entry) return
    latest.current.setRole(agentId, entry.before)
    setEntries((current) => current.filter((candidate) => candidate.agentId !== agentId))
  }, [])
  const rewrite = useCallback(() => {
    const naming = entriesRef.current.filter((entry) => entry.state === 'failed' || entry.state === 'stale')
    for (const cardId of new Set(naming.map((entry) => entry.source.cardId))) {
      const forCard = naming.filter((entry) => entry.source.cardId === cardId)
      const agents = forCard.flatMap((entry) => latest.current.agents.find((agent) => agent.id === entry.agentId) ?? [])
      if (agents.length > 0) ask(forCard[0].source, agents)
    }
  }, [ask])

  const notes = useMemo(() => new Map(entries.map((entry) => [entry.agentId,
    entry.state === 'working' ? 'Rewriting instructions…'
      : entry.state === 'updated' ? 'Instructions updated'
        : `Still names ${shortName(entry.source)}`])), [entries])

  return { removed, entries, forAgent, keep, keepAll, putBack, rewrite, notes }
}

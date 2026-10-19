// An agent whose model follows the model suggested for it (ADR 0072). When its configuration
// settles after a change (a pause in typing), the model moves to what is suggested for it now, and
// the move is kept for a while so its model list can say what it was, with Undo. The team as it
// opened is taken as it is: nothing moves until something changes, except who pays. An agent on the
// model its suggestion names, paid another way than the suggestion now says (a plan connected since,
// ADR 0073), moves onto that way of paying, with the note. A new agent of the team's own is followed
// from the moment it appears, without a note, since it had no model of its own yet.
//
// With Let AI choose on, an agent the free reading can't place moves by AI's reading of its
// configuration (lib/ai/reading.ts), one per settled configuration. If AI can't read it, its model
// stays where it is rather than moving by a guess.

import { useCallback, useEffect, useRef, useState } from 'react'

import { type ModelTier, OFFLINE_MODEL, openRouterEquivalent, parseModelRef, tierModel } from '../ai/modelIds'
import { readingOf, useReadingStatus } from '../ai/reading'
import { connectedSources } from '../ai/sources'
import { useAiStatus, useKeyStatus } from '../ai/useKeyStatus'
import { type SetupReading, needsReading, setupOf } from './agentSetup'
import { suggestModel } from './modelSuggestion'
import type { AgentConfig } from './types'

/** How long a configuration stays unchanged before its model follows it. */
export const SETTLE_MS = 1200
/** How long a move is shown with Undo: long enough to read it and decide. */
export const MOVE_SHOWN_MS = 30_000

/** Where a model moved from and to, while its model list shows it. */
export interface ModelMove {
  from: string
  to: string
}

const NO_MOVES: ReadonlyMap<string, ModelMove> = new Map()

/** Whether the app may move `agent`'s model: it follows its suggestion and runs on a real model. */
export function follows(agent: AgentConfig): boolean {
  return agent.followsSuggestion === true && agent.kind !== 'operator' && !agent.from && Boolean(agent.model) && agent.model !== OFFLINE_MODEL
}

/**
 * Whether a following agent may move from `from` to `to` by itself (ADR 0073): on the same source;
 * from OpenRouter onto a plan the person connected; or from one plan onto another when `to` is its
 * tier's first-choice model, which a plan's own model stood in for while nothing connected could
 * run it. Never off a plan onto OpenRouter: that would start charging by itself.
 */
export function mayMoveBetween(from: string, to: string, tier?: ModelTier): boolean {
  const before = parseModelRef(from).source
  const after = parseModelRef(to)
  if (before === after.source || before === 'openrouter') return true
  return after.source !== 'openrouter' && tier !== undefined && openRouterEquivalent(after) === tierModel(tier)
}

/** The suggestion names `agent`'s model but another way of paying for it: a plan connected since. */
function paidAnotherWay(agent: AgentConfig, agents: readonly AgentConfig[], responder: string | null): boolean {
  const { model: to, tier } = suggestModel({ agent, team: { agents, responder } })
  const from = agent.model as string
  return to !== from && openRouterEquivalent(parseModelRef(to)) === openRouterEquivalent(parseModelRef(from)) && mayMoveBetween(from, to, tier)
}

/** What `agent`'s suggestion depends on; when this changes, its model may move. */
export function followSignature(agent: AgentConfig, agents: readonly AgentConfig[], responder: string | null, aiChooses: boolean, sources = ''): string {
  const checked = agent.checks ? agents.find((other) => other.id === agent.checks)?.model ?? null : null
  return JSON.stringify([setupOf(agent), agent.checks ?? null, checked, responder === agent.id, aiChooses && needsReading(agent), sources])
}

export interface ModelFollowing {
  /** Each agent whose model just moved: what it was and is. */
  moves: ReadonlyMap<string, ModelMove>
  /** Puts back the model it had and stops it following. */
  undo: (agentId: string) => void
}

export function useModelFollowing({ team, agents, responder, editable, move, pin }: {
  /** The team open: a new one starts over. */
  team: string | null
  agents: readonly AgentConfig[]
  responder: string | null
  editable: boolean
  /** Moves a following agent's model, and it keeps following. */
  move: (agentId: string, model: string) => void
  /** Puts `model` back and stops the agent following: Undo. */
  pin: (agentId: string, model: string) => void
}): ModelFollowing {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const ai = useAiStatus()
  // The ways of paying connected: when one connects or goes, following agents' suggestions move.
  const sources = ai ? connectedSources(ai).join(' ') : ''
  const ready = status !== null && key !== null && ai !== null
  const aiChooses = Boolean(status?.enabled && key?.connected)
  // The moves shown, for the team they were made in: another team's are never shown.
  const [shown, setShown] = useState<{ team: string | null; moves: ReadonlyMap<string, ModelMove> }>(() => ({ team, moves: NO_MOVES }))
  const moves = shown.team === team ? shown.moves : NO_MOVES
  // Each following agent's signature as last followed; null until the team is first seen.
  const seen = useRef<Map<string, string> | null>(null)
  // Every agent seen in this team, and those added since it opened that haven't settled yet: a new
  // agent had no model of its own, so its first move needs no note.
  const known = useRef(new Set<string>())
  const fresh = useRef(new Set<string>())
  // Each agent waiting for its configuration to settle: the signature it waits on, and its timer.
  const timers = useRef(new Map<string, { signature: string; timer: ReturnType<typeof setTimeout> }>())
  const latest = useRef({ team, agents, responder, aiChooses, sources, move, pin, moves })
  useEffect(() => { latest.current = { team, agents, responder, aiChooses, sources, move, pin, moves } })

  // Another team: nothing carries over.
  useEffect(() => {
    seen.current = null
    known.current = new Set()
    fresh.current = new Set()
    for (const { timer } of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [team])

  useEffect(() => () => { for (const { timer } of timers.current.values()) clearTimeout(timer) }, [])

  const settle = useCallback(async (id: string, signature: string) => {
    timers.current.delete(id)
    const signatureNow = () => {
      const now = latest.current
      const agent = now.agents.find((each) => each.id === id)
      return agent && follows(agent) ? followSignature(agent, now.agents, now.responder, now.aiChooses, now.sources) : null
    }
    if (signatureNow() !== signature) return
    let reading: SetupReading | null = null
    const agent = latest.current.agents.find((each) => each.id === id) as AgentConfig
    if (latest.current.aiChooses && needsReading(agent)) {
      try {
        reading = await readingOf(setupOf(agent))
      } catch {
        return
      }
      // Changed while AI read it: that change has its own turn.
      if (signatureNow() !== signature) return
    }
    seen.current?.set(id, signature)
    const isNew = fresh.current.delete(id)
    const now = latest.current
    const current = now.agents.find((each) => each.id === id) as AgentConfig
    const { model: to, tier } = suggestModel({ agent: current, team: { agents: now.agents, responder: now.responder }, reading })
    if (!current.model || to === current.model || !mayMoveBetween(current.model, to, tier)) return
    const from = current.model
    now.move(id, to)
    if (isNew) return
    const madeIn = now.team
    setShown((before) => ({ team: madeIn, moves: new Map(before.team === madeIn ? before.moves : NO_MOVES).set(id, { from, to }) }))
    setTimeout(() => setShown((before) => {
      if (before.team !== madeIn || before.moves.get(id)?.to !== to) return before
      const next = new Map(before.moves)
      next.delete(id)
      return { team: madeIn, moves: next }
    }), MOVE_SHOWN_MS)
  }, [])

  useEffect(() => {
    if (!ready || !editable) return
    const following = agents.filter(follows)
    if (!seen.current) {
      // As it opened, except an agent whose model a plan connected since pays for: it moves below.
      seen.current = new Map(following.filter((agent) => !paidAnotherWay(agent, agents, responder)).map((agent) => [agent.id, followSignature(agent, agents, responder, aiChooses, sources)]))
      known.current = new Set(agents.map((agent) => agent.id))
    }
    for (const agent of agents) {
      if (known.current.has(agent.id)) continue
      known.current.add(agent.id)
      fresh.current.add(agent.id)
    }
    for (const agent of following) {
      const signature = followSignature(agent, agents, responder, aiChooses, sources)
      const waiting = timers.current.get(agent.id)
      // Already followed, or already waiting on this very configuration: a render isn't a change.
      if (seen.current.get(agent.id) === signature || waiting?.signature === signature) continue
      if (waiting) clearTimeout(waiting.timer)
      timers.current.set(agent.id, { signature, timer: setTimeout(() => { void settle(agent.id, signature) }, SETTLE_MS) })
    }
  }, [agents, responder, aiChooses, sources, ready, editable, settle])

  const undo = useCallback((agentId: string) => {
    const move = latest.current.moves.get(agentId)
    if (!move) return
    latest.current.pin(agentId, move.from)
    setShown((before) => {
      const next = new Map(before.moves)
      next.delete(agentId)
      return { team: before.team, moves: next }
    })
  }, [])

  return { moves, undo }
}

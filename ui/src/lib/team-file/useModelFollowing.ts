// An agent whose model follows the model suggested for it (ADR 0072). When its configuration
// settles after a change (a pause in typing), the model moves to what is suggested for it now, and
// the move is kept for a while so its model list can say what it was, with Undo. The team as it
// opened is taken as it is: nothing moves until something changes, except who pays and what agents'
// models lean to. An agent on the model its suggestion names, paid another way than the suggestion
// now says (a plan connected since, ADR 0073), moves onto that way of paying, with the note; one on
// what its suggestion was at another priority (the person moved Saving, Balance or Highest quality
// since, ADR 0112) moves to what it is now, with the note. Moving the priority while the team is
// open moves them too. A new agent of the team's own is followed from the moment it appears,
// without a note, since it had no model of its own yet.
//
// With Let AI choose on, an agent the free reading can't place moves by AI's reading of its
// configuration (lib/ai/reading.ts), one per settled configuration. If AI can't read it, its model
// stays where it is rather than moving by a guess.
//
// Its thinking effort moves with it to the one its suggestion gives (ADR 0062), on a model that
// reasons, while the effort is still the one its last suggestion gave: an effort set by hand stays.

import { useCallback, useEffect, useRef, useState } from 'react'

import { modelEfforts } from '../ai/efforts'
import { DEFAULT_PRIORITY, OFFLINE_MODEL, PRIORITIES, type Priority, openRouterEquivalent, parseModelRef } from '../ai/modelIds'
import { readingOf, useReadingStatus } from '../ai/reading'
import { connectedSources } from '../ai/sources'
import { useAiStatus, useKeyStatus } from '../ai/useKeyStatus'
import { useModels } from '../ai/useModels'
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
  /** The effort it had when the effort moved too, '' for the model's own; absent when it stayed. */
  fromEffort?: string
  /** The stop of the agents' models slider it moved for, when it moved because the person moved that. */
  priority?: Priority
}

const NO_MOVES: ReadonlyMap<string, ModelMove> = new Map()

/** Whether the app may move `agent`'s model: it follows its suggestion and runs on a real model. */
export function follows(agent: AgentConfig): boolean {
  return agent.followsSuggestion === true && agent.kind !== 'operator' && !agent.from && Boolean(agent.model) && agent.model !== OFFLINE_MODEL
}

/**
 * Whether a following agent may move from `from` to `to` by itself (ADR 0073): on the same source;
 * from OpenRouter onto a plan the person connected; or from one plan onto another when `to` is the
 * first-choice model (`first`, an OpenRouter id: its suggestion's), which a plan's own model stood
 * in for while nothing connected could run it. Never off a plan onto OpenRouter: that would start
 * charging by itself.
 */
export function mayMoveBetween(from: string, to: string, first?: string): boolean {
  const before = parseModelRef(from).source
  const after = parseModelRef(to)
  if (before === after.source || before === 'openrouter') return true
  return after.source !== 'openrouter' && first !== undefined && openRouterEquivalent(after) === first
}

/** The suggestion names `agent`'s model but another way of paying for it: a plan connected since. */
function paidAnotherWay(agent: AgentConfig, agents: readonly AgentConfig[], responder: string | null): boolean {
  const { model: to, first } = suggestModel({ agent, team: { agents, responder } })
  const from = agent.model as string
  return to !== from && openRouterEquivalent(parseModelRef(to)) === openRouterEquivalent(parseModelRef(from)) && mayMoveBetween(from, to, first)
}

/** The suggestion was `agent`'s model at another priority than `priority`, and isn't at it: the person moved the slider since. */
function setAtAnotherPriority(agent: AgentConfig, agents: readonly AgentConfig[], responder: string | null, priority: Priority): boolean {
  const team = { agents, responder }
  const at = (each: Priority) => canonicalOf(suggestModel({ agent, team, priority: each }).model)
  const had = canonicalOf(agent.model as string)
  return at(priority) !== had && PRIORITIES.some((each) => each !== priority && at(each) === had)
}

/** A model as its source names it, without its effort, for telling two apart. */
const canonicalOf = (model: string) => openRouterEquivalent(parseModelRef(model))

/** What `agent`'s suggestion depends on; when this changes, its model may move. */
export function followSignature(agent: AgentConfig, agents: readonly AgentConfig[], responder: string | null, aiChooses: boolean, sources = '', priority: Priority = DEFAULT_PRIORITY): string {
  const checked = agent.checks ? agents.find((other) => other.id === agent.checks)?.model ?? null : null
  return JSON.stringify([setupOf(agent), agent.checks ?? null, checked, responder === agent.id, aiChooses && needsReading(agent), sources, priority])
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
  /** Moves a following agent's model, and its effort when `effort` is given ('' for the model's own). */
  move: (agentId: string, model: string, effort?: string) => void
  /** Puts `model` back, with its effort when given, and stops the agent following: Undo. */
  pin: (agentId: string, model: string, effort?: string) => void
}): ModelFollowing {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const ai = useAiStatus()
  const { catalog } = useModels()
  // The ways of paying connected: when one connects or goes, following agents' suggestions move.
  const sources = ai ? connectedSources(ai).join(' ') : ''
  // What agents' models lean to: when the person moves it, following agents' suggestions move.
  const priority = ai?.priority ?? DEFAULT_PRIORITY
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
  // Each following agent's effort as its suggestion last gave it: while its effort is that one, the
  // effort follows too.
  const given = useRef(new Map<string, string>())
  // Following agents whose next move is for the slider, not their configuration, and the stop last seen.
  const forPriority = useRef(new Set<string>())
  const lastPriority = useRef(priority)
  const latest = useRef({ team, agents, responder, aiChooses, sources, priority, move, pin, moves, ai, catalog })
  useEffect(() => { latest.current = { team, agents, responder, aiChooses, sources, priority, move, pin, moves, ai, catalog } })

  // Another team: nothing carries over.
  useEffect(() => {
    seen.current = null
    known.current = new Set()
    fresh.current = new Set()
    given.current = new Map()
    forPriority.current = new Set()
    for (const { timer } of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [team])

  useEffect(() => () => { for (const { timer } of timers.current.values()) clearTimeout(timer) }, [])

  const settle = useCallback(async (id: string, signature: string) => {
    timers.current.delete(id)
    const signatureNow = () => {
      const now = latest.current
      const agent = now.agents.find((each) => each.id === id)
      return agent && follows(agent) ? followSignature(agent, now.agents, now.responder, now.aiChooses, now.sources, now.priority) : null
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
    const slider = forPriority.current.delete(id)
    const now = latest.current
    const current = now.agents.find((each) => each.id === id) as AgentConfig
    const { model: suggested, first, effort } = suggestModel({ agent: current, team: { agents: now.agents, responder: now.responder }, reading, priority: now.priority })
    const had = current.thinkingEffort ?? ''
    const effortFollows = isNew || had === given.current.get(id)
    given.current.set(id, effort)
    if (!current.model) return
    const to = mayMoveBetween(current.model, suggested, first) ? suggested : current.model
    const thinks = modelEfforts(to, now.ai, now.catalog).levels.length > 0
    const moveEffort = effortFollows && thinks && effort !== had
    if (to === current.model && !moveEffort) return
    const from = current.model
    if (moveEffort) now.move(id, to, effort)
    else now.move(id, to)
    if (isNew) return
    const madeIn = now.team
    const made: ModelMove = { from, to, ...(moveEffort ? { fromEffort: had } : {}), ...(slider ? { priority: now.priority } : {}) }
    setShown((before) => ({ team: madeIn, moves: new Map(before.team === madeIn ? before.moves : NO_MOVES).set(id, made) }))
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
    for (const agent of agents) if (!follows(agent)) given.current.delete(agent.id)
    if (!seen.current) {
      // As it opened, except an agent whose model a plan connected since pays for, or whose model was
      // its suggestion at another priority: it moves below.
      const atAnother = following.filter((agent) => setAtAnotherPriority(agent, agents, responder, priority))
      forPriority.current = new Set(atAnother.map((agent) => agent.id))
      seen.current = new Map(following.filter((agent) => !paidAnotherWay(agent, agents, responder) && !atAnother.includes(agent)).map((agent) => [agent.id, followSignature(agent, agents, responder, aiChooses, sources, priority)]))
      known.current = new Set(agents.map((agent) => agent.id))
      lastPriority.current = priority
    }
    if (priority !== lastPriority.current) {
      lastPriority.current = priority
      for (const agent of following) forPriority.current.add(agent.id)
    }
    for (const agent of agents) {
      if (known.current.has(agent.id)) continue
      known.current.add(agent.id)
      fresh.current.add(agent.id)
    }
    for (const agent of following) {
      // As it opened, or as it started following: picking its suggestion gave it that effort.
      if (!given.current.has(agent.id)) given.current.set(agent.id, suggestModel({ agent, team: { agents, responder }, priority }).effort)
      const signature = followSignature(agent, agents, responder, aiChooses, sources, priority)
      const waiting = timers.current.get(agent.id)
      // Already followed, or already waiting on this very configuration: a render isn't a change.
      if (seen.current.get(agent.id) === signature || waiting?.signature === signature) continue
      if (waiting) clearTimeout(waiting.timer)
      timers.current.set(agent.id, { signature, timer: setTimeout(() => { void settle(agent.id, signature) }, SETTLE_MS) })
    }
  }, [agents, responder, aiChooses, sources, priority, ready, editable, settle])

  const undo = useCallback((agentId: string) => {
    const move = latest.current.moves.get(agentId)
    if (!move) return
    if (move.fromEffort === undefined) latest.current.pin(agentId, move.from)
    else latest.current.pin(agentId, move.from, move.fromEffort)
    setShown((before) => {
      const next = new Map(before.moves)
      next.delete(agentId)
      return { team: before.team, moves: next }
    })
  }, [])

  return { moves, undo }
}

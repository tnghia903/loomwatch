import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_MODEL, FAST_MODEL } from '../ai/modelIds'
import { forgetReadings } from '../ai/reading'
import { forgetKeyStatus } from '../ai/useKeyStatus'
import { onTheFastTier } from '../library/onTheFastTier'
import { ROLE_PRESETS } from '../library/roles'
import type { AgentConfig } from './types'
import { MOVE_SHOWN_MS, SETTLE_MS, useModelFollowing } from './useModelFollowing'

const roleOf = (id: string) => ROLE_PRESETS.find((preset) => preset.id === id)!.role
const writer: AgentConfig = { id: 'writer', name: 'Writer', role: roleOf('writer'), model: DEFAULT_MODEL }
// A team's own agent that writes for now, and follows its suggestion.
const helper: AgentConfig = { id: 'helper', name: 'Helper', role: roleOf('writer'), model: DEFAULT_MODEL, followsSuggestion: true }
// The same agent once its instructions say it gathers for the writer.
const gathering = { ...helper, role: roleOf('researcher') }

let readingOn = false
let readings = 0
let readingFails = false
let ai: unknown = { openrouter: { connected: true } }

beforeEach(() => {
  vi.useFakeTimers()
  forgetReadings(); forgetKeyStatus()
  readingOn = false; readings = 0; readingFails = false
  ai = { openrouter: { connected: true } }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    if (path === '/api/ai') return json(ai)
    if (path === '/api/models/reading' && init?.method === 'POST') {
      readings += 1
      if (readingFails) return json({ error: 'Reading failed a moment ago.', code: 'resting' }, 409)
      return json({ reading: { kind: 'gather', probabilities: { gather: 0.95 }, confidence: 0.9 }, kept: false })
    }
    if (path === '/api/models/reading') return json({ enabled: readingOn, readings, spent: 0, today: readings, dailyLimit: 50 })
    return json({ error: 'not found' }, 404)
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function follow(agents: readonly AgentConfig[]) {
  const move = vi.fn()
  const pin = vi.fn()
  const hook = renderHook(({ agents: now }) => useModelFollowing({ team: 'team.yaml', agents: now, responder: 'writer', editable: true, move, pin }), { initialProps: { agents } })
  return { ...hook, move, pin }
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(SETTLE_MS + 10))

describe('useModelFollowing', () => {
  it('moves a following agent onto a plan connected since that pays for its model, and never onto OpenRouter by itself', onTheFastTier(async () => {
    ai = { openrouter: { connected: true }, anthropic: { connected: true } }
    // The helper follows and is on Claude Opus through OpenRouter; the Claude credit now pays for it.
    const { result, move } = follow([writer, { ...helper }, { ...helper, id: 'planned', model: 'chatgpt:gpt-6.1-sol' }])
    // The first pause reads what is connected; the move waits a pause after that.
    await settle()
    await settle()
    expect(move).toHaveBeenCalledTimes(1)
    expect(move).toHaveBeenCalledWith('helper', 'anthropic:claude-opus-5-5')
    expect(result.current.moves.get('helper')).toEqual({ from: DEFAULT_MODEL, to: 'anthropic:claude-opus-5-5' })
    // The pinned writer stays put, and the agent on the ChatGPT plan isn't moved off it.
    expect(move).not.toHaveBeenCalledWith('writer', expect.anything())
    expect(move).not.toHaveBeenCalledWith('planned', expect.anything())
  }))

  it('takes the team as it opened, and moves a following agent once its configuration settles', onTheFastTier(async () => {
    // Opened gathering, yet on the strongest model: nothing changed, so nothing moves.
    const { rerender, result, move } = follow([writer, { ...gathering }])
    await settle()
    expect(move).not.toHaveBeenCalled()

    // Changed while typing: it waits for the pause, then moves once.
    rerender({ agents: [writer, { ...gathering, role: `${gathering.role} Use` }] })
    await act(() => vi.advanceTimersByTimeAsync(SETTLE_MS / 2))
    rerender({ agents: [writer, { ...gathering, role: `${gathering.role} Use the Brief's sources first.` }] })
    await act(() => vi.advanceTimersByTimeAsync(SETTLE_MS / 2))
    expect(move).not.toHaveBeenCalled()
    await settle()
    expect(move).toHaveBeenCalledTimes(1)
    expect(move).toHaveBeenCalledWith('helper', FAST_MODEL)
    expect(result.current.moves.get('helper')).toEqual({ from: DEFAULT_MODEL, to: FAST_MODEL })

    // The note goes after a while.
    await act(() => vi.advanceTimersByTimeAsync(MOVE_SHOWN_MS))
    expect(result.current.moves.size).toBe(0)
  }))

  // The workbench renders often (its figure moves): a render with nothing changed isn't a change, so
  // it never puts the move off.
  it('moves even while the page keeps rendering', onTheFastTier(async () => {
    const { rerender, move } = follow([writer, helper])
    await settle()
    const changed = [writer, gathering]
    for (let step = 0; step < 6; step += 1) {
      rerender({ agents: [...changed] })
      await act(() => vi.advanceTimersByTimeAsync(SETTLE_MS / 4))
    }
    expect(move).toHaveBeenCalledWith('helper', FAST_MODEL)
  }))

  it('leaves a pinned agent’s model alone, and moves a new following agent without a note', onTheFastTier(async () => {
    const pinned = { ...helper, followsSuggestion: undefined }
    const { rerender, result, move } = follow([writer, pinned])
    await settle()
    rerender({ agents: [writer, { ...pinned, role: roleOf('researcher') }] })
    await settle()
    expect(move).not.toHaveBeenCalled()

    // Added after the team opened, still on the model it was made with.
    rerender({ agents: [writer, { ...pinned, role: roleOf('researcher') }, { ...gathering, id: 'scout', name: 'Scout' }] })
    await settle()
    expect(move).toHaveBeenCalledWith('scout', FAST_MODEL)
    expect(result.current.moves.size).toBe(0)
  }))

  // Picked to follow, then changed before the pick had settled: it had a model of its own, so the
  // move is noted, as for any agent that was there when the team opened.
  it('notes a move right after an agent starts following', onTheFastTier(async () => {
    const pinned = { ...helper, followsSuggestion: undefined }
    const { rerender, result, move } = follow([writer, pinned])
    await settle()
    rerender({ agents: [writer, { ...pinned, followsSuggestion: true }] })
    await act(() => vi.advanceTimersByTimeAsync(SETTLE_MS / 3))
    rerender({ agents: [writer, gathering] })
    await settle()
    expect(move).toHaveBeenCalledWith('helper', FAST_MODEL)
    expect(result.current.moves.get('helper')).toEqual({ from: DEFAULT_MODEL, to: FAST_MODEL })
  }))

  it('puts the model back and stops following on Undo', onTheFastTier(async () => {
    const { rerender, result, pin } = follow([writer, helper])
    await settle()
    rerender({ agents: [writer, gathering] })
    await settle()
    act(() => result.current.undo('helper'))
    expect(pin).toHaveBeenCalledWith('helper', DEFAULT_MODEL)
    expect(result.current.moves.size).toBe(0)
  }))

  it('with Let AI choose on, moves an unclear agent by AI’s reading, and stays put when AI can’t read it', async () => {
    readingOn = true
    // "Do not judge the stories or write them": the free reading calls it a writer.
    const unclear = { ...helper, name: 'Gatherer', role: 'Find what happened in tech in the last 24 hours, from the trusted sources only. Do not judge the stories or write them: the Writer does.' }
    const { rerender, move } = follow([writer, { ...unclear, role: `${unclear.role} Keep it short.` }])
    await settle()
    readingFails = true
    rerender({ agents: [writer, unclear] })
    await settle()
    expect(readings).toBe(1)
    expect(move).not.toHaveBeenCalled()

    readingFails = false
    rerender({ agents: [writer, { ...unclear, role: `${unclear.role} Skip opinion pieces.` }] })
    await settle()
    expect(readings).toBe(2)
    expect(move).toHaveBeenCalledWith('helper', FAST_MODEL)
  })
})

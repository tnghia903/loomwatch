import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { InstructionsRewrite } from '../../lib/ask/client'
import { removedSource } from '../../lib/team-file/mentions'
import type { AgentConfig } from '../../lib/team-file/types'
import { useInstructionUpdates, type InstructionUpdatesInput } from './useInstructionUpdates'

const ekis = removedSource({ id: 'notion@807', kind: 'knowledge', name: 'EKIS — SUTD Final Project Hub', notion: { page: '807' } })

function agent(id: string, role: string): AgentConfig {
  return { id, name: `${id} agent`, role, spawn: { cmd: 'claude', args: [], env: {}, cwd: '.' }, model: '' } as AgentConfig
}

const SCOPE = 'Establish the problem. Locate the EKIS page through the connected Notion tools.\n'
const PLAN = 'Maintain the plan on the canonical EKIS page.'
const WRITER = 'Write the final answer.'

/** A rewrite the test answers by hand, and the team it is wired to. */
function setup(overrides: Partial<InstructionUpdatesInput> = {}) {
  let answer: (agents: { id: string; role: string }[]) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const rewrite = vi.fn((_request: InstructionsRewrite) => new Promise<{ id: string; role: string }[]>((resolve, reject) => { answer = resolve; fail = reject }))
  const team = { agents: [agent('scope', SCOPE), agent('plan', PLAN), agent('writer', WRITER)], cardBack: false }
  const setRoles = vi.fn((roles: ReadonlyMap<string, string>) => {
    team.agents = team.agents.map((one) => roles.has(one.id) ? { ...one, role: roles.get(one.id) as string } : one)
  })
  const setRole = vi.fn((id: string, role: string) => { team.agents = team.agents.map((one) => one.id === id ? { ...one, role } : one) })
  const props = (): InstructionUpdatesInput => ({
    agents: team.agents, teamPath: 'research.yaml', app: 'claude', model: null, unavailable: null,
    isBack: () => team.cardBack, setRoles, setRole, rewrite, ...overrides,
  })
  const hook = renderHook(() => useInstructionUpdates(props()))
  return {
    hook, team, rewrite, setRoles, setRole,
    rerender: () => hook.rerender(),
    answer: async (agents: { id: string; role: string }[]) => { await act(async () => { answer(agents) }); hook.rerender() },
    fail: async (message: string) => { await act(async () => { fail(new Error(message)) }); hook.rerender() },
    remove: () => act(() => hook.result.current.removed(ekis, team.agents)),
  }
}

describe('useInstructionUpdates', () => {
  it('marks the agents that still name what was removed, and asks no app until told to', () => {
    const t = setup()
    t.remove()
    expect(t.rewrite).not.toHaveBeenCalled()
    expect(t.hook.result.current.forAgent('scope')).toMatchObject({ state: 'stale', before: SCOPE })
    expect(t.hook.result.current.notes.get('plan')).toBe('Still names EKIS')
    expect(t.hook.result.current.notes.has('writer')).toBe(false)
  })

  it('on request, rewrites only the agents that named what was removed, in one edit, and marks each one', async () => {
    const t = setup()
    t.remove()
    act(() => t.hook.result.current.rewrite())
    expect(t.rewrite).toHaveBeenCalledTimes(1)
    expect(t.rewrite.mock.calls[0][0]).toMatchObject({
      app: 'claude', removed: { name: 'EKIS — SUTD Final Project Hub', kind: 'Notion page' },
      agents: [{ id: 'scope', role: SCOPE }, { id: 'plan', role: PLAN }],
    })
    expect(t.hook.result.current.notes.get('scope')).toBe('Rewriting instructions…')
    expect(t.hook.result.current.notes.has('writer')).toBe(false)

    await t.answer([{ id: 'scope', role: 'Establish the problem.' }, { id: 'plan', role: 'Maintain the plan.' }])
    expect(t.setRoles).toHaveBeenCalledTimes(1)
    expect(Object.fromEntries(t.setRoles.mock.calls[0][0])).toEqual({ scope: 'Establish the problem.\n', plan: 'Maintain the plan.' })
    expect(t.hook.result.current.forAgent('scope')).toMatchObject({ state: 'updated', before: SCOPE, after: 'Establish the problem.\n' })
    expect(t.hook.result.current.notes.get('plan')).toBe('Instructions updated')
  })

  it('marks nothing for an agent whose instructions came back as they were', async () => {
    const t = setup()
    t.remove()
    act(() => t.hook.result.current.rewrite())
    await t.answer([{ id: 'scope', role: 'Establish the problem.' }, { id: 'plan', role: ` ${PLAN} ` }])
    expect(t.hook.result.current.forAgent('plan')).toBeNull()
    expect([...t.setRoles.mock.calls[0][0].keys()]).toEqual(['scope'])
  })

  it('leaves instructions the person changed meanwhile as they wrote them, and says so', async () => {
    const t = setup()
    t.remove()
    act(() => t.hook.result.current.rewrite())
    t.team.agents = t.team.agents.map((one) => one.id === 'plan' ? { ...one, role: 'Maintain the plan on the EKIS page, my way.' } : one)
    t.rerender()
    await t.answer([{ id: 'scope', role: 'Establish the problem.' }, { id: 'plan', role: 'Maintain the plan.' }])
    expect([...t.setRoles.mock.calls[0][0].keys()]).toEqual(['scope'])
    expect(t.hook.result.current.forAgent('plan')).toMatchObject({ state: 'failed', error: expect.stringContaining('as you wrote them') })
    expect(t.hook.result.current.notes.get('plan')).toBe('Still names EKIS')
  })

  it('applies nothing once the card is back on the canvas', async () => {
    const t = setup()
    t.remove()
    act(() => t.hook.result.current.rewrite())
    t.team.cardBack = true
    await t.answer([{ id: 'scope', role: 'Establish the problem.' }])
    expect(t.setRoles).not.toHaveBeenCalled()
    expect(t.hook.result.current.entries).toEqual([])
  })

  it('says why when no AI app can rewrite them, and asks nobody', () => {
    const t = setup({ unavailable: 'No AI app that can run Ask was found on this computer.' })
    t.remove()
    act(() => t.hook.result.current.rewrite())
    expect(t.rewrite).not.toHaveBeenCalled()
    expect(t.hook.result.current.forAgent('scope')).toMatchObject({ state: 'failed', error: 'No AI app that can run Ask was found on this computer.' })
  })

  it('puts the old instructions back on request, and forgets a change an undo took back', async () => {
    const t = setup()
    t.remove()
    act(() => t.hook.result.current.rewrite())
    await t.answer([{ id: 'scope', role: 'Establish the problem.' }, { id: 'plan', role: 'Maintain the plan.' }])
    act(() => t.hook.result.current.putBack('scope'))
    expect(t.setRole).toHaveBeenCalledWith('scope', SCOPE)
    expect(t.hook.result.current.forAgent('scope')).toBeNull()

    t.team.agents = t.team.agents.map((one) => one.id === 'plan' ? { ...one, role: PLAN } : one)
    t.rerender()
    expect(t.hook.result.current.forAgent('plan')).toBeNull()
  })

  it('keeps a failure marked until it is tried again', async () => {
    const t = setup()
    t.remove()
    act(() => t.hook.result.current.rewrite())
    await t.fail('Claude Code stopped answering: timeout')
    expect(t.hook.result.current.forAgent('scope')).toMatchObject({ state: 'failed', error: 'Claude Code stopped answering: timeout' })
    act(() => t.hook.result.current.rewrite())
    expect(t.rewrite).toHaveBeenCalledTimes(2)
    expect(t.rewrite.mock.calls[1][0].agents.map((one) => one.id)).toEqual(['scope', 'plan'])
    expect(t.hook.result.current.forAgent('scope')?.state).toBe('working')
  })

  it('marks nobody when nobody named it, and forgets a mark the operator edited away', () => {
    const t = setup()
    act(() => t.hook.result.current.removed(removedSource({ id: 'skill:canvas-design', kind: 'skill', name: 'canvas-design' }), t.team.agents))
    expect(t.hook.result.current.entries).toEqual([])

    t.remove()
    t.team.agents = t.team.agents.map((one) => one.id === 'plan' ? { ...one, role: 'Maintain the plan.' } : one)
    t.rerender()
    expect(t.hook.result.current.forAgent('plan')).toBeNull()
    expect(t.hook.result.current.forAgent('scope')?.state).toBe('stale')
    act(() => t.hook.result.current.rewrite())
    expect(t.rewrite.mock.calls[0][0].agents.map((one) => one.id)).toEqual(['scope'])
  })
})

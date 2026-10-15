import { afterEach, describe, expect, it } from 'vitest'

import { TOUR_STEPS, type TourStep } from './steps'

const step = (id: TourStep['id']) => TOUR_STEPS.find((candidate) => candidate.id === id)!
const ready = { readyApps: ['Claude', 'Codex'], appsLoading: false }

afterEach(() => { document.body.innerHTML = '' })

describe('getting-started guide steps', () => {
  it('follows the work: build an agent in Your agents, then a team, then its chat', () => {
    const screens = TOUR_STEPS.map((candidate) => candidate.screen).filter((screen, at, all) => screen !== all[at - 1])
    expect(screens).toEqual(['any', 'home', 'agents', 'home', 'workspace', 'any'])
    const order = (id: TourStep['id']) => TOUR_STEPS.indexOf(step(id))
    expect(order('build-agent')).toBeLessThan(order('try'))
    expect(order('try')).toBeLessThan(order('save'))
    expect(order('save')).toBeLessThan(order('new-team'))
    expect(order('team-agents')).toBeLessThan(order('workflow'))
    expect(order('workflow')).toBeLessThan(order('ask'))
  })

  it('names the AI apps it found, or asks for one before the first agent', () => {
    expect(step('build-agent').view(ready)).toMatchObject({ title: 'Build your first agent', target: ['[data-tour="build-agent"]'] })
    expect(step('build-agent').view(ready).body).toContain('LoomWatch found Claude and Codex')
    expect(step('build-agent').view({ readyApps: [], appsLoading: true }).title).toBe('Build your first agent')
    expect(step('build-agent').view({ readyApps: [], appsLoading: false })).toMatchObject({ title: 'Set up an AI app first', target: ['[data-tour="app-setup"]', '[data-tour="apps"]'] })
  })

  it('says what is on screen: a builder or the list, a dialog or its button', () => {
    expect(step('agent').view(ready).title).toBe('Start a new agent')
    document.body.innerHTML = '<div data-tour="agent-blocks"></div>'
    expect(step('agent').view(ready)).toMatchObject({ title: 'Give it a name and a job', advance: 'next' })

    expect(step('new-team').view(ready).title).toBe('Put it in a team')
    document.body.innerHTML = '<div data-tour="new-team-dialog"></div>'
    expect(step('new-team').view(ready)).toMatchObject({ title: 'Start it empty', keepClear: true })
  })

  it('waits for an agent to join the team, then shows it in Workflow', () => {
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="0" data-tour-view="agents"><section data-tour="agent-picker"></section></div>'
    expect(step('team-agents').done?.({ runAtStepStart: null })).toBe(false)
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="1" data-tour-view="agents"></div>'
    expect(step('team-agents').done?.({ runAtStepStart: null })).toBe(true)
    expect(step('workflow').view(ready)).toMatchObject({ title: 'Open Workflow', advance: 'action' })
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="1" data-tour-view="workflow"></div>'
    expect(step('workflow').view(ready)).toMatchObject({ title: 'Connect them in Workflow', advance: 'next' })
  })

  it('points only at data-tour names, never at styling', () => {
    for (const candidate of TOUR_STEPS) {
      for (const selector of candidate.view(ready).target ?? []) expect(selector).toMatch(/^\[data-tour="[a-z-]+"\]/)
    }
  })
})

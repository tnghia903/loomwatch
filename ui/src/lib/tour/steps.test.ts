import { afterEach, describe, expect, it } from 'vitest'

import { TOUR_STEPS, type TourStep } from './steps'

const step = (id: TourStep['id']) => TOUR_STEPS.find((candidate) => candidate.id === id)!
const ready = { keyReady: true, keyLoading: false }

afterEach(() => { document.body.innerHTML = '' })

describe('getting-started guide steps', () => {
  it('follows the work: build an agent in My agents, then a team, then its chat', () => {
    const screens = TOUR_STEPS.map((candidate) => candidate.screen).filter((screen, at, all) => screen !== all[at - 1])
    expect(screens).toEqual(['any', 'home', 'agents', 'home', 'workspace', 'any'])
    const order = (id: TourStep['id']) => TOUR_STEPS.indexOf(step(id))
    expect(order('build-agent')).toBeLessThan(order('try'))
    expect(order('try')).toBeLessThan(order('save'))
    expect(order('save')).toBeLessThan(order('new-team'))
    expect(order('team-agents')).toBeLessThan(order('workflow'))
    expect(order('workflow')).toBeLessThan(order('ask'))
  })

  it('asks how models are paid before the first agent', () => {
    expect(step('build-agent').view(ready)).toMatchObject({ title: 'Build your first agent', target: ['[data-tour="build-agent"]'] })
    expect(step('build-agent').view({ keyReady: false, keyLoading: true }).title).toBe('Build your first agent')
    expect(step('build-agent').view({ keyReady: false, keyLoading: false })).toMatchObject({ title: 'Choose how your models are paid first', target: ['[data-tour="key"]'] })
  })

  it('says what is on screen: a builder or the list, a dialog or its button', () => {
    expect(step('agent').view(ready).title).toBe('Start a new agent')
    document.body.innerHTML = '<section data-tour="agent-start"></section>'
    expect(step('agent').view(ready)).toMatchObject({ title: 'Start from a job', target: ['[data-tour="agent-start"]'] })
    document.body.innerHTML = '<div data-tour="agent-blocks"></div>'
    expect(step('agent').view(ready)).toMatchObject({ title: 'Give it a name and a job', advance: 'next' })

    // Every team works in a project (ADR 0097): before any, Set up project; then a project; in its room, New team.
    document.body.innerHTML = ''
    expect(step('new-team').view(ready)).toMatchObject({ title: 'Set up your first project', target: ['[data-tour="set-up-project"]'] })
    expect(step('new-team').view({ keyReady: false, keyLoading: false })).toMatchObject({ title: 'Choose how your models are paid first', target: ['[data-tour="key"]'] })
    document.body.innerHTML = '<aside data-tour="ask"></aside>'
    expect(step('new-team').view(ready).title).toBe('Ask LoomWatch is on it')
    document.body.innerHTML = '<aside data-tour="ask"><article data-tour="ask-proposal"></article></aside>'
    expect(step('new-team').view(ready)).toMatchObject({ title: 'See the proposed team', target: ['[data-tour="ask-proposal"]'] })
    // With projects too, Ask at work comes first, and New project's own form before the rooms behind it.
    document.body.innerHTML = '<section data-tour="projects"></section><aside data-tour="ask"></aside>'
    expect(step('new-team').view(ready)).toMatchObject({ title: 'Ask LoomWatch is on it', waiting: 'Waiting for Ask LoomWatch' })
    document.body.innerHTML = '<section data-tour="projects"></section><form data-tour="set-up-project"></form>'
    expect(step('new-team').view(ready)).toMatchObject({ title: 'Set up a project', target: ['[data-tour="set-up-project"]'] })
    document.body.innerHTML = '<section data-tour="projects"></section>'
    expect(step('new-team').view(ready)).toMatchObject({ title: 'Open a project', target: ['[data-tour="projects"]'] })
    document.body.innerHTML = '<div data-tour="room"><button data-tour="new-team"></button></div>'
    expect(step('new-team').view(ready)).toMatchObject({ title: 'Put it in a team', target: ['[data-tour="new-team"]'] })
    document.body.innerHTML = '<div data-tour="room"></div><div data-tour="new-team-dialog"></div>'
    expect(step('new-team').view(ready)).toMatchObject({ title: 'Start it with your agent', keepClear: true })
  })

  it('waits for an agent to join the team, then shows it on the Team tab', () => {
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="0" data-tour-view="agents"><section data-tour="agent-picker"></section></div>'
    expect(step('team-agents').done?.({ runAtStepStart: null })).toBe(false)
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="1" data-tour-view="agents"></div>'
    expect(step('team-agents').done?.({ runAtStepStart: null })).toBe(true)
    // With no Agents tab, an empty team on its Team tab is pointed at My agents in the add panel.
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="0" data-tour-view="workflow"><aside data-tour="palette"></aside></div>'
    expect(step('team-agents').view(ready)).toMatchObject({ title: 'Add your agent', target: ['[data-tour="palette"]'] })
    // Ask's team on the canvas has agents but isn't saved: it is applied first.
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="1" data-tour-view="workflow" data-tour-proposal="showing"></div>'
    expect(step('team-agents').done?.({ runAtStepStart: null })).toBe(false)
    expect(step('team-agents').view(ready)).toMatchObject({ title: 'Keep the team', target: ['[data-tour="apply-proposal"]'] })
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="1" data-tour-view="agents"></div>'
    expect(step('workflow').view(ready)).toMatchObject({ title: 'Open the Team tab', advance: 'action' })
    document.body.innerHTML = '<div data-tour="workspace" data-tour-agents="1" data-tour-view="workflow"></div>'
    expect(step('workflow').view(ready)).toMatchObject({ title: 'Connect them on the Team tab', advance: 'next' })
  })

  it('points only at data-tour names, never at styling', () => {
    for (const candidate of TOUR_STEPS) {
      for (const selector of candidate.view(ready).target ?? []) expect(selector).toMatch(/^\[data-tour="[a-z-]+"\]/)
    }
  })
})

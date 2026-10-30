import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EXAMPLE_REQUEST } from '../../lib/tour/steps'
import { goToStep, readTourState, resetTourForTests, startTour } from '../../lib/tour/store'
import { GettingStarted } from './GettingStarted'

// The page the guide reads: a stand-in for Home or the workspace, outside what React renders.
let page: HTMLDivElement

function showPage(html: string) {
  page.innerHTML = html
}

/** Let the guide read the page: its first read, or `ms` worth of its polling. */
function tick(ms = 0) {
  act(() => { vi.advanceTimersByTime(ms) })
}

function renderGuide() {
  render(<GettingStarted keyReady keyLoading={false} />)
  tick()
}

beforeEach(() => {
  vi.useFakeTimers()
  resetTourForTests()
  window.history.replaceState({}, '', '/')
  page = document.createElement('div')
  document.body.appendChild(page)
  // jsdom has no layout: anything the guide may point at gets a box, everything else none.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = this.hasAttribute('data-tour') ? { x: 100, y: 100, width: 200, height: 40 } : { x: 0, y: 0, width: 0, height: 0 }
    return { ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  page.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Home as the studio draws it (ADR 0097): with projects, or before any, asking what you work on. */
const HOME = '<div data-tour="home"><span data-tour="apps">Ready</span><a data-tour="build-agent">Build an agent</a><section data-tour="projects"></section></div>'
const EMPTY_HOME = '<div data-tour="home"><div data-tour="key"></div><form data-tour="set-up-project"></form><a data-tour="build-agent">Build an agent</a></div>'
/** A project's room, where its teams are started. */
const ROOM = '<div data-tour="room"><button data-tour="new-team">New team</button></div>'
/** Your agents: the builder for one agent, with its chat open or not, or the list with its New agent button. */
const builder = (saved = false, chat = '') => `<div data-tour="agents"><a data-tour="dock-home">Home</a><div data-tour="agent-builder"${saved ? ' data-tour-saved="true"' : ''}><button data-tour="save-agent">Save to My agents</button><nav><button data-tour="agent-tab-build"></button><button data-tour="agent-tab-chat"></button></nav><div data-tour="agent-blocks"></div>${chat}</div></div>`
/** Its chat, before and after it answers. */
const CHAT = '<section data-tour="chat"><form data-tour="composer"></form></section>'
const ANSWERED = '<section data-tour="chat"><div data-tour="output"></div><form data-tour="composer"></form></section>'
const AGENTS_LIST = '<div data-tour="agents"><a data-tour="dock-home">Home</a><button data-tour="new-agent">New agent</button></div>'
const workspace = (inner: string, agents = 1, view = 'workflow', proposal = false) => `<div data-tour="workspace" data-tour-agents="${agents}" data-tour-view="${view}"${proposal ? ' data-tour-proposal="showing"' : ''}><nav data-tour="view-tabs"><button data-tour="tab-agents"></button><button data-tour="tab-workflow"></button><button data-tour="tab-chat"></button></nav>${inner}</div>`

describe('GettingStarted', () => {
  it('shows nothing until the guide is started', () => {
    showPage(HOME)
    renderGuide()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('welcomes a first-time user, then starts with building an agent', () => {
    showPage(HOME)
    startTour()
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Welcome to LoomWatch' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start the guide' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Start the guide' }))
    tick()
    expect(screen.getByRole('heading', { name: 'Build your first agent' })).toBeInTheDocument()
    expect(screen.getByText(/the AI model you choose for it/)).toBeInTheDocument()
    expect(screen.getByText('Getting started · Step 1 of 11')).toBeInTheDocument()
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
  })

  it('carries on in My agents once the builder opens', () => {
    showPage(builder())
    goToStep('build-agent')
    renderGuide()
    expect(readTourState()?.step).toBe('agent')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Give it a name and a job' })).toBeInTheDocument()
    // The step before it was on Home: there is nothing on this page to go back to.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    tick()
    expect(screen.getByRole('heading', { name: 'Chat with it on its own' })).toBeInTheDocument()
  })

  it('asks for a new agent on the list of My agents', () => {
    showPage(AGENTS_LIST)
    goToStep('agent')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Start a new agent' })).toBeInTheDocument()
    showPage(builder())
    tick(250)
    expect(screen.getByRole('heading', { name: 'Give it a name and a job' })).toBeInTheDocument()
  })

  it('opens its chat, waits for its answer, then points at it until the operator moves on', () => {
    showPage(builder())
    goToStep('try')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Chat with it on its own' })).toBeInTheDocument()
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()

    showPage(builder(false, CHAT))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Ask it for something' })).toBeInTheDocument()
    expect(readTourState()?.step).toBe('try')

    showPage(builder(false, ANSWERED))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Read its answer' })).toBeInTheDocument()
    expect(readTourState()?.step).toBe('try')
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    tick()
    expect(screen.getByRole('heading', { name: 'Save it to My agents' })).toBeInTheDocument()
  })

  it('brings each card’s target into view, a tall one by its top', () => {
    // jsdom has no scrolling: the Chat tab sits below the fold, and the answer is taller than the screen.
    const scrolled = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrolled, configurable: true })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const tour = this.getAttribute('data-tour')
      const box = tour === 'agent-tab-chat' ? { x: 100, y: 1200, width: 100, height: 32 }
        : tour === 'output' ? { x: 100, y: 1300, width: 400, height: 2000 }
        : tour ? { x: 100, y: 100, width: 200, height: 40 } : { x: 0, y: 0, width: 0, height: 0 }
      return { ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box } as DOMRect
    })
    try {
      showPage(builder())
      goToStep('try')
      renderGuide()
      tick(1000)
      // Once for the card, however long it stays: after that, scrolling is the operator's.
      expect(scrolled).toHaveBeenCalledTimes(1)
      expect(scrolled).toHaveBeenLastCalledWith(expect.objectContaining({ block: 'center' }))

      showPage(builder(false, ANSWERED))
      tick(1000)
      expect(scrolled).toHaveBeenCalledTimes(2)
      expect(scrolled).toHaveBeenLastCalledWith(expect.objectContaining({ block: 'start' }))
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('once the agent is saved, points the way to My team and carries on at Home', () => {
    showPage(builder())
    goToStep('save')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Save it to My agents' })).toBeInTheDocument()

    showPage(builder(true))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Now put it in a team' })).toBeInTheDocument()

    showPage(HOME)
    tick(250)
    expect(readTourState()?.step).toBe('new-team')
    tick(250)
    // Every team works in a project: Home points at the projects, and a room at its New team.
    expect(screen.getByRole('heading', { name: 'Open a project' })).toBeInTheDocument()
    showPage(ROOM)
    tick(250)
    expect(screen.getByRole('heading', { name: 'Put it in a team' })).toBeInTheDocument()
    expect(readTourState()?.step).toBe('new-team')
  })

  it('with no project yet, asks for one through Set up project and follows Ask to the team it proposes', () => {
    showPage(EMPTY_HOME)
    goToStep('new-team')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Set up your first project' })).toBeInTheDocument()
    expect(screen.getByText(/press Set up project/)).toBeInTheDocument()

    showPage(EMPTY_HOME + '<aside data-tour="ask"></aside>')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Ask LoomWatch is on it' })).toBeInTheDocument()
    // Nothing for the operator to do here: the card says who it waits for.
    expect(screen.getByText('Waiting for Ask LoomWatch')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for you')).not.toBeInTheDocument()

    showPage(EMPTY_HOME + '<aside data-tour="ask"><article data-tour="ask-proposal"></article></aside>')
    tick(250)
    expect(screen.getByRole('heading', { name: 'See the proposed team' })).toBeInTheDocument()
    expect(readTourState()?.step).toBe('new-team')
  })

  it('asks for a way to pay for models before Set up project, which asks Ask LoomWatch', () => {
    showPage(EMPTY_HOME)
    goToStep('new-team')
    render(<GettingStarted keyReady={false} keyLoading={false} />)
    tick()
    expect(screen.getByRole('heading', { name: 'Choose how your models are paid first' })).toBeInTheDocument()
    expect(screen.getByText(/needs an AI model for Ask LoomWatch/)).toBeInTheDocument()
  })

  it('keeps Ask’s team on its canvas before the team steps go on', () => {
    showPage(workspace('<header><button data-tour="apply-proposal">Apply</button></header>', 2, 'workflow', true))
    goToStep('new-team')
    renderGuide()
    expect(readTourState()?.step).toBe('team-agents')
    tick(250)
    // Its agents are on the canvas, but nothing is saved: the guide waits for Apply.
    expect(screen.getByRole('heading', { name: 'Keep the team' })).toBeInTheDocument()
    tick(1000)
    expect(readTourState()?.step).toBe('team-agents')

    showPage(workspace('<div class="react-flow__node-agent" data-tour="card"></div>', 2, 'workflow'))
    tick(250)
    expect(readTourState()?.step).toBe('workflow')
  })

  it('follows the operator into the New team dialog and back out of it', () => {
    showPage(ROOM)
    goToStep('new-team')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Put it in a team' })).toBeInTheDocument()
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Next/ })).not.toBeInTheDocument()

    showPage(ROOM + '<div data-tour="new-team-dialog"></div>')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Start it with your agent' })).toBeInTheDocument()

    showPage(ROOM)
    tick(250)
    expect(screen.getByRole('heading', { name: 'Put it in a team' })).toBeInTheDocument()
  })

  it('carries on inside the team once one opens, on its Agents', () => {
    showPage(workspace('<section data-tour="agent-picker"></section>', 0, 'agents'))
    goToStep('new-team')
    renderGuide()
    expect(readTourState()?.step).toBe('team-agents')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Add your agent' })).toBeInTheDocument()
  })

  it('moves on once the agent is in the team, and explains its card on the Team tab', () => {
    showPage(workspace('<section data-tour="agent-picker"></section>', 0, 'agents'))
    goToStep('team-agents')
    renderGuide()
    showPage(workspace('', 1, 'agents'))
    tick(250)
    expect(readTourState()?.step).toBe('workflow')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Back to the team' })).toBeInTheDocument()

    showPage(workspace('<div class="react-flow__node-agent" data-tour="card"></div>', 1, 'workflow'))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Connect them on the Team tab' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    tick()
    expect(screen.getByRole('heading', { name: 'Open the team’s chat' })).toBeInTheDocument()
    // Workflow keeps a request box in the page, out of sight: only the chat opening counts.
    showPage(workspace('<div data-tour="run-team"></div><div data-tour="composer" hidden></div>', 1, 'workflow'))
    tick(500)
    expect(screen.getByRole('heading', { name: 'Open the team’s chat' })).toBeInTheDocument()
    showPage(workspace('<div data-tour="composer"></div>', 1, 'chat'))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Ask in plain words' })).toBeInTheDocument()
  })

  it('waits on Home for the operator to open a team again', () => {
    showPage(HOME)
    goToStep('watch')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Open a team to carry on' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    tick()
    expect(screen.getByRole('heading', { name: 'Open a project' })).toBeInTheDocument()
  })

  it('waits in My agents for the operator to go back Home', () => {
    showPage(builder(true))
    goToStep('new-team')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Go Home to carry on' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
  })

  it('skips New team without landing on the dialog it would have opened', () => {
    showPage(HOME)
    goToStep('new-team')
    renderGuide()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }))
    tick(2000)
    expect(readTourState()?.step).toBe('team-agents')
    expect(screen.getByRole('heading', { name: 'Open a team to carry on' })).toBeInTheDocument()
  })

  it('skips Run team in Workflow past the chat steps it cannot show', () => {
    showPage(workspace('<div data-tour="run-team"></div><div data-tour="needs-you"></div>'))
    goToStep('run-team')
    renderGuide()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }))
    tick(2000)
    expect(readTourState()?.step).toBe('done')
    expect(screen.getByRole('heading', { name: 'You’re all set' })).toBeInTheDocument()
  })

  it('skips one step only when the next one is on screen', () => {
    window.history.replaceState({}, '', '/?path=a.yaml')
    showPage(workspace('<div data-tour="composer"></div><div data-tour="stages"></div>', 1, 'chat'))
    goToStep('ask')
    renderGuide()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }))
    tick(2000)
    expect(screen.getByRole('heading', { name: 'Watch it work' })).toBeInTheDocument()
  })

  it('counts only a run started during the ask step, not one already on screen', () => {
    window.history.replaceState({}, '', '/?path=a.yaml&run=earlier')
    showPage(workspace('<div data-tour="composer"></div><div data-tour="stages"></div>', 1, 'chat'))
    goToStep('ask')
    renderGuide()
    tick(500)
    expect(screen.getByRole('heading', { name: 'Ask in plain words' })).toBeInTheDocument()

    window.history.replaceState({}, '', '/?path=a.yaml&run=new-run')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Watch it work' })).toBeInTheDocument()
  })

  it('offers an example request without sending it', () => {
    showPage(workspace('<div data-tour="composer"></div>', 1, 'chat'))
    goToStep('ask')
    renderGuide()
    const composed = vi.fn()
    window.addEventListener('loomwatch:compose', (event) => composed((event as CustomEvent).detail), { once: true })
    fireEvent.click(screen.getByRole('button', { name: /Use this example/ }))
    expect(composed).toHaveBeenCalledWith(EXAMPLE_REQUEST)
    expect(screen.getByRole('heading', { name: 'Ask in plain words' })).toBeInTheDocument()
  })

  it('goes back only to a card that explains, never to an action already done', () => {
    showPage(workspace('<div data-tour="stages"></div><aside data-tour="output"></aside>', 1, 'chat'))
    goToStep('review')
    renderGuide()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    tick()
    expect(screen.getByRole('heading', { name: 'Watch it work' })).toBeInTheDocument()
    // Before "Watch it work" comes "Ask in plain words", which would want another run.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
  })

  it('remembers a closed guide, and a finished one', () => {
    showPage(HOME)
    goToStep('build-agent')
    renderGuide()
    fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(readTourState()?.status).toBe('dismissed')

    act(() => goToStep('done'))
    tick()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(readTourState()?.status).toBe('finished')
  })
})

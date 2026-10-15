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
  render(<GettingStarted readyApps={['Claude', 'Codex']} appsLoading={false} />)
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

const HOME = '<div data-tour="home"><span data-tour="apps">Ready</span><a data-tour="build-agent">Build an agent</a><button data-tour="new-team">New team</button></div>'
/** Your agents: the builder for one agent, or the list with its New agent button. */
const builder = (saved = false) => `<div data-tour="agents"><a data-tour="your-teams">Your teams</a><div data-tour="agent-builder"${saved ? ' data-tour-saved="true"' : ''}><button data-tour="save-agent">Save to Your agents</button><div data-tour="agent-blocks"></div><section data-tour="bench"></section></div></div>`
const AGENTS_LIST = '<div data-tour="agents"><a data-tour="your-teams">Your teams</a><button data-tour="new-agent">New agent</button></div>'
const workspace = (inner: string, agents = 1, view = 'workflow') => `<div data-tour="workspace" data-tour-agents="${agents}" data-tour-view="${view}"><nav data-tour="view-tabs"><button data-tour="tab-agents"></button><button data-tour="tab-workflow"></button><button data-tour="tab-chat"></button></nav>${inner}</div>`

describe('GettingStarted', () => {
  it('shows nothing until the guide is started', () => {
    showPage(HOME)
    renderGuide()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('welcomes a first-time user, then starts with building an agent in the apps it found', () => {
    showPage(HOME)
    startTour()
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Welcome to LoomWatch' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start the guide' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Start the guide' }))
    tick()
    expect(screen.getByRole('heading', { name: 'Build your first agent' })).toBeInTheDocument()
    expect(screen.getByText(/found Claude and Codex/)).toBeInTheDocument()
    expect(screen.getByText('Getting started · Step 1 of 11')).toBeInTheDocument()
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
  })

  it('carries on in Your agents once the builder opens', () => {
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
    expect(screen.getByRole('heading', { name: 'Try it on its own' })).toBeInTheDocument()
  })

  it('asks for a new agent on the list of Your agents', () => {
    showPage(AGENTS_LIST)
    goToStep('agent')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Start a new agent' })).toBeInTheDocument()
    showPage(builder())
    tick(250)
    expect(screen.getByRole('heading', { name: 'Give it a name and a job' })).toBeInTheDocument()
  })

  it('waits for a try to finish, then points at its answer until the operator moves on', () => {
    showPage(builder())
    goToStep('try')
    renderGuide()
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()

    showPage(builder().replace('<section data-tour="bench"></section>', '<section data-tour="bench"><div data-tour="bench-result"></div></section>'))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Try it on its own' })).toBeInTheDocument()

    showPage(builder().replace('<section data-tour="bench"></section>', '<section data-tour="bench"><div data-tour="bench-result" data-tour-done="true"></div></section>'))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Read its answer' })).toBeInTheDocument()
    expect(readTourState()?.step).toBe('try')
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    tick()
    expect(screen.getByRole('heading', { name: 'Save it to Your agents' })).toBeInTheDocument()
  })

  it('brings each card’s target into view, a tall one by its top', () => {
    // jsdom has no scrolling: the bench sits below the fold, and its answer is taller than the screen.
    const scrolled = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrolled, configurable: true })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const tour = this.getAttribute('data-tour')
      const box = tour === 'bench' ? { x: 100, y: 1200, width: 400, height: 300 }
        : tour === 'bench-result' ? { x: 100, y: 1300, width: 400, height: 2000 }
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

      showPage(builder().replace('<section data-tour="bench"></section>', '<section data-tour="bench"><div data-tour="bench-result" data-tour-done="true"></div></section>'))
      tick(1000)
      expect(scrolled).toHaveBeenCalledTimes(2)
      expect(scrolled).toHaveBeenLastCalledWith(expect.objectContaining({ block: 'start' }))
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('once the agent is saved, points the way to Your teams and carries on at Home', () => {
    showPage(builder())
    goToStep('save')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Save it to Your agents' })).toBeInTheDocument()

    showPage(builder(true))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Now put it in a team' })).toBeInTheDocument()

    showPage(HOME)
    tick(250)
    expect(readTourState()?.step).toBe('new-team')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Put it in a team' })).toBeInTheDocument()
  })

  it('follows the operator into the New team dialog and back out of it', () => {
    showPage(HOME)
    goToStep('new-team')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Put it in a team' })).toBeInTheDocument()
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Next/ })).not.toBeInTheDocument()

    showPage(HOME + '<div data-tour="new-team-dialog"></div>')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Start it empty' })).toBeInTheDocument()

    showPage(HOME)
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

  it('moves on once the agent is in the team, and explains its card in Workflow', () => {
    showPage(workspace('<section data-tour="agent-picker"></section>', 0, 'agents'))
    goToStep('team-agents')
    renderGuide()
    showPage(workspace('', 1, 'agents'))
    tick(250)
    expect(readTourState()?.step).toBe('workflow')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Open Workflow' })).toBeInTheDocument()

    showPage(workspace('<div class="react-flow__node-agent" data-tour="card"></div>', 1, 'workflow'))
    tick(250)
    expect(screen.getByRole('heading', { name: 'Connect them in Workflow' })).toBeInTheDocument()
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
    expect(screen.getByRole('heading', { name: 'Put it in a team' })).toBeInTheDocument()
  })

  it('waits in Your agents for the operator to go back to Your teams', () => {
    showPage(builder(true))
    goToStep('new-team')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Go to Your teams to carry on' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Your teams' })).toHaveAttribute('href', '/')
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

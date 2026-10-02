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

const HOME = '<div data-tour="home"><span data-tour="apps">Ready</span><button data-tour="new-team">New team</button></div>'
const workspace = (inner: string, agents = 1) => `<div data-tour="workspace" data-tour-agents="${agents}"><nav data-tour="view-tabs"></nav>${inner}</div>`

describe('GettingStarted', () => {
  it('shows nothing until the guide is started', () => {
    showPage(HOME)
    renderGuide()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('welcomes a first-time user, then names the AI apps it found', () => {
    showPage(HOME)
    startTour()
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Welcome to LoomWatch' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start the guide' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Start the guide' }))
    tick()
    expect(screen.getByRole('heading', { name: 'Your AI apps' })).toBeInTheDocument()
    expect(screen.getByText(/found Claude and Codex/)).toBeInTheDocument()
    expect(screen.getByText('Getting started · Step 1 of 10')).toBeInTheDocument()
  })

  it('waits for the operator to act, and moves on when they do', () => {
    showPage(HOME)
    goToStep('new-team')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Create your first team' })).toBeInTheDocument()
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Next/ })).not.toBeInTheDocument()

    showPage(HOME + '<div data-tour="new-team-dialog"></div>')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Name it and pick a start' })).toBeInTheDocument()
  })

  it('goes back a step when the dialog it explains is closed', () => {
    showPage(HOME + '<div data-tour="new-team-dialog"></div>')
    goToStep('create')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Name it and pick a start' })).toBeInTheDocument()

    showPage(HOME)
    tick(250)
    // A dialog mid-repaint is not a closed one.
    expect(screen.getByRole('heading', { name: 'Name it and pick a start' })).toBeInTheDocument()
    tick(1000)
    expect(screen.getByRole('heading', { name: 'Create your first team' })).toBeInTheDocument()
  })

  it('carries on inside the team once one opens', () => {
    showPage(workspace('<article data-tour="stage"></article>'))
    goToStep('create')
    renderGuide()
    expect(readTourState()?.step).toBe('team')
    tick(250)
    expect(screen.getByRole('heading', { name: 'This is your team' })).toBeInTheDocument()
  })

  it('asks for a first agent when the team is empty', () => {
    showPage(workspace('<aside data-tour="palette"></aside>', 0))
    goToStep('team')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Add your first agent' })).toBeInTheDocument()
  })

  it('waits on Home for the operator to open a team again', () => {
    showPage(HOME)
    goToStep('watch')
    renderGuide()
    expect(screen.getByRole('heading', { name: 'Pick up where you left off' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    tick()
    expect(screen.getByRole('heading', { name: 'Create your first team' })).toBeInTheDocument()
  })

  it('counts only a run started during the ask step, not one already on screen', () => {
    window.history.replaceState({}, '', '/?path=a.yaml&run=earlier')
    showPage(workspace('<div data-tour="composer"></div><div data-tour="stages"></div>'))
    goToStep('ask')
    renderGuide()
    tick(500)
    expect(screen.getByRole('heading', { name: 'Ask in plain words' })).toBeInTheDocument()

    window.history.replaceState({}, '', '/?path=a.yaml&run=new-run')
    tick(250)
    expect(screen.getByRole('heading', { name: 'Watch it work' })).toBeInTheDocument()
  })

  it('offers an example request without sending it', () => {
    showPage(workspace('<div data-tour="composer"></div>'))
    goToStep('ask')
    renderGuide()
    const composed = vi.fn()
    window.addEventListener('loomwatch:compose', (event) => composed((event as CustomEvent).detail), { once: true })
    fireEvent.click(screen.getByRole('button', { name: /Use this example/ }))
    expect(composed).toHaveBeenCalledWith(EXAMPLE_REQUEST)
    expect(screen.getByRole('heading', { name: 'Ask in plain words' })).toBeInTheDocument()
  })

  it('goes back only to a card that explains, never to an action already done', () => {
    showPage(workspace('<div data-tour="stages"></div><aside data-tour="output"></aside>'))
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
    goToStep('apps')
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

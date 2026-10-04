import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { Composer, type ComposerState } from './Composer'
import { liftInto, noteShownRequest } from '../../lib/motion/lift'

afterEach(cleanup)

// The §1 contracts the gate can only see structurally: `verify-composer-conformance.mjs` greps
// source, so it can tell that the height effect depends on focus but not that focusing and
// blurring actually move the height. §10.6 found C2 had no behavioural cover at all.
function renderComposer(state: ComposerState = { kind: 'ready' }, value = 'one\ntwo\nthree\nfour\nfive\nsix') {
  return render(
    <Composer
      mode="pipeline" stepCount={2} state={state} value={value} onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()}
      onRetry={vi.fn()} onNewRun={vi.fn()}
    />,
  )
}

// The mode chip says how the team runs and explains itself on hover. It opens nothing: the popover
// it once opened was retired (CANVAS_SPEC §8.1), so it must not look or announce like a button.
it('labels the execution mode in plain words without offering a popover', () => {
  const { unmount } = renderComposer()
  const chip = screen.getByText('2 steps in order').closest('.mode-chip')
  expect(chip?.tagName).toBe('SPAN')
  expect(chip).not.toHaveAttribute('aria-haspopup')
  expect(chip).toHaveAttribute('title', expect.stringMatching(/^Your agents work one after another/))
  unmount()

  render(
    <Composer
      mode="team" stepCount={3} state={{ kind: 'ready' }} value="" onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()}
      onRetry={vi.fn()} onNewRun={vi.fn()}
    />,
  )
  expect(screen.getByText('Lead agent delegates').closest('.mode-chip')).toHaveAttribute('title', 'Your lead agent gets the request and decides who else to bring in.')
  expect(screen.queryByRole('button', { name: /in order|delegates/ })).not.toBeInTheDocument()
})

// Field report (2026-10-04): a one-agent team's follow-up box said "Lead agent delegates", with no
// one to delegate to.
it('says nothing about order or delegation for a one-agent team', () => {
  render(
    <Composer
      mode="team" stepCount={1} state={{ kind: 'terminal', phase: 'succeeded' }} value="" onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()}
      onRetry={vi.fn()} onNewRun={vi.fn()} onFollowUp={vi.fn()} followUpStages={[]}
    />,
  )
  expect(screen.queryByText('Lead agent delegates')).not.toBeInTheDocument()
  expect(document.querySelector('.mode-summary')).toBeNull()
  // The follow-up itself is all still there.
  expect(screen.getByRole('button', { name: /Follow up/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
})

// ADR 0043: Memory and Run history open from the workspace menu on every screen, so the composer
// carries neither: a second button for each made two controls do one thing.
it('offers no Memory chip and no Run history button of its own', () => {
  renderComposer()
  expect(screen.queryByRole('button', { name: /Memory/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Run history' })).not.toBeInTheDocument()
})

// §1.2: "`Esc` — blur and collapse to one line, text preserved."
it('collapses to one line when Esc blurs it, and keeps the typed goal (§1.2)', () => {
  renderComposer()
  const field = screen.getByLabelText('What should the team do?') as HTMLTextAreaElement
  act(() => field.focus())
  expect(field.style.height).not.toBe('')
  fireEvent.keyDown(field, { key: 'Escape' })
  expect(document.activeElement).not.toBe(field)
  expect(field.style.height).toBe('')
  expect(field).toHaveValue('one\ntwo\nthree\nfour\nfive\nsix')
})

// §1.6: "The button shows `Starting…`, disabled." §1.4 keeps the save step legible as its own
// step, so the start step must never claim a write is happening.
it('labels the start step Starting…, and the save step Saving… (§1.4/§1.6)', () => {
  const { unmount } = renderComposer({ kind: 'starting' })
  expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  expect(screen.queryByText(/^Saving /)).not.toBeInTheDocument()
  unmount()
  renderComposer({ kind: 'saving', filename: 'research-team.yaml' })
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  expect(screen.getByText(/Saving research-team\.yaml/)).toBeInTheDocument()
})

// Canvas B: "When the Output arrives the composer does not go dark. It offers Follow up."
//
// The chooser lists the pipeline's stages **in order**, and ⌘↵ sends the follow-up rather than the
// "New run" it would otherwise send. Retry stays what it is — "same prompt, from zero" — and keeps
// its own button, because a follow-up and a retry cost different things.
it('offers Follow up with the stages in pipeline order, and ⌘↵ sends it', () => {
  const onFollowUp = vi.fn()
  const onNewRun = vi.fn()
  const onFollowUpTargetChange = vi.fn()
  render(
    <Composer
      mode="pipeline" stepCount={3} state={{ kind: 'terminal', phase: 'succeeded' }} value="Shorter." onChange={vi.fn()}
      onSubmit={vi.fn()} onStop={vi.fn()} onRetry={vi.fn()} onNewRun={onNewRun}
     
      followUpStages={[
        { id: 'researcher', name: 'Protocol Researcher' },
        { id: 'reviewer', name: 'Code Reviewer' },
        { id: 'writer', name: 'Technical Writer' },
      ]}
      followUpTarget={null} onFollowUpTargetChange={onFollowUpTargetChange} onFollowUp={onFollowUp}
    />,
  )
  const chooser = screen.getByLabelText('Follow up target') as HTMLSelectElement
  expect([...chooser.options].map((option) => option.textContent)).toEqual([
    'the beginning',
    'Protocol Researcher',
    'Code Reviewer',
    'Technical Writer',
  ])
  expect(screen.getByText(/Runs every step again, building on this answer/)).toBeInTheDocument()

  fireEvent.change(chooser, { target: { value: 'writer' } })
  expect(onFollowUpTargetChange).toHaveBeenCalledWith('writer')

  // ⌘↵ is the follow-up, not a new run: the button says so and the shortcut must agree with it.
  fireEvent.keyDown(screen.getByLabelText('What should the team do?'), { key: 'Enter', metaKey: true })
  expect(onFollowUp).toHaveBeenCalledOnce()
  expect(onNewRun).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /Follow up/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute(
    'title',
    'Run the original request again from scratch',
  )
})

// The note under the composer explains the chosen target in one line, because "from Writer" and
// "whole pipeline" cost different amounts and the operator is choosing between them.
it('names the chosen follow-up target in the note, and offers only the whole pipeline in team mode', () => {
  const { unmount } = render(
    <Composer
      mode="pipeline" stepCount={3} state={{ kind: 'terminal', phase: 'succeeded' }} value="Shorter." onChange={vi.fn()}
      onSubmit={vi.fn()} onStop={vi.fn()} onRetry={vi.fn()} onNewRun={vi.fn()}
     
      followUpStages={[{ id: 'writer', name: 'Technical Writer' }]}
      followUpTarget="writer" onFollowUpTargetChange={vi.fn()} onFollowUp={vi.fn()}
    />,
  )
  expect(screen.getByText(/Starts again at Technical Writer, reusing what the earlier steps handed over/)).toBeInTheDocument()
  expect(screen.queryByText(/Runs every step again/)).not.toBeInTheDocument()
  unmount()

  // Team mode has no configured order, so there is no stage to start at and the chooser says so.
  render(
    <Composer
      mode="team" stepCount={3} state={{ kind: 'terminal', phase: 'succeeded' }} value="Shorter." onChange={vi.fn()}
      onSubmit={vi.fn()} onStop={vi.fn()} onRetry={vi.fn()} onNewRun={vi.fn()}
     
      followUpStages={[]} followUpTarget={null} onFollowUpTargetChange={vi.fn()} onFollowUp={vi.fn()}
    />,
  )
  const chooser = screen.getByLabelText('Follow up target') as HTMLSelectElement
  expect([...chooser.options].map((option) => option.textContent)).toEqual(['the beginning'])
})

// A build with no follow-up wiring keeps today's terminal composer exactly: Retry plus New run.
it('keeps Retry and New run when no follow-up handler is supplied', () => {
  renderComposer({ kind: 'terminal', phase: 'succeeded' }, 'A new goal')
  expect(screen.getByRole('button', { name: 'New run' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Follow up/ })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Follow up target')).not.toBeInTheDocument()
})

it.each(['review_stop', 'question'] as const)('routes the %s answer and keyboard shortcut without launching a run', (kind) => {
  const onAnswer = vi.fn(), onSubmit = vi.fn()
  const waiting = { node: 'review', name: 'Review', kind, since: '2026-09-13T00:00:00Z', question: 'Approve?', park: 'kept_alive' as const, parkNote: 'kept alive', handoverFrom: 'researcher', sendBackAvailable: kind === 'review_stop' }
  const props = { mode: 'pipeline' as const, stepCount: 3, state: { kind: 'answering' as const, waiting, sending: false }, value: 'Proceed', onChange: vi.fn(), onSubmit, onStop: vi.fn(), onRetry: vi.fn(), onNewRun: vi.fn(), onAnswer }
  const { rerender } = render(<Composer {...props} />)
  expect(screen.getByRole('button', { name: kind === 'review_stop' ? /Continue/ : /^Reply/ })).toBeEnabled()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true })
  expect(onAnswer).toHaveBeenCalledWith()
  expect(onSubmit).not.toHaveBeenCalled()
  if (kind === 'review_stop') {
    fireEvent.click(screen.getByRole('button', { name: 'Send back to researcher' }))
    expect(onAnswer).toHaveBeenLastCalledWith('researcher')
  }
  rerender(<Composer {...props} state={{ ...props.state, sending: true }} />)
  const count = onAnswer.mock.calls.length
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true })
  expect(onAnswer).toHaveBeenCalledTimes(count)
})

it('names the save that a dirty follow-up must perform', () => {
  render(<Composer mode="pipeline" stepCount={2} state={{ kind: 'terminal', phase: 'succeeded' }} value="Shorter" onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()} onRetry={vi.fn()} onNewRun={vi.fn()} onFollowUp={vi.fn()} dirty />)
  expect(screen.getByRole('button', { name: /Save & follow up/ })).toBeEnabled()
})


it('lets the operator reply to a server-reported warm agent during a run', () => {
  const onReply = vi.fn(), onSubmit = vi.fn()
  const props = { mode: 'pipeline' as const, stepCount: 2, state: { kind: 'busy' as const, phase: 'running' as const }, value: 'Check the source', onChange: vi.fn(), onSubmit, onStop: vi.fn(), onRetry: vi.fn(), onNewRun: vi.fn(), replyAgents: [{ id: 'a', name: 'Researcher' }], onReply }
  const { rerender } = render(<Composer {...props} />)
  expect(screen.getByRole('textbox')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Reply to agent'), { target: { value: 'a' } })
  const input = screen.getByLabelText('Reply to Researcher')
  expect(input).toBeEnabled()
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  expect(onReply).toHaveBeenCalledWith('a')
  expect(onSubmit).not.toHaveBeenCalled()
  rerender(<Composer {...props} replySending />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true })
  expect(onReply).toHaveBeenCalledTimes(1)
  rerender(<Composer {...props} replyAgents={[]} />)
  expect(screen.getByRole('textbox')).toBeDisabled()
  expect(screen.queryByRole('button', { name: /^Reply/ })).not.toBeInTheDocument()
})

function keyProps(state: ComposerState, value: string) {
  const handlers = { onSubmit: vi.fn(), onRetry: vi.fn(), onNewRun: vi.fn(), onAnswer: vi.fn() }
  render(
    <Composer
      mode="pipeline" stepCount={2} state={state} value={value} onChange={vi.fn()} onStop={vi.fn()}
      {...handlers}
    />,
  )
  return handlers
}

// Every chat app an operator already uses sends on ↵; requiring ⌘↵ made the first run look broken.
it('sends on Enter, keeps Shift+Enter for a newline, and never sends mid-IME composition', () => {
  const { onSubmit } = keyProps({ kind: 'ready' }, 'Summarise the report')
  const box = screen.getByRole('textbox')
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
  expect(onSubmit).not.toHaveBeenCalled()
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(onSubmit).toHaveBeenCalledOnce()
})

// The run a send starts lifts the sent text out of this box (lib/motion/lift.ts), so ↵ has to leave
// where that text was before the composer clears.
it('leaves where the sent text was, for the run it starts to lift into place', () => {
  HTMLElement.prototype.animate = vi.fn(() => ({ finished: Promise.resolve() }) as unknown as Animation)
  try {
    noteShownRequest('An earlier request')
    keyProps({ kind: 'terminal', phase: 'succeeded' }, 'A different goal')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    const box = document.body.appendChild(document.createElement('p'))
    box.textContent = 'A different goal'
    expect(liftInto(box, 'A different goal')).toBe(true)
  } finally {
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate
    document.querySelectorAll('.lift-ghost').forEach((ghost) => ghost.remove())
  }
})

// A stray Enter in an empty box after a run must not silently re-run the whole team.
it('only retries a finished run on an explicit ⌘↵, never on a bare Enter', () => {
  const { onRetry } = keyProps({ kind: 'terminal', phase: 'succeeded' }, '')
  const box = screen.getByRole('textbox')
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(onRetry).not.toHaveBeenCalled()
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
  expect(onRetry).toHaveBeenCalledOnce()
})

// "Looks good" is the most common answer at a review stop; it must not require typing.
it('lets a review stop be approved without a comment, and names who work goes back to', () => {
  const waiting = { node: 'review', name: 'You', kind: 'review_stop' as const, since: '2026-10-01T00:00:00Z', question: 'Approve?', park: 'kept_alive' as const, parkNote: 'kept alive', handoverFrom: 'researcher', sendBackAvailable: true }
  const onAnswer = vi.fn()
  render(
    <Composer
      mode="pipeline" stepCount={3} state={{ kind: 'answering', waiting, sending: false }} value="" onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()}
      onRetry={vi.fn()} onNewRun={vi.fn()}
      onAnswer={onAnswer} agentNames={new Map([['researcher', 'Researcher']])}
    />,
  )
  expect(screen.getByRole('button', { name: 'Send back to Researcher' })).toBeDisabled()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(onAnswer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  expect(onAnswer).toHaveBeenCalledWith()
})

it('still requires words to answer an agent’s question', () => {
  const waiting = { node: 'writer', name: 'Writer', kind: 'question' as const, since: '2026-10-01T00:00:00Z', question: 'Which tone?', park: 'kept_alive' as const, parkNote: 'kept alive', sendBackAvailable: false }
  render(
    <Composer
      mode="pipeline" stepCount={3} state={{ kind: 'answering', waiting, sending: false }} value="" onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()}
      onRetry={vi.fn()} onNewRun={vi.fn()} onAnswer={vi.fn()}
    />,
  )
  expect(screen.getByRole('button', { name: /^Reply/ })).toBeDisabled()
  // A question is answered to whoever asked it, and the box shows the question itself.
  expect(screen.getByRole('textbox', { name: 'Answer to Writer' })).toHaveAttribute('placeholder', 'Which tone?')
})

const demoStop = { node: 'review', name: 'You', kind: 'review_stop' as const, since: '2026-10-04T00:00:00Z', question: 'Researcher is done. Approve the findings, or say what to change.', park: 'kept_alive' as const, parkNote: 'kept alive', handoverFrom: 'researcher', sendBackAvailable: true }

// Field report (2026-10-04): the note box was a borderless line whose placeholder, the stop's own
// question, read like a heading, and a screen reader called it "Answer to You".
it('gives a review stop a note field that looks and reads like one', () => {
  render(
    <Composer
      mode="pipeline" stepCount={3} state={{ kind: 'answering', waiting: demoStop, sending: false }} value="" onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()}
      onRetry={vi.fn()} onNewRun={vi.fn()} onAnswer={vi.fn()}
    />,
  )
  const note = screen.getByRole('textbox', { name: 'Your note to the team' })
  expect(note).toHaveClass('comp-field')
  expect(note).toHaveAttribute('placeholder', 'Type what should change, or leave empty to approve as is')
  expect(screen.queryByRole('textbox', { name: /Answer to/ })).not.toBeInTheDocument()
})

// Field report (2026-10-04): the demo's handover showed "## Summary … ## Open questions" as raw
// text. It is Markdown, rendered as the team's answer is, and raw HTML in it is never rendered.
it('shows what the stage handed over as formatted Markdown, never as HTML', async () => {
  const { container } = render(
    <Composer
      mode="pipeline" stepCount={3} state={{ kind: 'answering', waiting: demoStop, sending: false }} value="" onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()}
      onRetry={vi.fn()} onNewRun={vi.fn()} onAnswer={vi.fn()}
      reviewContext={{ label: 'What Researcher handed over', text: '## Summary\nDemo options: a **short** guide.\n\n- One\n- Two\n\n<img src="https://tracker.example/pixel.gif">\n\n## Open questions\nWhich format?' }}
    />,
  )
  fireEvent.click(screen.getByText('What Researcher handed over'))
  expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Open questions' })).toBeInTheDocument()
  expect(screen.getByText('short').tagName).toBe('STRONG')
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['One', 'Two'])
  expect(container.querySelector('.operator-context img')).toBeNull()
  expect(container.querySelector('.operator-context')).not.toHaveTextContent('##')
})

// The one-line composer on the run screen used to stay one line after the run ended, hiding
// Retry and "Redo from" — the ways the README tells people to go on from a result.
it('brings back the full set of next steps once a run is over, even in the one-line layout', () => {
  const onRetry = vi.fn()
  render(
    <Composer
      compact mode="pipeline" stepCount={3} state={{ kind: 'terminal', phase: 'succeeded' }} value="" onChange={vi.fn()}
      onSubmit={vi.fn()} onStop={vi.fn()} onRetry={onRetry} onNewRun={vi.fn()}
      onFollowUp={vi.fn()} followUpStages={[{ id: 'writer', name: 'Writer' }]}
    />,
  )
  expect(screen.getByRole('group', { name: 'Prompt composer' })).not.toHaveClass('prototype-composer')
  expect(screen.getByRole('button', { name: /Follow up/ })).toBeInTheDocument()
  expect(screen.getByLabelText('Follow up target')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetry).toHaveBeenCalledOnce()
})

it('keeps the one-line layout for asking', () => {
  render(
    <Composer
      compact mode="pipeline" stepCount={3} state={{ kind: 'ready' }} value="Plan a trip" onChange={vi.fn()}
      onSubmit={vi.fn()} onStop={vi.fn()} onRetry={vi.fn()} onNewRun={vi.fn()}
     
    />,
  )
  expect(screen.getByRole('group', { name: 'Prompt composer' })).toHaveClass('prototype-composer')
  expect(screen.getByRole('button', { name: 'Run team' })).toBeEnabled()
})

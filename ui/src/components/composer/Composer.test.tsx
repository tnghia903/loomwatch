import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { Composer, type ComposerState } from './Composer'

afterEach(cleanup)

// The §1 contracts the gate can only see structurally: `verify-composer-conformance.mjs` greps
// source, so it can tell that the height effect depends on focus but not that focusing and
// blurring actually move the height. §10.6 found C2 had no behavioural cover at all.
function renderComposer(state: ComposerState = { kind: 'ready' }, value = 'one\ntwo\nthree\nfour\nfive\nsix') {
  return render(
    <Composer
      mode="pipeline" stepCount={2} state={state} value={value} onChange={vi.fn()} onSubmit={vi.fn()} onStop={vi.fn()}
      onRetry={vi.fn()} onNewRun={vi.fn()} onOpenMode={vi.fn()} onOpenHistory={vi.fn()} modeOpen={false} historyOpen={false}
    />,
  )
}

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

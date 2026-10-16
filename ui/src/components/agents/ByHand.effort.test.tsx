import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import claude from '../../lib/models/fixtures/claude.json'
import { ByHand } from './ByHand'

// The bench's 3D figure is beside the point here.
vi.mock('./AgentFigure', () => ({ default: () => null }))

const harness: DetectedHarness = {
  id: 'claude', name: 'Claude', command: 'claude', executablePath: '/bin/claude', acpAvailable: true,
  spawn: { cmd: 'claude-agent-acp', args: [] },
}

function renderByHand(draft: Partial<AgentDraft>) {
  const set = vi.fn()
  render(<ByHand draft={{ ...BLANK_DRAFT, appId: 'claude', ...draft }} set={set} harness={harness} harnesses={[harness]} harnessesLoading={false} models={claude} skills={[]} skillsLoading={false} tools={[]} toolsLoading={false} roleField={createRef()} markId="researcher" figure={{ kind: 'yarn', color: 'sage' }} record={null} />)
  return set
}

afterEach(cleanup)

// Claude lists one effort option, for the model its session runs on, and nothing for any other.
// Recorded from claude-agent-acp 0.85.1 running on Sonnet (lib/models/fixtures/claude.json).
describe('By hand: thinking effort, on Claude’s recorded catalog', () => {
  it('offers the efforts of the model Claude runs on', () => {
    renderByHand({ model: '' })
    expect(screen.getByRole('slider', { name: 'Thinking effort' })).toHaveAttribute('aria-valuetext', 'Xhigh')
  })

  it('offers none on Haiku 4.5, which runs at its own default', () => {
    renderByHand({ model: 'haiku' })
    expect(screen.queryByRole('slider', { name: 'Thinking effort' })).not.toBeInTheDocument()
    expect(screen.getByText('It runs at the model’s own default effort.')).toBeInTheDocument()
  })

  it('takes the effort out when Haiku 4.5 is picked', () => {
    const set = renderByHand({ model: 'sonnet', effort: 'low' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'haiku' } })
    expect(set).toHaveBeenCalledWith('effort', '')
    expect(set).toHaveBeenCalledWith('model', 'haiku')
  })

  it('says an effort a saved agent asks of Haiku is used only if it has one, and offers its default', () => {
    const set = renderByHand({ model: 'haiku', effort: 'high' })
    expect(screen.getByText(/Used only if this model has that setting/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use its default' }))
    expect(set).toHaveBeenCalledWith('effort', '')
  })
})

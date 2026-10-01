import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CapabilityInspector } from './CapabilityInspector'

/** What the daemon answers `GET /api/capabilities/{id}` with, for a skill with no coupling. */
const PORTABLE_DETAILS = {
  id: 'skill-notebooklm', kind: 'skill',
  definitions: [{ source: 'Codex', path: '/skills/notebooklm/SKILL.md', content: '---\nname: notebooklm\n---\nUse the notebook.' }],
  portability: { kind: 'portable', needs: [], evidence: [], routes: { claude: 'native', codex: 'native' } },
}

/** The same shape for a Claude-coupled skill that produces a deliverable. */
const COUPLED_DETAILS = {
  ...PORTABLE_DETAILS,
  portability: {
    kind: 'artifact',
    needs: ['subagents', 'scripts'],
    evidence: [
      { need: 'subagents', line: 'Use the Task tool to fan out three variants.' },
      { need: 'scripts', line: 'Run `python3 scripts/render.py` to build it.' },
    ],
    routes: { claude: 'native', codex: 'inline', hermes: 'blocked' },
  },
}

function serve(details: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(details), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })))
}

beforeEach(() => { serve(PORTABLE_DETAILS) })

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('CapabilityInspector', () => {
  const item = { id: 'skill-notebooklm', name: 'notebooklm', source: 'Claude Code + Codex', detail: 'Research notebooks', status: 'Ready' as const }

  it('shows scanned details, the local skill definition, and an explicit canvas action', async () => {
    const onAdd = vi.fn()
    render(<CapabilityInspector item={item} kind="skill" placed={false} connectedAgents={[]} onAdd={onAdd} onReveal={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('region', { name: 'Skill details' })).toHaveTextContent('Research notebooks')
    expect(screen.getByText('Claude Code + Codex')).toBeInTheDocument()
    expect(await screen.findByText(/Use the notebook/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to canvas' }))
    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('connects a skill discovered in another harness through a direct agent choice', async () => {
    const onToggleAgent = vi.fn()
    const props = {item, kind: 'skill' as const, placed: false, connectedAgents: [], agents: [{id: 'designer', name: 'Report Designer', harness: 'Codex', connected: false}], onToggleAgent, onAdd: vi.fn(), onReveal: vi.fn(), onClose: vi.fn()}
    const view = render(<CapabilityInspector {...props} />)
    await screen.findByText(/Use the notebook/)
    fireEvent.click(screen.getByRole('checkbox', {name: 'Use notebooklm with Report Designer (Codex)'}))
    expect(onToggleAgent).toHaveBeenCalledWith('designer', true)
    view.rerender(<CapabilityInspector {...props} agents={[{...props.agents[0], connected: true}]} readOnly />)
    expect(screen.getByRole('checkbox', {name: 'Use notebooklm with Report Designer (Codex)'})).toBeChecked()
    expect(screen.getByRole('checkbox', {name: 'Use notebooklm with Report Designer (Codex)'})).toBeDisabled()
  })

  /**
   * ADR 0021's operator-facing half: the panel says what the skill assumes, quotes the line that
   * says so, and states what will happen on each agent's harness. The old copy said only that
   * "skill-specific tools still need to be available in the receiving harness", which named no
   * skill, no tool and no harness.
   */
  it('names what a skill assumes, quotes the line proving it, and states the route per agent', async () => {
    serve(COUPLED_DETAILS)
    const agents = [
      { id: 'designer', name: 'Report Designer', harness: 'Codex', harnessId: 'codex', connected: true },
      { id: 'writer', name: 'Research', harness: 'Claude', harnessId: 'claude', connected: false },
    ]
    render(<CapabilityInspector item={item} kind="skill" placed connectedAgents={['Report Designer']} agents={agents} onToggleAgent={vi.fn()} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)

    expect(await screen.findByText('Produces a deliverable.')).toBeInTheDocument()
    expect(screen.getByText('subagents')).toBeInTheDocument()
    expect(screen.getByText('Use the Task tool to fan out three variants.')).toBeInTheDocument()
    expect(screen.getByText(/Codex · in-prompt, translated for Codex/)).toBeInTheDocument()
    expect(screen.getByText(/Claude · native/)).toBeInTheDocument()
    // The route is the daemon's answer, not this component's: a harness the report says nothing
    // about must show no route rather than a guessed one.
    const quiet = { id: 'other', name: 'Other', harness: 'OpenCode', harnessId: 'opencode', connected: false }
    cleanup()
    serve(COUPLED_DETAILS)
    render(<CapabilityInspector item={item} kind="skill" placed connectedAgents={[]} agents={[quiet]} onToggleAgent={vi.fn()} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText('OpenCode')).toBeInTheDocument()
  })

  it('offers the Claude agent already in the team for a deliverable-producing skill, and connects it', async () => {
    serve(COUPLED_DETAILS)
    const onToggleAgent = vi.fn()
    const agents = [
      { id: 'designer', name: 'Report Designer', harness: 'Codex', harnessId: 'codex', connected: true },
      { id: 'writer', name: 'Research', harness: 'Claude', harnessId: 'claude', connected: false },
    ]
    const view = render(<CapabilityInspector item={item} kind="skill" placed connectedAgents={['Report Designer']} agents={agents} onToggleAgent={onToggleAgent} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect to Research' }))
    expect(onToggleAgent).toHaveBeenCalledWith('writer', true)

    // The counterfactual: the suggestion exists because one connected agent would only get the
    // skill inlined. Connect the Claude agent and there is nothing left to suggest.
    view.rerender(<CapabilityInspector item={item} kind="skill" placed connectedAgents={['Report Designer', 'Research']} agents={[agents[0], { ...agents[1], connected: true }]} onToggleAgent={onToggleAgent} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Connect to Research' })).not.toBeInTheDocument()
  })

  it('does not suggest a Claude agent for a skill that assumes nothing', async () => {
    const agents = [
      { id: 'designer', name: 'Report Designer', harness: 'Codex', harnessId: 'codex', connected: true },
      { id: 'writer', name: 'Research', harness: 'Claude', harnessId: 'claude', connected: false },
    ]
    render(<CapabilityInspector item={item} kind="skill" placed connectedAgents={['Report Designer']} agents={agents} onToggleAgent={vi.fn()} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText(/Nothing in its text assumes/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect to Research' })).not.toBeInTheDocument()
  })

  it('names connected agents and reveals an existing card', async () => {
    const onReveal = vi.fn()
    render(<CapabilityInspector item={item} kind="skill" placed connectedAgents={['Collector', 'Editor']} onAdd={vi.fn()} onReveal={onReveal} onClose={vi.fn()} />)

    expect(screen.getByText('Connected to Collector, Editor')).toBeInTheDocument()
    await screen.findByText(/Use the notebook/)
    fireEvent.click(screen.getByRole('button', { name: 'Show on canvas' }))
    expect(onReveal).toHaveBeenCalledOnce()
  })
})

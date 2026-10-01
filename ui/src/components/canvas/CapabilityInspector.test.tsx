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

  it('shows what a knowledge source holds, which is what a connected agent receives', async () => {
    serve({
      id: 'source-project', kind: 'knowledge',
      definitions: [
        { source: 'LoomWatch · folder', path: '/work/loomwatch', content: 'crates/\nui/\nREADME.md' },
        { source: 'OpenCode · sessions in this project', path: '/work/loomwatch', content: '2026-09-30 10:00  Fix the canvas' },
      ],
    })
    const source = { id: 'source-project', name: 'loomwatch project', source: 'LoomWatch + OpenCode', detail: 'Previously used project context', status: 'Ready' as const }
    render(<CapabilityInspector item={source} kind="knowledge" placed connectedAgents={['Research']} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)

    expect(await screen.findByText(/Fix the canvas/)).toBeInTheDocument()
    expect(screen.getByText('Contents')).toBeInTheDocument()
    expect(screen.getByText('LoomWatch · folder')).toBeInTheDocument()
    expect(screen.getByText(/crates\//)).toBeInTheDocument()
    expect(screen.getByText(/receives exactly these contents in its opening prompt/)).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/capabilities/source-project'))
  })

  /** ADR 0029: knowledge and tools are connected to agents like skills, through the team file. */
  it('connects a knowledge source or a tool to an agent, but not team memory', async () => {
    serve({ id: 'source-project', kind: 'knowledge', definitions: [{ source: 'LoomWatch · folder', path: '/work', content: 'README.md' }] })
    const onToggleAgent = vi.fn()
    const agents = [{ id: 'research', name: 'Research', harness: 'Claude Code', connected: true }]
    const source = { id: 'source-project', name: 'loomwatch project', source: 'LoomWatch', detail: 'Project folder', status: 'Ready' as const }
    const view = render(<CapabilityInspector item={source} kind="knowledge" placed connectedAgents={['Research']} agents={agents} onToggleAgent={onToggleAgent} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText(/README.md/)
    expect(screen.getByText('Connected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use loomwatch project with Research (Claude Code)' }))
    expect(onToggleAgent).toHaveBeenCalledWith('research', false)
    expect(screen.getByText(/supply its contents to an agent in the next run/)).toBeInTheDocument()

    serve({ id: 'tool-memory', kind: 'tool', definitions: [] })
    const tool = { id: 'tool-memory', name: 'Agent Memory', source: 'Claude Code', detail: 'Local MCP connector', status: 'Compatible' as const }
    view.rerender(<CapabilityInspector item={tool} kind="tool" placed={false} connectedAgents={[]} agents={[{ ...agents[0], connected: false }]} onToggleAgent={onToggleAgent} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Agent Memory with Research (Claude Code)' }))
    expect(onToggleAgent).toHaveBeenLastCalledWith('research', true)
    expect(screen.getByText(/give an agent its MCP server in the next run/)).toBeInTheDocument()

    serve({ id: 'memory-team', kind: 'knowledge', definitions: [] })
    const memory = { id: 'memory-team', name: 'Research team · memory', source: 'LoomWatch', detail: '1 brief entry', status: 'Ready' as const, memory: { team: 'research-team', brief: 1 } }
    view.rerender(<CapabilityInspector item={memory} kind="knowledge" placed={false} connectedAgents={[]} agents={agents} onToggleAgent={onToggleAgent} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('says so when a knowledge source has nothing readable', async () => {
    serve({ id: 'source-empty', kind: 'knowledge', definitions: [] })
    const source = { id: 'source-empty', name: 'Empty project', source: 'OpenCode', detail: 'Previously used project context', status: 'Ready' as const }
    render(<CapabilityInspector item={source} kind="knowledge" placed={false} connectedAgents={[]} onAdd={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />)

    expect(await screen.findByText('Nothing readable was found for this source.')).toBeInTheDocument()
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

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import type { CapabilityInventory } from '../../lib/library/client'
import type { Evidence } from '../../lib/watch/events'
import { CAPABILITY_DRAG_MIME, EVIDENCE_DRAG_MIME, LIBRARY_DRAG_MIME } from './constants'
import { Library } from './Library'

const openCode: DetectedHarness = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  executablePath: '/usr/local/bin/opencode',
  spawn: { cmd: 'opencode', args: ['acp'] },
}

const capabilities: CapabilityInventory = {
  skills: [{ id: 'skill-notebooklm', name: 'notebooklm', source: 'Claude Code + Codex', detail: 'Research notebooks', status: 'Ready' }],
  tools: [{ id: 'tool-memory', name: 'Agent Memory', source: 'Claude Code + Codex', detail: 'Local MCP connector', status: 'Compatible' }],
  // Team memory is the only knowledge the daemon lists (ADR 0036).
  sources: [{ id: 'memory-research', name: 'Research team · memory', source: 'LoomWatch', detail: '1 brief entry · this team’s kept notes travel with it', status: 'Ready', memory: { team: 'research-team', brief: 1 } }],
}

function recordedEvidence(overrides: Partial<Evidence> & Pick<Evidence, 'id' | 'kind' | 'name'>): Evidence {
  return {
    seq: 1, order: 1, agentId: 'agent', relation: 'used', detail: '', status: 'succeeded', capture: 'recorded',
    ts: '2026-09-11T00:00:00Z', offsetMs: 0, callId: null, toolKind: null, rawInput: null, rawOutput: null,
    content: null, locations: [], target: null, events: [], ...overrides,
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
})

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  window.dispatchEvent(new Event('resize'))
}

describe('Library', () => {
  it('shows detected harness rows with their spawn command and counts', () => {
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} />)
    expect(screen.getByRole('region', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByLabelText('Agents')).toBeInTheDocument()
    expect(screen.getByText('OpenCode')).toHaveClass('lib-row-name')
    expect(screen.getByText('opencode acp')).toHaveClass('lib-row-sub')
    expect(screen.getByText('1 of 1 usable here')).toBeInTheDocument()
  })

  it('renders a skeleton, never a spinner, while the PATH scan is running', () => {
    const { container } = render(<Library harnesses={[]} harnessesLoading harnessesError={null} />)
    expect(container.querySelectorAll('.skel-row')).toHaveLength(3)
    expect(screen.queryByText('No agent harnesses found on PATH.')).not.toBeInTheDocument()
  })

  it('shows the daemon error verbatim with a retry', () => {
    const retry = vi.fn()
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError="500: EACCES scanning /usr/local/bin" onRetry={retry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('500: EACCES scanning /usr/local/bin')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('explains missing ACP adapters and prevents dragging an unusable harness', () => {
    render(<Library harnesses={[{ ...openCode, acpAvailable: false }]} harnessesLoading={false} harnessesError={null} />)
    const row = screen.getByLabelText('OpenCode, opencode not found on PATH')
    expect(row).toHaveAttribute('draggable', 'false')
    expect(row).toHaveClass('unavailable')
    const setData = vi.fn()
    fireEvent.dragStart(row, { dataTransfer: { setData } })
    expect(setData).not.toHaveBeenCalled()
  })

  // A harness can be installed and still unrunnable: `pi` ships no ACP bridge at all. The daemon
  // knows which case it is, so the row must print the daemon's sentence rather than the client's
  // old "not found on PATH" guess, which was simply false for that harness.
  it('prints the daemon reason for an installed harness that has no ACP bridge', () => {
    const pi: DetectedHarness = {
      id: 'pi', name: 'pi', command: 'pi', executablePath: '/home/t/.local/bin/pi',
      acpAvailable: false, unavailableReason: 'pi is installed but ships no ACP bridge, so LoomWatch cannot drive it.',
      spawn: { cmd: 'pi', args: [] },
    }
    render(<Library harnesses={[pi]} harnessesLoading={false} harnessesError={null} />)
    expect(screen.getByLabelText('pi, pi is installed but ships no ACP bridge, so LoomWatch cannot drive it.')).toHaveAttribute('draggable', 'false')
    expect(screen.queryByText(/not found on PATH/)).not.toBeInTheDocument()
  })

  it('lists the harnesses the daemon looked for but did not find as not installed', () => {
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} knownHarnessIds={['claude', 'codex', 'gemini', 'opencode', 'openclaw', 'hermes', 'pi']} />)
    fireEvent.click(screen.getByRole('button', { name: /not installed/i }))
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini')).toBeInTheDocument()
    expect(screen.getByText('OpenClaw')).toBeInTheDocument()
    expect(screen.getByText('Hermes')).toBeInTheDocument()
    expect(screen.getByText('pi')).toBeInTheDocument()
    expect(screen.getByLabelText('Claude, not found on PATH')).toHaveAttribute('draggable', 'false')
  })

  // The daemon owns the vendor list now, so a harness it learns about renders without a UI
  // release. Its id stands in for a name this build has never heard of.
  it('renders a harness the daemon knows about that this build does not', () => {
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} knownHarnessIds={['newharness']} />)
    fireEvent.click(screen.getByRole('button', { name: /not installed/i }))
    expect(screen.getByText('newharness')).toBeInTheDocument()
  })

  it('shows the search-path empty state when nothing is detected', () => {
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} knownHarnessIds={['claude', 'codex', 'gemini', 'opencode', 'openclaw', 'hermes', 'pi']} harnessSearchPath={['/usr/bin', '/home/t/.local/bin']} />)
    expect(screen.getByText('No agent harnesses found on PATH.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Show search path'))
    expect(screen.getByText(/claude, codex, gemini, opencode, openclaw, hermes, pi/)).toBeInTheDocument()
    // The directories, not a description of them: "installed but invisible from here" is only
    // diagnosable if the operator can see which prefixes were actually walked.
    expect(screen.getByText('/home/t/.local/bin')).toBeInTheDocument()
  })

  it('says so when the daemon was started with no PATH at all', () => {
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} harnessSearchPath={[]} />)
    fireEvent.click(screen.getByText('Show search path'))
    expect(screen.getByText(/started without a PATH/)).toBeInTheDocument()
  })

  it('does not offer fictional models as runnable presets', () => {
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} />)
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument()
    expect(screen.getByText(/No saved presets/)).toBeInTheDocument()
  })

  it('filters rows by the search box and reports the visible count', () => {
    render(<Library harnesses={[openCode, { ...openCode, id: 'codex', name: 'Codex', spawn: { cmd: 'codex-acp', args: [] } }]} harnessesLoading={false} harnessesError={null} />)
    fireEvent.change(screen.getByLabelText('Search the Library'), { target: { value: 'cod' } })
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search the Library'), { target: { value: 'open' } })
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('adds an installed agent by clicking or activating its row', () => {
    const add = vi.fn()
    window.addEventListener('loomwatch:add-agent', add)
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} />)
    const row = screen.getByRole('button', { name: 'OpenCode, drag onto the canvas or press Enter to add it' })
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(add).toHaveBeenCalledTimes(2)
    expect(JSON.parse(add.mock.calls[0][0].detail).id).toBe('opencode')
    window.removeEventListener('loomwatch:add-agent', add)
  })

  it('puts the source payload on dataTransfer when a row drag starts', () => {
    const dragState = vi.fn()
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} onDragStateChange={dragState} />)
    const row = screen.getByLabelText('OpenCode, drag onto the canvas or press Enter to add it')
    const setData = vi.fn()
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(LIBRARY_DRAG_MIME, expect.stringContaining('"OpenCode"'))
    expect(dragState).toHaveBeenCalledWith(true)
  })

  it('makes skills, tools and knowledge sources real drag sources, not a grip that does nothing', () => {
    // The regression: these rows rendered a drag handle but carried no `draggable` attribute and
    // no handlers, so the affordance was a lie — nothing could be dragged onto the canvas.
    const dragState = vi.fn()
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} onDragStateChange={dragState} />)

    for (const [label, payload] of [
      ['notebooklm, skill from Claude Code + Codex, click for details or drag onto the canvas', '"kind":"skill"'],
      ['Agent Memory, tool or connector from Claude Code + Codex, click for details or drag onto the canvas', '"kind":"tool"'],
      ['Research team · memory, knowledge source from LoomWatch, click for details or drag onto the canvas', '"memory":{"team":"research-team"}'],
    ] as const) {
      const row = screen.getByLabelText(label)
      expect(row).toHaveAttribute('draggable', 'true')
      const setData = vi.fn()
      fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } })
      expect(setData).toHaveBeenCalledWith(CAPABILITY_DRAG_MIME, expect.stringContaining(payload))
    }
    expect(dragState).toHaveBeenCalledWith(true)
  })

  it('opens capability details by click and keyboard without changing the canvas', () => {
    const inspect = vi.fn()
    const placed = vi.fn()
    window.addEventListener('loomwatch:add-capability', placed)
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} onInspectCapability={inspect} />)

    fireEvent.click(screen.getByLabelText(/^notebooklm, skill/))
    fireEvent.keyDown(screen.getByLabelText(/^Agent Memory, tool or connector/), { key: 'Enter' })

    expect(inspect).toHaveBeenNthCalledWith(1, capabilities.skills[0], 'skill')
    expect(inspect).toHaveBeenNthCalledWith(2, capabilities.tools[0], 'tool')
    expect(placed).not.toHaveBeenCalled()
    window.removeEventListener('loomwatch:add-capability', placed)
  })

  it('names the one relationship each kind can carry onto the canvas', () => {
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} />)
    expect(screen.getByLabelText(/^notebooklm, skill/)).toHaveTextContent('skill · uses skill')
    expect(screen.getByLabelText(/^Agent Memory, tool/)).toHaveTextContent('tool or connector · invokes')
    expect(screen.getByLabelText(/^Research team · memory, knowledge/)).toHaveTextContent('knowledge source · reads')
  })

  it('lists evidence-backed skills and tools and lets their cards be revealed or repositioned', () => {
    const reveal = vi.fn()
    const evidence = [
      recordedEvidence({ id: 'skill-1', kind: 'skill', name: 'release-evidence', detail: 'v3' }),
      recordedEvidence({ id: 'tool-1', callId: 'call-1', kind: 'tool', name: 'notion · search', detail: 'workspace.search', events: [{ id: 'event-1', sessionId: 'run-1', agentId: 'agent', seq: 1, ts: '2026-09-11T00:00:00Z', kind: 'tool_call', payload: { name: 'mcp__notion__search' } }] }),
    ]
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} observedEvidence={evidence} onRevealEvidence={reveal} />)

    expect(screen.getByLabelText('Skills')).toHaveTextContent('release-evidence')
    expect(screen.getByLabelText('Tools & connectors')).toHaveTextContent('notion · search')
    const row = screen.getByRole('button', { name: /notion · search, recorded tool/ })
    fireEvent.click(row)
    expect(reveal).toHaveBeenCalledWith('tool-1')
    const setData = vi.fn()
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(EVIDENCE_DRAG_MIME, 'tool-1')
  })

  it('shows everything found by the local capability scan and can scan again', () => {
    const scanAgain = vi.fn()
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={capabilities} capabilitiesScannedAt={new Date()} onRetryCapabilities={scanAgain} />)

    expect(screen.getByLabelText('Skills')).toHaveTextContent('notebooklm')
    expect(screen.getByLabelText('Skills')).toHaveTextContent('Claude Code + Codex')
    expect(screen.getByLabelText('Tools & connectors')).toHaveTextContent('Agent Memory')
    expect(screen.getByLabelText('Knowledge sources')).toHaveTextContent('Research team · memory')
    fireEvent.click(screen.getByRole('button', { name: /scan again/i }))
    expect(scanAgain).toHaveBeenCalledOnce()
  })

  /** ADR 0036: with no team memory the group is empty, and says where a folder or file is added. */
  it('points an empty knowledge group at Add folder and Add file', () => {
    render(<Library harnesses={[]} harnessesLoading={false} harnessesError={null} capabilityInventory={{ ...capabilities, sources: [] }} />)
    expect(screen.getByLabelText('Knowledge sources')).toHaveTextContent('Teams with memory appear here. To give an agent a folder or file, select the agent and use Add folder… or Add file… in its Context.')
    expect(screen.getByLabelText('Skills')).not.toHaveTextContent('Teams with memory appear here')
  })

  it('uses a collapsed rail and scrim-backed sheet at tablet widths', () => {
    setWindowWidth(900)
    render(<Library harnesses={[openCode]} harnessesLoading={false} harnessesError={null} />)

    expect(screen.getByRole('toolbar', { name: 'Library, collapsed' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Library' }))
    expect(screen.getByRole('region', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close Library' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close Library' }))
    expect(screen.getByRole('toolbar', { name: 'Library, collapsed' })).toBeInTheDocument()
  })
})

// ⌥⌘L organizes the canvas. Holding Option on macOS changes the character a key types, so Safari
// and Chrome report ⌥⌘L as `key: '¬'` — the shortcut matched `event.key` alone and never fired
// there. These tests dispatch presses the way each platform reports them, and pin that plain `L`
// (solo an edge layer) is not caught by the fix.
import { fireEvent, renderHook } from '@testing-library/react'
import { describe, expect, it, vi, type Mock } from 'vitest'

import type { LayerSolo } from '../canvas/LayerLegend'
import { useWorkspaceShortcuts, type WorkspaceShortcutContext } from './useWorkspaceShortcuts'

function shortcuts(overrides: Partial<WorkspaceShortcutContext> = {}) {
  let solo: LayerSolo = 'both'
  const context: WorkspaceShortcutContext = {
    editable: true,
    doc: {
      nodes: [], edges: [], pipelineSteps: [], refusal: null,
      save: vi.fn(), reloadFromDisk: vi.fn(), undo: vi.fn(), redo: vi.fn(), dismissRefusal: vi.fn(),
      onNodesChange: vi.fn(), onEdgesChange: vi.fn(),
    } as unknown as WorkspaceShortcutContext['doc'],
    flow: { fitView: vi.fn(), setViewport: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn() },
    theme: 'light',
    windowWidth: 1280,
    runView: true,
    layersVisible: true,
    session: { terminal: false, lastSeq: 0, cursor: null, setCursor: vi.fn() } as unknown as WorkspaceShortcutContext['session'],
    submit: vi.fn(async () => {}),
    openNewTeam: vi.fn(),
    toggleLibrary: vi.fn(),
    cycleProblem: vi.fn(),
    clearSelection: vi.fn(),
    closeRun: vi.fn(),
    organize: vi.fn(),
    fitCanvas: vi.fn(),
    pendingNodeDelete: [],
    setPendingNodeDelete: vi.fn(),
    requestNodeDelete: vi.fn(),
    deleteNodes: vi.fn(),
    discardConfirm: false,
    setDiscardConfirm: vi.fn(),
    paletteOpen: false,
    setPaletteOpen: vi.fn(),
    historyOpen: false,
    setHistoryOpen: vi.fn(),
    problemsOpen: false,
    setProblemsOpen: vi.fn(),
    yamlOpen: false,
    setYamlOpen: vi.fn(),
    compareOpen: false,
    setCompareOpen: vi.fn(),
    inspectedEvidenceId: null,
    setInspectedEvidenceId: vi.fn(),
    handoverAgentId: null,
    setHandoverAgentId: vi.fn(),
    inspectedCapability: null,
    provenanceOpen: false,
    setProvenanceOpen: vi.fn(),
    memoryOpen: false,
    setMemoryOpen: vi.fn(),
    fannedAgentId: null,
    setFannedAgentId: vi.fn(),
    setSolo: vi.fn((next) => { solo = typeof next === 'function' ? next(solo) : next }),
    setSweeping: vi.fn(),
    selectedNodes: [],
    selectedEdges: [],
    selectedCapabilities: new Set(),
    selectedCapabilityEdgeIds: new Set(),
    capabilityCards: [],
    capabilityEdgeById: new Map(),
    removeCapabilityCards: vi.fn(),
    removeCapabilityEdge: vi.fn(),
    ...overrides,
  }
  const view = renderHook(() => useWorkspaceShortcuts(context))
  return { context, organize: context.organize as Mock, solo: () => solo, unmount: view.unmount }
}

describe('useWorkspaceShortcuts', () => {
  it('organizes on ⌥⌘L as macOS reports it, where Option turns L into ¬', () => {
    const { organize, context, unmount } = shortcuts()
    fireEvent.keyDown(window, { key: '¬', code: 'KeyL', altKey: true, metaKey: true })
    expect(organize).toHaveBeenCalledTimes(1)
    expect(context.setSolo).not.toHaveBeenCalled()
    unmount()
  })

  it('organizes on Ctrl+Alt+L as Windows and Linux report it, and when AltGr turns L into another letter', () => {
    const { organize, unmount } = shortcuts()
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL', altKey: true, ctrlKey: true })
    expect(organize).toHaveBeenCalledTimes(1)
    // Polish Programmer: Ctrl+Alt is AltGr, and AltGr+L types ł.
    fireEvent.keyDown(window, { key: 'ł', code: 'KeyL', altKey: true, ctrlKey: true })
    expect(organize).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('follows the keyboard layout while it still reports a plain letter', () => {
    const { organize, unmount } = shortcuts()
    // Colemak on Windows or Linux: L sits where QWERTY has U, and the physical L key types I.
    // (Not Dvorak: its physical L types N, and Ctrl+Alt+N is caught first as ⌘N, New team.)
    fireEvent.keyDown(window, { key: 'i', code: 'KeyL', altKey: true, ctrlKey: true })
    expect(organize).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'l', code: 'KeyU', altKey: true, ctrlKey: true })
    expect(organize).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('leaves ⌥⌘L to a text field that has focus', () => {
    const { organize, unmount } = shortcuts()
    const field = document.body.appendChild(document.createElement('textarea'))
    fireEvent.keyDown(field, { key: '¬', code: 'KeyL', altKey: true, metaKey: true })
    expect(organize).not.toHaveBeenCalled()
    field.remove()
    unmount()
  })

  it('still cycles the edge layers on a plain L, and organizes nothing', () => {
    const { organize, solo, unmount } = shortcuts()
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' })
    expect(solo()).toBe('configured')
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' })
    expect(solo()).toBe('observed')
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' })
    expect(solo()).toBe('both')
    // Option alone is neither shortcut: ⌥L types ¬ and soloes nothing.
    fireEvent.keyDown(window, { key: '¬', code: 'KeyL', altKey: true })
    expect(solo()).toBe('both')
    expect(organize).not.toHaveBeenCalled()
    unmount()
  })

  it('leaves a plain L inert while no legend names the edge layers', () => {
    const { context, unmount } = shortcuts({ layersVisible: false })
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' })
    expect(context.setSolo).not.toHaveBeenCalled()
    unmount()
  })
})

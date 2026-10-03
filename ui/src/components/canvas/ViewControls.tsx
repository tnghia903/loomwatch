import { getNodesBounds, useReactFlow, useStore } from '@xyflow/react'
import { Moon, Sun, Workflow, Undo2 } from 'lucide-react'

import { useTheme } from '../../lib/theme'
import { DEPTHS, DEPTH_LABEL, DEPTH_ZOOM, depthForZoom, type Depth } from '../../lib/story/depth'
import { SegmentThumb } from '../ui/SegmentThumb'

/**
 * Story · Team · Trace: the zoom levels at which cards change what they say (lib/story/depth.ts).
 * It is the canvas's one zoom control (ADR 0043), spelled in words, so a newcomer can find the
 * detail and an expert can jump straight to it; scrolling, pinching and the zoom keys move the
 * same selection. Story frames the whole team, which is what a separate Fit button used to do.
 */
export function DepthDial({ className = '', onStory }: { className?: string; onStory?: () => void }) {
  const flow = useReactFlow()
  const depth = useStore((store) => depthForZoom(store.transform[2]))
  const minZoom = useStore((store) => store.minZoom)
  const maxZoom = useStore((store) => store.maxZoom)
  const go = (next: Depth) => {
    if (next === 'story' && onStory) { onStory(); return }
    const zoom = Math.min(maxZoom, Math.max(minZoom, DEPTH_ZOOM[next]))
    const nodes = flow.getNodes().filter((node) => !node.hidden)
    if (nodes.length === 0) { void flow.zoomTo(zoom, { duration: 320 }); return }
    // Leaning in goes towards something: the selected card, else the agent that starts the run.
    // Leaning out goes back to the whole team. Zooming about the screen centre instead could leave
    // every card off-screen, which reads as "the cards vanished".
    const focus = next === 'story' ? null : nodes.find((node) => node.selected) ?? nodes.find((node) => node.type === 'agent' && (node.data as { isEntrypoint?: boolean }).isEntrypoint) ?? null
    if (focus) {
      const width = focus.measured?.width ?? 235
      // A Trace card grows downwards, so aim at its upper part to keep its header in view.
      void flow.setCenter(focus.position.x + width / 2, focus.position.y + (next === 'trace' ? 140 : 50), { zoom, duration: 320 })
    } else {
      const bounds = getNodesBounds(nodes)
      void flow.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { zoom, duration: 320 })
    }
  }
  return (
    <div
      className={`depth-dial ${className}`}
      role="radiogroup"
      aria-label="How much detail the cards show"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const index = Math.max(0, Math.min(DEPTHS.length - 1, DEPTHS.indexOf(depth) + (event.key === 'ArrowRight' ? 1 : -1)))
        go(DEPTHS[index])
        ;(event.currentTarget.querySelectorAll('button')[index] as HTMLButtonElement | undefined)?.focus()
      }}
    >
      <SegmentThumb />
      {DEPTHS.map((option) => (
        <button key={option} type="button" role="radio" aria-checked={depth === option} tabIndex={depth === option ? 0 : -1} aria-label={DEPTH_LABEL[option].name} aria-description={DEPTH_LABEL[option].hint} title={DEPTH_LABEL[option].hint} onClick={() => go(option)}>
          {DEPTH_LABEL[option].name}
        </button>
      ))}
    </div>
  )
}

// UX_REDESIGN §3 / DESIGN_LANGUAGE §11: Organize, the dial, the zoom level, theme. The theme glyph
// names the DESTINATION, not the current state; a hairline dot under it means "following system".
// One bar on every canvas (ADR 0041), and one zoom control in it (ADR 0043): −, + and Fit did what
// the dial, the wheel and the zoom keys already do.
export function ViewControls({ onOrganize, onUndoOrganize, onFit, organizeDisabled = false }: { onOrganize?: () => void; onUndoOrganize?: () => void; onFit?: () => void; organizeDisabled?: boolean }) {
  const zoom = useStore((store) => store.transform[2])
  const { resolved, mode, toggle } = useTheme()
  return (
    // The bar is a fixed landmark: it does not shift when a right panel opens (the panels
    // stop above it instead), so it takes no layout input from the rest of the shell.
    <div className={`panel right bottom e1 lw-viewctl ${mode === 'system' ? 'theme-system' : ''}`} aria-label="View controls" role="toolbar">
      {onOrganize && <button type="button" className="btn organize-button" title="Organize agents and resources (⌥⌘L)" disabled={organizeDisabled} onClick={onOrganize}><Workflow size={15} aria-hidden="true" /> Organize</button>}
      {onUndoOrganize && <button type="button" className="iconbtn" aria-label="Undo organize" title="Restore the previous arrangement" onClick={onUndoOrganize}><Undo2 size={15} aria-hidden="true" /></button>}
      <DepthDial onStory={onFit} />
      <span className="zoomlvl t-mono-sm" title="Zoom level: scroll or pinch, ⌘− and ⌘+; ⌘0 resets to 100%">{Math.round(zoom * 100)}%</span>
      <button type="button" className="iconbtn" title={resolved === 'dark' ? 'Switch to light (⌘⇧L)' : 'Switch to dark (⌘⇧L)'} aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
        {resolved === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
        <span className="sysdot" aria-hidden="true" />
      </button>
    </div>
  )
}

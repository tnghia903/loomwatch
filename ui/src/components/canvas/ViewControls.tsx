import { useReactFlow, useStore } from '@xyflow/react'
import { Maximize2, Minus, Moon, Plus, Sun, Workflow, Undo2 } from 'lucide-react'

import { useTheme } from '../../lib/theme'

// UX_REDESIGN §3 / DESIGN_LANGUAGE §11: −, level, +, fit, theme. The theme glyph names the
// DESTINATION, not the current state; a hairline dot under it means "following system".
export function ViewControls({ prototype = false, onOrganize, onUndoOrganize, onFit, organizeDisabled = false }: { prototype?: boolean; onOrganize?: () => void; onUndoOrganize?: () => void; onFit?: () => void; organizeDisabled?: boolean }) {
  const flow = useReactFlow()
  const zoom = useStore((store) => store.transform[2])
  const { resolved, mode, toggle } = useTheme()
  const minZoom = useStore((store) => store.minZoom)
  const maxZoom = useStore((store) => store.maxZoom)
  if (prototype) return <><button className="fit-canvas" onClick={onFit}>Fit team</button><div className="prototype-canvas-controls" role="toolbar" aria-label="View controls"><button aria-label="Zoom in" onClick={() => void flow.zoomIn({ duration: 200 })}><Plus size={16} /></button><button aria-label="Zoom out" onClick={() => void flow.zoomOut({ duration: 200 })}><Minus size={16} /></button><button aria-label="Fit view" onClick={onFit}><Maximize2 size={15} /></button></div></>
  return (
    // The bar is a fixed landmark: it does not shift when a right panel opens (the panels
    // stop above it instead), so it takes no layout input from the rest of the shell.
    <div className={`panel right bottom e1 lw-viewctl ${mode === 'system' ? 'theme-system' : ''}`} aria-label="View controls" role="toolbar">
      {onOrganize && <button type="button" className="btn organize-button" title="Organize agents and resources (⌥⌘L)" disabled={organizeDisabled} onClick={onOrganize}><Workflow size={15} aria-hidden="true" /> Organize</button>}
      {onUndoOrganize && <button type="button" className="iconbtn" aria-label="Undo organize" title="Restore the previous arrangement" onClick={onUndoOrganize}><Undo2 size={15} aria-hidden="true" /></button>}
      <button type="button" className="iconbtn" title="Zoom out (⌘−)" aria-label="Zoom out" disabled={zoom <= minZoom + 0.001} onClick={() => void flow.zoomOut({ duration: 200 })}><Minus size={16} aria-hidden="true" /></button>
      <span className="zoomlvl t-mono-sm" title="Zoom level — ⌘0 resets to 100%">{Math.round(zoom * 100)}%</span>
      <button type="button" className="iconbtn" title="Zoom in (⌘+)" aria-label="Zoom in" disabled={zoom >= maxZoom - 0.001} onClick={() => void flow.zoomIn({ duration: 200 })}><Plus size={16} aria-hidden="true" /></button>
      <button type="button" className="iconbtn" title="Fit view (F)" aria-label="Fit view" onClick={onFit ?? (() => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 }))}><Maximize2 size={15} aria-hidden="true" /></button>
      <button type="button" className="iconbtn" title={resolved === 'dark' ? 'Switch to light (⌘⇧L)' : 'Switch to dark (⌘⇧L)'} aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
        {resolved === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
        <span className="sysdot" aria-hidden="true" />
      </button>
    </div>
  )
}

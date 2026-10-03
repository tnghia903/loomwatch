import type { KeyboardEvent, PointerEvent } from 'react'

import { PALETTE_WIDTH, clampPaletteWidth } from '../../lib/library/paletteWidth'

/**
 * The add panel's right edge, dragged to make the panel wider or narrower. Long skill and folder
 * names are cut at 210 px; a wider panel shows them whole. Arrow keys move it too, and a double
 * click puts the default back.
 */
export function PaletteResizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const left = handle.parentElement?.getBoundingClientRect().left ?? 0
    handle.setPointerCapture?.(event.pointerId)
    document.body.classList.add('palette-resizing')
    const move = (next: globalThis.PointerEvent) => onResize(clampPaletteWidth(next.clientX - left))
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      document.body.classList.remove('palette-resizing')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = {
      ArrowLeft: width - PALETTE_WIDTH.step,
      ArrowRight: width + PALETTE_WIDTH.step,
      Home: PALETTE_WIDTH.min,
      End: PALETTE_WIDTH.max,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    onResize(clampPaletteWidth(next))
  }
  return (
    <div
      className="palette-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuemin={PALETTE_WIDTH.min}
      aria-valuemax={PALETTE_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={start}
      onDoubleClick={() => onResize(PALETTE_WIDTH.default)}
      onKeyDown={keys}
    />
  )
}

import { KNOWN_HARNESSES } from '../../lib/harnesses'
import type { LibrarySource } from '../../lib/library/types'
import { EntityGlyph } from '../ui/glyphs'
import { LIBRARY_DRAG_MIME } from './constants'

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function monogramFor(harnessId: string): string {
  return KNOWN_HARNESSES.find((harness) => harness.id === harnessId)?.monogram ?? '·'
}

function subtitleFor(source: LibrarySource): string {
  if (source.kind === 'operator') return 'Review stop · your decision'
  if (source.group === 'presets') return source.model ?? ''
  return [source.spawn.cmd, ...source.spawn.args].join(' ')
}

interface LibraryRowProps {
  source: LibrarySource
  /** Not-installed harnesses render disabled: no drag handle, "not found on PATH" (§4.2). */
  disabled?: boolean
  disabledReason?: string
  onDragStateChange?: (dragging: boolean) => void
}

// UX_REDESIGN §4.1 / TNG-124: a 44 px card with monogram, name, a mono sub-line and the
// resting grip handle. Rows are drag sources AND keyboard/click sources for placement.
export function LibraryRow({ source, disabled = false, disabledReason, onDragStateChange }: LibraryRowProps) {
  const unavailable = disabled || Boolean(disabledReason)
  const reason = disabledReason ?? 'not found on PATH'
  const accessibleName = unavailable
    ? `${source.label}, ${reason}`
    : `${source.label}, drag onto the canvas or press Enter to add it`

  const addAgent = () => window.dispatchEvent(new CustomEvent('loomwatch:add-agent', { detail: JSON.stringify(source) }))

  return (
    <div
      role={unavailable ? 'listitem' : 'button'}
      aria-label={accessibleName}
      aria-disabled={unavailable || undefined}
      title={unavailable ? reason : 'Drag onto the canvas, or click, to add this agent'}
      draggable={!unavailable}
      onDragStart={(event) => {
        if (unavailable) { event.preventDefault(); return }
        event.dataTransfer.setData(LIBRARY_DRAG_MIME, JSON.stringify(source))
        event.dataTransfer.setData('text/plain', source.label)
        event.dataTransfer.effectAllowed = 'copy'
        onDragStateChange?.(true)
      }}
      onDragEnd={() => onDragStateChange?.(false)}
      onClick={() => { if (!unavailable) addAgent() }}
      onKeyDown={(event) => {
        if (!unavailable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); addAgent() }
      }}
      tabIndex={unavailable ? undefined : 0}
      className={cx('lib-row', unavailable && 'unavailable')}
    >
      {source.group === 'presets' ? (
        <span className="monogram res"><EntityGlyph kind="agent" size={11} /></span>
      ) : (
        <span className="monogram">{monogramFor(source.id)}</span>
      )}
      <span className="lib-row-text">
        <span className="lib-row-name t-body-m">{source.label}</span>
        <span className={cx(unavailable ? 'lib-row-sub t-meta' : 'lib-row-sub t-mono-sm')}>{unavailable ? reason : subtitleFor(source)}</span>
        {!unavailable && <span className="lib-row-meta t-meta"><span className="lib-row-compat">{source.kind === 'operator' ? 'pipeline · pauses for your answer' : source.group === 'presets' ? 'preset · role and model filled' : 'detected harness · needs a role and model'}</span></span>}
      </span>
      {!unavailable && <GripVertical className="drag-dots" size={16} aria-hidden="true" />}
    </div>
  )
}
import { GripVertical } from 'lucide-react'

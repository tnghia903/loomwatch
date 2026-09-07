import { Diamond, GripVertical } from 'lucide-react'

import { KNOWN_HARNESSES } from '../../lib/harnesses'
import type { LibrarySource } from '../../lib/library/types'
import { LIBRARY_DRAG_MIME } from './constants'

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function monogramFor(harnessId: string): string {
  return KNOWN_HARNESSES.find((harness) => harness.id === harnessId)?.monogram ?? '·'
}

function subtitleFor(source: LibrarySource): string {
  if (source.group === 'presets') {
    const budget = source.budgetUsd !== undefined ? ` · $${source.budgetUsd.toFixed(2)}` : ''
    return `${source.model ?? ''}${budget}`
  }
  return [source.spawn.cmd, ...source.spawn.args].join(' ')
}

interface LibraryRowProps {
  source: LibrarySource
  /** Not-installed harnesses render disabled: no drag handle, "not found on PATH" (§4.2). */
  disabled?: boolean
}

// Rows are drag sources only (§4.1) — clicking selects/opens nothing.
export function LibraryRow({ source, disabled = false }: LibraryRowProps) {
  const accessibleName = disabled
    ? `${source.label}, not found on PATH`
    : `${source.label}, drag onto the canvas to add it`

  return (
    <div
      role="listitem"
      aria-label={accessibleName}
      title={disabled ? `${source.label} was not found on PATH` : undefined}
      draggable={!disabled}
      onDragStart={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        event.dataTransfer.setData(LIBRARY_DRAG_MIME, JSON.stringify(source))
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className={cx(
        'group flex h-10 items-center gap-2 rounded-md px-2 transition-colors',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-grab hover:bg-iris/6 active:cursor-grabbing',
      )}
    >
      {source.group === 'presets' ? (
        <Diamond className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-hairline/10 font-mono text-[11px] text-ink-2">
          {monogramFor(source.id)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-ink">{source.label}</span>
        <span className="block truncate font-mono text-[12px] text-ink-2">
          {disabled ? 'not found on PATH' : subtitleFor(source)}
        </span>
      </span>
      {!disabled && (
        <GripVertical
          className="size-4 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-60"
          aria-hidden="true"
        />
      )}
    </div>
  )
}

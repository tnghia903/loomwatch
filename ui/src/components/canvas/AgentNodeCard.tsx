import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Check, GitMerge, Lock, X } from 'lucide-react'
import { createElement, useState } from 'react'

import { formatUsd, middleTruncate } from '../../lib/format'
import { monogramForSpawnCmd } from '../../lib/harnesses'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { AgentStatus } from '../../lib/team-file/types'
import { useCanvasActions } from './CanvasActionsContext'
import { roleGlyph } from './roleGlyph'

type EditableField = 'name' | 'role'

// docs/CANVAS_SPEC.md §5.1 anatomy: 264x88, role glyph + name + status indicator, role line,
// a hairline-divided meta row (monogram, model, budget), the 3px left status rail, and the
// entrypoint ring + ENTRY pill. Every node is `idle` in Phase 04 (§5.3), but the table is
// implemented in full so Phase 05 does not have to revisit this component.
export function AgentNodeCard({ id, data, selected }: NodeProps<AgentNode>) {
  const { agent, isEntrypoint } = data
  const { renameAgent, mode, stepById, nodeNames } = useCanvasActions()
  const [editing, setEditing] = useState<EditableField | null>(null)
  const [draft, setDraft] = useState('')
  const step = stepById.get(id)
  const handleClasses =
    mode === 'pipeline' ? '!size-2 !border-iris !bg-iris/40' : '!size-2 !border-hairline !bg-ink-3/25'

  function startEdit(field: EditableField, currentValue: string) {
    setDraft(currentValue)
    setEditing(field)
  }

  function commit(field: EditableField) {
    setEditing(null)
    if (draft !== agent[field]) {
      renameAgent(id, field, draft)
    }
  }

  function inputKeyDown(event: React.KeyboardEvent<HTMLInputElement>, field: EditableField) {
    if (event.key === 'Enter') {
      commit(field)
    } else if (event.key === 'Escape') {
      setEditing(null)
    }
  }

  return (
    <div
      className={`relative flex h-[88px] w-[264px] flex-col rounded-[14px] border bg-surface-solid text-left ${
        selected ? 'shadow-[0_0_0_2px_var(--color-iris)]' : 'border-hairline/10'
      } ${agent.role === '' || agent.model === '' ? 'border-copper' : ''}`}
    >
      <span
        className={`absolute inset-y-0 left-0 w-[3px] rounded-l-[14px] ${statusRailColor(agent.status)}`}
        aria-hidden="true"
      />

      <Handle type="target" position={Position.Left} className={handleClasses} />
      <Handle type="source" position={Position.Right} className={handleClasses} />

      {step && (
        <span className="absolute -left-1.5 -top-1.5 flex items-center gap-0.5">
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-iris font-mono text-[10px] font-semibold text-white">
            {step.step}
          </span>
          {step.joinFrom.length > 0 && (
            <span
              className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-solid text-ink-2 shadow-[0_1px_2px_rgb(0_0_0/.12)]"
              title={`receives replies from ${step.joinFrom.map((joinId) => nodeNames.get(joinId) ?? joinId).join(', ')} in that order`}
            >
              <GitMerge className="size-2.5" aria-hidden="true" />
            </span>
          )}
        </span>
      )}

      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span
          className={`flex size-5 shrink-0 items-center justify-center rounded-full ${
            isEntrypoint ? 'ring-2 ring-iris' : ''
          }`}
        >
          {createElement(roleGlyph(agent.role), {
            className: 'size-4 text-ink-2',
            'aria-hidden': 'true',
          })}
        </span>

        {editing === 'name' ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit('name')}
            onKeyDown={(event) => inputKeyDown(event, 'name')}
            className="min-w-0 flex-1 truncate rounded-sm border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          />
        ) : (
          <span
            onDoubleClick={() => startEdit('name', agent.name)}
            className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink"
          >
            {agent.name}
          </span>
        )}

        {isEntrypoint && (
          <span className="shrink-0 rounded-full bg-iris/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-iris">
            Entry
          </span>
        )}
        <StatusIndicator status={agent.status} />
      </div>

      {editing === 'role' ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit('role')}
          onKeyDown={(event) => inputKeyDown(event, 'role')}
          className="mx-3 mt-0.5 truncate rounded-sm border-none bg-transparent text-[12px] text-ink-2 outline-none"
        />
      ) : (
        <p
          onDoubleClick={() => startEdit('role', agent.role)}
          className={`mx-3 mt-0.5 truncate text-[12px] ${agent.role ? 'text-ink-2' : 'italic text-ink-3'}`}
        >
          {agent.role || 'Add a role'}
        </p>
      )}

      <div className="mt-auto flex items-center gap-1.5 border-t border-hairline/10 px-3 py-1.5 font-mono text-[12px] text-ink-2">
        {agent.allowRecruiting === false && (
          <Lock className="size-3 shrink-0 text-ink-3" aria-hidden="true" aria-label="may not recruit helpers" />
        )}
        <span className="shrink-0 rounded-md bg-hairline/10 px-1 text-ink-2">
          {monogramForSpawnCmd(agent.spawn.cmd)}
        </span>
        <span className="min-w-0 flex-1 truncate">{agent.model ? middleTruncate(agent.model) : '—'}</span>
        <span className="shrink-0">{formatUsd(agent.budget.limitUsd)}</span>
      </div>
    </div>
  )
}

function statusRailColor(status: AgentStatus | undefined): string {
  switch (status) {
    case 'running':
    case 'starting':
      return 'bg-iris'
    case 'waiting':
      return 'bg-copper'
    case 'succeeded':
      return 'bg-green'
    case 'failed':
      return 'bg-red'
    case 'stopped':
      return 'bg-slate'
    default:
      return 'bg-ink-3'
  }
}

// §5.3: shape and colour both encode status so it survives colour-blindness and greyscale.
function StatusIndicator({ status }: { status: AgentStatus | undefined }) {
  const base = 'flex size-3 shrink-0 items-center justify-center'
  switch (status) {
    case 'starting':
      return <span className={`${base} rounded-full border-[1.5px] border-iris border-t-transparent`} aria-label="starting" />
    case 'running':
      return <span className={`${base} rounded-full bg-iris`} aria-label="running" />
    case 'waiting':
      return <span className={`${base} rotate-45 border-[1.5px] border-copper`} aria-label="waiting" />
    case 'succeeded':
      return (
        <span className={`${base} rounded-full bg-green`} aria-label="succeeded">
          <Check className="size-2 text-surface-solid" aria-hidden="true" strokeWidth={3} />
        </span>
      )
    case 'failed':
      return (
        <span className={`${base} rounded-full bg-red`} aria-label="failed">
          <X className="size-2 text-surface-solid" aria-hidden="true" strokeWidth={3} />
        </span>
      )
    case 'stopped':
      return <span className={`${base} bg-slate`} aria-label="stopped" />
    case 'unavailable':
      return <span className={`${base} rounded-full border-[1.5px] border-dashed border-ink-3/40`} aria-label="unavailable" />
    case 'idle':
    default:
      return <span className={`${base} rounded-full border-[1.5px] border-ink-3`} aria-label="idle" />
  }
}

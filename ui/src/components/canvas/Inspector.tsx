import { createElement } from 'react'

import { formatUsd } from '../../lib/format'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { roleGlyph } from './roleGlyph'

// docs/CANVAS_SPEC.md §5.4: the node inspector. Scoped to the fields TNG-55 names —
// name, role, model, cwd, budget — plus the two schema-required toggles the same section
// specifies (entrypoint, allowRecruiting) so those already-built mutators aren't left dead.
// Spawn args/env editing and presets are out of scope here (§15.3 has no backend for presets).
export interface InspectorProps {
  node: AgentNode
  isEntrypoint: boolean
  onRename: (field: 'name' | 'role', value: string) => void
  onModelChange: (value: string) => void
  onCwdChange: (value: string) => void
  onBudgetChange: (limitUsd: number) => void
  onAllowRecruitingChange: (allow: boolean) => void
  onPromoteEntrypoint: () => void
  onDelete: () => void
  onClose: () => void
}

export function Inspector({
  node,
  isEntrypoint,
  onRename,
  onModelChange,
  onCwdChange,
  onBudgetChange,
  onAllowRecruitingChange,
  onPromoteEntrypoint,
  onDelete,
  onClose,
}: InspectorProps) {
  const { agent } = node.data

  return (
    <div
      role="region"
      aria-label="Inspector"
      className="pointer-events-auto flex w-80 max-h-[calc(100vh-32px)] flex-col gap-4 overflow-y-auto rounded-lg border border-hairline/10 bg-surface/72 p-4 shadow-[0_1px_2px_rgb(0_0_0/.04),0_8px_24px_rgb(0_0_0/.08)] backdrop-blur-xl"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {createElement(roleGlyph(agent.role), {
            className: 'size-5 shrink-0 text-ink-2',
            'aria-hidden': 'true',
          })}
          <div className="min-w-0">
            <input
              value={agent.name}
              onChange={(event) => onRename('name', event.target.value)}
              aria-label="Name"
              className="w-full truncate rounded-sm border-none bg-transparent text-[20px] font-semibold leading-7 text-ink outline-none"
            />
            <p className="truncate font-mono text-[12px] text-ink-2">{agent.id}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-ink-3 hover:bg-hairline/10 hover:text-ink"
        >
          ×
        </button>
      </div>

      <div className="h-px bg-hairline/10" />

      <Field label="Role">
        <input
          value={agent.role}
          onChange={(event) => onRename('role', event.target.value)}
          placeholder="Add a role"
          className="h-9 w-full rounded-sm border border-hairline/10 bg-surface-solid px-2 text-[14px] text-ink outline-none focus:border-iris"
        />
        {agent.role === '' && <p className="mt-1 text-[12px] text-copper">Required</p>}
      </Field>

      <Field label="Model">
        <input
          value={agent.model}
          onChange={(event) => onModelChange(event.target.value)}
          placeholder="e.g. claude-opus-5"
          className="h-9 w-full rounded-sm border border-hairline/10 bg-surface-solid px-2 font-mono text-[12px] text-ink outline-none focus:border-iris"
        />
        {agent.model === '' && <p className="mt-1 text-[12px] text-copper">Required</p>}
      </Field>

      <Field label="Cwd">
        <input
          value={agent.spawn.cwd}
          onChange={(event) => onCwdChange(event.target.value)}
          className="h-9 w-full rounded-sm border border-hairline/10 bg-surface-solid px-2 font-mono text-[12px] text-ink outline-none focus:border-iris"
        />
        <p className="mt-1 text-[12px] text-ink-3">Relative to the team file</p>
      </Field>

      <Field label="Budget">
        <div className="flex items-center gap-2">
          <span className="text-ink-2">$</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={agent.budget.limitUsd}
            onChange={(event) => onBudgetChange(Number(event.target.value))}
            aria-label="Budget limit in USD"
            className="h-9 w-full rounded-sm border border-hairline/10 bg-surface-solid px-2 font-mono text-[12px] text-ink outline-none focus:border-iris"
          />
        </div>
        <p className="mt-1 font-mono text-[12px] text-ink-3">{formatUsd(agent.budget.limitUsd)} limit</p>
      </Field>

      <div className="h-px bg-hairline/10" />

      <label className="flex items-center gap-2 text-[13px] text-ink" title={isEntrypoint ? 'Every team starts somewhere. Check another agent to move the entry point.' : undefined}>
        <input
          type="checkbox"
          checked={isEntrypoint}
          disabled={isEntrypoint}
          onChange={() => onPromoteEntrypoint()}
          className="size-4 accent-[var(--color-iris)]"
        />
        Entrypoint
      </label>

      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={agent.allowRecruiting !== false}
          onChange={(event) => onAllowRecruitingChange(event.target.checked)}
          className="size-4 accent-[var(--color-iris)]"
        />
        May recruit helpers
      </label>

      <div className="h-px bg-hairline/10" />

      <button
        type="button"
        onClick={onDelete}
        className="self-start text-[13px] text-ink-2 hover:text-red"
      >
        Delete node
      </button>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</p>
      {children}
    </div>
  )
}

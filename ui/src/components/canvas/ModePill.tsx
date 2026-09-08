import { Asterisk, GitMerge, TriangleAlert, Workflow } from 'lucide-react'
import { useState } from 'react'

import type { PipelineStep } from '../../lib/team-file/pipelineOrder'
import type { BudgetConfig, GuardsConfig } from '../../lib/team-file/types'
import type { ExecutionMode, PendingEdgeRemoval } from '../../lib/team-file/useTeamDocument'

export interface ModePillProps {
  mode: ExecutionMode
  pipelineSteps: PipelineStep[]
  nodeNames: ReadonlyMap<string, string>
  entrypointName: string | null
  teamGuards: GuardsConfig | null
  teamBudget: BudgetConfig | null
  onUpdateGuards: (field: keyof GuardsConfig, value: number) => void
  onUpdateBudget: (limitUsd: number) => void
  switchBanner: boolean
  pendingRemoval: PendingEdgeRemoval | null
  onKeepRemoval: () => void
  onUndoRemoval: () => void
}

// docs/CANVAS_SPEC.md §8: "a consequence of the file, not a setting" — this never renders a
// toggle, only what the current `edges` shape already means.
export function ModePill({
  mode,
  pipelineSteps,
  nodeNames,
  entrypointName,
  teamGuards,
  teamBudget,
  onUpdateGuards,
  onUpdateBudget,
  switchBanner,
  pendingRemoval,
  onKeepRemoval,
  onUndoRemoval,
}: ModePillProps) {
  const [open, setOpen] = useState(false)

  if (pendingRemoval) {
    return (
      <div
        role="alert"
        className="pointer-events-auto flex items-center gap-3 rounded-full border border-copper bg-surface-solid px-4 py-2 text-[13px] text-ink shadow-[0_2px_4px_rgb(0_0_0/.06),0_16px_40px_rgb(0_0_0/.14)]"
      >
        <TriangleAlert className="size-4 shrink-0 text-copper" aria-hidden="true" />
        <span>Removing the last edge returns this team to self-organizing.</span>
        <button
          type="button"
          onClick={onUndoRemoval}
          className="shrink-0 rounded-full bg-iris/10 px-2.5 py-1 text-[12px] font-medium text-iris hover:bg-iris/20"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={onKeepRemoval}
          className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-hairline/10"
        >
          Keep it
        </button>
      </div>
    )
  }

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-2">
      {open && (
        <div className="w-80 rounded-lg border border-hairline/10 bg-surface-solid p-4 text-[13px] text-ink shadow-[0_2px_4px_rgb(0_0_0/.06),0_16px_40px_rgb(0_0_0/.14)]">
          {mode === 'team' ? (
            <TeamModeDetails
              entrypointName={entrypointName}
              guards={teamGuards}
              budget={teamBudget}
              onUpdateGuards={onUpdateGuards}
              onUpdateBudget={onUpdateBudget}
            />
          ) : (
            <PipelineModeDetails steps={pipelineSteps} nodeNames={nodeNames} />
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 items-center gap-2 rounded-full border border-hairline/10 bg-surface-solid px-4 text-[13px] shadow-[0_1px_2px_rgb(0_0_0/.04),0_8px_24px_rgb(0_0_0/.08)]"
      >
        {mode === 'team' ? (
          <>
            <Asterisk className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
            <span className="text-ink-2">Team · self-organizing</span>
          </>
        ) : (
          <>
            <Workflow className="size-4 shrink-0 text-iris" aria-hidden="true" />
            <span className="text-ink">Pipeline · {pipelineSteps.length} steps</span>
          </>
        )}
      </button>

      {switchBanner && (
        <p className="rounded-md bg-surface-solid/90 px-2 py-1 text-[12px] text-ink-2">
          Drawn edges now sequence this team. <code className="font-mono">dispatch</code> and{' '}
          <code className="font-mono">handoff</code> are withdrawn.
        </p>
      )}
    </div>
  )
}

function TeamModeDetails({
  entrypointName,
  guards,
  budget,
  onUpdateGuards,
  onUpdateBudget,
}: {
  entrypointName: string | null
  guards: GuardsConfig | null
  budget: BudgetConfig | null
  onUpdateGuards: (field: keyof GuardsConfig, value: number) => void
  onUpdateBudget: (limitUsd: number) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <p>
        <code className="font-mono">edges</code> is empty, so{' '}
        {entrypointName ? <span className="font-medium">{entrypointName}</span> : 'the entrypoint'} receives the
        goal and decides who else to involve. All six Team Bus tools are available.
      </p>
      <div className="h-px bg-hairline/10" />
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Guards</p>
      <div className="flex items-center gap-3">
        <GuardField
          label="Max dispatch depth"
          value={guards?.maxDispatchDepth ?? 8}
          onChange={(value) => onUpdateGuards('maxDispatchDepth', value)}
        />
        <GuardField
          label="Max concurrent dispatches"
          value={guards?.maxConcurrentDispatches ?? 8}
          onChange={(value) => onUpdateGuards('maxConcurrentDispatches', value)}
        />
      </div>
      <div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          Team budget
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-ink-2">$</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={budget?.limitUsd ?? ''}
            placeholder="No limit"
            onChange={(event) => onUpdateBudget(Number(event.target.value))}
            aria-label="Team budget limit in USD"
            className="h-8 w-28 rounded-sm border border-hairline/10 bg-canvas px-2 font-mono text-[12px] text-ink outline-none focus:border-iris"
          />
        </div>
      </div>
    </div>
  )
}

function GuardField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[11px] text-ink-3">{label}</span>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-8 rounded-sm border border-hairline/10 bg-canvas px-2 font-mono text-[12px] text-ink outline-none focus:border-iris"
      />
    </label>
  )
}

function PipelineModeDetails({
  steps,
  nodeNames,
}: {
  steps: PipelineStep[]
  nodeNames: ReadonlyMap<string, string>
}) {
  return (
    <div className="flex flex-col gap-3">
      <p>
        {steps.length} step{steps.length === 1 ? '' : 's'} run in the order you drew.{' '}
        <code className="font-mono">dispatch</code> and <code className="font-mono">handoff</code> are withdrawn;
        the backend sequences the run.
      </p>
      <div className="h-px bg-hairline/10" />
      <ol className="flex flex-col gap-1.5">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-iris/10 font-mono text-[11px] text-iris">
              {step.step}
            </span>
            <span className="min-w-0 flex-1 truncate">{nodeNames.get(step.id) ?? step.id}</span>
            {step.joinFrom.length > 0 && (
              <span
                className="flex shrink-0 items-center gap-1 text-ink-3"
                title={`receives replies from ${step.joinFrom.map((id) => nodeNames.get(id) ?? id).join(', ')} in that order`}
              >
                <GitMerge className="size-3.5" aria-hidden="true" />
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

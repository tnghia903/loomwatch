import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { useHeldState } from '../../../lib/widgets/useHeldState'
import { WidgetCalculator } from './WidgetCalculator'
import { WidgetChecklist } from './WidgetChecklist'
import { WidgetChoices } from './WidgetChoices'
import { WidgetSteps } from './WidgetSteps'

export interface AnswerWidgetsProps {
  widgets: readonly KeptWidget[]
  /** Keep what you made of widget `n`: answers with it as kept. */
  onChange: (n: number, state: WidgetState) => Promise<KeptWidget>
  /** Tap a choice: it goes as your message, replying to the answer. Absent: choices can't be
      tapped now, because this isn't the newest answer or something is at work. */
  onChoose?: (label: string) => Promise<boolean> | void
  /** The choice already sent, read from the message that replied with it. */
  chosen?: string | null
}

/**
 * The widgets under an answer (ADR 0114): choices to tap, a checklist to tick, a calculator
 * LoomWatch works out, steps to tap through. What you tick or change is kept, and the next work's
 * conversation says so. The answer's words stay above them, as they are.
 */
export function AnswerWidgets({ widgets, onChange, onChoose, chosen = null }: AnswerWidgetsProps) {
  return (
    <div className="wg-list">
      {widgets.map((kept) => {
        switch (kept.spec.kind) {
          case 'choices': return <WidgetChoices key={kept.n} spec={kept.spec} onChoose={onChoose} chosen={chosen} />
          case 'checklist': return <HeldChecklist key={kept.n} kept={kept} onChange={onChange} />
          case 'calculator': return <HeldCalculator key={kept.n} kept={kept} onChange={onChange} />
          case 'steps': return <WidgetSteps key={kept.n} spec={kept.spec} />
        }
        return null
      })}
    </div>
  )
}

function HeldChecklist({ kept, onChange }: { kept: KeptWidget; onChange: AnswerWidgetsProps['onChange'] }) {
  const held = useHeldState(kept, onChange)
  if (kept.spec.kind !== 'checklist') return null
  return <WidgetChecklist spec={kept.spec} state={held.state} onToggle={(checked) => held.keep({ checked })} error={held.error} />
}

function HeldCalculator({ kept, onChange }: { kept: KeptWidget; onChange: AnswerWidgetsProps['onChange'] }) {
  const held = useHeldState(kept, onChange)
  if (kept.spec.kind !== 'calculator') return null
  return <WidgetCalculator spec={kept.spec} state={held.state} onShow={held.show} onKeep={held.keep} error={held.error} />
}

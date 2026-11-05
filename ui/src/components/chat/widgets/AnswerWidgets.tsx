import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { useHeldState } from '../../../lib/widgets/useHeldState'
import { WidgetCalculator } from './WidgetCalculator'
import { WidgetChart } from './WidgetChart'
import { WidgetChecklist } from './WidgetChecklist'
import { WidgetChoices } from './WidgetChoices'
import { WidgetFlow } from './WidgetFlow'
import { WidgetGraph } from './WidgetGraph'
import { WidgetMarks } from './WidgetMarks'
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
  /** The answer is still being written: the widgets are drawn as they will be, and work once it is
      done. */
  live?: boolean
}

/**
 * Widgets at the end of an answer (ADR 0114): those its words didn't place, or every one in an
 * answer drawn before place lines. The answer's words stay above them, as they are.
 */
export function AnswerWidgets(props: AnswerWidgetsProps) {
  return (
    <div className="wg-list">
      {props.widgets.map((kept) => <AnswerWidget key={kept.n} kept={kept} {...props} />)}
    </div>
  )
}

/**
 * One widget in an answer (ADR 0114): choices to tap, a checklist to tick, a calculator LoomWatch
 * works out, steps to tap through, or a chart, a graph, a row of marks or a flow to look at. What you tick or
 * change is kept, and the next work's conversation says so.
 */
export function AnswerWidget({ kept, onChange, onChoose, chosen = null, live = false }: Omit<AnswerWidgetsProps, 'widgets'> & { kept: KeptWidget }) {
  switch (kept.spec.kind) {
    case 'choices': return <WidgetChoices spec={kept.spec} onChoose={live ? undefined : onChoose} chosen={chosen} />
    case 'checklist': return <HeldChecklist kept={kept} onChange={onChange} live={live} />
    case 'calculator': return <HeldCalculator kept={kept} onChange={onChange} live={live} />
    case 'steps': return <WidgetSteps spec={kept.spec} />
    case 'marks': return <WidgetMarks spec={kept.spec} />
    case 'flow': return <WidgetFlow spec={kept.spec} />
    case 'chart': return <WidgetChart spec={kept.spec} />
    case 'graph': return <WidgetGraph spec={kept.spec} />
  }
  return null
}

function HeldChecklist({ kept, onChange, live }: { kept: KeptWidget; onChange: AnswerWidgetsProps['onChange']; live: boolean }) {
  const held = useHeldState(kept, onChange)
  if (kept.spec.kind !== 'checklist') return null
  return <WidgetChecklist spec={kept.spec} state={held.state} onToggle={(checked) => held.keep({ checked })} error={held.error} disabled={live} />
}

function HeldCalculator({ kept, onChange, live }: { kept: KeptWidget; onChange: AnswerWidgetsProps['onChange']; live: boolean }) {
  const held = useHeldState(kept, onChange)
  if (kept.spec.kind !== 'calculator') return null
  return <WidgetCalculator spec={kept.spec} state={held.state} onShow={held.show} onKeep={held.keep} error={held.error} disabled={live} />
}

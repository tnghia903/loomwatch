import { Component, type ReactNode } from 'react'

import { useAppear } from '../../../lib/chat/appear'
import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { useFirstSight } from '../../../lib/widgets/useFirstSight'
import { useHeldState } from '../../../lib/widgets/useHeldState'
import { WidgetCalculator } from './WidgetCalculator'
import { WidgetChart } from './WidgetChart'
import { WidgetChecklist } from './WidgetChecklist'
import { WidgetChoices } from './WidgetChoices'
import { WidgetCompare } from './WidgetCompare'
import { WidgetFinder } from './WidgetFinder'
import { WidgetFlow } from './WidgetFlow'
import { WidgetGraph } from './WidgetGraph'
import { WidgetMarks } from './WidgetMarks'
import { WidgetPicture } from './WidgetPicture'
import { WidgetQuiz } from './WidgetQuiz'
import { WidgetScale } from './WidgetScale'
import { WidgetSkill } from './WidgetSkill'
import { WidgetSteps } from './WidgetSteps'
import { WidgetTimeline } from './WidgetTimeline'

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
  /** Who answered, as the chat names them: a skill they suggest says so once saved. */
  by?: string
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
 * works out, a finder whose questions lead you to the outcome for your case, a quiz that checks
 * what the answer explained, steps to tap through, a picture the agent drew whose parts you step
 * through, or a comparison, a chart, a graph, a scale, a timeline, a row of marks or a flow to look
 * at. What you tick, answer or change is kept, and the next work's conversation says so. When it
 * arrives as news (ADR 0051) and this window hasn't drawn it before, its marks grow in once
 * (`wg-fresh`); history and a widget drawn again are simply there.
 */
export function AnswerWidget(props: Omit<AnswerWidgetsProps, 'widgets'> & { kept: KeptWidget }) {
  const news = useAppear()
  const drawing = JSON.stringify(props.kept.spec)
  const first = useFirstSight(drawing)
  const fresh = news && first
  return (
    <div className={`wg-shell${fresh ? ' wg-fresh' : ''}`}>
      <WidgetGuard drawing={drawing} title={props.kept.spec.title}>{drawn(props, fresh)}</WidgetGuard>
    </div>
  )
}

interface GuardState { broken: boolean; drawing: string }

/**
 * A widget the app can't draw says so in its place, under its title, and the rest of the screen
 * goes on: an agent's widget is its own data, and one drawn wrongly must never take the chat with
 * it. A widget that changes (the kept one taking the place of the one drawn while the answer was
 * written) is tried again.
 */
class WidgetGuard extends Component<{ drawing: string; title: unknown; children: ReactNode }, GuardState> {
  state: GuardState = { broken: false, drawing: this.props.drawing }

  static getDerivedStateFromProps(props: { drawing: string }, state: GuardState): Partial<GuardState> | null {
    return props.drawing === state.drawing ? null : { broken: false, drawing: props.drawing }
  }

  static getDerivedStateFromError(): Partial<GuardState> {
    return { broken: true }
  }

  componentDidCatch(error: Error) {
    console.error('LoomWatch could not draw a widget', error)
  }

  render() {
    if (!this.state.broken) return this.props.children
    const title = typeof this.props.title === 'string' && this.props.title.trim() ? this.props.title : null
    return (
      <section className="wg" aria-label={title ?? 'Part of this answer'}>
        {title && <p className="wg-title">{title}</p>}
        <p className="wg-unshown">{title ? 'LoomWatch couldn’t show this.' : 'LoomWatch couldn’t show part of this answer.'}</p>
      </section>
    )
  }
}

function drawn({ kept, onChange, onChoose, chosen = null, live = false, by }: Omit<AnswerWidgetsProps, 'widgets'> & { kept: KeptWidget }, fresh: boolean) {
  switch (kept.spec.kind) {
    case 'choices': return <WidgetChoices spec={kept.spec} onChoose={live ? undefined : onChoose} chosen={chosen} live={live} />
    case 'checklist': return <HeldChecklist kept={kept} onChange={onChange} live={live} />
    case 'calculator': return <HeldCalculator kept={kept} onChange={onChange} live={live} />
    case 'steps': return <WidgetSteps spec={kept.spec} />
    case 'marks': return <WidgetMarks spec={kept.spec} />
    case 'flow': return <WidgetFlow spec={kept.spec} />
    case 'compare': return <WidgetCompare spec={kept.spec} />
    case 'chart': return <WidgetChart spec={kept.spec} />
    case 'graph': return <WidgetGraph spec={kept.spec} />
    case 'picture': return <WidgetPicture spec={kept.spec} fresh={fresh} />
    case 'finder': return <HeldFinder kept={kept} onChange={onChange} live={live} />
    case 'quiz': return <HeldQuiz kept={kept} onChange={onChange} live={live} />
    case 'scale': return <WidgetScale spec={kept.spec} />
    case 'timeline': return <WidgetTimeline spec={kept.spec} />
    case 'skill': return <WidgetSkill kept={kept} onChange={onChange} live={live} by={by} />
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

function HeldFinder({ kept, onChange, live }: { kept: KeptWidget; onChange: AnswerWidgetsProps['onChange']; live: boolean }) {
  const held = useHeldState(kept, onChange)
  if (kept.spec.kind !== 'finder') return null
  return <WidgetFinder spec={kept.spec} state={held.state} onAnswer={(answers) => held.keep({ answers })} error={held.error} disabled={live} />
}

function HeldQuiz({ kept, onChange, live }: { kept: KeptWidget; onChange: AnswerWidgetsProps['onChange']; live: boolean }) {
  const held = useHeldState(kept, onChange)
  if (kept.spec.kind !== 'quiz') return null
  return <WidgetQuiz spec={kept.spec} state={held.state} onPick={(picked) => held.keep({ picked })} error={held.error} disabled={live} />
}

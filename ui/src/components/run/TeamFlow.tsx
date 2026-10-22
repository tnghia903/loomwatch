import { Fragment, type ReactNode } from 'react'
import { ArrowRight, Check, FileText, Sparkles } from 'lucide-react'

import type { WorkPhase } from '../../lib/library/figure'
import type { CardActivity, UseKind } from '../../lib/watch/cardActivity'
import { hadSkill } from '../../lib/runs/capabilityEvidence'
import { AgentPortrait } from '../agents/AvatarFace'
import { StatusGlyph } from '../ui/glyphs'
import type { MarkState } from '../../lib/story/mark'
import { StageFigure, StageNow, StageTray, type FigureGlow, type SkillSummary } from './StageActivity'

/**
 * The team at work, as option A of the trace sketches drew it: your request, each agent's card and
 * the team's answer in one row, joined by the lines the work moves along. Over a card floats what
 * its agent is at; on it, its figure acting that out, its model and state, the tray of what it
 * used and, while it types, its last words; under it, its skills, which light up as it opens them.
 * A send-back leaves a dashed arc under the line it went back along. The lists the tray opens sit
 * under the row (DeliveryLane), so a card never grows past the others.
 */
export interface FlowStage {
  id: string
  name: string
  /** "Claude Opus 5.5", or "Your review step" for a person. */
  model: string
  /** Its state in words beside the glow, so the glow never says it alone. */
  status: string
  statusClass: string
  glow: FigureGlow
  phase: WorkPhase | null
  markState: MarkState
  events: number
  operator: boolean
  working: boolean
  selected: boolean
  activity: CardActivity
  skills: SkillSummary
  /** Skills it opened in the last moment, by name, so their cards light up as it does. */
  opening: ReadonlySet<string>
  /** The work just passed on into this stage, or was just sent back from it. */
  pass: { id: string; way: 'on' | 'back' } | null
  /** It sent the work back to the stage before at some point in this run. */
  sentBack: boolean
  /** The mark whose list is open under the row, when it is this stage's. */
  open: UseKind | null
  extra: ReactNode
}

export interface TeamFlowProps {
  /** There is a request to start from. */
  asked: boolean
  stages: readonly FlowStage[]
  /** The stages run in a line, each handing on to the next: draw the lines between them. */
  relay: boolean
  /** The team has answered. */
  answered: boolean
  answerPass: boolean
  planned: boolean
  finished: boolean
  animate: boolean
  onSelect: (id: string) => void
  onOpen: (id: string, kind: UseKind | null) => void
  onOpenSkill: (id: string, skill: string) => void
}

/** A line the work moves along, and the sheet on it while it passes. */
function FlowLink({ line, pass, passing, sentBack }: { line: boolean; pass: FlowStage['pass']; passing: boolean; sentBack: boolean }) {
  return (
    <span className={`flow-link${line ? '' : ' no-line'}${passing ? ' passing' : ''}`} data-pass={pass?.way} aria-hidden="true">
      {line && <i className="flow-line" />}
      {sentBack && <i className="flow-back" />}
      {pass && <i key={pass.id} className="handoff-sheet" />}
    </span>
  )
}

export function TeamFlow({ asked, stages, relay, answered, answerPass, planned, finished, animate, onSelect, onOpen, onOpenSkill }: TeamFlowProps) {
  return (
    <div className="team-flow" data-tour="stages">
      <div className="flow-row" role="list" aria-label="Team stages">
        <div className="flow-node flow-end" role="listitem">
          {/* What was asked and what came back are read in the chat beside this record (ADR 0051):
              the ends of the row say where the work starts and ends, not the words again. */}
          <article className="flow-card flow-request">
            <span className="flow-micro">Your request</span>
            <strong className="flow-text">{asked ? 'From you' : 'Not asked yet'}</strong>
          </article>
        </div>
        {stages.map((stage, index) => (
          <Fragment key={stage.id}>
            <div className="flow-node" role="listitem">
              <FlowLink line={relay || index === 0} pass={stage.pass} passing={stage.working} sentBack={stage.sentBack} />
              <div className="flow-column">
                <div className="flow-above"><StageNow activity={stage.activity} /></div>
                <article id={`delivery-stage-${stage.id}`} className={`flow-card flow-agent${stage.working ? ' working' : ''}${stage.selected ? ' selected' : ''}`} data-tour="stage">
                  <button type="button" className="flow-who" aria-pressed={stage.selected} onClick={() => onSelect(stage.id)}>
                    {/* The figure and how it is doing share a row, so the model and the name get the card's full width under them. */}
                    <span className="flow-top">
                      <StageFigure phase={stage.phase} glow={stage.glow}>
                        <AgentPortrait id={stage.id} name={stage.name} size={46} operator={stage.operator} state={stage.markState} events={stage.events} animate={animate} />
                      </StageFigure>
                      {/* Stopped with a problem wears the failed mark, so its red is a shape, not words. */}
                      <span className={`delivery-status ${stage.statusClass}`}>{stage.statusClass === 'status-failed' && <StatusGlyph status="failed" size={10} />}{stage.status}</span>
                    </span>
                    <span className="flow-micro">{stage.model}</span>
                    <strong>{stage.name}</strong>
                  </button>
                  <StageTray activity={stage.activity} skills={stage.skills} planned={planned} finished={finished} open={stage.open} onOpen={(kind) => onOpen(stage.id, kind)} />
                  {stage.activity.said && <p className="flow-said">{stage.activity.said}<span className="caret" aria-hidden="true" /></p>}
                  {stage.extra}
                </article>
                {stage.skills.skills.length > 0 && (
                  <div className="flow-skills">
                    {stage.skills.skills.map((skill) => {
                      const had = hadSkill(skill)
                      return (
                        <button key={skill.id} type="button" className={`flow-skill${stage.opening.has(skill.name) ? ' opening' : ''}${had ? ' had' : ''}`} aria-label={`Skill ${skill.name}${had ? ', opened' : ''}`} onClick={() => onOpenSkill(stage.id, skill.id)}>
                          <span className="flow-micro">Skill</span>
                          <strong>{skill.name}</strong>
                          {had ? <Check className="flow-skill-tick" size={13} aria-hidden="true" /> : <Sparkles className="flow-skill-tick" size={13} aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </Fragment>
        ))}
        <div className="flow-node flow-end" role="listitem">
          <FlowLink line={relay} pass={answerPass ? { id: 'answer', way: 'on' } : null} passing={false} sentBack={false} />
          <article className={`flow-card flow-answer${answered ? ' done' : ''}`}>
            <span className="flow-micro">The team’s answer</span>
            {answered ? <strong className="flow-text">In the chat</strong> : <p className="flow-text flow-muted">Appears when the team is done.</p>}
            {answered && <FileText className="flow-answer-mark" size={14} aria-hidden="true" />}
          </article>
        </div>
      </div>
    </div>
  )
}

/** The way from a stage card to what it was handed, or to its agent's settings: small, at its foot. */
export function FlowLinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="delivery-link flow-card-link" onClick={onClick}>{children} <ArrowRight size={13} /></button>
}

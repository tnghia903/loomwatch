import { Fragment, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight } from '../ui/icon'

import { modelNameFromId } from '../../lib/ai/modelIds'
import { replyLine } from '../../lib/library/desk'
import type { FigureMood, WorkPhase } from '../../lib/library/figure'
import { draftFromTeamAgent, readsOf } from '../../lib/library/teamDraft'
import type { MarkState } from '../../lib/story/mark'
import type { AgentConfig } from '../../lib/team-file/types'
import type { CardActivity, UseKind } from '../../lib/watch/cardActivity'
import type { Talk } from '../../lib/watch/talk'
import { AgentPortrait } from '../agents/AvatarFace'
import { AgentFigure } from '../agents/benchFigure'
import { useAgentFigure } from '../agents/figureContext'
import { FigureStill } from '../agents/FigureStill'
import type { BenchHelper, BenchView } from '../agents/workbenchScene'
import { StatusGlyph } from '../ui/glyphs'
import { StageFigure, StageNow, StageTray, type FigureGlow, type SkillSummary } from './StageActivity'

/**
 * The team at work, as the office sketches drew it (owner, 2026-11-13): one tile per agent, the
 * agent at its own workbench (the builder's bench, to look at, as the island's box shows it), what
 * it is at in a bubble over its head, and its card under it: its name, model and state, who handed
 * it its work, and the tray of what it used. The tiles wrap, so a team of two or of nine needs no
 * sideways scrolling.
 *
 * Who is talking to whom is the spotlight, while the run is watched: the agents in a talk stay lit
 * and the rest dim, and one card above them says it in a sentence with their faces. What they said
 * stays in the team's chat beside the record (ADR 0051), where the card opens it.
 */
export interface BenchStage {
  id: string
  name: string
  /** "Claude Opus 5.5", or "Your review step" for a person. */
  model: string
  agent: AgentConfig
  /** Its state in words beside the glow, so the glow never says it alone. */
  status: string
  statusClass: string
  glow: FigureGlow
  /** What its figure acts out at its bench. */
  mood: FigureMood
  phase: WorkPhase | null
  markState: MarkState
  events: number
  operator: boolean
  working: boolean
  selected: boolean
  /** Someone else is talking, and this stage is neither in the talk nor at work. */
  dim: boolean
  activity: CardActivity
  /** Helpers it brought in (ADR 0079), at its own bench. */
  helpers: readonly BenchHelper[]
  skills: SkillSummary
  /** The mark whose list is open under the tiles, when it is this stage's. */
  open: UseKind | null
  /** Who handed it its work ("you", "Researcher"); `null` before it has any. What they handed it is
      in the chat and opens from here (ADR 0051): the record doesn't say it again. */
  handed: { from: string; title?: string } | null
  /** What it waits for before it starts ("Starts after Writer"); `null` once it has. */
  waits: string | null
  /** Opens what it was handed (its "What it received"); absent when there is nothing to open. */
  onReceived?: () => void
  extra: ReactNode
}

export interface TeamBenchesProps {
  stages: readonly BenchStage[]
  /** Who is talking to whom now; drawn only while the run is watched (`live`). */
  talks: readonly Talk[]
  live: boolean
  planned: boolean
  finished: boolean
  animate: boolean
  onSelect: (id: string) => void
  onOpen: (id: string, kind: UseKind | null) => void
  /** Reads a talk's message in the team's chat. Absent, a talk card is words only. */
  onReadMessage?: (messageId: string) => void
}

const NO_LABELS: [] = []
const NOTHING = () => {}
/**
 * How many tiles draw their bench in 3D; the rest show their figure. A browser keeps only so many
 * 3D views on a page (Chromium, 16) and drops the oldest unannounced, and the agent's own page or
 * the island may be drawing one too.
 */
export const MAX_BENCHES = 8

export function TeamBenches({ stages, talks, live, planned, finished, animate, onSelect, onOpen, onReadMessage }: TeamBenchesProps) {
  const names = useMemo(() => new Map(stages.map((stage) => [stage.id, stage.name])), [stages])
  const operators = useMemo(() => new Set(stages.filter((stage) => stage.operator).map((stage) => stage.id)), [stages])
  return (
    <div className="team-benches" data-tour="stages">
      {/* The band the talk cards stand in is there for the whole of a live run, talk or not, so the
          tiles under it never jump as a card comes and goes. */}
      {live && stages.length > 1 && <TalkBand talks={talks} names={names} operators={operators} onRead={onReadMessage} />}
      <ul className="bench-grid" aria-label="Team stages">
        {stages.map((stage, index) => (
          <li key={stage.id} className="bench-cell">
            <StageTile stage={stage} drawn={index < MAX_BENCHES} planned={planned} finished={finished} animate={animate} onSelect={onSelect} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function StageTile({ stage, drawn, planned, finished, animate, onSelect, onOpen }: { stage: BenchStage; drawn: boolean; planned: boolean; finished: boolean; animate: boolean; onSelect: (id: string) => void; onOpen: (id: string, kind: UseKind | null) => void }) {
  const doing = stage.activity.doing ? <StageNow activity={stage.activity} /> : null
  // While it types, its last words; while it thinks, its bench's own thought bubble says what about.
  const said = !doing && stage.activity.said ? <p className="stage-said">{stage.activity.said}<span className="caret" aria-hidden="true" /></p> : null
  return (
    <article id={`delivery-stage-${stage.id}`} className={`stage-tile${stage.working ? ' working' : ''}${stage.selected ? ' selected' : ''}${stage.dim ? ' dim' : ''}`} data-tour="stage">
      <div className="stage-scene">
        {stage.operator
          ? <div className="stage-you"><StageFigure phase={null} glow={stage.glow}><AgentPortrait id={stage.id} name={stage.name} size={88} operator state={stage.markState} events={stage.events} animate={animate} /></StageFigure></div>
          : <StageBench stage={stage} drawn={drawn} />}
        {(doing || said) && <div className="stage-says">{doing ?? said}</div>}
      </div>
      <div className="stage-card">
        <button type="button" className="stage-who" aria-pressed={stage.selected} onClick={() => onSelect(stage.id)}>
          <span className="stage-who-top">
            <strong>{stage.name}</strong>
            {/* Stopped with a problem wears the failed mark, so its red is a shape, not words. */}
            <span className={`delivery-status ${stage.statusClass}`}>{stage.statusClass === 'status-failed' && <StatusGlyph status="failed" size={10} />}{stage.status}</span>
          </span>
          <span className="flow-micro">{stage.model}</span>
        </button>
        {stage.handed
          ? stage.onReceived
            ? <button type="button" className="stage-handed" title={stage.handed.title ?? `What ${stage.name} was given`} onClick={stage.onReceived}>Work from <b>{stage.handed.from}</b><ArrowRight size={12} aria-hidden="true" /></button>
            : <p className="stage-handed" title={stage.handed.title}>Work from <b>{stage.handed.from}</b></p>
          : stage.waits && <p className="stage-handed waits">{stage.waits}</p>}
        <StageTray activity={stage.activity} skills={stage.skills} planned={planned} finished={finished} open={stage.open} onOpen={(kind) => onOpen(stage.id, kind)} />
        {stage.extra}
      </div>
    </article>
  )
}

/**
 * The agent at its own workbench, to look at: what the builder draws, without its labels, acting
 * out what its stage is at. Its figure stands in while the bench comes, where it can't be drawn,
 * and past the benches a page can draw (`drawn`).
 */
function StageBench({ stage, drawn }: { stage: BenchStage; drawn: boolean }) {
  const figure = useAgentFigure(stage.agent)
  const draft = useMemo(() => draftFromTeamAgent(stage.agent), [stage.agent])
  const reads = useMemo(() => readsOf(stage.agent), [stage.agent])
  const tools = useMemo(() => draft.tools.map((name) => ({ name, icon: null })), [draft.tools])
  const [failed, setFailed] = useState(false)
  const view = useMemo<BenchView>(() => ({
    look: { name: draft.name, instructions: draft.instructions, app: draft.model, model: `${draft.model}|${draft.effort}`, skills: draft.skills, allow: draft.allow },
    figure,
    does: draft.does,
    appName: draft.model ? modelNameFromId(draft.model) : '',
    hasReply: Boolean(replyLine(draft.instructions)),
    mood: stage.mood,
    events: stage.events,
    phase: stage.phase ?? undefined,
    thought: stage.phase === 'thinking' ? stage.activity.thought : null,
    asked: null,
    open: null,
    dropping: false,
    reads,
    tools,
    helpers: stage.helpers,
  }), [draft, figure, stage.mood, stage.events, stage.phase, stage.activity.thought, reads, tools, stage.helpers])
  const still = <div className="stage-bench-still"><FigureStill figure={figure} alt="" /></div>
  if (failed || !drawn) return still
  return (
    <Suspense fallback={still}>
      <AgentFigure view={view} labels={NO_LABELS} open={null} onPart={NOTHING} onKey={NOTHING} onSkillDrop={NOTHING} skillMime="" onFail={() => setFailed(true)} readOnly who={stage.id} />
    </Suspense>
  )
}

/**
 * The spotlight's cards: who is talking to whom, each in a sentence with their faces, and a bracket
 * from each card down to the tiles it is about.
 */
function TalkBand({ talks, names, operators, onRead }: { talks: readonly Talk[]; names: ReadonlyMap<string, string>; operators: ReadonlySet<string>; onRead?: (messageId: string) => void }) {
  const band = useRef<HTMLDivElement>(null)
  const [brackets, setBrackets] = useState<{ key: string; d: string; tips: string[]; tone: Talk['tone'] }[]>([])
  // The run view passes the newest talk; should more come, the band has room for three at most.
  const shown = useMemo(() => talks.slice(-3), [talks])
  // A talk that comes back (a question still waiting, once a newer talk has passed) is the same talk,
  // not a new one: it doesn't arrive again.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const last = useRef<readonly string[]>([])
  useLayoutEffect(() => {
    const now = shown.map((talk) => talk.key)
    const left = last.current.filter((key) => !now.includes(key) && !gone.has(key))
    last.current = now
    if (left.length) setGone((before) => new Set([...before, ...left]))
  }, [shown, gone])
  useLayoutEffect(() => {
    const box = band.current
    if (!box) return
    const draw = () => {
      const base = box.getBoundingClientRect()
      const bottom = base.height
      // Only tiles in the first row are under the band; one further down is lit, not pointed at.
      const tiles = [...(box.parentElement?.querySelectorAll<HTMLElement>('.stage-tile') ?? [])]
      const top = Math.min(...tiles.map((tile) => tile.getBoundingClientRect().top))
      const at = (id: string) => {
        const tile = tiles.find((candidate) => candidate.id === `delivery-stage-${id}`)
        const rect = tile?.getBoundingClientRect()
        return rect && Math.abs(rect.top - top) < 2 ? rect.left - base.left + rect.width / 2 : null
      }
      setBrackets(shown.flatMap((talk) => {
        const card = box.querySelector<HTMLElement>(`[data-talk="${talk.key}"]`)?.getBoundingClientRect()
        if (!card || !card.width) return []
        const ends = [...talk.from, ...talk.to].map(at).filter((x): x is number => x !== null)
        if (!ends.length) return []
        const cardX = card.left - base.left + card.width / 2
        const cardY = card.bottom - base.top
        const y = cardY + (bottom - cardY) * 0.5
        const left = Math.min(cardX, ...ends), right = Math.max(cardX, ...ends)
        const d = `M ${cardX} ${cardY} V ${y} M ${left} ${y} H ${right}${ends.map((x) => ` M ${x} ${y} V ${bottom - 1}`).join('')}`
        const tips = talk.to.map(at).filter((x): x is number => x !== null).map((x) => `M ${x - 4.5} ${bottom - 7} L ${x} ${bottom} L ${x + 4.5} ${bottom - 7} Z`)
        return [{ key: talk.key, d, tips, tone: talk.tone }]
      }))
    }
    draw()
    if (typeof ResizeObserver === 'undefined') return
    const resize = new ResizeObserver(draw)
    resize.observe(box)
    return () => resize.disconnect()
  }, [shown])
  // The review step is you: "you", in the middle of a sentence as anywhere else.
  const face = (ids: readonly string[]) => ids.map((id, index) => (
    <Fragment key={id}>
      {index > 0 && <span className="talk-and">{index === ids.length - 1 ? ' and ' : ', '}</span>}
      <span className="talk-name"><AgentPortrait id={id} name={names.get(id)} size={24} operator={operators.has(id)} />{operators.has(id) ? 'you' : names.get(id) ?? id}</span>
    </Fragment>
  ))
  return (
    <div ref={band} className="talk-band" aria-live="polite">
      <div className="talk-cards">
        {shown.map((talk) => {
          // "’s work" sits on the name before it; " back" is a word of its own.
          const tail = talk.tail && <span className={`talk-verb${talk.tail.startsWith('’') ? ' talk-tail' : ''}`}>{talk.tail.trim()}</span>
          const body = (
            <span className="talk-who">
              {face(talk.from)}<span className="talk-verb">{talk.verb}</span>{face(talk.to)}{tail}
              {/* Only what the sentence doesn't say already: how it went. Couldn't finish wears the failed mark. */}
              {talk.word && <span className={`talk-word tone-${talk.tone}`}>{talk.tone === 'failed' && <StatusGlyph status="failed" size={10} />}{talk.word}</span>}
            </span>
          )
          const className = `talk-card tone-${talk.tone}${gone.has(talk.key) ? ' again' : ''}`
          // "Read the message", as the timeline names the same way to the same message.
          return onRead
            ? <button key={talk.key} type="button" className={className} data-talk={talk.key} title="Read the message" onClick={() => onRead(talk.messageId)}>{body}</button>
            : <div key={talk.key} className={className} data-talk={talk.key}>{body}</div>
        })}
      </div>
      <svg className="talk-bracket" aria-hidden="true">
        {brackets.map((bracket) => (
          <g key={bracket.key} className={`tone-${bracket.tone}`}>
            <path className="talk-line" d={bracket.d} />
            {bracket.tips.map((tip) => <path key={tip} className="talk-tip" d={tip} />)}
          </g>
        ))}
      </svg>
    </div>
  )
}

/** The way from a stage's card to its agent's settings: small, at its foot. */
export function CardLinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="delivery-link flow-card-link" onClick={onClick}>{children} <ArrowRight size={13} /></button>
}

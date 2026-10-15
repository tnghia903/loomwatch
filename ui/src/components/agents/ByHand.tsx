import { lazy, Suspense, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { KeyRound, Plus, Puzzle, Search, X } from 'lucide-react'

import { isHarnessRunnable, type DetectedHarness, type HarnessModels } from '../../lib/harnesses'
import type { DetectedCapability } from '../../lib/library/client'
import type { AgentDraft } from '../../lib/library/draft'
import { replyLine } from '../../lib/library/desk'
import { askedKey, CARD_SLOTS, FIGURE_KEYS, figureMood, type FigurePart } from '../../lib/library/figure'
import { COLOR_HEX, COLOR_NAMES, FIGURE_COLORS, FIGURE_KINDS, FIGURE_NAMES, figureStill, type FigureChoice } from '../../lib/library/figures'
import type { RunRecord } from '../../lib/runs/client'
import { markPattern } from '../../lib/story/mark'
import { useNow } from '../../lib/useNow'
import { actsWithoutAsking, ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { appendToRole, instructionShape, PART_STARTERS } from '../../lib/team-file/checkup'
import type { AllowSwitch } from '../../lib/team-file/types'
import { InstructionShape } from '../canvas/InstructionShape'
import type { BenchLabel } from './AgentFigure'
import type { BenchView } from './workbenchScene'

const AgentFigure = lazy(() => import('./AgentFigure'))

/**
 * BUILD BY HAND: every setting of the agent as a block of plain words and controls, always open,
 * beside the agent as a figure at a workbench (lib/library/figure.ts says what each thing on the
 * bench stands for). It is the one way to build an agent in Your agents.
 *
 * The blocks are the way in: each says what its setting does, in words, so nobody needs to learn
 * the bench first. The bench is the picture of the same settings: the laptop is the app, the
 * nameplate the name, the clipboard the job, the cards on the pegboard the skills, the keys on the
 * hooks what it may do without asking (the ones in your dish ask you first), and the tray what it
 * hands back. Clicking anything on the bench takes you to its block, and working in a block lights
 * its thing on the bench. While you try it on the test bench, the figure works as the run record says.
 */

const SKILL_MIME = 'application/x-loomwatch-skill'

export interface ByHandProps {
  draft: AgentDraft
  set: <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => void
  harness: DetectedHarness | null
  harnesses: DetectedHarness[]
  harnessesLoading: boolean
  models: HarnessModels | null
  /** Why the app's models could not be listed, if they could not. */
  modelsError?: string | null
  modelName?: string
  skills: readonly DetectedCapability[]
  skillsLoading: boolean
  roleField: RefObject<HTMLTextAreaElement | null>
  /** The id its woven mark is made from, so its scarf is the swatch it wears everywhere. */
  markId: string
  /** The figure it wears (lib/library/figures.ts). */
  figure: FigureChoice
  /** Choose another figure: only in Your agents, where the figure is kept. */
  onFigure?: (figure: FigureChoice) => void
  /** The test bench's run, if one is on screen: the figure works as its record says. */
  record: RunRecord | null
  /** A team's own agent has no palette line ("what it does"): that belongs to Your agents. */
  hideDoes?: boolean
  /** Changes can't be kept here (a team you can't edit): every control shows, none applies. */
  readOnly?: boolean
}

/** Each block: its title, and where it is on the bench. In the order you would set an agent up. */
const BLOCKS: readonly { part: FigurePart; title: string; where: string }[] = [
  { part: 'name', title: 'Name', where: 'the nameplate' },
  { part: 'job', title: 'Instructions', where: 'the clipboard' },
  { part: 'app', title: 'App', where: 'the laptop' },
  { part: 'mind', title: 'Model', where: 'the figure' },
  { part: 'skills', title: 'Skills', where: 'the recipe cards' },
  { part: 'keys', title: 'What it may do without asking', where: 'the keys, and your dish' },
  { part: 'reply', title: 'What it hands back', where: 'the tray' },
]

export function ByHand({ draft, set: write, harness, harnesses, harnessesLoading, models, modelsError = null, modelName, skills, skillsLoading, roleField, markId, figure, onFigure, record, hideDoes = false, readOnly = false }: ByHandProps) {
  const set: ByHandProps['set'] = (key, value) => { if (!readOnly) write(key, value) }
  // The block you are working in: its thing on the bench is lit.
  const [focus, setFocus] = useState<FigurePart | null>(null)
  const [flash, setFlash] = useState<{ part: FigurePart; at: number } | null>(null)
  const [dragging, setDragging] = useState<'skill' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const blocks = useRef(new Map<FigurePart, HTMLElement>())
  const ids = useId()
  const wild = harness ? actsWithoutAsking({ spawn: { cmd: harness.spawn.cmd, args: harness.spawn.args, env: {}, cwd: '.' } }) : null
  const shape = instructionShape(draft.instructions)
  const reply = replyLine(draft.instructions)
  const mood = useFigureMood(record)
  const pattern = useMemo(() => markPattern(markId).over, [markId])
  const given = FIGURE_KEYS.filter(({ key }) => draft.allow[key])
  const kept = FIGURE_KEYS.filter(({ key }) => !draft.allow[key])
  const giveKey = (key: AllowSwitch, on: boolean) => set('allow', { ...draft.allow, [key]: on })
  const addSkill = (name: string) => { if (!draft.skills.includes(name)) set('skills', [...draft.skills, name]) }
  const model = modelName || draft.model || 'the app’s current model'
  // How hard it thinks: one of the efforts its model lists, or the app's default for it.
  const thinkingModel = models?.models.find((item) => item.id === (draft.model || models.currentModelId)) ?? null
  const efforts = thinkingModel?.thinkingEfforts ?? []
  const effortId = draft.effort || models?.currentThinkingEffort || ''
  const effortIndex = Math.max(0, efforts.findIndex((item) => item.id === effortId))
  const effort = efforts.length ? efforts[effortIndex] : null
  const thinks = effort ? `${model} · ${effort.name.toLowerCase()} effort` : model
  const events = record?.eventCount ?? 0
  const asked = askedKey(record)

  const view = useMemo<BenchView>(() => ({
    look: { name: draft.name, instructions: draft.instructions, app: draft.appId ?? '', model: `${draft.model}|${draft.effort}`, skills: draft.skills, allow: draft.allow },
    figure,
    pattern,
    does: draft.does,
    appName: harness?.name ?? '',
    hasReply: Boolean(replyLine(draft.instructions)),
    mood,
    events,
    asked,
    open: focus,
    dropping: dragging === 'skill',
  }), [draft, figure, pattern, harness, mood, events, asked, focus, dragging])

  /** From the bench: go to the block for what was picked, and start working in it. */
  const goTo = (part: FigurePart) => {
    const block = blocks.current.get(part)
    setFocus(part)
    setFlash((current) => ({ part, at: (current?.at ?? 0) + 1 }))
    if (!block) return
    block.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
    block.querySelector<HTMLElement>('textarea, input, select, button')?.focus({ preventScroll: true })
  }

  const name = draft.name.trim() || 'New agent'
  const more = draft.skills.length > CARD_SLOTS ? ` (${draft.skills.length - CARD_SLOTS} not pinned)` : ''
  const keysText = wild ? 'Every door is open' : given.length ? `Keys it has · ${given.map((item) => item.word).join(', ')}` : 'Keys it has · none'
  const asking = asked && !draft.allow[asked] ? FIGURE_KEYS.find(({ key }) => key === asked)?.word : null
  const dishText = asking ? `It’s asking you for the ${asking} key` : wild ? `${wild} doesn’t ask before it acts` : kept.length ? `You keep: ${kept.map((item) => item.word).join(', ')} · it asks you first` : 'You keep no keys'
  const parts = (['job', 'method', 'reply'] as const).filter((part) => shape[part]).length
  // What each setting adds up to, in words: the line under each block's title.
  const says: Record<FigurePart, string> = {
    name: hideDoes || !draft.does.trim() ? name : `${name} · ${draft.does.trim()}`,
    job: draft.instructions.trim() ? `Says ${parts} of the 3 things good instructions say: its job, how to work, and what it replies with` : 'Nothing written yet',
    app: harness ? `Works in ${harness.name}, on this computer, signed in as you` : 'No app chosen yet',
    mind: `Thinks with ${thinks}`,
    skills: draft.skills.length ? `${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'} it opens when the work calls for one` : 'No skills yet',
    keys: wild ? `${wild} doesn’t ask before it acts, so every door is open` : given.length ? `Goes ahead with ${given.map((item) => item.word.toLowerCase()).join(' and ')}${kept.length ? `; asks you first for ${kept.map((item) => item.word.toLowerCase()).join(' and ')}` : ''}` : 'Asks you before it searches the web, changes files or runs a command',
    reply: reply ?? 'Its instructions don’t say yet',
  }
  const labels: BenchLabel[] = [
    { anchor: 'mind', part: 'mind', place: 'right', text: <>Thinks with <b>{model}</b>{effort && <> · {effort.name.toLowerCase()}</>}</>, short: <b>{model}</b>, label: `The figure, the model it thinks with: ${thinks}` },
    { anchor: 'job', part: 'job', place: 'above', text: <>The job <span className="byhand-parts">{(['job', 'method', 'reply'] as const).map((part) => <i key={part} className={shape[part] ? 'on' : ''} />)}</span></>, short: 'Job', label: 'The job on the clipboard: its instructions' },
    { anchor: 'skills', part: 'skills', place: 'above', text: `Skills · ${draft.skills.length || 'none yet'}${more}`, short: `Skills · ${draft.skills.length}`, label: `The recipe cards: ${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'}` },
    { anchor: 'keys', part: 'keys', place: 'above', text: keysText, short: `Keys · ${wild ? 'all' : given.length}`, label: `The key hooks: ${keysText}` },
    { anchor: 'dish', part: 'keys', place: 'below', text: dishText, short: asking ? `Asking for ${asking}` : `You keep ${wild ? 0 : kept.length}`, label: `Your dish: ${dishText}` },
    { anchor: 'reply', part: 'reply', place: 'above', text: `Hands back · ${reply ? 'see the tray' : 'not said yet'}`, short: 'Hands back', label: 'The tray: what it hands back' },
    { anchor: 'name', part: 'name', place: 'plate', label: `The nameplate: ${name}` },
    { anchor: 'app', part: 'app', place: 'plate', label: `The laptop, the app it works in: ${harness?.name ?? 'none chosen'}` },
  ]

  const block = (part: FigurePart, body: ReactNode, extra?: ReactNode) => {
    const meta = BLOCKS.find((item) => item.part === part)!
    const flashing = flash?.part === part
    return (
      <section
        key={part}
        ref={(element) => { if (element) blocks.current.set(part, element); else blocks.current.delete(part) }}
        className={`byhand-block${focus === part ? ' focus' : ''}`}
        aria-labelledby={`${ids}-${part}`}
        onFocus={() => setFocus(part)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus((current) => (current === part ? null : current)) }}
        onPointerEnter={() => setFocus((current) => current ?? part)}
        onPointerLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setFocus((current) => (current === part ? null : current)) }}
      >
        {flashing && <span key={flash.at} className="byhand-block-flash" aria-hidden="true" onAnimationEnd={() => setFlash(null)} />}
        <header className="byhand-block-head">
          <h3 id={`${ids}-${part}`}>{meta.title}</h3>
          <span className="byhand-block-where">{meta.where}</span>
        </header>
        <p className="byhand-block-says">{says[part]}</p>
        {body}
        {extra}
      </section>
    )
  }

  return (
    <div className="byhand">
      <p className="byhand-say" aria-live="polite">{sentence(draft, harness, model, wild)}</p>
      <div className="byhand-main">
        <div className="byhand-stage">
          {failed
            ? <div className="bench-fallback"><p className="t-meta">The bench can’t be drawn in this browser ({failed}). Every setting is in the blocks.</p></div>
            : <Suspense fallback={<div className="bench-stage"><p className="bench-loading t-meta">Setting up the bench…</p></div>}>
                <AgentFigure
                  view={view}
                  labels={labels}
                  open={focus}
                  onPart={goTo}
                  onKey={(key, on) => { giveKey(key, on); setFocus('keys') }}
                  onSkillDrop={(skill) => { setDragging(null); addSkill(skill); setFocus('skills') }}
                  skillMime={SKILL_MIME}
                  onFail={setFailed}
                />
              </Suspense>}
          {onFigure && <FigurePicker figure={figure} onChange={(next) => { if (!readOnly) onFigure(next) }} />}
        </div>

        <div className="byhand-blocks" data-tour="agent-blocks">
          {block('name', <div className="agent-field-row">
            <label className="agent-field">Name<input value={draft.name} maxLength={80} onChange={(event) => set('name', event.target.value)} placeholder="e.g. Release notes writer" /></label>
            {!hideDoes && <label className="agent-field"><span>What it does <span className="optional">optional</span></span><input value={draft.does} maxLength={120} onChange={(event) => set('does', event.target.value)} placeholder="Shown under its name" /></label>}
          </div>)}

          {block('job', <>
            <textarea ref={roleField} className="agent-instructions" rows={8} value={draft.instructions} onChange={(event) => set('instructions', event.target.value)} placeholder="What this agent does, how it works, and what it replies with." aria-label="Instructions" />
            <InstructionShape role={draft.instructions} field={roleField} onChange={(role) => set('instructions', role)} />
          </>)}

          {block('app', <>
            <label className="agent-field">AI app
              <select value={draft.appId ?? ''} onChange={(event) => { set('appId', event.target.value || null); set('model', ''); set('effort', '') }}>
                <option value="" disabled>{harnessesLoading ? 'Looking for apps…' : 'Choose an app'}</option>
                {harnesses.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={!isHarnessRunnable(candidate)}>{candidate.name}{isHarnessRunnable(candidate) ? '' : ' (not ready)'}</option>)}
              </select>
            </label>
            {!harnessesLoading && !harnesses.some(isHarnessRunnable) && <p className="t-meta">No AI app is ready on this computer yet. Set one up from Home first.</p>}
            <p className="t-meta">The app runs the model, holds the keys and opens the skills. Changing it puts the model and its effort back to the app’s own.</p>
          </>)}

          {block('mind', <>
            <label className="agent-field">Model
              <select value={draft.model} disabled={!draft.appId} onChange={(event) => {
                // An effort belongs to one model: keep it only if the new model offers it too.
                const next = models?.models.find((item) => item.id === (event.target.value || models.currentModelId))
                if (draft.effort && !next?.thinkingEfforts.some((item) => item.id === draft.effort)) set('effort', '')
                set('model', event.target.value)
              }}>
                <option value="">{models?.currentModelId ? `The app’s current model (${models.models.find((item) => item.id === models.currentModelId)?.name ?? models.currentModelId})` : 'The app’s current model'}</option>
                {(models?.models ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <div className="thinking-field agent-field">
              <span className="thinking-label"><label htmlFor={`${ids}-thinking`}>Thinking effort</label><output htmlFor={`${ids}-thinking`}>{effort?.name ?? 'App default'}</output></span>
              <input
                id={`${ids}-thinking`}
                className="thinking-slider"
                type="range"
                min={0}
                max={Math.max(0, efforts.length - 1)}
                step={1}
                value={effortIndex}
                disabled={!draft.appId || efforts.length === 0}
                aria-label="Thinking effort"
                aria-valuetext={effort?.name ?? 'App default'}
                onChange={(event) => {
                  const picked = efforts[Number(event.target.value)]
                  if (!picked) return
                  // An effort is saved with the model it belongs to, so the app's current model is pinned.
                  if (!draft.model && thinkingModel) set('model', thinkingModel.id)
                  set('effort', picked.id)
                }}
              />
              {efforts.length > 1 && <span className="thinking-scale t-micro"><span>{efforts[0].name}</span><span>{efforts[efforts.length - 1].name}</span></span>}
              <span className="t-meta">{effort?.description ?? (!draft.appId ? 'Choose its app first.' : efforts.length === 0 ? (models ? 'This model has no separate effort setting.' : 'Loading effort choices…') : 'How much it reasons before it answers.')}</span>
            </div>
            {modelsError && <p className="t-meta agent-save-error">Couldn’t list this app’s models: {modelsError}</p>}
            <p className="t-meta">{harness ? <>The models {harness.name} offers. </> : <>Choose its app first. </>}A bigger model can think more through, and costs more of your plan per run.</p>
          </>)}

          {block('skills', <SkillShelf chosen={draft.skills} available={skills} loading={skillsLoading} onAdd={addSkill} onRemove={(skill) => set('skills', draft.skills.filter((item) => item !== skill))} onDrag={setDragging} />)}

          {block('keys', <ul className="byhand-keys">
            {FIGURE_KEYS.map(({ key, word }) => {
              const on = draft.allow[key] === true
              const info = ALLOW_SWITCHES.find((item) => item.key === key)!
              return (
                <li key={key} className={on ? 'on' : ''}>
                  <KeyRound size={15} aria-hidden="true" />
                  <span><b>{word}</b> · {info.label.toLowerCase()}<em>{wild ? `${wild} doesn’t ask, so it does this either way.` : on ? info.on : 'It asks you first. On a schedule nobody is there to answer, so it is declined.'}</em></span>
                  <button type="button" className={`btn${on ? '' : ' btn-primary'}`} onClick={() => giveKey(key, !on)}>{on ? 'Take it back' : 'Hand it over'}</button>
                </li>
              )
            })}
          </ul>)}

          {block('reply', <>
            {reply && <blockquote className="byhand-reply">{reply}</blockquote>}
            <button type="button" className="btn" onClick={() => { if (!shape.reply) set('instructions', appendToRole(draft.instructions, PART_STARTERS.reply)); goTo('job'); window.setTimeout(() => { const field = roleField.current; if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length) } }, 0) }}>{reply ? 'Change it in the instructions' : 'Say what it replies with'}</button>
          </>)}
        </div>
      </div>
    </div>
  )
}

/**
 * Its figure: which of the crew it is, and in what colour, so you can tell your agents apart at a
 * glance in Your agents. Teams never copy it, so changing it never makes a new version.
 */
function FigurePicker({ figure, onChange }: { figure: FigureChoice; onChange: (figure: FigureChoice) => void }) {
  const name = useId()
  return (
    <fieldset className="figure-picker">
      <legend>Its figure <span className="t-meta">how you tell it apart in Your agents</span></legend>
      <div className="figure-picker-kinds">
        {FIGURE_KINDS.map((kind) => (
          <label key={kind} className="figure-picker-kind" title={FIGURE_NAMES[kind]}>
            <input type="radio" className="visually-hidden" name={`${name}-kind`} checked={figure.kind === kind} onChange={() => onChange({ ...figure, kind })} />
            <img src={figureStill({ kind, color: figure.color })} alt="" width={56} height={56} loading="lazy" decoding="async" />
            <span>{FIGURE_NAMES[kind]}</span>
          </label>
        ))}
      </div>
      <div className="figure-picker-colors">
        {FIGURE_COLORS.map((color) => (
          <label key={color} className="figure-picker-color" title={COLOR_NAMES[color]}>
            <input type="radio" className="visually-hidden" name={`${name}-color`} checked={figure.color === color} onChange={() => onChange({ ...figure, color })} />
            <span style={{ background: COLOR_HEX[color] }} aria-hidden="true" />
            <span className="visually-hidden">{COLOR_NAMES[color]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** The figure's mood, from the run record, on the shared clock while the run is live, to tell working from quiet. */
function useFigureMood(record: RunRecord | null) {
  const now = useNow(record?.status === 'running')
  const [moved, setMoved] = useState<{ run: string; events: number; at: number } | null>(null)
  const run = record?.runId ?? null
  const events = record?.eventCount ?? 0
  // When the record moves, note when (adjusting state while rendering, not in an effect).
  if (run && (moved?.run !== run || moved.events !== events)) setMoved({ run, events, at: now })
  return figureMood(record, moved && moved.run === run ? moved.at : null, now)
}

function SkillShelf({ chosen, available, loading, onAdd, onRemove, onDrag }: { chosen: readonly string[]; available: readonly DetectedCapability[]; loading: boolean; onAdd: (name: string) => void; onRemove: (name: string) => void; onDrag: (kind: 'skill' | null) => void }) {
  const [query, setQuery] = useState('')
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const seen = new Set<string>()
    return available.filter((skill) => !chosen.includes(skill.name) && (!needle || `${skill.name} ${skill.detail}`.toLowerCase().includes(needle))).filter((skill) => (seen.has(skill.name) ? false : (seen.add(skill.name), true))).slice(0, 12)
  }, [available, chosen, query])
  return (
    <div className="byhand-shelf">
      {chosen.length > 0
        ? <ul className="skill-picker-chosen" aria-label="Recipe cards on its pegboard">{chosen.map((name) => <li key={name}><Puzzle size={12} aria-hidden="true" />{name}<button type="button" className="iconbtn" aria-label={`Take ${name} down`} onClick={() => onRemove(name)}><X size={12} aria-hidden="true" /></button></li>)}</ul>
        : <p className="t-meta">None yet. A skill is a recipe card: instructions it opens when the work calls for it. Press + on one below, or drag it onto the bench.</p>}
      <label className="skill-picker-find"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={loading ? 'Looking for recipe cards on this computer…' : `Find a recipe card (${available.length} on this computer)`} aria-label="Find a skill" /></label>
      <ul className="byhand-cards" aria-label="Recipe cards you can add">
        {found.map((skill) => (
          <li key={skill.id} draggable onDragStart={(event) => { event.dataTransfer.setData(SKILL_MIME, skill.name); event.dataTransfer.effectAllowed = 'copy'; onDrag('skill') }} onDragEnd={() => onDrag(null)} title="Drag it onto the bench">
            <span className="byhand-card-tab" aria-hidden="true" />
            <b>{skill.name}</b>
            <span>{skill.detail || skill.source}</span>
            <button type="button" className="iconbtn" aria-label={`Pin ${skill.name} up`} onClick={() => onAdd(skill.name)}><Plus size={13} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The bench in one sentence, for anyone who reads rather than looks, and for screen readers. */
function sentence(draft: AgentDraft, harness: DetectedHarness | null, model: string, wild: string | null): ReactNode {
  const name = draft.name.trim() || 'This agent'
  const has = FIGURE_KEYS.filter(({ key }) => draft.allow[key]).map(({ word }) => word.toLowerCase())
  const keys = wild ? `${wild} doesn’t ask before it acts, so every door is open.` : has.length ? `It has the ${has.join(' and ')} key${has.length === 1 ? '' : 's'}; for anything else it asks you first.` : 'It has no keys, so it asks you before it searches the web, changes files or runs a command.'
  const skills = draft.skills.length ? `${draft.skills.length} recipe card${draft.skills.length === 1 ? '' : 's'}` : 'no recipe cards yet'
  return <><b>{name}</b> thinks with {model}, works {harness ? `in ${harness.name}` : 'in no app yet'}, and has {skills}. {keys}</>
}

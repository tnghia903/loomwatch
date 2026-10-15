import { useMemo, useState, type DragEvent, type ReactNode, type RefObject } from 'react'
import { KeyRound, Plus, Puzzle, Search, X } from 'lucide-react'

import type { DetectedHarness, HarnessModels } from '../../lib/harnesses'
import type { DetectedCapability } from '../../lib/library/client'
import type { AgentDraft } from '../../lib/library/draft'
import { ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { actsWithoutAsking } from '../../lib/team-file/allow'
import { appendToRole, instructionShape, PART_STARTERS } from '../../lib/team-file/checkup'
import type { AllowSwitch } from '../../lib/team-file/types'
import { InstructionShape } from '../canvas/InstructionShape'
import { replyLine } from '../../lib/library/desk'
import { BYHAND } from './byhandAnchors'

/**
 * BUILD BY HAND: the agent as a desk you equip, for someone who has never set an agent up.
 *
 * Every object on the desk is one part of the agent and the control for it: the clipboard holds
 * its job, the nameplate its name, the lamp the app and model it thinks with, the recipe box its
 * skills, the keys what it may do without asking (a key on the rack: it goes ahead; a key in the
 * dish: it knocks and asks you), and the outbox what it hands back. Each object always carries
 * its label, so there is no legend, and each shows the real setting. The pictures are Blender
 * renders, stacked: the desk, then the recipe box with as many cards as it has skills, then each
 * key where it is (byhand.py).
 */

type Box = [number, number, number, number]
const A: Record<string, Box> = BYHAND.anchors
const SIZE = BYHAND.size
const src = (layer: string) => `/byhand/${layer}.webp`
const KEYS: readonly { key: AllowSwitch; file: string; word: string }[] = [
  { key: 'web', file: 'web', word: 'Web' },
  { key: 'edits', file: 'files', word: 'Files' },
  { key: 'commands', file: 'cmd', word: 'Commands' },
]
const LAYERS = ['box0', 'box1', 'box2', 'box3', ...KEYS.flatMap(({ file }) => [`key_${file}_rack`, `key_${file}_dish`])]
const at = (box: Box, pad = 0.008) => ({ left: `${(box[0] - pad) * 100}%`, top: `${(box[1] - pad) * 100}%`, width: `${(box[2] - box[0] + pad * 2) * 100}%`, height: `${(box[3] - box[1] + pad * 2) * 100}%` })
const above = (box: Box) => ({ left: `${((box[0] + box[2]) / 2) * 100}%`, top: `${box[1] * 100}%` })
const below = (box: Box) => ({ left: `${((box[0] + box[2]) / 2) * 100}%`, top: `${box[3] * 100}%` })

export type DeskPart = 'job' | 'name' | 'lamp' | 'skills' | 'keys' | 'reply'
const KEY_MIME = 'application/x-loomwatch-key'
const SKILL_MIME = 'application/x-loomwatch-skill'

export interface ByHandProps {
  draft: AgentDraft
  set: <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => void
  harness: DetectedHarness | null
  harnesses: DetectedHarness[]
  harnessesLoading: boolean
  models: HarnessModels | null
  modelName?: string
  skills: readonly DetectedCapability[]
  skillsLoading: boolean
  roleField: RefObject<HTMLTextAreaElement | null>
}

export function ByHand({ draft, set, harness, harnesses, harnessesLoading, models, modelName, skills, skillsLoading, roleField }: ByHandProps) {
  const [open, setOpen] = useState<DeskPart | null>('job')
  const [dragging, setDragging] = useState<'key' | 'skill' | null>(null)
  const wild = harness ? actsWithoutAsking({ spawn: { cmd: harness.spawn.cmd, args: harness.spawn.args, env: {}, cwd: '.' } }) : null
  const shape = instructionShape(draft.instructions)
  const reply = replyLine(draft.instructions)
  const cards = Math.min(3, draft.skills.length)
  const given = KEYS.filter(({ key }) => draft.allow[key])
  const kept = KEYS.filter(({ key }) => !draft.allow[key])
  const giveKey = (key: AllowSwitch, on: boolean) => set('allow', { ...draft.allow, [key]: on })
  const addSkill = (name: string) => { if (!draft.skills.includes(name)) set('skills', [...draft.skills, name]) }
  const toggle = (part: DeskPart) => setOpen((current) => (current === part ? null : part))

  const drop = (target: 'rack' | 'dish' | 'box') => ({
    onDragOver: (event: DragEvent) => {
      const types = event.dataTransfer.types
      if ((target === 'box' && types.includes(SKILL_MIME)) || (target !== 'box' && types.includes(KEY_MIME))) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      setDragging(null)
      if (target === 'box') { const name = event.dataTransfer.getData(SKILL_MIME); if (name) { addSkill(name); setOpen('skills') } return }
      const key = event.dataTransfer.getData(KEY_MIME) as AllowSwitch
      if (key) { giveKey(key, target === 'rack'); setOpen('keys') }
    },
  })

  const appLine = harness ? `${harness.name} · ${modelName || draft.model || 'its current model'}` : 'No app chosen'
  return (
    <div className="byhand">
      <p className="byhand-say" aria-live="polite">{sentence(draft, harness, wild)}</p>
      <div className={`byhand-stage${dragging ? ` dragging-${dragging}` : ''}`} style={{ aspectRatio: `${SIZE[0]} / ${SIZE[1]}` }}>
        <img src={src('desk')} alt="" draggable={false} />
        {LAYERS.map((layer) => {
          const shown = layer === `box${cards}` || KEYS.some(({ key, file }) => layer === `key_${file}_${draft.allow[key] ? 'rack' : 'dish'}`)
          return <img key={layer} src={src(layer)} alt="" draggable={false} hidden={!shown} />
        })}

        {/* What each object is, always in words. */}
        <span className="byhand-tag" style={above(A.clipboard)}>The job <span className="byhand-parts">{(['job', 'method', 'reply'] as const).map((part) => <i key={part} className={shape[part] ? 'on' : ''} />)}</span></span>
        <span className="byhand-tag" style={above(A.lamp)}>Thinks with {appLine}</span>
        <span className="byhand-tag" style={above(A.box0)}>Skills · {draft.skills.length || 'none yet'}</span>
        <span className="byhand-tag" style={above(A.rack)}>Keys it has · {wild ? 'every door is open' : given.length ? given.map((item) => item.word).join(', ') : 'none'}</span>
        <span className="byhand-tag quiet" style={below(A.dish)}>{wild ? `${wild} doesn’t ask before it acts` : kept.length ? `You keep: ${kept.map((item) => item.word).join(', ')} · it asks you first` : 'You keep no keys'}</span>
        <span className="byhand-tag" style={above(A.outbox)}>Hands back · {reply ? 'see the outbox' : 'not said yet'}</span>
        <span className="byhand-plate" style={at(A.plate, 0)}><b>{draft.name.trim() || 'New agent'}</b>{draft.does.trim() && <em>{draft.does.trim()}</em>}</span>

        {/* Each object is the control for its part. */}
        <Spot part="job" box={A.clipboard} open={open} label="The job card: its instructions" onClick={toggle} />
        <Spot part="name" box={A.nameplate} open={open} label={`The nameplate: ${draft.name.trim() || 'no name yet'}`} onClick={toggle} />
        <Spot part="lamp" box={A.lamp} open={open} label={`The lamp: ${appLine}`} onClick={toggle} />
        <Spot part="skills" box={A.box0} open={open} zone="box" label={`The recipe box: ${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'}`} onClick={toggle} extra={drop('box')} />
        <Spot part="reply" box={A.outbox} open={open} label="The outbox: what it hands back" onClick={toggle} />
        <Spot part="keys" box={A.rack} open={open} zone="rack" label="The key rack: keys it has" onClick={toggle} extra={drop('rack')} />
        <Spot part="keys" box={A.dish} open={open} zone="dish" label="The dish: keys you keep" onClick={toggle} extra={drop('dish')} />
        {KEYS.map(({ key, file, word }) => {
          const on = draft.allow[key] === true
          return (
            <button
              key={key}
              type="button"
              className="byhand-key"
              style={at(A[`key_${file}_${on ? 'rack' : 'dish'}`], 0.002)}
              draggable
              aria-label={`${word} key: ${on ? 'it has it, so it goes ahead without asking' : 'you keep it, so it asks you first'}. Click to ${on ? 'take it back' : 'hand it over'}.`}
              title={`${word} key · ${on ? 'it has it' : 'you keep it'} · drag it, or click`}
              onDragStart={(event) => { event.dataTransfer.setData(KEY_MIME, key); event.dataTransfer.effectAllowed = 'move'; setDragging('key') }}
              onDragEnd={() => setDragging(null)}
              onClick={() => { giveKey(key, !on); setOpen('keys') }}
            />
          )
        })}
      </div>

      {open && (
        <div className="byhand-drawer" role="region" aria-label={DRAWER_TITLE[open]}>
          <div className="byhand-drawer-head"><b>{DRAWER_TITLE[open]}</b><button type="button" className="iconbtn" aria-label="Close" onClick={() => setOpen(null)}><X size={14} aria-hidden="true" /></button></div>
          {open === 'job' && <>
            <textarea ref={roleField} className="agent-instructions" rows={8} value={draft.instructions} onChange={(event) => set('instructions', event.target.value)} placeholder="What this agent does, how it works, and what it replies with." />
            <InstructionShape role={draft.instructions} field={roleField} onChange={(role) => set('instructions', role)} />
          </>}
          {open === 'name' && <div className="agent-field-row">
            <label className="agent-field">Name<input value={draft.name} maxLength={80} onChange={(event) => set('name', event.target.value)} placeholder="e.g. Release notes writer" /></label>
            <label className="agent-field"><span>What it does <span className="optional">optional</span></span><input value={draft.does} maxLength={120} onChange={(event) => set('does', event.target.value)} placeholder="Shown under its name" /></label>
          </div>}
          {open === 'lamp' && <>
            <div className="agent-field-row">
              <label className="agent-field">AI app
                <select value={draft.appId ?? ''} onChange={(event) => { set('appId', event.target.value || null); set('model', '') }}>
                  <option value="" disabled>{harnessesLoading ? 'Looking for apps…' : 'Choose an app'}</option>
                  {harnesses.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={candidate.acpAvailable === false || candidate.health === 'error'}>{candidate.name}</option>)}
                </select>
              </label>
              <label className="agent-field">Model
                <select value={draft.model} disabled={!draft.appId} onChange={(event) => set('model', event.target.value)}>
                  <option value="">The app’s current model</option>
                  {(models?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
            </div>
            <p className="t-meta">The app does the work; the model is how much it can think through. A bigger model costs more of your plan per run.</p>
          </>}
          {open === 'skills' && <SkillShelf chosen={draft.skills} available={skills} loading={skillsLoading} onAdd={addSkill} onRemove={(name) => set('skills', draft.skills.filter((skill) => skill !== name))} onDrag={setDragging} />}
          {open === 'keys' && <ul className="byhand-keys">
            {KEYS.map(({ key, word }) => {
              const on = draft.allow[key] === true
              const info = ALLOW_SWITCHES.find((item) => item.key === key)!
              return (
                <li key={key} className={on ? 'on' : ''}>
                  <KeyRound size={15} aria-hidden="true" />
                  <span><b>{word} key</b> · {info.label.toLowerCase()}<em>{wild ? `${wild} doesn’t ask, so it does this either way.` : on ? info.on : `It asks you first. On a schedule nobody is there to answer, so it is declined.`}</em></span>
                  <button type="button" className={`btn${on ? '' : ' btn-primary'}`} onClick={() => giveKey(key, !on)}>{on ? 'Take it back' : 'Hand it over'}</button>
                </li>
              )
            })}
          </ul>}
          {open === 'reply' && <>
            {reply ? <blockquote className="byhand-reply">{reply}</blockquote> : <p className="t-meta">Its instructions don’t say what it replies with yet. The next agent, or you, will get whatever it decides to write.</p>}
            <button type="button" className="btn" onClick={() => { if (!shape.reply) set('instructions', appendToRole(draft.instructions, PART_STARTERS.reply)); setOpen('job'); window.setTimeout(() => { const field = roleField.current; if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length) } }, 0) }}>{reply ? 'Change it on the job card' : 'Say what it replies with'}</button>
          </>}
        </div>
      )}
    </div>
  )
}

const DRAWER_TITLE: Record<DeskPart, string> = {
  job: 'The job card · its instructions',
  name: 'The nameplate · who it is',
  lamp: 'The lamp · the app and model it thinks with',
  skills: 'The recipe box · its skills',
  keys: 'The keys · what it may do without asking',
  reply: 'The outbox · what it hands back',
}

function Spot({ part, box, open, label, onClick, extra, zone }: { part: DeskPart; box: Box; open: DeskPart | null; label: string; onClick: (part: DeskPart) => void; extra?: object; zone?: 'box' | 'rack' | 'dish' }) {
  return <button type="button" className={`byhand-spot${open === part ? ' open' : ''}${zone ? ` zone-${zone}` : ''}`} style={at(box)} aria-label={label} aria-expanded={open === part} title={label} onClick={() => onClick(part)} {...extra} />
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
        ? <ul className="skill-picker-chosen" aria-label="Recipe cards in the box">{chosen.map((name) => <li key={name}><Puzzle size={12} aria-hidden="true" />{name}<button type="button" className="iconbtn" aria-label={`Take ${name} out`} onClick={() => onRemove(name)}><X size={12} aria-hidden="true" /></button></li>)}</ul>
        : <p className="t-meta">The box is empty. A skill is a recipe card: instructions it opens when the work calls for it. Drag one in, or press +.</p>}
      <label className="skill-picker-find"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={loading ? 'Looking for recipe cards on this computer…' : `Find a recipe card (${available.length} on this computer)`} aria-label="Find a skill" /></label>
      <ul className="byhand-cards" aria-label="Recipe cards you can add">
        {found.map((skill) => (
          <li key={skill.id} draggable onDragStart={(event) => { event.dataTransfer.setData(SKILL_MIME, skill.name); event.dataTransfer.effectAllowed = 'copy'; onDrag('skill') }} onDragEnd={() => onDrag(null)} title="Drag it onto the recipe box">
            <span className="byhand-card-tab" aria-hidden="true" />
            <b>{skill.name}</b>
            <span>{skill.detail || skill.source}</span>
            <button type="button" className="iconbtn" aria-label={`Put ${skill.name} in the box`} onClick={() => onAdd(skill.name)}><Plus size={13} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The desk in one sentence, for anyone who reads rather than looks, and for screen readers. */
function sentence(draft: AgentDraft, harness: DetectedHarness | null, wild: string | null): ReactNode {
  const name = draft.name.trim() || 'This agent'
  const has = KEYS.filter(({ key }) => draft.allow[key]).map(({ word }) => word.toLowerCase())
  const keys = wild ? `${wild} doesn’t ask before it acts, so every door is open.` : has.length ? `It has the ${has.join(' and ')} key${has.length === 1 ? '' : 's'}; for anything else it asks you first.` : 'It has no keys, so it asks you before it searches the web, changes files or runs a command.'
  const skills = draft.skills.length ? `${draft.skills.length} recipe card${draft.skills.length === 1 ? '' : 's'}` : 'no recipe cards yet'
  return <><b>{name}</b> works {harness ? `on ${harness.name}` : 'on no app yet'}, carries {skills}. {keys}</>
}

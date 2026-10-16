import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { FileText, Folder, KeyRound, Network, NotebookText, Plus, Puzzle, Search, Wrench, X } from 'lucide-react'

import { listNames, middleTruncate } from '../../lib/format'
import { isHarnessRunnable, type DetectedHarness, type HarnessModels } from '../../lib/harnesses'
import type { DetectedCapability } from '../../lib/library/client'
import type { AgentDraft } from '../../lib/library/draft'
import { replyLine } from '../../lib/library/desk'
import { askedKey, CARD_SLOTS, FIGURE_KEYS, figureMood, READ_SLOTS, TOOL_SLOTS, type FigurePart, type ReadSource } from '../../lib/library/figure'
import type { FigureChoice } from '../../lib/library/figures'
import type { RunRecord } from '../../lib/runs/client'
import { useNow } from '../../lib/useNow'
import { useSessionEvents } from '../../lib/watch/useSessionEvents'
import { actsWithoutAsking, ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { appendToRole, INSTRUCTION_PARTS, instructionShape, PART_STARTERS } from '../../lib/team-file/checkup'
import type { AllowSwitch } from '../../lib/team-file/types'
import { DoneWhen } from '../canvas/DoneWhen'
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
 * nameplate the name, the clipboard the job, the cards on the pegboard the skills, the folders in
 * the file drawer what its team gives it to read, the wrenches in the tool drawer its tools,
 * the keys on the hooks what it may do without
 * asking (the ones in your dish ask you first), and the tray what it hands back. Clicking anything
 * on the bench takes you to its block, and working in a block lights its thing on the bench. While
 * it works in its chat, the figure works as the run record and its events say.
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
  /** The tools (MCP servers) on this computer it can be given: the capability scan's tools. */
  tools: readonly DetectedCapability[]
  toolsLoading: boolean
  roleField: RefObject<HTMLTextAreaElement | null>
  /** The figure it wears (lib/library/figures.ts). */
  figure: FigureChoice
  /** The run in its chat, if one is on screen: the figure works as its record and events say. */
  record: RunRecord | null
  /** A team's own agent has no palette line ("what it does"): that belongs to Your agents. */
  hideDoes?: boolean
  /** Changes can't be kept here (a team you can't edit): every control shows, none applies. */
  readOnly?: boolean
  /**
   * In a team: the folders, files and Notion pages the team gives it to read (teamDraft.ts
   * readsOf), filed in the bench's file drawer. Absent in Your agents, where its file drawer stays
   * shut and its block says each team it joins gives it what it reads.
   */
  reads?: readonly ReadSource[]
  /** In a team: open its Workflow, where what it reads is given with a line. */
  onShowWorkflow?: () => void
  /**
   * Its chat (its Chat tab), shown beside the bench instead of the blocks: the figure
   * works there as the chat's newest run says. The bench stays the same one, so it is never drawn
   * twice. Picking something on it goes back to Build, to that thing's block (`onBuild`).
   */
  chat?: ReactNode
  onBuild?: () => void
  /** Laid over the bench while it is shown: an answer in the chat, read in full beside it. */
  cover?: ReactNode
}

/** Each block: its title, and where it is on the bench. In the order you would set an agent up. */
const BLOCKS: readonly { part: FigurePart; title: string; where: string }[] = [
  { part: 'name', title: 'Name', where: 'the nameplate' },
  { part: 'job', title: 'Instructions', where: 'the clipboard' },
  { part: 'app', title: 'App', where: 'the laptop' },
  { part: 'mind', title: 'Model', where: 'the figure' },
  { part: 'skills', title: 'Skills', where: 'the recipe cards' },
  { part: 'reads', title: 'What it reads', where: 'the file drawer' },
  { part: 'tools', title: 'Tools it can use', where: 'the tool drawer' },
  { part: 'keys', title: 'What it may do without asking', where: 'the keys, and your dish' },
  { part: 'reply', title: 'What it hands back', where: 'the tray' },
]

export function ByHand({ draft, set: write, harness, harnesses, harnessesLoading, models, modelsError = null, modelName, skills, skillsLoading, roleField, figure, record, hideDoes = false, readOnly = false, tools, toolsLoading, reads, onShowWorkflow, chat, onBuild, cover }: ByHandProps) {
  const chatting = chat !== undefined
  const set: ByHandProps['set'] = (key, value) => { if (!readOnly) write(key, value) }
  // The block you are working in: its thing on the bench is lit.
  const [focus, setFocus] = useState<FigurePart | null>(null)
  const [flash, setFlash] = useState<{ part: FigurePart; at: number } | null>(null)
  const [dragging, setDragging] = useState<'skill' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const blocks = useRef(new Map<FigurePart, HTMLElement>())
  // Picked on the bench while chatting: its block is shown once Build is back on screen.
  const picked = useRef<FigurePart | null>(null)
  useEffect(() => {
    if (chatting || !picked.current) return
    showBlock(blocks.current.get(picked.current))
    picked.current = null
  }, [chatting])
  const ids = useId()
  const wild = harness ? actsWithoutAsking({ spawn: { cmd: harness.spawn.cmd, args: harness.spawn.args, env: {}, cwd: '.' } }) : null
  const shape = { ...instructionShape(draft.instructions), ...(draft.doneWhen.length ? { check: true } : {}) }
  const reply = replyLine(draft.instructions)
  const { mood, events } = useFigureMood(record)
  const given = FIGURE_KEYS.filter(({ key }) => draft.allow[key])
  const kept = FIGURE_KEYS.filter(({ key }) => !draft.allow[key])
  const giveKey = (key: AllowSwitch, on: boolean) => set('allow', { ...draft.allow, [key]: on })
  const addSkill = (name: string) => { if (!draft.skills.includes(name)) set('skills', [...draft.skills, name]) }
  const model = modelName || draft.model || 'the app’s current model'
  // How hard it thinks: one of the efforts its model lists, or the app's default for it. The app
  // lists efforts only for the model it runs on (and Codex for each model it lists them for);
  // another model runs at its own default.
  const thinkingModel = models?.models.find((item) => item.id === (draft.model || models.currentModelId)) ?? null
  const efforts = thinkingModel?.thinkingEfforts ?? []
  const effortId = draft.effort || models?.currentThinkingEffort || ''
  const effortIndex = Math.max(0, efforts.findIndex((item) => item.id === effortId))
  const effort = efforts.length ? efforts[effortIndex] : null
  // A saved effort on a model whose efforts are not known is used only if the model has it.
  const askedOfUnknown = draft.effort && thinkingModel && !thinkingModel.effortsKnown ? models?.models.flatMap((item) => item.thinkingEfforts).find((item) => item.id === draft.effort)?.name ?? draft.effort : null
  const thinks = effort ? `${model} · ${effort.name.toLowerCase()} effort` : model
  const asked = askedKey(record)

  const view = useMemo<BenchView>(() => ({
    look: { name: draft.name, instructions: draft.instructions, app: draft.appId ?? '', model: `${draft.model}|${draft.effort}`, skills: draft.skills, allow: draft.allow },
    figure,
    does: draft.does,
    appName: harness?.name ?? '',
    hasReply: Boolean(replyLine(draft.instructions)),
    mood,
    events,
    asked,
    open: focus,
    dropping: dragging === 'skill',
    // Outside a team its file drawer stays shut: what it reads is given by each team it joins.
    reads: reads ?? [],
    tools: draft.tools,
  }), [draft, figure, harness, mood, events, asked, focus, dragging, reads])

  /** From the bench: go to the block for what was picked, and start working in it. */
  const goTo = (part: FigurePart) => {
    setFocus(part)
    setFlash((current) => ({ part, at: (current?.at ?? 0) + 1 }))
    if (chatting) {
      picked.current = part
      onBuild?.()
      return
    }
    showBlock(blocks.current.get(part))
  }

  const name = draft.name.trim() || 'New agent'
  const more = draft.skills.length > CARD_SLOTS ? ` (${draft.skills.length - CARD_SLOTS} not pinned)` : ''
  const keysText = wild ? 'Every door is open' : given.length ? `Keys it has · ${given.map((item) => item.word).join(', ')}` : 'Keys it has · none'
  const asking = asked && !draft.allow[asked] ? FIGURE_KEYS.find(({ key }) => key === asked)?.word : null
  const dishText = asking ? `It’s asking you for the ${asking} key` : wild ? `${wild} doesn’t ask before it acts` : kept.length ? `You keep: ${kept.map((item) => item.word).join(', ')} · it asks you first` : 'You keep no keys'
  const parts = INSTRUCTION_PARTS.filter((part) => shape[part]).length
  // More than a drawer has room for still count, as skills past the pegboard's do: the label says
  // how many aren't in it. It gives only the total then, so the two drawers' labels stay short
  // enough to sit side by side.
  const readsOff = reads && reads.length > READ_SLOTS ? ` (${reads.length - READ_SLOTS} not in the drawer)` : ''
  const toolsOff = draft.tools.length > TOOL_SLOTS ? ` (${draft.tools.length - TOOL_SLOTS} not in the drawer)` : ''
  const readsText = !reads ? 'Reads · what a team gives' : !reads.length ? 'Reads · nothing yet' : reads.length === 1 ? `Reads · ${reads[0].name}` : readsOff ? `Reads · ${reads.length}${readsOff}` : `Reads · ${readCount(reads)}`
  const toolsText = !draft.tools.length ? 'Tools · none yet' : draft.tools.length === 1 ? `Tools · ${draft.tools[0]}` : `Tools · ${draft.tools.length}${toolsOff}`
  // What each setting adds up to, in words: the line under each block's title.
  const says: Record<FigurePart, string> = {
    name: hideDoes || !draft.does.trim() ? name : `${name} · ${draft.does.trim()}`,
    job: draft.instructions.trim() ? `Says ${parts} of the ${INSTRUCTION_PARTS.length} things good instructions say: its job, how to work, how it checks its work, and what it replies with` : 'Nothing written yet',
    app: harness ? `Works in ${harness.name}, on this computer, signed in as you` : 'No app chosen yet',
    mind: `Thinks with ${thinks}`,
    skills: draft.skills.length ? `${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'} it opens when the work calls for one` : 'No skills yet',
    reads: !reads ? 'Each team it joins gives it what it reads' : reads.length ? `Reads ${readCount(reads)} the team gives it` : 'The team gives it nothing to read yet',
    tools: draft.tools.length ? `Can use ${toolCount(draft.tools)} while it works` : 'No tools yet',
    keys: wild ? `${wild} doesn’t ask before it acts, so every door is open` : given.length ? `Goes ahead with ${given.map((item) => item.word.toLowerCase()).join(' and ')}${kept.length ? `; asks you first for ${kept.map((item) => item.word.toLowerCase()).join(' and ')}` : ''}` : 'Asks you before it searches the web, changes files or runs a command',
    reply: reply ?? 'Its instructions don’t say yet',
  }
  const labels: BenchLabel[] = [
    { anchor: 'mind', part: 'mind', place: 'right', text: <>Thinks with <b>{model}</b>{effort && <> · {effort.name.toLowerCase()}</>}</>, short: <b>{model}</b>, label: `The figure, the model it thinks with: ${thinks}` },
    { anchor: 'job', part: 'job', place: 'above', text: <>The job <span className="byhand-parts">{INSTRUCTION_PARTS.map((part) => <i key={part} className={shape[part] ? 'on' : ''} />)}</span></>, short: 'Job', label: 'The job on the clipboard: its instructions' },
    { anchor: 'skills', part: 'skills', place: 'above', text: `Skills · ${draft.skills.length || 'none yet'}${more}`, short: `Skills · ${draft.skills.length}`, label: `The recipe cards: ${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'}` },
    { anchor: 'keys', part: 'keys', place: 'above', text: keysText, short: `Keys · ${wild ? 'all' : given.length}`, label: `The key hooks: ${keysText}` },
    { anchor: 'dish', part: 'keys', place: 'below', text: dishText, short: asking ? `Asking for ${asking}` : `You keep ${wild ? 0 : kept.length}`, label: `Your dish: ${dishText}` },
    { anchor: 'reply', part: 'reply', place: 'above', text: `Hands back · ${reply ? 'see the tray' : 'not said yet'}`, short: 'Hands back', label: 'The tray: what it hands back' },
    // Under the bench's two drawers, on its face: what it works with, apart from the work on top.
    { anchor: 'reads', part: 'reads', place: 'below', text: readsText, short: `Reads · ${reads?.length ?? 0}`, label: `The file drawer: ${says.reads}${readsOff}` },
    { anchor: 'tools', part: 'tools', place: 'below', text: toolsText, short: `Tools · ${draft.tools.length}`, label: `The tool drawer: ${says.tools}${toolsOff}` },
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
    <div className={`byhand${chatting ? ' chatting' : ''}`}>
      {!chatting && <p className="byhand-say" aria-live="polite">{sentence(draft, harness, model, wild, reads)}</p>}
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
          {cover && <div className="byhand-cover">{cover}</div>}
        </div>
        {chatting && <div className="byhand-chat">{chat}</div>}

        {/* Kept while chatting, only hidden: what you were writing in a block is there when you come back. */}
        <div className="byhand-blocks" data-tour="agent-blocks" hidden={chatting}>
          {block('name', <div className="agent-field-row">
            <label className="agent-field">Name<input value={draft.name} maxLength={80} onChange={(event) => set('name', event.target.value)} placeholder="e.g. Release notes writer" /></label>
            {!hideDoes && <label className="agent-field"><span>What it does <span className="optional">optional</span></span><input value={draft.does} maxLength={120} onChange={(event) => set('does', event.target.value)} placeholder="Shown under its name" /></label>}
          </div>)}

          {block('job', <>
            <textarea ref={roleField} className="agent-instructions" rows={8} value={draft.instructions} onChange={(event) => set('instructions', event.target.value)} placeholder="What this agent does, how it works, and what it replies with." aria-label="Instructions" />
            <InstructionShape role={draft.instructions} checksDoneWhen={draft.doneWhen.length > 0} field={roleField} onChange={(role) => set('instructions', role)} />
            <DoneWhen items={draft.doneWhen} readOnly={readOnly} onChange={(items) => set('doneWhen', items)} />
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
              <span className="thinking-label"><label htmlFor={`${ids}-thinking`}>Thinking effort</label><output htmlFor={`${ids}-thinking`}>{effort?.name ?? askedOfUnknown ?? 'Model default'}</output></span>
              {effort && <input
                id={`${ids}-thinking`}
                className="thinking-slider"
                type="range"
                min={0}
                max={efforts.length - 1}
                step={1}
                value={effortIndex}
                disabled={!draft.appId}
                aria-label="Thinking effort"
                aria-valuetext={effort.name}
                onChange={(event) => {
                  const picked = efforts[Number(event.target.value)]
                  if (!picked) return
                  // An effort is saved with the model it belongs to, so the app's current model is pinned.
                  if (!draft.model && thinkingModel) set('model', thinkingModel.id)
                  set('effort', picked.id)
                }}
              />}
              {efforts.length > 1 && <span className="thinking-scale t-micro"><span>{efforts[0].name}</span><span>{efforts[efforts.length - 1].name}</span></span>}
              <span className="t-meta">{effort ? effort.description ?? 'How much it reasons before it answers.'
                : !draft.appId ? 'Choose its app first.'
                : !models ? 'Loading effort choices…'
                : askedOfUnknown ? <>Used only if this model has that setting, else it runs at its own default.{!readOnly && <> <button type="button" className="link" onClick={() => set('effort', '')}>Use its default</button></>}</>
                : thinkingModel?.effortsKnown ? 'This model has no separate effort setting.'
                : 'It runs at the model’s own default effort.'}</span>
            </div>
            {modelsError && <p className="t-meta agent-save-error">Couldn’t list this app’s models: {modelsError}</p>}
            <p className="t-meta">{harness ? <>The models {harness.name} offers. </> : <>Choose its app first. </>}A bigger model can think more through, and costs more of your plan per run.</p>
          </>)}

          {block('skills', <Shelf kind="skill" chosen={draft.skills} available={skills} loading={skillsLoading} onAdd={addSkill} onRemove={(skill) => set('skills', draft.skills.filter((item) => item !== skill))} onDrag={setDragging} />)}

          {block('reads', !reads ? <p className="t-meta">A folder, file or Notion page is given in a team: draw a line from it to this agent in the team’s Workflow.</p> : <>
            {reads.length > 0 && <ul className="byhand-reads" aria-label="In its file drawer">
              {reads.map((source, index) => {
                const Icon = source.kind === 'page' ? NotebookText : source.kind === 'file' ? FileText : Folder
                return <li key={`${source.kind}:${source.where}:${index}`}><Icon size={15} aria-hidden="true" /><span><b>{source.name}</b><em title={source.where}>{source.kind === 'page' ? source.where : `${source.kind === 'file' ? 'File' : 'Folder'} · ${middleTruncate(source.where, 64)}`}</em></span></li>
              })}
            </ul>}
            {reads.length > READ_SLOTS && <p className="t-meta">The drawer has room for {READ_SLOTS}, so {listNames(reads.slice(READ_SLOTS).map((source) => source.name))} {reads.length - READ_SLOTS === 1 ? 'isn’t' : 'aren’t'} in it. It still reads {reads.length - READ_SLOTS === 1 ? 'it' : 'them'}.</p>}
            <p className="t-meta">What it reads is the team’s to give: draw a line from a folder, file or Notion page to this agent in Workflow.</p>
            {onShowWorkflow && <button type="button" className="btn" onClick={onShowWorkflow}><Network size={14} aria-hidden="true" />{reads.length ? 'Change it in Workflow' : 'Give it something in Workflow'}</button>}
          </>)}

          {block('tools', <>
            <Shelf kind="tool" chosen={draft.tools} available={tools} loading={toolsLoading} onAdd={(tool) => { if (!draft.tools.includes(tool)) set('tools', [...draft.tools, tool]) }} onRemove={(tool) => set('tools', draft.tools.filter((item) => item !== tool))} />
            {draft.tools.length > TOOL_SLOTS && <p className="t-meta">The drawer has room for {TOOL_SLOTS}, so {listNames(draft.tools.slice(TOOL_SLOTS))} {draft.tools.length - TOOL_SLOTS === 1 ? 'isn’t' : 'aren’t'} in it. It can still use {draft.tools.length - TOOL_SLOTS === 1 ? 'it' : 'them'}.</p>}
            <p className="t-meta">{reads ? 'Each tool it has shows on the Workflow canvas as a card wired to this agent.' : 'In a team, each tool it has shows on the Workflow canvas as a card wired to this agent.'}</p>
          </>)}

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

/** A block brought into view, with its first control taken, so you can carry on in it. */
function showBlock(block: HTMLElement | undefined) {
  if (!block) return
  block.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  block.querySelector<HTMLElement>('textarea, input, select, button')?.focus({ preventScroll: true })
}

/**
 * The figure's mood, from the run record, on the shared clock while the run is live, to tell working
 * from quiet; and the run's events so far, each one flickering its screen. The record counts its
 * events only once the run is over, so while it runs they are counted as they arrive.
 */
function useFigureMood(record: RunRecord | null) {
  const live = record?.status === 'running'
  const now = useNow(live)
  const arrived = useSessionEvents(live ? record.sessionId : '').events.length
  const [moved, setMoved] = useState<{ run: string; events: number; at: number } | null>(null)
  const run = record?.runId ?? null
  const events = live ? arrived : record?.eventCount ?? 0
  // When the run moves, note when (adjusting state while rendering, not in an effect).
  if (run && (moved?.run !== run || moved.events !== events)) setMoved({ run, events, at: now })
  return { mood: figureMood(record, moved && moved.run === run ? moved.at : null, now), events }
}

/** What a shelf says, for skills (recipe cards on the pegboard) and tools (wrenches in the tool drawer). */
const SHELF = {
  skill: {
    Icon: Puzzle,
    chosen: 'Recipe cards on its pegboard',
    none: 'None yet. A skill is a recipe card: instructions it opens when the work calls for it. Press + on one below, or drag it onto the bench.',
    looking: 'Looking for recipe cards on this computer…',
    find: (count: number) => `Find a recipe card (${count} on this computer)`,
    findLabel: 'Find a skill',
    list: 'Recipe cards you can add',
    take: (name: string) => `Take ${name} down`,
    give: (name: string) => `Pin ${name} up`,
  },
  tool: {
    Icon: Wrench,
    chosen: 'Wrenches in its tool drawer',
    none: 'None yet. A tool is an MCP server set up on this computer, like GitHub or a database, that it can use while it works. Press + on one below.',
    looking: 'Looking for tools on this computer…',
    find: (count: number) => `Find a tool (${count} on this computer)`,
    findLabel: 'Find a tool',
    list: 'Tools you can add',
    take: (name: string) => `Take ${name} out`,
    give: (name: string) => `Give it ${name}`,
  },
} as const

/**
 * What it has of one kind, each with a way to take it off, and what else this computer has to give
 * it. Skills can also be dragged onto the bench, where they are pinned up as recipe cards.
 */
function Shelf({ kind, chosen, available, loading, onAdd, onRemove, onDrag }: { kind: 'skill' | 'tool'; chosen: readonly string[]; available: readonly DetectedCapability[]; loading: boolean; onAdd: (name: string) => void; onRemove: (name: string) => void; onDrag?: (kind: 'skill' | null) => void }) {
  const words = SHELF[kind]
  const [query, setQuery] = useState('')
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const seen = new Set<string>()
    return available.filter((item) => !chosen.includes(item.name) && (!needle || `${item.name} ${item.detail}`.toLowerCase().includes(needle))).filter((item) => (seen.has(item.name) ? false : (seen.add(item.name), true))).slice(0, 12)
  }, [available, chosen, query])
  return (
    <div className="byhand-shelf">
      {chosen.length > 0
        ? <ul className="skill-picker-chosen" aria-label={words.chosen}>{chosen.map((name) => <li key={name}><words.Icon size={12} aria-hidden="true" />{name}<button type="button" className="iconbtn" aria-label={words.take(name)} onClick={() => onRemove(name)}><X size={12} aria-hidden="true" /></button></li>)}</ul>
        : <p className="t-meta">{words.none}</p>}
      <label className="skill-picker-find"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={loading ? words.looking : words.find(available.length)} aria-label={words.findLabel} /></label>
      <ul className={`byhand-cards${onDrag ? '' : ' still'}`} aria-label={words.list}>
        {found.map((item) => (
          <li key={item.id} draggable={Boolean(onDrag)} onDragStart={onDrag && ((event) => { event.dataTransfer.setData(SKILL_MIME, item.name); event.dataTransfer.effectAllowed = 'copy'; onDrag('skill') })} onDragEnd={onDrag && (() => onDrag(null))} title={onDrag ? 'Drag it onto the bench' : undefined}>
            <span className="byhand-card-tab" aria-hidden="true" />
            <b>{item.name}</b>
            <span>{item.detail || item.source}</span>
            <button type="button" className="iconbtn" aria-label={words.give(item.name)} onClick={() => onAdd(item.name)}><Plus size={13} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The bench in one sentence, for anyone who reads rather than looks, and for screen readers. */
function sentence(draft: AgentDraft, harness: DetectedHarness | null, model: string, wild: string | null, reads?: readonly ReadSource[]): ReactNode {
  const name = draft.name.trim() || 'This agent'
  const has = FIGURE_KEYS.filter(({ key }) => draft.allow[key]).map(({ word }) => word.toLowerCase())
  const keys = wild ? `${wild} doesn’t ask before it acts, so every door is open.` : has.length ? `It has the ${has.join(' and ')} key${has.length === 1 ? '' : 's'}; for anything else it asks you first.` : 'It has no keys, so it asks you before it searches the web, changes files or runs a command.'
  const skills = draft.skills.length ? `${draft.skills.length} recipe card${draft.skills.length === 1 ? '' : 's'}` : 'no recipe cards yet'
  const works = harness ? `in ${harness.name}` : 'in no app yet'
  const uses = draft.tools.length ? toolCount(draft.tools) : 'no tools yet'
  if (reads) return <><b>{name}</b> thinks with {model}, works {works}, has {skills}, reads {reads.length ? readCount(reads) : 'nothing yet'}, and uses {uses}. {keys}</>
  return <><b>{name}</b> thinks with {model}, works {works}, has {skills}, and uses {uses}. {keys}</>
}

/** What it reads, counted in words: "1 folder", "2 folders and 1 Notion page". */
function readCount(reads: readonly ReadSource[]): string {
  const words = ([['folder', 'folder'], ['file', 'file'], ['page', 'Notion page']] as const).flatMap(([kind, word]) => {
    const count = reads.filter((source) => source.kind === kind).length
    return count ? [`${count} ${word}${count === 1 ? '' : 's'}`] : []
  })
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? 'nothing'
}

/** The tools it is given, counted in words: "1 tool", "3 tools". */
function toolCount(tools: readonly string[]): string {
  return `${tools.length} tool${tools.length === 1 ? '' : 's'}`
}

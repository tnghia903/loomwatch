import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ExternalLink, FilePlus2, FileText, Folder, FolderPlus, KeyRound, Network, NotebookText, Plug, Plus, Puzzle, Search, Store, Wrench, X } from 'lucide-react'

import { shortName } from '../../lib/ai/client'
import { effortWord, modelEfforts, placeEffort } from '../../lib/ai/efforts'
import { modelNameFromId } from '../../lib/ai/modelIds'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { useModels } from '../../lib/ai/useModels'
import { helpersOf } from '../../lib/chat/helpers'
import { uniqueLabel } from '../../lib/composer-layout/types'
import { listNames, middleTruncate } from '../../lib/format'
import { addAgentFile, addTeamFile } from '../../lib/knowledge/client'
import type { DetectedCapability } from '../../lib/library/client'
import type { AgentDraft } from '../../lib/library/draft'
import { replyLine, replySays, replySection, withReply } from '../../lib/library/desk'
import { knowledgeOf, readKey, type AgentRead } from '../../lib/library/reads'
import { readsOf } from '../../lib/library/teamDraft'
import { CONNECT_NOTION_HREF, useNotionConnection } from '../../lib/notion/connection'
import { askedKey, CARD_SLOTS, FIGURE_KEYS, figureMood, READ_SLOTS, TOOL_SLOTS, type BenchUse, type FigurePart, type ReadSource } from '../../lib/library/figure'
import type { FigureChoice } from '../../lib/library/figures'
import type { RunRecord } from '../../lib/runs/client'
import { useNow } from '../../lib/useNow'
import { useSessionEvents } from '../../lib/watch/useSessionEvents'
import { benchUses, thoughtLine, workPhase, type BenchKit } from '../../lib/watch/workPhase'
import { ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { allowedFor, withoutAllowed } from '../../lib/tools/allow'
import { actionCount, toolNamed, useConnectedTools, type ConnectedTool } from '../../lib/tools/client'
import { INSTRUCTION_PARTS, instructionShape } from '../../lib/team-file/checkup'
import { suggestedOfDraft } from '../../lib/team-file/agentSetup'
import type { ModelSuggestionInput } from '../../lib/team-file/modelSuggestion'
import type { AllowSwitch } from '../../lib/team-file/types'
import { DoneWhen } from '../canvas/DoneWhen'
import { FolderPicker } from '../canvas/FolderPicker'
import { NotionPagePicker } from '../canvas/NotionPagePicker'
import { InstructionShape } from '../canvas/InstructionShape'
import { EffortSlider } from '../models/EffortSlider'
import { ModelPicker } from '../models/ModelPicker'
import type { LessonsOf } from '../../lib/lessons/client'
import { SkillDetails } from '../skills/SkillDetails'
import { ConnectTool } from '../tools/ConnectTool'
import { ToolIcon } from '../tools/ToolIcon'
import type { BenchLabel } from './AgentFigure'
import type { BenchHelper, BenchView } from './workbenchScene'
import { LearnedBlock } from './LearnedBlock'

const AgentFigure = lazy(() => import('./AgentFigure'))
const SkillsMarket = lazy(() => import('../skills/SkillsMarket'))

/**
 * BUILD BY HAND: every setting of the agent as a block of plain words and controls, always open,
 * beside the agent as a figure at a workbench (lib/library/figure.ts says what each thing on the
 * bench stands for). It is the one way to build an agent in Your agents.
 *
 * The blocks are the way in: each says what its setting does, in words, so nobody needs to learn
 * the bench first. The bench is the picture of the same settings: the laptop shows the model it
 * thinks with, the nameplate the name, the clipboard the job, the cards on the pegboard the skills, the folders in
 * the file drawer what it reads, the tiles with their icons in the tool drawer its tools,
 * the keys on the hooks what it may do without
 * asking (the ones in your dish ask you first), and the tray what it hands back. Clicking anything
 * on the bench takes you to its block, and working in a block lights its thing on the bench. While
 * it works in its chat, the figure works as the run record and its events say.
 */

const SKILL_MIME = 'application/x-loomwatch-skill'

export interface ByHandProps {
  draft: AgentDraft
  set: <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => void
  skills: readonly DetectedCapability[]
  skillsLoading: boolean
  roleField: RefObject<HTMLTextAreaElement | null>
  /** The figure it wears (lib/library/figures.ts). */
  figure: FigureChoice
  /** The run in its chat, if one is on screen: the figure works as its record and events say. */
  record: RunRecord | null
  /**
   * A team's own agent has no "What it does" line: it is the line under an agent's name in My
   * agents and in the list a team adds agents from, where a team's own agent never is, and the team
   * file has no field to keep it in. Its Name box stays where it is for one of My agents.
   */
  hideDoes?: boolean
  /** Changes can't be kept here (a team you can't edit): every control shows, none applies. */
  readOnly?: boolean
  /**
   * One of Your agents in a team: the folders, files and Notion pages it reads there (teamDraft.ts
   * readsOf). The drawer files them with its own (`draft.reads`), each once; absent elsewhere.
   */
  reads?: readonly ReadSource[]
  /**
   * A team's own agent, in the team at `teamPath` (`null` until it is saved). What it reads
   * (`draft.reads`) is the team's: each is a card with a line to it in Workflow, so giving it one
   * here and drawing that line there are the same thing. A file it is given is kept beside the team
   * file. One of Your agents is given what it reads in every team it joins, here too.
   */
  teamOwn?: { teamPath: string | null }
  /** In a team: open its Workflow, where the team gives it more to read with a line. */
  onShowWorkflow?: () => void
  /** Whose lessons its Learned block lists (ADR 0078); absent until there is an agent to learn. */
  learned?: LessonsOf | null
  /** In a team: the agent and its team, which the suggested model is read from. Absent, its own
      setup alone decides. */
  suggestFor?: ModelSuggestionInput
  /** A team's own agent (ADR 0072): whether its model follows its suggestion, a move to show with
      Undo, and what a pick writes, in place of setting `model` on the draft. */
  following?: { follows: boolean; moved?: { from: string; onUndo: () => void }; onPick: (id: string, follow: boolean) => void }
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
  { part: 'mind', title: 'Model', where: 'the figure and the laptop' },
  { part: 'skills', title: 'Skills', where: 'the recipe cards' },
  { part: 'reads', title: 'What it reads', where: 'the file drawer' },
  { part: 'tools', title: 'Tools it can use', where: 'the tool drawer' },
  { part: 'keys', title: 'What it may do without asking', where: 'the keys, and your dish' },
  { part: 'reply', title: 'What it hands back', where: 'the tray' },
]

export function ByHand({ draft, set: write, skills, skillsLoading, roleField, figure, record, hideDoes = false, readOnly = false, reads: teamReads, teamOwn, onShowWorkflow, learned, suggestFor, following, chat, onBuild, cover }: ByHandProps) {
  const chatting = chat !== undefined
  const set: ByHandProps['set'] = (key, value) => { if (!readOnly) write(key, value) }
  // The block you are working in: its thing on the bench is lit.
  const [focus, setFocus] = useState<FigurePart | null>(null)
  const [flash, setFlash] = useState<{ part: FigurePart; at: number } | null>(null)
  const [dragging, setDragging] = useState<'skill' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // The skills marketplace, open over the page (with what was typed in the shelf), and what it pinned up.
  const [market, setMarket] = useState<{ query: string } | null>(null)
  const [fromMarket, setFromMarket] = useState<readonly string[]>([])
  const blocks = useRef(new Map<FigurePart, HTMLElement>())
  // Back from it, you carry on at its button: Safari never focuses a button you click, so what had
  // focus when it opened can't be trusted to say where you were.
  const backFrom = useRef(false)
  useEffect(() => {
    if (market || !backFrom.current) return
    backFrom.current = false
    blocks.current.get('skills')?.querySelector<HTMLElement>('.byhand-market')?.focus()
  }, [market])
  // Picked on the bench while chatting: its block is shown once Build is back on screen.
  const picked = useRef<FigurePart | null>(null)
  useEffect(() => {
    if (chatting || !picked.current) return
    showBlock(blocks.current.get(picked.current))
    picked.current = null
  }, [chatting])
  const ids = useId()
  const shape = { ...instructionShape(draft.instructions), ...(draft.doneWhen.length ? { check: true } : {}) }
  const replyPart = replySection(draft.instructions)
  const given = FIGURE_KEYS.filter(({ key }) => draft.allow[key])
  const kept = FIGURE_KEYS.filter(({ key }) => !draft.allow[key])
  const giveKey = (key: AllowSwitch, on: boolean) => set('allow', { ...draft.allow, [key]: on })
  const addSkill = (name: string) => { if (!draft.skills.includes(name)) set('skills', [...draft.skills, name]) }
  /** Back from the marketplace: what was added there for this agent goes on its pegboard. */
  const backFromMarket = (added: readonly string[]) => {
    backFrom.current = true
    setMarket(null)
    const fresh = added.filter((skill) => !draft.skills.includes(skill))
    setFromMarket(fresh)
    if (!fresh.length) return
    set('skills', [...draft.skills, ...fresh])
    setFocus('skills')
    setFlash((current) => ({ part: 'skills', at: (current?.at ?? 0) + 1 }))
  }
  const { catalog } = useModels()
  const listed = catalog?.models.find((item) => item.id === draft.model)
  const model = listed ? shortName(listed) : modelNameFromId(draft.model)
  // How hard it thinks, when it is set and the model reasons: where it runs on the model's own
  // efforts, as the slider shows it (EffortSlider says the rest).
  const ai = useAiStatus()
  const runsAt = placeEffort(draft.effort, modelEfforts(draft.model, ai, catalog)).runs
  const effort = runsAt ? { name: effortWord(runsAt) } : null
  const thinks = effort ? `${model} · ${effort.name.toLowerCase()} effort` : model
  const asked = askedKey(record)
  // The tools connected in LoomWatch (ADR 0069): the ones it is given, and the ones it could be.
  const connected = useConnectedTools()
  const connectedTools = connected.state === 'ready' ? connected.tools : []
  const [connecting, setConnecting] = useState<ConnectedTool | 'new' | null>(null)
  const givenTools = draft.tools.map((name) => ({ name, tool: toolNamed(connectedTools, name) }))
  // The bench's tool drawer shows each one's own icon, once it is connected.
  const readyTools = connected.state === 'ready' ? connected.tools : null
  const benchTools = useMemo(() => draft.tools.map((name) => ({ name, icon: (readyTools && toolNamed(readyTools, name)?.icon) || null })), [draft.tools, readyTools])
  const toGive = connectedTools.filter((tool) => !tool.pending && !draft.tools.some((name) => name.trim().toLowerCase() === tool.name.trim().toLowerCase()))
  const giveTool = (name: string) => { if (!draft.tools.some((given) => given.trim().toLowerCase() === name.trim().toLowerCase())) set('tools', [...draft.tools, name]) }
  // What it reads: its own (for a team's own agent, all of it), and in a team what that team gives
  // one of Your agents besides.
  const ownReads = useMemo(() => readsOf({ capabilities: knowledgeOf(draft.reads) }), [draft.reads])
  const teamGiven = useMemo(() => {
    const own = new Set(ownReads.map((source) => source.key))
    return (teamReads ?? []).filter((source) => !source.key || !own.has(source.key))
  }, [ownReads, teamReads])
  const reads = useMemo(() => [...ownReads, ...teamGiven], [ownReads, teamGiven])
  const giveRead = (read: AgentRead) => {
    if (draft.reads.some((had) => readKey(had) === readKey(read))) return
    set('reads', [...draft.reads, { ...read, name: uniqueLabel(read.name, new Set(draft.reads.map((had) => had.name))) }])
    setFocus('reads')
  }

  const kit = useMemo<BenchKit>(() => ({ skills: draft.skills, reads, tools: draft.tools }), [draft.skills, reads, draft.tools])
  const { mood, events, phase, thought, uses, helpers } = useFigureMood(record, kit)

  const view = useMemo<BenchView>(() => ({
    look: { name: draft.name, instructions: draft.instructions, app: draft.model, model: `${draft.model}|${draft.effort}`, skills: draft.skills, allow: draft.allow },
    figure,
    does: draft.does,
    // The laptop's screen: the model it thinks with.
    appName: model,
    hasReply: Boolean(replyLine(draft.instructions)),
    mood,
    events,
    phase,
    thought,
    uses,
    asked,
    open: focus,
    dropping: dragging === 'skill',
    reads,
    tools: benchTools,
    helpers,
  }), [draft, figure, model, mood, events, phase, thought, uses, asked, focus, dragging, reads, benchTools, helpers])

  /** From the bench: go to the block for what was picked, and start working in it. */
  const goTo = (target: FigurePart) => {
    // The laptop shows the model, so it opens the Model block.
    const part = target === 'app' ? 'mind' : target
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
  const keysText = given.length ? `Keys it has · ${given.map((item) => item.word).join(', ')}` : 'Keys it has · none'
  const asking = asked && !draft.allow[asked] ? FIGURE_KEYS.find(({ key }) => key === asked)?.word : null
  const dishText = asking ? `It’s asking you for the ${asking} key` : kept.length ? `You keep: ${kept.map((item) => item.word).join(', ')} · it asks you first` : 'You keep no keys'
  const parts = INSTRUCTION_PARTS.filter((part) => shape[part]).length
  // More than a drawer has room for still count, as skills past the pegboard's do: the label says
  // how many aren't in it. It gives only the total then, so the two drawers' labels stay short
  // enough to sit side by side.
  const readsOff = reads.length > READ_SLOTS ? ` (${reads.length - READ_SLOTS} not in the drawer)` : ''
  const toolsOff = draft.tools.length > TOOL_SLOTS ? ` (${draft.tools.length - TOOL_SLOTS} not in the drawer)` : ''
  const readsText = !reads.length ? 'Reads · nothing yet' : reads.length === 1 ? `Reads · ${reads[0].name}` : readsOff ? `Reads · ${reads.length}${readsOff}` : `Reads · ${readCount(reads)}`
  const toolsText = !draft.tools.length ? 'Tools · none yet' : draft.tools.length === 1 ? `Tools · ${draft.tools[0]}` : `Tools · ${draft.tools.length}${toolsOff}`
  // What each setting adds up to, in words: the line under each block's title. Name has none: its
  // boxes already say all of it, and a line above them said the name twice.
  const says: Record<Exclude<FigurePart, 'app'>, string> = {
    name: '',
    job: draft.instructions.trim() ? `Says ${parts} of the ${INSTRUCTION_PARTS.length} things good instructions say: its job, how to work, how it checks its work, and what it replies with` : 'Nothing written yet',
    mind: `Thinks with ${thinks}`,
    skills: draft.skills.length ? `${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'} it opens when the work calls for one` : 'No skills yet',
    reads: readsSay(ownReads, teamGiven, Boolean(teamOwn)),
    tools: toolsSay(givenTools, connected.state === 'loading'),
    keys: given.length ? `Goes ahead with ${given.map((item) => item.word.toLowerCase()).join(' and ')}${kept.length ? `; asks you first for ${kept.map((item) => item.word.toLowerCase()).join(' and ')}` : ''}` : 'Asks you before it searches the web, changes files or runs a command',
    reply: replyPart ? replySays(replyPart.text) : 'Its instructions don’t say yet',
  }
  const labels: BenchLabel[] = [
    { anchor: 'mind', part: 'mind', place: 'right', text: <>Thinks with <b>{model}</b>{effort && <> · {effort.name.toLowerCase()}</>}</>, short: <b>{model}</b>, label: `The figure, the model it thinks with: ${thinks}` },
    { anchor: 'job', part: 'job', place: 'above', text: <>The job <span className="byhand-parts">{INSTRUCTION_PARTS.map((part) => <i key={part} className={shape[part] ? 'on' : ''} />)}</span></>, short: 'Job', label: 'The job on the clipboard: its instructions' },
    { anchor: 'skills', part: 'skills', place: 'above', text: `Skills · ${draft.skills.length || 'none yet'}${more}`, short: `Skills · ${draft.skills.length}`, label: `The recipe cards: ${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'}` },
    { anchor: 'keys', part: 'keys', place: 'above', text: keysText, short: `Keys · ${given.length}`, label: `The key hooks: ${keysText}` },
    { anchor: 'dish', part: 'keys', place: 'below', text: dishText, short: asking ? `Asking for ${asking}` : `You keep ${kept.length}`, label: `Your dish: ${dishText}` },
    { anchor: 'reply', part: 'reply', place: 'above', text: `Hands back · ${replyPart ? 'see the tray' : 'not said yet'}`, short: 'Hands back', label: 'The tray: what it hands back' },
    // Under the bench's two drawers, on its face: what it works with, apart from the work on top.
    { anchor: 'reads', part: 'reads', place: 'below', text: readsText, short: `Reads · ${reads.length}`, label: `The file drawer: ${says.reads}${readsOff}` },
    { anchor: 'tools', part: 'tools', place: 'below', text: toolsText, short: `Tools · ${draft.tools.length}`, label: `The tool drawer: ${says.tools}${toolsOff}` },
    { anchor: 'name', part: 'name', place: 'plate', label: `The nameplate: ${name}` },
    { anchor: 'app', part: 'app', place: 'plate', label: `The laptop, the model it thinks with: ${model}` },
  ]

  const block = (part: Exclude<FigurePart, 'app'>, body: ReactNode, extra?: ReactNode) => {
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
        {says[part] && <p className="byhand-block-says">{says[part]}</p>}
        {body}
        {extra}
      </section>
    )
  }

  return (
    <div className={`byhand${chatting ? ' chatting' : ''}`}>
      {!chatting && <p className="byhand-say" aria-live="polite">{sentence(draft, model, reads)}</p>}
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
            {/* Labelled, and where it is, whether or not "What it does" is beside it, so the block reads the same everywhere. */}
            <label className="agent-field">Name<input value={draft.name} maxLength={80} onChange={(event) => set('name', event.target.value)} placeholder="e.g. Release notes writer" /></label>
            {!hideDoes && <label className="agent-field"><span>What it does <span className="optional">optional</span></span><input value={draft.does} maxLength={120} onChange={(event) => set('does', event.target.value)} placeholder="Shown under its name" /></label>}
          </div>)}

          {block('job', <>
            <textarea ref={roleField} className="agent-instructions" rows={8} value={draft.instructions} onChange={(event) => set('instructions', event.target.value)} placeholder="What this agent does, how it works, and what it replies with." aria-label="Instructions" />
            <InstructionShape role={draft.instructions} checksDoneWhen={draft.doneWhen.length > 0} field={roleField} onChange={(role) => set('instructions', role)} />
            <DoneWhen items={draft.doneWhen} readOnly={readOnly} onChange={(items) => set('doneWhen', items)} />
          </>)}

          {block('mind', <>
            <ModelPicker value={draft.model} disabled={readOnly} suggestFor={suggestFor ?? { agent: suggestedOfDraft(draft) }} follows={following?.follows} moved={following?.moved} onChange={(id, follow) => { if (readOnly) return; if (following) following.onPick(id, follow); else set('model', id) }} />
            <EffortSlider className="thinking-field agent-field" model={draft.model} value={draft.effort} disabled={readOnly} onChange={(effort) => set('effort', effort ?? '')} />
            <p className="t-meta">A bigger model can think more through, and costs more per run or uses more of your plan. Prices are per million tokens.</p>
            {/* ADR 0079: on by default, as the way a big task is done well; off, it works alone. */}
            <button type="button" className={`check byhand-helpers${draft.helpers !== false ? ' on' : ''}`} disabled={readOnly} aria-pressed={draft.helpers !== false} onClick={() => set('helpers', draft.helpers === false ? undefined : false)}>
              <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
              <span className="txt"><b className="t-body">Brings in helpers for big tasks</b><span className="t-meta">On a wide task it can start copies of itself on the parts at once, then put their work together. Each copy runs on its model too.</span></span>
            </button>
          </>)}

          {block('skills', <Shelf kind="skill" chosen={draft.skills} available={skills} loading={skillsLoading} onAdd={addSkill} onRemove={(skill) => set('skills', draft.skills.filter((item) => item !== skill))} onDrag={setDragging} onMarket={readOnly ? undefined : (query) => setMarket({ query })} fromMarket={fromMarket.filter((skill) => draft.skills.includes(skill))} />)}

          {block('reads', <Reads
            reads={reads}
            own={ownReads.length}
            teamOwn={teamOwn}
            inTeam={teamReads !== undefined}
            readOnly={readOnly}
            agentName={draft.name.trim() || 'your new agent'}
            onGive={giveRead}
            onTakeAway={(key) => set('reads', draft.reads.filter((read) => readKey(read) !== key))}
            onShowWorkflow={onShowWorkflow}
          />)}

          {block('tools', <>
            <p className="t-meta">Every agent can read and write files in its own folder, search and read the web, and run commands, as its keys below allow.</p>
            {givenTools.length > 0 && <ul className="byhand-tools" aria-label="Tools you gave it">
              {givenTools.map(({ name, tool }) => {
                const allowed = allowedFor(draft.toolAllow, name)
                const label = (call: string) => tool?.calls.find((item) => item.name === call)?.label ?? call
                return (
                  <li key={name} className={tool ? '' : 'missing'}>
                    {tool ? <ToolIcon name={tool.name} icon={tool.icon} size={24} /> : <Wrench size={15} aria-hidden="true" />}
                    <span className="byhand-tool-text">
                      <b>{name}</b>
                      {!tool
                        ? <em>{connected.state === 'loading' ? 'Looking for it…' : 'Not connected in LoomWatch, so it can’t use it yet.'}</em>
                        : tool.problem
                          ? <em className="problem">{tool.problem}</em>
                          : <em>{allowed.length ? 'Asks you before each action, except these, which it always may do:' : `Asks you before each of its ${actionCount(tool.calls.length)}.`}</em>}
                      {tool?.example && !tool.problem && <em className="byhand-tool-try">Try asking: “{tool.example}”</em>}
                      {allowed.length > 0 && <ul className="byhand-tool-allowed" aria-label={`Always allowed for ${name}`}>
                        {allowed.map((call) => <li key={call}>{label(call)}<button type="button" className="iconbtn" aria-label={`Ask again before ${label(call)}`} onClick={() => set('toolAllow', withoutAllowed(draft.toolAllow, name, call))}><X size={11} aria-hidden="true" /></button></li>)}
                      </ul>}
                    </span>
                    <span className="byhand-tool-actions">
                      {!tool && connected.state === 'ready' && <button type="button" className="btn" onClick={() => setConnecting('new')}>Connect</button>}
                      {tool?.problem && tool.auth === 'signIn' && <button type="button" className="btn" onClick={() => setConnecting(tool)}>Sign in again</button>}
                      <button type="button" className="iconbtn" aria-label={`Take ${name} away`} onClick={() => set('tools', draft.tools.filter((item) => item !== name))}><X size={12} aria-hidden="true" /></button>
                    </span>
                  </li>
                )
              })}
            </ul>}
            {toGive.length > 0 && !connecting && <div className="byhand-tools-give">
              <p className="t-meta">Give it a tool you connected</p>
              <ul className="connect-tool-list" aria-label="Tools you can give it">
                {toGive.map((tool) => <li key={tool.id}><button type="button" onClick={() => giveTool(tool.name)}><span className="connect-tool-name"><ToolIcon name={tool.name} icon={tool.icon} size={24} /><b>{tool.name}</b></span><span>{actionCount(tool.calls.length)}</span><em><Plus size={12} aria-hidden="true" /> Give it {tool.name}</em></button></li>)}
              </ul>
            </div>}
            {connecting && connected.state === 'ready'
              ? <ConnectTool
                  catalog={connected.catalog}
                  connected={connected.tools}
                  keptIn={connected.keptIn}
                  resume={connecting === 'new' ? null : connecting}
                  onClose={() => setConnecting(null)}
                  onConnected={(tool) => { setConnecting(null); connected.refresh(); giveTool(tool.name) }}
                />
              : connected.state === 'ready'
                ? <button type="button" className="btn byhand-tools-connect" onClick={() => setConnecting('new')}><Plug size={14} aria-hidden="true" />Connect a new tool</button>
                : connected.state === 'unavailable' && <p className="t-meta">{connected.message}</p>}
            {givenTools.length > 0 && <p className="t-meta">A tool works in your own account on its site, so it asks you before each action, and the card lets you always allow one. On a schedule nobody can answer, so actions you haven’t always allowed are declined.</p>}
          </>)}

          {block('keys', <ul className="byhand-keys">
            {FIGURE_KEYS.map(({ key, word }) => {
              const on = draft.allow[key] === true
              const info = ALLOW_SWITCHES.find((item) => item.key === key)!
              return (
                <li key={key} className={on ? 'on' : ''}>
                  <KeyRound size={15} aria-hidden="true" />
                  <span><b>{word}</b> · {info.label.toLowerCase()}<em>{on ? info.on : 'It asks you first. On a schedule nobody is there to answer, so it is declined.'}</em></span>
                  {/* A key is offered, not the page's main action: Save is its one gold fill. */}
                  <button type="button" className="btn" onClick={() => giveKey(key, !on)}>{on ? 'Take it back' : 'Hand it over'}</button>
                </li>
              )
            })}
          </ul>)}

          {block('reply', <ReplyField role={draft.instructions} readOnly={readOnly} onChange={(role) => set('instructions', role)} />)}
          {learned && <LearnedBlock of={learned} name={draft.name.trim() || 'this agent'} readOnly={readOnly} />}
        </div>
      </div>
      {market && <Suspense fallback={null}><SkillsMarket agentName={draft.name.trim() || 'your new agent'} query={market.query} onClose={backFromMarket} /></Suspense>}
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
 * from quiet; the run's events so far, each one flickering its screen; and, while it runs, what its
 * agent is at (reading, thinking, using a tool or typing), what it is thinking about, and what on
 * its bench it just used (a skill, a folder, a tool) for its figure to go and get, from those events. The record counts its
 * events only once the run is over, so while it runs they are counted as they arrive.
 */
function useFigureMood(record: RunRecord | null, kit: BenchKit) {
  const live = record?.status === 'running'
  const now = useNow(live)
  const followed = useSessionEvents(live ? record.sessionId : '').events
  const arrived = followed.length
  const [moved, setMoved] = useState<{ run: string; events: number; at: number } | null>(null)
  const run = record?.runId ?? null
  const events = live ? arrived : record?.eventCount ?? 0
  // When the run moves, note when (adjusting state while rendering, not in an effect).
  if (run && (moved?.run !== run || moved.events !== events)) setMoved({ run, events, at: now })
  const phase = live ? workPhase(followed, record.responder || null, now) : undefined
  const thought = live && phase === 'thinking' ? thoughtLine(followed, record.responder || null) : null
  // The same uses keep the same list, so the bench is told only when there is a new one.
  const fresh = live ? benchUses(followed, record.responder || null, now, kit) : []
  const [uses, setUses] = useState<readonly BenchUse[]>([])
  if (fresh.length > 0 && fresh.map((use) => use.id).join() !== uses.map((use) => use.id).join()) setUses(fresh)
  // Its helpers (ADR 0079), each acting out its own events as the figure acts out its agent's; one
  // that finished stays a moment to hand its part back, then goes.
  const helpers: BenchHelper[] = live
    ? helpersOf(followed)
      .filter((helper) => helper.state === 'working' || now - Date.parse(helper.finishedAt ?? '') < HELPER_LINGER_MS)
      .map((helper) => ({ id: helper.id, state: helper.state === 'stopped' ? 'failed' as const : helper.state, phase: helper.state === 'working' ? workPhase(followed, helper.id, now) : null }))
    : []
  return { mood: figureMood(record, moved && moved.run === run ? moved.at : null, now), events, phase, thought, uses, helpers }
}

/** How long a helper that finished stays at the bench, handing its part back, before it goes. */
const HELPER_LINGER_MS = 3500

/** What the skills shelf says: recipe cards on the pegboard. */
const SHELF = {
  skill: {
    Icon: Puzzle,
    chosen: 'Recipe cards on its pegboard',
    none: 'None yet. A skill is a recipe card: instructions it opens when the work calls for it. Click one below to read it, press + to pin it up, or drag it onto the bench.',
    noneToGive: 'None yet. A skill is a recipe card: instructions it opens when the work calls for it. LoomWatch has none to give yet, so find some in the marketplace.',
    looking: 'Looking for recipe cards…',
    find: (count: number) => `Find a recipe card (${count} in LoomWatch)`,
    findLabel: 'Find a skill',
    list: 'Recipe cards you can add',
    take: (name: string) => `Take ${name} down`,
    give: (name: string) => `Pin ${name} up`,
    read: (name: string) => `Read ${name}`,
    market: 'Find skills in the marketplace',
    marketFor: (query: string) => `Search the marketplace for “${query}”`,
    fromMarket: (names: readonly string[]) => `Pinned up ${listNames(names)} from the marketplace.`,
  },
} as const

/**
 * The skills it has, each with a way to take it off, and the others LoomWatch has to give it. They
 * can also be dragged onto the bench, where they are pinned up as recipe cards. LoomWatch gets more
 * from the marketplace (`onMarket`, with what was typed when nothing here matches it). Any of them,
 * pinned up or not, opens to be read in full (SkillDetails).
 */
function Shelf({ kind, chosen, available, loading, onAdd, onRemove, onDrag, onMarket, fromMarket = [] }: { kind: 'skill'; chosen: readonly string[]; available: readonly DetectedCapability[]; loading: boolean; onAdd: (name: string) => void; onRemove: (name: string) => void; onDrag?: (kind: 'skill' | null) => void; onMarket?: (query: string) => void; fromMarket?: readonly string[] }) {
  const words = SHELF[kind]
  const ids = useId()
  const [query, setQuery] = useState('')
  // The skill open to be read, by name: pinning it up moves it from the cards to the pegboard.
  const [reading, setReading] = useState<string | null>(null)
  const named = (name: string) => available.find((item) => item.name === name)
  const open = reading ? named(reading) : undefined
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const seen = new Set<string>()
    return available.filter((item) => !chosen.includes(item.name) && (!needle || `${item.name} ${item.detail}`.toLowerCase().includes(needle))).filter((item) => (seen.has(item.name) ? false : (seen.add(item.name), true))).slice(0, 12)
  }, [available, chosen, query])
  return (
    <div className="byhand-shelf">
      {chosen.length > 0
        ? <ul className="skill-picker-chosen" aria-label={words.chosen}>{chosen.map((name) => (
          <li key={name}>
            <words.Icon size={12} aria-hidden="true" />
            {/* One LoomWatch can't find any more has nothing to read. */}
            {named(name) ? <button type="button" className="skill-picker-open" data-skill={name} aria-label={words.read(name)} onClick={() => setReading(name)}>{name}</button> : name}
            <button type="button" className="iconbtn" aria-label={words.take(name)} onClick={() => onRemove(name)}><X size={12} aria-hidden="true" /></button>
          </li>
        ))}</ul>
        : <p className="t-meta">{onMarket && !loading && available.length === 0 ? words.noneToGive : words.none}</p>}
      {fromMarket.length > 0 && <p className="t-meta byhand-shelf-news" role="status">{words.fromMarket(fromMarket)}</p>}
      <label className="skill-picker-find"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={loading ? words.looking : words.find(available.length)} aria-label={words.findLabel} /></label>
      <ul className={`byhand-cards${onDrag ? '' : ' still'}`} aria-label={words.list}>
        {found.map((item) => (
          <li key={item.id} draggable={Boolean(onDrag)} onDragStart={onDrag && ((event) => { event.dataTransfer.setData(SKILL_MIME, item.name); event.dataTransfer.effectAllowed = 'copy'; onDrag('skill') })} onDragEnd={onDrag && (() => onDrag(null))} title={onDrag ? 'Click to read it, or drag it onto the bench' : undefined}>
            <span className="byhand-card-tab" aria-hidden="true" />
            <button type="button" className="byhand-card-open" data-skill={item.name} aria-label={words.read(item.name)} aria-describedby={`${ids}-${item.id}`} onClick={() => setReading(item.name)}>
              <b>{item.name}</b>
              <span id={`${ids}-${item.id}`}>{item.detail || item.source}</span>
            </button>
            <button type="button" className="iconbtn" aria-label={words.give(item.name)} title={words.give(item.name)} onClick={() => onAdd(item.name)}><Plus size={13} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
      {onMarket && <button type="button" className="btn byhand-market" onClick={() => { const typed = found.length ? '' : query.trim(); if (typed) setQuery(''); onMarket(typed) }}><Store size={14} aria-hidden="true" />{query.trim() && !found.length ? words.marketFor(query.trim()) : words.market}</button>}
      {open && <SkillDetails key={open.id} item={open} pinned={chosen.includes(open.name)} onPin={() => { onAdd(open.name); setReading(null) }} onTakeDown={() => { onRemove(open.name); setReading(null) }} onClose={() => setReading(null)} />}
    </div>
  )
}

/** The bench in one sentence, for anyone who reads rather than looks, and for screen readers. */
function sentence(draft: AgentDraft, model: string, reads: readonly ReadSource[]): ReactNode {
  const name = draft.name.trim() || 'This agent'
  const has = FIGURE_KEYS.filter(({ key }) => draft.allow[key]).map(({ word }) => word.toLowerCase())
  const keys = has.length ? `It has the ${has.join(' and ')} key${has.length === 1 ? '' : 's'}; for anything else it asks you first.` : 'It has no keys, so it asks you before it searches the web, changes files or runs a command.'
  const skills = draft.skills.length ? `${draft.skills.length} recipe card${draft.skills.length === 1 ? '' : 's'}` : 'no recipe cards yet'
  return <><b>{name}</b> thinks with {model}, has {skills}, and reads {reads.length ? readCount(reads) : 'nothing yet'}. {keys}</>
}

/**
 * What it reads, in words, for the line under the block's title: what it reads in every team, and
 * in a team what that team gives it besides. A team's own agent is only ever in its team.
 */
function readsSay(own: readonly ReadSource[], teamGives: readonly ReadSource[], teamOwn: boolean): string {
  if (teamOwn) return own.length ? `Reads ${readCount(own)}` : 'Nothing yet'
  if (!own.length) return teamGives.length ? `Reads ${readCount(teamGives)} this team gives it` : 'Nothing yet'
  const everywhere = `Reads ${readCount(own)} in every team it joins`
  return teamGives.length ? `${everywhere}, and ${readCount(teamGives)} this team gives it` : everywhere
}

/**
 * The file drawer's block: what it reads, each with where it is. One of Your agents is given a
 * folder, a file or a Notion page right here, and reads it in every team it joins; a file is kept
 * in the teams folder's `.jobs/.files/`, so every team reads the same one. What a team gives it
 * besides is listed after, and is changed in that team's Workflow. A team's own agent (`teamOwn`)
 * is given everything here or there alike, as cards wired to it, and a file is kept beside the team
 * file (in `.jobs/.files/` while the team has never been saved).
 */
function Reads({ reads, own, teamOwn, inTeam, readOnly, agentName, onGive, onTakeAway, onShowWorkflow }: { reads: readonly ReadSource[]; own: number; teamOwn?: { teamPath: string | null }; inTeam: boolean; readOnly: boolean; agentName: string; onGive: (read: AgentRead) => void; onTakeAway: (key: string) => void; onShowWorkflow?: () => void }) {
  const [picking, setPicking] = useState<'folder' | 'page' | null>(null)
  const [adding, setAdding] = useState(false)
  const [notes, setNotes] = useState<{ text: string; failed: boolean }[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const giving = !readOnly
  // Notion is asked about only once the agent can be given something here.
  const notion = useNotionConnection(giving)

  const addFiles = async (files: readonly File[]) => {
    if (!files.length) return
    setAdding(true)
    const next: { text: string; failed: boolean }[] = []
    for (const file of files) {
      try {
        const stored = await (teamOwn?.teamPath ? addTeamFile(teamOwn.teamPath, file) : addAgentFile(file))
        onGive({ name: stored.name, path: stored.path })
        if (stored.note) next.push({ text: `${stored.name}: ${stored.note}`, failed: false })
      } catch (caught) {
        next.push({ text: `${file.name} wasn’t added: ${caught instanceof Error ? caught.message : String(caught)}`, failed: true })
      }
    }
    setNotes(next)
    setAdding(false)
  }

  // A team's own agent is given it here as well as in Workflow, so that button only goes to see it.
  const workflowLabel = teamOwn ? (reads.length ? 'See it in Workflow' : null) : !own ? (reads.length ? 'Change it in Workflow' : 'Give it something in Workflow') : 'Give it more in Workflow'
  return (
    <>
      {reads.length > 0 && <ul className="byhand-reads" aria-label="In its file drawer">
        {reads.map((source, index) => {
          const Icon = source.kind === 'page' ? NotebookText : source.kind === 'file' ? FileText : Folder
          const mine = index < own
          return (
            <li key={`${source.key ?? `${source.kind}:${source.where}`}:${index}`} className={mine ? undefined : 'team'}>
              <Icon size={15} aria-hidden="true" />
              <span>
                <b>{source.name}</b>
                <em title={source.where}>{source.kind === 'page' ? source.where : `${source.kind === 'file' ? 'File' : 'Folder'} · ${middleTruncate(source.where, 64)}`}</em>
                {!mine && <em className="byhand-reads-team">This team gives it</em>}
              </span>
              {mine && giving && source.key && <button type="button" className="iconbtn" aria-label={`Stop reading ${source.name}`} onClick={() => onTakeAway(source.key!)}><X size={12} aria-hidden="true" /></button>}
            </li>
          )
        })}
      </ul>}
      {reads.length > READ_SLOTS && <p className="t-meta">The drawer has room for {READ_SLOTS}, so {listNames(reads.slice(READ_SLOTS).map((source) => source.name))} {reads.length - READ_SLOTS === 1 ? 'isn’t' : 'aren’t'} in it. It still reads {reads.length - READ_SLOTS === 1 ? 'it' : 'them'}.</p>}
      {giving && <>
        <div className="byhand-reads-give" role="group" aria-label="Give it something to read">
          <button type="button" className="btn" onClick={() => setPicking('folder')}><FolderPlus size={14} aria-hidden="true" />Folder</button>
          <button type="button" className="btn" disabled={adding} onClick={() => fileInput.current?.click()}><FilePlus2 size={14} aria-hidden="true" />{adding ? 'Adding…' : 'File'}</button>
          {notion.state === 'connected'
            ? <button type="button" className="btn" onClick={() => setPicking('page')}><NotebookText size={14} aria-hidden="true" />Notion page</button>
            : notion.state === 'disconnected'
              ? <a className="btn" href={CONNECT_NOTION_HREF} target="_blank" rel="noopener" title="Connect Notion first, then choose a page"><NotebookText size={14} aria-hidden="true" />Notion page<ExternalLink size={12} aria-hidden="true" /></a>
              : <button type="button" className="btn" disabled title={notion.state === 'unavailable' ? notion.message : 'Checking the Notion connection…'}><NotebookText size={14} aria-hidden="true" />Notion page</button>}
          <input ref={fileInput} type="file" multiple hidden aria-label="Files it reads" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files) }} />
        </div>
        {notes.length > 0 && <ul className="agent-context-notes" aria-live="polite">
          {notes.map((note) => <li key={note.text} className={`t-meta ${note.failed ? 'failed' : ''}`} role={note.failed ? 'alert' : undefined}>{note.text}</li>)}
        </ul>}
      </>}
      <p className="t-meta">{teamOwn
        ? 'Each is a card in Workflow with a line to this agent, and a line drawn there shows here too. A folder is linked where it is; a file is copied into your teams folder.'
        : inTeam
          ? 'What you give it here, it reads in every team it joins. This team can give it more with a line in Workflow.'
          : 'What you give it here, it reads in every team it joins. A folder is linked where it is; a file is copied into your teams folder. A team can give it more in its Workflow.'}</p>
      {onShowWorkflow && workflowLabel && <button type="button" className="btn" onClick={onShowWorkflow}><Network size={14} aria-hidden="true" />{workflowLabel}</button>}
      {picking === 'folder' && <FolderPicker
        onClose={() => setPicking(null)}
        title={`Give ${agentName} a folder`}
        note={`It is given the folder’s list of files and its README, and may open the files in it${teamOwn ? '' : ', in every team it joins'}. The folder is linked, not copied, so every run sees what is in it then.`}
        onChoose={(folder) => { setPicking(null); onGive({ name: folder.name, path: folder.path }) }}
      />}
      {picking === 'page' && <NotionPagePicker
        agentName={agentName}
        given={new Set(reads.flatMap((source) => source.key?.startsWith('notion:') ? [source.key.slice('notion:'.length)] : []))}
        onClose={() => setPicking(null)}
        onChoose={(page) => { setPicking(null); onGive({ name: page.title || 'Notion page', notion: { page: page.id } }) }}
      />}
    </>
  )
}

/**
 * What it hands back, written right here: the part of its instructions that says it (desk.ts
 * `replySection`), so a change here is a change there. While you write in it, it keeps to the
 * part you started in, even once it no longer reads like a reply; with none yet, what you write
 * is added after the rest of its instructions.
 */
function ReplyField({ role, readOnly, onChange }: { role: string; readOnly: boolean; onChange: (role: string) => void }) {
  const [held, setHeld] = useState<{ role: string; start: number; text: string } | null>(null)
  // The part being written in, as long as nothing else has changed the instructions since.
  const part = held?.role === role ? held : replySection(role)
  const text = part?.text ?? ''
  const write = (next: string) => {
    if (readOnly) return
    const written = withReply(role, part, next)
    setHeld({ role: written.role, ...written.section })
    onChange(written.role)
  }
  return (
    <>
      <textarea
        className="agent-instructions byhand-reply-field"
        rows={Math.min(10, Math.max(3, text.split('\n').length + 1))}
        value={text}
        readOnly={readOnly}
        onChange={(event) => write(event.target.value)}
        placeholder="e.g. Reply with a three-line summary, then each source as a link."
        aria-label="What it hands back"
      />
      <p className="t-meta">Part of its instructions. Say what it replies with, and in what shape: the next agent, or you, gets exactly that.</p>
    </>
  )
}

/** What it reads, counted in words: "1 folder", "2 folders and 1 Notion page". */
function readCount(reads: readonly ReadSource[]): string {
  const words = ([['folder', 'folder'], ['file', 'file'], ['page', 'Notion page']] as const).flatMap(([kind, word]) => {
    const count = reads.filter((source) => source.kind === kind).length
    return count ? [`${count} ${word}${count === 1 ? '' : 's'}`] : []
  })
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? 'nothing'
}

/** What its tools add up to, in words, for the line under the block's title and the tool drawer. */
function toolsSay(given: readonly { name: string; tool: ConnectedTool | undefined }[], loading: boolean): string {
  const builtIn = 'Files, the web and commands'
  if (!given.length) return `${builtIn}, as its keys allow`
  const usable = given.filter((item) => item.tool).map((item) => item.name)
  const missing = given.length - usable.length
  const plus = usable.length ? `${builtIn}, plus ${listNames(usable)}` : builtIn
  if (!missing || loading) return plus
  return `${plus}; ${missing} tool${missing === 1 ? ' isn’t' : 's aren’t'} connected`
}

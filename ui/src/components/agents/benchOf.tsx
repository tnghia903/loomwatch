import { useMemo, useState } from 'react'

import { shortName } from '../../lib/ai/client'
import { effortWord, modelEfforts, placeEffort } from '../../lib/ai/efforts'
import { modelNameFromId } from '../../lib/ai/modelIds'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { useModels } from '../../lib/ai/useModels'
import { helpersOf } from '../../lib/chat/helpers'
import { listNames } from '../../lib/format'
import { replyLine, replySection } from '../../lib/library/desk'
import { draftFromJob, type AgentDraft } from '../../lib/library/draft'
import { askedKey, CARD_SLOTS, FIGURE_KEYS, figureMood, READ_SLOTS, TOOL_SLOTS, type BenchUse, type ReadSource } from '../../lib/library/figure'
import { figureFor } from '../../lib/library/figures'
import type { SavedJob } from '../../lib/library/jobs'
import { knowledgeOf } from '../../lib/library/reads'
import { readsOf } from '../../lib/library/teamDraft'
import type { RunRecord } from '../../lib/runs/client'
import { ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { INSTRUCTION_PARTS, instructionShape } from '../../lib/team-file/checkup'
import type { AllowSwitch } from '../../lib/team-file/types'
import { toolNamed, useConnectedTools, type ConnectedTool } from '../../lib/tools/client'
import { useNow } from '../../lib/useNow'
import { useSessionEvents } from '../../lib/watch/useSessionEvents'
import { benchUses, thoughtLine, workPhase, type BenchKit } from '../../lib/watch/workPhase'
import type { BenchLabel } from './AgentFigure'
import type { BenchHelper, BenchView } from './workbenchScene'

/**
 * What the workbench shows of an agent, and the words on its labels, worked out from its settings
 * and its newest run: the builder (ByHand) draws it to edit, and the island's box (ADR 0083,
 * decision 11) to look at, so both draw the same bench. Only types come from the bench itself, so
 * three.js is fetched only where it is drawn.
 */

/** What the labels are made of: the agent's settings, and what the builder has worked out. */
export interface BenchWords {
  draft: AgentDraft
  /** The model it thinks with, by its short name. */
  model: string
  /** How hard it thinks, in a word, lower case; `null` when that isn't set or the model can't. */
  effort: string | null
  /** Everything it reads: its own, and in a team what that team gives it. */
  reads: readonly ReadSource[]
  /** What it reads and what its tools add up to, in words (`readsSay`, `toolsSay`). */
  readsSaid: string
  toolsSaid: string
  /** The key its run is asking for, if any. */
  asked: AllowSwitch | null
}

/** The bench's labels: each thing on it, in words, long and short. */
export function benchLabels({ draft, model, effort, reads, readsSaid, toolsSaid, asked }: BenchWords): BenchLabel[] {
  const shape = { ...instructionShape(draft.instructions), ...(draft.doneWhen.length ? { check: true } : {}) }
  const replyPart = replySection(draft.instructions)
  // Each switch by its own short name, as on the agent's card: "Edit files", not the bench key's "Files".
  const given = FIGURE_KEYS.filter(({ key }) => draft.allow[key]).map(({ key }) => ({ key, word: switchName(key) }))
  const kept = FIGURE_KEYS.filter(({ key }) => !draft.allow[key]).map(({ key }) => ({ key, word: switchName(key) }))
  const thinks = effort ? `${model} · ${effort} effort` : model
  const name = draft.name.trim() || 'New agent'
  const more = draft.skills.length > CARD_SLOTS ? ` (${draft.skills.length - CARD_SLOTS} not shown)` : ''
  // The two sides of "what it may do without asking", in its card's words (AgentBadge): what it is
  // allowed, and what it asks you first. The bench draws them as keys on hooks and keys in a dish,
  // but the words never ask anyone to read that picture (and a "key" is what pays for models).
  const keysText = given.length ? `Allowed · ${given.map((item) => item.word).join(', ')}` : 'Allowed · nothing'
  const asking = asked && !draft.allow[asked] ? switchName(asked) : null
  const dishText = asking ? `It’s asking to ${ALLOW_SWITCHES.find(({ key }) => key === asked)?.label.toLowerCase() ?? asking.toLowerCase()}` : kept.length ? `Asks you first · ${kept.map((item) => item.word).join(', ')}` : 'Asks you first · nothing'
  // More than a drawer has room for still count, as skills past the pegboard's do: the label says
  // how many aren't in it. It gives only the total then, so the two drawers' labels stay short
  // enough to sit side by side.
  const readsOff = reads.length > READ_SLOTS ? ` (${reads.length - READ_SLOTS} not shown)` : ''
  const toolsOff = draft.tools.length > TOOL_SLOTS ? ` (${draft.tools.length - TOOL_SLOTS} not shown)` : ''
  const readsText = !reads.length ? 'Reads · nothing yet' : reads.length === 1 ? `Reads · ${reads[0].name}` : readsOff ? `Reads · ${reads.length}${readsOff}` : `Reads · ${readCount(reads)}`
  const toolsText = !draft.tools.length ? 'Tools · none yet' : draft.tools.length === 1 ? `Tools · ${draft.tools[0]}` : `Tools · ${draft.tools.length}${toolsOff}`
  return [
    { anchor: 'mind', part: 'mind', place: 'right', text: <>Thinks with <b>{model}</b>{effort && <> · {effort}</>}</>, short: <b>{model}</b>, label: `Thinks with ${thinks}` },
    { anchor: 'job', part: 'job', place: 'above', text: <>The job <span className="byhand-parts">{INSTRUCTION_PARTS.map((part) => <i key={part} className={shape[part] ? 'on' : ''} />)}</span></>, short: 'Job', label: 'The job: its instructions' },
    { anchor: 'skills', part: 'skills', place: 'above', text: `Skills · ${draft.skills.length || 'none yet'}${more}`, short: `Skills · ${draft.skills.length}`, label: `Skills: ${draft.skills.length || 'none yet'}${more}` },
    { anchor: 'keys', part: 'keys', place: 'above', text: keysText, short: `Allowed · ${given.length}`, label: `Allowed without asking: ${given.length ? given.map((item) => item.word).join(', ') : 'nothing'}` },
    { anchor: 'dish', part: 'keys', place: 'below', text: dishText, short: asking ? `Asking: ${asking}` : `Asks first · ${kept.length}`, label: asking ? dishText : `What it asks you first: ${kept.length ? kept.map((item) => item.word).join(', ') : 'nothing'}` },
    { anchor: 'reply', part: 'reply', place: 'above', text: `Hands back · ${replyPart ? 'said in its instructions' : 'not said yet'}`, short: 'Hands back', label: `What it hands back: ${replyPart ? 'said in its instructions' : 'not said yet'}` },
    // Under the bench's two drawers, on its face: what it works with, apart from the work on top.
    { anchor: 'reads', part: 'reads', place: 'below', text: readsText, short: `Reads · ${reads.length}`, label: `What it reads: ${readsSaid}${readsOff}` },
    { anchor: 'tools', part: 'tools', place: 'below', text: toolsText, short: `Tools · ${draft.tools.length}`, label: `Tools it can use: ${toolsSaid}${toolsOff}` },
    { anchor: 'name', part: 'name', place: 'plate', label: `Name: ${name}` },
    { anchor: 'app', part: 'app', place: 'plate', label: `The model it thinks with: ${model}` },
  ]
}

/** A switch's short name, as the agent's card shows it: "Web", "Edit files", "Commands". */
function switchName(key: AllowSwitch): string {
  return ALLOW_SWITCHES.find((item) => item.key === key)?.short ?? key
}

/**
 * The figure's mood, from the run record, on the shared clock while the run is live, to tell working
 * from quiet; the run's events so far, each one flickering its screen; and, while it runs, what its
 * agent is at (reading, thinking, using a tool or typing), what it is thinking about, and what on
 * its bench it just used (a skill, a folder, a tool) for its figure to go and get, from those events. The record counts its
 * events only once the run is over, so while it runs they are counted as they arrive.
 */
export function useFigureMood(record: RunRecord | null, kit: BenchKit) {
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

/**
 * One of My agents at its workbench, to look at (the island's box): as it is saved, at rest, or
 * acting out `record`, its newest run in its own chat, while that runs.
 */
export function useSavedBench(job: SavedJob, record: RunRecord | null): { view: BenchView; labels: BenchLabel[] } {
  const draft = useMemo(() => draftFromJob(job), [job])
  const figure = useMemo(() => figureFor(job.id, job.figure), [job.id, job.figure])
  const { catalog } = useModels()
  const listed = catalog?.models.find((item) => item.id === draft.model)
  const model = listed ? shortName(listed) : modelNameFromId(draft.model)
  const ai = useAiStatus()
  const runsAt = placeEffort(draft.effort, modelEfforts(draft.model, ai, catalog)).runs
  const effort = runsAt ? effortWord(runsAt).toLowerCase() : null
  const connected = useConnectedTools()
  const ready = connected.state === 'ready' ? connected.tools : null
  const tools = useMemo(() => draft.tools.map((name) => ({ name, icon: (ready && toolNamed(ready, name)?.icon) || null })), [draft.tools, ready])
  const reads = useMemo(() => readsOf({ capabilities: knowledgeOf(draft.reads) }), [draft.reads])
  const kit = useMemo<BenchKit>(() => ({ skills: draft.skills, reads, tools: draft.tools }), [draft.skills, reads, draft.tools])
  const { mood, events, phase, thought, uses, helpers } = useFigureMood(record, kit)
  const asked = askedKey(record)
  const view = useMemo<BenchView>(() => ({
    look: { name: draft.name, instructions: draft.instructions, app: draft.model, model: `${draft.model}|${draft.effort}`, skills: draft.skills, allow: draft.allow },
    figure,
    does: draft.does,
    appName: model,
    hasReply: Boolean(replyLine(draft.instructions)),
    mood,
    events,
    phase,
    thought,
    uses,
    asked,
    open: null,
    dropping: false,
    reads,
    tools,
    helpers,
  }), [draft, figure, model, mood, events, phase, thought, uses, asked, reads, tools, helpers])
  const given = draft.tools.map((name) => ({ name, tool: ready ? toolNamed(ready, name) : undefined }))
  const labels = benchLabels({ draft, model, effort, reads, readsSaid: readsSay(reads, [], false), toolsSaid: toolsSay(given, connected.state === 'loading'), asked })
  return { view, labels }
}

/**
 * What it reads, in words, for the line under the block's title: what it reads in every team, and
 * in a team what that team gives it besides. A team's own agent is only ever in its team.
 */
export function readsSay(own: readonly ReadSource[], teamGives: readonly ReadSource[], teamOwn: boolean): string {
  if (teamOwn) return own.length ? `Reads ${readCount(own)}` : 'Nothing yet'
  if (!own.length) return teamGives.length ? `Reads ${readCount(teamGives)} this team gives it` : 'Nothing yet'
  const everywhere = `Reads ${readCount(own)} in every team it joins`
  return teamGives.length ? `${everywhere}, and ${readCount(teamGives)} this team gives it` : everywhere
}

/** What it reads, counted in words: "1 folder", "2 folders and 1 Notion page". */
export function readCount(reads: readonly ReadSource[]): string {
  const words = ([['folder', 'folder'], ['file', 'file'], ['page', 'Notion page']] as const).flatMap(([kind, word]) => {
    const count = reads.filter((source) => source.kind === kind).length
    return count ? [`${count} ${word}${count === 1 ? '' : 's'}`] : []
  })
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? 'nothing'
}

/** What its tools add up to, in words, for the line under the block's title and the tool drawer. */
export function toolsSay(given: readonly { name: string; tool: ConnectedTool | undefined }[], loading: boolean): string {
  const builtIn = 'Files, the web and commands'
  if (!given.length) return `${builtIn}, as you allow`
  const usable = given.filter((item) => item.tool).map((item) => item.name)
  const missing = given.length - usable.length
  const plus = usable.length ? `${builtIn}, plus ${listNames(usable)}` : builtIn
  if (!missing || loading) return plus
  return `${plus}; ${missing} tool${missing === 1 ? ' isn’t' : 's aren’t'} connected`
}

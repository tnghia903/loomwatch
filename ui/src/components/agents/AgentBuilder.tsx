import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ExternalLink, MessagesSquare, Trash2, Wrench } from 'lucide-react'

import { shortName } from '../../lib/ai/client'
import { effortWord, modelEfforts, placeEffort } from '../../lib/ai/efforts'
import { modelNameFromId } from '../../lib/ai/modelIds'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { useModels } from '../../lib/ai/useModels'
import type { DetectedCapability } from '../../lib/library/client'
import { BLANK_DRAFT, blankDraft, draftChanged, draftFromJob, draftFromPreset, specFromDraft, type AgentDraft } from '../../lib/library/draft'
import type { ReadSource } from '../../lib/library/figure'
import { figureFor, freshFigure } from '../../lib/library/figures'
import { JobApiError, jobIdFor, removeJob, saveJob, useSavedJobs, versionOf, type JobSpec, type SavedJob } from '../../lib/library/jobs'
import { usePinnedAgent } from '../../lib/library/pinned'
import { ROLE_PRESETS } from '../../lib/library/roles'
import type { TeamKnowledge } from '../../lib/library/teamDraft'
import { teamAgentHref, useAgentUses } from '../../lib/library/uses'
import { relativeTime } from '../../lib/format'
import { isMac } from '../../lib/platform'
import { PINNED_SHORTCUT_WORDS } from '../../island/bridge'
import type { RunRecord } from '../../lib/runs/client'
import type { LeaveGuard } from '../rail/CrewRail'
import type { ChipState } from '../ui/glyphs'
import { SegmentThumb } from '../ui/SegmentThumb'
import { AgentChip } from './AgentChip'
import type { AgentBarSlots } from './AgentFrame'
import { AgentBadge } from './AgentBadge'
import { useBenchFile } from '../../lib/files/useBenchFile'
import { AgentAnswer, AgentChat, AgentFile } from './AgentChat'
import { ByHand } from './ByHand'
import { FigurePicker } from './FigurePicker'
import { navigate, withView, type AgentView } from './route'
import { withAllowed } from '../../lib/tools/allow'

export interface AgentBuilderProps {
  /** The saved agent's id, or `null` for a new one. */
  id: string | null
  /** A built-in job a new agent starts from. */
  startFrom?: string | null
  skills: DetectedCapability[]
  skillsLoading: boolean
  /** The team the operator came from ("Edit in Your agents"), so the way back is one click. */
  cameFrom?: string | null
  /** Which tab of its page is open, from the address: Build, or its Chat. Inside a team the page keeps it. */
  view?: AgentView
  /**
   * Shown inside a team's Agents tab, for an agent placed from Your agents: there is no page to
   * go back to, and every save is followed by moving that team to the version just saved, from the
   * version it had (`previous`). What the team gives it to read besides its own stays the team's
   * (lib/library/link.ts), so its file drawer shows both, and what its chat sends from here reads
   * the same (`knowledge`); its tools are the version's, like its skills.
   */
  inTeam?: { name: string; onSaved: (job: SavedJob, previous: Pick<JobSpec, 'reads'> | null) => void; reads: readonly ReadSource[]; knowledge: TeamKnowledge; onShowWorkflow?: () => void }
  /** Kept up to date with what moving to another agent would lose (the rail asks it first). */
  leaveRef?: MutableRefObject<LeaveGuard | null>
  /**
   * On its own page in My agents: the places in the page's header (AgentFrame) for its name chip
   * and its tabs, as a team's page has them. Absent inside a team, where the agent keeps its own
   * head under the team's.
   */
  bar?: AgentBarSlots
}

/** `bumped`: the save changed what teams copy, so the teams that use it have an update ready. */
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; bumped: boolean } | { kind: 'error'; message: string }

/**
 * One of Your agents, on its own page with two tabs, as a team has its own: Build and Chat.
 *
 * Build is its workbench (ByHand): every setting, each in one place, with what you picked open
 * beside it, then what its settings add up to (the ID card), where it is used and how it got here
 * (its versions). Chat is where you work with it before any team depends on it, and after (AgentChat):
 * the same bench, with the figure working as the chat's newest work says, beside the conversation.
 * Saving a change a team would copy makes the next version; teams keep theirs until they Update.
 *
 * Inside a team (`inTeam`) it has the same two tabs, and its Chat is the one it has in Your agents:
 * talking to one agent on its own is a different thing from giving the team work in the team's chat.
 */
export function AgentBuilder({ id, startFrom = null, skills, skillsLoading, cameFrom = null, view: asked = 'build', inTeam, leaveRef, bar }: AgentBuilderProps) {
  // Inside a team the address is the team's, so the page keeps which tab is open.
  const [teamView, setTeamView] = useState<AgentView>('build')
  const view: AgentView = inTeam ? teamView : asked
  const { jobs, available, loaded } = useSavedJobs()
  const pinned = usePinnedAgent()
  const ai = useAiStatus()
  const saved = useMemo(() => (id ? jobs.find((job) => job.id === id) ?? null : null), [jobs, id])
  const [base, setBase] = useState<AgentDraft | null>(null)
  const [draft, setDraft] = useState<AgentDraft>(BLANK_DRAFT)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [removing, setRemoving] = useState(false)
  const roleField = useRef<HTMLTextAreaElement>(null)
  const [benchRecord, setBenchRecord] = useState<RunRecord | null>(null)
  // A long answer from the chat, read in full over the bench.
  const [answerRun, setAnswerRun] = useState<string | null>(null)
  // A file its answers name, read over the bench too (ADR 0077).
  const benchFile = useBenchFile()

  // Start once per agent: from the saved version, from a built-in job, or blank on the default model.
  // Later reloads of the list (every save anywhere) must never overwrite edits on screen.
  const [startedFor, setStartedFor] = useState<string | null>(null)
  // What a new agent started as, so moving away from it asks only once something was changed.
  const [startedAs, setStartedAs] = useState<AgentDraft | null>(null)
  const startKey = id ?? `new:${startFrom ?? ''}`
  if (startedFor !== startKey) {
    if (id && saved) {
      setStartedFor(startKey)
      const from = draftFromJob(saved)
      setBase(from)
      setDraft(from)
    } else if (!id && loaded && ai) {
      // A new agent waits for what is connected, so its model is one it can run on (ADR 0073).
      setStartedFor(startKey)
      const preset = ROLE_PRESETS.find((candidate) => candidate.id === startFrom)
      const from = preset ? draftFromPreset(preset) : blankDraft()
      // A new agent wears a figure none of your agents wears yet, so it is easy to tell apart.
      const worn = jobs.map((job) => figureFor(job.id, job.figure))
      const started = { ...from, figure: freshFigure(`${startKey}:${jobs.length}`, worn) }
      setBase(null)
      setStartedAs(started)
      setDraft(started)
    }
  }

  const { catalog } = useModels()
  const listed = catalog?.models.find((model) => model.id === draft.model)
  const modelName = listed ? shortName(listed) : modelNameFromId(draft.model)
  // What it runs at on this model, as the slider and the bench say it.
  const runsAt = placeEffort(draft.effort, modelEfforts(draft.model, ai, catalog)).runs
  const effortName = runsAt ? effortWord(runsAt) : undefined

  const { uses } = useAgentUses()
  const mine = (uses ?? []).filter((use) => saved && use.agent === saved.id)
  // Versions are kept behind the scenes, so a team knows when it has an older copy to update;
  // nobody reads a number.
  const version = saved ? versionOf(saved) : null

  const changed = base ? draftChanged(draft, base) : true
  const problem = !draft.name.trim() ? 'Give it a name.' : !draft.instructions.trim() ? 'Write its instructions.' : null
  // What leaving would lose: changes to a saved agent, or a new one changed since it began. The
  // browser asks before the page goes (the brand, a menu item, closing it); the rail asks itself.
  const unsaved = base ? changed : startedAs !== null && draftChanged(draft, startedAs)
  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => { setDraft((current) => ({ ...current, [key]: value })); if (save.kind !== 'saving') setSave({ kind: 'idle' }) }

  async function doSave(): Promise<boolean> {
    if (problem) return false
    setSave({ kind: 'saving' })
    try {
      const spec = specFromDraft(draft, '')
      const result: SavedJob = saved
        ? await saveJob(saved.id, spec, { replace: true, expectedVersion: versionOf(saved) })
        : await saveJob(jobIdFor(draft.name), spec)
      const next = draftFromJob(result)
      setBase(next)
      setDraft(next)
      setSave({ kind: 'saved', bumped: Boolean(saved) && versionOf(result) > versionOf(saved!) })
      inTeam?.onSaved(result, base ? { reads: base.reads } : null)
      if (!saved) {
        setStartedFor(result.id)
        const query = new URLSearchParams(cameFrom ? { team: cameFrom } : {})
        if (view === 'chat') query.set('view', 'chat')
        navigate(`/agents/${encodeURIComponent(result.id)}${query.size ? `?${query}` : ''}`, true)
      }
      return true
    } catch (failed) {
      const message = failed instanceof JobApiError && failed.status === 412
        ? saved ? failed.message : `You already have an agent called “${draft.name.trim()}”. Give this one another name, or open that one from My agents.`
        : failed instanceof JobApiError && failed.status === 404 ? 'This LoomWatch server is older than My agents. Restart it, then save again.'
        : failed instanceof Error ? failed.message : String(failed)
      setSave({ kind: 'error', message })
      return false
    }
  }

  useEffect(() => {
    if (leaveRef) leaveRef.current = unsaved ? { save: doSave, problem } : null
  })
  useEffect(() => () => { if (leaveRef) leaveRef.current = null }, [leaveRef])

  // What pinning did, said where a save is: where to find the agent now, or that it didn't work.
  const [pinSaid, setPinSaid] = useState<{ ok: boolean; text: string } | null>(null)
  async function togglePin(agent: string, name: string) {
    const pinning = pinned.pinned !== agent
    const before = pinning && pinned.pinned ? jobs.find((job) => job.id === pinned.pinned)?.name ?? null : null
    try {
      await pinned.pin(pinning ? agent : null)
      // The line under the name says what pinning did now, not the last save.
      if (save.kind === 'saved') setSave({ kind: 'idle' })
      setPinSaid({ ok: true, text: pinning ? `Pinned${before ? ` in place of ${before}` : ''}. Press ${PINNED_SHORTCUT_WORDS} in any app, or point at the top middle of your screen, to message ${name}.` : 'Unpinned.' })
    } catch {
      setPinSaid({ ok: false, text: pinning ? `Couldn’t pin ${name}. Try again.` : `Couldn’t unpin ${name}. Try again.` })
    }
  }

  async function doRemove() {
    if (!saved) return
    try { await removeJob(saved.id); navigate('/agents') } catch (failed) { setSave({ kind: 'error', message: failed instanceof Error ? failed.message : String(failed) }); setRemoving(false) }
  }

  if (id && !saved) {
    const missing = <p className="home-empty">{!loaded ? 'Loading…' : available ? `There is no agent “${id}” in My agents.` : 'This LoomWatch server is older than My agents. Restart it to use them.'}</p>
    if (bar) return <div className="agent-builder">{bar.chip && createPortal(<AgentChip name={id} state="clean" detail={!loaded ? 'Loading…' : 'Not in My agents'} />, bar.chip)}{missing}</div>
    return <div className="agent-builder"><a className="link agent-back" href="/agents" onClick={(event) => { event.preventDefault(); navigate('/agents') }}><ArrowLeft size={14} aria-hidden="true" />My agents</a><p className="home-empty">{!loaded ? 'Loading…' : available ? `There is no agent “${id}” in My agents.` : 'This LoomWatch server is older than My agents. Restart it to use them.'}</p></div>
  }

  // Its chat is kept under the id it is saved as, so a new agent saved under the name it had in its
  // chat goes on talking in the same chat. A name one of your agents already has keeps its own.
  const provisional = jobIdFor(draft.name || 'agent')
  const chatId = saved ? saved.id : jobs.some((job) => job.id === provisional) ? `new-${provisional}` : provisional
  const showView = (next: AgentView) => { if (next !== view) { if (inTeam) setTeamView(next); else navigate(withView(next), true) } }
  // The team the operator came from, which the team panel names by its file, absolute or not.
  const cameFromUse = cameFrom ? mine.find((use) => use.teamPath === cameFrom || cameFrom.endsWith(`/${use.teamPath}`)) ?? null : null
  const scheduledUses = mine.filter((use) => use.scheduled).length
  const behindUses = version ? mine.filter((use) => use.version < version).length : 0
  const saveLabel = !saved ? 'Save to My agents' : 'Save'
  const markId = saved?.id ?? (draft.name || 'new')
  const figure = figureFor(saved?.id ?? startKey, draft.figure)
  const badge = <AgentBadge markId={markId} figure={figure} draft={draft} modelName={modelName} effortName={effortName} usedIn={saved ? { teams: mine.length, scheduled: scheduledUses, behind: behindUses } : undefined} />

  const name = draft.name.trim() || 'New agent'
  const saveButton = <button type="button" className="btn btn-primary" data-tour="save-agent" disabled={!changed || Boolean(problem) || save.kind === 'saving'} title={problem ?? undefined} onClick={() => void doSave()}>{save.kind === 'saving' ? 'Saving…' : saveLabel}</button>
  const saveSaid = save.kind === 'saved' ? (save.bumped ? (inTeam ? `Saved, and ${inTeam.name} now uses it. Save the team to keep that.` : mine.length > 0 ? 'Saved. Each team that uses it keeps its copy until you press Update in that team.' : 'Saved.') : 'Saved.')
    : save.kind === 'error' ? <span className="agent-save-error">{save.message}</span> : null
  // Back to the team's agents: that is where an agent is added, or updated.
  const backToTeam = cameFrom && <a className="link agent-back" href={`/?path=${encodeURIComponent(cameFromUse?.teamPath ?? cameFrom)}&view=agents`}>Back to {cameFromUse?.teamName ?? 'the team'}{save.kind === 'saved' && save.bumped ? ' to update it' : ''}</a>
  const bench = (
    <ByHand
      draft={draft} set={set} skills={skills} skillsLoading={skillsLoading} roleField={roleField} figure={figure} record={benchRecord} reads={inTeam?.reads} onShowWorkflow={inTeam?.onShowWorkflow}
      learned={saved ? { savedAgent: saved.id } : null}
      chat={view === 'chat' ? <AgentChat draft={draft} model={draft.model} chatId={chatId} figure={figure} onAllow={(what) => (typeof what === 'string' ? set('allow', { ...draft.allow, [what]: true }) : set('toolAllow', withAllowed(draft.toolAllow, what.tool, what.call)))} onRecord={setBenchRecord} answerRunId={answerRun} onOpenAnswer={setAnswerRun} knowledge={inTeam?.knowledge} file={benchFile.chat} /> : undefined}
      onBuild={() => showView('build')}
      cover={view === 'chat' && benchFile.reading ? <AgentFile bench={benchFile} chatId={chatId} name={name} figure={figure} /> : view === 'chat' && answerRun ? <AgentAnswer runId={answerRun} name={name} onClose={() => setAnswerRun(null)} /> : undefined}
    />
  )
  const side = view === 'build' && (
    <div className="agent-builder-grid">
      <aside className="agent-builder-side">
        {/* Who it is and where it is used, then how it looks: its figure is not part of the bench. */}
        <div className="agent-builder-facts">
          {badge}

          {saved && (
            <section className="agent-section" aria-label="Used in">
              <div className="agent-section-head">Used in</div>
              {uses === null ? <p className="t-meta">Looking through your teams…</p>
                : mine.length === 0 ? <p className="t-meta">No team uses it yet. Open a team and add it from My agents in the add panel.</p>
                : <ul className="agent-uses">
                  {mine.map((use) => (
                    <li key={`${use.teamPath}#${use.agentId}`}>
                      {/* To the team's Agents tab with this agent open, where its Update is. */}
                      <a href={teamAgentHref(use)}>{use.teamName}<ExternalLink size={12} aria-hidden="true" /></a>
                      <span className={`agent-use-version${version && use.version < version ? ' behind' : ''}`}>{version && use.version < version ? 'Update ready there' : 'Up to date'}</span>
                      {use.scheduled && <span className="t-meta">on a schedule</span>}
                    </li>
                  ))}
                </ul>}
            </section>
          )}

          {/* On its own page, Remove is in its name chip's menu, as Delete team is in a team's (ADR 0043). */}
          {saved && !bar && (
            <div className="agent-remove">
              {removing
                ? <><span className="t-meta">Remove it from My agents? Teams keep their copies.</span><button type="button" className="btn" onClick={() => void doRemove()}>Remove</button><button type="button" className="btn" onClick={() => setRemoving(false)}>Keep it</button></>
                : <button type="button" className="link" onClick={() => setRemoving(true)}><Trash2 size={12} aria-hidden="true" />Remove from My agents</button>}
            </div>
          )}
        </div>
        <FigurePicker figure={figure} onChange={(next) => set('figure', next)} />
      </aside>
    </div>
  )

  if (bar) {
    // The name chip says how it is kept, as a team's does: the dot, a line under the name, and Save
    // beside it while there is something to save.
    const state: ChipState = save.kind === 'saving' ? 'saving' : save.kind === 'error' ? 'failed' : problem ? 'incomplete' : !saved ? 'new' : changed ? 'dirty' : save.kind === 'saved' ? 'saved' : 'clean'
    // A saved agent can be kept at the notch of a Mac (ADR 0083): only the island there shows it.
    const pin = saved && isMac() ? { pinned: pinned.pinned === saved.id, onToggle: () => void togglePin(saved.id, name) } : undefined
    const detail = save.kind === 'saving' ? 'Saving…' : save.kind === 'error' ? 'Couldn’t save' : problem ?? (!saved ? 'Not saved yet' : changed ? 'Unsaved changes' : saved.savedAt ? `Saved ${relativeTime(new Date(saved.savedAt))}` : 'Saved')
    return (
      <div className="agent-builder" data-tour="agent-builder" data-tour-saved={saved && !changed ? true : undefined}>
        {bar.chip && createPortal(<AgentChip name={name} state={state} detail={detail} action={changed || save.kind === 'saving' ? saveButton : undefined} onRemove={saved ? () => void doRemove() : undefined} pin={pin} />, bar.chip)}
        {bar.tabs && createPortal(<AgentViewTabs view={view} onView={showView} tour inBar />, bar.tabs)}
        <h1 className="visually-hidden">{name}</h1>
        {/* The way back to a team, and what a save did. Always there, so a save is announced. */}
        <div className="agent-notices">{backToTeam}<span className={`agent-save-state t-meta${saveSaid === 'Saved.' ? ' quiet' : ''}`} role="status">{saveSaid ?? (pinSaid && (pinSaid.ok ? pinSaid.text : <span className="agent-save-error">{pinSaid.text}</span>))}</span></div>
        {bench}
        {side}
      </div>
    )
  }

  return (
    <div className="agent-builder" data-tour="agent-builder" data-tour-saved={saved && !changed ? true : undefined}>
      <AgentHead
        above={inTeam ? <span className="agent-backs t-meta">From My agents. Saving changes it there too. Other teams keep their copy until you update them.</span> : <span className="agent-backs">
          <a className="link agent-back" href="/agents" onClick={(event) => { event.preventDefault(); navigate('/agents') }}><ArrowLeft size={14} aria-hidden="true" />My agents</a>
          {backToTeam}
        </span>}
        name={name}
        status={<span className="agent-builder-version">{saved ? (saved.savedAt ? `Saved ${relativeTime(new Date(saved.savedAt))}` : 'Saved') : 'Not saved yet'}</span>}
        view={view} onView={showView} tour={!inTeam}
      >
        <div className="agent-builder-save">
          {saveButton}
          <span className="agent-save-state t-meta" role="status">{saveSaid ?? (changed && base ? 'Unsaved changes' : problem ?? '')}</span>
        </div>
      </AgentHead>
      {bench}
      {side}
    </div>
  )
}

/**
 * The head of an agent's page, the same wherever an agent is edited: in My agents, and in a team's
 * Agents tab for one from My agents or one of the team's own. Read top down: the way back or where
 * it comes from (`above`), its name, how it is kept (`status`), then its two tabs, then the bench's
 * summary below it. The tabs sit under the name, on the left, so they are read with the agent they
 * belong to and right above what they switch; the far side (`children`) is for saving it.
 */
export function AgentHead({ above, name, status, view, onView, tour = false, children }: { above?: ReactNode; name: string; status: ReactNode; view: AgentView; onView: (view: AgentView) => void; tour?: boolean; children?: ReactNode }) {
  return (
    <header className="agent-builder-head">
      {above}
      <div className="agent-builder-title">
        <h1>{name}</h1>
        {status}
        <AgentViewTabs view={view} onView={onView} tour={tour} />
      </div>
      {children}
    </header>
  )
}

/**
 * An agent's two tabs: Build, its workbench, and Chat, where you work with it on its own. They sit
 * under its name (AgentHead); in My agents the getting-started guide points at them.
 */
export function AgentViewTabs({ view, onView, tour = false, inBar = false }: { view: AgentView; onView: (view: AgentView) => void; tour?: boolean; inBar?: boolean }) {
  // In the header of its own page they are a team's tabs, the same size and place (AgentFrame).
  const size = inBar ? 15 : 14
  return (
    <nav className={inBar ? 'workspace-view-tabs' : 'workspace-view-tabs agent-view-tabs'} aria-label="Agent view">
      <SegmentThumb />
      <button type="button" aria-pressed={view === 'build'} onClick={() => onView('build')} data-tour={tour ? 'agent-tab-build' : undefined}><Wrench size={size} aria-hidden="true" />Build</button>
      <button type="button" aria-pressed={view === 'chat'} onClick={() => onView('chat')} data-tour={tour ? 'agent-tab-chat' : undefined}><MessagesSquare size={size} aria-hidden="true" />Chat</button>
    </nav>
  )
}

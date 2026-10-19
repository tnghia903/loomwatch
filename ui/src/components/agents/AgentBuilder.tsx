import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, History, MessagesSquare, Trash2, Wrench } from 'lucide-react'

import { shortName } from '../../lib/ai/client'
import { effortWord, modelEfforts, placeEffort } from '../../lib/ai/efforts'
import { modelNameFromId } from '../../lib/ai/modelIds'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { useModels } from '../../lib/ai/useModels'
import type { DetectedCapability } from '../../lib/library/client'
import { BLANK_DRAFT, blankDraft, draftChanged, draftFromJob, draftFromPreset, makesNewVersion, specFromDraft, type AgentDraft } from '../../lib/library/draft'
import type { ReadSource } from '../../lib/library/figure'
import { figureFor, freshFigure } from '../../lib/library/figures'
import { fetchJobVersions, JobApiError, jobIdFor, removeJob, saveJob, useSavedJobs, versionOf, type JobSpec, type JobVersion, type SavedJob } from '../../lib/library/jobs'
import { ROLE_PRESETS } from '../../lib/library/roles'
import type { TeamKnowledge } from '../../lib/library/teamDraft'
import { useAgentUses } from '../../lib/library/uses'
import { relativeTime } from '../../lib/format'
import type { RunRecord } from '../../lib/runs/client'
import { SegmentThumb } from '../ui/SegmentThumb'
import { AgentBadge } from './AgentBadge'
import { AgentAnswer, AgentChat } from './AgentChat'
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
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; version: number; bumped: boolean } | { kind: 'error'; message: string }

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
export function AgentBuilder({ id, startFrom = null, skills, skillsLoading, cameFrom = null, view: asked = 'build', inTeam }: AgentBuilderProps) {
  // Inside a team the address is the team's, so the page keeps which tab is open.
  const [teamView, setTeamView] = useState<AgentView>('build')
  const view: AgentView = inTeam ? teamView : asked
  const { jobs, available, loaded } = useSavedJobs()
  const ai = useAiStatus()
  const saved = useMemo(() => (id ? jobs.find((job) => job.id === id) ?? null : null), [jobs, id])
  const [base, setBase] = useState<AgentDraft | null>(null)
  const [draft, setDraft] = useState<AgentDraft>(BLANK_DRAFT)
  const [note, setNote] = useState('')
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [removing, setRemoving] = useState(false)
  const roleField = useRef<HTMLTextAreaElement>(null)
  const [benchRecord, setBenchRecord] = useState<RunRecord | null>(null)
  // A long answer from the chat, read in full over the bench.
  const [answerRun, setAnswerRun] = useState<string | null>(null)

  // Start once per agent: from the saved version, from a built-in job, or blank on the default model.
  // Later reloads of the list (every save anywhere) must never overwrite edits on screen.
  const [startedFor, setStartedFor] = useState<string | null>(null)
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
      setBase(null)
      setDraft({ ...from, figure: freshFigure(`${startKey}:${jobs.length}`, worn) })
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
  const version = saved ? versionOf(saved) : null
  const [versions, setVersions] = useState<JobVersion[] | null>(null)
  useEffect(() => {
    if (!saved) return
    let cancelled = false
    fetchJobVersions(saved.id).then((found) => { if (!cancelled) setVersions(found) }, () => { if (!cancelled) setVersions([]) })
    return () => { cancelled = true }
  }, [saved, version])

  const changed = base ? draftChanged(draft, base) : true
  const bumps = base ? makesNewVersion(draft, base) : true
  const problem = !draft.name.trim() ? 'Give it a name.' : !draft.instructions.trim() ? 'Write its instructions.' : null
  useEffect(() => {
    if (!changed || !base) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [changed, base])

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => { setDraft((current) => ({ ...current, [key]: value })); if (save.kind !== 'saving') setSave({ kind: 'idle' }) }

  async function doSave() {
    if (problem) return
    setSave({ kind: 'saving' })
    try {
      const spec = specFromDraft(draft, bumps ? note : '')
      const result: SavedJob = saved
        ? await saveJob(saved.id, spec, { replace: true, expectedVersion: versionOf(saved) })
        : await saveJob(jobIdFor(draft.name), spec)
      const next = draftFromJob(result)
      setBase(next)
      setDraft(next)
      setNote('')
      setSave({ kind: 'saved', version: versionOf(result), bumped: Boolean(saved) && versionOf(result) > versionOf(saved!) })
      inTeam?.onSaved(result, base ? { reads: base.reads } : null)
      if (!saved) {
        setStartedFor(result.id)
        const query = new URLSearchParams(cameFrom ? { team: cameFrom } : {})
        if (view === 'chat') query.set('view', 'chat')
        navigate(`/agents/${encodeURIComponent(result.id)}${query.size ? `?${query}` : ''}`, true)
      }
    } catch (failed) {
      const message = failed instanceof JobApiError && failed.status === 412
        ? saved ? failed.message : `You already have an agent called “${draft.name.trim()}”. Give this one another name, or open that one from My agents.`
        : failed instanceof JobApiError && failed.status === 404 ? 'This LoomWatch server is older than My agents. Restart it, then save again.'
        : failed instanceof Error ? failed.message : String(failed)
      setSave({ kind: 'error', message })
    }
  }

  async function doRemove() {
    if (!saved) return
    try { await removeJob(saved.id); navigate('/agents') } catch (failed) { setSave({ kind: 'error', message: failed instanceof Error ? failed.message : String(failed) }); setRemoving(false) }
  }

  if (id && !saved) {
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
  const saveLabel = !saved ? 'Save to My agents' : bumps ? `Save as v${(version ?? 1) + 1}` : 'Save'
  const markId = saved?.id ?? (draft.name || 'new')
  const figure = figureFor(saved?.id ?? startKey, draft.figure)
  const badge = <AgentBadge markId={markId} figure={figure} draft={draft} modelName={modelName} effortName={effortName} version={saved && !changed ? version : null} usedIn={saved ? { teams: mine.length, scheduled: scheduledUses, behind: behindUses } : undefined} />

  return (
    <div className="agent-builder" data-tour="agent-builder" data-tour-saved={saved && !changed ? true : undefined}>
      <header className="agent-builder-head">
        {inTeam ? <span className="agent-backs t-meta">From My agents. Saving makes its next version, and moves {inTeam.name} to it.</span> : <span className="agent-backs">
          <a className="link agent-back" href="/agents" onClick={(event) => { event.preventDefault(); navigate('/agents') }}><ArrowLeft size={14} aria-hidden="true" />My agents</a>
          {/* Back to the team's agents: that is where an agent is added, or moved to a new version. */}
          {cameFrom && <a className="link agent-back" href={`/?path=${encodeURIComponent(cameFromUse?.teamPath ?? cameFrom)}&view=agents`}>Back to {cameFromUse?.teamName ?? 'the team'}{save.kind === 'saved' && save.bumped ? ` to update it to v${save.version}` : ''}</a>}
        </span>}
        <div className="agent-builder-title">
          <h1>{draft.name.trim() || 'New agent'}</h1>
          <span className="agent-builder-version">{saved ? `v${version}${saved.savedAt ? ` · saved ${relativeTime(new Date(saved.savedAt))}` : ''}` : 'Not saved yet'}</span>
          <AgentViewTabs view={view} onView={showView} tour={!inTeam} />
        </div>
        <div className="agent-builder-save">
          {saved && changed && bumps && <input className="agent-note" value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} placeholder="What changed? Teams see this when they update" aria-label="What changed in this version" />}
          <button type="button" className="btn btn-primary" data-tour="save-agent" disabled={!changed || Boolean(problem) || save.kind === 'saving'} title={problem ?? undefined} onClick={() => void doSave()}>{save.kind === 'saving' ? 'Saving…' : saveLabel}</button>
          <span className="agent-save-state t-meta" role="status">
            {save.kind === 'saved' ? (save.bumped ? (inTeam ? `Saved as v${save.version}, and ${inTeam.name} now uses it. Save the team to keep that.` : `Saved as v${save.version}. Teams keep their version until they update.`) : `Saved${save.version ? ` · v${save.version}` : ''}.`)
              : save.kind === 'error' ? <span className="agent-save-error">{save.message}</span>
              : changed && base ? 'Unsaved changes' : problem ?? ''}
          </span>
        </div>
      </header>

      <ByHand
        draft={draft} set={set} skills={skills} skillsLoading={skillsLoading} roleField={roleField} figure={figure} record={benchRecord} reads={inTeam?.reads} onShowWorkflow={inTeam?.onShowWorkflow}
        chat={view === 'chat' ? <AgentChat draft={draft} model={draft.model} chatId={chatId} figure={figure} onAllow={(what) => (typeof what === 'string' ? set('allow', { ...draft.allow, [what]: true }) : set('toolAllow', withAllowed(draft.toolAllow, what.tool, what.call)))} onRecord={setBenchRecord} answerRunId={answerRun} onOpenAnswer={setAnswerRun} knowledge={inTeam?.knowledge} /> : undefined}
        onBuild={() => showView('build')}
        cover={view === 'chat' && answerRun ? <AgentAnswer runId={answerRun} name={draft.name.trim() || 'New agent'} onClose={() => setAnswerRun(null)} /> : undefined}
      />

      {view === 'build' && <div className="agent-builder-grid">
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
                        <a href={`/?path=${encodeURIComponent(use.teamPath)}`}>{use.teamName}<ExternalLink size={12} aria-hidden="true" /></a>
                        <span className={`agent-use-version${version && use.version < version ? ' behind' : ''}`}>v{use.version}{version && use.version < version ? ` · v${version} is ready` : ''}</span>
                        {use.scheduled && <span className="t-meta">on a schedule</span>}
                      </li>
                    ))}
                  </ul>}
              </section>
            )}

            {saved && versions && versions.length > 0 && (
              <section className="agent-section" aria-label="Versions">
                <div className="agent-section-head"><History size={13} aria-hidden="true" />Versions</div>
                <ol className="agent-versions">
                  {versions.map((entry) => <li key={entry.version}><b>v{entry.version}</b><span>{entry.note || (entry.version === 1 ? 'First version' : 'No note')}</span>{entry.savedAt && <time dateTime={entry.savedAt}>{relativeTime(new Date(entry.savedAt))}</time>}</li>)}
                </ol>
              </section>
            )}

            {saved && (
              <div className="agent-remove">
                {removing
                  ? <><span className="t-meta">Remove it from My agents? Teams keep their copies.</span><button type="button" className="btn" onClick={() => void doRemove()}>Remove</button><button type="button" className="btn" onClick={() => setRemoving(false)}>Keep it</button></>
                  : <button type="button" className="link" onClick={() => setRemoving(true)}><Trash2 size={12} aria-hidden="true" />Remove from My agents</button>}
              </div>
            )}
          </div>
          <FigurePicker figure={figure} onChange={(next) => set('figure', next)} />
        </aside>
      </div>}
    </div>
  )
}

/**
 * An agent's two tabs: Build, its workbench, and Chat, where you work with it on its own. In Your
 * agents they sit by its name (the getting-started guide points at them); a team's own agent has
 * them above its bench.
 */
export function AgentViewTabs({ view, onView, tour = false }: { view: AgentView; onView: (view: AgentView) => void; tour?: boolean }) {
  return (
    <nav className="workspace-view-tabs agent-view-tabs" aria-label="Agent view">
      <SegmentThumb />
      <button type="button" aria-pressed={view === 'build'} onClick={() => onView('build')} data-tour={tour ? 'agent-tab-build' : undefined}><Wrench size={14} aria-hidden="true" />Build</button>
      <button type="button" aria-pressed={view === 'chat'} onClick={() => onView('chat')} data-tour={tour ? 'agent-tab-chat' : undefined}><MessagesSquare size={14} aria-hidden="true" />Chat</button>
    </nav>
  )
}

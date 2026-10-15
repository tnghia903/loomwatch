import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, History, Trash2 } from 'lucide-react'

import { fetchHarnessModels, isHarnessRunnable, type DetectedHarness, type HarnessModels } from '../../lib/harnesses'
import type { DetectedCapability } from '../../lib/library/client'
import { agentFromDraft, BLANK_DRAFT, draftChanged, draftFromJob, draftFromPreset, makesNewVersion, specFromDraft, type AgentDraft } from '../../lib/library/draft'
import { fetchJobVersions, JobApiError, jobIdFor, removeJob, saveJob, useSavedJobs, versionOf, type JobVersion, type SavedJob } from '../../lib/library/jobs'
import { ROLE_PRESETS } from '../../lib/library/roles'
import { useAgentUses } from '../../lib/library/uses'
import { relativeTime } from '../../lib/format'
import { rankHarnesses } from '../../lib/team-file/templates'
import { AgentPermissions } from '../canvas/AgentPermissions'
import { InstructionShape } from '../canvas/InstructionShape'
import { AgentBadge } from './AgentBadge'
import { SkillPicker } from './SkillPicker'
import { TestBench } from './TestBench'
import { navigate } from './route'

export interface AgentBuilderProps {
  /** The saved agent's id, or `null` for a new one. */
  id: string | null
  /** A built-in job a new agent starts from. */
  startFrom?: string | null
  harnesses: DetectedHarness[]
  harnessesLoading: boolean
  skills: DetectedCapability[]
  skillsLoading: boolean
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; version: number; bumped: boolean } | { kind: 'error'; message: string }

/**
 * One of Your agents, built on its own: the agent panel at full size, plus a test bench.
 *
 * The left column holds every setting, each in one place. The right column shows what those
 * settings add up to (the ID card), lets you try the agent on a real request before any team
 * depends on it, and says where it is used and how it got here (its versions). Saving a change
 * a team would copy makes the next version; teams keep theirs until they choose Update.
 */
export function AgentBuilder({ id, startFrom = null, harnesses, harnessesLoading, skills, skillsLoading }: AgentBuilderProps) {
  const { jobs, available, loaded } = useSavedJobs()
  const saved = useMemo(() => (id ? jobs.find((job) => job.id === id) ?? null : null), [jobs, id])
  const runnable = useMemo(() => rankHarnesses(harnesses), [harnesses])
  const [base, setBase] = useState<AgentDraft | null>(null)
  const [draft, setDraft] = useState<AgentDraft>(BLANK_DRAFT)
  const [note, setNote] = useState('')
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [removing, setRemoving] = useState(false)
  const roleField = useRef<HTMLTextAreaElement>(null)

  // Start once per agent: from the saved version, from a built-in job, or blank on the best app.
  // Later reloads of the list (every save anywhere) must never overwrite edits on screen.
  const [startedFor, setStartedFor] = useState<string | null>(null)
  const startKey = id ?? `new:${startFrom ?? ''}`
  if (startedFor !== startKey) {
    if (id && saved) {
      setStartedFor(startKey)
      const from = draftFromJob(saved)
      setBase(from)
      setDraft(from)
    } else if (!id && !harnessesLoading) {
      setStartedFor(startKey)
      const preset = ROLE_PRESETS.find((candidate) => candidate.id === startFrom)
      const from = preset ? draftFromPreset(preset, harnesses) : { ...BLANK_DRAFT, appId: runnable[0]?.id ?? null }
      setBase(null)
      setDraft(from)
    }
  }

  const harness = harnesses.find((candidate) => candidate.id === draft.appId) ?? null
  const [models, setModels] = useState<{ app: string; list: HarnessModels | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!draft.appId) return
    let cancelled = false
    const app = draft.appId
    fetchHarnessModels(app).then((list) => { if (!cancelled) setModels({ app, list, error: null }) }, (failed: unknown) => { if (!cancelled) setModels({ app, list: null, error: failed instanceof Error ? failed.message : String(failed) }) })
    return () => { cancelled = true }
  }, [draft.appId])
  const appModels = models?.app === draft.appId ? models : null
  const resolvedModel = draft.model || appModels?.list?.currentModelId || ''
  const modelName = appModels?.list?.models.find((model) => model.id === resolvedModel)?.name

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
      if (!saved) { setStartedFor(result.id); navigate(`/agents/${encodeURIComponent(result.id)}`, true) }
    } catch (failed) {
      const message = failed instanceof JobApiError && failed.status === 412
        ? saved ? failed.message : `You already have an agent called “${draft.name.trim()}”. Give this one another name, or open that one from Your agents.`
        : failed instanceof JobApiError && failed.status === 404 ? 'This LoomWatch server is older than Your agents. Restart it, then save again.'
        : failed instanceof Error ? failed.message : String(failed)
      setSave({ kind: 'error', message })
    }
  }

  async function doRemove() {
    if (!saved) return
    try { await removeJob(saved.id); navigate('/agents') } catch (failed) { setSave({ kind: 'error', message: failed instanceof Error ? failed.message : String(failed) }); setRemoving(false) }
  }

  if (id && !saved) {
    return <div className="agent-builder"><a className="link agent-back" href="/agents" onClick={(event) => { event.preventDefault(); navigate('/agents') }}><ArrowLeft size={14} aria-hidden="true" />Your agents</a><p className="home-empty">{!loaded ? 'Loading…' : available ? `There is no agent “${id}” in Your agents.` : 'This LoomWatch server is older than Your agents. Restart it to use them.'}</p></div>
  }

  const benchId = saved ? saved.id : `new-${jobIdFor(draft.name || 'agent')}`
  const scheduledUses = mine.filter((use) => use.scheduled).length
  const behindUses = version ? mine.filter((use) => use.version < version).length : 0
  const saveLabel = !saved ? 'Save to Your agents' : bumps ? `Save as v${(version ?? 1) + 1}` : 'Save'
  const permissionsAgent = agentFromDraft(draft, harness)

  return (
    <div className="agent-builder">
      <header className="agent-builder-head">
        <a className="link agent-back" href="/agents" onClick={(event) => { event.preventDefault(); navigate('/agents') }}><ArrowLeft size={14} aria-hidden="true" />Your agents</a>
        <div className="agent-builder-title">
          <h1>{draft.name.trim() || 'New agent'}</h1>
          <span className="agent-builder-version">{saved ? `v${version}${saved.savedAt ? ` · saved ${relativeTime(new Date(saved.savedAt))}` : ''}` : 'Not saved yet'}</span>
        </div>
        <div className="agent-builder-save">
          {saved && changed && bumps && <input className="agent-note" value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} placeholder="What changed? Teams see this when they update" aria-label="What changed in this version" />}
          <button type="button" className="btn btn-primary" disabled={!changed || Boolean(problem) || save.kind === 'saving'} title={problem ?? undefined} onClick={() => void doSave()}>{save.kind === 'saving' ? 'Saving…' : saveLabel}</button>
          <span className="agent-save-state t-meta" role="status">
            {save.kind === 'saved' ? (save.bumped ? `Saved as v${save.version}. Teams keep their version until they update.` : `Saved${save.version ? ` · v${save.version}` : ''}.`)
              : save.kind === 'error' ? <span className="agent-save-error">{save.message}</span>
              : changed && base ? 'Unsaved changes' : problem ?? ''}
          </span>
        </div>
      </header>

      <div className="agent-builder-grid">
        <div className="agent-builder-form">
          <section className="agent-section" aria-label="Who it is">
            <div className="agent-section-head">Who it is</div>
            <label className="agent-field">Name<input value={draft.name} maxLength={80} onChange={(event) => set('name', event.target.value)} placeholder="e.g. Release notes writer" autoFocus={!saved} /></label>
            <label className="agent-field"><span>What it does <span className="optional">optional</span></span><input value={draft.does} maxLength={120} onChange={(event) => set('does', event.target.value)} placeholder="Shown under its name in the add panel" /></label>
          </section>

          <section className="agent-section" aria-label="Instructions">
            <div className="agent-section-head">Instructions</div>
            <textarea ref={roleField} className="agent-instructions" rows={9} value={draft.instructions} onChange={(event) => set('instructions', event.target.value)} placeholder="What this agent does, how it works, and what it replies with." />
            <InstructionShape role={draft.instructions} field={roleField} onChange={(role) => set('instructions', role)} />
          </section>

          <section className="agent-section" aria-label="App and model">
            <div className="agent-section-head">App and model</div>
            <div className="agent-field-row">
              <label className="agent-field">AI app
                <select value={draft.appId ?? ''} onChange={(event) => { set('appId', event.target.value || null); set('model', '') }}>
                  <option value="" disabled>{harnessesLoading ? 'Looking for apps…' : 'Choose an app'}</option>
                  {harnesses.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={!isHarnessRunnable(candidate)}>{candidate.name}{isHarnessRunnable(candidate) ? '' : ' (not ready)'}</option>)}
                </select>
              </label>
              <label className="agent-field">Model
                <select value={draft.model} disabled={!draft.appId} onChange={(event) => set('model', event.target.value)}>
                  <option value="">{appModels?.list?.currentModelId ? `The app’s current model (${appModels.list.models.find((model) => model.id === appModels.list!.currentModelId)?.name ?? appModels.list.currentModelId})` : 'The app’s current model'}</option>
                  {(appModels?.list?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
            </div>
            {appModels?.error && <p className="t-meta agent-save-error">Couldn’t list this app’s models: {appModels.error}</p>}
            {!draft.appId && !harnessesLoading && runnable.length === 0 && <p className="t-meta">No AI app is ready on this computer yet. Set one up from Home first.</p>}
          </section>

          <section className="agent-section" aria-label="Skills">
            <div className="agent-section-head">Skills</div>
            <SkillPicker chosen={draft.skills} available={skills} loading={skillsLoading} onChange={(next) => set('skills', next)} />
          </section>

          <section className="agent-section" aria-label="Allowed without asking">
            <AgentPermissions agent={permissionsAgent} onChange={(key, on) => set('allow', { ...draft.allow, [key]: on })} headClassName="agent-section-head" />
          </section>
        </div>

        <aside className="agent-builder-side">
          <AgentBadge markId={saved?.id ?? (draft.name || 'new')} draft={draft} harness={harness} modelName={modelName} version={saved && !changed ? version : null} usedIn={saved ? { teams: mine.length, scheduled: scheduledUses, behind: behindUses } : undefined} />
          <TestBench draft={draft} harness={harness} model={resolvedModel} benchId={benchId} onAllow={(key) => set('allow', { ...draft.allow, [key]: true })} />

          {saved && (
            <section className="agent-section" aria-label="Used in">
              <div className="agent-section-head">Used in</div>
              {uses === null ? <p className="t-meta">Looking through your teams…</p>
                : mine.length === 0 ? <p className="t-meta">No team uses it yet. Open a team and add it from Your agents in the add panel.</p>
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
                ? <><span className="t-meta">Remove it from Your agents? Teams keep their copies.</span><button type="button" className="btn" onClick={() => void doRemove()}>Remove</button><button type="button" className="btn" onClick={() => setRemoving(false)}>Keep it</button></>
                : <button type="button" className="link" onClick={() => setRemoving(true)}><Trash2 size={12} aria-hidden="true" />Remove from Your agents</button>}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

import { ArrowRight, Check } from '../ui/icon'
import { useId, useState } from 'react'

import { figureFor } from '../../lib/library/figures'
import { fetchJobs, saveJob, useSavedJobs } from '../../lib/library/jobs'
import { saveTeamFile } from '../../lib/team-file/client'
import { teamOfMyAgents } from '../../lib/team-file/myAgents'
import { TeamFileModel } from '../../lib/team-file/document'
import { teamIdForPath } from '../../lib/team-file/useTeamDocument'
import { agentsTeamYaml, TEAM_TEMPLATES, templateTeamYaml, uniqueTeamPath, type TeamTemplateId } from '../../lib/team-file/templates'
import { openTeam } from '../../lib/team-file/useTeamList'
import { FigureStill } from '../agents/FigureStill'

export interface NewTeamDialogProps {
  /**
   * Paths a new team must not take: files already in the teams folder, and where deleted teams
   * used to live, whose run history and Notebook notes a new team there would inherit.
   */
  existingPaths: readonly string[]
  onClose: () => void
  /** The open team has unsaved changes that creating a new team would discard. */
  openTeamUnsaved?: boolean
  /** The project the new team works in (ADR 0097): from a project's room. */
  project?: string
  /** Where to go once it is saved; its page in place, by default. */
  onCreated?: (path: string) => void
}

/** `yaml` working in `project`, when there is one. */
function withProject(yaml: string, project: string | undefined): string {
  if (!project) return yaml
  const model = TeamFileModel.parse(yaml)
  model.setProject(project)
  return model.toYaml()
}

/** Where a new team starts: some of Your agents, or a template. */
type Start = 'agents' | TeamTemplateId

/**
 * Name, starting point, done. A team always starts with agents: the ones you built in Your agents,
 * or a template's. Either way it is written to disk as a complete team and opened, so the first
 * screen after this dialog is one where typing a request and pressing Enter runs it. Each agent
 * runs on its own model, which team setup can change.
 */
export function NewTeamDialog({ existingPaths, onClose, openTeamUnsaved = false, project, onCreated = (path) => openTeam(path) }: NewTeamDialogProps) {
  const [name, setName] = useState('')
  const saved = useSavedJobs()
  const hasAgents = saved.available && saved.jobs.length > 0
  // Until a choice is made, someone who built agents starts with them (the work goes agents first),
  // and someone who has none with the one-assistant template.
  const [chosen, setChosen] = useState<Start | null>(null)
  const start: Start = chosen ?? (hasAgents ? 'agents' : 'single')
  // With one agent there is nothing to choose, so it is ticked; with more, you tick the ones you want.
  const [ticked, setTicked] = useState<string[] | null>(null)
  const picked = saved.jobs.filter((job) => (ticked ?? (saved.jobs.length === 1 ? [saved.jobs[0].id] : [])).includes(job.id))
  const tick = (id: string, on: boolean) => setTicked((current) => {
    const now = current ?? picked.map((job) => job.id)
    return on ? [...now.filter((other) => other !== id), id] : now.filter((other) => other !== id)
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const trimmed = name.trim()
  const needsAgent = start === 'agents' && picked.length === 0

  async function create() {
    if (!trimmed || busy || needsAgent) return
    const path = uniqueTeamPath(trimmed, existingPaths)
    setError(null)
    setBusy('Setting up the team…')
    try {
      const written = start === 'agents' ? agentsTeamYaml(picked, trimmed, teamIdForPath(path)) : templateTeamYaml(start, trimmed, undefined, teamIdForPath(path))
      // Its agents are agents of My agents first (ADR 0094), so a change saved to one reaches this
      // team too. My agents as they are now: a template's agent may join one saved a moment ago.
      const mine = await fetchJobs()
      const yaml = withProject(mine ? await teamOfMyAgents(written, mine.jobs, saveJob) : written, project)
      await saveTeamFile(path, yaml, null)
      onCreated(path)
    } catch (caught) {
      setBusy(null)
      setError(`The team couldn’t be saved. ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  return (
    <div className="lw-scrim dim" onMouseDown={() => { if (!busy) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 lw-newteam" data-tour="new-team-dialog" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() } }}>
        <form onSubmit={(event) => { event.preventDefault(); void create() }}>
          <h2 id={titleId}>Create a team</h2>
          <label className="field">
            <span className="nt-label">Team name</span>
            <input autoFocus className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Blog writer" disabled={Boolean(busy)} />
          </label>

          <fieldset className="nt-templates" disabled={Boolean(busy)}>
            <legend className="nt-label">Which agents does it start with?</legend>
            {saved.available && (
              <label className={`nt-option ${start === 'agents' ? 'on' : ''} ${hasAgents ? '' : 'off'}`}>
                <input type="radio" name="template" value="agents" checked={start === 'agents'} disabled={!hasAgents} onChange={() => setChosen('agents')} />
                <span className="nt-check" aria-hidden="true">{start === 'agents' && <Check size={12} />}</span>
                <span className="nt-body">
                  <span className="nt-title">My agents{hasAgents && <em>Recommended</em>}</span>
                  <span className="nt-desc">{!saved.loaded ? 'Loading your agents…' : hasAgents ? 'The agents you built and tried. Each is the same agent in every team it’s in.' : 'You have no agents yet. Build one first, or start from a template below.'}</span>
                </span>
              </label>
            )}
            {saved.loaded && !hasAgents && saved.available && <a className="link nt-build" href="/agents/new">Build your first agent<ArrowRight size={13} aria-hidden="true" /></a>}
            {start === 'agents' && hasAgents && (
              <div className="nt-agents" role="group" aria-label="Agents to start with" data-tour="new-team-agents">
                {saved.jobs.map((job) => {
                  const on = picked.some((candidate) => candidate.id === job.id)
                  return (
                    <label key={job.id} className={`nt-agent ${on ? 'on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={(event) => tick(job.id, event.target.checked)} />
                      <FigureStill className="nt-agent-figure" figure={figureFor(job.id, job.figure)} headOnly alt="" width={28} height={28} loading="lazy" decoding="async" />
                      <b>{job.name}</b>
                    </label>
                  )
                })}
              </div>
            )}
            {TEAM_TEMPLATES.map((option) => {
              return (
                <label key={option.id} className={`nt-option ${start === option.id ? 'on' : ''}`}>
                  <input type="radio" name="template" value={option.id} checked={start === option.id} onChange={() => setChosen(option.id)} />
                  <span className="nt-check" aria-hidden="true">{start === option.id && <Check size={12} />}</span>
                  <span className="nt-body">
                    <span className="nt-title">{option.title}{option.id === 'single' && !hasAgents && <em>Recommended</em>}</span>
                    <span className="nt-desc">{option.description}</span>
                    {option.steps.length > 0 && (
                      <span className="nt-steps" aria-hidden="true">
                        {option.steps.map((step, index) => <span key={step}>{index > 0 && <ArrowRight size={11} />}<i className={step === 'You' ? 'you' : ''}>{step}</i></span>)}
                      </span>
                    )}
                    {option.perRun && <span className="nt-cost">{option.perRun}</span>}
                  </span>
                  {option.example && (
                    // Pick by outcome: what a finished run of this team hands back, marked as an example.
                    <span className="nt-example" aria-label={`Example result: ${option.example.title}`}>
                      <span className="nt-example-tag">Example result</span>
                      <b>{option.example.title}</b>
                      {option.example.lines.map((line) => <span key={line}>{line}</span>)}
                      {option.example.note && <em>{option.example.note}</em>}
                    </span>
                  )}
                </label>
              )
            })}
          </fieldset>

          {openTeamUnsaved && <p className="nt-note warn">The open team has unsaved changes. Save it first, or they will be lost.</p>}

          {/* Pinned to the bottom of the dialog: five templates with example results are taller than
              a laptop screen, and a Create button (or its progress and errors) scrolled out of view
              reads as a dialog that does nothing. */}
          <div className="nt-foot">
            {error && <p role="alert" className="nt-error">{error}</p>}
            <div className="nt-acts">
              <span role="status" className="nt-busy">{busy ?? (needsAgent ? 'Tick at least one agent.' : null)}</span>
              <button type="button" className="btn" onClick={onClose} disabled={Boolean(busy)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!trimmed || Boolean(busy) || needsAgent}>{busy ? 'Creating…' : 'Create team'}</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

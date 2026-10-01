import { ArrowRight, Check } from 'lucide-react'
import { useId, useState } from 'react'

import { fetchHarnessModels, harnessProblem, type DetectedHarness } from '../../lib/harnesses'
import { saveTeamFile } from '../../lib/team-file/client'
import { teamIdForPath } from '../../lib/team-file/useTeamDocument'
import { rankHarnesses, TEAM_TEMPLATES, templateTeamYaml, uniqueTeamPath, type TeamTemplateId } from '../../lib/team-file/templates'

export interface NewTeamDialogProps {
  harnesses: readonly DetectedHarness[]
  /**
   * Paths a new team must not take: files already in the teams folder, and where deleted teams
   * used to live, whose run history and Notebook notes a new team there would inherit.
   */
  existingPaths: readonly string[]
  onCreateBlank: (name: string, path: string) => void
  onClose: () => void
  /** The open team has unsaved changes that creating a new team would discard. */
  openTeamUnsaved?: boolean
}

/**
 * Name, starting point, done. A template is written to disk as a complete team and opened, so the
 * first screen after this dialog is one where typing a request and pressing Enter runs it.
 */
export function NewTeamDialog({ harnesses, existingPaths, onCreateBlank, onClose, openTeamUnsaved = false }: NewTeamDialogProps) {
  const ranked = rankHarnesses(harnesses)
  // Left out of `ranked` because the daemon last saw them fail to start; named so the operator knows
  // why an app they installed is not offered.
  const failing = harnesses.filter((harness) => harness.acpAvailable !== false && harness.health === 'error')
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<TeamTemplateId>(ranked.length > 0 ? 'single' : 'blank')
  const [harnessId, setHarnessId] = useState(ranked[0]?.id ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const trimmed = name.trim()

  async function create() {
    if (!trimmed || busy) return
    const path = uniqueTeamPath(trimmed, existingPaths)
    if (template === 'blank') { onCreateBlank(trimmed, path); onClose(); return }
    setError(null)
    // The chosen app first, then the others: a template is only useful if its agents can start,
    // and an app that cannot list its models (signed out, unsupported) will not start either.
    const order = [...ranked.filter((harness) => harness.id === harnessId), ...ranked.filter((harness) => harness.id !== harnessId)]
    const failures: string[] = []
    for (const harness of order) {
      setBusy(`Setting up ${harness.name}…`)
      try {
        const catalog = await fetchHarnessModels(harness.id)
        const model = catalog.currentModelId ?? catalog.models[0]?.id
        if (!model) { failures.push(`${harness.name} did not offer any models`); continue }
        await saveTeamFile(path, templateTeamYaml(template, trimmed, harness, model, new Date(), teamIdForPath(path)), null)
        window.location.assign(`/?path=${encodeURIComponent(path)}`)
        return
      } catch (caught) {
        failures.push(`${harness.name}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
    }
    setBusy(null)
    setError(`None of your AI apps could be set up. ${failures.join(' · ')}`)
  }

  return (
    <div className="lw-scrim dim" onMouseDown={() => { if (!busy) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 lw-newteam" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() } }}>
        <form onSubmit={(event) => { event.preventDefault(); void create() }}>
          <h2 id={titleId}>Create a team</h2>
          <label className="field">
            <span className="nt-label">Team name</span>
            <input autoFocus className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Blog writer" disabled={Boolean(busy)} />
          </label>

          <fieldset className="nt-templates" disabled={Boolean(busy)}>
            <legend className="nt-label">How should it start?</legend>
            {TEAM_TEMPLATES.map((option) => {
              const unavailable = option.id !== 'blank' && ranked.length === 0
              return (
                <label key={option.id} className={`nt-option ${template === option.id ? 'on' : ''} ${unavailable ? 'off' : ''}`}>
                  <input type="radio" name="template" value={option.id} checked={template === option.id} disabled={unavailable} onChange={() => setTemplate(option.id)} />
                  <span className="nt-check" aria-hidden="true">{template === option.id && <Check size={12} />}</span>
                  <span className="nt-body">
                    <span className="nt-title">{option.title}{option.id === 'single' && <em>Recommended</em>}</span>
                    <span className="nt-desc">{option.description}</span>
                    {option.steps.length > 0 && (
                      <span className="nt-steps" aria-hidden="true">
                        {option.steps.map((step, index) => <span key={step}>{index > 0 && <ArrowRight size={11} />}<i className={step === 'You' ? 'you' : ''}>{step}</i></span>)}
                      </span>
                    )}
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

          {template !== 'blank' && ranked.length > 1 && (
            <label className="field nt-app">
              <span className="nt-label">AI app the agents use</span>
              <select className="input" value={harnessId} onChange={(event) => setHarnessId(event.target.value)} disabled={Boolean(busy)}>
                {ranked.map((harness) => <option key={harness.id} value={harness.id}>{harness.name}</option>)}
              </select>
              <span className="hint t-meta">You can change each agent's app and model later in team setup.</span>
            </label>
          )}
          {ranked.length === 0 && failing.length === 0 && <p className="nt-note">No AI apps were found on this computer, so only an empty team is available. Install Claude Code, Codex or OpenCode and sign in to use the ready-made teams.</p>}
          {ranked.length === 0 && failing.length > 0 && <p className="nt-note">None of your AI apps can start right now, so only an empty team is available.</p>}
          {failing.length > 0 && (
            <ul className="nt-note nt-problems" aria-label="Apps that need attention">
              {failing.map((harness) => <li key={harness.id} title={harness.healthDetail}>{harnessProblem(harness)}</li>)}
            </ul>
          )}
          {openTeamUnsaved && <p className="nt-note warn">The open team has unsaved changes. Save it first, or they will be lost.</p>}

          {/* Pinned to the bottom of the dialog: four templates with example results are taller than
              a laptop screen, and a Create button (or its progress and errors) scrolled out of view
              reads as a dialog that does nothing. */}
          <div className="nt-foot">
            {error && <p role="alert" className="nt-error">{error}</p>}
            <div className="nt-acts">
              <span role="status" className="nt-busy">{busy}</span>
              <button type="button" className="btn" onClick={onClose} disabled={Boolean(busy)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!trimmed || Boolean(busy)}>{busy ? 'Creating…' : 'Create team'}</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

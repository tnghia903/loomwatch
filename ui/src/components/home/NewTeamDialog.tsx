import { ArrowRight, Check } from 'lucide-react'
import { useId, useState } from 'react'

import { saveTeamFile } from '../../lib/team-file/client'
import { teamIdForPath } from '../../lib/team-file/useTeamDocument'
import { TEAM_TEMPLATES, templateTeamYaml, uniqueTeamPath, type TeamTemplateId } from '../../lib/team-file/templates'

export interface NewTeamDialogProps {
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
 * first screen after this dialog is one where typing a request and pressing Enter runs it. Each
 * agent runs on its job's model, which team setup can change.
 */
export function NewTeamDialog({ existingPaths, onCreateBlank, onClose, openTeamUnsaved = false }: NewTeamDialogProps) {
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<TeamTemplateId>('single')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const trimmed = name.trim()

  async function create() {
    if (!trimmed || busy) return
    const path = uniqueTeamPath(trimmed, existingPaths)
    if (template === 'blank') { onCreateBlank(trimmed, path); onClose(); return }
    setError(null)
    setBusy('Setting up the team…')
    try {
      await saveTeamFile(path, templateTeamYaml(template, trimmed, undefined, teamIdForPath(path)), null)
      window.location.assign(`/?path=${encodeURIComponent(path)}`)
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
            <legend className="nt-label">How should it start?</legend>
            {TEAM_TEMPLATES.map((option) => {
              return (
                <label key={option.id} className={`nt-option ${template === option.id ? 'on' : ''}`}>
                  <input type="radio" name="template" value={option.id} checked={template === option.id} onChange={() => setTemplate(option.id)} />
                  <span className="nt-check" aria-hidden="true">{template === option.id && <Check size={12} />}</span>
                  <span className="nt-body">
                    <span className="nt-title">{option.title}{option.id === 'single' && <em>Recommended</em>}</span>
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

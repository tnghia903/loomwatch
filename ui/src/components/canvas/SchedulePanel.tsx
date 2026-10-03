import { AlertCircle, ChevronDown, ChevronRight, Clock3, Globe2, Save, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { cronFor, normalizeSchedule, scheduleParts, unsupportedScheduleKeys, type ScheduleFrequency } from '../../lib/team-file/schedule'
import type { ScheduleConfig } from '../../lib/team-file/types'

const TIMEZONES = ['Asia/Singapore', 'UTC', 'America/New_York', 'Europe/London']

export interface SchedulePanelProps {
  schedule: ScheduleConfig
  /** Schedule problems still standing *after* the last save — empty once the editor fixed them. */
  problems: readonly string[]
  readOnly: boolean
  /** The document carries unsaved edits, so the schedule is set on the canvas but not on disk. */
  dirty: boolean
  canSaveFile: boolean
  /** True once "Save schedule" has been pressed in this session, so the footer can tell the two
   * meanings of "saved" apart: fixed on the canvas vs. written to the team file. */
  savedInEditor: boolean
  onSave: (schedule: ScheduleConfig) => void
  onSaveFile: () => void
  onAdvanced: () => void
  onClose: () => void
  /** Take the schedule off the team. Absent for a schedule not added yet, and when read-only. */
  onRemove?: () => void
  /** Opened from the Schedule button: nothing is on the team until "Save schedule". */
  isNew?: boolean
  /** How the saved routine is doing, as the daemon reports it, with a way to run it now. Absent
   * until the team file on disk has a schedule the daemon has picked up. */
  status?: ReactNode
}

export function SchedulePanel({ schedule, problems, readOnly, dirty, canSaveFile, savedInEditor, onSave, onSaveFile, onAdvanced, onClose, onRemove, isNew = false, status }: SchedulePanelProps) {
  const initial = scheduleParts(schedule.cron)
  const [frequency, setFrequency] = useState<ScheduleFrequency>(initial.frequency)
  const [time, setTime] = useState(initial.time)
  const [manual, setManual] = useState(schedule.cron ?? '')
  const [timezone, setTimezone] = useState(schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
  const [prompt, setPrompt] = useState(schedule.prompt ?? '')
  const [dirtyDraft, setDirtyDraft] = useState(false)
  const [seed, setSeed] = useState(schedule)

  // Reloading the file (or discarding) swaps the schedule under an open panel; follow it rather
  // than keeping a draft of a document that no longer exists. Adjusting state during render
  // instead of in an effect keeps the panel from painting the stale draft first.
  if (seed !== schedule) {
    setSeed(schedule)
    if (!dirtyDraft) {
      const parts = scheduleParts(schedule.cron)
      setFrequency(parts.frequency)
      setTime(parts.time)
      setManual(schedule.cron ?? '')
      setPrompt(schedule.prompt ?? '')
    }
  }

  const cron = cronFor(frequency, time, manual)
  const dropped = unsupportedScheduleKeys(schedule)
  const edit = <T,>(set: (value: T) => void) => (value: T) => { setDirtyDraft(true); set(value) }

  const save = (event: React.FormEvent) => {
    event.preventDefault()
    if (!cron || !prompt.trim()) return
    setDirtyDraft(false)
    onSave(normalizeSchedule({ cron, timezone, prompt }, schedule))
  }

  return (
    <aside className="panel right top e1 lw-inspector lw-schedule-panel" aria-label="Schedule" role="region" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <div className="inspector-glass" aria-hidden="true" />
      <div className="inspector-scroll">
      <header className="insp-head">
        <span className="node-glyph"><Clock3 size={20} aria-hidden="true" /></span>
        <span className="insp-text">
          <div className="insp-title t-title">Schedule trigger</div>
          <div className="insp-status t-micro">Step 1 · starts this pipeline</div>
        </span>
        <button type="button" className="iconbtn" onClick={onClose} title="Close (Esc)" aria-label="Close schedule"><X size={15} aria-hidden="true" /></button>
      </header>

      <form className="schedule-editor" aria-label="Edit schedule" onSubmit={save}>
        <header>
          <strong className="t-title">When should this team run?</strong>
          <span className="t-body">Set a schedule to start this pipeline.</span>
        </header>

        {status && <div className="schedule-routine t-meta" aria-label="Routine status">{status}</div>}

        {problems.length > 0 && (
          <div className="schedule-problems" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>
              <strong className="t-body-m">{problems.length === 1 ? 'This schedule still needs a fix' : `${problems.length} things still need a fix`}</strong>
              <ul>{problems.map((problem) => <li key={problem} className="t-meta">{problem}</li>)}</ul>
            </span>
          </div>
        )}

        <div className="schedule-tabs" role="tablist" aria-label="Schedule frequency">
          {(['daily', 'weekdays', 'manual'] as const).map((option) => (
            <button key={option} type="button" role="tab" aria-selected={frequency === option} className={frequency === option ? 'active' : ''} onClick={() => edit(setFrequency)(option)}>{option[0].toUpperCase() + option.slice(1)}</button>
          ))}
        </div>

        {frequency === 'manual' ? (
          <label className="schedule-field"><span className="t-ui">Schedule expression</span><span className="schedule-input"><Clock3 size={16} aria-hidden="true" /><input value={manual} onChange={(event) => edit(setManual)(event.target.value)} placeholder="0 8 * * *" aria-label="Schedule expression" /></span><small className="t-meta">For advanced schedules such as every Monday or every two hours.</small></label>
        ) : (
          <div className="schedule-grid">
            <label className="schedule-field"><span className="t-ui">Time</span><span className="schedule-input"><Clock3 size={16} aria-hidden="true" /><input type="time" value={time} onChange={(event) => edit(setTime)(event.target.value)} aria-label="Schedule time" /><ChevronDown size={14} aria-hidden="true" /></span></label>
            <label className="schedule-field"><span className="t-ui">Timezone</span><span className="schedule-input"><Globe2 size={16} aria-hidden="true" /><select value={timezone} onChange={(event) => edit(setTimezone)(event.target.value)} aria-label="Schedule timezone">{TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}{!TIMEZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}</select><ChevronDown size={14} aria-hidden="true" /></span></label>
          </div>
        )}

        <label className="schedule-field"><span className="t-ui">What should the team do?</span><textarea className="input" value={prompt} onChange={(event) => edit(setPrompt)(event.target.value)} placeholder="Describe the task for each scheduled run" aria-label="Scheduled task" /></label>

        {dropped.length > 0 && <small className="t-meta schedule-note">Saving removes {dropped.join(', ')} — {dropped.length === 1 ? 'a setting' : 'settings'} this team file's format does not allow. Use Advanced YAML to keep {dropped.length === 1 ? 'it' : 'them'}.</small>}

        <button type="submit" className="btn btn-primary schedule-save" disabled={readOnly || !cron.trim() || !prompt.trim()}><Clock3 size={16} aria-hidden="true" /> Save schedule</button>

        <div className="schedule-stage t-meta" role="status">
          {problems.length > 0
            ? 'The schedule is not fixed yet — the team cannot run until these are resolved.'
            : isNew
              ? 'Not added yet. Say what the team should do, then save the schedule.'
              : dirtyDraft
                ? 'Unsaved changes in this editor.'
                : dirty
                  ? `${savedInEditor ? 'Schedule set on the canvas' : 'This team has unsaved edits'}. The team file still needs saving.`
                  : savedInEditor ? 'Schedule saved to the team file.' : 'This schedule matches the team file on disk.'}
        </div>
        {dirty && problems.length === 0 && !dirtyDraft && (
          <button type="button" className="btn schedule-save-file" onClick={onSaveFile} disabled={!canSaveFile}><Save size={15} aria-hidden="true" /> Save team file <kbd className="t-mono-sm">⌘S</kbd></button>
        )}

        <footer><button type="button" className="link" onClick={onAdvanced}>Advanced YAML <ChevronRight size={14} aria-hidden="true" /></button>{onRemove && <button type="button" className="link muted" onClick={onRemove}>Remove schedule</button>}<button type="button" className="link muted" onClick={onClose}>Close</button></footer>
      </form>
      </div>
    </aside>
  )
}

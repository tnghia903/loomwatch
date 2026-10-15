import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, FlaskConical, Square } from 'lucide-react'

import type { DetectedHarness } from '../../lib/harnesses'
import { benchTeamYaml, type AgentDraft } from '../../lib/library/draft'
import { benchFolder } from '../../lib/library/jobs'
import { answerPermission, answerRun, cancelRun, isTerminalRun, newStartKey, startRun, useRunRecord, type PermissionRequest, type RunRecord } from '../../lib/runs/client'
import { ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { fetchTeamFile, saveTeamFile } from '../../lib/team-file/client'
import type { AllowSwitch } from '../../lib/team-file/types'
import { formatTokens, summarizeUsage, turnUsage } from '../../lib/watch/usage'
import { useSessionEvents } from '../../lib/watch/useSessionEvents'
import { Markdown } from '../ui/Markdown'

export interface TestBenchProps {
  draft: AgentDraft
  harness: DetectedHarness | null
  /** A model the app advertises: the draft's, else the app's current one. Empty while unknown. */
  model: string
  /** Names this agent's bench team: its saved id, or a slug of its name before the first save. */
  benchId: string
  /** "Allow from now on": switch this on in the draft, for the next try and for every team. */
  onAllow: (key: AllowSwitch) => void
  /** The run on the bench as it changes, so Build by hand can show the figure at work. */
  onRecord?: (record: RunRecord | null) => void
}

const STATUS_WORD: Record<RunRecord['status'], string> = { queued: 'Starting…', starting: 'Starting…', running: 'Working…', succeeded: 'Done', failed: 'It failed', cancelled: 'Stopped' }
const message = (failed: unknown) => failed instanceof Error ? failed.message : String(failed)
const seconds = (record: RunRecord) => {
  if (!record.startedAt) return null
  const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now()
  const total = Math.max(0, Math.round((end - Date.parse(record.startedAt)) / 1000))
  return total >= 60 ? `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s` : `${total}s`
}

/**
 * TRY IT: run the agent on its own, as it is on screen, before any team depends on it.
 *
 * The bench writes this one agent as a team in `.jobs/.bench/` (hidden from the team list and the
 * scheduler) and runs it like any team, so what you see is what a team would get: its reply, the
 * permission requests its switches leave to you, and any question it asks. A request a switch
 * would cover can be allowed for this run, or switched on from now on, which is the setting a
 * test is best placed to show you need.
 */
export function TestBench({ draft, harness, model, benchId, onAllow, onRecord }: TestBenchProps) {
  const [request, setRequest] = useState('')
  const [run, setRun] = useState<{ id: string; path: string } | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { record, apply } = useRunRecord(run?.id ?? null)
  const { events } = useSessionEvents(run?.id ?? '')
  const live = Boolean(run) && !isTerminalRun(record?.status)
  // What the try cost, from the run's own readings (usage.ts), once every event is in: the fact
  // that tells a model or effort choice apart, where a guess would not (ADR 0062).
  const tokens = useMemo(() => {
    if (!record || !isTerminalRun(record.status)) return null
    if (record.eventCount !== null && events.length < record.eventCount) return null
    const summary = summarizeUsage(turnUsage(events))
    return summary.total > 0 ? `${summary.stoppedTurns > 0 ? 'at least ' : ''}${formatTokens(summary.total)} tokens` : null
  }, [record, events])
  const shown = run && record ? record : null
  useEffect(() => { onRecord?.(shown) }, [shown, onRecord])
  useEffect(() => () => onRecord?.(null), [onRecord])
  const blocked = !harness ? 'Choose an app first.' : !model ? 'Waiting for the app’s models…' : !draft.instructions.trim() ? 'Write its instructions first.' : null

  async function start() {
    if (!harness || !model || !request.trim()) return
    setError(null)
    setStarting(true)
    try {
      const folder = await benchFolder()
      const path = `${folder}/${benchId}.yaml`
      let revision: string | null = null
      try { revision = (await fetchTeamFile(path)).revision ?? null } catch { revision = null }
      const saved = await saveTeamFile(path, benchTeamYaml(draft, harness, model, benchId), revision)
      const started = await startRun(path, request.trim(), { startKey: newStartKey(), expectedRevision: saved.revision ?? null })
      setRun({ id: started.runId, path })
      apply(started)
    } catch (failed) {
      setError(message(failed))
    } finally {
      setStarting(false)
    }
  }

  async function answer(request: PermissionRequest, decision: 'allow_once' | 'deny', allowFromNow = false) {
    if (!run) return
    if (allowFromNow && request.switch) onAllow(request.switch)
    try { apply(await answerPermission(run.id, request.id, decision)) } catch (failed) { setError(message(failed)) }
  }

  return (
    <section className="agent-bench" aria-label="Try it" data-tour="bench">
      <div className="agent-section-head"><FlaskConical size={14} aria-hidden="true" />Try it</div>
      <p className="t-meta">Runs this agent on its own, exactly as it is on screen, saved or not. Nothing here changes a team.</p>
      <form className="agent-bench-ask" onSubmit={(event) => { event.preventDefault(); void start() }}>
        <textarea
          rows={3}
          value={request}
          maxLength={8000}
          placeholder="Give it a real request, the kind a team would hand it"
          disabled={starting || live}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void start() } }}
        />
        <div className="agent-bench-acts">
          {live
            ? <button type="button" className="btn" onClick={() => run && void cancelRun(run.id).then(apply, (failed: unknown) => setError(message(failed)))}><Square size={12} aria-hidden="true" />Stop</button>
            : <button type="submit" className="btn btn-primary" disabled={Boolean(blocked) || !request.trim() || starting}>{starting ? 'Starting…' : run ? 'Try again' : 'Try it'}</button>}
          {blocked && !live && <span className="t-meta">{blocked}</span>}
        </div>
      </form>
      {error && <p role="alert" className="agent-bench-error">{error}</p>}
      {run && record && (
        <div className={`agent-bench-result st-${record.status}`} aria-live="polite" data-tour="bench-result" data-tour-done={isTerminalRun(record.status) || undefined}>
          <div className="agent-bench-status">
            <span className={`agent-bench-dot st-${record.status}`} aria-hidden="true" />
            <b>{record.permissionRequests?.length ? 'Waiting for you' : record.waitingOn ? 'It has a question' : STATUS_WORD[record.status]}</b>
            <span className="t-meta">{[seconds(record), record.eventCount ? `${record.eventCount} events` : null, tokens].filter(Boolean).join(' · ')}</span>
            <a className="link agent-bench-open" href={`/?path=${encodeURIComponent(run.path)}&run=${encodeURIComponent(run.id)}`}>See every step<ExternalLink size={12} aria-hidden="true" /></a>
          </div>
          {(record.permissionRequests ?? []).map((ask) => {
            const sw = ALLOW_SWITCHES.find((item) => item.key === ask.switch)
            return (
              <div key={ask.id} className="agent-bench-ask-card" role="group" aria-label={`${ask.title} needs your answer`}>
                <p><b>It wants to: {ask.title}</b>{ask.detail ? <code>{ask.detail}</code> : null}</p>
                {sw && <p className="t-meta">“{sw.label}” is off, so it asks you. In a scheduled team this would be declined.</p>}
                <div className="agent-bench-acts">
                  <button type="button" className="btn btn-primary" onClick={() => void answer(ask, 'allow_once')}>Allow once</button>
                  {sw && <button type="button" className="btn" onClick={() => void answer(ask, 'allow_once', true)}>Allow from now on</button>}
                  <button type="button" className="btn" onClick={() => void answer(ask, 'deny')}>Decline</button>
                </div>
              </div>
            )
          })}
          {record.waitingOn?.kind === 'question' && <Question record={record} onAnswer={(text) => run && void answerRun(run.id, record.waitingOn!.node, text).then(apply, (failed: unknown) => setError(message(failed)))} />}
          {record.reply && <div className="agent-bench-reply"><Markdown>{record.reply}</Markdown></div>}
          {record.status === 'failed' && record.error && <p role="alert" className="agent-bench-error">{record.error}</p>}
          {isTerminalRun(record.status) && !record.reply && record.status === 'succeeded' && <p className="t-meta">It finished without a reply.</p>}
        </div>
      )}
    </section>
  )
}

function Question({ record, onAnswer }: { record: RunRecord; onAnswer: (text: string) => void }) {
  const [text, setText] = useState('')
  return (
    <form className="agent-bench-ask-card" onSubmit={(event) => { event.preventDefault(); if (text.trim()) onAnswer(text.trim()) }}>
      <p><b>It asks:</b> {record.waitingOn?.question}</p>
      <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder="Your answer" />
      <div className="agent-bench-acts"><button type="submit" className="btn btn-primary" disabled={!text.trim()}>Answer</button></div>
    </form>
  )
}

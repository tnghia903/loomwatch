import { ArrowUpCircle, Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'

import { relativeTime } from '../../lib/format'
import { fetchRuns } from '../../lib/runs/client'
import { teamLabel } from '../../lib/story/needsYou'
import {
  checkForUpdates,
  fetchUpdateStatus,
  InstallRefused,
  offerUpdate,
  openUpdates,
  rollbackCommand,
  saveUpdateSettings,
  setUpdateStatus,
  updateAndRestart,
  UPDATES_EVENT,
  useInstallProgress,
  useUpdateStatus,
  type InstallProgress,
  type LiveRun,
  type Release,
  type UpdateSettings,
  type UpdateStatus,
} from '../../lib/updates/client'
import { Markdown } from '../ui/Markdown'
import { preloadMarkdown } from '../ui/preloadMarkdown'

/** How often an open tab asks the daemon what its daily check found. Asking costs nothing. */
const REFRESH_MS = 60 * 60 * 1000

/**
 * Keeps the app's idea of the newest release current, and opens the updates dialog when anything
 * calls `openUpdates()`. Mounted once, beside Send feedback.
 */
export function Updates() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => {
      fetchUpdateStatus(controller.signal).then(setUpdateStatus).catch(() => {
        // An older daemon, or one that is down, has no news to give: nothing to show.
      })
    }
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    const show = () => setOpen(true)
    window.addEventListener(UPDATES_EVENT, show)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener(UPDATES_EVENT, show)
    }
  }, [])
  if (!open) return null
  return <UpdatesDialog onClose={() => setOpen(false)} />
}

/**
 * Home's pill, shown only when a newer release is out and the operator has not skipped it. It
 * opens the dialog rather than updating: updating stops LoomWatch, which is the operator's call.
 */
export function UpdateBadge() {
  const status = useUpdateStatus()
  const offered = offerUpdate(status)
  // The notes are Markdown: fetch their renderer now, so the dialog opens formatted.
  useEffect(() => { if (offered) preloadMarkdown() }, [offered])
  if (!offered || !status?.latest) return null
  return (
    <button type="button" className="home-update" onClick={openUpdates} title={`LoomWatch ${status.latest.version} is available`}>
      <ArrowUpCircle size={15} aria-hidden="true" />
      <span className="home-update-label">Update available</span>
      <span className="visually-hidden">: LoomWatch {status.latest.version}</span>
    </button>
  )
}

function published(at: string | null): string | null {
  if (!at) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

function headline(status: UpdateStatus | null, checking: boolean, progress: InstallProgress): string {
  if (progress.phase === 'updating') return `Updating to ${progress.to}…`
  if (progress.phase === 'updated') return `Updated to ${progress.version}`
  if (progress.phase === 'failed') return 'The update didn’t finish'
  if (progress.phase === 'lost') return 'LoomWatch hasn’t come back'
  if (!status) return checking ? 'Checking for updates…' : 'LoomWatch updates'
  if (status.available && status.latest) return `LoomWatch ${status.latest.version} is available`
  if (status.checkedAt) return 'LoomWatch is up to date'
  return 'LoomWatch updates'
}

/** Where Update and restart got to, once LoomWatch agreed to stop. */
function Progress({ progress }: { progress: Exclude<InstallProgress, { phase: 'idle' }> }) {
  switch (progress.phase) {
    case 'updating':
      return (
        <p role="status" className="up-progress">
          LoomWatch is saving a copy of your run history, installing {progress.to} and starting again. Keep its terminal window open. This page says when it is back.
        </p>
      )
    case 'updated':
      return <p role="status" className="up-progress">LoomWatch {progress.version} is running. Reload this page to use it.</p>
    case 'failed':
      return (
        <p role="alert" className="up-error">
          LoomWatch {progress.version} was started again instead of {progress.to}. {progress.error ?? 'The terminal window running LoomWatch says why.'}
        </p>
      )
    case 'lost':
      return <p role="alert" className="up-error">LoomWatch didn’t answer for ten minutes after it stopped to install {progress.to}. Look in the terminal window running it.</p>
  }
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Update and restart, for a ready-built copy whose launcher starts it again. It asks first, naming
 * the teams at work that updating would stop. The command stays beside it for the terminal.
 */
function UpdateAndRestart({ latest, command, rollback, installError, copyButton }: {
  latest: Release
  command: string | null
  rollback: string | null
  installError: string | null
  copyButton: (command: string) => ReactNode
}) {
  const [confirming, setConfirming] = useState(false)
  // Null while LoomWatch is asked which teams are at work.
  const [working, setWorking] = useState<LiveRun[] | null>(null)
  const [unchecked, setUnchecked] = useState(false)
  const [startedSince, setStartedSince] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function ask() {
    setConfirming(true)
    setWorking(null)
    setUnchecked(false)
    setStartedSince(false)
    setProblem(null)
    try {
      const runs = await fetchRuns()
      setWorking(runs.filter((run) => !FINISHED.has(run.status)).map(({ runId, teamPath, status }) => ({ runId, teamPath, status })))
    } catch {
      // Not knowing is not agreeing: LoomWatch refuses, naming them, if a team turns out to be at work.
      setUnchecked(true)
      setWorking([])
    }
  }

  async function update() {
    setBusy(true)
    setProblem(null)
    try {
      await updateAndRestart((working ?? []).length > 0)
    } catch (caught) {
      if (caught instanceof InstallRefused && caught.code === 'runs_live') {
        setWorking(caught.liveRuns)
        setStartedSince(true)
      } else {
        setProblem(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      setBusy(false)
    }
  }

  const teams = working ?? []
  const names = new Map<string, string>()
  return (
    <>
      {installError && <p role="status" className="up-error">The last update didn’t finish. {installError}</p>}
      {confirming ? (
        <div className="up-confirm" role="group" aria-label={`Update to ${latest.version}?`}>
          <p className="up-confirm-q">Update to {latest.version} now?</p>
          {working === null ? (
            <p className="fb-note">Checking whether a team is working…</p>
          ) : teams.length > 0 ? (
            <>
              <p>{startedSince ? 'A team started working since you asked. ' : ''}{teams.length === 1 ? 'This team is working, and updating stops it:' : 'These teams are working, and updating stops them:'}</p>
              <ul className="up-runs">
                {teams.map((run) => <li key={run.runId}>{teamLabel(run.teamPath, names)}</li>)}
              </ul>
            </>
          ) : (
            <p>{unchecked ? 'LoomWatch couldn’t say whether a team is working. It asks again before it stops one.' : 'No team is working.'} LoomWatch is unavailable until it starts again, in a minute or two.</p>
          )}
          {problem && <p role="alert" className="up-error">{problem}</p>}
          <div className="up-acts">
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => void update()} disabled={busy || working === null}>
              {busy ? 'Stopping LoomWatch…' : teams.length > 0 ? `Stop ${teams.length === 1 ? 'it' : 'them'} and update` : 'Update and restart'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p>LoomWatch saves a copy of your run history, installs {latest.version} and starts again in its terminal window. It takes a minute or two.</p>
          <div className="up-acts">
            <button type="button" className="btn btn-primary" onClick={() => void ask()}>Update and restart</button>
          </div>
        </>
      )}
      {command && (
        <p className="fb-note">
          Or press <kbd>Ctrl</kbd>-<kbd>C</kbd> in that window and run <code className="t-mono-sm">{command}</code>{copyButton(command)}
          {rollback && <> If the new version gives you trouble, <code className="t-mono-sm">{rollback}</code> goes back to this one.</>}
        </p>
      )}
    </>
  )
}

/**
 * What the newest release changes and how to install it, with the daily check's switch. A
 * ready-built copy whose launcher starts it again offers Update and restart; any other copy shows
 * the steps for the terminal LoomWatch runs in.
 */
export function UpdatesDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const status = useUpdateStatus()
  const progress = useInstallProgress()
  const [busy, setBusy] = useState<'check' | 'settings' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Opened before the first answer arrived (the palette, on a slow start): ask for it.
  useEffect(() => {
    if (status) return
    const controller = new AbortController()
    fetchUpdateStatus(controller.signal).then(setUpdateStatus).catch((caught: unknown) => {
      if (!controller.signal.aborted) setProblem(caught instanceof Error ? caught.message : String(caught))
    })
    return () => controller.abort()
  }, [status])

  async function run(kind: 'check' | 'settings', request: () => Promise<UpdateStatus>) {
    setBusy(kind)
    setProblem(null)
    try {
      setUpdateStatus(await request())
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  const save = (settings: UpdateSettings) => void run('settings', () => saveUpdateSettings(settings))

  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const latest = status?.available ? status.latest : null
  const skipped = Boolean(latest && status?.skipped === latest.version)
  const releasedOn = published(latest?.publishedAt ?? null)
  const command = status?.command ?? null
  const rollback = status?.install === 'release' ? rollbackCommand(command) : null
  // What the daemon's last check met is news; a click that failed just now is an alert.
  const error = problem ?? status?.error ?? null
  // Once LoomWatch stopped to update, the dialog follows that, not the release it offered.
  const following = progress.phase === 'updating' || progress.phase === 'updated'
  const copyButton = (text: string) => (
    <button type="button" className="iconbtn" onClick={() => void copy(text)} aria-label={copied ? 'Copied' : 'Copy the command'} title="Copy">
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  )

  return (
    <div className="lw-scrim dim" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="pop e2 lw-feedback lw-updates"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
      >
        <h2 id={titleId}>{headline(status, busy === 'check', progress)}</h2>
        {status && (
          <p className="up-meta">
            You have {status.current}.{releasedOn && ` ${latest?.version} came out on ${releasedOn}.`}
            {status.checkedAt && ` Checked ${relativeTime(new Date(status.checkedAt))}.`}
          </p>
        )}
        {error && <p role={problem ? 'alert' : 'status'} className="up-error">{error}</p>}
        {progress.phase !== 'idle' && <Progress progress={progress} />}

        {!following && latest && skipped && (
          <p className="fb-note">You chose to skip this version, so LoomWatch doesn’t point it out. <button type="button" className="link" onClick={() => save({ skipped: null })} disabled={busy !== null}>Point it out again</button></p>
        )}

        {!following && latest && latest.notes && (
          <section className="up-notes" aria-label="What’s new">
            <span className="nt-label">What’s new</span>
            <div className="up-notes-body"><Markdown>{latest.notes}</Markdown></div>
          </section>
        )}
        {!following && latest && (
          <a className="up-link" href={latest.url} target="_blank" rel="noreferrer">Read the release notes on GitHub<ExternalLink size={13} aria-hidden="true" /></a>
        )}

        {!following && latest && (
          <section className="up-how" aria-label="How to update">
            <span className="nt-label">How to update</span>
            {status?.canInstall ? (
              <UpdateAndRestart latest={latest} command={command} rollback={rollback} installError={status.installError ?? null} copyButton={copyButton} />
            ) : command ? (
              <>
                <ol>
                  <li>Wait until no team is working. Updating stops LoomWatch for a minute or two.</li>
                  <li>In the terminal window running LoomWatch, press <kbd>Ctrl</kbd>-<kbd>C</kbd>.</li>
                  <li>
                    Run this in that window:
                    <span className="up-command">
                      <code className="t-mono-sm">{command}</code>
                      {copyButton(command)}
                    </span>
                  </li>
                </ol>
                <p className="fb-note">
                  It saves a copy of your run history first, then starts the new version.
                  {status?.install === 'source' && ' A copy of the source code is rebuilt, which takes a few minutes.'}
                  {rollback && <> If the new version gives you trouble, <code className="t-mono-sm">{rollback}</code> goes back to this one.</>}
                </p>
              </>
            ) : (
              <p>Download it from the release page above, or update LoomWatch the way you installed it.</p>
            )}
          </section>
        )}

        <div className="up-auto">
          <label>
            <input
              type="checkbox"
              checked={Boolean(status?.automatic) && !status?.turnedOffBy}
              disabled={!status || Boolean(status.turnedOffBy) || busy !== null}
              onChange={(event) => save({ automatic: event.target.checked })}
            />
            Check for new versions once a day
          </label>
          <p className="fb-note">
            {status?.turnedOffBy
              ? `Turned off on this computer by the ${status.turnedOffBy} setting.`
              : 'LoomWatch asks GitHub for the newest version number. Nothing about you, your teams or your runs is sent.'}
          </p>
        </div>

        <div className="fb-acts">
          {!following && latest && !skipped && (
            <button type="button" className="btn" onClick={() => save({ skipped: latest.version })} disabled={busy !== null}>Skip this version</button>
          )}
          {!following && (
            <button type="button" className="btn" onClick={() => void run('check', checkForUpdates)} disabled={busy !== null || Boolean(status?.turnedOffBy)}>
              {busy === 'check' ? 'Checking…' : 'Check now'}
            </button>
          )}
          {progress.phase === 'updated' ? (
            <>
              <button type="button" className="btn" onClick={onClose}>Close</button>
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()} autoFocus>Reload</button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>Close</button>
          )}
        </div>
      </div>
    </div>
  )
}

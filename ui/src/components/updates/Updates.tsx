import { ArrowUpCircle, Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { relativeTime } from '../../lib/format'
import {
  checkForUpdates,
  fetchUpdateStatus,
  offerUpdate,
  openUpdates,
  rollbackCommand,
  saveUpdateSettings,
  setUpdateStatus,
  UPDATES_EVENT,
  useUpdateStatus,
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

function headline(status: UpdateStatus | null, checking: boolean): string {
  if (!status) return checking ? 'Checking for updates…' : 'LoomWatch updates'
  if (status.available && status.latest) return `LoomWatch ${status.latest.version} is available`
  if (status.checkedAt) return 'LoomWatch is up to date'
  return 'LoomWatch updates'
}

/**
 * What the newest release changes and how to install it, with the daily check's switch. Nothing
 * here installs anything: the steps are the operator's, in the terminal LoomWatch runs in.
 */
export function UpdatesDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const status = useUpdateStatus()
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
        <h2 id={titleId}>{headline(status, busy === 'check')}</h2>
        {status && (
          <p className="up-meta">
            You have {status.current}.{releasedOn && ` ${latest?.version} came out on ${releasedOn}.`}
            {status.checkedAt && ` Checked ${relativeTime(new Date(status.checkedAt))}.`}
          </p>
        )}
        {error && <p role={problem ? 'alert' : 'status'} className="up-error">{error}</p>}

        {latest && skipped && (
          <p className="fb-note">You chose to skip this version, so LoomWatch doesn’t point it out. <button type="button" className="link" onClick={() => save({ skipped: null })} disabled={busy !== null}>Point it out again</button></p>
        )}

        {latest && latest.notes && (
          <section className="up-notes" aria-label="What’s new">
            <span className="nt-label">What’s new</span>
            <div className="up-notes-body"><Markdown>{latest.notes}</Markdown></div>
          </section>
        )}
        {latest && (
          <a className="up-link" href={latest.url} target="_blank" rel="noreferrer">Read the release notes on GitHub<ExternalLink size={13} aria-hidden="true" /></a>
        )}

        {latest && (
          <section className="up-how" aria-label="How to update">
            <span className="nt-label">How to update</span>
            {command ? (
              <>
                <ol>
                  <li>Wait until no team is working. Updating stops LoomWatch for a minute or two.</li>
                  <li>In the terminal window running LoomWatch, press <kbd>Ctrl</kbd>-<kbd>C</kbd>.</li>
                  <li>
                    Run this in that window:
                    <span className="up-command">
                      <code className="t-mono-sm">{command}</code>
                      <button type="button" className="iconbtn" onClick={() => void copy(command)} aria-label={copied ? 'Copied' : 'Copy the command'} title="Copy">
                        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                      </button>
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
          {latest && !skipped && (
            <button type="button" className="btn" onClick={() => save({ skipped: latest.version })} disabled={busy !== null}>Skip this version</button>
          )}
          <button type="button" className="btn" onClick={() => void run('check', checkForUpdates)} disabled={busy !== null || Boolean(status?.turnedOffBy)}>
            {busy === 'check' ? 'Checking…' : 'Check now'}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>Close</button>
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'

import type { DetectedHarness } from '../../lib/harnesses'
import { teamDisplayName } from '../../lib/team-file/client'
import { openTeam, useTeamList } from '../../lib/team-file/useTeamList'
import { NewTeamDialog } from '../home/NewTeamDialog'

export function ConflictSheetFooter({ onKeepMine, onUseDisk }: { onKeepMine: () => void; onUseDisk: () => void }) {
  const [confirmDisk, setConfirmDisk] = useState(false)
  return (
    <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)', padding: 'var(--sp-3) var(--sp-4)', borderTop: '1px solid var(--color-hairline)' }}>
      <button type="button" className="btn" onClick={onKeepMine}>Keep mine</button>
      <button type="button" className={`btn ${confirmDisk ? 'btn-danger' : ''}`} onClick={() => (confirmDisk ? onUseDisk() : setConfirmDisk(true))} style={confirmDisk ? { color: 'var(--color-alert)' } : undefined}>{confirmDisk ? 'Discard my edits?' : 'Use disk'}</button>
    </footer>
  )
}

export function InlineConfirm({ message, confirmLabel, onConfirm, onCancel }: { message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" aria-label={message} className="pointer-events-none absolute inset-x-0 z-50 flex justify-center" style={{ bottom: 'calc(var(--lw-panel-inset) + 72px)' }}>
      <div className="e2 lw-confirm t-body" style={{ pointerEvents: 'auto' }}>
        <span>{message}</span>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger-fill" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  )
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="lw-scrim dim" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={label} className="pop e2" style={{ left: '50%', top: '22%', transform: 'translateX(-50%)', width: 'min(480px, calc(100vw - 32px))', padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
        {children}
      </div>
    </div>
  )
}

export function OpenTeamSheet({ onClose }: { onClose: () => void }) {
  const { teams, error } = useTeamList()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = (teams ?? []).filter((team) => !needle || teamDisplayName(team).toLowerCase().includes(needle) || team.path.toLowerCase().includes(needle))
  return (
    <Sheet label="Open a team" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (matches[0]) openTeam(matches[0].path) }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <label className="field"><span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>Open a team</span><input autoFocus className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a team by name" /></label>
        <div className="pop-list" style={{ padding: 0, maxHeight: 280 }} aria-label="Your teams">
          {teams === null && !error && <p role="status" className="pop-empty t-meta">Finding teams…</p>}
          {error && <p role="alert" className="pop-empty t-meta" style={{ color: 'var(--color-alert)' }}>{error}</p>}
          {teams !== null && matches.length === 0 && <p className="pop-empty t-meta">No team matches.</p>}
          {matches.map((team) => (
            <button key={team.path} type="button" onClick={() => openTeam(team.path)} className="pop-row" style={{ height: 'auto', padding: '8px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
              <span className="name t-body-m">{teamDisplayName(team)}</span>
              <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{team.path}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
      </form>
    </Sheet>
  )
}

export function SaveCopySheet({ onClose, onSave, error }: { onClose: () => void; onSave: (path: string) => Promise<boolean>; error: string | null }) {
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempted, setAttempted] = useState(false)
  return (
    <Sheet label="Save a copy" onClose={onClose}>
      <form onSubmit={async (event) => { event.preventDefault(); setAttempted(true); if (!path.trim() || saving) return; setSaving(true); const saved = await onSave(path.trim()); setSaving(false); if (saved) onClose() }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <label className="field"><span className="t-micro" style={{ color: 'var(--color-ink-3)' }}>Save copy as</span><input autoFocus className="input mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="research-team-copy.yaml" /><span className="hint t-meta">Relative to the daemon teams directory.</span></label>
        {attempted && error && <p role="alert" className="t-meta" style={{ color: 'var(--color-alert)', margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!path.trim() || saving}>{saving ? 'Saving…' : 'Save a copy'}</button></div>
      </form>
    </Sheet>
  )
}

export function NewTeamSheet({ harnesses, openTeamUnsaved, onClose, onCreateBlank }: { harnesses: DetectedHarness[]; openTeamUnsaved: boolean; onClose: () => void; onCreateBlank: (name: string, path: string) => void }) {
  const { teams } = useTeamList()
  return <NewTeamDialog harnesses={harnesses} existingPaths={teams?.map((team) => team.path) ?? []} openTeamUnsaved={openTeamUnsaved} onCreateBlank={onCreateBlank} onClose={onClose} />
}

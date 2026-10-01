import { Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'

import { useTheme } from '../../lib/theme'
import { slugifyTeamName } from '../../lib/team-file/useTeamDocument'
import { ChipDot, LoomMark } from '../ui/glyphs'

export interface FirstRunProps {
  harnessCount: number
  loading: boolean
  harnessError: string | null
  creating: boolean
  name: string
  onNameChange: (name: string) => void
  onStart: () => void
  onCancel: () => void
  onCreate: () => void
  onOpen: () => void
  onPalette: () => void
  children?: ReactNode
}

// UX_REDESIGN §10.1: one centred composition, one action, no wizard, no tour. The only
// screen using the serif display step. Bottom-left carries the one line that matters.
export function FirstRun({ harnessCount, loading, harnessError, creating, name, onNameChange, onStart, onCancel, onCreate, onOpen, onPalette, children }: FirstRunProps) {
  const { resolved, toggle } = useTheme()
  const foot = loading ? 'Looking for harnesses…' : harnessError ? `Couldn't read the harness list: ${harnessError}` : harnessCount === 0 ? 'No agent harnesses found on PATH' : `${harnessCount} harness${harnessCount === 1 ? '' : 'es'} ready`
  return (
    <div className="lw-firstrun">
      <div className="ground" aria-hidden="true" />
      <main className="fr-stack">
        <LoomMark />
        <h1 className="fr-title t-display">LoomWatch</h1>
        <p className="fr-sub t-body">Compose a team of agents. Watch them work.</p>
        {!creating ? (
          <>
            <div className="fr-cta"><button type="button" className="btn btn-primary btn-lg" onClick={onStart}>New team</button></div>
            <button type="button" className="link fr-alt" onClick={onOpen}>or open an existing team</button>
          </>
        ) : (
          <form className="fr-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate() }} onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}>
            <input autoFocus className="input" value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Research and review" aria-label="Team name" />
            <p className="t-mono-sm" style={{ color: 'var(--color-ink-3)', margin: 0 }}>{slugifyTeamName(name)}.yaml in the teams folder</p>
            <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
              <button type="button" className="btn" onClick={onCancel}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Create team</button>
            </div>
          </form>
        )}
      </main>
      <div className="fr-foot t-meta">
        <ChipDot state={harnessError ? 'invalid' : harnessCount === 0 && !loading ? 'incomplete' : 'dirty'} size={10} />
        <span>{foot}</span>
      </div>
      <div className="fr-corner e1">
        <button type="button" className="link t-meta" style={{ color: 'var(--color-ink-3)' }} onClick={onPalette} aria-label="Open the command palette">⌘K</button>
        <button type="button" className="iconbtn" onClick={toggle} aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title="Theme (⌘⇧L)">{resolved === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}</button>
      </div>
      {children}
    </div>
  )
}

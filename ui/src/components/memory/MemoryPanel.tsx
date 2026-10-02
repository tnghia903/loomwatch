import { FilePlus2, PackageOpen, PencilLine, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { MemoryEntry, MemoryView, Note, NotebookView } from '../../lib/memory/client'
import { NotebookTab } from './NotebookTab'

/**
 * The Memory panel, Brief tab (docs/TEAM_MEMORY.md → "The Memory panel").
 *
 * `e2`, not `e1`: DESIGN_LANGUAGE §7 keeps carefully-read text off a blurred backdrop, and this
 * panel exists to be read and edited at length.
 *
 * Copy rules from the design, and they are load-bearing: the four words are **supplied**,
 * **retrieved**, **kept** and **eligible**. Never "the agent knows", "remembers" or "has read".
 * The budget is stated in characters because adapters do not report live context occupancy, so
 * anything shaped like a "63% full" meter would be invented.
 *
 * The Notebook tab is memory phase 2 and lives in [`NotebookTab`]; this file owns the tab strip,
 * the Brief, and the inherited group the Brief gained with inheritance.
 */
export interface MemoryPanelProps {
  /** Team file path, for the subtitle. */
  teamPath: string
  view: MemoryView | null
  loading: boolean
  error: string | null
  /** False when the document cannot be edited (read-only file, narrow window, live run). */
  editable: boolean
  /** Adds a note: writes the Markdown file, then registers it in `memory.brief`. */
  onWriteNote: (body: string) => Promise<void>
  /** Registers an existing Markdown file that is already beside the team file. */
  onAddFile: (path: string) => Promise<void>
  /**
   * Rewrites one Brief file in place. The team file is untouched — the entry already names this
   * path — so this is the edit that can happen mid-run, and the one the mid-run strip reports.
   */
  onEditNote?: (path: string, body: string) => Promise<void>
  onRemove: (path: string) => void
  onRetry: () => void
  onClose: () => void
  /** The team's notes. `undefined` while the caller does not read them (a narrow, Brief-only host). */
  notebook?: NotebookView | null
  notebookLoading?: boolean
  notebookError?: string | null
  onReviseNote?: (id: string, action: 'keep' | 'correct' | 'retire', change: { revision: number; title?: string; body?: string }) => Promise<void>
  onNoteHistory?: (id: string) => Promise<Note[]>
  onRetryNotebook?: () => void
  /**
   * Stop supplying one inherited Brief entry, by writing an `exclude` on the `inherits` entry.
   *
   * The only control a borrowing team gets over another team's Brief. It cannot edit it — the
   * file belongs to the origin team and `PUT /api/memory/file` is bounded to this team's own
   * directory — so declining an entry is the whole of it.
   */
  onExcludeInherited?: (origin: string, path: string) => void
  /** Open the origin team, where an inherited entry can actually be edited. */
  onOpenOriginTeam?: (origin: string) => void
  /** Write this team's Brief and kept notes to a pack folder under the teams root. */
  onExportPack?: () => Promise<string>
  /**
   * Entries the open document names that the saved team file does not yet: a note just added is
   * written to disk at once but joins the team only when the team is saved, and without this the
   * panel showed nothing at all for it.
   */
  unsavedEntries?: readonly string[]
  onSaveTeam?: () => void
}

type Draft =
  | { kind: 'note'; body: string }
  | { kind: 'file'; path: string }
  | { kind: 'edit'; path: string; title: string; body: string }
  | null

export function MemoryPanel({
  teamPath, view, loading, error, editable, onWriteNote, onAddFile, onEditNote, onRemove, onRetry, onClose,
  notebook = null, notebookLoading = false, notebookError = null, onReviseNote, onNoteHistory,
  onRetryNotebook, onExcludeInherited, onOpenOriginTeam, onExportPack, unsavedEntries = [], onSaveTeam,
}: MemoryPanelProps) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState<Draft>(null)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [tab, setTab] = useState<'brief' | 'notebook'>('brief')
  const [exported, setExported] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  const entries = view?.entries ?? []
  const inherited = view?.inherited ?? []
  const teamWide = entries.filter((entry) => !entry.appliesTo)
  const scoped = entries.filter((entry) => entry.appliesTo)
  // Inherited entries are grouped by the team that wrote them, because "Inherited from Research
  // team" is a sentence about ownership and a flat list of borrowed rows is not.
  const byOrigin = new Map<string, MemoryEntry[]>()
  for (const entry of inherited) {
    const origin = entry.origin ?? 'another team'
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), entry])
  }
  const noteCount = (notebook?.notes.length ?? 0) + (notebook?.inherited.length ?? 0)
  const fits = view ? `fits ${format(view.usedChars)} of ${format(view.budgetChars)} chars` : '—'

  async function commit() {
    if (!draft) return
    setBusy(true)
    setWriteError(null)
    try {
      if (draft.kind === 'note') await onWriteNote(draft.body)
      else if (draft.kind === 'edit') await onEditNote?.(draft.path, draft.body.endsWith('\n') ? draft.body : `${draft.body}\n`)
      else await onAddFile(draft.path.trim())
      setDraft(null)
    } catch (caught: unknown) {
      setWriteError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside
      className="panel right top e2 lw-activity"
      role="region"
      aria-labelledby="memory-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        // Escape backs out of the draft first: losing typed text to a panel close is the one
        // thing this panel must not do.
        if (draft) setDraft(null)
        else onClose()
      }}
    >
      <header className="insp-head">
        <span className="insp-text">
          <div className="insp-title t-title" id="memory-title">Memory</div>
          <div className="insp-id t-mono">{teamPath} · {fits}</div>
        </span>
        <button ref={closeButton} type="button" className="iconbtn" onClick={onClose} aria-label="Close Memory" title="Close (Esc)"><X size={15} aria-hidden="true" /></button>
      </header>

      <div className="zone" role="tablist" aria-label="Memory tabs" style={{ flexDirection: 'row', gap: 'var(--sp-4)' }}>
        <button type="button" role="tab" aria-selected={tab === 'brief'} className="link t-body-m"
          style={{ color: tab === 'brief' ? 'var(--color-ink)' : 'var(--color-ink-3)', borderBottom: tab === 'brief' ? '2px solid var(--color-accent)' : '2px solid transparent', paddingBottom: 4 }}
          onClick={() => setTab('brief')}>
          Brief <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{briefCount(entries.length, inherited.length)}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'notebook'} className="link t-body-m"
          style={{ color: tab === 'notebook' ? 'var(--color-ink)' : 'var(--color-ink-3)', borderBottom: tab === 'notebook' ? '2px solid var(--color-accent)' : '2px solid transparent', paddingBottom: 4 }}
          onClick={() => setTab('notebook')}>
          Notebook <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{noteCount}</span>
        </button>
      </div>

      {tab === 'notebook' && (
        <NotebookTab
          view={notebook} loading={notebookLoading} error={notebookError} editable={editable}
          onRevise={onReviseNote ?? (() => Promise.resolve())}
          onHistory={onNoteHistory ?? (() => Promise.resolve([]))}
          onRetry={onRetryNotebook ?? onRetry}
        />
      )}

      {tab === 'brief' && <>

      {loading && <p className="hint t-meta" style={{ margin: 0 }}>Reading the Brief…</p>}

      {error && !loading && (
        <div className="inline-error" role="alert">
          <span className="msg t-body">Couldn't read this team's Brief.</span>
          <span className="detail t-mono-sm">{error}</span>
          <span><button type="button" className="btn" onClick={onRetry}>Try again</button></span>
        </div>
      )}

      {!loading && !error && entries.length === 0 && unsavedEntries.length === 0 && (
        <p className="t-body" style={{ margin: 0 }}>Give your team something to keep in mind.</p>
      )}

      {!loading && !error && unsavedEntries.length > 0 && (
        <div className="zone" role="status">
          <div className="zone-head t-micro"><span>Not saved yet</span><span>{unsavedEntries.length}</span></div>
          {unsavedEntries.map((path) => <span key={path} className="t-mono-sm" style={{ color: 'var(--color-ink-2)', overflowWrap: 'anywhere' }}>{path}</span>)}
          <p className="hint t-meta" style={{ margin: 0 }}>
            Save the team to keep {unsavedEntries.length === 1 ? 'this entry' : 'these entries'}. Agents are given the Brief from the next run.
          </p>
          {onSaveTeam && editable && <span><button type="button" className="btn btn-primary" onClick={onSaveTeam}>Save team</button></span>}
        </div>
      )}

      {!loading && !error && teamWide.length > 0 && (
        <div className="zone">
          <div className="zone-head t-micro"><span>Whole team</span><span>{teamWide.length}</span></div>
          {teamWide.map((entry) => (
            <BriefRow key={entry.path} title={entry.title} meta={`${entry.path} · whole team · always · ${format(entry.chars)} chars`} body={entry.body} editable={editable} onRemove={() => onRemove(entry.path)} onEdit={onEditNote ? () => { setWriteError(null); setDraft({ kind: 'edit', path: entry.path, title: entry.title, body: entry.body }) } : undefined} />
          ))}
        </div>
      )}

      {!loading && !error && scoped.length > 0 && (
        <div className="zone">
          <div className="zone-head t-micro"><span>Scoped to some agents</span><span>{scoped.length}</span></div>
          {scoped.map((entry) => (
            <BriefRow key={entry.path} title={entry.title} meta={`${entry.path} · ${entry.appliesTo?.join(', ')} only · always · ${format(entry.chars)} chars`} body={entry.body} editable={editable} onRemove={() => onRemove(entry.path)} onEdit={onEditNote ? () => { setWriteError(null); setDraft({ kind: 'edit', path: entry.path, title: entry.title, body: entry.body }) } : undefined} />
          ))}
        </div>
      )}

      {!loading && !error && [...byOrigin.entries()].map(([origin, rows]) => (
        <div className="zone" key={origin}>
          <div className="zone-head t-micro">
            <span>Inherited from {origin}</span><span>{rows.length} · read-only</span>
          </div>
          {rows.map((entry) => (
            <InheritedRow
              key={`${origin}:${entry.path}`} entry={entry} origin={origin} editable={editable}
              onOpen={onOpenOriginTeam ? () => onOpenOriginTeam(origin) : undefined}
              onExclude={onExcludeInherited ? () => onExcludeInherited(origin, entry.path) : undefined}
            />
          ))}
        </div>
      ))}

      {/* Said once, under the inherited groups, and only when there are some: the zone heads
          already say "read-only", so this only adds what read-only means for a run. */}
      {!loading && !error && inherited.length > 0 && (
        <p className="hint t-meta" style={{ margin: 0 }}>
          Nothing this team writes goes back to an inherited entry. Each run is supplied them as
          they were when it started.
        </p>
      )}

      {!loading && !error && (
        <p className="hint t-meta" style={{ margin: 0 }}>
          Saved beside {teamPath}. Supplied to each agent at the start of its session
          {view?.deliverAs === 'native-file'
            ? ", and written into its workspace as the harness's own memory file."
            : '. This team is packet-only, so the Brief is not in the harness’s own memory file and a context compaction can summarise it away.'}
        </p>
      )}

      {draft && (
        <div className="zone">
          <div className="zone-head t-micro">{draft.kind === 'note' ? 'Write a note' : draft.kind === 'edit' ? `Edit ${draft.title}` : 'Add a file'}</div>
          {draft.kind === 'note' ? (
            <label className="field">
              <span className="t-meta">Plain words are fine. Its first line names the entry; start it with “# ” to give it a title of its own.</span>
              <textarea className="input" autoFocus value={draft.body} disabled={busy}
                onChange={(event) => setDraft({ kind: 'note', body: event.target.value })}
                placeholder={'# House constraints\nWe ship on ACP v1 only. Never touch main.'} />
            </label>
          ) : draft.kind === 'edit' ? (
            <label className="field">
              <span className="t-meta">Rewrites <code>{draft.path}</code>. The whole Brief is read once, at the start of a run, so a save during a run lands at the next session start.</span>
              <textarea className="input" autoFocus aria-label={`Edit ${draft.title}`} value={draft.body} disabled={busy}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
            </label>
          ) : (
            <label className="field">
              <span className="t-meta">A Markdown file already beside the team file, e.g. <code>brief/constraints.md</code>.</span>
              <input className="input mono" autoFocus value={draft.path} disabled={busy}
                onChange={(event) => setDraft({ kind: 'file', path: event.target.value })}
                placeholder="brief/constraints.md" />
            </label>
          )}
          {writeError && <p className="hint t-meta" role="alert" style={{ margin: 0, color: 'var(--color-alert)' }}>{writeError}</p>}
          <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
            <button type="button" className="btn btn-primary" disabled={busy || !draftReady(draft)} onClick={() => void commit()}>
              {busy ? 'Saving…' : draft.kind === 'edit' ? 'Save this entry' : 'Add to the Brief'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(null); setWriteError(null) }}>Cancel</button>
          </div>
          <p className="hint t-meta" style={{ margin: 0 }}>
            {draft.kind === 'edit'
              ? 'The file is written now. The team file already names this entry, so there is nothing else to save.'
              : 'The file is written now; the team file gains the entry as an unsaved change, so you review and save it like any other edit.'}
          </p>
        </div>
      )}

      {!draft && (
        <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
          <button type="button" className="btn" disabled={!editable} title={editable ? undefined : 'This team cannot be edited here.'} onClick={() => { setWriteError(null); setDraft({ kind: 'note', body: '' }) }}>
            <PencilLine size={13} aria-hidden="true" /> Write a note
          </button>
          <button type="button" className="btn" disabled={!editable} title={editable ? undefined : 'This team cannot be edited here.'} onClick={() => { setWriteError(null); setDraft({ kind: 'file', path: '' }) }}>
            <FilePlus2 size={13} aria-hidden="true" /> Add a file
          </button>
        </div>
      )}

      {/* A section of its own, after this team's own actions: exporting is about other teams, and
          as a bordered box beside the entries it read as one more Brief row. */}
      {!loading && !error && !draft && onExportPack && (
        <div className="zone">
          <div className="zone-head t-micro"><span>Share with another team</span></div>
          <p className="hint t-meta" style={{ margin: 0 }}>
            {exported
              ? <>Written to <code>{exported}</code>. Another team reads it with a <code>memory.inherits</code> entry naming that folder.</>
              : "Copies this team's Brief and kept notes into a folder another team can inherit."}
          </p>
          {exportError && <p className="hint t-meta" role="alert" style={{ margin: 0, color: 'var(--color-alert)' }}>{exportError}</p>}
          <span>
            <button type="button" className="btn" disabled={busy}
              onClick={() => { setBusy(true); setExportError(null); onExportPack().then(setExported).catch((caught: unknown) => setExportError(caught instanceof Error ? caught.message : String(caught))).finally(() => setBusy(false)) }}>
              <PackageOpen size={13} aria-hidden="true" /> {busy ? 'Exporting…' : 'Export memory'}
            </button>
          </span>
        </div>
      )}

      </>}
    </aside>
  )
}

/**
 * One inherited Brief row: dashed, read-only, and offering the only two things a borrowing team
 * can honestly do with another team's writing.
 */
function InheritedRow({
  entry, origin, editable, onOpen, onExclude,
}: {
  entry: MemoryEntry
  origin: string
  editable: boolean
  onOpen?: () => void
  onExclude?: () => void
}) {
  const [open, setOpen] = useState(false)
  const scope = entry.appliesTo ? `applies to ${entry.appliesTo.join(', ')}` : 'whole team'
  return (
    <div className="rt-strip t-meta" style={{ borderTop: 0, padding: '8px 10px', borderRadius: 'var(--r-sm)', background: 'var(--color-panel-solid)', border: '1px dashed var(--color-hairline)', alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', width: '100%', gap: 'var(--sp-3)', alignItems: 'baseline' }}>
        <b className="t-body-m" style={{ color: 'var(--color-ink)', flex: 1, minWidth: 0 }}>{entry.title}</b>
        <button type="button" className="link t-meta" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
        {onOpen && <button type="button" className="link t-meta" onClick={onOpen} title={`Edit this where it lives, on ${origin}`}>Open there</button>}
        {onExclude && (
          <button type="button" className="link t-meta" disabled={!editable} onClick={onExclude}
            title="Stop supplying this inherited entry. The origin team keeps it.">Exclude</button>
        )}
      </span>
      <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>
        {origin} · {entry.path} · {scope} · snapshot at run start
      </span>
      {open && <pre className="ent-out t-mono-sm">{entry.body}</pre>}
    </div>
  )
}

/** `1 + 2` when entries are inherited, matching the design's "Brief 1 + 2" tab count. */
function briefCount(own: number, inherited: number): string {
  return inherited > 0 ? `${own} + ${inherited}` : String(own)
}

function draftReady(draft: NonNullable<Draft>): boolean {
  if (draft.kind === 'note' || draft.kind === 'edit') return draft.body.trim().length > 0
  return /^[^/].*\.md$/.test(draft.path.trim())
}

function BriefRow({ title, meta, body, editable, onRemove, onEdit }: { title: string; meta: string; body: string; editable: boolean; onRemove: () => void; onEdit?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rt-strip t-meta" style={{ borderTop: 0, padding: '8px 10px', borderRadius: 'var(--r-sm)', background: 'var(--color-panel-solid)', border: '1px solid var(--color-hairline)', alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', width: '100%', gap: 'var(--sp-3)', alignItems: 'baseline' }}>
        <b className="t-body-m" style={{ color: 'var(--color-ink)', flex: 1, minWidth: 0 }}>{title}</b>
        <button type="button" className="link t-meta" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
        {onEdit && <button type="button" className="link t-meta" disabled={!editable} onClick={onEdit} title="Rewrite this Brief file">Edit</button>}
        {/* Removing the entry leaves the Markdown on disk: deleting an operator's own writing
            because they unpinned it would be the wrong default, and the file is theirs. */}
        <button type="button" className="link t-meta" disabled={!editable} onClick={onRemove} title="Stop supplying this entry. The file stays on disk.">Remove</button>
      </span>
      <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{meta}</span>
      {open && <pre className="ent-out t-mono-sm">{body}</pre>}
    </div>
  )
}

function format(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

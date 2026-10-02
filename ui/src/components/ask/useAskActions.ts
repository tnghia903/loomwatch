import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { decideRunRequest, fetchProposal, reportProposalOutcome, type Proposal } from '../../lib/ask/client'
import { proposalChanges, type ProposalChanges } from '../../lib/ask/proposal'
import type { ProposalCard, ReviewNoteCard, RunRequestCard } from '../../lib/ask/thread'
import { newStartKey, startRun, type RunRecord } from '../../lib/runs/client'
import type { useTeamDocument } from '../../lib/team-file/useTeamDocument'

type TeamDocumentApi = ReturnType<typeof useTeamDocument>

/** A proposal shown on the canvas and not applied yet. */
export interface ProposalPreview {
  proposal: Proposal
  changes: ProposalChanges
  /** The editor's YAML before the proposal went on the canvas; null for a new team. */
  beforeYaml: string | null
  applying: boolean
  error: string | null
}

/** What just happened, said once at the foot of the screen, with a way back where there is one. */
export interface AskNotice {
  text: string
  undo?: () => void
}

const NOTE_KEY = 'loomwatch:ask:note'
/** A proposal carried to the page of the team it is for, in case the daemon no longer has it. */
const CARRIED_PROPOSAL_KEY = 'loomwatch:ask:proposal'

/** The daemon names team files relative to the teams folder; an open team's path may be absolute. */
export function sameTeamFile(docPath: string | null, file: string): boolean {
  if (!docPath || !file) return false
  const relative = file.replace(/^\.\//, '')
  return docPath === file || docPath === relative || docPath.endsWith(`/${relative}`)
}

/** The open team's path as the daemon's tools spell it, relative to the teams folder when known. */
export function teamFileForAsk(docPath: string | null, teamsRoot: string | null): string | null {
  if (!docPath) return null
  if (teamsRoot && docPath.startsWith(`${teamsRoot.replace(/\/$/, '')}/`)) return docPath.slice(teamsRoot.replace(/\/$/, '').length + 1)
  return docPath
}

const CONNECTED_APP_NAMES: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', vscode: 'VS Code', opencode: 'OpenCode', 'claude-desktop': 'Claude Desktop',
}

/** Who made a proposal, in words: Ask LoomWatch, or the connected app (`connection:<app>`). */
export function proposalSource(source: string): string {
  const app = source.startsWith('connection:') ? source.slice('connection:'.length) : null
  return app ? CONNECTED_APP_NAMES[app] ?? app : 'Ask LoomWatch'
}

function teamUrl(file: string, extra: Record<string, string> = {}): string {
  return `/?${new URLSearchParams({ path: file, ...extra }).toString()}`
}

interface AskActionsOptions {
  doc: TeamDocumentApi
  conversationId: string | null
  activeRunId: string | null
  /** The open run is waiting for the person, so a drafted note can go in the answer box. */
  waiting: boolean
  /** Leave the Run view for Build, where a proposal is shown. */
  toBuild: () => void
  showRun: (runId: string | null) => void
  applyRecord: (record: RunRecord) => void
  onDocumentOpen: () => void
  /** Frame the given agents once they are on the canvas. */
  frame: (ids: string[]) => void
}

/**
 * What the Ask panel's cards do to the rest of LoomWatch: put a proposal on the canvas for the
 * person to apply or discard, start a run the assistant asked for, and carry a drafted review note
 * to the run that is waiting. Every one of these is the person's own action; the assistant only
 * prepared it (ADR 0033).
 */
export function useAskActions({ doc, conversationId, activeRunId, waiting, toBuild, showRun, applyRecord, onDocumentOpen, frame }: AskActionsOptions) {
  const [preview, setPreview] = useState<ProposalPreview | null>(null)
  const [notice, setNotice] = useState<AskNotice | null>(null)
  /** Agents that just became real, for one settling animation. */
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set())
  const [busyCard, setBusyCard] = useState<string | null>(null)
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null)
  /** A proposal the person took off the canvas with ⌘Z, to be recorded as discarded. */
  const [undone, setUndone] = useState<string | null>(null)
  /** A proposal the person saved without pressing Apply, to be recorded as applied. */
  const [savedElsewhere, setSavedElsewhere] = useState<string | null>(null)
  const frameRef = useRef(frame)
  // Undo runs after the render it caused, so it needs that render's document, not this one's.
  const docRef = useRef(doc)
  useEffect(() => { frameRef.current = frame; docRef.current = doc })

  const say = useCallback((next: AskNotice | null) => setNotice(next), [])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.undo ? 10_000 : 5000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (settled.size === 0) return
    const timer = window.setTimeout(() => setSettled(new Set()), 1400)
    return () => window.clearTimeout(timer)
  }, [settled])

  const begin = useCallback((proposal: Proposal, inPlace: boolean) => {
    const beforeYaml = inPlace ? doc.yamlPreview : null
    const changes = proposalChanges(inPlace ? doc.loadedYaml ?? doc.yamlPreview : null, proposal.yaml)
    const applied = inPlace ? doc.applyYaml(proposal.yaml) : doc.applyYaml(proposal.yaml, proposal.file)
    if (!applied) {
      say({ text: 'That proposal isn’t a team LoomWatch can open. Ask for it again.' })
      return
    }
    if (!inPlace) onDocumentOpen()
    setPreview({ proposal, changes, beforeYaml, applying: false, error: null })
    // Reviewing is not adding: the library folds away so the proposal has the canvas. After this
    // render, because from Home the canvas and its library are not on screen yet.
    const focus = changes.added.length + changes.changed.length > 0 ? [...changes.added, ...changes.changed] : []
    window.setTimeout(() => {
      window.dispatchEvent(new Event('loomwatch:collapse-palette'))
      window.setTimeout(() => frameRef.current(focus), 160)
    }, 100)
  }, [doc, onDocumentOpen, say])

  const presentRef = useRef<(proposal: Proposal) => void>(() => {})

  /** Put a proposal on the canvas: here when it is for the open team, otherwise on its own page. */
  const present = useCallback((proposal: Proposal) => {
    const id = proposal.id
    if (preview) {
      // A revised proposal replaces the one on the canvas: take that one off, then show this one
      // from the team as it was, so Discard and Undo still lead back to the person's own version.
      if (preview.proposal.id === id) return
      void reportProposalOutcome(preview.proposal.id, 'discarded').catch(() => {})
      const wasNew = preview.beforeYaml === null
      setPreview(null)
      if (wasNew) doc.closeDocument()
      else doc.undo()
      // Shown once the canvas is back to the person's own version, by the render that put it back.
      window.setTimeout(() => presentRef.current(proposal), 30)
      return
    }
    if (sameTeamFile(doc.path, proposal.file)) {
      if (doc.saveState !== 'new' && !['dirty', 'invalid', 'conflict'].includes(doc.saveState) && doc.loadedYaml?.trim() === proposal.yaml.trim()) {
        say({ text: `“${proposal.name || proposal.file}” is already exactly that. Nothing to change.` })
        return
      }
      toBuild()
      begin(proposal, true)
    } else if (!doc.path && proposal.isNew) {
      begin(proposal, false)
    } else {
      try { window.sessionStorage.setItem(CARRIED_PROPOSAL_KEY, JSON.stringify(proposal)) } catch { /* the daemon's copy is enough */ }
      window.location.assign(proposal.isNew ? `/?${new URLSearchParams({ proposal: id })}` : teamUrl(proposal.file, { proposal: id }))
    }
  }, [preview, doc, toBuild, begin, say])

  /**
   * The daemon keeps proposals in memory, so after a restart it no longer has one; the conversation
   * recorded the whole file with it, and that copy is shown instead.
   */
  const showProposal = useCallback(async (id: string, recorded?: ProposalCard) => {
    try {
      present(await fetchProposal(id))
    } catch (caught) {
      if (recorded?.yaml) {
        present({ id, source: '', file: recorded.file, name: recorded.name, isNew: recorded.isNew, yaml: recorded.yaml, baseRevision: null, summary: recorded.summary, createdAt: recorded.at })
        return
      }
      say({ text: caught instanceof Error ? caught.message : String(caught) })
    }
  }, [present, say])
  useEffect(() => { presentRef.current = present })

  // A proposal opened from another page arrives as `?proposal=`: shown once the team it is for has
  // loaded (or straight away for a new team), then dropped from the address so a reload is clean.
  const handledLink = useRef(false)
  useEffect(() => {
    if (handledLink.current) return
    const params = new URLSearchParams(window.location.search)
    const id = params.get('proposal')
    if (!id) return
    const requested = params.get('path')
    if (requested && doc.saveState !== 'error' && (!doc.path || doc.loadedYaml === null)) return
    handledLink.current = true
    params.delete('proposal')
    const query = params.toString()
    window.history.replaceState({}, '', query ? `/?${query}` : '/')
    let carried: Proposal | null = null
    try { carried = JSON.parse(window.sessionStorage.getItem(CARRIED_PROPOSAL_KEY) ?? 'null') as Proposal | null } catch { carried = null }
    window.sessionStorage.removeItem(CARRIED_PROPOSAL_KEY)
    if (requested && doc.saveState === 'error') return
    fetchProposal(id).then(present, (caught: unknown) => {
      if (carried?.id === id && carried.yaml) present(carried)
      else say({ text: caught instanceof Error ? caught.message : String(caught) })
    })
  }, [doc.path, doc.loadedYaml, doc.saveState, present, say])

  // The person undid the proposal with ⌘Z: the canvas is back where it was, so the preview ends —
  // decided while rendering the undo, so the heading never shows Apply over the old team.
  if (preview && !preview.applying && preview.beforeYaml !== null && doc.yamlPreview === preview.beforeYaml) {
    setUndone(preview.proposal.id)
    setPreview(null)
  }
  useEffect(() => {
    if (undone) void reportProposalOutcome(undone, 'discarded').catch(() => {})
  }, [undone])
  // Saved another way — ⌘S, or the Save beside the team's name — is applying it all the same.
  if (preview && !preview.applying && (doc.saveState === 'saved' || doc.saveState === 'clean')) {
    setSavedElsewhere(preview.proposal.id)
    setSettled(new Set([...preview.changes.added, ...preview.changes.changed]))
    setPreview(null)
  }
  useEffect(() => {
    if (savedElsewhere) void reportProposalOutcome(savedElsewhere, 'applied').catch(() => {})
  }, [savedElsewhere])

  const applyProposal = useCallback(async () => {
    if (!preview || preview.applying) return
    setPreview({ ...preview, applying: true, error: null })
    const saved = await doc.save()
    if (!saved) {
      setPreview({ ...preview, applying: false, error: 'Couldn’t save the team. The list at the top says what to fix first.' })
      return
    }
    void reportProposalOutcome(preview.proposal.id, 'applied').catch(() => {})
    setSettled(new Set([...preview.changes.added, ...preview.changes.changed]))
    const name = preview.proposal.name || preview.proposal.file
    const isNew = preview.beforeYaml === null
    setPreview(null)
    say({
      text: isNew ? `Saved “${name}”. Press Run team when you’re ready.` : `Applied the changes to “${name}”.`,
      undo: isNew ? undefined : () => {
        docRef.current.undo()
        // The file is put back too: Undo here means "as it was before I applied".
        window.setTimeout(() => {
          void docRef.current.save().then((ok) => {
            if (ok) void reportProposalOutcome(preview.proposal.id, 'undone').catch(() => {})
            say({ text: ok ? `Put “${name}” back the way it was.` : 'Undone on the canvas. Press Save to keep it.' })
          })
        }, 50)
      },
    })
  }, [preview, doc, say])

  const discardProposal = useCallback(() => {
    if (!preview) return
    void reportProposalOutcome(preview.proposal.id, 'discarded').catch(() => {})
    const isNew = preview.beforeYaml === null
    setPreview(null)
    if (isNew) doc.closeDocument()
    else doc.undo()
  }, [preview, doc])

  const startRequestedRun = useCallback(async (card: RunRequestCard) => {
    if (!conversationId || busyCard) return
    setBusyCard(card.id)
    setCardError(null)
    try {
      const record = await startRun(card.file, card.request, { startKey: newStartKey(), expectedRevision: null })
      await decideRunRequest(conversationId, card.id, 'started', record.runId).catch(() => {})
      if (sameTeamFile(doc.path, card.file)) {
        applyRecord(record)
        showRun(record.runId)
      } else {
        window.location.assign(teamUrl(card.file, { run: record.runId }))
      }
    } catch (caught) {
      setCardError({ id: card.id, message: caught instanceof Error ? caught.message : String(caught) })
    } finally {
      setBusyCard(null)
    }
  }, [conversationId, busyCard, doc.path, applyRecord, showRun])

  const declineRequestedRun = useCallback(async (card: RunRequestCard) => {
    if (!conversationId || busyCard) return
    setBusyCard(card.id)
    try {
      await decideRunRequest(conversationId, card.id, 'declined')
    } catch (caught) {
      setCardError({ id: card.id, message: caught instanceof Error ? caught.message : String(caught) })
    } finally {
      setBusyCard(null)
    }
  }, [conversationId, busyCard])

  const openRun = useCallback((runId: string, file: string) => {
    if (sameTeamFile(doc.path, file)) showRun(runId)
    else window.location.assign(teamUrl(file, { run: runId }))
  }, [doc.path, showRun])

  /**
   * The drafted note goes in the run's answer box — through `loomwatch:compose`, the request box's
   * one way in from outside — and the person reads it and sends it themselves.
   */
  const takeNote = useCallback((card: ReviewNoteCard) => {
    if (activeRunId === card.runId && waiting) {
      window.dispatchEvent(new CustomEvent('loomwatch:compose', { detail: card.text }))
      return
    }
    try { window.sessionStorage.setItem(NOTE_KEY, JSON.stringify({ runId: card.runId, text: card.text })) } catch { /* the note is still in the card */ }
    openRun(card.runId, card.file)
  }, [activeRunId, waiting, openRun])

  // A note carried to another run, or across a page load, lands once that run is open and waiting.
  useEffect(() => {
    if (!activeRunId || !waiting) return
    let carried: { runId?: string; text?: string } | null = null
    try { carried = JSON.parse(window.sessionStorage.getItem(NOTE_KEY) ?? 'null') } catch { carried = null }
    if (carried?.runId !== activeRunId || typeof carried.text !== 'string') return
    window.sessionStorage.removeItem(NOTE_KEY)
    window.dispatchEvent(new CustomEvent('loomwatch:compose', { detail: carried.text }))
  }, [activeRunId, waiting])

  /** How each agent on the canvas stands with the proposal: new, changed, or just settled. */
  const marks = useMemo(() => {
    const result = new Map<string, 'added' | 'changed' | 'settled'>()
    for (const id of settled) result.set(id, 'settled')
    if (preview) {
      for (const id of preview.changes.added) result.set(id, 'added')
      for (const id of preview.changes.changed) result.set(id, 'changed')
    }
    return result
  }, [preview, settled])

  return {
    preview, notice, dismissNotice: () => setNotice(null), marks, busyCard, cardError,
    showProposal, applyProposal, discardProposal, startRequestedRun, declineRequestedRun, openRun, takeNote,
  }
}

import { useEffect, useMemo, useRef, useState } from 'react'

import { decideRunRequest, type AskContext } from '../../lib/ask/client'
import type { ProposalCard, ReviewNoteCard, RunRequestCard } from '../../lib/ask/thread'
import { useAsk } from '../../lib/ask/useAsk'
import { newStartKey, startRun } from '../../lib/runs/client'
import { teamHref } from '../../lib/team-file/teamHref'
import { AskButton } from '../ask/AskButton'
import type { CardActions } from '../ask/AskCards'
import { AskPanel } from '../ask/AskPanel'
import { registerAskToggle } from '../frame/frameStore'

/** A team's page at one of its runs, or showing a proposal for it. */
function teamPage(file: string, extra: Record<string, string>): string {
  return `${teamHref(file, 'chat')}&${new URLSearchParams(extra).toString()}`
}

/**
 * Ask in a project's room (ADR 0097), under LoomWatch's own mark: it knows what every agent here
 * knows and the project's teams, and what it prepares (a team, a run, a note) opens on that team's
 * page for the person to apply, start or send. Nothing is saved or run from here.
 */
export function RoomAsk({ project, name }: { project: string; name: string }) {
  const context = useMemo<AskContext>(() => ({ view: 'project', teamPath: null, runId: null, project }), [project])
  const ask = useAsk(context)
  // The dock's Ask opens the room's own panel, about this project.
  const askRef = useRef(ask)
  useEffect(() => { askRef.current = ask })
  useEffect(() => registerAskToggle(() => askRef.current.setOpen(!askRef.current.open)), [])
  const [busyCard, setBusyCard] = useState<string | null>(null)
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null)
  const cards: CardActions = {
    previewingId: null,
    savedYamlFor: () => null,
    busyCard,
    cardError,
    // A proposal goes on its team's canvas, or a new team's, where Apply is.
    onShowProposal: (id: string, card?: ProposalCard) => {
      window.location.assign(card && !card.isNew ? teamPage(card.file, { proposal: id }) : `/?${new URLSearchParams({ proposal: id }).toString()}`)
    },
    onApply: () => {},
    onDiscard: () => {},
    onStartRun: (card: RunRequestCard) => {
      if (!ask.conversationId || busyCard) return
      const conversation = ask.conversationId
      setBusyCard(card.id)
      setCardError(null)
      void (async () => {
        try {
          const record = await startRun(card.file, card.request, { startKey: newStartKey(), expectedRevision: null })
          await decideRunRequest(conversation, card.id, 'started', record.runId).catch(() => {})
          window.location.assign(teamPage(card.file, { run: record.runId }))
        } catch (caught) {
          setCardError({ id: card.id, message: caught instanceof Error ? caught.message : String(caught) })
          setBusyCard(null)
        }
      })()
    },
    onDeclineRun: (card: RunRequestCard) => {
      if (!ask.conversationId) return
      void decideRunRequest(ask.conversationId, card.id, 'declined').catch((caught: unknown) => setCardError({ id: card.id, message: caught instanceof Error ? caught.message : String(caught) }))
    },
    onOpenRun: (runId: string, file: string) => window.location.assign(teamPage(file, { run: runId })),
    // The note goes in that run's answer box, unsent, as it does from a team's page.
    onUseNote: (card: ReviewNoteCard) => {
      try { window.sessionStorage.setItem('loomwatch:ask:note', JSON.stringify({ runId: card.runId, text: card.text })) } catch { /* the note is still in the card */ }
      window.location.assign(teamPage(card.file, { run: card.runId }))
    },
  }
  return (
    <>
      <AskButton ask={ask} />
      {ask.open && <AskPanel ask={ask} view="project" cards={cards} onHome title={`Ask about ${name}`} />}
    </>
  )
}

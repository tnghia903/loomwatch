import { useCallback, useEffect, useRef, useState } from 'react'

import { approveTeam, askRunAgent, answerRun, cancelRun, findRunByStartKey, isTerminalRun, newStartKey, RunApiError, STALE_TEAM_REVISION, startRun, TEAM_NEEDS_REVIEW, type TeamReview, type WaitingOn } from '../../lib/runs/client'
import type { useRunHistory } from '../../lib/runs/useRunHistory'
import type { useRunSession } from '../../lib/runs/useRunSession'
import type { useTeamDocument } from '../../lib/team-file/useTeamDocument'

type TeamDocument = ReturnType<typeof useTeamDocument>
type RunSession = ReturnType<typeof useRunSession>
type RunHistory = ReturnType<typeof useRunHistory>
type Lineage = { followsRunId?: string | null; startAt?: string | null; fromCheckpointId?: string | null }

/** A start the daemon held back until the operator has seen what the team runs (ADR 0048). */
interface HeldStart {
  review: TeamReview
  prompt: string
  parent: string | null | undefined
  expectedRevision: string | null
  lineage: Lineage | undefined
}

interface RunControllerInput {
  doc: TeamDocument
  session: RunSession
  history: RunHistory
  activeRunId: string | null
  record: RunSession['record']
  /** The operator question the run is blocked on, if any. */
  waiting: WaitingOn | null
  /** The prompt the evidence recorded, for runs whose record no longer carries one. */
  projectionPrompt: string | null
  /** Every route into a run passes through here so per-run view state resets together. */
  showRun: (runId: string | null) => void
  /** Where the next follow-up starts: `null` is the whole pipeline, a stage id is "from <stage>". */
  followUpTarget: string | null
  /** The planned deliverable from the layout sidecar, appended to the prompt a run starts with. */
  output: { name: string; format: string } | undefined
  /** Polite status line for the screen reader queue. */
  announce: (message: string) => void
}

/**
 * Everything that starts, answers or stops a run, and the composer text those actions consume.
 *
 * Starting a run: there is no "run without saving" (TNG89 §1.4). Every start goes through one
 * `launch`, which holds the §1.6 start key for the life of an attempt and, when the response is
 * lost, asks the daemon what that key did before reporting anything.
 */
export function useRunController({ doc, session, history, activeRunId, record, waiting, projectionPrompt, showRun, followUpTarget, output, announce }: RunControllerInput) {
  const [composerText, setComposerText] = useState('')
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const answerInFlight = useRef(false)
  const [answerSending, setAnswerSending] = useState(false)
  const [starting, setStarting] = useState(false)
  const [heldStart, setHeldStart] = useState<HeldStart | null>(null)
  // §1.6: the start key of the attempt in hand, surviving a failed POST so the re-press is the
  // same attempt. Cleared once the daemon answers with a run id.
  const startAttempt = useRef<{ identity: string; key: string } | null>(null)
  const [retryOf] = useState<Map<string, string>>(() => new Map())
  // `submit` reads the planned deliverable after its save resolves, so it goes through a ref that
  // is kept current after each commit rather than written during render.
  const outputPlanRef = useRef<{ name: string; format: string } | undefined>(undefined)
  useEffect(() => { outputPlanRef.current = output }, [output])

  const launch = useCallback(async (prompt: string, parent?: string | null, expectedRevision: string | null = null, lineage?: Lineage) => {
    if (!doc.path) return
    // §1.6: one start key per attempt, held for the life of the attempt. An attempt is this
    // prompt against this revision of this file, so a re-press after a lost response carries the
    // SAME key and the daemon answers with the run it already started (200) instead of starting a
    // second one. A connection loss during submit never retries blind.
    // The lineage is part of the attempt's identity: "shorter" as a whole-pipeline follow-up and
    // "shorter" as a follow-up from Writer are different requests, and one start key for both
    // would make the second a 409 conflict instead of a run.
    const identity = `${doc.path}\0${parent ?? ''}\0${expectedRevision ?? ''}\0${lineage?.followsRunId ?? ''}\0${lineage?.startAt ?? ''}\0${lineage?.fromCheckpointId ?? ''}\0${prompt}`
    const attempt = startAttempt.current?.identity === identity ? startAttempt.current : { identity, key: newStartKey() }
    startAttempt.current = attempt
    setStarting(true)
    setStartError(null)
    try {
      const created = await startRun(doc.path, prompt, { startKey: attempt.key, expectedRevision, retryOfRunId: parent, ...lineage })
      startAttempt.current = null
      if (parent) retryOf.set(created.runId, parent)
      session.applyRecord(created)
      showRun(created.runId)
      setComposerText('')
      window.dispatchEvent(new Event('loomwatch:close-library'))
      void history.refresh()
    } catch (caught) {
      // §1.6: a lost response is not a failed run, it is an unknown one — so ask the daemon what
      // this start key did before reporting anything. A `RunApiError` is an answer and needs no
      // recovery; anything else means none arrived, and a 404 here is the daemon saying the
      // request never landed. Guessing either way is the blind retry the clause forbids.
      const recovered = caught instanceof RunApiError ? null : await findRunByStartKey(attempt.key).catch(() => null)
      if (recovered) {
        startAttempt.current = null
        if (parent) retryOf.set(recovered.runId, parent)
        session.applyRecord(recovered)
        showRun(recovered.runId)
        setComposerText('')
        window.dispatchEvent(new Event('loomwatch:close-library'))
        void history.refresh()
        return
      }
      // ADR 0048: a team from outside LoomWatch starts nothing until the operator has seen what it
      // runs. The attempt (and its start key) is held for "Trust and run"; the prompt stays put.
      if (caught instanceof RunApiError && caught.code === TEAM_NEEDS_REVIEW && caught.review) {
        setHeldStart({ review: caught.review, prompt, parent, expectedRevision, lineage })
        return
      }
      // §1.5: the file moved between the save and the start, so no run was created. Hand it to
      // the §9.3 conflict bar rather than reporting it as a failed start; the prompt stays put.
      if (caught instanceof RunApiError && caught.code === STALE_TEAM_REVISION) void doc.checkDiskRevision()
      setStartError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setStarting(false)
    }
  }, [doc, history, retryOf, session, showRun])

  /** "Trust and run": approve the revision the operator was shown, then make the held start. */
  const trustAndRun = useCallback(async () => {
    if (!heldStart) return
    try {
      await approveTeam(heldStart.review.teamPath, heldStart.review.teamRevision)
    } catch (caught) {
      if (caught instanceof RunApiError && caught.code === STALE_TEAM_REVISION) {
        throw new Error('The team changed after this opened. Close this and press Run again to see what it runs now.')
      }
      throw caught
    }
    setHeldStart(null)
    await launch(heldStart.prompt, heldStart.parent, heldStart.expectedRevision, heldStart.lineage)
  }, [heldStart, launch])

  const dismissReview = useCallback(() => setHeldStart(null), [])

  const submit = useCallback(async (promptOverride?: string) => {
    const prompt = (promptOverride ?? composerText).trim()
    if (!prompt || !doc.path) return
    // §1.6: re-pressing while a start is in flight is a no-op, not a second run.
    if (starting || pendingPrompt !== null) return
    const parent = activeRunId && isTerminalRun(record?.status) ? activeRunId : null
    // §1.4: there is no "run without saving" — the run executes an exact snapshot of the file.
    if (['dirty', 'new'].includes(doc.documentChipState)) {
      setPendingPrompt(prompt)
      const saved = await doc.save()
      setPendingPrompt(null)
      if (!saved) { setStartError('The team file could not be saved, so no run was started.'); return }
    }
    // §1.4: the run is pinned to `expectedRevision` — the revision the PUT just returned, read
    // after the await so it is the one this save landed and not the one loaded before it.
    const outputPlan = outputPlanRef.current
    const request = outputPlan ? `${prompt}\n\nRequested deliverable: ${outputPlan.name}\nFormat: ${outputPlan.format}` : prompt
    await launch(request, parent, doc.currentRevision())
  }, [composerText, doc, launch, activeRunId, record?.status, starting, pendingPrompt])

  const stop = useCallback(async () => {
    if (!activeRunId) return
    try { session.applyRecord(await cancelRun(activeRunId)) } catch (caught) { setStartError(caught instanceof Error ? caught.message : String(caught)) }
  }, [activeRunId, session])

  const sendAnswer = useCallback(async (sendBack?: string) => {
    // Approving a review stop needs no comment; the daemon still requires words, so the approval
    // is said explicitly. Sending work back, or answering an agent's question, needs real text.
    const text = composerText.trim() || (waiting?.kind === 'review_stop' && !sendBack ? 'Approved. Continue as planned.' : '')
    if (!activeRunId || !waiting || !text || answerInFlight.current) return
    answerInFlight.current = true
    setAnswerSending(true)
    setStartError(null)
    try {
      const next = await answerRun(activeRunId, waiting.node, text, sendBack)
      session.applyRecord(next)
      if (next.runId !== activeRunId) showRun(next.runId)
      setComposerText('')
      void history.refresh()
    } catch (error) { setStartError(error instanceof Error ? error.message : String(error)) }
    finally { answerInFlight.current = false; setAnswerSending(false) }
  }, [activeRunId, waiting, composerText, session, history, showRun])

  const replyToAgent = useCallback(async (agentId: string) => {
    if (!activeRunId || !composerText.trim() || answerInFlight.current) return
    answerInFlight.current = true
    setAnswerSending(true)
    setStartError(null)
    try {
      await askRunAgent(activeRunId, agentId, composerText.trim())
      setComposerText('')
      announce('Reply received. Open the agent’s events to read the conversation.')
    } catch (error) { setStartError(error instanceof Error ? error.message : String(error)) }
    finally { answerInFlight.current = false; setAnswerSending(false) }
  }, [activeRunId, composerText, announce])

  const retry = useCallback(() => {
    const prompt = record?.prompt ?? projectionPrompt ?? ''
    if (prompt) void submit(prompt)
  }, [projectionPrompt, record?.prompt, submit])

  /**
   * Follow up: a new run that is a child of the one on screen (decision 8).
   *
   * `followUpTarget` is `null` for the whole pipeline and a stage id for "from <stage>", where the
   * earlier stages are **not** re-executed — their stored handovers are replayed. Unlike Retry,
   * this does not save the document first: the followed run's stages are replayed from the archive,
   * so pinning the new run to whatever is on disk now is the same trade every run already makes.
   */
  const followUp = useCallback(async () => {
    const prompt = composerText.trim()
    if (!prompt || !activeRunId || !doc.path || starting) return
    if (['dirty', 'new'].includes(doc.documentChipState)) {
      setPendingPrompt(prompt)
      const saved = await doc.save()
      setPendingPrompt(null)
      if (!saved) { setStartError('The team file could not be saved, so no follow-up was started.'); return }
    }
    await launch(prompt, null, doc.currentRevision(), {
      followsRunId: activeRunId,
      startAt: doc.mode === 'pipeline' ? followUpTarget : null,
    })
  }, [activeRunId, composerText, doc, followUpTarget, launch, starting])

  /**
   * "Start a new run from this checkpoint" — never "Resume".
   *
   * The label is the design's, verbatim and deliberately: nothing here reattaches to the stopped
   * run, nothing reconciles the side effects it had already caused, and a word that implied either
   * would be a promise the tree cannot keep. The prompt is the stopped run's own, so the operator
   * can press it without retyping the goal.
   */
  const startFromCheckpoint = useCallback(async (checkpointId: string) => {
    if (!doc.path || starting) return
    const prompt = (record?.prompt ?? projectionPrompt ?? '').trim() || composerText.trim()
    if (!prompt) { setStartError('This run has no prompt to continue from. Type one first.'); return }
    await launch(prompt, null, doc.currentRevision(), { fromCheckpointId: checkpointId })
  }, [composerText, doc, launch, projectionPrompt, record?.prompt, starting])

  // §3.4: `[ Reuse ]` on the failed response node copies the run's original prompt back
  // into the composer — the prompt survives on the Prompt node (§12.2), so this is a
  // missing route, not lost data.
  const reusePrompt = useCallback(() => {
    const prompt = record?.prompt ?? projectionPrompt ?? ''
    if (!prompt) return
    setComposerText(prompt)
    document.querySelector<HTMLTextAreaElement>('.lw-composer textarea')?.focus()
  }, [record?.prompt, projectionPrompt])

  return {
    composerText, setComposerText, pendingPrompt, starting, startError, setStartError, answerSending, retryOf,
    submit, stop, sendAnswer, replyToAgent, retry, followUp, startFromCheckpoint, reusePrompt,
    teamReview: heldStart?.review ?? null, trustAndRun, dismissReview,
  }
}

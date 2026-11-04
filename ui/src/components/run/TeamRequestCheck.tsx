import { useEffect, useState } from 'react'

import { approveTeam, RunApiError, STALE_TEAM_REVISION, TEAM_NEEDS_REVIEW, type TeamReview } from '../../lib/runs/client'
import { answerTeamRequest, fetchTeamRequests, takeTeamRequestToCheck, type TeamRequest } from '../../lib/runs/teamRequests'
import { TeamReviewDialog } from './TeamReviewDialog'

/** How far back a request is looked for: as long as the daemon keeps one. */
const KEPT_SECONDS = 60 * 60

/** What pressing Start on the request did. */
type Pressed =
  | { kind: 'started' }
  | { kind: 'check'; review: TeamReview }
  /** It couldn't start (`problem`, in the daemon's words), or it is answered or forgotten (`null`). */
  | { kind: 'ended'; problem: string | null }

interface Check {
  id: string
  review: TeamReview
  /** The request, when it could be read: who asked, and what. */
  request: TeamRequest | null
  again: boolean
  ended: string | null
}

/**
 * The check of a team that changed outside LoomWatch, before it runs what the agent pinned to the
 * notch asked of it (ADR 0048; ADR 0083, decision 10). Start at the notch found the team needed one
 * and opened its page with the request in the address (`teamRequestCheckHref`). Start is pressed
 * again here: it starts the request when the team was trusted since, and otherwise brings the check,
 * naming who asked and what. Its Trust and run approves the version shown and starts the agent's own
 * request, whose answer goes back to the agent as usual; a team changed again since brings the newer
 * version's check in its place. Cancel puts the check away; the request still waits at the notch.
 */
export function TeamRequestCheck() {
  const [check, setCheck] = useState<Check | null>(null)
  useEffect(() => {
    const id = takeTeamRequestToCheck()
    if (!id) return
    const asked = fetchTeamRequests(KEPT_SECONDS).then((all) => all.find((each) => each.id === id) ?? null, () => null)
    // A request that started, couldn't, or was answered since has nothing to check: the notch and
    // the agent's chat say how it went.
    Promise.all([press(id), asked]).then(([pressed, request]) => {
      if (pressed.kind === 'check') setCheck({ id, review: pressed.review, request, again: false, ended: null })
    }, () => {})
  }, [])
  if (!check) return null
  const who = check.request?.askedBy.name
  return (
    <TeamReviewDialog
      review={check.review}
      asked={who && check.request ? `${who} asked: “${check.request.request}”` : undefined}
      changedAgain={check.again}
      ended={check.ended}
      onTrust={async () => {
        try {
          await approveTeam(check.review.teamPath, check.review.teamRevision)
        } catch (error) {
          // It changed since it was shown: Start brings the newer version's check.
          if (!(error instanceof RunApiError && error.code === STALE_TEAM_REVISION)) throw error
        }
        const pressed = await press(check.id)
        if (pressed.kind === 'started') setCheck(null)
        else if (pressed.kind === 'check') setCheck({ ...check, review: pressed.review, again: true })
        else setCheck({ ...check, ended: endedWords(pressed.problem, check) })
      }}
      onClose={() => setCheck(null)}
    />
  )
}

/** Press Start on request `id`. */
async function press(id: string): Promise<Pressed> {
  try {
    const request = await answerTeamRequest(id, 'start')
    return request.status === 'failed' ? { kind: 'ended', problem: request.problem } : { kind: 'started' }
  } catch (error) {
    if (error instanceof RunApiError && error.code === TEAM_NEEDS_REVIEW && error.review) return { kind: 'check', review: error.review }
    // Answered (409) or forgotten (404) since the check opened.
    if (error instanceof RunApiError && (error.status === 404 || error.status === 409)) return { kind: 'ended', problem: null }
    throw error
  }
}

/** Why there is nothing left to trust, said on the team's own page: the daemon's reason, whose way
    to the team (`start` in team_requests.rs) is here closing the check. */
function endedWords(problem: string | null, check: Check): string {
  if (problem === null) return `${check.request?.askedBy.name ? `${check.request.askedBy.name}’s` : 'This'} request isn’t waiting any more.`
  return problem.replace(`Open ${check.review.teamName} to see what to fix.`, 'Close this to see what to fix.')
}

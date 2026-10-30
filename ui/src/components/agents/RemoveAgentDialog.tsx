import { useEffect, useId, useState } from 'react'

import { listNames } from '../../lib/format'
import { useSavedJobs } from '../../lib/library/jobs'
import { removeFromMyAgents } from '../../lib/library/removeAgent'
import type { AgentUse, TeamCard } from '../../lib/library/uses'
import { fetchRuns, isTerminalRun } from '../../lib/runs/client'

export interface RemoveAgentDialogProps {
  agent: { id: string; name: string }
  /** Where it is used: it comes off each of these teams first (ADR 0100). `null` while they are
      still being read. */
  uses: readonly Pick<AgentUse, 'teamPath' | 'teamName' | 'agentId' | 'takeOff'>[] | null
  onRemoved: () => void
  onClose: () => void
}

/** How often an open dialog asks again whether a team it would delete has finished its run. */
const LIVE_RECHECK_MS = 4000

/**
 * The one confirmation for removing one of My agents, from its card and from its own page alike.
 * It says what happens to each team it is in before anything changes (ADR 0100), and asks the one
 * thing LoomWatch can't tell: who starts a team it started when several could.
 */
export function RemoveAgentDialog({ agent, uses, onRemoved, onClose }: RemoveAgentDialogProps) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starts, setStarts] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<string[]>([])
  const { jobs } = useSavedJobs()
  // One of My agents is called what My agents call it, as everywhere else.
  const nameOf = (card: TeamCard) => (card.agent && jobs.find((job) => job.id === card.agent)?.name) || card.name
  const all = uses ?? []
  const teams = [...new Set(all.map((use) => use.teamName))]
  // What it does to a team it starts, said once for every team it does it to.
  const starters = new Map<string, { starter: string; withoutCheck: boolean; teams: string[] }>()
  for (const use of all) {
    const instead = use.takeOff?.startsInstead
    if (!instead) continue
    const starter = nameOf(instead)
    const key = `${starter}\n${use.takeOff?.withoutCheck ? 1 : 0}`
    starters.set(key, { starter, withoutCheck: Boolean(use.takeOff?.withoutCheck), teams: [...(starters.get(key)?.teams ?? []), use.teamName] })
  }
  const emptied = all.filter((use) => use.takeOff?.empty)
  const choose = all.filter((use) => use.takeOff?.chooseStart?.length)
  const unchosen = choose.filter((use) => !starts[use.teamPath])

  // A team it would delete can't go while it is working, as Delete team can't (ADR 0028): asked
  // before, so the person is told before choosing, and again until it finishes.
  const emptiedPaths = emptied.map((use) => use.teamPath).join('\n')
  useEffect(() => {
    if (!emptiedPaths) return
    const paths = emptiedPaths.split('\n')
    const controller = new AbortController()
    const check = () => void fetchRuns(controller.signal).then(
      (runs) => { if (!controller.signal.aborted) setRunning(paths.filter((path) => runs.some((run) => run.teamPath === path && !isTerminalRun(run.status)))) },
      () => { /* No run control: nothing can be running. */ },
    )
    check()
    const timer = window.setInterval(check, LIVE_RECHECK_MS)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [emptiedPaths])
  const working = emptied.filter((use) => running.includes(use.teamPath)).map((use) => use.teamName)
  const blocked = busy || !uses || unchosen.length > 0 || working.length > 0

  async function confirm() {
    if (blocked || !uses) return
    setBusy(true)
    setError(null)
    try {
      await removeFromMyAgents(agent.id, uses, starts)
      onRemoved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  // "Blog starts with", "Both start with", "Each starts with", "Blog and Notes start with".
  const startsWith = (where: readonly string[]) => (where.length === teams.length && teams.length > 1
    ? (teams.length === 2 ? 'Both start with' : 'Each starts with')
    : `${listNames(where)} ${where.length === 1 ? 'starts' : 'start'} with`)
  return (
    <div className="lw-scrim dim" onMouseDown={() => { if (!busy) onClose() }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 lw-deleteteam" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() } }}>
        <h2 id={titleId}>Remove “{agent.name}” from My agents?</h2>
        {!uses && <p role="status">Checking its teams…</p>}
        {/* "the team": a team's name is often everyday words ("Blog posts"), which alone reads as your posts. */}
        {teams.length > 0 && <p>It leaves the {teams.length === 1 ? 'team' : 'teams'} {listNames(teams)} too.</p>}
        {[...starters.values()].map(({ starter, withoutCheck, teams: where }) => <p key={`${starter}:${where.join()}`}>{startsWith(where)} {starter} now{withoutCheck ? `, and your review of ${agent.name}’s work goes too` : ''}.</p>)}
        {emptied.length > 0 && <p>{listNames(emptied.map((use) => use.teamName))} {emptied.length === 1 ? 'has no other agent, so that team is deleted too.' : 'have no other agent, so those teams are deleted too.'}</p>}
        {choose.map((use) => (
          <div key={use.teamPath} className="ra-choose" role="group" aria-label={`Who starts ${use.teamName} instead?`}>
            <p>{use.teamName} starts with {agent.name}. Who starts it instead?</p>
            <span className="ra-choices">
              {use.takeOff?.chooseStart?.map((card) => (
                <button key={card.id} type="button" className="btn" aria-pressed={starts[use.teamPath] === card.id} onClick={() => setStarts((now) => ({ ...now, [use.teamPath]: card.id }))} disabled={busy}>{nameOf(card)}</button>
              ))}
            </span>
          </div>
        ))}
        {working.length > 0 && <p role="alert" className="dt-alert">{listNames(working)} {working.length === 1 ? 'is' : 'are'} working right now. Wait for {working.length === 1 ? 'it' : 'them'} to finish, then remove {agent.name}.</p>}
        {/* A copy, not "nothing is erased": the teams it leaves are saved closed up around it. */}
        <p title={emptied.length > 0 ? '.jobs/.removed and .trash, inside your teams folder' : '.jobs/.removed, inside your teams folder'}>LoomWatch keeps a copy of {emptied.length > 0 ? 'it, and of the teams it deletes,' : 'it'} in your teams folder.</p>
        {error && <p role="alert" className="dt-alert">{error}</p>}
        <div className="dt-acts">
          <button type="button" className="btn" autoFocus onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-danger-fill" onClick={() => void confirm()} disabled={blocked}>{busy ? 'Removing…' : 'Remove'}</button>
        </div>
      </div>
    </div>
  )
}

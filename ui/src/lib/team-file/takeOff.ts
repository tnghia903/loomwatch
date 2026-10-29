import type { TeamFileModel } from './document'

/** What taking agent cards off a team did to it, for the person to be told before it is done. */
export interface TakeOff {
  /** Who starts the work now, by id, when it started the team. */
  startsInstead?: string
  /** Review stops at the front that went with it: they checked work no one does now. */
  stopsGone: string[]
  /** No agent is left: the team goes, as Delete team does. Nothing should be saved. */
  empty?: boolean
  /** The agents who could start the work now, by id, when LoomWatch can't tell which: the person
      picks one (`start`). Nothing should be saved until then. */
  chooseStart?: string[]
}

/**
 * Take agent cards off a team so it still runs (ADR 0100), as Remove in My agents does. Each card
 * comes off as deleting it in Workflow takes it off (`removeAgentCards`), and then its place in the
 * line closes up: whoever handed it work hands it on to whoever it handed work to. When it started
 * the team, a review stop left at the front, with no work before it to check, goes too, and the one
 * agent left at the front starts now. When several are left there, `start` names the one the person
 * picked, which then hands the work on to the others; with none picked the result lists them.
 */
export function takeAgentOff(team: TeamFileModel, ids: readonly string[], start?: string): TakeOff {
  const result: TakeOff = { stopsGone: [] }
  const responder = team.snapshot().responder
  // Who was on the line: one left with nothing handed to it is at the front now.
  const onLine = new Set((team.snapshot().edges ?? []).flatMap((edge) => [edge.from, edge.to]))
  let startGone = false
  for (const id of ids) {
    const before = team.snapshot()
    if (!(before.agents ?? []).some((agent) => agent.id === id)) continue
    const edges = before.edges ?? []
    const into = edges.filter((edge) => edge.to === id)
    const out = edges.filter((edge) => edge.from === id)
    if (before.entrypoint === id) startGone = true
    team.removeAgentCards([id])
    for (const from of into) {
      for (const to of out) {
        if (from.from === to.to || (team.snapshot().edges ?? []).some((edge) => edge.from === from.from && edge.to === to.to)) continue
        team.addEdge({ ...to, from: from.from })
      }
    }
  }
  if (startGone) {
    // A review stop that nothing hands work to any more checks nothing: it goes, and what it handed
    // on to is at the front now.
    for (let stop = frontStop(team, onLine); stop; stop = frontStop(team, onLine)) {
      team.removeAgentCards([stop])
      result.stopsGone.push(stop)
    }
    const after = team.snapshot()
    const working = (after.agents ?? []).filter((agent) => agent.kind !== 'operator')
    if (working.length === 0) return { ...result, empty: true }
    const line = after.edges ?? []
    // Only an agent that was on the line with nothing handed to it now can start; with no line, any.
    const front = onLine.size > 0 ? working.filter((agent) => onLine.has(agent.id) && !line.some((edge) => edge.to === agent.id)) : working
    const candidates = front.length > 0 ? front : working
    const chosen = candidates.length === 1 ? candidates[0].id : candidates.find((agent) => agent.id === start)?.id
    if (!chosen) return { ...result, chooseStart: candidates.map((agent) => agent.id) }
    team.setEntrypoint(chosen)
    // The others at the front now get their work from the one who starts, so all of them still run.
    if (onLine.size > 0) {
      for (const other of front) {
        if (other.id === chosen) continue
        const like = line.find((edge) => edge.from === other.id) ?? line.at(0)
        team.addEdge({ layer: like?.layer ?? 'configured', kind: like?.kind ?? 'sequence', ts: like?.ts ?? new Date().toISOString(), from: chosen, to: other.id })
      }
    }
    result.startsInstead = chosen
  }
  // Who replies: the starting agent in a team with no line left, as the team needs; otherwise the
  // one it was, unless it went, when the end of the line replies.
  const after = team.snapshot()
  if (responder) {
    if ((after.edges ?? []).length === 0 && after.entrypoint) team.setResponder(after.entrypoint)
    else if (ids.includes(responder) || result.stopsGone.includes(responder)) team.clearResponder()
    else team.setResponder(responder)
  }
  return result
}

/** A review stop at the front of the line: on it before, with nothing handed to it now. */
function frontStop(team: TeamFileModel, onLine: ReadonlySet<string>): string | undefined {
  const { agents = [], edges = [] } = team.snapshot()
  return agents.find((agent) => agent.kind === 'operator' && onLine.has(agent.id) && !edges.some((edge) => edge.to === agent.id))?.id
}

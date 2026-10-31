import { deleteTeamFile, fetchTeamFile, saveTeamFile } from '../team-file/client'
import { TeamFileModel } from '../team-file/document'
import { takeAgentOff } from '../team-file/takeOff'
import { hashTeamYaml } from '../team-file/useTeamDocument'
import { removeJob } from './jobs'
import type { AgentUse } from './uses'

/**
 * Remove one of My agents in one step (ADR 0100): it comes off every team it is in, each team
 * closing up around it (`takeAgentOff`), a team left with no agent going as Delete team takes it,
 * and then it leaves My agents. Who starts a team it started, when LoomWatch can't tell, is the
 * person's pick in `starts`, by team. Every team is read and changed in memory first: when one of
 * them still can't tell who starts, nothing changes. A team that then can't be saved stops it there,
 * the teams before it already changed: the daemon still refuses to remove an agent a team uses.
 */
export async function removeFromMyAgents(id: string, uses: readonly Pick<AgentUse, 'teamPath' | 'teamName' | 'agentId' | 'places'>[], starts: Readonly<Record<string, string>> = {}): Promise<void> {
  const cards = new Map<string, { name: string; ids: string[]; places: readonly string[] }>()
  for (const use of uses) cards.set(use.teamPath, { name: use.teamName, ids: [...(cards.get(use.teamPath)?.ids ?? []), use.agentId], places: use.places ?? [] })
  const changes: { path: string; yaml: string | null; revision: string; places: readonly string[] }[] = []
  for (const [path, { name, ids, places }] of cards) {
    const file = await fetchTeamFile(path)
    const team = TeamFileModel.parse(file.yaml)
    const there = new Set((team.snapshot().agents ?? []).map((agent) => agent.id))
    const off = ids.filter((agentId) => there.has(agentId))
    if (off.length === 0) continue
    const outcome = takeAgentOff(team, off, starts[path])
    if (outcome.chooseStart) throw new Error(`${name} starts with this agent: choose who starts it instead.`)
    changes.push({ path, yaml: outcome.empty ? null : team.toYaml(), revision: file.revision ?? await hashTeamYaml(file.yaml), places })
  }
  for (const change of changes) {
    // A team in several projects (ADR 0103): one save writes the others' setup too; a team left
    // with no agent goes from every project.
    if (change.yaml === null) for (const path of [change.path, ...change.places]) await deleteTeamFile(path)
    else await saveTeamFile(change.path, change.yaml, change.revision)
  }
  await removeJob(id)
}

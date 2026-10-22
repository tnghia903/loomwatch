// The agent pinned to the notch (ADR 0083, decision 9): one of My agents, messaged from the island.
// A message goes into that agent's own chat, the one its Chat tab shows, so what it answers is
// there too; its work and its answer come back to the island as any team's do, under its name.
import { sendChatMessage, uploadChatFile, type SendResult } from '../lib/chat/client'
import { destination } from '../lib/chat/route'
import { joinUnderRoot } from '../lib/files/paths'
import { chatAgentId, chatTeamYaml, draftFromJob } from '../lib/library/draft'
import { benchFolder, type SavedJob } from '../lib/library/jobs'
import { newStartKey, type RunRecord } from '../lib/runs/client'
import type { TeamRequest } from '../lib/runs/teamRequests'
import { fetchTeamFile, saveTeamFile } from '../lib/team-file/client'
import { messageFor, type Intake } from './intake'
import { teamHref } from '../lib/team-file/teamHref'
import { URGENCY, type TeamNow } from './teams'

/** Where My agents' chats are kept (`jobs::BENCH_DIR`), as the run records name their team files. */
const CHATS = '.jobs/.bench'

/** The pinned agent, as the island knows it. */
export interface PinnedNow {
  /** Its id in My agents, which names its chat too. */
  id: string
  name: string
  /** Its chat's team file, as the run records name it. */
  chatPath: string
  /** Its id in that chat. */
  agent: string
  /** Its chat in LoomWatch. */
  link: string
  job: SavedJob
}

/** The pinned agent `id`, while it is one of My agents. */
export function pinnedNow(id: string | null, jobs: readonly SavedJob[]): PinnedNow | null {
  const job = id ? jobs.find((each) => each.id === id) : undefined
  if (!job) return null
  return {
    id: job.id,
    name: job.name.trim() || job.id,
    chatPath: `${CHATS}/${job.id}.yaml`,
    agent: chatAgentId(job.id),
    link: `/agents/${encodeURIComponent(job.id)}?view=chat`,
    job,
  }
}

/**
 * The pinned agent's work among the teams, named as the agent and opening its chat: "Maya is
 * working", "Maya answered"; with its requests for your teams (`requests`) as questions to answer
 * with Start or Not now, and the teams it started as its crew. Everything else is left as it is.
 *
 * - A turn of the agent's that asked a team says only that it asked: its words are not the answer,
 *   which comes from the turn the team's answer starts. Once it has asked, that turn leaves.
 * - Its crew's answer goes to the agent, not to you: a crew that finished leaves too. One that
 *   stopped stays, as a stop.
 * - A team you pressed Start on that could not start says why, as a stop, while that is news: it
 *   ended after the island started watching (`since`) and you have not looked yet (`seen`).
 */
export function withPinned(teams: TeamNow[], pinned: PinnedNow | null, requests: readonly TeamRequest[] = [], since = 0, seen: ReadonlySet<string> = new Set()): TeamNow[] {
  if (!pinned) return teams
  const mine = requests.filter((request) => request.askedBy.chatPath === pinned.chatPath)
  const asked = new Set(mine.map((request) => request.askedBy.runId))
  const crew = new Set(mine.flatMap((request) => (request.runId ? [request.runId] : [])))
  const waiting = mine.filter((request) => request.status === 'waiting')
  const out: TeamNow[] = []
  for (const team of teams) {
    if (team.teamPath === pinned.chatPath) {
      if (asked.has(team.runId) && (team.moment === 'done' || team.moment === 'fail')) continue
      out.push({ ...team, teamName: pinned.name, agentName: pinned.name, link: pinned.link, pinned: true })
    } else if (crew.has(team.runId)) {
      if (team.moment !== 'done') out.push({ ...team, crewFor: pinned.name })
    } else {
      out.push(team)
    }
  }
  for (const request of mine) {
    const id = `team-request:${request.id}`
    const ended = Date.parse(request.finishedAt ?? '')
    if (request.status !== 'failed' || request.runId || !(ended >= since) || seen.has(id)) continue
    out.push({
      runId: id,
      teamPath: request.team.path,
      teamName: request.team.name,
      moment: 'fail',
      agent: null,
      agentName: null,
      agents: [],
      startedAt: request.createdAt,
      asks: [],
      quick: [],
      result: request.problem ?? 'It couldn’t start.',
      link: teamHref(request.team.path),
      chat: false,
      crewFor: pinned.name,
      didNotStart: true,
    })
  }
  if (waiting.length) {
    const at = out.findIndex((team) => team.pinned)
    if (at >= 0) out[at] = { ...out[at], moment: 'ask', teamAsks: waiting }
    else {
      out.push({
        runId: `pinned:${pinned.id}`,
        teamPath: pinned.chatPath,
        teamName: pinned.name,
        moment: 'ask',
        agent: pinned.agent,
        agentName: pinned.name,
        agents: [pinned.agent],
        startedAt: waiting[0].createdAt,
        asks: [],
        quick: [],
        result: null,
        link: pinned.link,
        chat: false,
        pinned: true,
        teamAsks: waiting,
      })
    }
  }
  const started = (team: TeamNow) => Date.parse(team.startedAt ?? '') || 0
  return out.sort((a, b) => URGENCY[a.moment] - URGENCY[b.moment] || started(a) - started(b))
}

const LIVE = new Set(['queued', 'starting', 'running'])

/** Whether the pinned agent is at work in its chat now: a message then joins its turn as a note. */
export function pinnedWorking(records: readonly RunRecord[], pinned: PinnedNow): boolean {
  return destination({ kind: 'agent', agent: pinned.agent }, live(records, pinned), new Map(), 1).route === 'note'
}

function live(records: readonly RunRecord[], pinned: PinnedNow): RunRecord[] {
  return records.filter((record) => record.teamPath === pinned.chatPath && LIVE.has(record.status))
}

/**
 * Send `text` to the pinned agent, as its Chat tab would, with anything dropped into the slot
 * (`intake`): its files go as the chat's own attachments, a link or some text goes in the words.
 * When the agent is free, its chat is first written as it is saved in My agents, so it answers as
 * that version; while it works, the message is a note for its next turn.
 */
export async function sendToPinned(pinned: PinnedNow, said: string, records: readonly RunRecord[], intake: Intake | null = null): Promise<SendResult> {
  const text = intake ? messageFor(intake, said) : said
  const to = { kind: 'agent' as const, agent: pinned.agent }
  const where = destination(to, live(records, pinned), new Map([[pinned.agent, pinned.name]]), 1)
  const teamPath = joinUnderRoot(await benchFolder(), `${pinned.id}.yaml`)
  let revision: string | null = null
  if (where.route === 'agent') {
    let current: string | null = null
    try { current = (await fetchTeamFile(teamPath)).revision ?? null } catch { current = null }
    const draft = draftFromJob(pinned.job)
    revision = (await saveTeamFile(teamPath, chatTeamYaml(draft, draft.model, pinned.id), current)).revision ?? null
  }
  const files = intake?.files.length ? await Promise.all(intake.files.map((file) => uploadChatFile(teamPath, file, file.name))) : []
  return sendChatMessage({ teamPath, text, to, expectedRevision: revision, startKey: where.route === 'agent' ? newStartKey() : undefined, files })
}

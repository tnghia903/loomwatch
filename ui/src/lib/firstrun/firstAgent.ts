import { sendChatMessage } from '../chat/client'
import { joinUnderRoot } from '../files/paths'
import { BLANK_DRAFT, blankDraft, chatAgentId, chatTeamYaml, specFromDraft, type AgentDraft } from '../library/draft'
import type { FigureChoice } from '../library/figures'
import { benchFolder, jobIdFor, saveJob } from '../library/jobs'
import { newStartKey, type RunRecord } from '../runs/client'
import { fetchTeamFile, saveTeamFile } from '../team-file/client'

/**
 * The first agent a newcomer works with (ADR 0075): a general helper on the new-agent model, with
 * the instructions any new agent starts with. It works in its own chat, as an agent in My agents
 * does (`.jobs/.bench/`), and becomes one of My agents only if the person keeps it: saving it under
 * the chat's name keeps talking in the same chat.
 *
 * It wears the butter spool, the crew member the landing page's lamp hangs from, and keeps it when
 * kept: the figure that greets a newcomer is the one they find in My agents, its chat and teams.
 */
export const FIRST_FIGURE: FigureChoice = { kind: 'spool', color: 'butter' }
export const FIRST_AGENT: AgentDraft = { ...BLANK_DRAFT, name: 'Helper', does: 'Helps with whatever you ask', figure: FIRST_FIGURE }
export const FIRST_CHAT = jobIdFor(FIRST_AGENT.name)

/** The first agent as it works now: on the model a new agent gets with what is connected (ADR 0073). */
export function firstAgentNow(): AgentDraft {
  const { model, effort } = blankDraft()
  return { ...FIRST_AGENT, model, effort }
}

/** Start one piece of work for the first agent, and the run it started. */
export async function askFirstAgent(text: string): Promise<RunRecord> {
  const path = joinUnderRoot(await benchFolder(), `${FIRST_CHAT}.yaml`)
  let revision: string | null = null
  try { revision = (await fetchTeamFile(path)).revision ?? null } catch { revision = null }
  const agent = firstAgentNow()
  const saved = await saveTeamFile(path, chatTeamYaml(agent, agent.model, FIRST_CHAT), revision)
  const sent = await sendChatMessage({
    teamPath: path,
    text,
    to: { kind: 'agent', agent: chatAgentId(FIRST_CHAT) },
    expectedRevision: saved.revision ?? null,
    startKey: newStartKey(),
  })
  if (!sent.run) throw new Error('Your first agent didn’t start. Try again.')
  return sent.run
}

/**
 * The same request again, once the person has told their agents about themselves. Every piece of
 * work opens a new session, which reads the About you just saved. The agent also sees its first
 * answer, so the request says why it is asked again: without that, it could hand back the same.
 */
export const forMeRequest = (request: string): string => `Answer this again for me, using what I just told you about myself: ${request}`

/** Keep the first agent in My agents, under its chat's name. Returns its id. */
export async function keepFirstAgent(): Promise<string> {
  try {
    await saveJob(FIRST_CHAT, specFromDraft(firstAgentNow()))
  } catch (failed) {
    // Kept already (a second tab, or a click that didn't hear back): it is there to open.
    if (!(failed instanceof Error && /already have an agent/i.test(failed.message))) throw failed
  }
  return FIRST_CHAT
}

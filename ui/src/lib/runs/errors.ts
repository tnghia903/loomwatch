import { stateAfterName } from '../state/words'

/** What a run error needs to know about an agent to name it the way the operator does. */
export interface ErrorAgent {
  name: string
}

// Runs recorded while LoomWatch drove AI apps: an agent's app failed to start, or ended a turn as
// usual but said it failed (Codex refusing a model the account can't use). The app's words are
// the cause, whatever context wraps them; a pipeline stage's context names who didn't finish.
const SPAWN_FAILURE = /failed to spawn ACP harness for (?:agent|pipeline node) ([^:\s]+): ([\s\S]*)$/
const APP_ERROR = /Codex reported an error instead of an answer: (.*)/
const STAGE_FAILURE = /^pipeline node ([^:\s]+) failed/
// A stage's failure with its cause: "pipeline node writer failed: …", "… failed after your
// answer: …".
const STAGE_CAUSE = /^pipeline node ([^:\s]+) failed[^:]*: ([\s\S]*)$/

/**
 * The agent a failed run stopped at: the one its error names, or the only one it ran. `null` when
 * the run didn't fail, or the schedule is trying it again, or its error names nobody, since a guess
 * would mark the wrong agent.
 */
export function failedAgent(run: { status: string; error: string | null; onlyAgent?: string | null; agentIds: readonly string[]; nextTryAt?: string | null }): string | null {
  if (run.status !== 'failed' || run.nextTryAt) return null
  const error = run.error?.trim() ?? ''
  const named = STAGE_FAILURE.exec(error)?.[1] ?? SPAWN_FAILURE.exec(error)?.[1]
  if (named) return named
  return run.onlyAgent ?? (run.agentIds.length === 1 ? run.agentIds[0] : null)
}

/** A failed run in the operator's words: who didn't finish, said once, then why. */
export interface RunStop {
  /** "Route finder didn’t finish.", or "… couldn’t start." for an AI app that never started; `null`
      when the error names nobody. */
  lead: string | null
  /** Why, in the run's own words: "Your OpenRouter account is out of credits…". */
  reason: string
}

/**
 * A daemon error in the operator's words, split into who didn't finish and why, so a card can say who in
 * bold and the reason once after it. The one word for a failure is "didn't finish"
 * (`lib/state/words.ts`); "stopped" is only work you stopped. Only failures with a known cause are
 * rewritten; anything else is the reason in the daemon's words, because a paraphrase that guesses
 * is worse than a technical sentence that is true. The daemon says the same of a team's stop it
 * hands back (`plain_stop` in `team_requests.rs`, with the same test cases).
 */
export function runStop(message: string, agents: ReadonlyMap<string, ErrorAgent> = new Map()): RunStop {
  const text = message.trim()
  // An agent the run doesn't name is said by its id, as the start of a sentence.
  const named = (id: string) => agents.get(id)?.name || sentence(id)
  const reported = APP_ERROR.exec(text)
  if (reported) {
    const id = STAGE_FAILURE.exec(text)?.[1]
    return { lead: id ? `${stateAfterName(named(id), 'failed')}.` : null, reason: `Codex reported an error instead of an answer: ${reported[1].trim()}` }
  }
  const spawn = SPAWN_FAILURE.exec(text)
  if (spawn) return { lead: `${named(spawn[1])} couldn’t start.`, reason: sentence(spawn[2]) }
  const stage = STAGE_CAUSE.exec(text)
  if (stage) return { lead: `${stateAfterName(named(stage[1]), 'failed')}.`, reason: sentence(stage[2]) }
  return { lead: null, reason: sentence(message) }
}

/** `runStop` as one line, for a place with room for one: "Route finder didn’t finish. Your
    OpenRouter account is out of credits…". */
export function plainRunError(message: string, agents: ReadonlyMap<string, ErrorAgent> = new Map()): string {
  const { lead, reason } = runStop(message, agents)
  return lead ? `${lead} ${reason}` : reason
}

/** A run record's names for its agents, as `runStop` and `plainRunError` read them. */
export function runAgents(names: Readonly<Record<string, string>> | null | undefined): ReadonlyMap<string, ErrorAgent> {
  return new Map(Object.entries(names ?? {}).map(([id, name]) => [id, { name }]))
}

/** A cause said after who didn't finish, as a sentence of its own. */
function sentence(cause: string): string {
  const trimmed = cause.trim()
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

/** The way out of a stop LoomWatch named (ADR 0073): where to fix it, in one button. */
export interface ProblemAction {
  label: string
  href: string
  /** Opens outside LoomWatch, in a new tab. */
  external: boolean
}

// The daemon's own words for each stop (`crates/loomwatch-backend/src/agent/error.rs` and
// `engine/mod.rs`), first match wins. Their tests pin the same sentences.
const ACTIONS: readonly [RegExp, ProblemAction][] = [
  [/usage limit on your ChatGPT plan/, { label: 'Manage usage', href: 'https://chatgpt.com/settings/usage', external: true }],
  [/Claude API credit is used up/, { label: 'See your Claude balance', href: 'https://platform.claude.com/settings/billing', external: true }],
  [/OpenRouter account is out of credits/, { label: 'Add OpenRouter credits', href: 'https://openrouter.ai/settings/credits', external: true }],
  [/Connections page/, { label: 'Open Connections', href: '/connections', external: false }],
]

/** The button that fixes a stop, when LoomWatch's words for it say where. */
export function problemAction(message: string | null | undefined): ProblemAction | null {
  if (!message) return null
  return ACTIONS.find(([pattern]) => pattern.test(message))?.[1] ?? null
}

/** Which stop in a chat message a way out is for (a note's failed answer, a team's failure), so
    the chat can fill only the newest one's. A piece of work's own stop is keyed by its run. */
export function fixKey(messageId: string, error: string): string {
  return `${messageId}\n${error}`
}

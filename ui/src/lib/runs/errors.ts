/** What a run error needs to know about an agent to name it the way the operator does. */
export interface ErrorAgent {
  name: string
}

// Runs recorded while LoomWatch drove AI apps: an agent's app failed to start, or ended a turn as
// usual but said it failed (Codex refusing a model the account can't use). The app's words are
// the cause, whatever context wraps them; a pipeline stage's context names who stopped.
const SPAWN_FAILURE = /failed to spawn ACP harness for (?:agent|pipeline node) ([^:\s]+): ([\s\S]*)$/
const APP_ERROR = /Codex reported an error instead of an answer: (.*)/
const STAGE_FAILURE = /^pipeline node ([^:\s]+) failed/
// A stage's failure with its cause: "pipeline node writer failed: …", "… failed after your
// answer: …". The daemon says the same of a team's stop it hands back (`who_stopped` in
// `team_requests.rs`, with the same test cases).
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

/**
 * A daemon error in the operator's words. Only failures with a known, fixable cause are rewritten;
 * anything else is returned as the daemon wrote it, because a paraphrase that guesses is worse
 * than a technical sentence that is true.
 */
export function plainRunError(message: string, agents: ReadonlyMap<string, ErrorAgent> = new Map()): string {
  const reported = APP_ERROR.exec(message.trim())
  if (reported) {
    const id = STAGE_FAILURE.exec(message.trim())?.[1]
    const who = id ? agents.get(id)?.name || id : null
    // "Didn't finish", the one word for a failure ("stopped" is only work you stopped).
    return `${who ? `${who} didn’t finish. ` : ''}Codex reported an error instead of an answer: ${reported[1].trim()}`
  }
  const spawn = SPAWN_FAILURE.exec(message.trim())
  if (spawn) {
    const [, id, cause] = spawn
    return `${agents.get(id)?.name || id} couldn’t start: ${cause.trim()}`
  }
  const stage = STAGE_CAUSE.exec(message.trim())
  if (!stage) return message
  const [, id, cause] = stage
  return `${agents.get(id)?.name || id} didn’t finish: ${cause.trim()}`
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

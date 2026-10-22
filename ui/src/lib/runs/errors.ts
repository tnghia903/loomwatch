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
    return `${who ? `${who} stopped. ` : ''}Codex reported an error instead of an answer: ${reported[1].trim()}`
  }
  const spawn = SPAWN_FAILURE.exec(message.trim())
  if (!spawn) return message
  const [, id, cause] = spawn
  return `${agents.get(id)?.name || id} couldn’t start: ${cause.trim()}`
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

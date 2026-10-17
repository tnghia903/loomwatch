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
 * the run didn't fail, or its error names nobody, since a guess would mark the wrong agent.
 */
export function failedAgent(run: { status: string; error: string | null; onlyAgent?: string | null; agentIds: readonly string[] }): string | null {
  if (run.status !== 'failed') return null
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

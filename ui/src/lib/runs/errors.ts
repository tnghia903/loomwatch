/** What a run error needs to know about an agent to name it the way the operator does. */
export interface ErrorAgent {
  name: string
  /** The command its app is started with (`spawn.cmd`), when the team file has one. */
  command?: string
}

// crates/loomwatch-backend/src/lib.rs wraps every harness spawn failure in this context.
const SPAWN_FAILURE = /failed to spawn ACP harness for (?:agent|pipeline node) ([^:\s]+): ([\s\S]*)$/

/**
 * A daemon error in the operator's words. Only failures with a known, fixable cause are rewritten;
 * anything else is returned as the daemon wrote it, because a paraphrase that guesses is worse
 * than a technical sentence that is true.
 */
export function plainRunError(message: string, agents: ReadonlyMap<string, ErrorAgent> = new Map()): string {
  const spawn = SPAWN_FAILURE.exec(message.trim())
  if (!spawn) return message
  const [, id, cause] = spawn
  const agent = agents.get(id)
  const who = agent?.name || id
  const app = agent?.command ? `“${agent.command}”` : 'its AI app'
  if (/no such file or directory|os error 2\b|not found/i.test(cause)) {
    return `${who} couldn’t start: ${app} isn’t installed on this computer, or LoomWatch can’t find it. Install it and restart LoomWatch from a terminal where it works, or choose another AI app for ${who} in Build.`
  }
  if (/permission denied|os error 13\b/i.test(cause)) {
    return `${who} couldn’t start: this computer doesn’t allow LoomWatch to run ${app}.`
  }
  return `${who} couldn’t start: ${cause.trim()}`
}

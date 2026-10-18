/**
 * The calls of connected tools an agent may make without asking (ADR 0069), by tool name: every
 * other call asks you first. In a team file each list is the tool entry's `alwaysAllow`; in Your
 * agents it is the job's `toolAllow`. Tool names compare ignoring case, as the daemon finds tools.
 */
export type ToolAllow = Readonly<Record<string, readonly string[]>>

/**
 * What a card's "Always allow" turns on: one of the agent's `allow:` switches (ADR 0037), or one
 * call of a connected tool (ADR 0069), with the words the card showed for it.
 */
export type AlwaysAllowed = 'web' | 'edits' | 'commands' | { tool: string; call: string; label: string }

/** The key `name` is kept under in `allow`, ignoring case. */
function keyOf(allow: ToolAllow, name: string): string | undefined {
  const wanted = name.trim().toLowerCase()
  return Object.keys(allow).find((key) => key.trim().toLowerCase() === wanted)
}

/** The calls of tool `name` always allowed. */
export function allowedFor(allow: ToolAllow, name: string): readonly string[] {
  const key = keyOf(allow, name)
  return key ? allow[key] ?? [] : []
}

/** The calls of tool `name` always allowed, as they are written down: trimmed, each once. */
export function callsFor(allow: ToolAllow, name: string): string[] {
  return [...new Set(allowedFor(allow, name).map((call) => call.trim()).filter(Boolean))]
}

/** `allow` with `call` of tool `name` always allowed too. */
export function withAllowed(allow: ToolAllow, name: string, call: string): ToolAllow {
  const key = keyOf(allow, name) ?? name.trim()
  const calls = allow[key] ?? []
  return calls.includes(call) ? allow : { ...allow, [key]: [...calls, call] }
}

/** `allow` with `call` of tool `name` asking again. */
export function withoutAllowed(allow: ToolAllow, name: string, call: string): ToolAllow {
  const key = keyOf(allow, name)
  if (!key) return allow
  const calls = (allow[key] ?? []).filter((kept) => kept !== call)
  const rest = Object.fromEntries(Object.entries(allow).filter(([other]) => other !== key))
  return calls.length ? { ...rest, [key]: calls } : rest
}

/** `allow` as it is saved: only for the tools in `tools`, under the name each is given by, each call once. */
export function keptFor(allow: ToolAllow, tools: readonly string[]): Record<string, string[]> {
  const kept: Record<string, string[]> = {}
  for (const tool of tools) {
    const calls = callsFor(allow, tool)
    if (calls.length) kept[tool] = calls
  }
  return kept
}

/** Whether `a` and `b` allow the same calls of `tools`. */
export function sameAllow(a: ToolAllow, b: ToolAllow, tools: readonly string[]): boolean {
  return tools.every((tool) => [...allowedFor(a, tool)].sort().join('\n') === [...allowedFor(b, tool)].sort().join('\n'))
}

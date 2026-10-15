// Build by hand (components/agents/ByHand.tsx): what the desk's objects read from a draft.

/** The line of the instructions that says what it replies with, if any. */
export function replyLine(role: string): string | null {
  const lines = role.split(/\n+|(?<=[.!?])\s+/).map((line) => line.trim()).filter(Boolean)
  const hit = lines.find((line) => /\b(reply|replies|respond|answer with|hand(s)? back|return|deliver)\b/i.test(line))
  if (!hit) return null
  return hit.length > 110 ? `${hit.slice(0, 107).trimEnd()}…` : hit
}

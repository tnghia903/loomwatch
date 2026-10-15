// Build by hand (components/agents/ByHand.tsx): what the desk's objects read from a draft.

import { checksBeforeReplying } from '../team-file/checkup'

/** The line of the instructions that says what it replies with, if any. A check it runs before replying is not that line. */
export function replyLine(role: string): string | null {
  const lines = role.split(/\n+|(?<=[.!?])\s+/).map((line) => line.trim()).filter(Boolean)
  const hit = lines.find((line) => !checksBeforeReplying(line) && /\b(reply|replies|respond|answer with|hand(s)? back|return|deliver)\b/i.test(line))
  if (!hit) return null
  return hit.length > 110 ? `${hit.slice(0, 107).trimEnd()}…` : hit
}

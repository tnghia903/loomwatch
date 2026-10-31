import type { AgentPart } from './types'

/** The schema's limit on `part.text`: a line or two, not a second set of instructions. */
export const PART_CHARS = 1000

/** `part` with blank text and an empty list left out, or nothing when that leaves nothing. */
export function tidyPart(part: AgentPart): AgentPart | undefined {
  const text = part.text?.trim()
  const doneWhen = (part.doneWhen ?? []).filter((item) => item.trim())
  const tidied: AgentPart = { ...(text ? { text } : {}), ...(doneWhen.length ? { doneWhen } : {}) }
  return Object.keys(tidied).length ? tidied : undefined
}

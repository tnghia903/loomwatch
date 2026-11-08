import { displayName } from './skillStore'

/** The longest name a new skill gets, in characters, as the Agent Skills format allows. */
export const SKILL_NAME_CHARS = 64
/** The longest a skill's folder name may be in bytes (the daemon's `usable_name`). */
const SKILL_NAME_BYTES = 128

const KEPT = /[\p{Alphabetic}\p{N}\p{M}]/u
const APOSTROPHE = /['’]/u
const bytes = new TextEncoder()

/**
 * The folder name a skill called `title` gets: its letters and numbers, lowercased, words joined
 * by hyphens, at most 64 characters. Any script's letters stay, so "Báo cáo tuần" is
 * `báo-cáo-tuần`. Empty when the title has no letters or numbers.
 *
 * The daemon names a skill the same way (`skills_store::written::skill_name`); both read the cases
 * in `schemas/skill-name.cases.json`.
 */
export function skillName(title: string): string {
  let name = ''
  let chars = 0
  let gap = false
  for (const char of title.normalize('NFC')) {
    // "Mai's report" is `mais-report`, not `mai-s-report`.
    if (APOSTROPHE.test(char)) continue
    if (!KEPT.test(char)) { gap = true; continue }
    const piece = (gap && name ? '-' : '') + char.toLowerCase()
    const more = Array.from(piece).length
    if (chars + more > SKILL_NAME_CHARS || bytes.encode(name + piece).length > SKILL_NAME_BYTES) break
    name += piece
    chars += more
    gap = false
  }
  return name
}

/**
 * A skill's name as it will show everywhere once saved, read back from its folder name: "Mai's
 * report" shows as "Mais report". The sheet and a suggestion's card show it so, so one skill never
 * goes by two names. A title with no letters or numbers stays as it is.
 */
export function shownName(title: string): string {
  const name = skillName(title)
  return name ? displayName(name) : title
}

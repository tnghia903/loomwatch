// What a skill Ask proposed says on its card (ADR 0121), in the words of the Skills page's sheet,
// where it is saved: "When to use it", "What to do", "Save skill". A new skill is said by when
// agents use it; a change by what differs from the skill as it is saved now.
import { listNames } from '../format'
import { shownName } from '../library/skillName'
import { displayName, type SkillWords } from '../library/skillStore'
import { lineChanges } from './agentProposal'

/** How much of "When to use it" a card shows; the sheet shows all of it. */
const SHOWN_CHARS = 160

type Proposed = { isNew: boolean; skill: string; title: string | null; description: string; instructions: string; base: string | null; givenTo: readonly string[] }

function cut(text: string): string {
  const chars = Array.from(text)
  return chars.length <= SHOWN_CHARS ? text : `${chars.slice(0, SHOWN_CHARS - 1).join('').trimEnd()}…`
}

/** The skill's name as it shows everywhere once saved, so it never goes by two names. */
export function skillProposalName(proposal: Pick<Proposed, 'isNew' | 'skill' | 'title'>): string {
  return proposal.isNew && proposal.title ? shownName(proposal.title) : displayName(proposal.skill)
}

/**
 * The lines for a skill Ask proposed: for a new one, when agents use it; for a change, what differs
 * from `saved` (its words now, or null while they aren't known), then who saving changes it for.
 */
export function skillProposalLines(proposal: Proposed, saved: Pick<SkillWords, 'description' | 'instructions'> | null): string[] {
  if (proposal.isNew) return [`When to use it: “${cut(proposal.description)}”`]
  const said: string[] = []
  if (saved) {
    if (proposal.description.trim() !== saved.description.trim()) said.push(`When to use it, changed to: “${cut(proposal.description)}”`)
    const changes = lineChanges(proposal.instructions, saved.instructions)
    if (changes) said.push(`What to do: ${changes}`)
  }
  said.push(proposal.givenTo.length
    ? `Saving changes it for every agent that uses it, including ${listNames([...proposal.givenTo])}`
    : 'Saving changes it for every agent that uses it')
  return said
}

/**
 * Whether the skill changed after Ask read it (ADR 0121): its change was made from other words, so
 * it can't be saved. A new skill, or one whose words aren't known yet, is never stale.
 */
export function changedSinceAsk(proposal: Pick<Proposed, 'isNew' | 'base'>, saved: Pick<SkillWords, 'base'> | null): boolean {
  return !proposal.isNew && saved !== null && proposal.base !== null && saved.base !== proposal.base
}

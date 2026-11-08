// What an agent Ask proposed on its own changes (ADR 0119), in the words its card and the agent's
// page use. A new agent is said by what it is set up with; a change by what differs from the agent
// as it is saved now. The words are the page's own: "Thinks with", "Edit files", "Done when".
import { effortWord } from '../ai/efforts'
import { modelNameFromId } from '../ai/modelIds'
import { listNames } from '../format'
import { versionOf, type JobSpec } from '../library/jobs'

const SWITCHES = [
  ['web', 'Searches the web without asking', 'Asks before it searches the web'],
  ['edits', 'Edits files without asking', 'Asks before it edits files'],
  ['commands', 'Runs commands without asking', 'Asks before it runs commands'],
] as const

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const quoted = (items: readonly string[]) => items.map((item) => `“${item}”`).join(', ')

/** What is in `after` and not in `before`, each once for each time more it is there. */
function more(after: readonly string[], before: readonly string[]): string[] {
  const left = [...before]
  return after.filter((item) => {
    const at = left.indexOf(item)
    if (at === -1) return true
    left.splice(at, 1)
    return false
  })
}

const readNames = (spec: JobSpec) => (spec.reads ?? []).map((read) => read.name)
const lines = (text: string) => text.split('\n').filter((line) => line.trim())

/** A new agent's lines: the settings it starts with, past its name and instructions. */
function newLines(spec: JobSpec): string[] {
  const said: string[] = []
  if (spec.model) said.push(`Thinks with ${modelNameFromId(spec.model)}`)
  if (spec.skills?.length) said.push(`${spec.skills.length === 1 ? 'Skill' : 'Skills'}: ${listNames(spec.skills)}`)
  if (spec.reads?.length) said.push(`Reads ${listNames(readNames(spec))}`)
  if (spec.tools?.length) said.push(`Uses ${listNames(spec.tools)}, asking before each action`)
  for (const [key, on] of SWITCHES) if (spec.allow?.[key]) said.push(on)
  if (spec.doneWhen?.length) said.push(`Done when: ${quoted(spec.doneWhen)}`)
  return said
}

/**
 * How a text changed, by line: a line taken out and one put in count as one changed, and blank
 * lines don't count, so a line that was only extended reads as "1 line changed". Null when no line
 * changed. A skill's card says it the same way (`skillProposal.ts`).
 */
export function lineChanges(now: string, was: string): string | null {
  const added = more(lines(now), lines(was)).length
  const taken = more(lines(was), lines(now)).length
  const changed = Math.min(added, taken)
  const parts = [
    changed && `${plural(changed, 'line')} changed`,
    added - changed && `${plural(added - changed, 'line')} put in`,
    taken - changed && `${plural(taken - changed, 'line')} taken out`,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

function instructionsLine(now: string, was: string): string | null {
  const changes = lineChanges(now, was)
  return changes ? `Instructions: ${changes}` : null
}

/** A change's lines: each setting that differs from `saved`, most noticed first. */
function changeLines(spec: JobSpec, saved: JobSpec): string[] {
  const said: string[] = []
  if (spec.name !== saved.name) said.push(`New name: ${spec.name} (was ${saved.name})`)
  const instructions = instructionsLine(spec.instructions, saved.instructions)
  if (instructions) said.push(instructions)
  if ((spec.model ?? '') !== (saved.model ?? '')) said.push(spec.model ? `Thinks with ${modelNameFromId(spec.model)}` : 'Thinks with the default model')
  if ((spec.thinkingEffort ?? '') !== (saved.thinkingEffort ?? '')) said.push(`Thinking effort: ${effortWord(spec.thinkingEffort)}`)
  const asSkills = (names: string[]) => `${listNames(names)} as ${names.length === 1 ? 'a skill' : 'skills'}`
  const lists: [string[], string[], (names: string[]) => string, (names: string[]) => string][] = [
    [spec.skills ?? [], saved.skills ?? [], (names) => `Gets ${asSkills(names)}`, (names) => `No longer has ${asSkills(names)}`],
    [readNames(spec), readNames(saved), (names) => `Reads ${listNames(names)}`, (names) => `No longer reads ${listNames(names)}`],
    [spec.tools ?? [], saved.tools ?? [], (names) => `Uses ${listNames(names)}, asking before each action`, (names) => `No longer uses ${listNames(names)}`],
  ]
  for (const [after, before, gets, loses] of lists) {
    const got = more(after, before)
    const lost = more(before, after)
    if (got.length) said.push(gets(got))
    if (lost.length) said.push(loses(lost))
  }
  for (const [key, on, off] of SWITCHES) {
    if (Boolean(spec.allow?.[key]) !== Boolean(saved.allow?.[key])) said.push(spec.allow?.[key] ? on : off)
  }
  const checks = more(spec.doneWhen ?? [], saved.doneWhen ?? [])
  const dropped = more(saved.doneWhen ?? [], spec.doneWhen ?? [])
  if (checks.length) said.push(`Adds to Done when: ${quoted(checks)}`)
  if (dropped.length) said.push(`Takes out of Done when: ${quoted(dropped)}`)
  return said
}

/**
 * The lines for an agent Ask proposed: for a new one, what it starts with; for a change, what
 * differs from `saved` (the agent as it is saved now, or null while that isn't known), then the
 * teams that use it, which saving changes too.
 */
export function agentProposalLines(proposal: { isNew: boolean; spec: JobSpec; inTeams: readonly string[] }, saved: JobSpec | null): string[] {
  if (proposal.isNew) return newLines(proposal.spec)
  const said = saved ? changeLines(proposal.spec, saved) : []
  if (proposal.inTeams.length) said.push(`Saving also changes it in ${listNames([...proposal.inTeams])}`)
  return said
}

/**
 * Whether the agent was saved again after Ask read it (ADR 0119): its change was made from another
 * version, so it can't be saved. A new agent, or one not known yet, is never stale.
 */
export function savedSinceAsk(proposal: { isNew: boolean; baseVersion?: number | null }, saved: Pick<JobSpec, 'version'> | null): boolean {
  return !proposal.isNew && saved !== null && typeof proposal.baseVersion === 'number' && versionOf(saved) !== proposal.baseVersion
}

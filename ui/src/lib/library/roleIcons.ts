/**
 * The icons a job can wear, and the guess at one from its name or instructions. A module of its own,
 * with nothing of the app's, so a figure's sign (figures.ts) and the landing page's figures can take
 * it; roles.ts and jobs.ts give the same names to the rest of the app.
 */
export type RoleIcon = 'research' | 'write' | 'edit' | 'review' | 'code' | 'design' | 'analyse' | 'slides' | 'document' | 'sheet' | 'chart' | 'dashboard' | 'video'

/** The same list as `schemas/job-icons.json`, which the daemon checks a saved agent's icon against. */
export const ROLE_ICON_IDS: readonly RoleIcon[] = ['research', 'write', 'edit', 'review', 'code', 'design', 'analyse', 'slides', 'document', 'sheet', 'chart', 'dashboard', 'video']

const ICON_WORDS: ReadonlyArray<readonly [RoleIcon, RegExp]> = [
  ['review', /\b(review|check|critic|qa|verif|audit|approv)/],
  ['edit', /\b(edit|proofread|polish|tighten|copyedit)/],
  ['research', /\b(research|search|find|source|scout|investigat)/],
  ['slides', /\b(slides?|deck|presentation|powerpoint|pptx)\b/],
  ['sheet', /\b(spreadsheet|workbook|excel|xlsx)\b/],
  ['dashboard', /\bdashboards?\b/],
  ['chart', /\b(charts?|graphs?|plots?)\b/],
  ['video', /\b(videos?|clips?|voice-?over|animation)\b/],
  ['document', /\b(word documents?|docx|pdfs?)\b/],
  ['analyse', /\b(analy[sz]|data|metric|number|statistic)/],
  ['design', /\b(design|visual|layout|diagram|ui\b)/],
  ['code', /\b(code|coder|develop|engineer|program|bug|test|refactor)/],
  ['write', /\b(write|writer|draft|author|copy|blog|post|notes?)\b/],
]

/** An icon for a job from its name, then its instructions; none when nothing fits. */
export function guessIcon(name: string, instructions = ''): RoleIcon | undefined {
  for (const text of [name, instructions]) {
    const lower = text.toLowerCase()
    const hit = ICON_WORDS.find(([, pattern]) => pattern.test(lower))
    if (hit) return hit[0]
  }
  return undefined
}


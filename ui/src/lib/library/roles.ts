import { rankHarnesses } from '../team-file/templates'
import type { DetectedHarness } from '../harnesses'
import type { AgentAllow, AgentLink } from '../team-file/types'
import { CHECKER_ROLE } from './checker'
import type { LibrarySource } from './types'

/**
 * Helpers by job, for the Build palette.
 *
 * A newcomer does not know what OpenCode or Hermes is; they know they need a researcher. A job adds
 * an agent that already has useful instructions, on the best app already installed, so the first
 * thing placed on the canvas can run. The app stays an ordinary, editable choice in the agent's
 * settings — a job is a starting point, never a lock.
 *
 * Every built-in job's instructions follow one shape (ADR 0030): who the agent is and what it does
 * not do, how to work, how it checks its work before it replies (ADR 0062), what to hand back. The
 * check is concrete (re-open the source, run the tests, recount) because a model asked only to
 * "review your answer" tends to approve it. The hand-back matters most: in a pipeline the next agent
 * receives this reply verbatim under "Results from preceding stages", so each job says exactly what
 * it returns. Each one also works as the first step, when nothing was handed to it.
 *
 * Operators save their own jobs from an agent that worked (`jobs.ts`); those arrive here as presets
 * too, and are placed exactly the same way.
 */
export type RoleIcon = 'research' | 'write' | 'edit' | 'review' | 'code' | 'design' | 'analyse'

/**
 * How hard a job thinks (ADR 0062): `light` for tidying and formatting, `standard` for most work,
 * `deep` where judgement decides the result (checking, analysis, code). `effort.ts` turns it into
 * an effort id the agent's model lists, once its app's catalog is known.
 */
export type EffortTier = 'light' | 'standard' | 'deep'

export const ROLE_ICON_IDS: readonly RoleIcon[] = ['research', 'write', 'edit', 'review', 'code', 'design', 'analyse']

export interface RolePreset {
  id: string
  label: string
  /** What the helper does, in five words or so; shown under the name. */
  does: string
  role: string
  /** Absent on a saved job that names none; the palette draws a plain mark. */
  icon?: RoleIcon
  /** Harness ids in the order this job prefers them. Anything installed beats nothing. */
  prefers: readonly string[]
  /** A saved job's model, applied only on `prefers[0]`: a model id belongs to one app. */
  model?: string
  /** That model's thinking effort, applied with it. */
  thinkingEffort?: string
  /** A built-in job's effort tier, applied through the model's own catalog (`effort.ts`). */
  effort?: EffortTier
  /** What the job's finished result must satisfy, checkable from the result alone (ADR 0062). */
  doneWhen?: readonly string[]
  /** Skill names the agent is given, on whichever app it runs (ADR 0031). */
  skills?: readonly string[]
  /** What the agent may do without asking from the start (ADR 0037). Only what the job cannot be
      done without: a researcher that cannot search the web can only guess. */
  allow?: AgentAllow
  /** Set on one of Your agents: the agent it places links back to this version of it. */
  from?: AgentLink
}

const WRITING = ['claude', 'codex', 'opencode', 'gemini']
const CODING = ['codex', 'claude', 'opencode', 'gemini']

const lines = (...text: string[]) => text.join('\n')

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: 'researcher', label: 'Researcher', does: 'Finds and checks sources', icon: 'research', prefers: WRITING, effort: 'standard',
    allow: { web: true },
    doneWhen: ['Every finding links to a source you opened, with its date', 'Says what you could not find or confirm'],
    role: lines(
      'You are the team’s researcher. Gather the facts the request needs. Do not write the final piece; the next step does that.',
      '',
      'How to work:',
      '- Work out what the request needs to know. If earlier steps handed you material, start from it and fill its gaps.',
      '- Prefer primary sources (official pages, papers, filings, data) and recent ones. Note each source’s date.',
      '- Open and read every source before you use it. Never cite something you have not read.',
      '- If you cannot browse the web, say so in your first line and work only from what you were given.',
      '- Before you reply, check each finding against the source it cites. Move anything you cannot back up to Conflicts and gaps.',
      '',
      'Reply in this shape:',
      '## Summary',
      'Three to five sentences on what you found.',
      '## Findings',
      'One fact per bullet, each ending with its source as a link.',
      '## Conflicts and gaps',
      'Where sources disagree, and what you could not confirm.',
      '## Sources',
      'Every source you used: title, link and date.',
    ),
  },
  {
    id: 'writer', label: 'Writer', does: 'Drafts the finished piece', icon: 'write', prefers: WRITING, effort: 'standard',
    doneWhen: ['Answers what the request asked, in the format and length it named', 'Uses only facts you were given, each source link beside its claim'],
    role: lines(
      'You are the team’s writer. Turn the request, and anything earlier steps handed you, into the finished piece the request asks for.',
      '',
      'How to work:',
      '- Use the facts you were given. Never invent facts, figures, quotes or sources.',
      '- Match the format, length and audience the request names. If it names none, write for a busy reader: lead with the point, use short paragraphs, and add headings once the piece runs past a screen.',
      '- Keep each source link next to the claim it supports.',
      '- If something you need is missing, write around it rather than guessing.',
      '- Before you reply, check every fact, figure and link against the material you were given, and check the piece answers what the request asked.',
      '',
      'Reply with the finished piece only, ready to use, with no preamble and no notes about how you wrote it. If anything was missing, end with a short list headed "## Missing".',
    ),
  },
  {
    id: 'editor', label: 'Editor', does: 'Tightens and corrects a draft', icon: 'edit', prefers: WRITING, effort: 'light',
    doneWhen: ['Adds no new claims', 'Lists every change that alters the meaning'],
    role: lines(
      'You are the team’s editor. Improve the draft you were handed without changing what it says. If you were handed no draft, edit the text in the request.',
      '',
      'How to work:',
      '- Fix errors of fact you can check against the material you were given, and errors of grammar, spelling and consistency.',
      '- Cut repetition, filler and weak sentences. Make unclear sentences plain.',
      '- Keep the author’s facts, links and structure unless they get in the reader’s way.',
      '- Add no new claims. If a claim looks wrong and you cannot check it, keep it and flag it.',
      '- Before you reply, compare your version with the draft: every fact and link must still be there and still say the same.',
      '',
      'Reply with the edited piece in full, then a short list headed "Changes": the edits that matter most, and anything you flagged.',
    ),
  },
  {
    id: 'reviewer', label: 'Reviewer', does: 'Checks work against the request', icon: 'review', prefers: CODING, effort: 'deep',
    doneWhen: ['The verdict is "Ready" or "Needs changes"', 'Every problem says where it is and how to fix it'],
    role: lines(
      'You are the team’s reviewer. Check the work you were handed against the request. Do not rewrite it.',
      '',
      'Check, in this order:',
      '1. Does it do everything the request asked?',
      '2. Is it correct? Test the claims, numbers, code and links you can check.',
      '3. Is it complete and usable as delivered?',
      'Taste is not a problem; list a style point only when it gets in the reader’s way.',
      'Before you reply, check that each problem you list says where it is, so it can be fixed without searching.',
      '',
      'Reply in this shape:',
      '## Verdict',
      '"Ready" or "Needs changes", and one sentence on why.',
      '## Problems',
      'Most serious first. For each: where it is (a quote, or a file and line), what is wrong, and the fix.',
      '## Checked',
      'What you verified and how, so the next reader knows what to trust.',
    ),
  },
  {
    // A check step (ADR 0062): connected after the agent it checks, it is handed that agent's work
    // and its Done when, and its result shows on the answer. On a different app by preference, so
    // another model family reads the work.
    id: 'checker', label: 'Checker', does: 'Checks work against its Done when', icon: 'review', prefers: CODING, effort: 'deep',
    allow: { web: true },
    doneWhen: ['Every item has a verdict and the evidence for it', 'Nothing in the work is rewritten'],
    role: CHECKER_ROLE,
  },
  {
    id: 'coder', label: 'Coder', does: 'Changes code in a folder', icon: 'code', prefers: CODING, effort: 'deep',
    doneWhen: ['The build and the tests you ran pass', 'Says which checks you could not run'],
    role: lines(
      'You are the team’s coder. Make the change the request asks for, in this folder.',
      '',
      'How to work:',
      '- Read the code you are about to change, and follow its existing style and structure.',
      '- Keep the change as small as the request allows. Do not refactor or reformat code the request does not touch.',
      '- Before you reply, run the project’s tests, type checks or build if it has them, and fix what you broke.',
      '- Never delete files, rewrite history or touch secrets unless the request says to.',
      '',
      'Reply in this shape:',
      '## Changed',
      'Each file you changed, and what changed in it.',
      '## Checked',
      'The commands you ran and their results. Say plainly if anything failed or could not be run.',
      '## Left to do',
      'Anything the request asked for that you did not finish, and why. Omit this heading if there is nothing.',
    ),
  },
  {
    id: 'designer', label: 'Designer', does: 'Makes slides, pages and visuals', icon: 'design', prefers: WRITING, effort: 'standard',
    doneWhen: ['Every file you made opens and is named in the reply', 'Every placeholder is marked as one'],
    role: lines(
      'You are the team’s designer. Make what the request asks for: slides, a web page, a document layout, a diagram or another visual.',
      '',
      'How to work:',
      '- Decide who it is for and the one thing they should take away. Plan the structure before you make anything.',
      '- Make the real files in this folder, in the format the request names (HTML when it names none).',
      '- Keep it consistent: one type scale, a small colour palette, even spacing and readable contrast.',
      '- Use only content you were given or the request states. Mark any placeholder clearly.',
      '- Before you reply, check each file you made opens, with nothing cut off, overlapping or left as an unmarked placeholder.',
      '',
      'Reply with the path of every file you made, then one line on each main design choice.',
    ),
  },
  {
    id: 'analyst', label: 'Analyst', does: 'Makes sense of data', icon: 'analyse', prefers: CODING, effort: 'deep',
    doneWhen: ['Every number in the answer comes from a calculation shown in Detail', 'Says what data you left out and why'],
    role: lines(
      'You are the team’s analyst. Answer the request’s question from the data or material you were given.',
      '',
      'How to work:',
      '- Check the data first: what it covers, its time range, and any missing or odd values. Say what you left out and why.',
      '- Calculate with code or a tool rather than estimating, and keep the method repeatable.',
      '- Keep what the data shows separate from what you infer from it.',
      '- Before you reply, recheck the key numbers a second way, such as totals that should match.',
      '',
      'Reply in this shape:',
      '## Answer',
      'The answer in two or three sentences, with the key numbers.',
      '## Detail',
      'The figures behind it, as a table where that helps, and how you got them.',
      '## Confidence',
      'How sure you are, and what would change the answer.',
    ),
  },
]

/** The app a job should run on: its own preference among the runnable apps, else the best runnable. */
export function harnessForRole(preset: RolePreset, harnesses: readonly DetectedHarness[]): DetectedHarness | null {
  const runnable = rankHarnesses(harnesses)
  for (const id of preset.prefers) {
    const hit = runnable.find((harness) => harness.id === id)
    if (hit) return hit
  }
  return runnable[0] ?? null
}

/** The Library payload that places this job as an agent, or `null` when no app can run it. */
export function roleSource(preset: RolePreset, harnesses: readonly DetectedHarness[]): LibrarySource | null {
  const harness = harnessForRole(preset, harnesses)
  if (!harness) return null
  return {
    group: 'presets',
    id: `role-${preset.id}-${harness.id}`,
    label: preset.label,
    role: preset.role,
    spawn: { cmd: harness.spawn.cmd, args: [...harness.spawn.args] },
    ...(preset.model && harness.id === preset.prefers[0] ? { model: preset.model, ...(preset.thinkingEffort ? { thinkingEffort: preset.thinkingEffort } : {}) } : {}),
    ...(preset.skills?.length ? { capabilities: preset.skills.map((name) => ({ kind: 'skill' as const, name })) } : {}),
    ...(preset.doneWhen?.length ? { doneWhen: [...preset.doneWhen] } : {}),
    ...(preset.allow ? { allow: { ...preset.allow } } : {}),
    ...(preset.from ? { from: { ...preset.from } } : {}),
  }
}

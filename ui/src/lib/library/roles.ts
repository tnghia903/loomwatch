import { jobNeeds, modelForJob, type EffortTier, type ModelTier } from '../ai/modelIds'
import type { AgentAllow, AgentLink, CapabilityRef } from '../team-file/types'
import { callsFor, type ToolAllow } from '../tools/allow'
import { CHECKER_ROLE } from './checker'
import { knowledgeOf, type AgentRead } from './reads'
import type { LibrarySource } from './types'

/**
 * Helpers by job, for the Build palette.
 *
 * A newcomer does not know which model is good at what; they know they need a researcher. A job
 * adds an agent that already has useful instructions, on the model its kind of work suits, so the
 * first thing placed on the canvas can run. The model stays an ordinary, editable choice in the
 * agent's settings — a job is a starting point, never a lock.
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

export type { EffortTier, ModelTier }

export const ROLE_ICON_IDS: readonly RoleIcon[] = ['research', 'write', 'edit', 'review', 'code', 'design', 'analyse']

export interface RolePreset {
  id: string
  label: string
  /** What the helper does, in five words or so; shown under the name. */
  does: string
  role: string
  /** Absent on a saved job that names none; the palette draws a plain mark. */
  icon?: RoleIcon
  /** A saved job's model: the OpenRouter id it was saved with. */
  model?: string
  /** That model's thinking effort, applied with it. */
  thinkingEffort?: string
  /** A built-in job's effort tier (ADR 0062). */
  effort?: EffortTier
  /** A built-in job's model tier (ADR 0057; `modelIds.ts`). */
  tier?: ModelTier
  /** What the job's finished result must satisfy, checkable from the result alone (ADR 0062). */
  doneWhen?: readonly string[]
  /** Skill names the agent is given (ADR 0031). */
  skills?: readonly string[]
  /** Tools connected in LoomWatch, by name, the agent is given; only Your agents carry any. */
  tools?: readonly string[]
  /** Calls of those tools it may make without asking, by tool name (ADR 0069). */
  toolAllow?: ToolAllow
  /** Folders, files and Notion pages it reads in every team; only Your agents carry any. */
  reads?: readonly AgentRead[]
  /** What the agent may do without asking from the start (ADR 0037). Only what the job cannot be
      done without: a researcher that cannot search the web can only guess. */
  allow?: AgentAllow
  /** Set on one of Your agents: the agent it places links back to this version of it. */
  from?: AgentLink
}

const lines = (...text: string[]) => text.join('\n')

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: 'researcher', label: 'Researcher', does: 'Finds and checks sources', icon: 'research', ...jobNeeds('researcher'),
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
    id: 'writer', label: 'Writer', does: 'Drafts the finished piece', icon: 'write', ...jobNeeds('writer'),
    doneWhen: ['Answers what the request asked, in the format and length it named', 'Uses only facts you were given; if they came with source links, each claim has its link beside it'],
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
    id: 'editor', label: 'Editor', does: 'Tightens and corrects a draft', icon: 'edit', ...jobNeeds('editor'),
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
    id: 'reviewer', label: 'Reviewer', does: 'Checks work against the request', icon: 'review', ...jobNeeds('reviewer'),
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
    // and its Done when, and its result shows on the answer. On another maker's model, so the work
    // is read by a model that did not write it.
    id: 'checker', label: 'Checker', does: 'Checks work against its Done when', icon: 'review', ...jobNeeds('checker'),
    allow: { web: true },
    doneWhen: ['Every item has a verdict and the evidence for it', 'Nothing in the work is rewritten'],
    role: CHECKER_ROLE,
  },
  {
    id: 'coder', label: 'Coder', does: 'Changes code in a folder', icon: 'code', ...jobNeeds('coder'),
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
    id: 'designer', label: 'Designer', does: 'Makes slides, pages and visuals', icon: 'design', ...jobNeeds('designer'),
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
    // The supervisor of Open Deep Research (langchain-ai/open_deep_research, MIT), as a job: it
    // splits the question, its researchers work in parallel through the Team Bus `dispatch`, and a
    // writer turns their notes into a report that cites every claim. The pattern, not its text.
    id: 'lead', label: 'Research lead', does: 'Plans research and hands it out', icon: 'research', ...jobNeeds('lead'),
    doneWhen: ['Every claim in the report cites a source a researcher opened', 'Says what the research could not find or settle'],
    role: lines(
      'You are the team’s research lead. Plan the question, hand the research to the Researcher, and have the Writer turn what comes back into a report. While you have those teammates, do not research or write the report yourself.',
      '',
      'How to work:',
      '- Split the request into two to four sub-questions that do not overlap, each one a researcher can answer alone. A simple question needs only one.',
      '- Hand them all out at once with `dispatch` to the Researcher, one call for each. Each brief gives the whole request, its one sub-question, what is already known and when to stop: a researcher sees nothing else.',
      '- When the findings come back, look for gaps and conflicts that change the answer. Hand those out in one more round, once at most.',
      '- Then `ask` the Writer for the report. Give it the request and every researcher’s findings and sources in full. Ask for a report that answers the request, with a numbered citation such as [1] after every claim, each linked to its source, and a "## Sources" list at the end giving each number its title, link and date.',
      '- If the team has no Researcher or no Writer, do that part yourself, the same way.',
      '- Before you reply, check that every claim in the report has a citation and that every cited source is one a researcher opened. If not, send the Writer the fixes once.',
      '',
      'Reply with the Writer’s report in full, as the team’s answer, with nothing before it. End with a short list headed "## Not confirmed" for anything the research could not find or settle; leave it out when there is nothing.',
    ),
  },
  {
    id: 'analyst', label: 'Analyst', does: 'Makes sense of data', icon: 'analyse', ...jobNeeds('analyst'),
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

/** The model and effort a job places its agent on: a saved job's own, else its tiers'. */
export function modelForPreset(preset: RolePreset): { model: string; thinkingEffort?: string } {
  if (preset.model) return { model: preset.model, ...(preset.thinkingEffort ? { thinkingEffort: preset.thinkingEffort } : {}) }
  return modelForJob(preset)
}

/**
 * What it reads, its skills and its tools as a team agent's `capabilities`: what placing an agent,
 * or the test bench, writes. Each tool carries the calls it may make without asking (ADR 0069).
 */
export function capabilitiesOf(skills: readonly string[], tools: readonly string[], toolAllow: ToolAllow = {}, reads: readonly AgentRead[] = []): CapabilityRef[] {
  return [
    ...knowledgeOf(reads),
    ...skills.map((name) => ({ kind: 'skill' as const, name })),
    ...tools.map((name) => {
      const calls = callsFor(toolAllow, name)
      return { kind: 'tool' as const, name, ...(calls.length ? { alwaysAllow: calls } : {}) }
    }),
  ]
}

/** The Library payload that places this job as an agent. */
export function roleSource(preset: RolePreset): LibrarySource {
  return {
    group: 'presets',
    id: `role-${preset.id}`,
    label: preset.label,
    role: preset.role,
    ...modelForPreset(preset),
    ...(preset.skills?.length || preset.tools?.length || preset.reads?.length ? { capabilities: capabilitiesOf(preset.skills ?? [], preset.tools ?? [], preset.toolAllow ?? {}, preset.reads ?? []) } : {}),
    ...(preset.doneWhen?.length ? { doneWhen: [...preset.doneWhen] } : {}),
    ...(preset.allow ? { allow: { ...preset.allow } } : {}),
    ...(preset.from ? { from: { ...preset.from } } : {}),
  }
}

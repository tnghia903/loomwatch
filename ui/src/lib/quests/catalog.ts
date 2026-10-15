/**
 * Quests (docs/QUESTS.md): each teaches one practice from building agents and agent teams, by
 * noticing it in a real run rather than explaining it first.
 *
 * - Before: a locked item shows its `hint`, one line on what to try.
 * - During: the operator tries it on work they wanted done anyway; nothing about the run changes.
 * - After: the receipt of the run that earned it names the `practice`, says why it works (`teach`)
 *   and links to where the practice comes from (`source`).
 *
 * The reward goes into one wardrobe shared by every agent in Your agents: an accessory any agent
 * can wear, or a figure any agent can be. Whether a run earned one is decided only from what
 * LoomWatch recorded (./rules.ts), never from what an agent said about itself, and no quest counts
 * runs: running more only spends tokens.
 */

export type QuestArea = 'prompt' | 'context' | 'harness' | 'graph' | 'loop'

export const AREAS: readonly QuestArea[] = ['prompt', 'context', 'harness', 'graph', 'loop']

export const AREA_NAMES: Record<QuestArea, string> = {
  prompt: 'Prompt',
  context: 'Context',
  harness: 'Harness',
  graph: 'Team shape',
  loop: 'Checking',
}

/** Accessories, in the order they are layered on a figure: what sits behind first. */
export const ACCESSORIES = ['band', 'chalk', 'patch', 'pin', 'monocle', 'cushion', 'shuttle'] as const
export type Accessory = (typeof ACCESSORIES)[number]

/** Figures a quest earns (lib/library/figures.ts draws them once earned). */
export const EARNED_FIGURES = ['scissors', 'bobbin'] as const
export type EarnedFigure = (typeof EARNED_FIGURES)[number]

export type QuestItem = Accessory | EarnedFigure

export interface QuestSource {
  name: string
  url: string
}

/** Where each practice comes from. Every summary on a quest is LoomWatch's, not a quote. */
export const SOURCES = {
  agents: { name: 'Anthropic: Building effective agents', url: 'https://www.anthropic.com/research/building-effective-agents' },
  context: { name: 'Anthropic: Effective context engineering for AI agents', url: 'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents' },
  evals: { name: 'Anthropic: Demystifying evals for AI agents', url: 'https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents' },
  success: { name: 'Claude docs: Define your success criteria', url: 'https://platform.claude.com/docs/en/test-and-evaluate/define-success' },
  agency: { name: 'OWASP Top 10 for LLM apps: Excessive Agency', url: 'https://genai.owasp.org/llmrisk/llm062025-excessive-agency/' },
} as const satisfies Record<string, QuestSource>

export interface Quest {
  item: QuestItem
  /** An accessory any agent can wear, or a figure any agent can be. */
  reward: 'accessory' | 'figure'
  area: QuestArea | 'all'
  /** The item's name. */
  name: string
  /** The practice it teaches, as the field names it. */
  practice: string
  /** What to try, shown while it is locked. */
  hint: string
  /** Why the practice works, in one or two sentences, shown on the receipt that earns it. */
  teach: string
  /** What a run has to show, in plain words. */
  earnedWhen: string
  source: QuestSource | null
}

export const QUESTS: readonly Quest[] = [
  {
    item: 'chalk', reward: 'accessory', area: 'prompt', name: 'Tailor’s chalk', practice: 'Clear success criteria',
    hint: 'Give an agent a Done when it can check itself against before it replies.',
    teach: 'Specific, checkable criteria tell the model when it is finished, and give you something to check its work against.',
    earnedWhen: 'An agent with a Done when replies with nothing under “Not met”, in a run that finished.',
    source: SOURCES.success,
  },
  {
    item: 'band', reward: 'accessory', area: 'context', name: 'Tape-measure band', practice: 'Scoped context',
    hint: 'Give an agent only the folders its job needs, not a whole drive.',
    teach: 'A model’s attention is a budget: the more it holds, the worse it recalls. A small set of the right sources beats a big one.',
    earnedWhen: 'An agent is given at least one folder to read, and reads from every folder it was given, in a run that finished.',
    source: SOURCES.context,
  },
  {
    item: 'pin', reward: 'accessory', area: 'harness', name: 'Safety-pin clip', practice: 'Least privilege',
    hint: 'Before a scheduled run, switch on only the keys (web, files, commands) its job uses.',
    teach: 'An agent should hold only the permissions its job needs. Extra ones turn a model’s mistake into real damage.',
    earnedWhen: 'A scheduled run finishes without asking for any permission, and every key its agents hold was used.',
    source: SOURCES.agency,
  },
  {
    item: 'cushion', reward: 'accessory', area: 'harness', name: 'Wrist pincushion', practice: 'Test before you ship',
    hint: 'Try an agent on its test bench in Your agents before a team uses it.',
    teach: 'Agents act over many steps and change things, so a trial run catches problems before they reach real work.',
    earnedWhen: 'A team run finishes with an agent from Your agents that had a test bench run that finished before it.',
    source: SOURCES.evals,
  },
  {
    item: 'shuttle', reward: 'accessory', area: 'graph', name: 'Shuttle', practice: 'Orchestrator and workers',
    hint: 'Let a lead hand one clear question to a teammate instead of doing everything itself.',
    teach: 'A lead splits the work, hands pieces to teammates and puts their answers together. It suits work whose parts you can’t list in advance.',
    earnedWhen: 'One agent asks another a question over the Team Bus and gets an answer, in a run that finished.',
    source: SOURCES.agents,
  },
  {
    item: 'monocle', reward: 'accessory', area: 'loop', name: 'Button monocle', practice: 'Evaluator–optimizer loop',
    hint: 'Add a check step with “Send it back once” on, after the agent whose work matters most.',
    teach: 'One agent drafts and another checks it against clear criteria, then sends it back to improve. It pays off when you can say what good looks like.',
    earnedWhen: 'A check step sends work back, and the second pass meets every item it checks, in a run that finished.',
    source: SOURCES.agents,
  },
  {
    item: 'patch', reward: 'accessory', area: 'loop', name: 'Sewn-on patch', practice: 'Learn from failures',
    hint: 'When the checkup shows a lesson from your runs, fix its cause and use the team again.',
    teach: 'Reading what went wrong in real runs, then fixing the cause, improves an agent more than guessing does.',
    earnedWhen: 'Something that went wrong in two or more of a team’s recent runs doesn’t happen in its next run, and that run finishes.',
    source: SOURCES.evals,
  },
  {
    item: 'scissors', reward: 'figure', area: 'graph', name: 'Scissors', practice: 'Start simple',
    hint: 'If a team works, try it with one agent fewer. Add agents only when a run shows the need.',
    teach: 'The simplest setup that works is usually best. Every extra agent adds tokens, time and another place to go wrong.',
    earnedWhen: 'A team runs with fewer agents than its last finished run, finishes, and uses fewer tokens.',
    source: SOURCES.agents,
  },
  {
    item: 'bobbin', reward: 'figure', area: 'all', name: 'Bobbin', practice: 'The whole craft',
    hint: 'Earn one item from each of the five parts: prompt, context, harness, team shape and checking.',
    teach: 'A good agent is more than a good prompt: it also needs the right context, safe permissions, a team no bigger than the job, and a way to check its work.',
    earnedWhen: 'The wardrobe holds an item from each of the five parts.',
    source: null,
  },
]

export function questFor(item: string): Quest | undefined {
  return QUESTS.find((quest) => quest.item === item)
}

export function isAccessory(value: unknown): value is Accessory {
  return typeof value === 'string' && (ACCESSORIES as readonly string[]).includes(value)
}

export function isQuestItem(value: unknown): value is QuestItem {
  return typeof value === 'string' && QUESTS.some((quest) => quest.item === value)
}

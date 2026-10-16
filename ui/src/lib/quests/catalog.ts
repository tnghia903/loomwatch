/**
 * Quests (docs/QUESTS.md): each notices one good practice of building agents and agent teams when a
 * real run shows it. LoomWatch configures agents rather than teaching about them, so a quest says
 * what to try and, once, why it works, and nothing more: no lessons, reading lists or links.
 *
 * - Before: a locked item in the wardrobe shows its `hint`, one line on what to try.
 * - During: the operator tries it on work they wanted done anyway; nothing about the run changes.
 * - After: the receipt of the run that earned it says what the run did and, in one sentence, why
 *   that works (`why`).
 *
 * The reward goes into one wardrobe shared by every agent in Your agents: an accessory any agent
 * can wear, or a figure any agent can be. Whether a run earned one is decided only from what
 * LoomWatch recorded (./rules.ts), never from what an agent said about itself, and no quest counts
 * runs: running more only spends tokens.
 */

export type QuestArea = 'prompt' | 'context' | 'harness' | 'graph' | 'loop'

export const AREAS: readonly QuestArea[] = ['prompt', 'context', 'harness', 'graph', 'loop']

/** The five parts of building agents, as the Quests page names them. */
export const AREA_NAMES: Record<QuestArea, string> = { prompt: 'Prompt', context: 'Context', harness: 'Harness', graph: 'Team shape', loop: 'Checking' }

/** Accessories, in the order they are layered on a figure: what sits behind first. */
export const ACCESSORIES = ['band', 'chalk', 'patch', 'pin', 'monocle', 'cushion', 'shuttle'] as const
export type Accessory = (typeof ACCESSORIES)[number]

/** Figures a quest earns (lib/library/figures.ts draws them once earned). */
export const EARNED_FIGURES = ['scissors', 'bobbin'] as const
export type EarnedFigure = (typeof EARNED_FIGURES)[number]

export type QuestItem = Accessory | EarnedFigure

export interface Quest {
  item: QuestItem
  /** An accessory any agent can wear, or a figure any agent can be. */
  reward: 'accessory' | 'figure'
  area: QuestArea | 'all'
  /** The item's name. */
  name: string
  /** The practice a run shows to earn it, in a few words. */
  practice: string
  /** What to try, shown while it is locked. */
  hint: string
  /** Why the practice works, in one sentence, shown on the receipt that earns it. */
  why: string
  /** What a run has to show, in plain words. */
  earnedWhen: string
}

export const QUESTS: readonly Quest[] = [
  {
    item: 'chalk', reward: 'accessory', area: 'prompt', name: 'Tailor’s chalk', practice: 'Clear success criteria',
    hint: 'Give an agent a Done when, and a check step that checks its work against it.',
    why: 'Checkable criteria tell an agent when it is finished, and give a check step something to hold its work against.',
    earnedWhen: 'A check step’s first look at an agent’s work finds every item of its Done when met, in a run that finished.',
  },
  {
    item: 'band', reward: 'accessory', area: 'context', name: 'Tailor’s tape', practice: 'Scoped context',
    hint: 'Give an agent only the folders its job needs, not a whole drive.',
    why: 'A model recalls less the more it holds, so the few folders a job needs beat a whole drive.',
    earnedWhen: 'An agent is given at least one folder to read, and reads from every folder it was given, in a run that finished.',
  },
  {
    item: 'pin', reward: 'accessory', area: 'harness', name: 'Safety-pin clip', practice: 'Least privilege',
    hint: 'Before a scheduled run, switch on only the keys (web, files, commands) its job uses.',
    why: 'A key the job never uses only turns a model’s mistake into real damage.',
    earnedWhen: 'A scheduled run finishes without asking for any permission, and every key its agents hold was used.',
  },
  {
    item: 'cushion', reward: 'accessory', area: 'harness', name: 'Wrist pincushion', practice: 'Test before you ship',
    hint: 'Try an agent on its test bench in Your agents before a team uses it.',
    why: 'An agent acts over many steps and changes things, so a trial run catches problems before they reach real work.',
    earnedWhen: 'A team run finishes with an agent from Your agents that had a test bench run that finished before it.',
  },
  {
    item: 'shuttle', reward: 'accessory', area: 'graph', name: 'Shuttle', practice: 'Orchestrator and workers',
    hint: 'Let a lead hand one clear question to a teammate instead of doing everything itself.',
    why: 'A lead that hands a teammate one clear question gets a focused answer back, instead of doing every part itself.',
    earnedWhen: 'One agent asks another a question over the Team Bus and gets an answer, in a run that finished.',
  },
  {
    item: 'monocle', reward: 'accessory', area: 'loop', name: 'Button monocle', practice: 'Evaluator–optimizer loop',
    hint: 'Add a check step with “Send it back once” on, after the agent whose work matters most.',
    why: 'A second look against clear criteria catches what the first pass missed, and one more pass fixes it.',
    earnedWhen: 'A check step sends work back, and the second pass meets every item it checks, in a run that finished.',
  },
  {
    item: 'patch', reward: 'accessory', area: 'loop', name: 'Sewn-on patch', practice: 'Learn from failures',
    hint: 'When the checkup shows a lesson from your runs, fix its cause and use the team again.',
    why: 'Fixing the cause of what went wrong in real runs improves an agent more than guessing does.',
    earnedWhen: 'Something that went wrong in two or more of a team’s recent runs doesn’t happen in its next run, and that run finishes.',
  },
  {
    item: 'scissors', reward: 'figure', area: 'graph', name: 'Scissors', practice: 'Start simple',
    hint: 'If a team works, try it with one agent fewer. Add agents only when a run shows the need.',
    why: 'Every agent a team doesn’t need adds tokens, time and another place to go wrong.',
    earnedWhen: 'A team runs with fewer agents than its last finished run, finishes, and uses fewer tokens.',
  },
  {
    item: 'bobbin', reward: 'figure', area: 'all', name: 'Bobbin', practice: 'The whole craft',
    hint: 'Earn one item from each of the five parts: prompt, context, harness, team shape and checking.',
    why: 'A good agent takes more than a good prompt, and your runs have now shown every part of it.',
    earnedWhen: 'The wardrobe holds an item from each of the five parts.',
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

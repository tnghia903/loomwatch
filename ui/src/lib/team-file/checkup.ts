// The team checkup: what would make each agent, and the team as a whole, work better.
//
// Validation (validation.ts) answers "will this file run". This answers "will it work well": an
// agent told one line, an agent whose instructions need the web but which must stop and ask for
// it, a lead that is never told when to use its teammates, a last step that judges the work instead
// of delivering it. Every rule is read off the team file and what the daemon really does with it
// (orientation.rs, skill_routing.rs, permissions.rs, the pipeline handover), never off a guess about
// the model. Each finding says why in one sentence and, where one exists, carries a fix the canvas
// can apply in one click: the operator stays the author, and ⌘Z undoes it like any other edit.
//
// Pure and framework-free like agentPlace.ts, so every rule is testable without a canvas.

import { DEFAULT_MODEL, OVERTHINKING_EFFORTS, modelForJob, modelNameFromId, openRouterId } from '../ai/modelIds'
import { ROLE_PRESETS, type RolePreset } from '../library/roles'
import type { TeamUsage } from './runLessons'
import type { AgentAllow, AgentConfig, AllowSwitch } from './types'

export interface CheckupEdge {
  from: string
  to: string
}

export interface CheckupInput {
  agents: readonly AgentConfig[]
  /** Configured edges only. */
  edges: readonly CheckupEdge[]
  entrypoint: string | null
  /** The agent whose reply is the team's answer: the document's `responder`, else the inferred one. */
  responder: string | null
  /** Runs on a schedule, so nobody may be there to answer a permission request. */
  scheduled?: boolean
  /** The model list's own names by id, once it has arrived; absent, names come from the ids. */
  modelNames?: ReadonlyMap<string, string>
  /** Where the team's tokens went in its recent runs (`teamUsage`), quoted beside a tier finding. */
  usage?: TeamUsage | null
}

export type CheckupRule =
  | 'needs-web'
  | 'needs-edits'
  | 'needs-commands'
  | 'thin-instructions'
  | 'no-hand-back'
  | 'lead-delegation'
  | 'final-is-review'
  | 'handoff-unused'
  | 'same-job'
  | 'large-team'
  | 'shouting'
  | 'overthinking'
  | 'long-instructions'
  | 'strong-gatherer'
  // Read from the team's recent runs (runLessons.ts).
  | 'heavy-agent'
  | 'idle-teammate'
  | 'asked-again'
  | 'keeps-failing'

/** What a one-click fix changes. Each maps onto an edit the team document already has. */
export type CheckupFix =
  | { kind: 'allow'; agentId: string; key: AllowSwitch }
  | { kind: 'append-role'; agentId: string; text: string }
  /** A built-in job's instructions, with the switches the job cannot work without (roles.ts). */
  | { kind: 'replace-role'; agentId: string; text: string; allow?: AgentAllow }
  | { kind: 'effort'; agentId: string; value: string }
  /** A model to run the agent on, with the effort to run it at; none means the model's default. */
  | { kind: 'model'; agentId: string; model: string; thinkingEffort?: string }

export interface CheckupFinding {
  /** Stable across edits that do not change the finding, so a dismissal sticks. */
  id: string
  rule: CheckupRule
  /** `fix`: the run will stall or skip work. `improve`: the run works, the result could be better. */
  severity: 'fix' | 'improve'
  /** The agent the finding is about; the one opened to act on it. */
  agentId: string
  /** Every agent the finding names, so the agent panel can list it on each of them. */
  agentIds: readonly string[]
  title: string
  why: string
  fix?: { label: string; change: CheckupFix }
  /** For a finding only judgement can fix: what to ask Ask LoomWatch, which proposes the edit. */
  askPrompt?: string
  /** Read from this many of the team's recent runs (runLessons.ts), not from the file alone. */
  learned?: number
}

/**
 * Capitals used for emphasis. Recent models follow instructions closely, and a shouted rule gets
 * applied even where it does not fit (Anthropic's prompting guide says to drop "CRITICAL: You
 * MUST" for plain wording). Only these words count, so an acronym such as API or PDF never does.
 */
const SHOUTED = /(?<![A-Za-z’'])(MUST(?:N['’]T)?|NEVER|ALWAYS|CRITICAL|IMPORTANT|NOT|ONLY|DON['’]T|DO NOT|REQUIRED|MANDATORY|STRICTLY|ABSOLUTELY|EXACTLY|UNDER NO CIRCUMSTANCES)(?![A-Za-z])/g
/** One shouted word can be a habit; two is a prompt written in capitals. */
const SHOUTING = 2

/** The same instructions in plain case: a shouted word starts a sentence with a capital, else lower case. */
export function unshout(role: string): string {
  return role.replace(SHOUTED, (word, _match: string, offset: number) => {
    const before = role.slice(0, offset)
    const startsSentence = /(^|[.!?:]\s+|\n\s*(?:[-*•]\s+|\d+[.)]\s+)?)$/.test(before)
    const lower = word.toLowerCase()
    return startsSentence ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
  })
}

/** Fewer words than this and the model has to guess the scope, the method and the format. */
export const THIN_WORDS = 12
/**
 * More words than this and the instructions cost more than they add: the model reads every word at
 * the start of every run, and in a long prompt each line gets less of the model's attention. The
 * built-in jobs are well under 300.
 */
export const LONG_WORDS = 700
/** Content-word overlap at which two agents are doing the same job. */
const SAME_JOB_OVERLAP = 0.7
/** More working agents than this, and it is worth asking whether some could be one. */
export const LARGE_TEAM = 4

const ALLOW_RULES: { rule: CheckupRule; key: AllowSwitch; needs: RegExp; doing: string; to: string; switchLabel: string }[] = [
  {
    rule: 'needs-web', key: 'web', doing: 'searches the web', to: 'search the web', switchLabel: 'Allow web search',
    needs: /\b(web|online|internet|browse|browsing|websites?|web ?pages?|news|google)\b/i,
  },
  {
    rule: 'needs-edits', key: 'edits', doing: 'changes a file', to: 'change files', switchLabel: 'Allow file changes',
    needs: /\b(write|create|save|edit|change|modify|update|make|generate)\b[^.\n]{0,50}\b(files?|code|codebase|repo|repository|folder|html|slides?|\.md|\.html|\.css|\.py|\.ts)\b|\b(fix|refactor|implement)\b[^.\n]{0,40}\b(bugs?|code|tests?|features?|functions?)\b/i,
  },
  {
    rule: 'needs-commands', key: 'commands', doing: 'runs a command', to: 'run commands', switchLabel: 'Allow commands',
    needs: /\b(run|execute|install)\b[^.\n]{0,40}\b(tests?|test suite|build|commands?|scripts?|lint(er)?|type checks?|npm|pnpm|yarn|cargo|pip|python|node)\b|\bterminal\b|\bshell\b/i,
  },
]

/** Says what to reply with: a reply, a format, or a shape drawn as headings. */
const HAND_BACK = /\b(reply|replies|respond|response|return|hand (it |them |this )?(back|over|on)|output|deliver|produce|format|end with|give back|answer with|in this shape)\b|^\s*#{1,3}\s/im
/** A self-check sentence ("Before you reply, check …") names the reply without saying what it is. */
const BEFORE_REPLYING = /\bbefore (you|it) (reply|replies|respond|responds|answer|answers|hand|hands|send|sends|return|returns|deliver|delivers)\b[^.\n]*/gi

/** Whether a line is a self-check ("Before you reply, check …") rather than a word on the reply itself. */
export function checksBeforeReplying(line: string): boolean {
  return new RegExp(BEFORE_REPLYING.source, 'i').test(line)
}

/** Whether these instructions say what the agent replies with, not counting a check before it. */
function saysWhatItReplies(role: string): boolean {
  return HAND_BACK.test(role.replace(BEFORE_REPLYING, ''))
}
/** Refers to the work an earlier step handed it. */
const USES_HANDOFF = /\b(handed|given you|you are given|you were given|earlier (step|steps|stage|work)|previous (step|stage|work)|preceding|before you|you receive|received|drafts?|material|findings|research|brief|handover|what came before)\b/i
/** Tells a lead to use its teammates. */
const DELEGATES = /\b(delegate|delegating|hand (off|over|out|work|parts?)|teammates?|helpers?|assign|split the work|ask (the |your )?(team|others|helpers))\b/i
/** A reviewer's instructions: judge, do not deliver. */
const JUDGES = /\b(verdict|do not rewrite|don['’]t rewrite|not rewrite)\b|\b(review|check|critique|grade|audit)\b[^.\n]{0,30}\b(the work|the draft|it against|against the request)\b/i
/** …and still hands over the finished work, which is what a last step's reply has to be. */
const DELIVERS = /\b(finished (piece|result|work|version)|in full|corrected (piece|version|work)|fixed (piece|version|work))\b/i

const STOPWORDS = new Set('the and for that this with from your you are what when which into each them they their then than have has had not but can will its it’s also only more most such these those about over just like make sure should would could been being were was very any all one two our out use using who how why where there here able must every other some what'.split(' '))

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z'’-]{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word)))
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** A built-in job whose name the agent carries, so its instructions can stand in for one line. */
export function jobFor(agent: Pick<AgentConfig, 'name' | 'role'>): RolePreset | null {
  const name = agent.name.toLowerCase()
  const role = agent.role.toLowerCase()
  const stems: Record<string, RegExp> = {
    researcher: /\bresearch/, writer: /\bwrit(er|e|ing)\b/, editor: /\bedit(or|ing)?\b|\bproofread/,
    reviewer: /\breview|\bcritic|\bqa\b/, coder: /\bcod(er|e|ing)\b|\bdevelop|\bengineer|\bprogramm/,
    designer: /\bdesign/, analyst: /\banaly/,
  }
  const byName = ROLE_PRESETS.find((preset) => stems[preset.id]?.test(name))
  return byName ?? ROLE_PRESETS.find((preset) => stems[preset.id]?.test(role)) ?? null
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** What will go wrong before what could be better. */
export const bySeverity = (a: CheckupFinding, b: CheckupFinding) => (a.severity === b.severity ? 0 : a.severity === 'fix' ? -1 : 1)

/** The instructions name this agent, which is how a lead is told when to use it. */
export const mentions = (role: string, name: string) => name.trim() !== '' && role.toLowerCase().includes(name.trim().toLowerCase())

/** "In the last 3 runs it used 41% of the team's tokens.", from the runs' own counts; empty without them. */
function shareOfTeam(usage: TeamUsage | null | undefined, agentId: string): string {
  const mine = usage?.agents.find((candidate) => candidate.id === agentId)
  if (!usage || !mine || usage.agents.length < 2) return ''
  return ` In ${usage.runs === 1 ? 'the last run' : `the last ${usage.runs} runs`} it used ${Math.round(mine.share * 100)}% of the team’s tokens.`
}

export function checkup({ agents, edges, entrypoint, responder, scheduled = false, modelNames, usage }: CheckupInput): CheckupFinding[] {
  const findings: CheckupFinding[] = []
  const workers = agents.filter((agent) => agent.kind !== 'operator')
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const name = (id: string) => byId.get(id)?.name || id
  const pipeline = edges.length > 0
  const lead = entrypoint ? byId.get(entrypoint) : undefined
  const add = (finding: Omit<CheckupFinding, 'id' | 'agentIds'> & { agentIds?: readonly string[] }) => {
    const agentIds = finding.agentIds ?? [finding.agentId]
    findings.push({ ...finding, agentIds, id: `${finding.rule}:${agentIds.join('+')}` })
  }

  // ── The team: can the lead use its teammates, and does it know when to? A pipeline agent left
  // unconnected is the team sentence's to say (teamSentence.ts), with its own fix: not repeated. ──
  if (!pipeline && lead && lead.kind !== 'operator' && workers.length > 1) {
    const teammates = workers.filter((agent) => agent.id !== lead.id)
    if (!DELEGATES.test(lead.role) && !teammates.some((agent) => mentions(lead.role, agent.name))) {
      add({
        rule: 'lead-delegation', severity: 'improve', agentId: lead.id,
        title: `Tell ${lead.name} when to bring in ${list(teammates.map((agent) => agent.name))}`,
        why: `${lead.name} is told who its teammates are, but not when to use them, so a lead often does the whole job alone.`,
        fix: {
          label: 'Add a hand-off plan',
          change: {
            kind: 'append-role', agentId: lead.id,
            // Names only: the daemon already lists each teammate's job under "Your place in the
            // team" (orientation.rs), and copying their instructions here would make this agent's
            // own read as theirs.
            // When, not how: the daemon tells every lead how to brief a teammate (orientation.rs
            // DELEGATION, ADR 0062), so this says only which part of the work is whose.
            text: `When the request is bigger than one step, hand parts of it to your teammates, ${list(teammates.map((agent) => agent.name))}, each the part that matches its job, then combine what they send into your answer.`,
          },
        },
      })
    }
  }

  // ── Size: every agent that runs starts a session of its own, and each hand-off loses detail. ──
  if (workers.length > LARGE_TEAM) {
    const anchor = lead && lead.kind !== 'operator' ? lead : workers[0]
    add({
      rule: 'large-team', severity: 'improve', agentId: anchor.id,
      title: `${workers.length} agents is a large team`,
      why: 'Each agent that runs starts a session of its own and pays its own opening cost, and each hand-off loses some detail. Check whether some of them could be one agent with clearer instructions.',
      askPrompt: `This team has ${workers.length} agents. Suggest how it could do the same work with fewer agents, merging jobs that belong together, and propose the change.`,
    })
  }

  // ── Each agent: are its instructions enough, and may it do what they ask? ──
  for (const agent of workers) {
    const role = agent.role ?? ''
    const count = words(role).length
    const final = agent.id === responder
    const predecessors = edges.filter((edge) => edge.to === agent.id).map((edge) => edge.from)

    for (const allow of ALLOW_RULES) {
      if (agent.allow?.[allow.key] || !allow.needs.test(role)) continue
      add({
        rule: allow.rule, severity: scheduled ? 'fix' : 'improve', agentId: agent.id,
        // permissions.rs: what is not switched on waits for the operator, up to 10 minutes, and a
        // scheduled run declines it at once (AgentPermissions says the same under its "?").
        title: scheduled ? `${agent.name} can't ${allow.to} when the team runs on schedule` : `${agent.name} must ask you each time it ${allow.doing}`,
        why: scheduled
          ? 'Its instructions need it, and a scheduled run declines anything not allowed here, so that part of the work won’t get done.'
          : 'Its instructions need it, so the run waits for your answer each time. Allow it here if you trust this agent with it.',
        fix: { label: allow.switchLabel, change: { kind: 'allow', agentId: agent.id, key: allow.key } },
      })
    }

    // Before the instructions checks: an empty or short role does not make max effort cheaper.
    if (agent.thinkingEffort && OVERTHINKING_EFFORTS.has(agent.thinkingEffort)) {
      add({
        rule: 'overthinking', severity: 'improve', agentId: agent.id,
        title: `${agent.name} thinks at the highest effort on every run`,
        why: 'The highest setting often overthinks, and thinking is paid for like writing. High is enough for almost any job.',
        fix: { label: 'Use high effort', change: { kind: 'effort', agentId: agent.id, value: 'high' } },
      })
    }

    // A gatherer on the strongest model (ADR 0057): it feeds the agent that writes the answer, so a
    // faster model does its work and leaves the strong one for the step that writes. Never for the
    // agent whose reply is the team's answer, and only for one on the default strong model: a model
    // the operator chose on purpose is theirs.
    const job = jobFor(agent)
    if (job?.tier === 'fast' && !final && openRouterId(agent.model) === DEFAULT_MODEL) {
      const fast = modelForJob(job)
      const named = (id: string) => modelNames?.get(id) ?? modelNameFromId(id)
      const writer = responder ? name(responder) : 'the next step'
      add({
        rule: 'strong-gatherer', severity: 'improve', agentId: agent.id,
        title: `${agent.name} could gather on ${named(fast.model)}`,
        why: `It collects facts for ${writer} to write up. A faster model does that well, for less, and leaves ${named(DEFAULT_MODEL)} for the step that writes the answer.${shareOfTeam(usage, agent.id)}`,
        fix: {
          label: `Use ${named(fast.model)}`,
          change: { kind: 'model', agentId: agent.id, model: fast.model, ...(fast.thinkingEffort ? { thinkingEffort: fast.thinkingEffort } : {}) },
        },
      })
    }

    if (count === 0) continue
    if (count < THIN_WORDS) {
      add({
        rule: 'thin-instructions', severity: 'improve', agentId: agent.id,
        title: `${agent.name}'s instructions are very short`,
        why: 'With one line to go on, the model guesses the scope, the method and the format. Say what it does, how to work, and what to hand back.',
        ...(job ? { fix: { label: `Use the ${job.label} job's instructions`, change: { kind: 'replace-role' as const, agentId: agent.id, text: job.role, ...(job.allow ? { allow: job.allow } : {}) } } } : {}),
        askPrompt: `Rewrite the instructions of ${agent.name} in this team so it knows what it does and does not do, how to work, and exactly what to reply with. Keep the job it has now: “${role.trim()}”.`,
      })
      continue
    }

    if (count > LONG_WORDS) {
      add({
        rule: 'long-instructions', severity: 'improve', agentId: agent.id,
        title: `${agent.name}'s instructions are ${count} words long`,
        why: 'The model reads every word at the start of every run, and in a long prompt each line counts for less. Keep what changes how it works; cut background it can look up and rules any careful worker follows anyway.',
        askPrompt: `Tighten the instructions of ${agent.name} in this team to under 300 words. Keep its job, how it works, how it checks and exactly what it replies with; cut repetition, background and rules any careful worker would follow anyway.`,
      })
    }

    if ((role.match(SHOUTED) ?? []).length >= SHOUTING) {
      add({
        rule: 'shouting', severity: 'improve', agentId: agent.id,
        title: `${agent.name}'s instructions use capitals for emphasis`,
        why: 'Models follow instructions closely, and a rule in capitals gets applied even where it doesn’t fit. Plain words, with the reason for the rule, work better.',
        fix: { label: 'Write them in plain case', change: { kind: 'replace-role', agentId: agent.id, text: unshout(role) } },
      })
    }

    const helper = !pipeline && lead && agent.id !== lead.id
    if ((final || helper) && !saysWhatItReplies(role)) {
      add({
        rule: 'no-hand-back', severity: 'improve', agentId: agent.id,
        title: final ? `Say what ${agent.name}'s answer should look like` : `Say what ${agent.name} sends back to ${lead?.name}`,
        why: final
          ? 'Its reply is the team’s answer. Without a format, each run comes back in a different shape.'
          : `Its reply goes back to ${lead?.name}, who has to use it. Name what to return so nothing gets lost.`,
        fix: {
          label: 'Add a reply format',
          change: {
            kind: 'append-role', agentId: agent.id,
            text: final
              ? 'Reply with the finished result only, ready to use: lead with the answer, then the details, in short sections. No preamble and no notes about how you worked. If something was missing, end with a short list headed "## Missing".'
              : `Reply to ${lead?.name} with what you found or made, in short sections, naming each source or file. Say plainly what you could not do.`,
          },
        },
      })
    }

    // A check step judges on purpose: the answer is the work it checks (ADR 0062).
    if (pipeline && final && !agent.checks && predecessors.length > 0 && JUDGES.test(role) && !DELIVERS.test(role)) {
      add({
        rule: 'final-is-review', severity: 'improve', agentId: agent.id,
        title: `The team's answer will be ${agent.name}'s review, not the finished work`,
        why: `${agent.name} is the last step, so its reply is what you get, and it is told to judge the work rather than deliver it.`,
        fix: {
          label: 'Have it deliver the fixed work',
          change: { kind: 'append-role', agentId: agent.id, text: 'You are the last step, so your reply is the team’s answer: after your verdict, give the finished piece in full, with the problems you found fixed.' },
        },
      })
    }

    const workPredecessors = predecessors.filter((id) => byId.get(id)?.kind !== 'operator')
    if (pipeline && workPredecessors.length > 0 && !USES_HANDOFF.test(role.replace(BEFORE_REPLYING, ''))) {
      const from = list(workPredecessors.map(name))
      add({
        rule: 'handoff-unused', severity: 'improve', agentId: agent.id,
        title: `${agent.name} isn't told to build on ${from}'s work`,
        why: `${from} hands it a handover, but its instructions read as if it starts from nothing, so it may redo that work.`,
        fix: { label: 'Start from the handover', change: { kind: 'append-role', agentId: agent.id, text: `Start from what ${from} handed you. Build on it rather than redoing it, and say if something you need is missing from it.` } },
      })
    }
  }

  // ── Two agents, one job. ──
  const vocab = new Map(workers.map((agent) => [agent.id, contentWords(agent.role ?? '')]))
  for (let i = 0; i < workers.length; i += 1) {
    for (let j = i + 1; j < workers.length; j += 1) {
      const [a, b] = [workers[i], workers[j]]
      if (words(a.role).length < THIN_WORDS || words(b.role).length < THIN_WORDS) continue
      if (overlap(vocab.get(a.id) as Set<string>, vocab.get(b.id) as Set<string>) < SAME_JOB_OVERLAP) continue
      add({
        rule: 'same-job', severity: 'improve', agentId: b.id, agentIds: [a.id, b.id],
        title: `${a.name} and ${b.name} have the same job`,
        why: 'Two agents told the same thing do the same work twice. Give each its own part of the request, or remove one.',
        askPrompt: `${a.name} and ${b.name} in this team have nearly the same instructions. Give each a distinct part of the work and rewrite both agents' instructions to match.`,
      })
    }
  }

  return findings.sort(bySeverity)
}

/**
 * The things an agent's instructions say, in the order the built-in jobs say them: its job, how to
 * work, how it checks its work before replying, and what it replies with (ADR 0030, ADR 0062).
 */
export type InstructionPart = 'job' | 'method' | 'check' | 'reply'

/** Every part, in that order. */
export const INSTRUCTION_PARTS: readonly InstructionPart[] = ['job', 'method', 'check', 'reply']

/** What the agent panel inserts to start a missing part; the operator writes the rest. */
export const PART_STARTERS: Record<Exclude<InstructionPart, 'job'>, string> = {
  method: 'How to work:\n- ',
  check: 'Before you reply, check ',
  reply: 'Reply with ',
}

/** Says how to work: a list of steps, or rules about the work. */
const METHOD = /^\s*([-*•]|\d+[.)])\s+\S|\b(always|never|prefer|make sure|do not|don['’]t|avoid|only use|check|first|before you)\b/im
/**
 * Says how it checks its own work before it replies. A concrete check (re-open a source, run the
 * tests, recount) is what makes an agent catch its own mistakes; the giveaway words are the moment
 * ("before you reply") or the act ("verify", "run the tests").
 */
const CHECK = /\bbefore (you|it) (reply|replies|answer|answers|finish|finishes|respond|hand|send|return|deliver)\b|\b(verify|verifies|double-check|re-?check)\b|\bcheck (your|each|every|that|it|the (result|work|piece|answer|output|numbers|links|sources))\b|\brun (the |its |your )?(project['’]s )?(tests?|build)\b/i

/**
 * Which of the three parts these instructions cover. A part the panel just started and the operator
 * has not written yet ("Reply with " at the end) does not count.
 */
export function instructionShape(role: string): Record<InstructionPart, boolean> {
  let text = role.trimEnd()
  for (const starter of Object.values(PART_STARTERS)) {
    if (text.endsWith(starter.trimEnd())) text = text.slice(0, -starter.trimEnd().length).trimEnd()
  }
  const firstSentence = text.trim().split(/(?<=[.!?])\s+|\n/)[0] ?? ''
  return { job: words(firstSentence).length >= 5 || words(text).length >= THIN_WORDS, method: METHOD.test(text.replace(BEFORE_REPLYING, '')), check: CHECK.test(text), reply: saysWhatItReplies(text) }
}

/** The text an `append-role` fix leaves: the role, a blank line, the addition. */
export function appendToRole(role: string, text: string): string {
  const trimmed = role.trimEnd()
  return trimmed ? `${trimmed}\n\n${text}` : text
}

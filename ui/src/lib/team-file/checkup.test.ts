import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL, type ModelTier } from '../ai/modelIds'
import { CHECKER_ROLE } from '../library/checker'
import { modelForPreset, ROLE_PRESETS } from '../library/roles'
import { appendToRole, checkup, fixFields, jobFor, LONG_WORDS, type CheckupFinding, type CheckupInput } from './checkup'
import { templateTeamYaml } from './templates'
import type { AgentConfig, TeamDocument } from './types'

const preset = (id: string) => ROLE_PRESETS.find((candidate) => candidate.id === id)?.role ?? ''

/** An agent as the palette places it: a built-in job's instructions come with its switches and its model. */
function agent(id: string, role: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  const job = ROLE_PRESETS.find((candidate) => candidate.role === role)
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1), role, model: job ? modelForPreset(job).model : DEFAULT_MODEL, ...(job?.allow ? { allow: job.allow } : {}), ...extra }
}

function run(input: Partial<CheckupInput> & Pick<CheckupInput, 'agents'>) {
  const entrypoint = input.entrypoint ?? input.agents[0]?.id ?? null
  const edges = input.edges ?? []
  const responder = input.responder ?? (edges.length === 0 ? entrypoint : edges.find((edge) => !edges.some((other) => other.from === edge.to))?.to ?? null)
  return checkup({ ...input, entrypoint, edges, responder })
}

const rules = (findings: ReturnType<typeof checkup>) => findings.map((finding) => `${finding.rule}:${finding.agentIds.join('+')}`)

describe('checkup', () => {
  it('finds nothing to improve in the starter teams', () => {
    for (const template of ['single', 'research-write', 'research-write-check', 'research-review-write', 'research'] as const) {
      const doc = parse(templateTeamYaml(template, 'Starter')) as TeamDocument
      const edges = doc.edges.map((edge) => ({ from: edge.from, to: edge.to }))
      // A pipeline that ends on a check step answers with the work it checks (answeringAgent).
      const terminal = edges.length ? edges.find((edge) => !edges.some((other) => other.from === edge.to))?.to ?? null : doc.entrypoint
      const responder = doc.agents.find((agent) => agent.id === terminal)?.checks ?? terminal
      expect(rules(run({ agents: doc.agents, edges, entrypoint: doc.entrypoint, responder })), template).toEqual([])
    }
  })

  // No built-in job is on the fast tier while quality comes first (schemas/model-tiers.json). The
  // rule is for when the table moves one there, so these move the Researcher there meanwhile.
  const onTheFastTier = (check: () => void) => () => {
    const job = ROLE_PRESETS.find((candidate) => candidate.id === 'researcher') as { tier?: ModelTier }
    const tier = job.tier
    job.tier = 'fast'
    try {
      check()
    } finally {
      job.tier = tier
    }
  }

  it('leaves a gatherer on the strong model alone while its job is on the strong tier', () => {
    const edges = [{ from: 'researcher', to: 'writer' }]
    const agents = [agent('researcher', preset('researcher'), { model: DEFAULT_MODEL }), agent('writer', preset('writer'))]
    expect(rules(run({ agents, edges }))).toEqual([])
  })

  it('suggests the faster model for a gatherer on the strong one, with its share of the team’s tokens', onTheFastTier(() => {
    const team = (model: string, extra: Partial<AgentConfig> = {}) => [agent('researcher', preset('researcher'), { model, ...extra }), agent('writer', preset('writer'), { model: DEFAULT_MODEL })]
    const edges = [{ from: 'researcher', to: 'writer' }]
    const usage = { runs: 3, perRun: 90_000, agents: [{ id: 'writer', name: 'Writer', perRun: 53_000, share: 0.59, opening: null }, { id: 'researcher', name: 'Researcher', perRun: 37_000, share: 0.41, opening: null }] }
    const [finding, ...others] = run({ agents: team(DEFAULT_MODEL), edges, usage })
    expect(others).toEqual([])
    expect(finding).toMatchObject({
      rule: 'strong-gatherer', severity: 'improve', agentId: 'researcher', title: 'Researcher could gather on Claude Sonnet 5.5',
      fix: { label: 'Use Claude Sonnet 5.5', change: { kind: 'model', agentId: 'researcher', model: FAST_MODEL, thinkingEffort: 'medium' } },
    })
    expect(finding.why).toBe('It collects facts for Writer to write up. A faster model does that well, for less, and leaves Claude Opus 5.5 for the step that writes the answer. In the last 3 runs it used 41% of the team’s tokens.')
    // Before any run it says so without a figure: facts from runs only.
    expect(run({ agents: team(DEFAULT_MODEL), edges })[0].why).not.toContain('%')
    // A name an AI app's team file used reads as the model it maps to.
    expect(run({ agents: team('opus'), edges })[0]).toMatchObject({ rule: 'strong-gatherer' })
    // The model list's own names, once it has arrived.
    expect(run({ agents: team(DEFAULT_MODEL), edges, modelNames: new Map([[FAST_MODEL, 'Sonnet 5.5']]) })[0].title).toBe('Researcher could gather on Sonnet 5.5')
  }))

  it('leaves alone a gatherer whose reply is the answer, one already faster, and one on a model chosen on purpose', onTheFastTier(() => {
    const researcher = agent('researcher', preset('researcher'))
    expect(run({ agents: [researcher] })).toEqual([])
    const writer = agent('writer', preset('writer'))
    const edges = [{ from: 'researcher', to: 'writer' }]
    expect(run({ agents: [{ ...researcher, model: FAST_MODEL }, writer], edges })).toEqual([])
    expect(run({ agents: [{ ...researcher, model: 'anthropic/claude-haiku-5.5' }, writer], edges })).toEqual([])
    expect(run({ agents: [{ ...researcher, model: 'openai/gpt-6.1-sol' }, writer], edges })).toEqual([])
  }))

  it('stays silent on every built-in job as the canvas places it', () => {
    const placed = ROLE_PRESETS.map((job) => agent(job.id, job.role, { ...modelForPreset(job) }))
    const edges = placed.filter((one) => one.id !== 'researcher').map((one) => ({ from: 'researcher', to: one.id }))
    for (const responder of placed.filter((one) => one.id !== 'researcher').map((one) => one.id)) {
      const findings = checkup({ agents: placed, edges, entrypoint: 'researcher', responder })
      expect(findings.filter((finding) => finding.rule === 'strong-gatherer').map((finding) => finding.id), responder).toEqual([])
    }
  })

  it('says when instructions are too short to go on, and offers a job that matches the name', () => {
    const [finding] = run({ agents: [agent('writer', 'Write a blog post.')] })
    expect(finding.rule).toBe('thin-instructions')
    expect(finding.fix).toEqual({ label: 'Use the Writer job\'s instructions', change: { kind: 'replace-role', agentId: 'writer', text: preset('writer') } })
    expect(run({ agents: [agent('helper', 'Do the thing.')] })[0].fix).toBeUndefined()
  })

  it('offers to allow what the instructions need, and calls it a stall on a schedule', () => {
    const coder = agent('coder', preset('coder'))
    expect(rules(run({ agents: [coder] }))).toEqual(['needs-edits:coder', 'needs-commands:coder'])
    const [web] = run({ agents: [agent('scout', 'Search the web for this week’s AI news and reply with five bullet points, each with a link.')] })
    expect(web).toMatchObject({ rule: 'needs-web', severity: 'improve', fix: { change: { kind: 'allow', agentId: 'scout', key: 'web' } } })
    expect(run({ agents: [agent('scout', 'Search the web for this week’s AI news and reply with five bullet points, each with a link.')], scheduled: true })[0]).toMatchObject({ rule: 'needs-web', severity: 'fix', title: 'Scout can\'t search the web when the team runs on schedule' })
    expect(run({ agents: [{ ...coder, allow: { edits: true, commands: true } }] })).toEqual([])
  })

  it('does not read a prohibition as a need', () => {
    const asked = (role: string) => rules(run({ agents: [agent('gatherer', `${role} Reply with one bullet per story, each with its link.`, { allow: { web: true } })], scheduled: true }))
    // The bundled daily digest's Gatherer (examples/usecases/daily-tech-digest.yaml).
    expect(asked('Find and read pages with web search only. Commands are off for this team, so don\'t run curl or any other command.')).toEqual([])
    for (const forbidden of [
      'Do not run any command.',
      'Never run scripts or open a shell.',
      'Don\'t edit files or run commands.',
      'Read pages without a terminal.',
      'There is no need to run the tests.',
      'Use web search instead of the shell.',
      'The terminal is off for this team.',
      'Do not change any files in this folder.',
    ]) expect(asked(forbidden), forbidden).toEqual([])
    for (const [needed, rule] of [
      ['Run curl to fetch the feed with a command.', 'needs-commands'],
      ['Run the tests before you reply.', 'needs-commands'],
      ['Don\'t forget to run the tests.', 'needs-commands'],
      ['Don\'t just read the code, run the tests.', 'needs-commands'],
      ['Never install packages, run the tests.', 'needs-commands'],
      ['Commands are off for this team. Run the build anyway.', 'needs-commands'],
      ['Don\'t reply before you run the linter.', 'needs-commands'],
      ['Save the digest to a file.', 'needs-edits'],
    ] as const) expect(asked(needed), needed).toEqual([`${rule}:gatherer`])
    // A condition plans for a missing switch; the web is still what it works from.
    expect(rules(run({ agents: [agent('scout', 'If you can\'t browse the web, say so in your first line. Reply with five links, each with its date.')] }))).toEqual(['needs-web:scout'])
  })

  it('has nothing to fix in the bundled use cases, on their own schedule', () => {
    // A finding to fix turns Build's heading from "Your team is ready" to "Almost ready".
    const usecases = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples/usecases')
    const files = readdirSync(usecases).filter((name) => name.endsWith('.yaml'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const doc = parse(readFileSync(path.join(usecases, file), 'utf8')) as TeamDocument
      const scheduled = Boolean(doc.schedule && doc.schedule.enabled !== false)
      const findings = run({ agents: doc.agents, edges: doc.edges.map((edge) => ({ from: edge.from, to: edge.to })), entrypoint: doc.entrypoint, responder: doc.responder, scheduled })
      expect(findings.filter((finding) => finding.severity === 'fix').map((finding) => finding.title), file).toEqual([])
    }
  })

  it('asks the team’s answer for a format, and a helper for what it sends back', () => {
    const vague = 'You summarize customer emails for the support lead, highlighting churn risks and the urgent issues first.'
    expect(rules(run({ agents: [agent('summarizer', vague)] }))).toEqual(['no-hand-back:summarizer'])
    const team = run({ agents: [agent('lead', `${preset('writer')} Hand parts to your teammates.`), agent('helper', vague)] })
    expect(team.find((finding) => finding.rule === 'no-hand-back')).toMatchObject({ agentId: 'helper', title: 'Say what Helper sends back to Lead' })
  })

  it('tells a lead when to use its teammates, naming each one’s job', () => {
    const findings = run({ agents: [agent('researcher', preset('researcher')), agent('writer', preset('writer'))] })
    expect(rules(findings)).toEqual(['lead-delegation:researcher'])
    const fix = findings[0].fix?.change
    expect(fix?.kind === 'append-role' && fix.text).toBe('When the request is bigger than one step, hand parts of it to your teammates, Writer, each the part that matches its job, then combine what they send into your answer.')
    // Naming a teammate is telling it when to use them.
    expect(run({ agents: [agent('lead', `${preset('researcher')} Pass the facts to Writer.`, { allow: { web: true } }), agent('writer', preset('writer'))] })).toEqual([])
  })

  it('warns when the last step judges the work instead of delivering it', () => {
    const findings = run({ agents: [agent('writer', preset('writer')), agent('reviewer', preset('reviewer'))], edges: [{ from: 'writer', to: 'reviewer' }] })
    expect(rules(findings)).toEqual(['final-is-review:reviewer'])
  })

  it('asks a later step to build on the handover it receives', () => {
    const findings = run({ agents: [agent('researcher', preset('researcher')), agent('coder', preset('coder'), { allow: { edits: true, commands: true } })], edges: [{ from: 'researcher', to: 'coder' }] })
    expect(rules(findings)).toEqual(['handoff-unused:coder'])
    // A review stop is you, not work to build on.
    const afterReview = run({ agents: [agent('researcher', preset('researcher')), { id: 'review', name: 'You', role: 'Approve it.', kind: 'operator' }, agent('coder', preset('coder'), { allow: { edits: true, commands: true } })], edges: [{ from: 'researcher', to: 'review' }, { from: 'review', to: 'coder' }] })
    expect(rules(afterReview)).toEqual([])
  })

  it('asks for plain case when instructions shout, and the fix clears it without opening another', () => {
    const shouting = `${preset('writer')}\n\nIMPORTANT: you MUST cite the API docs. NEVER guess a version number.\n- ALWAYS keep the PDF link.`
    const [finding] = run({ agents: [agent('writer', shouting)] })
    expect(finding).toMatchObject({ rule: 'shouting', severity: 'improve', fix: { label: 'Write them in plain case' } })
    const fixed = finding.fix?.change.kind === 'replace-role' ? finding.fix.change.text : ''
    expect(fixed).toContain('Important: you must cite the API docs. Never guess a version number.\n- Always keep the PDF link.')
    expect(run({ agents: [agent('writer', fixed)] })).toEqual([])
    // One capital word is a habit, and an acronym is not shouting.
    expect(run({ agents: [agent('writer', `${preset('writer')}\nCite the API and PDF docs, NOT blog posts.`)] })).toEqual([])
  })

  it('suggests high effort for an agent that thinks at max on every run, and the fix clears it', () => {
    const [finding] = run({ agents: [agent('writer', preset('writer'), { thinkingEffort: 'max' })] })
    expect(finding).toMatchObject({ rule: 'overthinking', fix: { label: 'Use high effort', change: { kind: 'effort', agentId: 'writer', value: 'high' } } })
    expect(run({ agents: [agent('writer', preset('writer'), { thinkingEffort: 'high' })] })).toEqual([])
    expect(run({ agents: [agent('writer', preset('writer'))] })).toEqual([])
  })

  it('never calls two different built-in jobs the same job', () => {
    const team = ROLE_PRESETS.map((job) => agent(job.id, job.role))
    expect(run({ agents: team }).filter((finding) => finding.rule === 'same-job')).toEqual([])
  })

  it('finds two agents told the same thing', () => {
    const findings = run({ agents: [agent('researcher', preset('researcher')), agent('scout', preset('researcher'), { allow: { web: true } }), agent('writer', `${preset('writer')}`)], edges: [{ from: 'researcher', to: 'writer' }, { from: 'scout', to: 'writer' }], entrypoint: 'researcher' })
    expect(rules(findings)).toContain('same-job:researcher+scout')
  })

  it('puts what will go wrong before what could be better', () => {
    const scout = agent('scout', 'Search the web for this week’s AI news and reply with five bullet points, each with a link.')
    const findings = run({ agents: [agent('lead', preset('writer')), scout], scheduled: true })
    expect(findings.map((finding) => `${finding.severity}:${finding.rule}`)).toEqual(['fix:needs-web', 'improve:lead-delegation'])
  })
})

/** What the canvas does with a fix (useTeamCheckup), on plain agents. */
function applyFix(agents: readonly AgentConfig[], finding: CheckupFinding): AgentConfig[] {
  const change = finding.fix?.change
  return agents.map((one) => {
    if (!change || one.id !== change.agentId) return one
    if (change.kind === 'allow') return { ...one, allow: { ...one.allow, [change.key]: true } }
    if (change.kind === 'append-role') return { ...one, role: appendToRole(one.role, change.text) }
    if (change.kind === 'effort') return { ...one, thinkingEffort: change.value }
    // The fixes that are field edits go through the same mapping the canvas applies them with.
    const fields = fixFields(change)
    if (fields) return { ...one, ...fields }
    if (change.kind === 'replace-role') return { ...one, role: change.text, ...(change.allow ? { allow: { ...one.allow, ...change.allow } } : {}) }
    return one
  })
}

describe('checkup fixes', () => {
  // A fix that leaves its own finding standing reads as a broken button.
  it('clears the finding it was offered for', () => {
    const vague = 'You summarize customer emails for the support lead, highlighting churn risks and the urgent issues first.'
    const scenarios: Partial<CheckupInput>[] = [
      { agents: [agent('writer', 'Write a blog post.')] },
      { agents: [agent('researcher', 'Research the market.')] },
      { agents: [agent('coder', preset('coder'))], scheduled: true },
      { agents: [agent('summarizer', vague)] },
      { agents: [agent('lead', `${preset('writer')} Hand parts to your teammates.`), agent('helper', vague)] },
      { agents: [agent('researcher', preset('researcher')), agent('writer', preset('writer'))] },
      // A teammate whose instructions name the web must not make the lead look like it needs it.
      { agents: [agent('lead', 'You plan product launches. Reply with the plan as a checklist grouped by week.'), agent('scout', 'Look at competitors’ recent launches on the web and reply with what worked, with links.', { allow: { web: true } })] },
      { agents: [agent('writer', preset('writer')), agent('reviewer', preset('reviewer'))], edges: [{ from: 'writer', to: 'reviewer' }] },
      { agents: [agent('researcher', preset('researcher')), agent('coder', preset('coder'), { allow: { edits: true, commands: true } })], edges: [{ from: 'researcher', to: 'coder' }] },
      { agents: [agent('writer', `${preset('writer')}\nIMPORTANT: NEVER skip a source.`, { thinkingEffort: 'max' })] },
      // A gatherer on the strong model, thinking at the top setting.
      { agents: [agent('researcher', preset('researcher'), { model: DEFAULT_MODEL, thinkingEffort: 'max' }), agent('writer', preset('writer'))], edges: [{ from: 'researcher', to: 'writer' }] },
      // A check step on the writer's model, on a writer with no Done when, that sends nothing back.
      { agents: [agent('writer', preset('writer')), agent('checker', CHECKER_ROLE, { model: DEFAULT_MODEL, checks: 'writer' })], edges: [{ from: 'writer', to: 'checker' }], responder: 'writer' },
    ]
    let fixed = 0
    for (const scenario of scenarios) {
      const before = run(scenario as CheckupInput)
      for (const finding of before.filter((candidate) => candidate.fix)) {
        const after = run({ ...scenario, agents: applyFix(scenario.agents ?? [], finding) } as CheckupInput)
        expect(after.map((candidate) => candidate.id), finding.id).not.toContain(finding.id)
        // …nor open a new one: a fix that leads straight to the next suggestion is half a fix.
        const added = after.filter((candidate) => !before.some((earlier) => earlier.id === candidate.id))
        expect(added.map((candidate) => candidate.id), finding.id).toEqual([])
        fixed += 1
      }
    }
    expect(fixed).toBeGreaterThanOrEqual(8)
  })
})

// ADR 0062: a check step pays for a whole extra session, so it should be one that can find a
// problem and get it fixed.
describe('check steps', () => {
  const edges = [{ from: 'writer', to: 'checker' }]
  const team = (writer: Partial<AgentConfig>, checker: Partial<AgentConfig>) => [
    agent('writer', preset('writer'), { doneWhen: ['Every claim has a link'], ...writer }),
    agent('checker', CHECKER_ROLE, { checks: 'writer', sendBackOnce: true, model: CHECK_MODEL, ...checker }),
  ]
  const checks = (agents: AgentConfig[]) => run({ agents, edges, responder: 'writer' }).filter((finding) => finding.rule.startsWith('check-'))

  it('finds nothing to say about a check step set up as the template sets one up', () => {
    expect(checks(team({}, {}))).toEqual([])
  })

  it('suggests another maker’s model for a check on the model that wrote the work', () => {
    const [finding] = checks(team({ model: DEFAULT_MODEL }, { model: DEFAULT_MODEL, thinkingEffort: 'medium' }))
    expect(finding).toMatchObject({ rule: 'check-same-model', agentId: 'checker', agentIds: ['checker', 'writer'], fix: { change: { kind: 'model', agentId: 'checker', model: CHECK_MODEL, thinkingEffort: 'medium' } } })
    // Work written on the check model is checked on the default one.
    expect(checks(team({ model: CHECK_MODEL }, { model: CHECK_MODEL }))[0]).toMatchObject({ fix: { change: { model: DEFAULT_MODEL } } })
  })

  it('offers the job’s Done when to a checked agent that has none, and Ask for one that is no job', () => {
    expect(checks(team({ doneWhen: undefined }, {}))).toEqual([expect.objectContaining({ rule: 'check-no-done-when', agentId: 'writer', fix: { label: 'Use the Writer job’s Done when', change: { kind: 'done-when', agentId: 'writer', items: ROLE_PRESETS.find((job) => job.id === 'writer')?.doneWhen } } })])
    const [custom] = checks(team({ name: 'Summary', role: 'Sum up the emails in three lines.', doneWhen: undefined }, {}))
    expect(custom).toMatchObject({ rule: 'check-no-done-when', title: 'Checker has nothing to check Summary’s work against' })
    expect(custom.fix).toBeUndefined()
    expect(custom.askPrompt).toContain('as its Done when')
  })

  it('says a check that sends nothing back changes nothing, and turns it on as a new check step has it', () => {
    expect(checks(team({}, { sendBackOnce: undefined }))).toEqual([expect.objectContaining({ rule: 'check-no-send-back', agentId: 'checker', title: 'What Checker finds is never fixed', fix: { label: 'Send it back up to 2 times', change: { kind: 'send-back', agentId: 'checker' } } })])
    // Either form of send-back counts: the older `sendBackOnce` and `sendBack`.
    expect(checks(team({}, { sendBackOnce: undefined, sendBack: { rounds: 1 } }))).toEqual([])
    // The fix writes `sendBack` and takes the older field out.
    expect(fixFields({ kind: 'send-back', agentId: 'checker' })).toEqual({ sendBack: { rounds: 2, whenStillNotMet: 'ask' }, sendBackOnce: undefined })
  })
})

describe('checkup helpers', () => {
  it('matches a job by name first, then by instructions', () => {
    expect(jobFor({ name: 'Code reviewer', role: '' })?.id).toBe('reviewer')
    expect(jobFor({ name: 'Ada', role: 'Analyse the sales data' })?.id).toBe('analyst')
    expect(jobFor({ name: 'Ada', role: 'Be nice' })).toBeNull()
    // A research lead leads; it is not a researcher on the faster model.
    expect(jobFor({ name: 'Research lead', role: '' })?.id).toBe('lead')
    expect(jobFor({ name: 'Lead researcher', role: '' })?.id).toBe('lead')
  })

  it('appends after a blank line', () => {
    expect(appendToRole('Do it.  \n', 'Reply briefly.')).toBe('Do it.\n\nReply briefly.')
    expect(appendToRole('', 'Reply briefly.')).toBe('Reply briefly.')
  })
})

describe('large-team', () => {
  it('asks whether five agents could be fewer, once, on the lead', () => {
    const roles = ROLE_PRESETS.slice(0, 5).map((job) => agent(job.id, job.role))
    const findings = checkup({ agents: roles, edges: [], entrypoint: roles[0].id, responder: roles[0].id })
    expect(findings.filter((finding) => finding.rule === 'large-team')).toEqual([expect.objectContaining({ agentIds: [roles[0].id], title: '5 agents is a large team' })])
    expect(checkup({ agents: roles.slice(0, 4), edges: [], entrypoint: roles[0].id, responder: roles[0].id }).some((finding) => finding.rule === 'large-team')).toBe(false)
  })
})

describe('long-instructions', () => {
  const ROLE = 'You summarize customer emails for the support lead. Reply with the three most urgent issues, one line each.'

  it('says when instructions run long, and leaves the cutting to Ask LoomWatch', () => {
    const long = `${ROLE} ${'Background the agent could look up itself. '.repeat(Math.ceil(LONG_WORDS / 7))}`
    const finding = run({ agents: [agent('summarizer', long)] }).find((candidate) => candidate.rule === 'long-instructions')
    expect(finding?.fix).toBeUndefined()
    expect(finding?.askPrompt).toContain('under 300 words')
    expect(run({ agents: [agent('summarizer', ROLE)] }).some((candidate) => candidate.rule === 'long-instructions')).toBe(false)
  })

  it('finds no built-in job long', () => {
    for (const job of ROLE_PRESETS) expect(run({ agents: [agent(job.id, job.role)] }).some((candidate) => candidate.rule === 'long-instructions'), job.id).toBe(false)
  })
})

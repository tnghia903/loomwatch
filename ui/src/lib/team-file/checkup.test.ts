import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import type { DetectedHarness } from '../harnesses'
import { modelForRole } from '../library/jobModel'
import { ROLE_PRESETS } from '../library/roles'
import claude from '../models/fixtures/claude.json'
import { claudeOn } from '../models/fixtures/claudeOn'
import codex from '../models/fixtures/codex.json'
import hermes from '../models/fixtures/hermes.json'
import opencode from '../models/fixtures/opencode.json'
import type { ModelCatalog } from '../models/tiers'
import { appendToRole, canUseTeamBus, checkup, jobFor, LONG_WORDS, type CheckupFinding, type CheckupInput } from './checkup'
import { templateTeamYaml } from './templates'
import type { AgentConfig, TeamDocument } from './types'

const CLAUDE = { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' }
const preset = (id: string) => ROLE_PRESETS.find((candidate) => candidate.id === id)?.role ?? ''

/** An agent as the palette places it: a built-in job's instructions come with its switches. */
function agent(id: string, role: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  const allow = ROLE_PRESETS.find((candidate) => candidate.role === role)?.allow
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1), role, spawn: CLAUDE, model: 'm', ...(allow ? { allow } : {}), ...extra }
}

function run(input: Partial<CheckupInput> & Pick<CheckupInput, 'agents'>) {
  const entrypoint = input.entrypoint ?? input.agents[0]?.id ?? null
  const edges = input.edges ?? []
  const responder = input.responder ?? (edges.length === 0 ? entrypoint : edges.find((edge) => !edges.some((other) => other.from === edge.to))?.to ?? null)
  return checkup({ ...input, entrypoint, edges, responder })
}

const rules = (findings: ReturnType<typeof checkup>) => findings.map((finding) => `${finding.rule}:${finding.agentIds.join('+')}`)

// As the apps listed their models on 2026-10-15 (lib/models/fixtures).
const CATALOGS: Record<string, ModelCatalog> = { claude, codex, opencode, hermes }

describe('checkup', () => {
  it('finds nothing to improve in the starter teams, on every app’s own model list', () => {
    const harness = { id: 'claude', name: 'Claude', command: 'claude', executablePath: '/x', spawn: { cmd: 'claude-agent-acp', args: [] } } as DetectedHarness
    for (const template of ['single', 'research-write', 'research-write-check', 'research-review-write'] as const) {
      const doc = parse(templateTeamYaml(template, 'Starter', harness, 'm')) as TeamDocument
      const edges = doc.edges.map((edge) => ({ from: edge.from, to: edge.to }))
      // A pipeline that ends on a check step answers with the work it checks (answeringAgent).
      const terminal = edges.length ? edges.find((edge) => !edges.some((other) => other.from === edge.to))?.to ?? null : doc.entrypoint
      const responder = doc.agents.find((agent) => agent.id === terminal)?.checks ?? terminal
      expect(rules(run({ agents: doc.agents, edges, entrypoint: doc.entrypoint, responder })), template).toEqual([])
      for (const [app, catalog] of Object.entries(CATALOGS)) {
        const tiered = parse(templateTeamYaml(template, 'Starter', harness, catalog.currentModelId ?? '', undefined, undefined, catalog)) as TeamDocument
        expect(rules(run({ agents: tiered.agents, edges, entrypoint: tiered.entrypoint, responder, catalogFor: () => catalog })), `${template} on ${app}`).toEqual([])
      }
    }
  })

  it('suggests the fast tier for a gatherer on the strong one, with its share of the team’s tokens', () => {
    const team = (model: string, extra: Partial<AgentConfig> = {}) => [agent('researcher', preset('researcher'), { model, ...extra }), agent('writer', preset('writer'), { model })]
    const edges = [{ from: 'researcher', to: 'writer' }]
    const usage = { runs: 3, perRun: 90_000, agents: [{ id: 'writer', name: 'Writer', perRun: 53_000, share: 0.59, opening: null }, { id: 'researcher', name: 'Researcher', perRun: 37_000, share: 0.41, opening: null }] }
    const [finding, ...others] = run({ agents: team('sonnet'), edges, catalogFor: () => claude, usage })
    expect(others).toEqual([])
    expect(finding).toMatchObject({
      rule: 'strong-gatherer', severity: 'improve', agentId: 'researcher', title: 'Researcher could gather on Haiku 4.5',
      fix: { label: 'Use Haiku 4.5', change: { kind: 'model', agentId: 'researcher', model: 'haiku' } },
    })
    expect(finding.why).toBe('It collects facts for Writer to write up. A faster model does that well, and leaves Sonnet 5.5 for the step that writes the answer. In the last 3 runs it used 41% of the team’s tokens.')
    // Before any run it says so without a figure: facts from runs only.
    expect(run({ agents: team('sonnet'), edges, catalogFor: () => claude })[0].why).not.toContain('%')

    // Codex lists no mini; it calls one model fast and affordable.
    // Codex lists 6 Luna's efforts, so it gathers at the Researcher's.
    expect(run({ agents: team('gpt-6.1-sol'), edges, catalogFor: () => codex })[0].fix?.change).toEqual({ kind: 'model', agentId: 'researcher', model: 'gpt-6-luna', thinkingEffort: 'medium' })
    // Where the current model is already the smallest, the fast tier is less thinking.
    const luna = { ...codex, currentModelId: 'gpt-6-luna', currentThinkingEffort: 'high' }
    expect(run({ agents: team('gpt-6-luna'), edges, catalogFor: () => luna })[0]).toMatchObject({ title: 'Researcher could gather at medium effort', fix: { label: 'Use medium effort', change: { kind: 'model', model: 'gpt-6-luna', thinkingEffort: 'medium' } } })
    expect(run({ agents: team('gpt-6-luna', { thinkingEffort: 'low' }), edges, catalogFor: () => luna })).toEqual([])
    // Haiku 4.5 has no effort to lower, and nothing is faster.
    expect(run({ agents: team('haiku'), edges, catalogFor: () => claudeOn('haiku') })).toEqual([])
  })

  it('leaves alone a gatherer whose reply is the answer, one it cannot judge, and one with nothing faster', () => {
    const researcher = agent('researcher', preset('researcher'), { model: 'sonnet' })
    expect(run({ agents: [researcher], catalogFor: () => claude })).toEqual([])
    expect(run({ agents: [researcher, agent('writer', preset('writer'), { model: 'sonnet' })], edges: [{ from: 'researcher', to: 'writer' }] })).toEqual([])
    const pickle = [agent('researcher', preset('researcher'), { model: 'opencode/big-pickle' }), agent('writer', preset('writer'), { model: 'opencode/big-pickle' })]
    expect(run({ agents: pickle, edges: [{ from: 'researcher', to: 'writer' }], catalogFor: () => opencode })).toEqual([])
    // The writer on the strong tier is where it belongs.
    expect(run({ agents: [agent('researcher', preset('researcher'), { model: 'haiku' }), agent('writer', preset('writer'), { model: 'sonnet' })], edges: [{ from: 'researcher', to: 'writer' }], catalogFor: () => claude })).toEqual([])
  })

  it('stays silent on every built-in job as the canvas places it, on every app', () => {
    for (const [app, catalog] of Object.entries(CATALOGS)) {
      const placed = ROLE_PRESETS.map((job) => agent(job.id, job.role, { ...modelForRole(job.role, catalog) }))
      const edges = placed.filter((one) => one.id !== 'researcher').map((one) => ({ from: 'researcher', to: one.id }))
      for (const responder of placed.filter((one) => one.id !== 'researcher').map((one) => one.id)) {
        const findings = checkup({ agents: placed, edges, entrypoint: 'researcher', responder, catalogFor: () => catalog })
        expect(findings.filter((finding) => finding.rule === 'strong-gatherer').map((finding) => finding.id), `${app} → ${responder}`).toEqual([])
      }
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
    // OpenCode never asks, so there is nothing to allow.
    expect(run({ agents: [{ ...coder, spawn: { ...CLAUDE, cmd: 'opencode', args: ['acp'] } }] })).toEqual([])
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

  it('says a lead on an app without Team Bus can never hand work on', () => {
    const lead = agent('lead', preset('writer'), { spawn: { ...CLAUDE, cmd: 'openclaw', args: ['acp'] } })
    expect(run({ agents: [lead, agent('helper', preset('researcher'))] })[0]).toMatchObject({ rule: 'lead-cannot-delegate', severity: 'fix' })
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
    const lead = agent('lead', 'Plan it.', { spawn: { ...CLAUDE, cmd: 'openclaw', args: ['acp'] } })
    const findings = run({ agents: [lead, agent('writer', preset('writer'))] })
    expect(findings.map((finding) => `${finding.severity}:${finding.rule}`)).toEqual(['fix:lead-cannot-delegate', 'improve:thin-instructions'])
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
    if (change.kind === 'model') return { ...one, model: change.model, thinkingEffort: change.thinkingEffort }
    return { ...one, role: change.text, ...(change.allow ? { allow: { ...one.allow, ...change.allow } } : {}) }
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
      // A gatherer on the strong tier: a faster model, or the same model thinking less, by app.
      ...Object.values(CATALOGS).map((catalog) => ({
        agents: [agent('researcher', preset('researcher'), { model: catalog.currentModelId, thinkingEffort: 'max' }), agent('writer', preset('writer'), { model: catalog.currentModelId })],
        edges: [{ from: 'researcher', to: 'writer' }],
        catalogFor: () => catalog,
      })),
      { agents: [agent('researcher', preset('researcher'), { model: 'haiku' }), agent('writer', preset('writer'), { model: 'haiku' })], edges: [{ from: 'researcher', to: 'writer' }], catalogFor: () => ({ ...claude, currentModelId: 'haiku' }) },
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

describe('checkup helpers', () => {
  it('reads Team Bus support off the spawn the way the daemon does', () => {
    expect(canUseTeamBus({ spawn: { cmd: 'codex-acp', args: [], env: {}, cwd: '.' } })).toBe(true)
    expect(canUseTeamBus({ spawn: { cmd: 'loomwatchd', args: ['harness-client', '--harness', 'opencode'], env: {}, cwd: '.' } })).toBe(true)
    expect(canUseTeamBus({ spawn: { cmd: 'openclaw', args: ['acp'], env: {}, cwd: '.' } })).toBe(false)
    expect(canUseTeamBus({ spawn: { cmd: 'my-agent', args: [], env: {}, cwd: '.' } })).toBe(false)
  })

  it('matches a job by name first, then by instructions', () => {
    expect(jobFor({ name: 'Code reviewer', role: '' })?.id).toBe('reviewer')
    expect(jobFor({ name: 'Ada', role: 'Analyse the sales data' })?.id).toBe('analyst')
    expect(jobFor({ name: 'Ada', role: 'Be nice' })).toBeNull()
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

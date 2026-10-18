import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL } from '../ai/modelIds'
import { agentsTeamYaml, TEAM_TEMPLATES, templateTeamYaml, uniqueTeamPath } from './templates'
import type { TeamDocument } from './types'
import { teamIdForPath } from './useTeamDocument'
import { compileTeamValidator } from './validation'

// The real schema the daemon serves, so a template can never drift into a file the daemon refuses.
const schema = parse(readFileSync(resolve(process.cwd(), '../schemas/team.schema.yaml'), 'utf8')) as object
const validate = compileTeamValidator(schema, Ajv2020)

describe('team templates', () => {
  it.each(['single', 'research-write', 'research-write-check', 'research-review-write', 'research'] as const)('writes a complete, schema-valid team for %s', (template) => {
    const yaml = templateTeamYaml(template, '  Blog writer ', new Date('2026-10-01T00:00:00Z'))
    const doc = parse(yaml) as TeamDocument
    const result = validate(doc)
    expect(result.documentProblems).toEqual([])
    expect(result.valid).toBe(true)
    expect(doc).toMatchObject({ id: 'blog-writer', name: 'Blog writer', entrypoint: doc.agents[0].id })
    // A run spends real money: a new team may spend $1.00 a run until you change it (ADR 0068).
    expect(doc.spend).toEqual({ perRun: 1 })
    for (const agent of doc.agents.filter((candidate) => candidate.kind !== 'operator')) {
      // Every agent runs on LoomWatch's engine, in the team file's own folder.
      expect(agent).not.toHaveProperty('spawn')
      expect(agent.model).toMatch(/^[a-z-]+\/[a-z0-9.-]+$/)
      expect(agent.role.length).toBeGreaterThan(20)
    }
  })

  // A team made from Your agents is what the canvas would make placing each one: linked copies.
  it('writes a schema-valid team of My agents, each a linked copy of its saved version', () => {
    const jobs = [
      { id: 'reader', file: 'reader.yaml', name: 'Reader', instructions: 'Read every source you are given and list what each one says.', model: FAST_MODEL, skills: ['notebooklm'], allow: { web: true }, version: 3 },
      { id: 'reader-2', file: 'reader-2.yaml', name: 'Reader', instructions: 'Read the second half of the sources and list what each one says.' },
    ]
    const doc = parse(agentsTeamYaml(jobs, ' Digest ', 'digest')) as TeamDocument
    const result = validate(doc)
    expect(result.documentProblems).toEqual([])
    expect(result.valid).toBe(true)
    expect(doc).toMatchObject({ id: 'digest', name: 'Digest', entrypoint: 'reader', edges: [], spend: { perRun: 1 } })
    expect(doc.agents[0]).toMatchObject({ id: 'reader', model: FAST_MODEL, capabilities: [{ kind: 'skill', name: 'notebooklm' }], allow: { web: true }, from: { agent: 'reader', version: 3 } })
    // Two agents with one name still get their own ids.
    expect(doc.agents[1]).toMatchObject({ name: 'Reader', from: { agent: 'reader-2', version: 1 } })
    expect(doc.agents[1].id).not.toBe('reader')
    expect(() => agentsTeamYaml([], 'Nobody')).toThrow()
  })

  // ADR 0037: a researcher that cannot search the web can only guess, so it starts allowed to;
  // nothing else is switched on for anyone.
  it('lets only the researcher search the web, and nothing more', () => {
    const doc = parse(templateTeamYaml('research-review-write', 'Report')) as TeamDocument
    expect(Object.fromEntries(doc.agents.map((agent) => [agent.id, agent.allow ?? null]))).toEqual({ researcher: { web: true }, review: null, writer: null })
    const single = parse(templateTeamYaml('single', 'Solo')) as TeamDocument
    expect(single.agents[0].allow).toBeUndefined()
  })

  // The model table (ADR 0057 and 0062), quality first: the researcher and the writer on the strong
  // one, the check step reads on another maker's, and each thinks as hard as its job needs.
  it('puts each job on its tier’s model at its job’s effort', () => {
    const tiers = (template: 'single' | 'research-write' | 'research-write-check' | 'research-review-write' | 'research') => {
      const doc = parse(templateTeamYaml(template, 'Report')) as TeamDocument
      return Object.fromEntries(doc.agents.filter((agent) => agent.kind !== 'operator').map((agent) => [agent.id, `${agent.model}${agent.thinkingEffort ? `[${agent.thinkingEffort}]` : ''}`]))
    }
    expect(tiers('research-write')).toEqual({ researcher: `${DEFAULT_MODEL}[medium]`, writer: `${DEFAULT_MODEL}[medium]` })
    expect(tiers('research-review-write')).toEqual({ researcher: `${DEFAULT_MODEL}[medium]`, writer: `${DEFAULT_MODEL}[medium]` })
    expect(tiers('research-write-check')).toEqual({ researcher: `${DEFAULT_MODEL}[medium]`, writer: `${DEFAULT_MODEL}[medium]`, checker: `${CHECK_MODEL}[high]` })
    // The lead plans and judges on the strong model, and its researchers gather on it too.
    expect(tiers('research')).toEqual({ lead: `${DEFAULT_MODEL}[medium]`, researcher: `${DEFAULT_MODEL}[medium]`, writer: `${DEFAULT_MODEL}[medium]` })
    // One assistant, with no job of its own, starts as the model table's new agent: the strong
    // model at the standard effort.
    expect(tiers('single')).toEqual({ assistant: `${DEFAULT_MODEL}[medium]` })
  })

  // Open Deep Research's shape: no edges, so the lead answers, and reaches the Researcher (many
  // times over, in parallel) and the Writer through the Team Bus. It names both, so it is told
  // when to use them.
  it('leads the Research team from one agent that hands the research out and has the Writer report', () => {
    const doc = parse(templateTeamYaml('research', 'Question')) as TeamDocument
    expect(doc.entrypoint).toBe('lead')
    expect(doc.edges).toEqual([])
    expect(doc.agents.map((agent) => agent.name)).toEqual(['Research lead', 'Researcher', 'Writer'])
    const lead = doc.agents[0]
    expect(lead.role).toMatch(/`dispatch` to the Researcher, one call for each/)
    expect(lead.role).toMatch(/`ask` the Writer for the report/)
    expect(lead.role).toMatch(/numbered citation such as \[1\] after every claim/)
    expect(lead.allow).toBeUndefined()
    expect(doc.agents[1].allow).toEqual({ web: true })
  })

  // ADR 0062: the checked starter team ends on a check step that checks the writer, so the writer's
  // piece stays the answer and the daemon accepts the file as it stands.
  it('ends the checked team on a Checker that checks the writer', () => {
    const doc = parse(templateTeamYaml('research-write-check', 'Brief')) as TeamDocument
    expect(doc.agents.map((agent) => agent.id)).toEqual(['researcher', 'writer', 'checker'])
    expect(doc.agents[2]).toMatchObject({ checks: 'writer', allow: { web: true } })
    expect(doc.agents[2].sendBackOnce).toBeUndefined()
    expect(doc.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['researcher->writer', 'writer->checker'])
  })

  it('wires the review template as researcher → you → writer', () => {
    const doc = parse(templateTeamYaml('research-review-write', 'Report')) as TeamDocument
    expect(doc.agents.map((agent) => agent.kind ?? 'harness')).toEqual(['harness', 'operator', 'harness'])
    expect(doc.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['researcher->review', 'review->writer'])
  })

  it('lists templates by plain title, each starting with agents', () => {
    for (const template of TEAM_TEMPLATES) expect((parse(templateTeamYaml(template.id, 'Starter')) as TeamDocument).agents.length).toBeGreaterThan(0)
    expect(TEAM_TEMPLATES.every((template) => !/harness|entrypoint|yaml/i.test(`${template.title} ${template.description}`))).toBe(true)
  })

  it('never reuses a file name that already exists', () => {
    expect(uniqueTeamPath('Blog writer', [])).toBe('blog-writer.yaml')
    expect(uniqueTeamPath('Blog writer', ['blog-writer.yaml', 'Blog-Writer-2.yaml'])).toBe('blog-writer-3.yaml')
  })

  // The Notebook is filed by team id. Two teams named "Trip planner" got the same id and shared
  // one Notebook; the id now comes from the file, which is unique.
  it('gives a second team with the same name its own id, taken from its file', () => {
    const path = uniqueTeamPath('Trip planner', ['trip-planner.yaml'])
    expect(path).toBe('trip-planner-2.yaml')
    expect(teamIdForPath(path)).toBe('trip-planner-2')
    expect(teamIdForPath('nested/Café Plans.YML')).toBe('cafe-plans')
    const doc = parse(templateTeamYaml('single', 'Trip planner', new Date(), teamIdForPath(path))) as TeamDocument
    expect(doc.id).toBe('trip-planner-2')
    expect(doc.name).toBe('Trip planner')
    expect(validate(doc).valid).toBe(true)
  })
})

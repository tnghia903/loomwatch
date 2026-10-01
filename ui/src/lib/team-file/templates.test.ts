import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import type { DetectedHarness } from '../harnesses'
import { rankHarnesses, TEAM_TEMPLATES, templateTeamYaml, uniqueTeamPath } from './templates'
import type { TeamDocument } from './types'
import { compileTeamValidator } from './validation'

// The real schema the daemon serves, so a template can never drift into a file the daemon refuses.
const schema = parse(readFileSync(resolve(process.cwd(), '../schemas/team.schema.yaml'), 'utf8')) as object
const validate = compileTeamValidator(schema, Ajv2020)

function harness(id: string, overrides: Partial<DetectedHarness> = {}): DetectedHarness {
  return { id, name: id[0].toUpperCase() + id.slice(1), command: id, executablePath: `/bin/${id}`, acpAvailable: true, spawn: { cmd: 'npx', args: ['-y', `@acp/${id}`] }, ...overrides }
}

describe('team templates', () => {
  it.each(['single', 'research-write', 'research-review-write'] as const)('writes a complete, schema-valid team for %s', (template) => {
    const yaml = templateTeamYaml(template, '  Blog writer ', harness('claude'), 'sonnet', new Date('2026-10-01T00:00:00Z'))
    const doc = parse(yaml) as TeamDocument
    const result = validate(doc)
    expect(result.documentProblems).toEqual([])
    expect(result.valid).toBe(true)
    expect(doc).toMatchObject({ id: 'blog-writer', name: 'Blog writer', entrypoint: doc.agents[0].id })
    for (const agent of doc.agents.filter((candidate) => candidate.kind !== 'operator')) {
      expect(agent).toMatchObject({ model: 'sonnet', spawn: { cmd: 'npx', args: ['-y', '@acp/claude'], env: {}, cwd: '.' } })
      expect(agent.role.length).toBeGreaterThan(20)
    }
  })

  it('wires the review template as researcher → you → writer', () => {
    const doc = parse(templateTeamYaml('research-review-write', 'Report', harness('codex'), 'gpt')) as TeamDocument
    expect(doc.agents.map((agent) => agent.kind ?? 'harness')).toEqual(['harness', 'operator', 'harness'])
    expect(doc.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['researcher->review', 'review->writer'])
  })

  it('offers a blank team and lists templates by plain title', () => {
    expect(TEAM_TEMPLATES.map((template) => template.id)).toContain('blank')
    expect(TEAM_TEMPLATES.every((template) => !/harness|entrypoint|yaml/i.test(`${template.title} ${template.description}`))).toBe(true)
  })

  it('never reuses a file name that already exists', () => {
    expect(uniqueTeamPath('Blog writer', [])).toBe('blog-writer.yaml')
    expect(uniqueTeamPath('Blog writer', ['blog-writer.yaml', 'Blog-Writer-2.yaml'])).toBe('blog-writer-3.yaml')
  })

  it('prefers apps most people have signed in, and drops ones that cannot run', () => {
    const ranked = rankHarnesses([harness('hermes'), harness('gemini'), harness('codex'), harness('pi', { acpAvailable: false }), harness('claude')])
    expect(ranked.map((item) => item.id)).toEqual(['claude', 'codex', 'gemini', 'hermes'])
  })

  it('skips an app the daemon last saw fail to start, and keeps one it has not checked yet', () => {
    const ranked = rankHarnesses([
      harness('gemini', { health: 'error', healthReason: 'Gemini: sign-in or version problem — run "gemini" in Terminal to fix' }),
      harness('codex'),
      harness('claude', { health: 'ok' }),
    ])
    expect(ranked.map((item) => item.id)).toEqual(['claude', 'codex'])
  })
})

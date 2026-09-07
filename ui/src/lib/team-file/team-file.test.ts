import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { TeamFileModel, TeamFileParseError } from './document'

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples')

function examplePaths(): string[] {
  return readdirSync(examplesDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
    .map((name) => path.join(examplesDir, name))
}

function readExample(name: string): string {
  return readFileSync(path.join(examplesDir, name), 'utf8')
}

// True if every line of `original` still appears in `updated`, in the same relative
// order, allowing new lines to be inserted between them. Catches reordering or
// reformatting of untouched content without pinning exact line numbers.
function isOrderedSubsequence(original: string[], updated: string[]): boolean {
  let cursor = 0
  for (const line of original) {
    const found = updated.indexOf(line, cursor)
    if (found === -1) {
      return false
    }
    cursor = found + 1
  }
  return true
}

describe('TeamFileModel round-trip against examples/*.yaml', () => {
  const examples = examplePaths()

  it('finds at least one example file', () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  it.each(examples)('loads and re-serializes %s byte-for-byte with no edits', (examplePath) => {
    const source = readFileSync(examplePath, 'utf8')
    const model = TeamFileModel.parse(source)
    expect(model.toYaml()).toBe(source)
  })

  it.each(examples)('exposes a matching typed snapshot for %s', (examplePath) => {
    const source = readFileSync(examplePath, 'utf8')
    const snapshot = TeamFileModel.parse(source).snapshot()
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.entrypoint).toBeTruthy()
    expect(snapshot.agents.length).toBeGreaterThan(0)
    expect(snapshot.agents.some((agent) => agent.id === snapshot.entrypoint)).toBe(true)
  })
})

describe('TeamFileModel mutations touch only the affected lines', () => {
  it('changes exactly one line when editing a scalar agent field', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)
    model.setAgentField('reviewer', 'model', 'claude-opus-6')
    const result = model.toYaml()

    const before = source.split('\n')
    const after = result.split('\n')
    expect(after).toHaveLength(before.length)
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index]))
    expect(changed).toEqual([before.findIndex((line) => line.includes('model: claude-opus-5'))])
    expect(after[changed[0]]).toBe('    model: claude-opus-6')
  })

  it('replacing a budget touches only that agent, not the other one', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)
    model.setAgentField('reviewer', 'budget', { limitUsd: 7 })
    const result = model.toYaml()

    const before = source.split('\n')
    const after = result.split('\n')
    expect(after).toHaveLength(before.length)
    const changedLines = before.filter((line, index) => line !== after[index])
    expect(changedLines).toEqual(['      limitUsd: 5'])
    expect(result).toContain('      limitUsd: 7')
  })

  it('renaming the team leaves every other line byte-identical', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)
    model.setName('Research and review, revised')
    const result = model.toYaml()

    const before = source.split('\n')
    const after = result.split('\n')
    expect(after[2]).toBe('name: Research and review, revised')
    expect(after.slice(3)).toEqual(before.slice(3))
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2))
  })

  it('adding then removing an agent nets an identical document', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)
    model.addAgent({
      id: 'scribe',
      name: 'Scribe',
      role: 'Take notes',
      spawn: { cmd: 'opencode', args: ['acp'], env: {}, cwd: '.' },
      model: 'test/model',
      budget: { limitUsd: 1 },
    })
    expect(model.toYaml()).not.toBe(source)

    model.removeAgent('scribe')
    expect(model.toYaml()).toBe(source)
  })

  it('adding an agent and an edge only inserts lines, never reorders existing ones', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)
    model.addAgent({
      id: 'scribe',
      name: 'Scribe',
      role: 'Take notes',
      spawn: { cmd: 'opencode', args: ['acp'], env: {}, cwd: '.' },
      model: 'test/model',
      budget: { limitUsd: 1 },
    })
    model.addEdge({
      from: 'reviewer',
      to: 'scribe',
      layer: 'configured',
      kind: 'sequence',
      ts: '2026-09-07T00:00:00Z',
    })
    const result = model.toYaml()

    const originalLines = source.split('\n').filter((line) => line.length > 0)
    expect(isOrderedSubsequence(originalLines, result.split('\n'))).toBe(true)

    const snapshot = model.snapshot()
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(['researcher', 'reviewer', 'scribe'])
    expect(snapshot.edges).toHaveLength(2)
    expect(snapshot.edges[1]).toMatchObject({ from: 'reviewer', to: 'scribe' })
  })
})

describe('TeamFileModel error handling', () => {
  it('rejects source that is not valid YAML', () => {
    expect(() => TeamFileModel.parse('agents: [\n')).toThrow(TeamFileParseError)
  })

  it('rejects editing a field on an unknown agent', () => {
    const model = TeamFileModel.parse(readExample('research-team.yaml'))
    expect(() => model.setAgentField('nobody', 'model', 'x')).toThrow(TeamFileParseError)
  })

  it('rejects adding a duplicate agent id', () => {
    const model = TeamFileModel.parse(readExample('research-team.yaml'))
    expect(() =>
      model.addAgent({
        id: 'reviewer',
        name: 'Duplicate',
        role: '',
        spawn: { cmd: 'opencode', args: [], env: {}, cwd: '.' },
        model: 'test/model',
        budget: { limitUsd: 1 },
      }),
    ).toThrow(TeamFileParseError)
  })

  it('rejects removing an edge that does not exist', () => {
    const model = TeamFileModel.parse(readExample('research-team.yaml'))
    expect(() => model.removeEdge('reviewer', 'researcher')).toThrow(TeamFileParseError)
  })
})

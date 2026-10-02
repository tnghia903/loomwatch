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
  it('adds and removes the team-wide deliver block without touching any other line (ADR 0038)', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)
    model.setDeliver({ notion: { title: 'Research — {{date}}' } })
    const added = model.toYaml()
    expect(model.snapshot().deliver).toEqual({ notion: { title: 'Research — {{date}}' } })
    expect(added).toMatch(/^deliver:\n {2}notion:\n {4}title: Research — \{\{date\}\}$/m)
    expect(isOrderedSubsequence(source.split('\n'), added.split('\n'))).toBe(true)

    model.setDeliver(null)
    expect(model.snapshot().deliver).toBeUndefined()
    expect(model.toYaml()).toBe(source)
  })

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

  it('replacing a nested block touches only that agent, not the other one', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)
    model.setAgentField('reviewer', 'spawn', { cmd: 'claude-agent-acp', args: [], env: {}, cwd: 'review' })
    const result = model.toYaml()

    const before = source.split('\n')
    const after = result.split('\n')
    expect(after).toHaveLength(before.length)
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index]))
    expect(changed).toHaveLength(1)
    expect(changed[0]).toBeGreaterThan(before.findIndex((line) => line.includes('id: reviewer')))
    expect(after[changed[0]]).toBe('      cwd: review')
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

  it('clearing the entrypoint removes the key rather than leaving a dangling reference', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)
    model.clearEntrypoint()
    const result = model.toYaml()

    expect(result).not.toContain('entrypoint: researcher')
    expect(result).not.toMatch(/^entrypoint:/m)
    expect(model.snapshot().entrypoint).toBeUndefined()
  })

  it('sets and clears the canonical responder without rewriting the rest of the team', () => {
    const source = readExample('research-team.yaml')
    const model = TeamFileModel.parse(source)

    model.setResponder('researcher')
    expect(model.snapshot().responder).toBe('researcher')
    expect(model.toYaml()).toContain('responder: researcher')

    model.clearResponder()
    expect(model.snapshot().responder).toBeUndefined()
    expect(model.toYaml()).toBe(source)
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

  // A stray notes file or compose file in the teams folder used to load as a "team" and crash the
  // editor on its first look at `agents`. It must be refused, and refused as a shape problem so
  // the screen says "not a team" rather than "not valid YAML".
  it.each([
    ['YAML that is not a team', 'shopping:\n  - milk\n  - eggs\n'],
    ['a list at the top level', '- a\n- b\n'],
    ['an empty file', ''],
    ['a file with only comments', '# nothing here yet\n'],
    ['agents that are not a list', 'schemaVersion: 1\nagents: {a: 1}\nedges: []\n'],
    ['edges that are not a list', 'schemaVersion: 1\nagents: []\nedges: nope\n'],
  ])('refuses %s as not a team', (_label, source) => {
    let caught: unknown = null
    try { TeamFileModel.parse(source) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(TeamFileParseError)
    expect((caught as TeamFileParseError).kind).toBe('shape')
  })

  it('still opens a half-written team, so its problems can be shown and fixed', () => {
    const snapshot = TeamFileModel.parse('schemaVersion: 1\nname: Draft\n').snapshot()
    expect(snapshot.name).toBe('Draft')
    expect(snapshot.agents).toBeUndefined()
  })

  it('marks a YAML syntax error as a yaml problem', () => {
    let caught: unknown = null
    try { TeamFileModel.parse('agents: [\n') } catch (error) { caught = error }
    expect((caught as TeamFileParseError).kind).toBe('yaml')
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
      }),
    ).toThrow(TeamFileParseError)
  })

  it('rejects removing an edge that does not exist', () => {
    const model = TeamFileModel.parse(readExample('research-team.yaml'))
    expect(() => model.removeEdge('reviewer', 'researcher')).toThrow(TeamFileParseError)
  })
})

describe('memory.inherits editing', () => {
  const bare = 'schemaVersion: 1\nid: t\nname: T\nentrypoint: a\nagents:\n  - id: a\n    name: A\n    role: r\n    spawn:\n      cmd: opencode\n      args: []\n      env: {}\n      cwd: .\n    model: m\nedges: []\n'

  it('creates the block, then narrows an existing entry rather than adding a second one', () => {
    const model = TeamFileModel.parse(bare)
    model.addMemoryInherit({ team: 'research-team' })
    expect(model.snapshot().memory?.inherits).toEqual([{ team: 'research-team' }])
    // Wiring the same card to one agent narrows the entry that is already there. A second entry
    // for the same team would supply its Brief twice and charge it twice against the budget.
    model.addMemoryInherit({ team: 'research-team', appliesTo: ['a'] })
    expect(model.snapshot().memory?.inherits).toEqual([{ team: 'research-team', appliesTo: ['a'] }])
    // Dropping it on the whole team again clears the key rather than listing every agent: a
    // frozen list would silently stop supplying an agent the team gains later.
    model.addMemoryInherit({ team: 'research-team' })
    expect(model.snapshot().memory?.inherits).toEqual([{ team: 'research-team' }])
    // A pack is a separate entry, matched on its own key.
    model.addMemoryInherit({ pack: 'onboarding-pack.memory' })
    expect(model.snapshot().memory?.inherits).toEqual([
      { team: 'research-team' },
      { pack: 'onboarding-pack.memory' },
    ])
  })

  it('refuses an entry that names both a team and a pack, or neither', () => {
    const model = TeamFileModel.parse(bare)
    expect(() => model.addMemoryInherit({ team: 't', pack: 'p.memory' })).toThrow(TeamFileParseError)
    expect(() => model.addMemoryInherit({})).toThrow(TeamFileParseError)
    expect(model.snapshot().memory?.inherits).toBeUndefined()
  })

  it('excludes one inherited Brief entry without touching the rest', () => {
    const model = TeamFileModel.parse(bare)
    model.addMemoryInherit({ team: 'research-team' })
    model.addMemoryInherit({ team: 'house-style' })
    model.excludeInheritedBrief({ team: 'research-team' }, 'brief/tone.md')
    expect(model.snapshot().memory?.inherits).toEqual([
      { team: 'research-team', exclude: ['brief/tone.md'] },
      { team: 'house-style' },
    ])
    // Excluding the same path twice is a no-op, not a duplicate.
    model.excludeInheritedBrief({ team: 'research-team' }, 'brief/tone.md')
    expect(model.snapshot().memory?.inherits?.[0].exclude).toEqual(['brief/tone.md'])
    // A source this team does not inherit is refused, rather than silently creating an entry
    // that would start supplying a whole team's Brief as a side effect of declining one file.
    expect(() => model.excludeInheritedBrief({ team: 'nobody' }, 'brief/x.md')).toThrow(TeamFileParseError)
  })

  it('removes an entry and drops the empty list with it', () => {
    const model = TeamFileModel.parse(bare)
    model.addMemoryInherit({ team: 'research-team' })
    model.removeMemoryInherit({ team: 'research-team' })
    expect(model.snapshot().memory?.inherits).toBeUndefined()
    // Removing something absent is a no-op: the panel and the file can disagree for a moment.
    model.removeMemoryInherit({ team: 'research-team' })
  })

  it('leaves a comment on a sibling key alone', () => {
    const model = TeamFileModel.parse(`${bare}memory:\n  # the operator's own note\n  brief:\n    - path: brief/constraints.md\n`)
    model.addMemoryInherit({ team: 'research-team' })
    expect(model.toYaml()).toContain("# the operator's own note")
    expect(model.toYaml()).toContain('brief/constraints.md')
    expect(model.snapshot().memory?.inherits).toEqual([{ team: 'research-team' }])
  })
})

describe('memory.brief editing', () => {
  const bare = 'schemaVersion: 1\nid: t\nname: T\nentrypoint: a\nagents:\n  - id: a\n    name: A\n    role: r\n    spawn:\n      cmd: opencode\n      args: []\n      env: {}\n      cwd: .\n    model: m\nedges: []\n'

  it('creates the memory block on the first entry and appends to it after that', () => {
    const model = TeamFileModel.parse(bare)
    model.addBriefEntry({ path: 'brief/constraints.md' })
    expect(model.snapshot().memory?.brief).toEqual([{ path: 'brief/constraints.md' }])
    model.addBriefEntry({ path: 'brief/tone.md', appliesTo: ['a'] })
    expect(model.snapshot().memory?.brief).toEqual([
      { path: 'brief/constraints.md' },
      { path: 'brief/tone.md', appliesTo: ['a'] },
    ])
  })

  // Two identical entries would be supplied twice and charged twice against the packet budget,
  // so this is refused rather than deduplicated silently.
  it('refuses a duplicate path', () => {
    const model = TeamFileModel.parse(bare)
    model.addBriefEntry({ path: 'brief/constraints.md' })
    expect(() => model.addBriefEntry({ path: 'brief/constraints.md' })).toThrow(TeamFileParseError)
  })

  it('removes an entry by path and leaves the rest untouched', () => {
    const model = TeamFileModel.parse(bare)
    model.addBriefEntry({ path: 'brief/constraints.md' })
    model.addBriefEntry({ path: 'brief/tone.md' })
    model.removeBriefEntry('brief/constraints.md')
    expect(model.snapshot().memory?.brief).toEqual([{ path: 'brief/tone.md' }])
    // Removing something that is not there is a no-op, not a throw: the panel and the file can
    // disagree for a moment after an external edit.
    model.removeBriefEntry('brief/absent.md')
    expect(model.snapshot().memory?.brief).toEqual([{ path: 'brief/tone.md' }])
  })

  it('keeps every untouched line of the team file byte-identical', () => {
    const model = TeamFileModel.parse(bare)
    model.addBriefEntry({ path: 'brief/constraints.md' })
    const updated = model.toYaml()
    expect(isOrderedSubsequence(bare.split('\n'), updated.split('\n'))).toBe(true)
  })
})

// The Inspector's Behaviour-zone memory toggles (docs/TEAM_MEMORY.md §5). Both keys are
// executable, so they go through the document model and wait for an explicit save.
describe('per-agent memory overrides', () => {
  const bare = 'schemaVersion: 1\nid: t\nname: T\nentrypoint: a\nagents:\n  - id: a\n    name: A\n    role: r\n    # keeps its own repository\n    spawn:\n      cmd: opencode\n      args: []\n      env: {}\n      cwd: .\n    model: m\nedges: []\n'

  it('creates the block on the first key and adds the second beside it', () => {
    const model = TeamFileModel.parse(bare)
    model.setAgentMemory('a', 'brief', false)
    expect(model.snapshot().agents[0].memory).toEqual({ brief: false })
    model.setAgentMemory('a', 'deliverAs', 'packet-only')
    expect(model.snapshot().agents[0].memory).toEqual({ brief: false, deliverAs: 'packet-only' })
  })

  it('clears one key without disturbing the other, and drops an empty block entirely', () => {
    const model = TeamFileModel.parse(bare)
    model.setAgentMemory('a', 'brief', false)
    model.setAgentMemory('a', 'deliverAs', 'packet-only')

    model.setAgentMemory('a', 'brief', undefined)
    expect(model.snapshot().agents[0].memory).toEqual({ deliverAs: 'packet-only' })

    model.setAgentMemory('a', 'deliverAs', undefined)
    // Not `memory: {}` — an empty mapping reads as a configured nothing rather than as absence.
    expect(model.snapshot().agents[0].memory).toBeUndefined()
    expect(model.toYaml()).not.toContain('memory')
  })

  it('is a no-op when the key was never there', () => {
    const model = TeamFileModel.parse(bare)
    model.setAgentMemory('a', 'deliverAs', undefined)
    expect(model.snapshot().agents[0].memory).toBeUndefined()
  })

  it('refuses an agent the file does not have', () => {
    const model = TeamFileModel.parse(bare)
    expect(() => model.setAgentMemory('nobody', 'brief', false)).toThrow(TeamFileParseError)
  })

  it('keeps every untouched line, comments included, byte-identical', () => {
    const model = TeamFileModel.parse(bare)
    model.setAgentMemory('a', 'deliverAs', 'packet-only')
    const updated = model.toYaml()
    expect(isOrderedSubsequence(bare.split('\n'), updated.split('\n'))).toBe(true)
    expect(updated).toContain('# keeps its own repository')
  })
})

it('removes the last connected skill without serializing an invalid null capability list', () => {
  const model = TeamFileModel.parse('schemaVersion: 1\nid: test\nname: Test\nentrypoint: a\nagents:\n  - id: a\n    name: A\n    role: Work\nedges: []\n')
  model.setAgentField('a', 'capabilities', [{kind: 'skill', name: 'claude-design'}])
  expect(model.toYaml()).toContain('claude-design')
  model.setAgentField('a', 'capabilities', undefined)
  expect(model.toYaml()).not.toContain('capabilities:')
  expect(TeamFileModel.parse(model.toYaml()).snapshot().agents[0].capabilities).toBeUndefined()
})

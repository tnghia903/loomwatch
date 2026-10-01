import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import type { DetectedHarness } from '../harnesses'
import { appLabelForAgent, harnessIdForAgent } from '../models'
import { useTeamDocument } from './useTeamDocument'

// Team files the daemon accepts because `config.rs` gives these keys serde defaults, while the UI
// read them as always present. Each one used to blank the workspace instead of opening. The real
// schema is served, so the assertions about problems are the ones an operator actually sees.
const SCHEMA = parse(readFileSync(resolve(process.cwd(), '../schemas/team.schema.yaml'), 'utf8')) as object

const OPENCODE: DetectedHarness = {
  id: 'opencode', name: 'OpenCode', command: 'opencode', executablePath: '/bin/opencode', acpAvailable: true,
  spawn: { cmd: 'opencode', args: ['acp'] },
}
const OPENCODE_SPAWN = { ...OPENCODE.spawn, env: {}, cwd: '.' }

/** `spawn` with `cmd` and `cwd` only. The cmd matches a detected harness, which is what reached `args`. */
const SPAWN_WITHOUT_ARGS = `schemaVersion: 1
id: no-args
name: No args
entrypoint: writer
agents:
  - id: writer
    name: Writer
    role: Write the summary.
    model: sonnet
    spawn:
      cmd: opencode
      cwd: .
edges: []
`

/** `memory:` with `inherits:` and no `brief:`. */
const MEMORY_WITHOUT_BRIEF = `schemaVersion: 1
id: inherits-only
name: Inherits only
entrypoint: writer
memory:
  inherits:
    - team: research
agents:
  - id: writer
    name: Writer
    role: Write the summary.
    model: sonnet
    spawn:
      cmd: opencode
      args: [acp]
      env: {}
      cwd: .
edges: []
`

/** No `edges:` key at all — what the `.filter` crash in validation was reading. */
const NO_EDGES = `schemaVersion: 1
id: no-edges
name: No edges
entrypoint: researcher
memory:
  inherits:
    - team: research
agents:
  - id: researcher
    name: Researcher
    role: Find sources.
    model: sonnet
    spawn:
      cmd: opencode
      args: [acp]
      env: {}
      cwd: .
  - id: writer
    name: Writer
    role: Write the summary.
    model: sonnet
    spawn:
      cmd: opencode
      args: [acp]
      env: {}
      cwd: .
`

/** Everything the daemon defaults left out at once: team id and name, edges, agent name and role. */
const BARE = `schemaVersion: 1
entrypoint: writer
agents:
  - id: writer
    model: sonnet
    spawn:
      cmd: opencode
      cwd: .
`

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function open(yaml: string) {
  window.history.pushState({}, '', `/?path=${encodeURIComponent('/teams/shape.yaml')}`)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input) === '/api/config/schema' ? jsonResponse(200, SCHEMA) : jsonResponse(200, { path: '/teams/shape.yaml', yaml }),
  ))
  return renderHook(() => useTeamDocument())
}

/** Waits for the schema too, so a problem that is absent is absent, not merely not yet computed. */
async function opened(result: { current: ReturnType<typeof useTeamDocument> }, agents: number) {
  await waitFor(() => expect(result.current.nodes).toHaveLength(agents))
  await waitFor(() => expect(result.current.saveState).toBe('clean'))
  await waitFor(() => expect(result.current.documentChipState === 'clean' || result.current.documentProblems.length > 0).toBe(true))
}

const messages = (result: { current: ReturnType<typeof useTeamDocument> }) => result.current.documentProblems.map((problem) => problem.message)

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

describe('team files that omit keys the daemon defaults', () => {
  it('opens a spawn without args or env, names both as problems, and choosing the app fixes them', async () => {
    const { result } = open(SPAWN_WITHOUT_ARGS)
    await opened(result, 1)

    const agent = result.current.nodes[0].data.agent
    expect(agent.spawn).toEqual({ cmd: 'opencode', args: [], env: {}, cwd: '.' })
    expect(harnessIdForAgent(agent, [OPENCODE])).toBe('opencode')
    expect(appLabelForAgent(agent, [OPENCODE])).toBe('OpenCode')
    expect(messages(result)).toEqual(expect.arrayContaining([
      expect.stringContaining('missing “args”'),
      expect.stringContaining('missing “env”'),
    ]))
    expect(result.current.documentChipState).toBe('invalid')

    // The Inspector's app picker writes the whole spawn back, which is the fix the schema asks for.
    act(() => result.current.updateAgentSpawn('writer', OPENCODE_SPAWN))
    expect(result.current.yamlPreview).toMatch(/args:\n\s+- acp\n\s+env: \{\}/)
    expect(messages(result).filter((message) => /“(args|env)”/.test(message))).toEqual([])
  })

  it('reads a memory block without a brief as valid memory', async () => {
    const { result } = open(MEMORY_WITHOUT_BRIEF)
    await opened(result, 1)

    expect(result.current.memoryInherits).toEqual([{ team: 'research' }])
    expect(messages(result).filter((message) => /memory|brief/i.test(message))).toEqual([])
  })

  it('opens a team without edges, and its agents can be connected and the connection undone', async () => {
    const { result } = open(NO_EDGES)
    await opened(result, 2)

    expect(result.current.edges).toEqual([])
    expect(result.current.mode).toBe('team')
    expect(result.current.memoryInherits).toEqual([{ team: 'research' }])
    expect(messages(result)).toContainEqual(expect.stringContaining('missing “edges”'))

    act(() => result.current.onConnect({ source: 'researcher', target: 'writer', sourceHandle: null, targetHandle: null }))
    expect(result.current.edges.map((edge) => [edge.source, edge.target])).toEqual([['researcher', 'writer']])
    expect(result.current.yamlPreview).toMatch(/edges:\n\s+- from: researcher\n\s+to: writer/)
    expect(messages(result).filter((message) => message.includes('edges'))).toEqual([])

    act(() => result.current.undo())
    expect(result.current.edges).toEqual([])
    expect(result.current.yamlPreview).not.toContain('edges:')
  })

  it('opens an agent with no name or role as empty text, and says what is missing', async () => {
    const { result } = open(BARE)
    await opened(result, 1)

    const agent = result.current.nodes[0].data.agent
    expect(agent).toMatchObject({ id: 'writer', name: '', role: '', spawn: { cmd: 'opencode', args: [], env: {}, cwd: '.' } })
    expect(messages(result)).toEqual(expect.arrayContaining([
      expect.stringContaining('missing “name”'),
      expect.stringContaining('missing “role”'),
      expect.stringContaining('missing “edges”'),
    ]))
  })
})

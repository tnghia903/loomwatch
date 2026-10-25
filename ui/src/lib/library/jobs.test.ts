import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_MODEL } from '../ai/modelIds'
import type { AgentConfig } from '../team-file/types'
import { buildAgentFromSource } from './createAgent'
import { fetchJobs, guessIcon, JobApiError, jobIdFor, JOBS_CHANGED_EVENT, removeJob, saveJob, savedJobPreset, type SavedJob } from './jobs'
import { ROLE_PRESETS, roleSource } from './roles'

const agent: AgentConfig = {
  id: 'notes', name: 'Release notes', role: 'Write release notes from the merged changes.', model: 'openai/gpt-6.1-sol',
  capabilities: [{ kind: 'skill', name: 'release-style' }],
}

afterEach(() => { vi.unstubAllGlobals() })

describe('built-in jobs', () => {
  it('each tells the agent what it does, how to work, and what to hand back', () => {
    for (const preset of ROLE_PRESETS) {
      expect(preset.role, preset.id).toMatch(/^You are the team’s /)
      expect(preset.role, preset.id).toMatch(/\n(Reply|Check)/)
      expect(preset.does.split(' ').length, preset.id).toBeLessThanOrEqual(6)
    }
    expect(new Set(ROLE_PRESETS.map((preset) => preset.id)).size).toBe(ROLE_PRESETS.length)
  })

  // The daemon takes `## Not met`, `## Missing`, `## Not changed` and `## Changes` off the end of
  // the team's answer (lib.rs NOTE_HEADINGS). Quality bench pilot 1: the Editor's change list was
  // delivered as part of the answer, and what it flagged went into the piece.
  it('asks the Editor for its edits and flags under headings set aside from the answer', () => {
    const editor = ROLE_PRESETS.find((preset) => preset.id === 'editor')!.role
    expect(editor).toContain('headed "## Changes"')
    expect(editor).toContain('headed "## Missing"')
    expect(editor).toContain('no notes about how you edited it')
  })

  // ADR 0095. An agent's commands run in a sandbox that lets them write only in the work folder and
  // the temporary ones (`agent/sandbox.rs`): LibreOffice, started as it usually is, cannot write its
  // profile and stops with "Unspecified Application Error". Seen on this project's Mac, 2026-10-25.
  it('has every maker that can need LibreOffice start it with its profile in the temporary folder', () => {
    const makers = ['deck', 'document', 'sheet', 'chart', 'video'].map((id) => ROLE_PRESETS.find((preset) => preset.id === id)!)
    for (const maker of makers) expect(maker.role, maker.id).toContain('soffice -env:UserInstallation=file://${TMPDIR:-/tmp}/lo-profile --headless')
  })

  // A part of a made file is asked about by its place (ADR 0091): the hand-back names the places,
  // and each maker looks at what it made, or reads it back, before it replies.
  it('has each maker check what it made and hand back its parts by name', () => {
    const parts: Record<string, RegExp> = {
      deck: /each slide: its number and its title/, document: /its headings in order/, sheet: /each sheet: its name, its columns/,
      chart: /the values it draws/, dashboard: /each number and chart the page shows/, video: /each scene: its start time \(m:ss\)/,
    }
    for (const [id, says] of Object.entries(parts)) {
      const role = ROLE_PRESETS.find((preset) => preset.id === id)!.role
      expect(role, id).toMatch(says)
      expect(role, id).toMatch(/Before you reply, (check|read|open)/)
      expect(role, id).toMatch(/`read_file`/)
    }
  })
})

describe('saving an agent as a job', () => {
  it('names the file from the job name', () => {
    expect(jobIdFor('Release notes — v2!')).toBe('release-notes-v2')
    expect(jobIdFor('Café rédacteur')).toBe('cafe-redacteur')
    expect(jobIdFor('!!!')).toBe('job')
  })

  it('guesses an icon from the name before the instructions', () => {
    expect(guessIcon('Fact checker', 'Write a summary')).toBe('review')
    expect(guessIcon('Helper', 'Analyse the sales data')).toBe('analyse')
    expect(guessIcon('Helper', 'Be nice')).toBeUndefined()
    // A maker's word wins over the older, wider ones.
    expect(guessIcon('Pitch deck designer')).toBe('slides')
    expect(guessIcon('Budget spreadsheet')).toBe('sheet')
    expect(guessIcon('Sales data dashboard')).toBe('dashboard')
    expect(guessIcon('Helper', 'Turn the data into charts')).toBe('chart')
    expect(guessIcon('Promo video')).toBe('video')
    expect(guessIcon('Board pack', 'Make a Word document from the notes')).toBe('document')
    expect(guessIcon('Data analyst')).toBe('analyse')
  })
})

describe('placing a saved job', () => {
  const saved: SavedJob = { id: 'release-notes', name: 'Release notes', instructions: agent.role, model: 'openai/gpt-6.1-sol', skills: ['release-style'], file: '.jobs/release-notes.yaml' }

  it('places the agent it was saved from: instructions, model and skills', () => {
    const source = roleSource(savedJobPreset(saved))
    expect(source).toMatchObject({ label: 'Release notes', role: agent.role, model: 'openai/gpt-6.1-sol', capabilities: [{ kind: 'skill', name: 'release-style' }] })
    expect(source).not.toHaveProperty('spawn')
    const placed = buildAgentFromSource(source, [])
    expect(placed.capabilities).toEqual([{ kind: 'skill', name: 'release-style' }])
    expect(placed.model).toBe('openai/gpt-6.1-sol')
  })

  it('places its tools as tools a team’s canvas draws wired to it', () => {
    const source = roleSource(savedJobPreset({ ...saved, tools: ['github'] }))
    const placed = buildAgentFromSource(source, [])
    expect(placed.capabilities).toEqual([{ kind: 'skill', name: 'release-style' }, { kind: 'tool', name: 'github' }])
  })

  it('runs on the default model when it was saved without one', () => {
    const source = roleSource(savedJobPreset({ ...saved, model: undefined }))
    expect(source.model).toBe(DEFAULT_MODEL)
    expect(source.capabilities).toEqual([{ kind: 'skill', name: 'release-style' }])
  })

  it('describes a job saved without a line of its own by its first sentence', () => {
    expect(savedJobPreset(saved).does).toBe('Write release notes from the merged changes.')
  })
})

describe('the jobs API', () => {
  it('treats a daemon without the route as one that predates saved jobs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 404 })))
    await expect(fetchJobs()).resolves.toBeNull()
  })

  it('creates without overwriting, reports a taken name as 412, and announces every change', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      if (init?.method === 'PUT' && (init.headers as Record<string, string>)['If-None-Match'] === '*') return new Response(JSON.stringify({ error: 'You already have a job called “Notes”.' }), { status: 412 })
      return new Response(JSON.stringify({ id: 'notes', name: 'Notes', instructions: 'x', file: '.jobs/notes.yaml' }), { status: 200 })
    }))
    const changed = vi.fn()
    window.addEventListener(JOBS_CHANGED_EVENT, changed)
    const refused = await saveJob('notes', { name: 'Notes', instructions: 'x' }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(JobApiError)
    expect((refused as JobApiError).status).toBe(412)
    expect(changed).not.toHaveBeenCalled()
    await saveJob('notes', { name: 'Notes', instructions: 'x' }, { replace: true })
    expect(((calls[1].init?.headers ?? {}) as Record<string, string>)['If-None-Match']).toBeUndefined()
    await removeJob('notes')
    expect(calls[2]).toMatchObject({ url: '/api/jobs/notes', init: { method: 'DELETE' } })
    expect(changed).toHaveBeenCalledTimes(2)
    window.removeEventListener(JOBS_CHANGED_EVENT, changed)
  })
})

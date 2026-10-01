import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchHarnesses, fetchHarnessModels, harnessProblem, HarnessesApiError, isHarnessRunnable, knownHarness, monogramForSpawnCmd, type DetectedHarness } from './harnesses'

afterEach(() => vi.unstubAllGlobals())

describe('fetchHarnessModels', () => {
  it('loads the live model catalog for the selected harness', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      harnessId: 'codex',
      models: [
        { id: 'openai/fast', name: 'Fast', thinkingEfforts: [] },
        { id: 'openai/reasoning', name: 'Reasoning', thinkingEfforts: [{ id: 'high', name: 'High' }] },
      ],
      currentModelId: 'openai/fast',
      currentThinkingEffort: 'high',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchHarnessModels('codex')).resolves.toEqual({
      harnessId: 'codex',
      models: [
        { id: 'openai/fast', name: 'Fast', thinkingEfforts: [] },
        { id: 'openai/reasoning', name: 'Reasoning', thinkingEfforts: [{ id: 'high', name: 'High' }] },
      ],
      currentModelId: 'openai/fast',
      currentThinkingEffort: 'high',
    })
    expect(fetch).toHaveBeenCalledWith('/api/harnesses/codex/models')
  })

  it('surfaces the harness error returned by the daemon', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Codex is not signed in' }),
      { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'application/json' } },
    )))

    await expect(fetchHarnessModels('codex')).rejects.toEqual(
      new HarnessesApiError('Codex is not signed in', 502),
    )
  })
})

// `GET /api/harnesses` returns a report, not a bare array: "nothing was found" and "nothing was
// looked for in the right place" produce the same empty list, and only the daemon knows which
// happened (crates/loomwatch-backend/src/api.rs::HarnessReport).
describe('fetchHarnesses', () => {
  it('returns what was found, where it looked, and what it looked for', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      harnesses: [
        { id: 'hermes', name: 'Hermes', command: 'hermes', executablePath: '/home/t/.local/bin/hermes', acpAvailable: true, spawn: { cmd: 'hermes-acp', args: [] } },
        { id: 'pi', name: 'pi', command: 'pi', executablePath: '/home/t/.local/bin/pi', acpAvailable: false, unavailableReason: 'pi is installed but ships no ACP bridge, so LoomWatch cannot drive it.', spawn: { cmd: 'pi', args: [] } },
      ],
      searchedPath: ['/usr/bin', '/home/t/.local/bin'],
      knownIds: ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'openclaw', 'pi'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)

    const report = await fetchHarnesses()
    expect(fetch).toHaveBeenCalledWith('/api/harnesses')
    expect(report.harnesses.map((harness) => harness.id)).toEqual(['hermes', 'pi'])
    expect(report.searchedPath).toEqual(['/usr/bin', '/home/t/.local/bin'])
    expect(report.knownIds).toContain('openclaw')
    // The reason is the daemon's sentence, not a client guess. `pi` is installed, so "not found
    // on PATH" would simply be false.
    expect(report.harnesses[1].unavailableReason).toContain('no ACP bridge')
  })

  it('surfaces a failure as a typed error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500, statusText: 'Internal Server Error' })))
    await expect(fetchHarnesses()).rejects.toEqual(new HarnessesApiError('Internal Server Error', 500))
  })
})

// The daemon owns which harnesses exist; this table owns only how one is drawn. A harness the
// daemon learns about must still render, which is what stops the two drifting again.
describe('harness presentation', () => {
  it('names and monograms every harness the backend catalog lists', () => {
    for (const [id, monogram] of [['claude', 'C'], ['codex', 'Cx'], ['gemini', 'G'], ['opencode', 'Oc'], ['openclaw', 'Ow'], ['hermes', 'H'], ['pi', 'Pi']] as const) {
      expect(knownHarness(id).monogram).toBe(monogram)
    }
    // OpenClaw and OpenCode are different products; a shared monogram would be the only thing
    // distinguishing their rows, so it must not be shared.
    expect(knownHarness('openclaw').monogram).not.toBe(knownHarness('opencode').monogram)
  })

  it('falls back to the id for a harness this build has never heard of', () => {
    expect(knownHarness('newharness')).toEqual({ id: 'newharness', name: 'newharness', monogram: '·' })
  })

  it('recovers a monogram from the spawn command an agent actually carries', () => {
    expect(monogramForSpawnCmd('hermes-acp')).toBe('H')
    expect(monogramForSpawnCmd('openclaw')).toBe('Ow')
    expect(monogramForSpawnCmd('opencode')).toBe('Oc')
    expect(monogramForSpawnCmd('loomwatchd', ['harness-client', '--harness', 'codex'])).toBe('Cx')
    expect(monogramForSpawnCmd('some-custom-acp')).toBe('·')
  })
})

describe('harness readiness', () => {
  const gemini: DetectedHarness = { id: 'gemini', name: 'Gemini', command: 'gemini', executablePath: '/bin/gemini', acpAvailable: true, spawn: { cmd: 'gemini', args: ['--acp'] } }

  it('treats an app the daemon has not checked as runnable, as older daemons never report health', () => {
    expect(isHarnessRunnable(gemini)).toBe(true)
    expect(harnessProblem(gemini)).toBeNull()
    expect(isHarnessRunnable({ ...gemini, health: 'ok' })).toBe(true)
  })

  it('prints the daemon\'s reason for an app that failed to start', () => {
    const failing = { ...gemini, health: 'error' as const, healthReason: 'Gemini: sign-in or version problem — run "gemini" in Terminal to fix' }
    expect(isHarnessRunnable(failing)).toBe(false)
    expect(harnessProblem(failing)).toBe('Gemini: sign-in or version problem — run "gemini" in Terminal to fix')
    expect(harnessProblem({ ...failing, healthReason: undefined })).toBe('Gemini: sign-in or version problem — run "gemini" in Terminal to fix')
  })

  it('reports a missing ACP bridge before any health verdict', () => {
    const pi = { ...gemini, id: 'pi', name: 'pi', acpAvailable: false, unavailableReason: 'pi has no ACP adapter.', health: 'error' as const, healthReason: 'unused' }
    expect(isHarnessRunnable(pi)).toBe(false)
    expect(harnessProblem(pi)).toBe('pi has no ACP adapter.')
  })
})

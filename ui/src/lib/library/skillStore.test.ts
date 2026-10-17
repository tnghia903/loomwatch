import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bringIn, describeOrigin, fetchSkills, inspectInstall, installSkills, licenseLabel, needLabel, previewBringIn, removeSkill,
  scanLabel, searchSkills, shortPath, SKILLS_UNAVAILABLE, SkillsApiError, undoBringIn,
} from './skillStore'

afterEach(() => { vi.unstubAllGlobals() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function stub(...answers: Response[]) {
  const fetch = vi.fn()
  for (const answer of answers) fetch.mockResolvedValueOnce(answer)
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const call = (fetch: ReturnType<typeof vi.fn>, index = 0) => {
  const [url, init] = fetch.mock.calls[index] as [string, RequestInit | undefined]
  return { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined }
}

describe('the skills folder', () => {
  it('reads the folder without the change header', async () => {
    const fetch = stub(json({ folder: '/Users/me/Library/Application Support/LoomWatch/skills', skills: [] }))
    expect(await fetchSkills()).toEqual({ folder: '/Users/me/Library/Application Support/LoomWatch/skills', skills: [] })
    expect(call(fetch)).toMatchObject({ url: '/api/skills', method: 'GET' })
    expect(call(fetch).headers['X-LoomWatch-Request']).toBeUndefined()
  })

  it('sends every change with the header, to the routes the daemon serves', async () => {
    const fetch = stub(
      json({ removed: 'pdf tools' }),
      json({ candidates: [{ key: 'k1' }] }),
      json({ batchId: 'b1', imported: [], skipped: [] }),
      json({ removed: ['pdf'] }),
      json({ token: 't', candidates: [], notes: [], source: 'github', title: 'acme/skills' }),
      json({ token: 't', candidates: [], notes: [], source: 'skills.sh', title: 'pdf' }),
      json({ installed: [{ name: 'pdf' }] }),
    )
    expect(await removeSkill('pdf tools')).toBe('pdf tools')
    expect(await previewBringIn()).toEqual([{ key: 'k1' }])
    expect((await bringIn(['k1', 'k2'])).batchId).toBe('b1')
    expect(await undoBringIn('b1')).toEqual(['pdf'])
    await inspectInstall('acme/skills')
    await inspectInstall('acme/skills/pdf', 'skills.sh')
    expect(await installSkills('t', ['skills/pdf'], true)).toEqual([{ name: 'pdf' }])

    const calls = fetch.mock.calls.map((_, index) => call(fetch, index))
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'DELETE /api/skills/pdf%20tools',
      'POST /api/skills/bring-in/preview',
      'POST /api/skills/bring-in',
      'POST /api/skills/bring-in/b1/undo',
      'POST /api/skills/install/inspect',
      'POST /api/skills/install/inspect',
      'POST /api/skills/install',
    ])
    for (const sent of calls) expect(sent.headers['X-LoomWatch-Request']).toBe('1')
    expect(calls[2].body).toEqual({ keys: ['k1', 'k2'] })
    expect(calls[4].body).toEqual({ ref: 'acme/skills' })
    expect(calls[5].body).toEqual({ ref: 'acme/skills/pdf', source: 'skills.sh' })
    expect(calls[6].body).toEqual({ token: 't', paths: ['skills/pdf'], replace: true })
  })

  it('searches through the daemon, never the sites themselves', async () => {
    const fetch = stub(json({ results: [{ source: 'clawhub', id: 'k', name: 'Pdf', url: 'https://clawhub.ai/a/skills/pdf', ref: 'a/pdf' }] }))
    expect((await searchSkills('pdf & forms', 'clawhub'))[0].ref).toBe('a/pdf')
    expect(call(fetch).url).toBe('/api/skills/search?q=pdf+%26+forms&source=clawhub')
  })

  it('says what the daemon said, and keeps the status a caller asks about', async () => {
    stub(json({ error: '“pdf” is already in LoomWatch. Replace it?' }, 409))
    const error = await installSkills('t', ['.']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SkillsApiError)
    expect(error).toMatchObject({ status: 409, message: '“pdf” is already in LoomWatch. Replace it?' })
  })

  it('tells an older daemon apart from a failure', async () => {
    stub(new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    await expect(fetchSkills()).rejects.toThrow(SKILLS_UNAVAILABLE)
    stub(new Response('', { status: 404 }))
    await expect(fetchSkills()).rejects.toThrow(SKILLS_UNAVAILABLE)
  })
})

describe('words for the page', () => {
  it('says where a skill came from, and names apps only as that', () => {
    expect(describeOrigin({ kind: 'brought_in', app: 'Claude Code' })).toBe('Brought in from Claude Code')
    expect(describeOrigin({ kind: 'installed', source: 'clawhub' })).toBe('Installed from ClawHub')
    expect(describeOrigin({ kind: 'found' })).toBe('Added to the folder by hand')
  })

  it('reads licenses, needs and safety checks plainly', () => {
    expect(licenseLabel({ id: 'MIT', restricted: false })).toBe('License: MIT')
    expect(licenseLabel({ restricted: false })).toBe('No license given')
    expect(licenseLabel({ id: 'All rights reserved', restricted: true })).toBe('All rights reserved (can’t be copied)')
    expect(needLabel('subagents')).toBe('Uses helper agents')
    expect(needLabel('something new')).toBe('something new')
    expect(scanLabel({ status: 'clean', hasWarnings: true })).toBe('ClawHub’s safety check passed, with warnings.')
    expect(shortPath('/Users/me/.claude/skills/pdf')).toBe('~/.claude/skills/pdf')
  })
})

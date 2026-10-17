import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bringIn, compactCount, describeOrigin, displayName, fetchSkills, inspectInstall, installedKeys, installSkills, licenseLabel, looksLikeLink,
  mergeResults, needLabel, noticesFor, previewBringIn, topicOf, removeSkill, resultKey, scanLabel, searchEverywhere, searchSkills, shortPath,
  SKILLS_UNAVAILABLE, SkillsApiError, undoBringIn, type InstallCandidate, type SearchResult, type SkillRecord,
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

describe('finding skills', () => {
  const hit = (source: 'skills.sh' | 'clawhub', ref: string): SearchResult => ({ source, id: ref, name: ref, url: '', ref })

  it('tells a pasted link from words', () => {
    for (const link of ['github.com/acme/skills', 'https://github.com/acme/skills/tree/main/x', 'acme/skills', 'acme/skills/skills/pdf@v1', 'https://www.skills.sh/a/b/c', 'clawhub.ai/a/skills/b']) {
      expect(looksLikeLink(link), link).toBe(true)
    }
    for (const words of ['pdf', 'pdf forms', 'data analysis', 'excel / sheets', '.hidden/x', '']) {
      expect(looksLikeLink(words), words).toBe(false)
    }
  })

  it('merges the two sites by taking turns, without repeats', () => {
    const merged = mergeResults([
      [hit('skills.sh', 'a/r/one'), hit('skills.sh', 'a/r/two'), hit('skills.sh', 'a/r/three')],
      [hit('clawhub', 'b/one'), hit('skills.sh', 'A/R/One')],
    ])
    expect(merged.map(resultKey)).toEqual(['skills.sh:a/r/one', 'clawhub:b/one', 'skills.sh:a/r/two', 'skills.sh:a/r/three'])
  })

  it('searches both sites and says which didn’t answer', async () => {
    const fetch = vi.fn((input: RequestInfo | URL) => Promise.resolve(String(input).includes('clawhub')
      ? json({ error: 'Couldn’t reach ClawHub.' }, 502)
      : json({ results: [hit('skills.sh', 'a/r/pdf')] })))
    vi.stubGlobal('fetch', fetch)
    expect(await searchEverywhere('pdf')).toEqual({ results: [hit('skills.sh', 'a/r/pdf')], missed: ['clawhub'] })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: 'Couldn’t reach skills.sh.' }, 502))))
    await expect(searchEverywhere('pdf')).rejects.toThrow('Couldn’t reach skills.sh.')
  })

  it('knows a result is yours only by where it came from, not its name', () => {
    const mine = { name: 'pdf', origin: { kind: 'installed', source: 'clawhub', ref: 'AwSpace/pdf' } } as SkillRecord
    const keys = installedKeys([mine, { name: 'notes', origin: { kind: 'brought_in', app: 'Codex' } } as SkillRecord])
    expect([...keys]).toEqual(['clawhub:awspace/pdf'])
    expect(keys.has(resultKey(hit('clawhub', 'awspace/pdf')))).toBe(true)
    expect(keys.has(resultKey(hit('skills.sh', 'openai/skills/pdf')))).toBe(false)
  })

  it('reads names and counts at a glance', () => {
    expect(displayName('remove-pdf-watermark')).toBe('Remove PDF watermark')
    expect(displayName('Pdf')).toBe('PDF')
    expect(displayName('brand_guidelines')).toBe('Brand guidelines')
    expect(displayName('PDF Form Filler')).toBe('PDF Form Filler')
    expect(compactCount(950)).toBe('950')
    expect(compactCount(1143)).toBe('1.1k')
    expect(compactCount(211908)).toBe('212k')
    expect(compactCount(2_400_000)).toBe('2.4M')
  })
})

describe('what a skill is about', () => {
  it('tells its topic from its name first, then its description', () => {
    expect(topicOf('pdf-to-docx')).toBe('pdf')
    expect(topicOf('pdftk-server')).toBe('pdf')
    expect(topicOf('spreadsheet-formula-helper')).toBe('sheet')
    expect(topicOf('brand-guidelines')).toBe('design')
    expect(topicOf('seo-audit')).toBe('marketing')
    expect(topicOf('meeting-notes')).toBe('meeting')
    expect(topicOf('house-style')).toBe('writing')
    expect(topicOf('contract-review')).toBe('legal')
    expect(topicOf('helper', 'Turns a call transcript into decisions and owners.')).toBe('meeting')
    expect(topicOf('acme-thing', 'Does acme things.')).toBeNull()
  })
})

describe('what to know before adding', () => {
  const candidate = (extra: Partial<InstallCandidate> = {}): InstallCandidate => ({
    path: '.', name: 'pdf', description: '', license: { id: 'MIT', restricted: false }, restricted: false, files: [], hasScripts: false, runtimes: [], needs: [], sizeBytes: 1, conflict: false, ...extra,
  })

  it('says only why, when it can’t be added', () => {
    const reason = '“pdf”’s license says “All rights reserved”, so it can’t be copied into LoomWatch.'
    expect(noticesFor(candidate({ reason, restricted: true, license: { restricted: true }, hasScripts: true, conflict: true }), { status: 'clean', hasWarnings: false }))
      .toEqual([{ tone: 'stop', text: reason }])
  })

  it('marks what is fine and what is worth reading', () => {
    expect(noticesFor(candidate(), { status: 'clean', hasWarnings: false })).toEqual([
      { tone: 'ok', text: 'ClawHub’s safety check passed.' },
      { tone: 'ok', text: 'Open license (MIT): free to use.' },
      { tone: 'ok', text: 'Instructions only: no scripts.' },
    ])
    const notes = noticesFor(candidate({ license: { restricted: false }, hasScripts: true, runtimes: ['node', 'python'], conflict: true }), { status: 'suspicious', hasWarnings: true })
    expect(notes.map((notice) => notice.tone)).toEqual(['note', 'note', 'note', 'note'])
    expect(notes[0].text).toMatch(/found something suspicious/)
    expect(notes[1].text).toMatch(/^You already have a skill called “pdf”/)
    expect(notes[2].text).toBe('It names no license. Check its page before you use it for work.')
    expect(notes[3].text).toMatch(/needs Node.js and Python for that/)
    expect(noticesFor(candidate({ license: { id: 'Complete terms in LICENSE.txt', restricted: false } }))[0])
      .toEqual({ tone: 'note', text: 'License: Complete terms in LICENSE.txt. Read it on its page if you’re not sure it covers your use.' })
  })
})

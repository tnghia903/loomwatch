import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BringInCandidate, InstallCandidate, Inspection, SearchResult, SkillRecord } from '../../lib/library/skillStore'
import { SkillsPage } from './SkillsPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Sent = { method: string; url: string; body?: Record<string, unknown>; header?: string }
type Route = (sent: Sent) => Response | undefined

/** The daemon, answering by method and path; every request is kept. */
function daemon(...routes: Route[]) {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const request: Sent = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, header: headers['X-LoomWatch-Request'] }
    sent.push(request)
    for (const route of routes) {
      const answer = route(request)
      if (answer) return answer
    }
    return json({ error: `no route for ${request.method} ${request.url}` }, 404)
  }))
  return sent
}

const on = (method: string, url: string, answer: (sent: Sent) => Response): Route => (sent) => (sent.method === method && sent.url === url ? answer(sent) : undefined)

const record = (name: string, extra: Partial<SkillRecord> = {}): SkillRecord => ({
  name, description: `Does ${name} things.`, origin: { kind: 'installed', source: 'github', ref: 'acme/skills', url: 'https://github.com/acme/skills/tree/abc/skills/pdf' },
  license: { id: 'MIT', restricted: false }, needs: [], runtimes: [], hasScripts: false, sizeBytes: 2048, sha256: 'f'.repeat(64), addedAt: '2026-10-17T00:00:00Z', ...extra,
})

const hit = (source: 'skills.sh' | 'clawhub', ref: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  source, id: ref, name: ref.split('/').pop()!, url: `https://example.test/${ref}`, ref, ...extra,
})

const found = (name: string, extra: Partial<InstallCandidate> = {}): InstallCandidate => ({
  path: `skills/${name}`, name, description: `Does ${name} things.`, license: { id: 'MIT', restricted: false }, restricted: false,
  files: ['SKILL.md'], hasScripts: false, runtimes: [], needs: [], sizeBytes: 900, conflict: false, ...extra,
})

const inspection = (extra: Partial<Inspection> = {}): Inspection => ({
  token: 'tok', source: 'clawhub', title: 'awspace/pdf', url: 'https://clawhub.ai/awspace/skills/pdf', notes: [],
  candidates: [found('pdf', { path: '.' })], ...extra,
})

const candidate = (name: string, extra: Partial<BringInCandidate> = {}): BringInCandidate => ({
  key: `key-${name}`, name, description: `Does ${name} things.`, app: 'Claude Code', path: `/Users/me/.claude/skills/${name}`, license: { restricted: false },
  restricted: false, needs: [], runtimes: [], hasScripts: false, sizeBytes: 1024, fileCount: 1, alreadyInLoomWatch: false, defaultSelected: true, ...extra,
})

const folder = (skills: SkillRecord[]) => json({ folder: '/Users/me/Library/Application Support/LoomWatch/skills', skills })
const PDF_SEARCH = {
  'skills.sh': [
    hit('skills.sh', 'anthropics/skills/pdf', { installs: 211908, avatar: '/api/skills/avatar/github/anthropics' }),
    hit('skills.sh', 'openai/skills/pdf', { installs: 13218 }),
  ],
  clawhub: [
    hit('clawhub', 'awspace/pdf', { name: 'Pdf', installs: 50624, description: 'Comprehensive PDF toolkit.' }),
    hit('skills.sh', 'anthropics/skills/pdf'),
  ],
}
const searching = (answers: Record<string, SearchResult[] | 'fail'> = PDF_SEARCH): Route => (sent) => {
  if (sent.method !== 'GET' || !sent.url.startsWith('/api/skills/search?')) return undefined
  const params = new URLSearchParams(sent.url.split('?')[1])
  const answer = answers[params.get('source') ?? '']
  return answer === 'fail' ? json({ error: 'Couldn’t reach ClawHub.' }, 502) : json({ results: answer ?? [] })
}

async function searchFor(topic = 'PDFs and forms') {
  fireEvent.click(await screen.findByRole('button', { name: topic }))
  return screen.findByRole('list', { name: 'Search results' })
}

describe('finding skills', () => {
  it('starts from topics and searches both sites at once, through LoomWatch', async () => {
    const sent = daemon(
      on('GET', '/api/skills', () => folder([record('pdf', { origin: { kind: 'installed', source: 'skills.sh', ref: 'openai/skills/pdf' } })])),
      searching(),
    )
    render(<SkillsPage />)
    const results = await searchFor()
    expect(screen.getByRole('searchbox', { name: 'Find skills' })).toHaveValue('pdf')
    const searches = sent.filter((request) => request.url.startsWith('/api/skills/search')).map((request) => request.url)
    expect(searches.sort()).toEqual(['/api/skills/search?q=pdf&source=clawhub', '/api/skills/search?q=pdf&source=skills.sh'])
    expect(sent.every((request) => request.url.startsWith('/api/'))).toBe(true)

    const cards = within(results).getAllByRole('listitem')
    expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual(['PDF', 'PDF', 'PDF'])
    expect(cards[0]).toHaveTextContent('by anthropics')
    expect(cards[0]).toHaveTextContent('212k installs')
    expect(cards[1]).toHaveTextContent('by awspace')
    expect(cards[1]).toHaveTextContent('Comprehensive PDF toolkit.')
    expect(cards[2]).toHaveTextContent('by openai')
    expect(cards[2]).toHaveTextContent('You have this')
    expect(within(cards[0]).getByRole('button', { name: 'Add PDF by anthropics' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'All topics' }))
    expect(await screen.findByRole('button', { name: 'Spreadsheets' })).toBeInTheDocument()
  })

  it('shows publishers’ pictures only as LoomWatch serves them, and none when one is missing', async () => {
    daemon(on('GET', '/api/skills', () => folder([])), searching())
    render(<SkillsPage />)
    const results = await searchFor()
    const [anthropics, , openai] = within(results).getAllByRole('listitem')
    const picture = anthropics.querySelector('.lw-skills-by img')
    expect(picture).toHaveAttribute('src', '/api/skills/avatar/github/anthropics')
    expect(picture).toHaveAttribute('alt', '')
    expect(openai.querySelector('.lw-skills-by img')).toBeNull()
    fireEvent.error(picture!)
    expect(anthropics.querySelector('.lw-skills-by img')).toBeNull()
    expect([...document.querySelectorAll('img')].every((image) => image.getAttribute('src')?.startsWith('/api/'))).toBe(true)
  })

  it('marks each skill with the icon of what it is about', async () => {
    daemon(on('GET', '/api/skills', () => folder([])), searching({ 'skills.sh': [hit('skills.sh', 'acme/skills/pdf'), hit('skills.sh', 'acme/skills/seo-audit'), hit('skills.sh', 'acme/skills/zzz')], clawhub: [] }))
    render(<SkillsPage />)
    const results = await searchFor()
    const icons = within(results).getAllByRole('listitem').map((card) => card.querySelector('.lw-skills-glyph svg')?.getAttribute('class'))
    expect(icons[0]).toMatch(/file-text/)
    expect(icons[1]).toMatch(/megaphone/)
    expect(icons[2]).toMatch(/book-open-text/)
  })

  it('shows one site’s results when the other doesn’t answer', async () => {
    daemon(on('GET', '/api/skills', () => folder([])), searching({ 'skills.sh': PDF_SEARCH['skills.sh'], clawhub: 'fail' }))
    render(<SkillsPage />)
    const results = await searchFor()
    expect(within(results).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText(/ClawHub didn’t answer, so these are from skills.sh only/)).toBeInTheDocument()
  })

  it('takes a pasted link straight to a look inside', async () => {
    const sent = daemon(
      on('GET', '/api/skills', () => folder([])),
      on('POST', '/api/skills/install/inspect', () => json(inspection({ source: 'github', title: 'acme/skills', candidates: [found('docx'), found('notes')] }))),
    )
    render(<SkillsPage />)
    const box = await screen.findByRole('searchbox', { name: 'Find skills' })
    fireEvent.change(box, { target: { value: 'research' } })
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
    fireEvent.change(box, { target: { value: ' github.com/acme/skills ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look inside' }))
    expect(await screen.findByRole('dialog', { name: 'acme/skills' })).toBeInTheDocument()
    expect(sent.find((request) => request.url === '/api/skills/install/inspect')?.body).toEqual({ ref: 'github.com/acme/skills' })
    expect(sent.some((request) => request.url.startsWith('/api/skills/search'))).toBe(false)
  })
})

describe('adding a skill', () => {
  it('reviews it in plain words, adds it with one click, and can take it back', async () => {
    let skills: SkillRecord[] = []
    const sent = daemon(
      on('GET', '/api/skills', () => folder(skills)),
      searching(),
      on('POST', '/api/skills/install/inspect', () => json(inspection({
        scan: { status: 'clean', hasWarnings: false },
        candidates: [found('pdf', { path: '.', hasScripts: true, runtimes: ['python'], files: ['SKILL.md', 'scripts/fill.py'] })],
      }))),
      on('POST', '/api/skills/install', () => {
        skills = [record('pdf', { origin: { kind: 'installed', source: 'clawhub', ref: 'awspace/pdf' } })]
        return json({ installed: skills })
      }),
      on('DELETE', '/api/skills/pdf', () => { skills = []; return json({ removed: 'pdf' }) }),
    )
    render(<SkillsPage />)
    const results = await searchFor()
    fireEvent.click(within(results).getByRole('button', { name: 'Add PDF by awspace' }))
    const sheet = await screen.findByRole('dialog', { name: 'PDF' })
    expect(sent.find((request) => request.url === '/api/skills/install/inspect')?.body).toEqual({ ref: 'awspace/pdf', source: 'clawhub' })
    const know = await within(sheet).findByRole('list', { name: 'What to know' })
    expect(know).toHaveTextContent('ClawHub’s safety check passed.')
    expect(know).toHaveTextContent('Open license (MIT): free to use.')
    expect(know).toHaveTextContent('Comes with scripts. Nothing runs now')
    expect(know).toHaveTextContent('this computer needs Python for that')
    expect(sheet).toHaveTextContent('What’s inside: 2 files')
    expect(sheet).toHaveTextContent('by awspace')
    expect(sent.some((request) => request.url === '/api/skills/install')).toBe(false)

    fireEvent.click(within(sheet).getByRole('button', { name: 'Add skill' }))
    expect(await screen.findByText('Added PDF. Every agent can use it now.')).toBeInTheDocument()
    const install = sent.find((request) => request.url === '/api/skills/install')!
    expect(install.body).toEqual({ token: 'tok', paths: ['.'], replace: false })
    expect(install.header).toBe('1')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(results).getAllByRole('listitem')[1]).toHaveTextContent('Added')
    expect(await screen.findByRole('list', { name: 'Your skills' })).toHaveTextContent('PDF')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Took back PDF.')).toBeInTheDocument()
    expect(sent.find((request) => request.method === 'DELETE')?.url).toBe('/api/skills/pdf')
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Your skills' })).toBeNull())
  })

  it('says why a skill can’t be added, and the card remembers', async () => {
    daemon(
      on('GET', '/api/skills', () => folder([])),
      searching(),
      on('POST', '/api/skills/install/inspect', () => json(inspection({
        source: 'skills.sh',
        candidates: [found('pdf', { license: { id: 'Proprietary', restricted: true }, restricted: true, hasScripts: true, runtimes: ['python'], reason: '“pdf”’s license says “All rights reserved”, so it can’t be copied into LoomWatch.' })],
      }))),
    )
    render(<SkillsPage />)
    const results = await searchFor()
    fireEvent.click(within(results).getByRole('button', { name: 'Add PDF by anthropics' }))
    const sheet = await screen.findByRole('dialog', { name: 'PDF' })
    const know = await within(sheet).findByRole('list', { name: 'What to know' })
    expect(within(know).getAllByRole('listitem')).toHaveLength(1)
    expect(know).toHaveTextContent('can’t be copied into LoomWatch')
    expect(within(sheet).queryByRole('button', { name: /Add/ })).toBeNull()
    expect(sheet).not.toHaveTextContent('Needs Python')
    fireEvent.click(within(sheet).getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(within(results).getAllByRole('listitem')[0]).toHaveTextContent('Can’t add')
  })

  it('says when adding replaces a skill you have, and offers no undo after', async () => {
    const sent = daemon(
      on('GET', '/api/skills', () => folder([record('pdf')])),
      searching(),
      on('POST', '/api/skills/install/inspect', () => json(inspection({ candidates: [found('pdf', { path: '.', conflict: true })] }))),
      on('POST', '/api/skills/install', () => json({ installed: [record('pdf')] })),
    )
    render(<SkillsPage />)
    const results = await searchFor()
    fireEvent.click(within(results).getByRole('button', { name: 'Add PDF by awspace' }))
    const sheet = await screen.findByRole('dialog', { name: 'PDF' })
    expect(await within(sheet).findByRole('list', { name: 'What to know' })).toHaveTextContent('You already have a skill called “pdf”. Adding this one replaces it')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Replace and add' }))
    expect(await screen.findByText('Added PDF. Every agent can use it now.')).toBeInTheDocument()
    expect(sent.find((request) => request.url === '/api/skills/install')?.body).toEqual({ token: 'tok', paths: ['.'], replace: true })
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('asks before replacing when the name was taken since the look', async () => {
    daemon(
      on('GET', '/api/skills', () => folder([])),
      searching(),
      on('POST', '/api/skills/install/inspect', () => json(inspection())),
      on('POST', '/api/skills/install', (request) => (request.body?.replace ? json({ installed: [record('pdf')] }) : json({ error: '“pdf” is already in LoomWatch. Replace it?' }, 409))),
    )
    render(<SkillsPage />)
    const results = await searchFor()
    fireEvent.click(within(results).getByRole('button', { name: 'Add PDF by awspace' }))
    const sheet = await screen.findByRole('dialog', { name: 'PDF' })
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Add skill' }))
    expect(await within(sheet).findByText('“pdf” is already in LoomWatch. Replace it?')).toBeInTheDocument()
    expect(within(sheet).queryByRole('alert')).toBeNull()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Replace' }))
    expect(await screen.findByText('Added PDF. Every agent can use it now.')).toBeInTheDocument()
  })

  it('lets you pick from a collection, with restricted skills locked', async () => {
    const sent = daemon(
      on('GET', '/api/skills', () => folder([record('brand')])),
      on('POST', '/api/skills/install/inspect', () => json(inspection({
        source: 'github', title: 'acme/skills', notes: ['2 links in the download were left out.'],
        candidates: [
          found('brand', { conflict: true }),
          found('meeting-notes'),
          found('docx', { license: { id: 'All rights reserved', restricted: true }, restricted: true, reason: '“docx”’s license says “All rights reserved”, so it can’t be copied into LoomWatch.' }),
        ],
      }))),
      on('POST', '/api/skills/install', (request) => json({ installed: ((request.body?.paths ?? []) as string[]).map((path) => record(path.split('/').pop()!)) })),
    )
    render(<SkillsPage />)
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Find skills' }), { target: { value: 'acme/skills' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look inside' }))
    const sheet = await screen.findByRole('dialog', { name: 'acme/skills' })
    expect(sheet).toHaveTextContent('It holds 3 skills. Tick the ones you want.')
    expect(sheet).toHaveTextContent('2 links in the download were left out.')
    const list = within(sheet).getByRole('list', { name: 'Skills inside' })
    expect(within(list).getAllByRole('checkbox').every((box) => box.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(within(list).getByRole('checkbox', { name: /DOCX/ })).toBeDisabled()
    expect(within(sheet).getByRole('button', { name: 'Add 0 skills' })).toBeDisabled()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Select all 2' }))
    expect(sheet).toHaveTextContent('Replaces your “brand”.')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add 2 skills' }))
    expect(await screen.findByText('Added 2 skills. Every agent can use them now.')).toBeInTheDocument()
    expect(sent.find((request) => request.url === '/api/skills/install')?.body).toEqual({ token: 'tok', paths: ['skills/brand', 'skills/meeting-notes'], replace: true })
  })

  it('closes on Escape without adding anything', async () => {
    const sent = daemon(on('GET', '/api/skills', () => folder([])), searching(), on('POST', '/api/skills/install/inspect', () => json(inspection())))
    render(<SkillsPage />)
    const results = await searchFor()
    fireEvent.click(within(results).getByRole('button', { name: 'Add PDF by awspace' }))
    const sheet = await screen.findByRole('dialog', { name: 'PDF' })
    await within(sheet).findByRole('button', { name: 'Add skill' })
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sent.some((request) => request.url === '/api/skills/install')).toBe(false)
  })
})

describe('Your skills', () => {
  it('lists each skill on the shelf, opens it for details and asks before removing', async () => {
    let skills = [record('brand-guidelines', { runtimes: ['node'], hasScripts: true, needs: ['subagents', 'scripts'] }), record('notes', { origin: { kind: 'brought_in', app: 'Codex' }, license: { restricted: false } })]
    const sent = daemon(
      on('GET', '/api/skills', () => folder(skills)),
      on('DELETE', '/api/skills/brand-guidelines', () => { skills = skills.slice(1); return json({ removed: 'brand-guidelines' }) }),
    )
    render(<SkillsPage />)
    const shelf = await screen.findByRole('list', { name: 'Your skills' })
    const [brand, notes] = within(shelf).getAllByRole('listitem')
    expect(brand).toHaveTextContent('Brand guidelines')
    expect(brand).toHaveTextContent('GitHub')
    expect(notes).toHaveTextContent('Codex')
    expect(screen.getByText('~/Library/Application Support/LoomWatch/skills')).toBeInTheDocument()

    fireEvent.click(within(brand).getByRole('button', { name: /Brand guidelines/ }))
    expect(brand).toHaveTextContent('Installed from GitHub')
    expect(brand).toHaveTextContent('MIT')
    expect(brand).toHaveTextContent('Needs Node')
    expect(brand).toHaveTextContent('Uses helper agents')
    expect(within(brand).getByRole('link', { name: 'Open its page' })).toHaveAttribute('href', 'https://github.com/acme/skills/tree/abc/skills/pdf')

    fireEvent.click(within(brand).getByRole('button', { name: 'Remove Brand guidelines' }))
    expect(sent.some((request) => request.method === 'DELETE')).toBe(false)
    fireEvent.click(within(within(brand).getByRole('group', { name: 'Remove Brand guidelines?' })).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your skills' })).getAllByRole('listitem')).toHaveLength(1))
    expect(sent.find((request) => request.method === 'DELETE')?.header).toBe('1')
  })

  it('says when the skills can’t be read, and tries again', async () => {
    let fail = true
    daemon(on('GET', '/api/skills', () => (fail ? json({ error: 'LoomWatch couldn’t update its skills folder: denied' }, 500) : folder([]))))
    render(<SkillsPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('denied')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument()
  })
})

describe('skills you already have', () => {
  it('looks only when asked, ticks what can come in, locks the rest with the reason, then brings in and undoes', async () => {
    let skills: SkillRecord[] = []
    const sent = daemon(
      on('GET', '/api/skills', () => folder(skills)),
      on('POST', '/api/skills/bring-in/preview', () => json({ candidates: [
        candidate('writer', { runtimes: ['python'], hasScripts: true }),
        candidate('secret', { restricted: true, license: { id: 'Proprietary', restricted: true }, reason: '“secret”’s license says “All rights reserved”, so it can’t be copied into LoomWatch.', defaultSelected: false }),
        candidate('review', { plugin: 'engineering' }),
        candidate('notes', { app: 'Codex', alreadyInLoomWatch: true, defaultSelected: false }),
      ] })),
      on('POST', '/api/skills/bring-in', () => {
        skills = [record('writer', { origin: { kind: 'brought_in', app: 'Claude Code' }, batchId: 'b1' })]
        return json({ batchId: 'b1', imported: skills, skipped: [{ name: 'review', reason: 'A skill named “review” is already in LoomWatch.' }] })
      }),
      on('POST', '/api/skills/bring-in/b1/undo', () => { skills = []; return json({ removed: ['writer'] }) }),
    )
    render(<SkillsPage />)
    await screen.findByText(/Nothing here yet/)
    expect(sent.some((request) => request.url.includes('bring-in'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Look on this computer' }))
    const sheet = await screen.findByRole('dialog', { name: 'Skills from your apps' })
    const claude = await within(sheet).findByRole('region', { name: 'Claude Code' })
    expect(within(sheet).getByRole('region', { name: 'Codex' })).toHaveTextContent('You already have it in LoomWatch.')
    expect(within(claude).getByRole('checkbox', { name: /Writer/ })).toHaveAttribute('aria-checked', 'true')
    const secret = within(claude).getByRole('checkbox', { name: /Secret/ })
    expect(secret).toBeDisabled()
    expect(secret.closest('li')).toHaveTextContent('can’t be copied into LoomWatch')
    expect(within(claude).getByRole('checkbox', { name: /Review/ }).closest('li')).toHaveTextContent('engineering plugin')

    fireEvent.click(within(claude).getByRole('checkbox', { name: /Review/ }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Bring in 1 skill' }))
    expect(await within(sheet).findByText('Brought in 1 skill. Every agent can use it now.')).toBeInTheDocument()
    expect(sent.find((request) => request.url === '/api/skills/bring-in')?.body).toEqual({ keys: ['key-writer'] })
    expect(sent.find((request) => request.url === '/api/skills/bring-in')?.header).toBe('1')
    expect(sheet).toHaveTextContent('Review: A skill named “review” is already in LoomWatch.')
    expect(await screen.findByRole('list', { name: 'Your skills' })).toHaveTextContent('Writer')

    fireEvent.click(within(sheet).getByRole('button', { name: 'Undo' }))
    expect(await within(sheet).findByText('Took back 1 skill.')).toBeInTheDocument()
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument()
  })
})

describe('the page’s words', () => {
  it('never asks anyone to sign in to an app', async () => {
    daemon(
      on('GET', '/api/skills', () => folder([record('pdf')])),
      searching(),
      on('POST', '/api/skills/bring-in/preview', () => json({ candidates: [candidate('writer')] })),
    )
    render(<SkillsPage />)
    await searchFor()
    fireEvent.click(screen.getByRole('button', { name: 'Look on this computer' }))
    await screen.findByRole('checkbox', { name: /Writer/ })
    expect(document.body.textContent).not.toMatch(/sign[ -]?in|log[ -]?in|subscription|account/i)
  })
})

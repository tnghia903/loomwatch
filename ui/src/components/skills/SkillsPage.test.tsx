import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BringInCandidate, InstallCandidate, Inspection, SkillRecord } from '../../lib/library/skillStore'
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

const candidate = (name: string, extra: Partial<BringInCandidate> = {}): BringInCandidate => ({
  key: `key-${name}`, name, description: `Does ${name} things.`, app: 'Claude Code', path: `/Users/me/.claude/skills/${name}`, license: { restricted: false },
  restricted: false, needs: [], runtimes: [], hasScripts: false, sizeBytes: 1024, fileCount: 1, alreadyInLoomWatch: false, defaultSelected: true, ...extra,
})

const found = (name: string, extra: Partial<InstallCandidate> = {}): InstallCandidate => ({
  path: `skills/${name}`, name, description: `Does ${name} things.`, license: { id: 'MIT', restricted: false }, restricted: false,
  files: ['SKILL.md'], hasScripts: false, runtimes: [], needs: [], sizeBytes: 900, conflict: false, ...extra,
})

const folder = (skills: SkillRecord[]) => json({ folder: '/Users/me/Library/Application Support/LoomWatch/skills', skills })

describe('Your skills', () => {
  it('lists each skill with where it came from, its license and what it needs', async () => {
    daemon(on('GET', '/api/skills', () => folder([
      record('pdf', { runtimes: ['node'], hasScripts: true, needs: ['subagents', 'scripts'] }),
      record('notes', { origin: { kind: 'brought_in', app: 'Codex' }, license: { restricted: false }, runtimes: ['python'] }),
    ])))
    render(<SkillsPage />)
    const list = await screen.findByRole('list', { name: 'Your skills' })
    const [pdf, notes] = within(list).getAllByRole('listitem')
    expect(pdf).toHaveTextContent('Installed from GitHub')
    expect(pdf).toHaveTextContent('License: MIT')
    expect(pdf).toHaveTextContent('Needs Node')
    expect(pdf).toHaveTextContent('Uses helper agents')
    expect(pdf).not.toHaveTextContent('Runs scripts')
    expect(within(pdf).getByRole('link', { name: 'Open its page' })).toHaveAttribute('href', 'https://github.com/acme/skills/tree/abc/skills/pdf')
    expect(notes).toHaveTextContent('Brought in from Codex')
    expect(notes).toHaveTextContent('No license given')
    expect(notes).toHaveTextContent('Needs Python')
    expect(screen.getByText('~/Library/Application Support/LoomWatch/skills')).toBeInTheDocument()
  })

  it('asks before removing, then removes with the change header', async () => {
    let skills = [record('pdf')]
    const sent = daemon(
      on('GET', '/api/skills', () => folder(skills)),
      on('DELETE', '/api/skills/pdf', () => { skills = []; return json({ removed: 'pdf' }) }),
    )
    render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove pdf' }))
    const asking = screen.getByRole('group', { name: 'Remove pdf?' })
    expect(sent.some((request) => request.method === 'DELETE')).toBe(false)
    fireEvent.click(within(asking).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText(/No skills yet/)).toBeInTheDocument()
    expect(sent.find((request) => request.method === 'DELETE')?.header).toBe('1')
  })

  it('says when the skills can’t be read, and tries again', async () => {
    let fail = true
    daemon(on('GET', '/api/skills', () => (fail ? json({ error: 'LoomWatch couldn’t update its skills folder: denied' }, 500) : folder([]))))
    render(<SkillsPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('denied')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/No skills yet/)).toBeInTheDocument()
  })
})

describe('Bring in from your apps', () => {
  it('looks only when asked, ticks what can come in, locks the rest with the reason, then imports and undoes', async () => {
    let skills: SkillRecord[] = []
    const sent = daemon(
      on('GET', '/api/skills', () => folder(skills)),
      on('POST', '/api/skills/bring-in/preview', () => json({ candidates: [
        candidate('writer', { runtimes: ['python'], hasScripts: true }),
        candidate('secret', { restricted: true, license: { id: 'Proprietary', restricted: true }, reason: '“secret”’s license says “All rights reserved”, so it can’t be copied into LoomWatch.', defaultSelected: false }),
        candidate('review', { app: 'Claude Code', plugin: 'engineering' }),
        candidate('notes', { alreadyInLoomWatch: true, defaultSelected: false }),
      ] })),
      on('POST', '/api/skills/bring-in', (request) => {
        skills = [record('writer', { origin: { kind: 'brought_in', app: 'Claude Code' }, batchId: 'b1' })]
        return json({ batchId: 'b1', imported: skills, skipped: [{ name: 'review', reason: 'A skill named “review” is already in LoomWatch.' }], echo: request.body })
      }),
      on('POST', '/api/skills/bring-in/b1/undo', () => { skills = []; return json({ removed: ['writer'] }) }),
    )
    render(<SkillsPage />)
    await screen.findByText(/No skills yet/)
    expect(sent.some((request) => request.url.includes('bring-in'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Look for skills' }))
    const list = await screen.findByRole('list', { name: 'Skills in your apps' })
    expect(within(list).getByRole('checkbox', { name: /writer/ })).toHaveAttribute('aria-checked', 'true')
    const secret = within(list).getByRole('checkbox', { name: /secret/ })
    expect(secret).toBeDisabled()
    expect(secret).toHaveAttribute('aria-checked', 'false')
    expect(secret.closest('li')).toHaveTextContent('can’t be copied into LoomWatch')
    expect(within(list).getByRole('checkbox', { name: /review/ })).toHaveTextContent('From Claude Code, engineering plugin')
    expect(within(list).getByRole('checkbox', { name: /notes/ }).closest('li')).toHaveTextContent('Already in LoomWatch.')
    expect(within(list).getByRole('checkbox', { name: /writer/ }).closest('li')).toHaveTextContent('Needs Python')

    fireEvent.click(within(list).getByRole('checkbox', { name: /review/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Bring in 1 skill' }))
    const done = await screen.findByText('Brought in 1 skill.')
    expect(sent.find((request) => request.url === '/api/skills/bring-in')?.body).toEqual({ keys: ['key-writer'] })
    expect(sent.find((request) => request.url === '/api/skills/bring-in')?.header).toBe('1')
    expect(done.closest('[role=status]')).toHaveTextContent('review: A skill named “review” is already in LoomWatch.')
    expect(await screen.findByRole('list', { name: 'Your skills' })).toHaveTextContent('writer')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Took back 1 skill.')).toBeInTheDocument()
    expect(await screen.findByText(/No skills yet/)).toBeInTheDocument()
  })
})

describe('Install skills', () => {
  const inspection = (extra: Partial<Inspection> = {}): Inspection => ({
    token: 'tok', source: 'skills.sh', title: 'pdf from acme/skills', url: 'https://skills.sh/acme/skills/pdf', notes: [],
    candidates: [found('pdf', { conflict: true, hasScripts: true, runtimes: ['node'], files: ['SKILL.md', 'scripts/fill.js'] })], ...extra,
  })

  it('searches through LoomWatch, shows what’s inside, and asks before replacing', async () => {
    let skills = [record('pdf')]
    const sent = daemon(
      on('GET', '/api/skills', () => folder(skills)),
      on('GET', '/api/skills/search?q=pdf&source=skills.sh', () => json({ results: [
        { source: 'skills.sh', id: 'acme/skills/pdf', name: 'pdf', installs: 211908, url: 'https://skills.sh/acme/skills/pdf', ref: 'acme/skills/pdf' },
      ] })),
      on('POST', '/api/skills/install/inspect', () => json(inspection())),
      on('POST', '/api/skills/install', (request) => {
        skills = [record('pdf', { origin: { kind: 'installed', source: 'skills.sh' } })]
        return json({ installed: skills, echo: request.body })
      }),
    )
    render(<SkillsPage />)
    fireEvent.change(await screen.findByLabelText('Search skills.sh'), { target: { value: 'pdf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const results = await screen.findByRole('list', { name: 'Search results' })
    expect(results).toHaveTextContent('211,908 installs')
    expect(sent.every((request) => request.url.startsWith('/api/'))).toBe(true)

    fireEvent.click(within(results).getByRole('button', { name: 'Look inside pdf' }))
    const inside = await screen.findByRole('group', { name: 'Inside pdf from acme/skills' })
    expect(sent.find((request) => request.url === '/api/skills/install/inspect')?.body).toEqual({ ref: 'acme/skills/pdf', source: 'skills.sh' })
    const pdf = within(inside).getByRole('checkbox', { name: /pdf/ })
    expect(pdf).toHaveAttribute('aria-checked', 'true')
    const row = pdf.closest('li')!
    expect(row).toHaveTextContent('License: MIT')
    expect(row).toHaveTextContent('Needs Node')
    expect(row).toHaveTextContent('Nothing runs while it installs')
    expect(row).toHaveTextContent('2 files')
    expect(row).toHaveTextContent('scripts/fill.js')
    expect(row).toHaveTextContent('already in LoomWatch')

    fireEvent.click(within(inside).getByRole('button', { name: 'Install 1 skill' }))
    const asking = await screen.findByRole('group', { name: 'Replace skills?' })
    expect(asking).toHaveTextContent('“pdf” is already in LoomWatch. Replace it?')
    expect(sent.some((request) => request.url === '/api/skills/install')).toBe(false)
    fireEvent.click(within(asking).getByRole('button', { name: 'Replace' }))
    expect(await screen.findByText('Installed pdf.')).toBeInTheDocument()
    const install = sent.find((request) => request.url === '/api/skills/install')!
    expect(install.body).toEqual({ token: 'tok', paths: ['skills/pdf'], replace: true })
    expect(install.header).toBe('1')
    expect(await screen.findByRole('list', { name: 'Your skills' })).toHaveTextContent('Installed from skills.sh')
  })

  it('takes a pasted GitHub link, locks restricted skills and lets the person pick from many', async () => {
    const sent = daemon(
      on('GET', '/api/skills', () => folder([])),
      on('POST', '/api/skills/install/inspect', () => json(inspection({
        source: 'github', title: 'acme/skills', url: 'https://github.com/acme/skills/tree/abc', notes: ['2 links in the download were left out.'],
        candidates: [
          found('docx'),
          found('locked', { restricted: true, license: { id: 'All rights reserved', restricted: true }, reason: '“locked”’s license says “All rights reserved”, so it can’t be copied into LoomWatch.' }),
        ],
      }))),
      on('POST', '/api/skills/install', () => json({ installed: [record('docx')] })),
    )
    render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('radio', { name: 'GitHub link' }))
    fireEvent.change(screen.getByLabelText('Paste a GitHub link'), { target: { value: ' github.com/acme/skills ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look inside' }))
    const inside = await screen.findByRole('group', { name: 'Inside acme/skills' })
    expect(sent.find((request) => request.url === '/api/skills/install/inspect')?.body).toEqual({ ref: 'github.com/acme/skills' })
    expect(inside).toHaveTextContent('2 links in the download were left out.')
    expect(within(inside).getByRole('button', { name: 'Install 0 skills' })).toBeDisabled()
    expect(within(inside).getByRole('checkbox', { name: /locked/ })).toBeDisabled()
    fireEvent.click(within(inside).getByRole('checkbox', { name: /docx/ }))
    fireEvent.click(within(inside).getByRole('button', { name: 'Install 1 skill' }))
    expect(await screen.findByText('Installed docx.')).toBeInTheDocument()
    expect(sent.find((request) => request.url === '/api/skills/install')?.body).toEqual({ token: 'tok', paths: ['skills/docx'], replace: false })
  })

  it('asks when the daemon finds the name taken since the look', async () => {
    daemon(
      on('GET', '/api/skills', () => folder([])),
      on('POST', '/api/skills/install/inspect', () => json(inspection({ candidates: [found('pdf')] }))),
      on('POST', '/api/skills/install', (request) => (request.body?.replace ? json({ installed: [record('pdf')] }) : json({ error: '“pdf” is already in LoomWatch. Replace it?' }, 409))),
    )
    render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('radio', { name: 'GitHub link' }))
    fireEvent.change(screen.getByLabelText('Paste a GitHub link'), { target: { value: 'acme/skills' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look inside' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install 1 skill' }))
    const asking = await screen.findByRole('group', { name: 'Replace skills?' })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(within(asking).getByRole('button', { name: 'Replace' }))
    expect(await screen.findByText('Installed pdf.')).toBeInTheDocument()
  })
})

describe('the page’s words', () => {
  it('never asks anyone to sign in to an app', async () => {
    daemon(
      on('GET', '/api/skills', () => folder([])),
      on('POST', '/api/skills/bring-in/preview', () => json({ candidates: [candidate('writer')] })),
    )
    const { container } = render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Look for skills' }))
    await screen.findByRole('list', { name: 'Skills in your apps' })
    await waitFor(() => expect(container.textContent).not.toMatch(/sign[ -]?in|log[ -]?in|subscription|account/i))
  })
})

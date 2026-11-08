import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SkillRecord, SkillWords } from '../../lib/library/skillStore'
import { SkillSheet } from './SkillSheet'
import { SkillsPage } from './SkillsPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Sent = { method: string; url: string; body?: Record<string, unknown>; header?: string }

/** The daemon, answering by method and path; every request is kept. */
function daemon(answer: (sent: Sent) => Response | undefined) {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const request: Sent = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, header: headers['X-LoomWatch-Request'] }
    sent.push(request)
    return answer(request) ?? json({ error: `no route for ${request.method} ${request.url}` }, 404)
  }))
  return sent
}

const record = (name: string, extra: Partial<SkillRecord> = {}): SkillRecord => ({
  name, description: `Does ${name} things.`, origin: { kind: 'installed', source: 'github', ref: 'acme/skills' },
  license: { id: 'MIT', restricted: false }, needs: [], runtimes: [], hasScripts: false, sizeBytes: 2048, sha256: 'f'.repeat(64), addedAt: '2026-10-17T00:00:00Z', ...extra,
})

const folder = (skills: SkillRecord[]) => json({ folder: '/Users/me/LoomWatch/skills', skills })

const PDF_WORDS: SkillWords = {
  name: 'pdf', description: 'Fills in PDF forms.', instructions: '# PDF\n\nRun scripts/fill.py.\nCheck every field.', files: ['scripts/fill.py'], base: 'base-1',
}

const sheet = () => screen.getByRole('dialog')

describe('writing a new skill', () => {
  it('writes it from the person’s words, and saves it only when they say', async () => {
    let skills: SkillRecord[] = []
    const sent = daemon((request) => {
      if (request.method === 'GET' && request.url === '/api/skills') return folder(skills)
      if (request.method === 'POST' && request.url === '/api/ask/skill') {
        return json({ title: 'Weekly client update', description: 'Writes the weekly update for a client.', instructions: '1. Read the notes.\n2. Write three bullets.\n3. Sign it Mai.', appName: 'Ask LoomWatch' })
      }
      if (request.method === 'PUT' && request.url === '/api/skills/words') {
        skills = [record('weekly-client-update', { origin: { kind: 'written' }, description: String(request.body?.description) })]
        return json({ skill: skills[0], base: 'base-new' })
      }
      return undefined
    })
    render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }))
    const save = within(sheet()).getByRole('button', { name: 'Save skill' })
    expect(save).toBeDisabled()

    fireEvent.change(within(sheet()).getByLabelText('What should your agents know how to do?'), { target: { value: 'My weekly client update: three bullets, signed Mai.' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Write it' }))
    await waitFor(() => expect(within(sheet()).getByLabelText('What to do')).toHaveValue('1. Read the notes.\n2. Write three bullets.\n3. Sign it Mai.'))
    const asked = sent.find((request) => request.url === '/api/ask/skill')
    expect(asked?.body).toEqual({ words: 'My weekly client update: three bullets, signed Mai.' })
    expect(within(sheet()).getByLabelText('Name')).toHaveValue('Weekly client update')
    expect(within(sheet()).getByLabelText('When to use it')).toHaveValue('Writes the weekly update for a client.')
    // Nothing is saved by writing it.
    expect(sent.some((request) => request.method === 'PUT')).toBe(false)
    // The box now changes what was written.
    expect(within(sheet()).getByLabelText('What should change?')).toHaveValue('')

    fireEvent.click(save)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const put = sent.find((request) => request.method === 'PUT')
    expect(put?.header).toBe('1')
    expect(put?.body).toEqual({
      name: 'weekly-client-update',
      description: 'Writes the weekly update for a client.',
      instructions: '1. Read the notes.\n2. Write three bullets.\n3. Sign it Mai.',
    })
    expect(await screen.findByText('Saved “Weekly client update”. Every agent can use it now.')).toBeTruthy()
    expect(await screen.findByText('Written by you')).toBeTruthy()
    // A skill you wrote has no license to show.
    fireEvent.click(within(screen.getByRole('list', { name: 'My skills' })).getByRole('button', { name: /^Weekly client update/ }))
    expect(screen.getByText('Size')).toBeTruthy()
    expect(screen.queryByText('License')).toBeNull()
  })

  it('can be written by hand, says what is missing, and asks before losing it', async () => {
    daemon((request) => (request.method === 'GET' && request.url === '/api/skills' ? folder([record('weekly')]) : undefined))
    render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }))
    fireEvent.change(within(sheet()).getByLabelText('Name'), { target: { value: '!!!' } })
    expect(within(sheet()).getByText('Give it a name with letters or numbers in it.')).toBeTruthy()
    fireEvent.change(within(sheet()).getByLabelText('Name'), { target: { value: 'Tidy notes' } })
    expect(within(sheet()).getByText('Say when your agents should use it.')).toBeTruthy()
    fireEvent.change(within(sheet()).getByLabelText('When to use it'), { target: { value: 'Tidies meeting notes.' } })
    expect(within(sheet()).getByText('Say what your agents should do.')).toBeTruthy()
    expect(within(sheet()).getByRole('button', { name: 'Save skill' })).toBeDisabled()

    // Escape doesn't throw away what was typed: it asks first.
    fireEvent.keyDown(sheet(), { key: 'Escape' })
    expect(within(sheet()).getByText('Leave without saving? What you wrote here will be lost.')).toBeTruthy()
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Keep writing' }))
    expect(within(sheet()).getByLabelText('When to use it')).toHaveValue('Tidies meeting notes.')
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Leave' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    // Words typed in the top box and not yet used are something to lose too.
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }))
    fireEvent.change(within(sheet()).getByLabelText('What should your agents know how to do?'), { target: { value: 'My weekly update' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }))
    expect(within(sheet()).getByText('Leave without saving? What you wrote here will be lost.')).toBeTruthy()
  })

  it('shows a name as it will show once saved, and says so when it is taken', async () => {
    daemon((request) => {
      if (request.method === 'GET' && request.url === '/api/skills') return folder([record('mais-report')])
      if (request.method === 'PUT') return json({ error: 'You already have a skill named “mais-report”. Give this one another name.' }, 409)
      return undefined
    })
    render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }))
    const name = within(sheet()).getByLabelText('Name')
    fireEvent.change(name, { target: { value: "Mai's report" } })
    fireEvent.change(within(sheet()).getByLabelText('When to use it'), { target: { value: 'Writes Mai’s report.' } })
    fireEvent.change(within(sheet()).getByLabelText('What to do'), { target: { value: 'Write it.' } })
    // Saved straight from the name box, the taken name is still said as it shows.
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save skill' }))
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('You already have a skill called “Mais report”. Give this one another name.')
    fireEvent.blur(name)
    expect(name).toHaveValue('Mais report')
  })

  it('says why LoomWatch couldn’t write it, and the fields still work', async () => {
    daemon((request) => {
      if (request.method === 'GET' && request.url === '/api/skills') return folder([])
      if (request.url === '/api/ask/skill') return json({ error: 'Connect an AI first, and LoomWatch can write it for you. You can write it yourself below.' }, 503)
      return undefined
    })
    render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }))
    fireEvent.change(within(sheet()).getByLabelText('What should your agents know how to do?'), { target: { value: 'Tidy notes' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Write it' }))
    expect(await within(sheet()).findByText(/Connect an AI first/)).toBeTruthy()
    expect(within(sheet()).getByLabelText('What to do')).not.toBeDisabled()
  })
})

describe('changing a skill', () => {
  it('shows what LoomWatch changed, puts it back, and saves from the words it opened', async () => {
    let words = PDF_WORDS
    const sent = daemon((request) => {
      if (request.method === 'GET' && request.url === '/api/skills') return folder([record('pdf')])
      if (request.method === 'GET' && request.url === '/api/skills/words?name=pdf') return json(words)
      if (request.method === 'POST' && request.url === '/api/ask/skill') {
        return json({ description: 'Fills in PDF forms.', instructions: '# PDF\n\nRun scripts/fill.py.\nCheck every field twice.' })
      }
      if (request.method === 'PUT' && request.url === '/api/skills/words') {
        const previous = words
        words = { ...words, description: String(request.body?.description), instructions: String(request.body?.instructions), base: 'base-2' }
        return json({ skill: record('pdf', { changedAt: '2026-11-08T00:00:00Z' }), base: 'base-2', previous })
      }
      return undefined
    })
    render(<SkillsPage />)
    fireEvent.click(within(await screen.findByRole('list', { name: 'My skills' })).getByRole('button', { name: /^PDF/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Change PDF' }))
    await waitFor(() => expect(within(sheet()).getByLabelText('What to do')).toHaveValue(PDF_WORDS.instructions))
    // Nothing changed yet: nothing to save.
    expect(within(sheet()).getByRole('button', { name: 'Save skill' })).toBeDisabled()

    fireEvent.change(within(sheet()).getByLabelText('What should change?'), { target: { value: 'Check twice' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Change it' }))
    const changed = await within(sheet()).findByRole('region', { name: 'What LoomWatch changed' })
    expect(sent.find((request) => request.url === '/api/ask/skill')?.body).toEqual({
      words: 'Check twice', skill: { description: PDF_WORDS.description, instructions: PDF_WORDS.instructions },
    })
    expect([...changed.querySelectorAll('ins')].map((part) => part.textContent).join('')).toContain('twice')
    expect(changed.querySelectorAll('del, ins').length).toBeGreaterThan(0)
    expect(within(sheet()).getByLabelText('What to do').className).toContain('instructions-marked')

    fireEvent.click(within(changed).getByRole('button', { name: 'Put back' }))
    expect(within(sheet()).getByLabelText('What to do')).toHaveValue(PDF_WORDS.instructions)
    expect(within(sheet()).queryByRole('region', { name: 'What LoomWatch changed' })).toBeNull()

    fireEvent.change(within(sheet()).getByLabelText('What to do'), { target: { value: '# PDF\n\nRun scripts/fill.py.' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save skill' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const put = sent.filter((request) => request.method === 'PUT')
    expect(put[0].body).toEqual({ name: 'pdf', description: PDF_WORDS.description, instructions: '# PDF\n\nRun scripts/fill.py.', base: 'base-1' })

    // Undo saves the old words over the new, from the new base.
    const toast = await screen.findByText('Saved “PDF”. Your agents use the new words from now on.')
    fireEvent.click(within(toast.parentElement!).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(sent.filter((request) => request.method === 'PUT')).toHaveLength(2))
    expect(sent.filter((request) => request.method === 'PUT')[1].body).toEqual({ name: 'pdf', description: PDF_WORDS.description, instructions: PDF_WORDS.instructions, base: 'base-2' })
    expect(await screen.findByText('Put back “PDF” as it was.')).toBeTruthy()
  })

  it('says so when the skill changed since it was opened', async () => {
    daemon((request) => {
      if (request.method === 'GET' && request.url === '/api/skills') return folder([record('pdf')])
      if (request.url === '/api/skills/words?name=pdf') return json(PDF_WORDS)
      if (request.method === 'PUT') return json({ error: '“pdf” changed since you opened it. Close it and open it again to see the change.' }, 409)
      return undefined
    })
    render(<SkillsPage />)
    fireEvent.click(within(await screen.findByRole('list', { name: 'My skills' })).getByRole('button', { name: /^PDF/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Change PDF' }))
    await waitFor(() => expect(within(sheet()).getByLabelText('When to use it')).toHaveValue(PDF_WORDS.description))
    fireEvent.change(within(sheet()).getByLabelText('When to use it'), { target: { value: 'Fills in any PDF form.' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save skill' }))
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('changed since you opened it')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('opens a change proposed elsewhere as one, with Put back, and saves it from the words it read', async () => {
    const sent = daemon((request) => {
      if (request.method === 'GET' && request.url === '/api/skills') return folder([record('pdf')])
      if (request.url === '/api/skills/words?name=pdf') return json(PDF_WORDS)
      if (request.method === 'PUT') return json({ skill: record('pdf'), base: 'base-2', previous: PDF_WORDS })
      return undefined
    })
    const onSaved = vi.fn()
    const proposed = { description: PDF_WORDS.description, instructions: `${PDF_WORDS.instructions}\nSend it back as a PDF.` }
    render(<SkillSheet writing={{ kind: 'change', name: 'pdf', proposed }} onClose={() => {}} onSaved={onSaved} />)
    await waitFor(() => expect(within(sheet()).getByLabelText('What to do')).toHaveValue(proposed.instructions))
    const changed = within(sheet()).getByRole('region', { name: 'What LoomWatch changed' })
    expect([...changed.querySelectorAll('ins')].map((part) => part.textContent).join('')).toContain('Send it back as a PDF.')
    fireEvent.click(within(changed).getByRole('button', { name: 'Put back' }))
    expect(within(sheet()).getByLabelText('What to do')).toHaveValue(PDF_WORDS.instructions)
    expect(within(sheet()).getByRole('button', { name: 'Save skill' })).toBeDisabled()
    fireEvent.change(within(sheet()).getByLabelText('What to do'), { target: { value: proposed.instructions } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save skill' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent.find((request) => request.method === 'PUT')?.body).toMatchObject({ name: 'pdf', base: 'base-1', instructions: proposed.instructions })
  })

  it('shows a proposed change before the box for more, and closes untouched without warning', async () => {
    daemon((request) => {
      if (request.method === 'GET' && request.url === '/api/skills') return folder([record('pdf')])
      if (request.url === '/api/skills/words?name=pdf') return json(PDF_WORDS)
      return undefined
    })
    const onClose = vi.fn()
    const proposed = { description: PDF_WORDS.description, instructions: `${PDF_WORDS.instructions}\nSend it back as a PDF.`, base: 'base-1' }
    const { unmount } = render(<SkillSheet writing={{ kind: 'change', name: 'pdf', proposed }} onClose={onClose} onSaved={() => {}} />)
    const marked = await within(sheet()).findByRole('region', { name: 'What LoomWatch changed' })
    const box = within(sheet()).getByLabelText('Anything else to change?')
    // The change comes first: the person asked for it already.
    expect(marked.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Leave without saving/)).toBeNull()
    unmount()

    // Touched, it is the person's own work, and leaving asks.
    const asked = vi.fn()
    render(<SkillSheet writing={{ kind: 'change', name: 'pdf', proposed }} onClose={asked} onSaved={() => {}} />)
    await waitFor(() => expect(within(sheet()).getByLabelText('What to do')).toHaveValue(proposed.instructions))
    fireEvent.change(within(sheet()).getByLabelText('What to do'), { target: { value: `${proposed.instructions}\nKeep it short.` } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }))
    expect(asked).not.toHaveBeenCalled()
    expect(within(sheet()).getByText('Leave without saving? What you wrote here will be lost.')).toBeTruthy()
    // Put back, the box asks what should change, and the marked change is gone.
    fireEvent.change(within(sheet()).getByLabelText('What to do'), { target: { value: proposed.instructions } })
    fireEvent.click(within(within(sheet()).getByRole('region', { name: 'What LoomWatch changed' })).getByRole('button', { name: 'Put back' }))
    expect(within(sheet()).getByLabelText('What should change?')).toBeTruthy()
  })

  it('opens a change made from words the skill no longer has as the skill is saved now, and says so', async () => {
    daemon((request) => {
      if (request.method === 'GET' && request.url === '/api/skills') return folder([record('pdf')])
      if (request.url === '/api/skills/words?name=pdf') return json(PDF_WORDS)
      return undefined
    })
    const made = { description: PDF_WORDS.description, instructions: 'Words from before.\nSend it back as a PDF.' }
    const { unmount } = render(<SkillSheet writing={{ kind: 'change', name: 'pdf', proposed: { ...made, base: 'base-0' } }} onClose={() => {}} onSaved={() => {}} />)
    expect(await within(sheet()).findByText('This skill was changed after Ask read it, so Ask’s change isn’t shown. Ask again for a new change.')).toBeTruthy()
    expect(within(sheet()).getByLabelText('What to do')).toHaveValue(PDF_WORDS.instructions)
    expect(within(sheet()).queryByRole('region', { name: 'What LoomWatch changed' })).toBeNull()
    expect(within(sheet()).getByRole('button', { name: 'Save skill' })).toBeDisabled()
    unmount()

    // Made from the words it has, it opens as the change.
    render(<SkillSheet writing={{ kind: 'change', name: 'pdf', proposed: { ...made, base: 'base-1' } }} onClose={() => {}} onSaved={() => {}} />)
    await waitFor(() => expect(within(sheet()).getByLabelText('What to do')).toHaveValue(made.instructions))
    expect(within(sheet()).queryByText(/changed after Ask read it/)).toBeNull()
  })
})

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { SKILLS_CHANGED_EVENT, type DetectedCapability } from '../../lib/library/client'
import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import type { SkillRecord } from '../../lib/library/skillStore'
import { ByHand } from './ByHand'
import { openBenchRows } from '../../test/benchRows'

// Each setting is a row that opens; these tests are about the editors inside them.
openBenchRows()

// The bench's 3D figure is beside the point here.
vi.mock('./AgentFigure', () => ({ default: () => null }))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const catalog = { fetchedAt: '2026-10-17T00:00:00Z', defaultModel: 'anthropic/claude-opus-5.5', recommended: [], models: [] }

const record = (name: string): SkillRecord => ({
  name, description: `Does ${name} things.`, origin: { kind: 'installed', source: 'clawhub', ref: `awspace/${name}` },
  license: { id: 'MIT', restricted: false }, needs: [], runtimes: [], hasScripts: false, sizeBytes: 2048, sha256: 'f'.repeat(64), addedAt: '2026-10-17T00:00:00Z',
})

/** The daemon: LoomWatch's skills folder (empty to start), the two sites' search and an install of "pdf". */
let skills: SkillRecord[] = []
let sent: { method: string; url: string }[] = []
beforeEach(() => {
  forgetModels()
  skills = []
  sent = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    sent.push({ method, url })
    if (method === 'GET' && url === '/api/skills') return json({ folder: '/Users/me/Library/Application Support/LoomWatch/skills', skills })
    if (method === 'GET' && url.startsWith('/api/skills/search?')) {
      const source = new URLSearchParams(url.split('?')[1]).get('source')
      return json({ results: source === 'clawhub' ? [{ source: 'clawhub', id: 'awspace/pdf', name: 'pdf', url: 'https://clawhub.ai/awspace/pdf', ref: 'awspace/pdf', installs: 50624 }] : [] })
    }
    if (method === 'POST' && url === '/api/skills/install/inspect') {
      return json({ token: 'tok', source: 'clawhub', title: 'awspace/pdf', url: 'https://clawhub.ai/awspace/skills/pdf', notes: [], candidates: [{ path: '.', name: 'pdf', description: 'Fills PDF forms.', license: { id: 'MIT', restricted: false }, restricted: false, files: ['SKILL.md'], hasScripts: false, runtimes: [], needs: [], sizeBytes: 900, conflict: false }] })
    }
    if (method === 'POST' && url === '/api/skills/install') { skills = [record('pdf')]; return json({ installed: skills }) }
    if (method === 'DELETE' && url === '/api/skills/pdf') { skills = []; return json({ removed: 'pdf' }) }
    return json(catalog)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The bench with its draft kept, as the builder keeps it, so a pinned-up skill shows. */
function Bench({ start, available = [], readOnly = false, onSet }: { start: Partial<AgentDraft>; available?: DetectedCapability[]; readOnly?: boolean; onSet?: (key: string, value: unknown) => void }) {
  const [draft, setDraft] = useState<AgentDraft>({ ...BLANK_DRAFT, ...start })
  return <ByHand draft={draft} set={(key, value) => { onSet?.(key, value); setDraft((current) => ({ ...current, [key]: value })) }} skills={available} skillsLoading={false} readOnly={readOnly} roleField={createRef()} figure={{ kind: 'yarn', color: 'sage' }} record={null} />
}

const skillsBlock = () => screen.getByRole('region', { name: 'Skills' })

async function addPdf(market: HTMLElement) {
  fireEvent.click(await within(market).findByRole('button', { name: /^Add PDF/ }))
  const sheet = await screen.findByRole('dialog', { name: 'PDF' })
  fireEvent.click(within(sheet).getByRole('button', { name: 'Add skill' }))
  expect(await screen.findByText('Added PDF. Every agent can use it now.')).toBeInTheDocument()
}

describe('By hand: skills from the marketplace', () => {
  it('opens the marketplace over the bench, and pins up what was added there on the way back', async () => {
    const onSet = vi.fn()
    render(<Bench start={{ name: 'Reader', instructions: 'Read the forms.' }} onSet={onSet} />)
    expect(skillsBlock()).toHaveTextContent('LoomWatch has none to give yet, so find some in the marketplace.')

    // Typed in the shelf and found nothing: the marketplace opens searching for it.
    fireEvent.change(within(skillsBlock()).getByRole('textbox', { name: 'Find a skill' }), { target: { value: 'pdf' } })
    const open = within(skillsBlock()).getByRole('button', { name: 'Search the marketplace for “pdf”' })
    fireEvent.click(open)
    const market = await screen.findByRole('dialog', { name: 'Find skills for Reader' })
    await waitFor(() => expect(sent.some((request) => request.url.startsWith('/api/skills/search?') && request.url.includes('q=pdf'))).toBe(true))
    expect(market).toHaveTextContent('What you add here goes to Reader when you go back.')

    const changed = vi.fn()
    window.addEventListener(SKILLS_CHANGED_EVENT, changed)
    await addPdf(market)
    window.removeEventListener(SKILLS_CHANGED_EVENT, changed)
    // Whatever lists LoomWatch's skills reads them again (App's capability scan).
    expect(changed).toHaveBeenCalled()
    expect(market.querySelector('.lw-skills-market-says')).toHaveTextContent('PDF goes to Reader when you go back.')

    fireEvent.click(within(market).getByRole('button', { name: 'Back to Reader' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Find skills for Reader' })).toBeNull())
    expect(onSet).toHaveBeenCalledWith('skills', ['pdf'])
    expect(within(skillsBlock()).getByRole('list', { name: 'Its skills' })).toHaveTextContent('pdf')
    expect(skillsBlock()).toHaveTextContent('Gave it pdf from the marketplace.')
    // Everything else set on the agent is still there, and you are back where you left off.
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Read the forms.')
    expect(within(skillsBlock()).getByRole('button', { name: 'Find skills in the marketplace' })).toBe(document.activeElement)
  })

  it('pins up nothing that was taken back before going back', async () => {
    const onSet = vi.fn()
    render(<Bench start={{ name: 'Reader' }} onSet={onSet} />)
    fireEvent.click(within(skillsBlock()).getByRole('button', { name: 'Find skills in the marketplace' }))
    const market = await screen.findByRole('dialog', { name: 'Find skills for Reader' })
    fireEvent.click(await within(market).findByRole('button', { name: 'PDFs and forms' }))
    await addPdf(market)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Took back PDF.')).toBeInTheDocument()
    await waitFor(() => expect(market).toHaveTextContent('What you add here goes to Reader when you go back.'))

    fireEvent.keyDown(market, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Find skills for Reader' })).toBeNull())
    expect(onSet).not.toHaveBeenCalledWith('skills', expect.anything())
    expect(skillsBlock()).not.toHaveTextContent('from the marketplace.')
  })

  it('points at the marketplace from the cards too, and not where nothing can change', () => {
    const pdf: DetectedCapability = { id: 'skill:pdf', name: 'pdf', source: 'LoomWatch', detail: 'Fills PDF forms.', status: 'Ready' }
    const { unmount } = render(<Bench start={{ name: 'Reader' }} available={[pdf]} />)
    expect(skillsBlock()).toHaveTextContent('Click one below to read it; press + or drag it onto the bench to give it to this agent.')
    expect(within(skillsBlock()).getByRole('button', { name: 'Find skills in the marketplace' })).toBeInTheDocument()
    unmount()
    render(<Bench start={{ name: 'Reader' }} readOnly />)
    expect(within(skillsBlock()).queryByRole('button', { name: /marketplace/ })).toBeNull()
  })
})

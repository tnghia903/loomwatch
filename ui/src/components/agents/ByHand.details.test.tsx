import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { CAPABILITY_NOT_FOUND, type DetectedCapability } from '../../lib/library/client'
import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import { skillBody } from '../../lib/library/skillStore'
import { ByHand } from './ByHand'

// The bench's 3D figure is beside the point here.
vi.mock('./AgentFigure', () => ({ default: () => null }))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const catalog = { fetchedAt: '2026-10-17T00:00:00Z', defaultModel: 'anthropic/claude-opus-5.5', recommended: [], models: [] }

const AUDIT_MD = [
  '---',
  'name: accessibility-review',
  'description: Run a WCAG 2.1 AA accessibility audit on a design or page.',
  '---',
  '',
  '# How to audit',
  '',
  'Audit a design or page for WCAG 2.1 AA.',
  '',
  '- Check colour contrast',
].join('\n')

const audit: DetectedCapability = { id: 'skill-audit', name: 'accessibility-review', source: 'LoomWatch', detail: 'Run a WCAG 2.1 AA accessibility audit on a design or page.', status: 'Ready' }
const notes: DetectedCapability = { id: 'skill-notes', name: 'apple-notes', source: 'LoomWatch', detail: 'Manage Apple Notes via memo CLI.', status: 'Ready' }

let sent: string[] = []
let gone = false
beforeEach(() => {
  forgetModels()
  sent = []
  gone = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? 'GET') !== 'GET') throw new Error(`nothing here writes: ${url}`)
    sent.push(url)
    if (url === '/api/capabilities/skill-audit') {
      if (gone) return json({ error: 'unknown capability "skill-audit"' }, 404)
      return json({ id: 'skill-audit', kind: 'skill', definitions: [{ source: 'LoomWatch', path: '/Users/me/Library/Application Support/LoomWatch/skills/accessibility-review/SKILL.md', content: AUDIT_MD }], portability: { kind: 'behavior', needs: ['slash commands'], evidence: [], route: 'inline' } })
    }
    if (url === '/api/capabilities/skill-notes') return json({ id: 'skill-notes', kind: 'skill', definitions: [] })
    if (url === '/api/skills') {
      return json({ folder: '/Users/me/Library/Application Support/LoomWatch/skills', skills: [{ name: 'accessibility-review', description: audit.detail, origin: { kind: 'brought_in', app: 'Claude Code' }, license: { id: 'MIT', restricted: false }, needs: ['slash commands'], runtimes: [], hasScripts: false, sizeBytes: 4278, sha256: '', addedAt: '2026-10-18T00:00:00Z' }] })
    }
    return json(catalog)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The bench with its draft kept, as the builder keeps it, so a pinned-up skill shows. */
function Bench({ start = {}, onSet }: { start?: Partial<AgentDraft>; onSet?: (key: string, value: unknown) => void }) {
  const [draft, setDraft] = useState<AgentDraft>({ ...BLANK_DRAFT, name: 'Reviewer', ...start })
  return <ByHand draft={draft} set={(key, value) => { onSet?.(key, value); setDraft((current) => ({ ...current, [key]: value })) }} skills={[audit, notes]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'yarn', color: 'sage' }} record={null} />
}

const skillsBlock = () => screen.getByRole('region', { name: 'Skills' })
const cards = () => within(skillsBlock()).getByRole('list', { name: 'Skills you can give it' })

describe('By hand: reading a skill', () => {
  it('opens a card to read every word of it, and pins it up from there', async () => {
    const onSet = vi.fn()
    render(<Bench onSet={onSet} />)
    const card = within(cards()).getByRole('button', { name: 'Read accessibility-review' })
    expect(card).toHaveAccessibleDescription(audit.detail)
    fireEvent.click(card)

    const sheet = await screen.findByRole('dialog', { name: 'Accessibility review' })
    expect(sheet).toHaveTextContent('Skill · LoomWatch')
    expect(sheet).toHaveTextContent(audit.detail)
    // Its SKILL.md, formatted, without the front matter the lines above already say.
    expect(await within(sheet).findByRole('heading', { name: 'How to audit' })).toBeInTheDocument()
    expect(within(sheet).getByRole('listitem')).toHaveTextContent('Check colour contrast')
    expect(sheet).not.toHaveTextContent('name: accessibility-review')
    // Where it came from, what it assumes, and which file this is.
    expect(sheet).toHaveTextContent('Brought in from Claude Code')
    expect(sheet).toHaveTextContent('Uses slash commands')
    expect(sheet).toHaveTextContent('MIT')
    expect(sheet).toHaveTextContent('accessibility-review/SKILL.md')
    expect(onSet).not.toHaveBeenCalled()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Give it this skill' }))
    expect(onSet).toHaveBeenCalledWith('skills', ['accessibility-review'])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Pinned up, it left the cards for the pegboard, and focus went with it.
    const pinned = within(skillsBlock()).getByRole('list', { name: 'Its skills' })
    const chip = within(pinned).getByRole('button', { name: 'Read accessibility-review' })
    expect(chip).toHaveFocus()
    expect(within(cards()).queryByRole('button', { name: 'Read accessibility-review' })).not.toBeInTheDocument()
  })

  it('opens a pinned-up skill too, to take it down', async () => {
    const onSet = vi.fn()
    render(<Bench start={{ skills: ['accessibility-review', 'gone-skill'] }} onSet={onSet} />)
    const pinned = within(skillsBlock()).getByRole('list', { name: 'Its skills' })
    // One LoomWatch can't find any more has nothing to open.
    expect(within(pinned).queryByRole('button', { name: 'Read gone-skill' })).not.toBeInTheDocument()
    expect(within(pinned).getByRole('button', { name: 'Take gone-skill away' })).toBeInTheDocument()

    fireEvent.click(within(pinned).getByRole('button', { name: 'Read accessibility-review' }))
    const sheet = await screen.findByRole('dialog', { name: 'Accessibility review' })
    expect(within(sheet).queryByRole('button', { name: 'Give it this skill' })).not.toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Take this skill away' }))
    expect(onSet).toHaveBeenCalledWith('skills', ['gone-skill'])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(cards()).getByRole('button', { name: 'Read accessibility-review' })).toHaveFocus()
  })

  it('closes on Escape with nothing changed, and + still pins up without opening', async () => {
    const onSet = vi.fn()
    render(<Bench onSet={onSet} />)
    fireEvent.click(within(cards()).getByRole('button', { name: 'Read apple-notes' }))
    const sheet = await screen.findByRole('dialog', { name: 'Apple notes' })
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onSet).not.toHaveBeenCalled()

    fireEvent.click(within(cards()).getByRole('button', { name: 'Give it apple-notes' }))
    expect(onSet).toHaveBeenCalledWith('skills', ['apple-notes'])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says so when the skill has gone, and tries again', async () => {
    gone = true
    render(<Bench />)
    fireEvent.click(within(cards()).getByRole('button', { name: 'Read accessibility-review' }))
    const sheet = await screen.findByRole('dialog', { name: 'Accessibility review' })
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(CAPABILITY_NOT_FOUND)
    // What the shelf already knows still shows.
    expect(sheet).toHaveTextContent(audit.detail)

    gone = false
    fireEvent.click(within(sheet).getByRole('button', { name: 'Try again' }))
    expect(await within(sheet).findByRole('heading', { name: 'How to audit' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() => expect(sent.filter((url) => url === '/api/capabilities/skill-audit')).toHaveLength(2))
  })
})

describe('skillBody', () => {
  it('drops the front matter and keeps the instructions', () => {
    expect(skillBody(AUDIT_MD)).toBe('# How to audit\n\nAudit a design or page for WCAG 2.1 AA.\n\n- Check colour contrast')
    expect(skillBody('---\r\nname: x\r\n---\r\nDo the thing.\r\n')).toBe('Do the thing.')
  })

  it('reads links into its own folder as words, and keeps web links and code', () => {
    const text = [
      'If unsure, see [CONNECTORS.md](../../CONNECTORS.md) or [the steps](#steps).',
      'More at [the docs](https://example.com/docs) and ![a chart](chart.png).',
      '',
      '```md',
      '[kept](./as-written.md)',
      '```',
    ].join('\n')
    expect(skillBody(text)).toBe([
      'If unsure, see CONNECTORS.md or the steps.',
      'More at [the docs](https://example.com/docs) and ![a chart](chart.png).',
      '',
      '```md',
      '[kept](./as-written.md)',
      '```',
    ].join('\n'))
  })

  it('leaves a SKILL.md with no front matter as it is', () => {
    expect(skillBody('# Notes\n\n---\n\nA rule, not front matter.')).toBe('# Notes\n\n---\n\nA rule, not front matter.')
  })
})

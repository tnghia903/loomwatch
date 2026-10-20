import { cleanup, render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LoomMark } from '../../components/ui/glyphs'
import type { RunRecord } from '../runs/client'
import { useNeedsYou } from './useNeedsYou'

const registry = vi.hoisted(() => ({ runs: [] as RunRecord[] }))
vi.mock('../runs/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../runs/client')>(), fetchRuns: () => Promise.resolve(registry.runs) }))
vi.mock('../team-file/useTeamList', () => ({ useTeamList: () => ({ teams: [] }) }))

// Read from disk: the mark's master drawing and the colour tokens the dot is checked against.
const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')
const mouth = /<path d="M222 354Q256 382 290 354"[^>]*stroke="(#[0-9A-Fa-f]{6})"/.exec(read('../docs/assets/brand/mark-small.svg'))?.[1]
const tokens = read('src/styles/tokens.css')
const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens)?.[1]

const run = (status: RunRecord['status'], waitingOn: RunRecord['waitingOn'] = null) => ({
  runId: `run-${status}`, sessionId: 's', teamPath: '/teams/research.yaml', prompt: '', status, mode: 'pipeline', entrypoint: 'writer', responder: 'writer', agentIds: ['writer'],
  createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, error: null, exitCode: null, waitingOn,
}) as RunRecord
const review = run('running', { node: 'writer', name: 'Writer', kind: 'review_stop', since: new Date().toISOString(), question: '', park: 'none', parkNote: '', sendBackAvailable: false })

function Probe() {
  useNeedsYou()
  return null
}

const icon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')!
const drawing = () => new DOMParser().parseFromString(decodeURIComponent(icon().href.replace(/^data:image\/svg\+xml,/, '')), 'image/svg+xml')
const dot = () => drawing().querySelector('circle[cx="416"][cy="96"]')?.getAttribute('fill') ?? undefined
// The mouth: the master's stitch, or a ring that isn't the dot.
const stitch = () => drawing().querySelector('path[d="M222 354Q256 382 290 354"]')
const ring = () => drawing().querySelector('circle:not([cx="416"])')
const shape = (circle: Element | null) => circle && ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width'].map((name) => circle.getAttribute(name))

beforeEach(() => {
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/icon.svg" />'
  document.title = 'LoomWatch'
})
afterEach(cleanup)

// Where the operator looks while in another tab. Waiting on you is your turn, not something wrong:
// the mark asks with its own gold (its "o" is the gold of its mouth), and red stays for what failed.
describe('the tab icon', () => {
  it('carries the mark’s gold when something needs you, and the title counts it', async () => {
    expect(mouth).toMatch(/^#[0-9A-F]{6}$/i)
    registry.runs = [review]
    render(<Probe />)
    await waitFor(() => expect(dot()).toBeDefined())
    expect(dot()).toBe(mouth)
    expect(dot()).toBe(token('lw-gold-200'))
    expect([token('lw-red-400'), token('lw-red-600')]).not.toContain(dot())
    expect(document.title).toBe('(1) LoomWatch')
  })

  // Gold against blue is a difference of hue alone where the "(1)" is hidden (a pinned tab, a
  // crowded strip), so the face asks too: the header mark's small "o" in place of the stitch.
  it('opens the mark’s mouth into the header mark’s "o" when something needs you', async () => {
    const { container } = render(<LoomMark size={16} state="asking" />)
    const header = shape(container.querySelector('.lw-mark-o'))
    cleanup()
    expect(header).toEqual(['256', '362', '26', 'none', mouth, '30'])
    registry.runs = [review]
    render(<Probe />)
    await waitFor(() => expect(dot()).toBeDefined())
    expect(shape(ring())).toEqual(header)
    expect(stitch()).toBeNull()
  })

  it('keeps the blue dot while a team works', async () => {
    registry.runs = [run('running')]
    render(<Probe />)
    await waitFor(() => expect(dot()).toBeDefined())
    expect(dot()).toBe(token('lw-blue-300'))
    expect(stitch()).not.toBeNull()
    expect(ring()).toBeNull()
    expect(document.title).toBe('LoomWatch')
  })

  it('shows the plain mark when nothing waits and nothing works', async () => {
    registry.runs = [run('succeeded')]
    render(<Probe />)
    await new Promise((settle) => setTimeout(settle, 20))
    expect(icon().href).toMatch(/\/icon\.svg$/)
    expect(dot()).toBeUndefined()
  })
})

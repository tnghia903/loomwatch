import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { answerFileName } from '../../lib/chat/format'
import type { RunRecord } from '../../lib/runs/client'
import type { AnswerCheck } from '../../lib/story/answerCheck'
import type { ReceiptLine } from '../../lib/story/receipt'
import { AnswerTools } from './AnswerTools'

vi.mock('../../lib/notion/useNotionSend', () => ({ useNotionSend: () => ({ hidden: false }) }))
vi.mock('../run/NotionSend', () => ({
  NotionOutcome: () => null,
  NotionOffer: () => <button type="button">Send to Notion</button>,
}))

const run = { runId: 'run-1', createdAt: '2026-10-06T02:00:00.000Z', status: 'succeeded' } as unknown as RunRecord
const ANSWER = '# Today’s AI digest\n\n| Finding | Impact |\n|---|---|\n| Clear results | Faster review |'
const finding: ReceiptLine = { tone: 'bad', text: 'Writer wasn’t allowed to search the web, and carried on without it', evidenceId: 'p1', agentId: 'writer' }
const check = (overrides: Partial<AnswerCheck['verdict']> = {}, skills = { required: 0, opened: 0 }): AnswerCheck => ({
  verdict: { tone: 'look', label: '1 thing to check', detail: `${finding.text}.`, findings: [finding], reviewable: true, ...overrides },
  receipt: null,
  ...skills,
})

function setup(props: Partial<Parameters<typeof AnswerTools>[0]> = {}) {
  const onReviewed = vi.fn()
  const onOpenFinding = vi.fn()
  render(<AnswerTools run={run} answer={ANSWER} check={check()} files={[]} makers={[]} finished reviewed={false} onReviewed={onReviewed} onOpenFinding={onOpenFinding} {...props} />)
  return { onReviewed, onOpenFinding }
}

beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') } })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// ADR 0051: the answer is read in the chat, so everything about it lives under it, once.
describe('under a team’s answer in the chat', () => {
  it('says what its record holds to check, and opens the review on it', () => {
    const { onOpenFinding } = setup()
    fireEvent.click(screen.getByRole('button', { name: '1 thing to check' }))
    const review = within(screen.getByRole('dialog', { name: 'Review the answer' }))
    fireEvent.click(within(review.getByRole('region', { name: 'Worth a look' })).getByRole('button', { name: /^Open: Writer wasn’t allowed/ }))
    expect(onOpenFinding).toHaveBeenCalledWith(finding)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('records a review only after you check the acknowledgement', () => {
    const { onReviewed } = setup()
    fireEvent.click(screen.getByRole('button', { name: '1 thing to check' }))
    const review = within(screen.getByRole('dialog', { name: 'Review the answer' }))
    expect(review.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled()
    fireEvent.click(review.getByRole('checkbox'))
    fireEvent.click(review.getByRole('button', { name: 'Mark reviewed' }))
    expect(onReviewed).toHaveBeenCalledOnce()
  })

  it('does not let the acknowledgement bypass a required skill with no loading evidence', () => {
    setup({ check: check({}, { required: 1, opened: 0 }) })
    fireEvent.click(screen.getByRole('button', { name: '1 thing to check' }))
    const review = within(screen.getByRole('dialog', { name: 'Review the answer' }))
    expect(review.getByText('0/1 required skills have loading evidence.')).toBeInTheDocument()
    fireEvent.click(review.getByRole('checkbox'))
    expect(review.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled()
    fireEvent.click(review.getByRole('button', { name: 'Keep reading' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says nothing was flagged as a status that still opens the review', () => {
    setup({ check: check({ tone: 'ok', label: 'Nothing flagged', detail: 'Every step finished and nothing in the record was flagged.', findings: [] }) })
    const status = screen.getByRole('button', { name: 'Nothing flagged' })
    expect(status).toHaveAttribute('title', 'Every step finished and nothing in the record was flagged.')
    fireEvent.click(status)
    expect(within(screen.getByRole('dialog', { name: 'Review the answer' })).getByText('Nothing in this record was flagged.')).toBeInTheDocument()
  })

  it('copies the exact Markdown, and saves it under its title and day', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(ANSWER)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(answerFileName(ANSWER, run.createdAt)).toBe('todays-ai-digest-2026-10-06.md')
    expect(answerFileName('No heading here.', run.createdAt)).toBe('team-answer-2026-10-06.md')
  })

  it('keeps saving and sending behind Share, which Esc closes', () => {
    setup()
    expect(screen.queryByRole('button', { name: /Download|Send to Notion/ })).toBeNull()
    const share = screen.getByRole('button', { name: 'Share' })
    fireEvent.click(share)
    expect(share).toHaveAttribute('aria-expanded', 'true')
    const menu = within(screen.getByRole('group', { name: 'Share this answer' }))
    expect(menu.getByRole('button', { name: 'Download as Markdown' })).toBeInTheDocument()
    expect(menu.getByRole('button', { name: 'Send to Notion' })).toBeInTheDocument()
    fireEvent.keyDown(share, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Share this answer' })).toBeNull()
  })

  it('offers nothing to copy, save or send until the answer is finished', () => {
    setup({ finished: false })
    expect(screen.queryByRole('button', { name: /Copy|Download|Send to Notion|thing to check/ })).toBeNull()
  })

  it('attaches the files it names under it, ready to open', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      path: '/teams/.loomwatch/demo/designer/report.docx', name: 'report.docx', exists: true, isDir: false, sizeBytes: 2048,
      modifiedAt: null, kind: 'document', folder: '.loomwatch/demo/designer', openable: true,
    })))))
    const folder = '/teams/.loomwatch/demo/designer'
    const paths = ['report.docx', 'charts.pdf', 'data.csv', 'notes.md', 'deck.pptx'].map((name) => `${folder}/${name}`)
    setup({ files: paths, makers: [{ id: 'designer', name: 'Designer' }] })
    const files = screen.getByRole('group', { name: 'Files in this answer' })
    // Attached as files posted in a chat are: a row each, the first three, and the rest behind "more".
    expect(within(files).getAllByRole('button', { name: /^Open / })).toHaveLength(3)
    expect(files.querySelectorAll('.file-card.compact')).toHaveLength(3)
    fireEvent.click(within(files).getByRole('button', { name: '2 more files' }))
    expect(within(files).getAllByRole('button', { name: /^Open / })).toHaveLength(5)
    expect(within(files).getByRole('button', { name: 'Show fewer files' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(files).getByText('report.docx')).toBeInTheDocument()
  })
})

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotionDeliverySettings } from './NotionDeliverySettings'
import type { DeliverConfig } from '../../lib/team-file/types'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const connection = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(body, status))))

const renderSettings = (deliver: DeliverConfig | null, extra: Partial<Parameters<typeof NotionDeliverySettings>[0]> = {}) => {
  const onChange = vi.fn()
  render(<NotionDeliverySettings deliver={deliver} onChange={onChange} readOnly={false} teamName="Daily desk" routineTitle={null} {...extra} />)
  return onChange
}

describe('Send every answer to Notion (ADR 0038)', () => {
  it('turns delivery on and off as the team file’s top-level deliver block', async () => {
    connection({ connected: true, name: 'Notion', destination: { id: 'p1', title: 'Team answers' }, problem: null })
    const onChange = renderSettings(null)
    const toggle = screen.getByRole('button', { name: /Send every answer to Notion/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Answers stay in LoomWatch.')).toBeInTheDocument()
    expect(await screen.findByText('Team answers')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('New pages go under Team answers in Notion.')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith({ notion: {} })
    cleanup()

    const off = renderSettings({ notion: { title: 'Desk {{date}}' } })
    fireEvent.click(screen.getByRole('button', { name: /Send every answer to Notion/ }))
    expect(off).toHaveBeenCalledWith(null)
  })

  it('says, in place, that nothing can arrive until Notion is connected — and where to fix it', async () => {
    connection({ connected: false })
    renderSettings({ notion: {} })
    const status = await screen.findByText(/Notion isn’t connected yet, so nothing can be sent\./)
    // Connections is under You, and nothing else on a team's page reaches it, so the line links there.
    expect(status).toHaveTextContent('Connect Notion under Tools in Connections.')
    expect(within(status).getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '/connections')
    expect(status).toHaveClass('warn')
  })

  it('asks for a page when connected without one, and stays quiet when the daemon has no Notion API', async () => {
    connection({ connected: true, name: 'Notion', destination: null, problem: null })
    renderSettings({ notion: {} })
    expect(await screen.findByText((_, node) => node?.className === 'output-send-link' && node.textContent === 'Choose a page in Connections.')).toBeInTheDocument()
    cleanup()
    connection({ error: 'Not Found' }, 404)
    renderSettings(null)
    expect(await screen.findByText('Notion can be connected only when LoomWatch runs on this computer.')).toBeInTheDocument()
  })

  it('writes the title once, on blur, and falls back to the default when cleared', async () => {
    connection({ connected: false })
    const onChange = renderSettings({ notion: {} })
    const input = screen.getByLabelText('Page title')
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', '{{team}} — {{date}} {{time}}')
    expect(screen.getByText(/Next page:/).textContent).toMatch(/Daily desk — \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    fireEvent.change(input, { target: { value: 'Brief {{date}}' } })
    fireEvent.change(input, { target: { value: 'Brief {{date}}!' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ notion: { title: 'Brief {{date}}!' } })
    cleanup()

    const cleared = renderSettings({ notion: { title: 'Old' } })
    const titled = screen.getByLabelText('Page title')
    fireEvent.change(titled, { target: { value: '   ' } })
    fireEvent.keyDown(titled, { key: 'Enter' })
    expect(cleared).toHaveBeenCalledWith({ notion: {} })
  })

  it('names a routine’s own Notion title, and locks everything when the team cannot be edited', async () => {
    connection({ connected: false })
    renderSettings(null, { routineTitle: 'Digest — {{date}}', readOnly: true })
    expect(screen.getByText(/Scheduled runs already go to Notion/).textContent).toMatch(/Digest — \d{4}-\d{2}-\d{2}/)
    expect(screen.getByRole('button', { name: /Send every answer to Notion/ })).toBeDisabled()
    await screen.findByText(/Notion isn’t connected yet\./)
  })
})

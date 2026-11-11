import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KeptWidget } from '../../../lib/widgets/types'
import { AnswerWidgets } from './AnswerWidgets'

afterEach(cleanup)

const weekend: KeptWidget = {
  n: 1,
  spec: {
    kind: 'calendar',
    title: 'Your long weekend',
    zone: 'Singapore time',
    days: ['2026-11-14', '2026-11-15', '2026-11-16'],
    hours: { from: '07:00', to: '24:00' },
    bookings: [
      { day: '2026-11-14', start: '10:00', end: '15:00', label: 'Study', place: 'Home' },
      { day: '2026-11-14', start: '19:00', end: '21:30', label: 'Dinner with Linh' },
      { day: '2026-11-15', label: 'Family day', place: 'Sentosa' },
      { day: '2026-11-16', start: '09:00', end: '11:00', label: 'Standup' },
      { day: '2026-11-16', start: '10:00', end: '12:00', label: 'Design review', place: 'Room 4' },
    ],
  },
}

const draw = (onChoose?: (text: string) => Promise<boolean>) => render(<AnswerWidgets widgets={[weekend]} onChange={vi.fn()} onChoose={onChoose} by="Ada" />)

describe('a calendar in an answer', () => {
  it('shows a week of dates, the calendar’s days among them, and the first day folded', async () => {
    draw()
    expect(await screen.findByText('Your long weekend')).toBeTruthy()
    const days = within(screen.getByRole('tablist', { name: 'Days' })).getAllByRole('tab')
    expect(days).toHaveLength(7)
    expect(days.filter((day) => !(day as HTMLButtonElement).disabled)).toHaveLength(3)
    expect(days[2].getAttribute('aria-selected')).toBe('true')
    expect(days[2].getAttribute('aria-label')).toMatch(/: 9h 30m free$/)
    expect(screen.getByText('Study')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Free .*: choose a time to hold$/ })).toHaveLength(3)
  })

  it('shows another day when its date is picked: one booked all day, or bookings that overlap', async () => {
    draw()
    const days = within(await screen.findByRole('tablist', { name: 'Days' })).getAllByRole('tab')
    fireEvent.click(days[3])
    expect(screen.getByText('Family day')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Free/ })).toBeNull()
    fireEvent.click(days[4])
    expect(screen.getByText('overlaps 1h')).toBeTruthy()
  })

  it('opens free time with an hour to hold, moved and stretched by keys, and sends it as your message', async () => {
    const onChoose = vi.fn(async () => true)
    draw(onChoose)
    fireEvent.click(await screen.findByRole('button', { name: /^Free 15:00 to 19:00/ }))
    const hold = screen.getByRole('slider')
    expect(hold.getAttribute('aria-valuetext')).toBe('15:00 to 16:00')
    fireEvent.keyDown(hold, { key: 'ArrowDown' })
    fireEvent.keyDown(hold, { key: 'ArrowDown', shiftKey: true })
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('15:15 to 16:30')
    fireEvent.click(screen.getByRole('button', { name: 'Hold it' }))
    expect(onChoose).toHaveBeenCalledWith('Hold Saturday, 14 November 2026, 15:15–16:30 on my calendar.')
    expect(await screen.findByText(/^Sent: Hold Saturday/)).toBeTruthy()
  })

  it('can’t send from an answer that isn’t the newest', async () => {
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /^Free 15:00 to 19:00/ }))
    expect((screen.getByRole('button', { name: 'Hold it' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Ask Ada to book' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

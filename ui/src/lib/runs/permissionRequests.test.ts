import { describe, expect, it } from 'vitest'

import { permissionDeadline, timeLeft } from './permissionRequests'

const NOW = Date.parse('2026-10-25T08:00:00Z')
const after = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

describe('timeLeft', () => {
  // ADR 0090: a scheduled run waits twelve hours for you, so hours read better than 719 min.
  it('says hours once it is two hours or more away, minutes below that', () => {
    expect(timeLeft(after(12 * 60), NOW)).toBe('in 12 hours')
    expect(timeLeft(after(11 * 60 + 59), NOW)).toBe('in 11 hours')
    expect(timeLeft(after(95), NOW)).toBe('in 95 min')
    expect(timeLeft(after(0.5), NOW)).toBe('in under a minute')
    expect(timeLeft('soon', NOW)).toBeNull()
  })

  it('makes the permission card say when it declines by itself', () => {
    expect(permissionDeadline(after(12 * 60), NOW)).toBe('Declines by itself in 12 hours if nobody answers.')
    expect(permissionDeadline(after(9.5), NOW)).toBe('Declines by itself in 9 min if nobody answers.')
    expect(permissionDeadline('soon', NOW)).toBe('Declines by itself if nobody answers.')
  })
})

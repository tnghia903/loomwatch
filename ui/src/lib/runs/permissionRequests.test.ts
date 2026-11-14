import { describe, expect, it } from 'vitest'

import { permissionDeadline, permissionWhat, timeLeft } from './permissionRequests'

const NOW = Date.parse('2026-10-25T08:00:00Z')
const after = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

// ADR 0040: a connected tool's call starts at its action, since the line above it names the tool.
describe('permissionWhat', () => {
  it('leaves out the tool’s name a call’s title starts with, and keeps every other title whole', () => {
    expect(permissionWhat({ title: 'Apple Calendar: Add event', detail: 'Upper A · Sat 14 Nov, 15:00–16:00', tool: { server: 'Apple Calendar' } })).toBe('Add event · Upper A · Sat 14 Nov, 15:00–16:00')
    expect(permissionWhat({ title: 'Apple Calendar: Add event', detail: null, tool: 'Apple Calendar' })).toBe('Add event')
    expect(permissionWhat({ title: 'Linear: Create issue', detail: 'Fix login', tool: { server: 'Notion' } })).toBe('Linear: Create issue · Fix login')
    expect(permissionWhat({ title: 'Run: npm test', detail: 'npm test' })).toBe('Run: npm test · npm test')
  })
})

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

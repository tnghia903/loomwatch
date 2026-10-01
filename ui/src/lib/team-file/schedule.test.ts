import { describe, expect, it } from 'vitest'

import { cronFor, normalizeSchedule, scheduleParts, summarizeSchedule, unsupportedScheduleKeys } from './schedule'
import type { ScheduleConfig } from './types'

describe('normalizeSchedule', () => {
  it('writes only the keys the schema allows, so a save clears the problem it promised to fix', () => {
    // The regression: `{ ...schedule }` carried an unknown key back into the document, so
    // pressing "Save schedule" left the team invalid and unrunnable with no explanation.
    const loaded = { cron: '0 8 * * *', prompt: 'Digest.', retries: 3, notes: 'x' } as unknown as ScheduleConfig
    const saved = normalizeSchedule({ cron: '30 9 * * *', timezone: 'UTC', prompt: 'Digest.' }, loaded)

    expect(Object.keys(saved)).toEqual(['cron', 'timezone', 'prompt'])
    expect(saved).toEqual({ cron: '30 9 * * *', timezone: 'UTC', prompt: 'Digest.' })
  })

  it('names the keys it is about to drop so the editor can say so first', () => {
    expect(unsupportedScheduleKeys({ cron: '0 8 * * *', prompt: 'x', retries: 3 } as unknown as ScheduleConfig)).toEqual(['retries'])
    expect(unsupportedScheduleKeys({ cron: '0 8 * * *', timezone: 'UTC', prompt: 'x', enabled: true, deliver: {} })).toEqual([])
    expect(unsupportedScheduleKeys(null)).toEqual([])
  })

  it('coerces a non-boolean `enabled` rather than carrying the type error forward', () => {
    const loaded = { cron: '0 8 * * *', prompt: 'x', enabled: 'yes-please' } as unknown as ScheduleConfig
    expect(normalizeSchedule({ cron: '0 8 * * *', prompt: 'x' }, loaded).enabled).toBe(true)
    expect(normalizeSchedule({ cron: '0 8 * * *', prompt: 'x' }, { ...loaded, enabled: false }).enabled).toBe(false)
  })

  it('leaves `enabled` out of a schedule that never had it', () => {
    expect(normalizeSchedule({ cron: '0 8 * * *', prompt: 'x' }, { cron: '', prompt: '' })).not.toHaveProperty('enabled')
  })

  it('keeps a delivery title but drops an empty one the schema rejects', () => {
    expect(normalizeSchedule({ cron: '0 8 * * *', prompt: 'x' }, { cron: '', prompt: '', deliver: { notion: { title: 'Digest — {{date}}' } } }).deliver)
      .toEqual({ notion: { title: 'Digest — {{date}}' } })
    expect(normalizeSchedule({ cron: '0 8 * * *', prompt: 'x' }, { cron: '', prompt: '', deliver: { notion: { title: '  ' } } }).deliver)
      .toEqual({ notion: {} })
  })

  it('trims, and omits an empty timezone instead of writing an empty string', () => {
    expect(normalizeSchedule({ cron: ' 0 8 * * * ', timezone: '   ', prompt: '  Digest.  ' }, null))
      .toEqual({ cron: '0 8 * * *', prompt: 'Digest.' })
  })
})

describe('scheduleParts', () => {
  it('reads the three frequencies back out of a cron expression', () => {
    expect(scheduleParts('0 8 * * *')).toEqual({ frequency: 'daily', time: '08:00' })
    expect(scheduleParts('30 9 * * 1-5')).toEqual({ frequency: 'weekdays', time: '09:30' })
    expect(scheduleParts('*/15 * * * *')).toEqual({ frequency: 'manual', time: '08:00' })
  })

  it('survives a schedule block with no cron at all', () => {
    expect(scheduleParts(undefined)).toEqual({ frequency: 'manual', time: '08:00' })
    expect(summarizeSchedule({})).toBe('Choose a time')
  })

  it('round-trips through cronFor', () => {
    expect(cronFor('daily', '08:00', '')).toBe('0 8 * * *')
    expect(cronFor('weekdays', '09:30', '')).toBe('30 9 * * 1-5')
    expect(cronFor('manual', '08:00', ' */15 * * * * ')).toBe('*/15 * * * *')
  })
})

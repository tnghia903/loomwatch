import { describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_ROLE } from './createAgent'
import { replySays, replySection, withReply } from './desk'
import { ROLE_PRESETS } from './roles'

describe('what it hands back, as the tray reads it from its instructions', () => {
  it('finds every built-in job’s hand-back whole, where it is', () => {
    for (const preset of ROLE_PRESETS) {
      const part = replySection(preset.role)
      expect(part, preset.id).not.toBeNull()
      expect(preset.role.slice(part!.start, part!.start + part!.text.length)).toBe(part!.text)
      // The hand-back is the last thing each job says.
      expect(preset.role.trimEnd().endsWith(part!.text)).toBe(true)
      expect(part!.text).toMatch(/^Reply (with|in this shape:)/)
    }
  })

  it('says a shape by its parts, and a sentence as it is', () => {
    const researcher = replySection(ROLE_PRESETS.find((preset) => preset.id === 'researcher')!.role)!
    expect(replySays(researcher.text)).toBe('Replies in 4 parts: Summary, Findings, Conflicts and gaps, Sources')
    expect(replySays('Reply with the list.')).toBe('Reply with the list.')
  })

  it('takes the sentence that says it, not a check before it', () => {
    expect(replySection(DEFAULT_AGENT_ROLE)).toEqual({ start: 36, text: 'Work carefully, then reply with the finished result.' })
    expect(replySection('Before you reply, check the numbers.')).toBeNull()
    expect(replySection('You are the editor.')).toBeNull()
  })

  it('writes it in place, or after the rest when there is none', () => {
    const role = 'You are the editor.\n\nReply with the piece.'
    const part = replySection(role)
    expect(withReply(role, part, 'Reply with a diff.')).toEqual({ role: 'You are the editor.\n\nReply with a diff.', section: { start: 21, text: 'Reply with a diff.' } })
    expect(withReply('You are the editor.  ', null, 'Reply with a diff.').role).toBe('You are the editor.\n\nReply with a diff.')
    expect(withReply('', null, 'Reply with a diff.').role).toBe('Reply with a diff.')
  })
})

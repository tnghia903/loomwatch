import { describe, expect, it } from 'vitest'
import { ReplyText } from './replyText'

/** Mirrors `reply_text_keeps_a_message_whole_and_separates_the_next` in acp.rs: the two must agree. */
describe('ReplyText', () => {
  it('joins one message verbatim and puts the next a paragraph apart', () => {
    const ided = new ReplyText()
    ided.push("I'll build ", 'm-1')
    ided.push('and render it.', 'm-1')
    ided.push('Draft builds.', 'm-2')
    expect(ided.text).toBe("I'll build and render it.\n\nDraft builds.")
  })

  it('reads tool activity as the boundary when the harness sends no IDs', () => {
    const bare = new ReplyText()
    bare.push('Still 8 ', null)
    bare.push('pages.', null)
    bare.noteActivity()
    bare.push('Done.', null)
    expect(bare.text).toBe('Still 8 pages.\n\nDone.')
  })

  it('trusts an ID over a stray update mid-message', () => {
    const same = new ReplyText()
    same.push('half ', 'm-1')
    same.noteActivity()
    same.push('sentence', 'm-1')
    expect(same.text).toBe('half sentence')
  })

  it('does not double a break the text already has, and ignores empty chunks', () => {
    const padded = new ReplyText()
    padded.push('Intro\n', 'm-1')
    padded.push('', 'm-2')
    padded.push('\n## Report', 'm-2')
    expect(padded.text).toBe('Intro\n\n## Report')
  })

  it('starts a new message at a turn boundary even when the ID repeats', () => {
    const turns = new ReplyText()
    turns.push('First turn.', 'message-1')
    turns.endMessage()
    turns.push('Second turn.', 'message-1')
    expect(turns.text).toBe('First turn.\n\nSecond turn.')
  })
})

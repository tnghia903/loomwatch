import { describe, expect, it } from 'vitest'
import { ReplyText } from './replyText'

/** Mirrors the `ReplyText` tests in `engine/recorder.rs`: the two must agree. */
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

  it('leaves out a message said on the way to a tool call, unless that is all there is', () => {
    const reply = new ReplyText()
    reply.push('Paths are relative to the work folder; ', 'm1')
    reply.push("I'll use the full paths.", 'm1')
    reply.setAside('m1')
    reply.noteActivity()
    reply.push('Basic costs ', 'm2')
    reply.push('139,000 VND.', 'm2')
    reply.setAside('m1')
    reply.push('Team costs 349,000 VND.', 'm3')
    expect(reply.said).toBe("Paths are relative to the work folder; I'll use the full paths.\n\nBasic costs 139,000 VND.\n\nTeam costs 349,000 VND.")
    expect(reply.text).toBe('Basic costs 139,000 VND.\n\nTeam costs 349,000 VND.')

    const onlyAsides = new ReplyText()
    onlyAsides.push("I'll read the notes first.", 'm1')
    onlyAsides.setAside('m1')
    onlyAsides.push('Now the prices.', 'm2')
    onlyAsides.setAside('m2')
    expect(onlyAsides.text).toBe("I'll read the notes first.\n\nNow the prices.")
  })

  it('starts a new message at a turn boundary even when the ID repeats', () => {
    const turns = new ReplyText()
    turns.push('First turn.', 'message-1')
    turns.endMessage()
    turns.push('Second turn.', 'message-1')
    expect(turns.text).toBe('First turn.\n\nSecond turn.')
  })
})

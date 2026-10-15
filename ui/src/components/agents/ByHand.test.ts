import { describe, expect, it } from 'vitest'

import { replyLine } from '../../lib/library/desk'

describe('the outbox', () => {
  it('shows the line of the instructions that says what it replies with', () => {
    expect(replyLine('You are the reader. Check every story.\n\nReply with the kept stories, most important first.')).toBe('Reply with the kept stories, most important first.')
    expect(replyLine('Write the digest. Hand back one paragraph per story.')).toBe('Hand back one paragraph per story.')
  })

  it('says nothing when the instructions never say', () => {
    expect(replyLine('Read the sources and keep what they stand behind.')).toBeNull()
  })

  it('keeps a long line short', () => {
    const line = replyLine(`Reply with ${'a very long description of the format '.repeat(5)}`)
    expect(line?.length).toBeLessThanOrEqual(110)
    expect(line?.endsWith('…')).toBe(true)
  })
})

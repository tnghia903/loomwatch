import { describe, expect, it } from 'vitest'

import { replyLine } from '../../lib/library/desk'
import { ROLE_PRESETS } from '../../lib/library/roles'
import { checksBeforeReplying } from '../../lib/team-file/checkup'

describe('the outbox', () => {
  it('shows the line of the instructions that says what it replies with', () => {
    expect(replyLine('You are the reader. Check every story.\n\nReply with the kept stories, most important first.')).toBe('Reply with the kept stories, most important first.')
    expect(replyLine('Write the digest. Hand back one paragraph per story.')).toBe('Hand back one paragraph per story.')
    // A check before replying names the reply without saying what it is.
    expect(replyLine('Write the digest.\n- Before you reply, check each link opens.\nReply with one paragraph per story.')).toBe('Reply with one paragraph per story.')
  })

  it('shows each built-in job’s reply, not the check it runs before replying', () => {
    for (const job of ROLE_PRESETS) {
      const line = replyLine(job.role)
      expect(line, job.id).not.toBeNull()
      expect(checksBeforeReplying(line ?? ''), `${job.id}: ${line}`).toBe(false)
    }
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

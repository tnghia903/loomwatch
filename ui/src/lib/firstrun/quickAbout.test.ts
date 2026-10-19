import { describe, expect, it } from 'vitest'

import { EMPTY_ABOUT, aboutFrom, aboutLine } from './quickAbout'

describe('telling the agents about me on the first run', () => {
  it('writes one plain sentence per tap, in the person’s voice', () => {
    expect(aboutFrom({ ...EMPTY_ABOUT, name: 'Mai', work: 'Teaching', language: 'Tiếng Việt', length: 'Short' }))
      .toBe('I’m a teacher.\nAnswer in Vietnamese.\nKeep answers short.')
    expect(aboutLine({ ...EMPTY_ABOUT, work: 'Teaching', language: 'Tiếng Việt', length: 'Short' })).toBe('Teaching · Tiếng Việt · Short')
  })

  it('says nothing for what wasn’t picked, or for Just right', () => {
    expect(aboutFrom(EMPTY_ABOUT)).toBe('')
    expect(aboutFrom({ ...EMPTY_ABOUT, name: 'Mai' })).toBe('')
    expect(aboutFrom({ ...EMPTY_ABOUT, length: 'Just right' })).toBe('')
    expect(aboutLine({ ...EMPTY_ABOUT, language: 'English', length: 'Just right' })).toBe('English')
  })

  it('takes what they do in their own words when no choice fits', () => {
    expect(aboutFrom({ ...EMPTY_ABOUT, work: 'Something else', otherWork: '  coffee   farming. ' })).toBe('I work in coffee farming.')
    expect(aboutFrom({ ...EMPTY_ABOUT, work: 'Something else', otherWork: ' ' })).toBe('')
    expect(aboutLine({ ...EMPTY_ABOUT, work: 'Something else', otherWork: 'coffee farming', length: 'Detailed' })).toBe('coffee farming · Detailed')
  })
})

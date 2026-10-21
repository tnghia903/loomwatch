import { describe, expect, it } from 'vitest'

import { EMPTY_ABOUT, aboutFrom, aboutLine, saidIn, withChoice } from './quickAbout'

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

// The About you page asks the same three questions over the text agents are told: each choice
// writes its sentence there, and shows what the text says.
describe('the three questions over an About you text', () => {
  it('reads each choice back from the sentence it wrote, wherever it is', () => {
    const text = 'I teach English at a primary school. Answer in Vietnamese.\nGive detailed answers.'
    expect(saidIn(text, 'work')).toBeNull()
    expect(saidIn(text, 'language')?.choice).toBe('Tiếng Việt')
    expect(saidIn(text, 'length')?.choice).toBe('Detailed')
    expect(saidIn('I’m a teacher.', 'work')?.choice).toBe('Teaching')
    expect(saidIn('Hi.\nI work in coffee farming.\nThanks', 'work')).toMatchObject({ choice: 'Something else', otherWork: 'coffee farming' })
    // Their own words may hold a full stop: the sentence runs to the end of its line.
    expect(saidIn('I work in TP. HCM banking.\nAnswer in English.', 'work')).toMatchObject({ otherWork: 'TP. HCM banking' })
    // Just right writes nothing, so a text never says it.
    expect(saidIn('Keep it friendly.', 'length')).toBeNull()
  })

  it('adds a choice on a line of its own, and changes it where it is', () => {
    expect(withChoice('', 'work', 'Teaching')).toBe('I’m a teacher.')
    expect(withChoice('I like cats.\n', 'language', 'English')).toBe('I like cats.\nAnswer in English.')
    const told = 'I’m a teacher.\nAnswer in Vietnamese.\nI like cats.'
    expect(withChoice(told, 'language', 'English')).toBe('I’m a teacher.\nAnswer in English.\nI like cats.')
    expect(withChoice(told, 'work', 'Something else', ' coffee  farming ')).toBe('I work in coffee farming.\nAnswer in Vietnamese.\nI like cats.')
    // Typed one key at a time, words with a full stop replace their sentence whole.
    const typed = [...'U.S. trade'].reduce((text, _, end, all) => withChoice(text, 'work', 'Something else', all.slice(0, end + 1).join('')), 'Answer in English.')
    expect(typed).toBe('Answer in English.\nI work in U.S. trade.')
  })

  it('takes a choice back out with its line, or its space inside a line', () => {
    expect(withChoice('I’m a teacher.\nAnswer in Vietnamese.\nI like cats.', 'language', null)).toBe('I’m a teacher.\nI like cats.')
    expect(withChoice('I like cats.\nKeep answers short.', 'length', 'Just right')).toBe('I like cats.')
    expect(withChoice('Hi. Keep answers short. Thanks', 'length', null)).toBe('Hi. Thanks')
    expect(withChoice('Keep answers short. Thanks', 'length', null)).toBe('Thanks')
    expect(withChoice('I’m a teacher.', 'work', 'Something else')).toBe('')
    expect(withChoice('I like cats.', 'work', null)).toBe('I like cats.')
  })
})

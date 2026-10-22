import { describe, expect, it } from 'vitest'

import { intakeFrom, intakeLabel, jobsFor, kindOf, messageFor, type Intake } from './intake'

function dropped(files: File[], data: Record<string, string> = {}) {
  return { files: files as unknown as FileList, getData: (type: string) => data[type] ?? '' }
}

const pdf = new File(['%PDF'], 'Lease 2027.pdf', { type: 'application/pdf' })
const photo = new File(['x'], 'IMG_2041.HEIC', { type: '' })
const sheet = new File(['a,b'], 'budget.csv', { type: 'text/csv' })

describe('what goes into the slot', () => {
  it('takes files, a link or text, files first, and nothing else', () => {
    expect(intakeFrom(dropped([pdf], { 'text/plain': 'Lease 2027.pdf' }))).toEqual({ files: [pdf], link: null, text: null })
    expect(intakeFrom(dropped([], { 'text/uri-list': '# from Safari\nhttps://example.com/rent', 'text/plain': 'https://example.com/rent' }))).toEqual({ files: [], link: 'https://example.com/rent', text: null })
    // A link as plain text, dragged from a message, is a link too.
    expect(intakeFrom(dropped([], { 'text/plain': 'https://example.com/a' }))?.link).toBe('https://example.com/a')
    expect(intakeFrom(dropped([], { 'text/plain': '  Could you do Friday afternoon?  ' }))).toEqual({ files: [], link: null, text: 'Could you do Friday afternoon?' })
    expect(intakeFrom(dropped([], { 'text/plain': '   ' }))).toBeNull()
  })

  it('offers three jobs that fit what went in, in plain words', () => {
    const one = (file: File): Intake => ({ files: [file], link: null, text: null })
    expect(kindOf(one(pdf))).toBe('document')
    expect(kindOf(one(photo))).toBe('picture')
    expect(kindOf(one(sheet))).toBe('table')
    expect(kindOf({ files: [pdf, sheet], link: null, text: null })).toBe('files')
    expect(kindOf({ files: [], link: 'https://example.com', text: null })).toBe('link')
    expect(kindOf({ files: [], link: null, text: 'hi' })).toBe('text')
    expect(jobsFor('document')).toEqual(['What should I check?', 'Summarize it', 'Pull out the dates'])
    for (const kind of ['document', 'picture', 'table', 'files', 'link', 'text'] as const) expect(jobsFor(kind)).toHaveLength(3)
  })

  it('names what went in, short', () => {
    expect(intakeLabel({ files: [pdf], link: null, text: null })).toBe('Lease 2027.pdf')
    expect(intakeLabel({ files: [pdf, sheet], link: null, text: null })).toBe('2 files')
    expect(intakeLabel({ files: [], link: 'https://www.example.com/rent?x=1', text: null })).toBe('a link to example.com')
    expect(intakeLabel({ files: [], link: null, text: 'We need to move the shoot to next week because the studio is booked' })).toBe('“We need to move the shoot to next week…”')
  })

  it('sends the job with the link or the text it is about; files go as attachments', () => {
    expect(messageFor({ files: [pdf], link: null, text: null }, ' What should I check? ')).toBe('What should I check?')
    expect(messageFor({ files: [], link: 'https://example.com/rent', text: null }, 'Summarize the page')).toBe('Summarize the page\n\nhttps://example.com/rent')
    expect(messageFor({ files: [], link: null, text: 'Line one\nLine two' }, 'Reply to it')).toBe('Reply to it\n\n> Line one\n> Line two')
  })
})

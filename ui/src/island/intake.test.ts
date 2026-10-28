import { describe, expect, it } from 'vitest'

import { intakeFrom, intakeLabel, jobsFor, kindOf, messageFor, tileName, withDropped, withoutFile, type Intake } from './intake'

function dropped(files: File[], data: Record<string, string> = {}) {
  return { files: files as unknown as FileList, getData: (type: string) => data[type] ?? '' }
}

const pdf = new File(['%PDF'], 'Lease 2027.pdf', { type: 'application/pdf' })
const photo = new File(['x'], 'IMG_2041.JPG', { type: '' })
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

  it('calls an email from Mail by its subject and offers what one does with an email', () => {
    const email = new File(['Subject: Rent'], 'Rent for March.eml')
    const reply = new File(['Subject: RE: Rent'], 'RE_ Rent for March.eml')
    expect(kindOf({ files: [email], link: null, text: null })).toBe('email')
    expect(intakeLabel({ files: [email], link: null, text: null })).toBe('Rent for March')
    expect(intakeLabel({ files: [email, reply], link: null, text: null })).toBe('2 emails')
    expect(jobsFor('email')).toEqual(['Draft a reply', 'Summarize it', 'What do they want?'])
    // An email with a PDF is files.
    expect(kindOf({ files: [email, pdf], link: null, text: null })).toBe('files')
  })

  it('adds a drop’s files to those waiting, each once; a link or text takes their place', () => {
    const waiting: Intake = { files: [pdf], link: null, text: null }
    expect(withDropped(waiting, { files: [sheet, pdf], link: null, text: null }).files).toEqual([pdf, sheet])
    expect(withDropped(waiting, { files: [], link: 'https://example.com', text: null })).toEqual({ files: [], link: 'https://example.com', text: null })
    expect(withDropped({ files: [], link: null, text: 'hi' }, { files: [sheet], link: null, text: null })).toEqual({ files: [sheet], link: null, text: null })
    expect(withDropped(null, { files: [sheet], link: null, text: null }).files).toEqual([sheet])
  })

  it('takes one file out, the same file dropped twice too; the last one out leaves nothing', () => {
    const again = new File(['%PDF'], 'Lease 2027.pdf', { type: 'application/pdf' })
    expect(withoutFile({ files: [pdf, sheet], link: null, text: null }, again)).toEqual({ files: [sheet], link: null, text: null })
    expect(withoutFile({ files: [sheet], link: null, text: null }, sheet)).toBeNull()
    // Another file of the same name but another size stays.
    const longer = new File(['a,b,c'], 'budget.csv', { type: 'text/csv' })
    expect(withoutFile({ files: [sheet], link: null, text: null }, longer)?.files).toEqual([sheet])
  })

  it('names a file under its tile without the kind its page shows', () => {
    expect(tileName(pdf)).toEqual(['Lease 2027'])
    expect(tileName(new File(['x'], 'Rent for March.eml'))).toEqual(['Rent for March'])
    expect(tileName(new File(['x'], 'v2.final.docx'))).toEqual(['v2.final'])
    // A name that is only a kind, or has none, is kept whole.
    expect(tileName(new File(['x'], '.env'))).toEqual(['.env'])
    expect(tileName(new File(['x'], 'README'))).toEqual(['README'])
    expect(tileName(new File(['x'], 'Quarterly numbers.xlsx'))).toEqual(['Quarterly numbers'])
    // A long one loses its middle, its first words and its last on a line each, so two versions
    // still differ by their ends.
    expect(tileName(new File(['x'], 'Budget 2027 with the new rent v1.xlsx'))).toEqual(['Budget', '…rent v1'])
    expect(tileName(new File(['x'], 'Budget 2027 with the new rent v2.xlsx'))).toEqual(['Budget', '…rent v2'])
    // A name with no spaces is cut by letters.
    expect(tileName(new File(['x'], 'IMG_20261028_134501_HDR.jpg'))).toEqual(['IMG_202610', '…34501_HDR'])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { cantOpen, sortDropped } from './readable'

const bytes = (text: string) => new TextEncoder().encode(text)
const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
const file = (name: string, body: BlobPart = 'words', size?: number) => {
  const made = new File([body], name)
  if (size !== undefined) Object.defineProperty(made, 'size', { value: size })
  return made
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what the pinned agent can open, as `read_file` does', () => {
  it('opens what the daemon reads: documents and pictures by name, and any text', () => {
    for (const name of ['Lease.pdf', 'Notes.docx', 'Budget.xlsx', 'Old budget.xls', 'Deck.pptx', 'Photo.JPG', 'Chart.png', 'Clip.gif', 'Shot.webp']) {
      expect(cantOpen(name, 1000, binary, 'Maya'), name).toBeNull()
    }
    // Text with any name or none: a Mail message, a CSV, code, a note, a licence key.
    for (const name of ['Rent for March.eml', 'rows.csv', 'main.rs', 'README', 'licence.key']) {
      expect(cantOpen(name, 1000, bytes('Subject: Rent\n\nHello'), 'Maya'), name).toBeNull()
    }
    // A PDF or picture without its name's ending is told by its first bytes, as the daemon does.
    expect(cantOpen('scan', 1000, bytes('%PDF-1.7\n\0\0'), 'Maya')).toBeNull()
    expect(cantOpen('download', 1000, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]), 'Maya')).toBeNull()
  })

  it('turns away what it can’t open, saying where to go to make one it can', () => {
    expect(cantOpen('Plan.pages', 1000, binary, 'Maya')).toBe('Maya can’t open Pages files. In Pages, choose File › Export To › PDF, then drop the PDF.')
    expect(cantOpen('Sums.numbers', 1000, binary, 'Maya')).toBe('Maya can’t open Numbers files. In Numbers, choose File › Export To › Excel, then drop that.')
    expect(cantOpen('Talk.key', 1000, binary, 'Maya')).toBe('Maya can’t open Keynote files. In Keynote, choose File › Export To › PDF, then drop the PDF.')
    expect(cantOpen('IMG_0001.HEIC', 1000, binary, 'Maya')).toBe('Maya can’t open this photo. In Preview, choose File › Export, pick JPEG, then drop the new photo.')
    expect(cantOpen('Letter.doc', 1000, binary, 'Maya')).toBe('Maya can’t open old Word files. Open it in Pages, choose File › Export To › PDF, then drop the PDF.')
    expect(cantOpen('Photos.zip', 1000, binary, 'Maya')).toBe('Maya can’t open compressed files. Double-click to open, then drop the files inside.')
    expect(cantOpen('Call.m4a', 1000, binary, 'Maya')).toBe('Maya can’t listen to recordings.')
    expect(cantOpen('Demo.mov', 1000, binary, 'Maya')).toBe('Maya can’t watch videos.')
    // Anything else that isn't text: the daemon finds a NUL in its first bytes and won't read it.
    expect(cantOpen('data.bin', 1000, binary, 'Maya')).toBe('Maya can’t open this kind of file.')
  })

  it('turns away a file over 25 MB, as the daemon won’t keep it, but says first what it is', () => {
    expect(cantOpen('Big.pdf', 25 * 1024 * 1024 + 1, binary, 'Maya')).toBe('Files over 25 MB are too big to send.')
    expect(cantOpen('Fits.pdf', 25 * 1024 * 1024, binary, 'Maya')).toBeNull()
    expect(cantOpen('Holiday.mov', 200 * 1024 * 1024, binary, 'Maya')).toBe('Maya can’t watch videos.')
  })
})

describe('a drop, sorted', () => {
  it('takes what opens, and says in a line for each reason what was left out', async () => {
    const pdf = file('Lease.pdf')
    expect(await sortDropped([pdf], [], 'Maya')).toEqual({ taken: [pdf], away: null })
    // One thing dropped: why, as it is.
    expect(await sortDropped([file('Call.mp3', binary)], [], 'Maya')).toEqual({ taken: [], away: 'Maya can’t listen to recordings.' })
    // More: which, and why.
    expect(await sortDropped([pdf, file('Call.mp3', binary)], [], 'Maya')).toEqual({ taken: [pdf], away: 'Left out Call.mp3. Maya can’t listen to recordings.' })
    expect(await sortDropped([pdf, file('A.mp3', binary), file('B.wav', binary)], [], 'Maya')).toEqual({ taken: [pdf], away: 'Left out A.mp3 and B.wav. Maya can’t listen to recordings.' })
    // Two reasons: two lines, each with its own way on.
    expect(await sortDropped([pdf, file('A.mp3', binary), file('Plan.pages', binary)], [], 'Maya')).toEqual({
      taken: [pdf],
      away: 'Left out A.mp3. Maya can’t listen to recordings.\nLeft out Plan.pages. Maya can’t open Pages files. In Pages, choose File › Export To › PDF, then drop the PDF.',
    })
  })

  it('reads a text file’s first bytes to know it is text', async () => {
    const notes = file('notes', 'plain words')
    expect(await sortDropped([notes, file('blob', binary)], [], 'Maya')).toEqual({ taken: [notes], away: 'Left out blob. Maya can’t open this kind of file.' })
  })

  it('takes ten files at a time, counting those already waiting, and names two of the rest', async () => {
    const files = Array.from({ length: 14 }, (_, index) => file(`Page ${index + 1}.pdf`))
    const sorted = await sortDropped(files, [], 'Maya')
    expect(sorted.taken).toEqual(files.slice(0, 10))
    expect(sorted.away).toBe('Left out Page 11.pdf, Page 12.pdf and 2 more. Only 10 files at a time. Send these, then drop the rest.')
    const more = await sortDropped(files.slice(0, 3), [], 'Maya', 8)
    expect(more.taken).toEqual(files.slice(0, 2))
    expect(more.away).toBe('Left out Page 3.pdf. Only 10 files at a time. Send these, then drop the rest.')
  })

  it('turns a folder away, and a Pages file that comes as one says what it is', async () => {
    expect(await sortDropped([], ['Receipts'], 'Maya')).toEqual({ taken: [], away: 'Maya can’t take a folder here. Open it and drop the files inside.' })
    expect(await sortDropped([], ['Plan.pages'], 'Maya')).toEqual({ taken: [], away: 'Maya can’t open Pages files. In Pages, choose File › Export To › PDF, then drop the PDF.' })
  })

  it('turns an iPhone photo into a JPEG it can open, and says how when it can’t be drawn', async () => {
    const photo = file('IMG_0001.HEIC', binary)
    // Where the picture can't be drawn, as in a page without `createImageBitmap`: why, and how.
    expect(await sortDropped([photo], [], 'Maya')).toEqual({ taken: [], away: 'Maya can’t open this photo. In Preview, choose File › Export, pick JPEG, then drop the new photo.' })
    // Where it can, as WebKit draws HEIC, TIFF and BMP: a JPEG no longer on its longest side than a
    // model is sent, white where the picture was see-through.
    const drawn: { width: number; height: number; fill?: string }[] = []
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4032, height: 3024, close: () => {} }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      // The canvas has its size before its context is asked for.
      const { width, height } = this
      const context = { fillStyle: '', fillRect: () => drawn.push({ width, height, fill: context.fillStyle }), drawImage: () => {} }
      return context as unknown as CanvasRenderingContext2D
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type) => done(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type })))
    const sorted = await sortDropped([photo], [], 'Maya')
    expect(sorted.away).toBeNull()
    expect(sorted.taken.map((taken) => [taken.name, taken.type])).toEqual([['IMG_0001.jpg', 'image/jpeg']])
    expect(drawn).toEqual([{ width: 2576, height: 1932, fill: 'white' }])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { besidePath, PAGE_BRIDGE, PAGE_POLICY, PAGE_SANDBOX, pageDocument, pageMessage } from './pageFrame'
import { readerFormat } from './reader'

afterEach(() => vi.unstubAllGlobals())

describe('a web page in the reader', () => {
  it('runs with no origin, and may fetch nothing nor reach this computer', () => {
    expect(PAGE_SANDBOX).toContain('allow-scripts')
    expect(PAGE_SANDBOX).not.toContain('allow-same-origin')
    expect(PAGE_POLICY).toContain("connect-src 'none'")
    expect(PAGE_POLICY).toContain("form-action 'none'")
    // Only the web over https: never http://localhost or another app on this computer.
    expect(PAGE_POLICY).not.toMatch(/\bhttp:/)
  })

  it('gets the policy and the reader’s script first, and the files beside it taken in', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/files/raw') && url.includes('chart.png')) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } })
      if (url.includes(encodeURIComponent('/w/site/style.css'))) return new Response(JSON.stringify({ text: 'body{color:red}' }), { status: 200 })
      if (url.includes(encodeURIComponent('/w/app.js'))) return new Response(JSON.stringify({ text: 'run("</script>")' }), { status: 200 })
      return new Response(JSON.stringify({ error: 'gone' }), { status: 404 })
    }))
    const html = '<html><head><base href="http://evil/"><meta http-equiv="content-security-policy" content="default-src *"><link rel="stylesheet" href="style.css"></head>'
      + '<body><img src="chart.png"><img src="https://cdn.example/x.png"><img src="missing.png"><script src="../app.js"></script></body></html>'
    const ready = await pageDocument(html, '/w/site/page.html')
    const doc = new DOMParser().parseFromString(ready, 'text/html')
    const head = doc.head.children
    expect(head[0].getAttribute('charset')).toBe('utf-8')
    expect(head[1].getAttribute('content')).toBe(PAGE_POLICY)
    expect(head[2].textContent).toBe(PAGE_BRIDGE)
    expect(doc.querySelector('base')).toBeNull()
    expect(doc.querySelectorAll('meta[http-equiv]')).toHaveLength(1)
    expect(doc.querySelector('style')?.textContent).toBe('body{color:red}')
    const images = [...doc.querySelectorAll('img')].map((image) => image.getAttribute('src'))
    expect(images[0]).toBe('data:image/png;base64,iVBORw==')
    expect(images.slice(1)).toEqual(['https://cdn.example/x.png', 'missing.png'])
    const script = [...doc.querySelectorAll('script')].at(-1)!
    expect(script.hasAttribute('src')).toBe(false)
    expect(ready).toContain('run("<\\/script>")')
  })

  it('names a file beside the page by its full path', () => {
    expect(besidePath('/w/site/page.html', 'img/chart%20one.png?v=2#x')).toBe('/w/site/img/chart one.png')
    expect(besidePath('/w/site/page.html', '../../../../etc/x.css')).toBe('/etc/x.css')
    expect(besidePath('C:\\w\\page.html', './a.png')).toBe('C:\\w\\a.png')
  })

  it('lets go of the marked words on Escape, which reaches the page and not the reader', async () => {
    const sent: { type?: string; text?: string }[] = []
    vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => { sent.push(message as { type?: string; text?: string }) })
    // jsdom lays nothing out: the marked words are somewhere.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 10, bottom: 30, left: 5, right: 80 }) })
    try {
      document.body.innerHTML = '<p>Sales grew 12% in Q3.</p>'
      new Function(PAGE_BRIDGE)()
      document.dispatchEvent(new Event('pointerdown'))
      const range = document.createRange()
      range.selectNodeContents(document.querySelector('p')!.firstChild!)
      document.getSelection()!.addRange(range)
      document.dispatchEvent(new Event('pointerup'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sent.at(-1)).toMatchObject({ lw: 'reader', type: 'selection', text: 'Sales grew 12% in Q3.' })

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(String(document.getSelection())).toBe('')
      expect(sent.at(-1)).toMatchObject({ lw: 'reader', type: 'selection', text: '' })
    } finally {
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
      vi.restoreAllMocks()
    }
  })

  it('marks the parts asked about in the page, with a bubble after each, and puts the page back as it was', async () => {
    // The page runs in a frame of its own, as it does in the reader, and talks to its parent.
    const holder = document.createElement('iframe')
    document.body.append(holder)
    const inner = holder.contentWindow! as Window & typeof globalThis
    const doc = holder.contentDocument!
    const sent: { type?: string; text?: string; parts?: unknown }[] = []
    vi.spyOn(inner.parent, 'postMessage').mockImplementation((message: unknown) => { sent.push(message as { type?: string }) })
    // jsdom lays nothing out: every mark is at 5,10 to 80,30.
    vi.spyOn(inner.Element.prototype, 'getClientRects').mockImplementation(() => [{ top: 10, bottom: 30, left: 5, right: 80 }] as unknown as DOMRectList)
    const frames: FrameRequestCallback[] = []
    vi.spyOn(inner, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length })
    try {
      const page = '<p>Next actions often relate to recent ones. SASRec beat <b>Markov-chain</b> and RNN baselines.</p><div style="background: rgb(20, 20, 24)"><p>Costs fell.</p></div>'
      doc.body.innerHTML = page
      new inner.Function(PAGE_BRIDGE)()
      const tell = (data: Record<string, unknown>) => inner.dispatchEvent(new inner.MessageEvent('message', { data: { lw: 'reader', ...data }, source: inner.parent }))
      const said = () => sent.map((message) => JSON.parse(JSON.stringify(message)) as unknown)
      const document = doc
      const mark = (text: string, look: string, more: Record<string, unknown> = {}) => ({ text, look, fresh: false, lit: false, open: false, label: `Show the answer about ${text}`, title: 'why?', figure: null, initials: 'WR', ...more })
      tell({ type: 'marks', asking: null, parts: [mark('beat Markov-chain', 'waiting'), mark('Costs fell.', 'busy', { figure: 'data:image/webp;base64,AAAA' }), mark('Sales fell.', 'read')] })

      // The words are marked where they are, across elements; the bubble is in the line after them.
      const marks = [...document.querySelectorAll('.lw-mark')]
      expect(marks.map((element) => element.textContent)).toEqual(['beat ', 'Markov-chain', 'Costs fell.'])
      expect(marks[0].className).toBe('lw-mark lw-waiting')
      expect(marks[2].className).toBe('lw-mark lw-busy lw-dark')
      const bubbles = [...document.querySelectorAll<HTMLButtonElement>('.lw-slot > .lw-bubble')]
      expect(bubbles.map((bubble) => bubble.getAttribute('aria-label'))).toEqual(['Show the answer about beat Markov-chain', 'Show the answer about Costs fell.'])
      expect(marks[1].nextElementSibling!.firstElementChild).toBe(bubbles[0])
      expect(bubbles[0].className).toBe('lw-bubble lw-waiting')
      expect(bubbles[0].querySelector('.lw-face')!.textContent).toBe('WR')
      expect(bubbles[1].querySelector('img')!.getAttribute('src')).toBe('data:image/webp;base64,AAAA')

      // Where each is, dark behind it or not; one the page no longer has is missing.
      const parts = { lw: 'reader', type: 'parts', parts: [
        { text: 'beat Markov-chain', rects: [{ top: 10, bottom: 30, left: 5, right: 80 }, { top: 10, bottom: 30, left: 5, right: 80 }], missing: false, dark: false },
        { text: 'Costs fell.', rects: [{ top: 10, bottom: 30, left: 5, right: 80 }], missing: false, dark: true },
        { text: 'Sales fell.', rects: [], missing: true, dark: false },
      ] }
      expect(sent.at(-1)).toEqual(parts)
      sent.length = 0
      inner.dispatchEvent(new inner.Event('scroll'))
      inner.dispatchEvent(new inner.Event('scroll'))
      expect(sent).toEqual([])
      frames.splice(0).forEach((frame) => frame(0))
      expect(said()).toEqual([parts])

      // The bubble, or the marked words, open the answer; other words do not.
      sent.length = 0
      document.querySelector('p')!.dispatchEvent(new inner.MouseEvent('click', { bubbles: true }))
      expect(sent).toEqual([])
      bubbles[0].click()
      marks[2].dispatchEvent(new inner.MouseEvent('click', { bubbles: true }))
      expect(said()).toEqual([{ lw: 'reader', type: 'open', text: 'beat Markov-chain' }, { lw: 'reader', type: 'open', text: 'Costs fell.' }])
      // Escape in the page, with nothing marked in it, is passed to the reader: it closes the answer.
      sent.length = 0
      document.dispatchEvent(new inner.KeyboardEvent('keydown', { key: 'Escape' }))
      expect(said()).toEqual([{ lw: 'reader', type: 'escape' }])

      // A look changing leaves the marks in place; nothing asked about any more puts the page back.
      tell({ type: 'marks', asking: null, parts: [mark('beat Markov-chain', 'read', { lit: true }), mark('Costs fell.', 'busy'), mark('Sales fell.', 'read')] })
      expect(document.querySelector('.lw-mark')).toBe(marks[0])
      expect(marks[0].className).toBe('lw-mark lw-read lw-lit')
      // A bubble wears the lightness of the page under it: light on the light part, dark on the dark one.
      expect(bubbles[0].className).toBe('lw-bubble lw-read')
      expect(bubbles[1].className).toBe('lw-bubble lw-busy lw-dark')
      tell({ type: 'marks', asking: null, parts: [] })
      expect(document.body.innerHTML).toBe(page)
    } finally {
      vi.restoreAllMocks()
      holder.remove()
    }
  })

  it('takes only well-formed messages from the page’s script', () => {
    expect(pageMessage({ lw: 'reader', type: 'ready' })).toEqual({ type: 'ready' })
    expect(pageMessage({ lw: 'reader', type: 'open', text: 'Sales' })).toEqual({ type: 'open', text: 'Sales' })
    expect(pageMessage({ lw: 'reader', type: 'escape' })).toEqual({ type: 'escape' })
    expect(pageMessage({ lw: 'reader', type: 'parts', parts: [{ text: 'Sales', rects: [{ top: 1, bottom: 2, left: 3, right: 4 }, { top: 'x' }], dark: true }, { rects: [] }] }))
      .toEqual({ type: 'parts', parts: [{ text: 'Sales', rects: [{ top: 1, bottom: 2, left: 3, right: 4 }], missing: false, dark: true }] })
    expect(pageMessage({ lw: 'reader', type: 'parts', parts: 'x' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'open' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'selection', text: 'Sales', rect: { top: 1, bottom: 2, left: 3, right: 4 } })).toEqual({ type: 'selection', text: 'Sales', rect: { top: 1, bottom: 2, left: 3, right: 4 } })
    expect(pageMessage({ lw: 'reader', type: 'selection', text: 'Sales', rect: { top: 'x' } })).toEqual({ type: 'selection', text: 'Sales', rect: undefined })
    expect(pageMessage({ type: 'selection', text: 'Sales' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'navigate', url: 'x' })).toBeNull()
    expect(pageMessage('hello')).toBeNull()
  })
})

describe('what the reader reads', () => {
  it('reads documents, pages, tables, code and pictures, and leaves the rest to their own apps', () => {
    expect(readerFormat('/w/report.md')).toBe('markdown')
    expect(readerFormat('/w/site.HTML')).toBe('page')
    expect(readerFormat('/w/sales.csv')).toBe('table')
    expect(readerFormat('/w/data.json')).toBe('code')
    expect(readerFormat('/w/notes.txt')).toBe('text')
    expect(readerFormat('/w/brief.docx')).toBe('document')
    expect(readerFormat('/w/deck.pdf')).toBe('document')
    expect(readerFormat('/w/chart.png')).toBe('picture')
    expect(readerFormat('/w/old.doc')).toBeNull()
    expect(readerFormat('/w/archive.zip')).toBeNull()
  })
})

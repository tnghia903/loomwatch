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

  it('takes only well-formed messages from the page’s script', () => {
    expect(pageMessage({ lw: 'reader', type: 'ready' })).toEqual({ type: 'ready' })
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

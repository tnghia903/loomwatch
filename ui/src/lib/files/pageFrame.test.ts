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
      if (url.includes(encodeURIComponent('/w/site/js/app.js'))) return new Response(JSON.stringify({ text: 'run("</script>")' }), { status: 200 })
      return new Response(JSON.stringify({ error: 'gone' }), { status: 404 })
    }))
    const html = '<html><head><base href="http://evil/"><meta http-equiv="content-security-policy" content="default-src *"><link rel="stylesheet" href="style.css"></head>'
      + '<body><img src="chart.png"><img src="https://cdn.example/x.png"><img src="missing.png"><script src="../app.js"></script><script src="js/app.js"></script></body></html>'
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
    const [outside, script] = [...doc.querySelectorAll('script')].slice(-2)
    // A script above the page's folder is left as written: the page reaches only its own folder.
    expect(outside.getAttribute('src')).toBe('../app.js')
    expect(vi.mocked(fetch).mock.calls.map(([input]) => decodeURIComponent(String(input)))).not.toContainEqual(expect.stringContaining('/w/app.js'))
    expect(script.hasAttribute('src')).toBe(false)
    expect(ready).toContain('run("<\\/script>")')
  })

  it('names a file beside the page by its full path, inside the page’s folder only', () => {
    expect(besidePath('/w/site/page.html', 'img/chart%20one.png?v=2#x')).toBe('/w/site/img/chart one.png')
    expect(besidePath('/w/site/page.html', 'img/../data/sales.csv')).toBe('/w/site/data/sales.csv')
    expect(besidePath('/w/site/page.html', '/data.csv')).toBe('/w/site/data.csv')
    expect(besidePath('C:\\w\\page.html', './a.png')).toBe('C:\\w\\a.png')
    for (const above of ['../other-team/secret.csv', 'img/../../x.css', '../../../../etc/x.css', '.', 'img/..']) expect(besidePath('/w/site/page.html', above)).toBeNull()
    // Named from its stylesheet, still inside the page's folder.
    expect(besidePath('/w/site/page.html', '../fonts/a.woff2', '/w/site/css/style.css')).toBe('/w/site/fonts/a.woff2')
    expect(besidePath('/w/site/page.html', '../../a.woff2', '/w/site/css/style.css')).toBeNull()
  })

  it('hands a clip over as the page runs, and takes in its poster and the pictures and fonts its CSS names', async () => {
    const bytes = (type: string) => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': type } })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input))
      if (url.startsWith('/api/files/read') && url.includes('/w/site/css/style.css')) {
        return new Response(JSON.stringify({ text: '@font-face{src:url(../fonts/brand.woff2)}body{background:url("../img/bg.png")}a{fill:url(#shine)}b{background:url(https://cdn.example/x.png)}i{background:url(../../up.png)}' }), { status: 200 })
      }
      if (url.startsWith('/api/files/raw') && url.endsWith('/w/site/fonts/brand.woff2')) return bytes('font/woff2')
      if (url.startsWith('/api/files/raw') && /\/w\/site\/(img\/bg|img\/dot|poster)\.png$/.test(url)) return bytes('image/png')
      return new Response(JSON.stringify({ error: 'gone' }), { status: 404 })
    }))
    const html = '<html><head><link rel="stylesheet" href="css/style.css"><style>.x{background:url(img/dot.png)}</style></head><body>'
      + '<video src="clip.mp4" poster="poster.png"></video><video><source src="clips/b.webm"></video><audio src="../outside.mp3"></audio>'
      + '<div style="background: url(\'img/dot.png\')"></div></body></html>'
    const doc = new DOMParser().parseFromString(await pageDocument(html, '/w/site/page.html'), 'text/html')
    const [video, holder] = [...doc.querySelectorAll('video')]
    expect(video.hasAttribute('src')).toBe(false)
    expect(video.getAttribute('data-lw-src')).toBe('clip.mp4')
    expect(video.getAttribute('poster')).toBe('data:image/png;base64,AQID')
    expect(holder.querySelector('source')!.getAttribute('data-lw-src')).toBe('clips/b.webm')
    expect(holder.querySelector('source')!.hasAttribute('src')).toBe(false)
    expect(doc.querySelector('audio')!.getAttribute('src')).toBe('../outside.mp3')
    expect(doc.querySelector('audio')!.hasAttribute('data-lw-src')).toBe(false)
    // The stylesheet's own files are named from where it is; the web, the page's own ids and
    // anything above its folder are left as written.
    const [linked, inline] = [...doc.querySelectorAll('style')].map((style) => style.textContent)
    expect(inline).toBe('.x{background:url("data:image/png;base64,AQID")}')
    expect(linked).toBe('@font-face{src:url("data:font/woff2;base64,AQID")}body{background:url("data:image/png;base64,AQID")}a{fill:url(#shine)}b{background:url(https://cdn.example/x.png)}i{background:url(../../up.png)}')
    expect(doc.querySelector('div')!.getAttribute('style')).toBe('background: url("data:image/png;base64,AQID")')
    expect(vi.mocked(fetch).mock.calls.map(([input]) => decodeURIComponent(String(input))).join(' ')).not.toMatch(/outside|up\.png|clip\.mp4|b\.webm/)
  })

  it('answers the page’s fetch and XMLHttpRequest for files beside it through the reader, and hands its clips over as blobs', async () => {
    const holder = document.createElement('iframe')
    document.body.append(holder)
    const inner = holder.contentWindow! as Window & typeof globalThis
    // jsdom's frames have none of fetch's own classes, which a browser's frame has. Its fetch
    // stands for the page's own, which the policy stops.
    const stopped = vi.fn(() => Promise.reject(new TypeError('stopped by the policy')))
    Object.assign(inner, { fetch: stopped, Response, Blob, TextDecoder })
    inner.URL.createObjectURL = () => 'blob:clip'
    const sent: Record<string, unknown>[] = []
    vi.spyOn(inner.parent, 'postMessage').mockImplementation((message: unknown) => { sent.push(message as Record<string, unknown>) })
    const loadsOf = () => sent.filter((message) => message.type === 'load')
    const answer = (id: unknown, file: Record<string, unknown>) => inner.dispatchEvent(new inner.MessageEvent('message', { data: { lw: 'reader', type: 'loaded', id, ...file }, source: inner.parent }))
    const text = (words: string) => new TextEncoder().encode(words).buffer
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    try {
      holder.contentDocument!.body.innerHTML = '<video data-lw-src="clip.mp4"></video>'
      new inner.Function(PAGE_BRIDGE)()
      // The clip is asked for at once, and plays from a blob made in the page.
      expect(loadsOf()).toEqual([{ lw: 'reader', type: 'load', id: 1, url: 'clip.mp4' }])
      answer(1, { status: 200, mediaType: 'video/mp4', body: text('clip') })
      await settle()
      expect(holder.contentDocument!.querySelector('video')!.getAttribute('src')).toBe('blob:clip')

      const fetched = inner.fetch('data/sales.csv')
      expect(loadsOf().at(-1)).toEqual({ lw: 'reader', type: 'load', id: 2, url: 'data/sales.csv' })
      answer(2, { status: 200, mediaType: 'text/csv; charset=utf-8', body: text('region,q3\nNorth,190\n') })
      const response = await fetched
      expect(response.ok).toBe(true)
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
      expect(await response.text()).toBe('region,q3\nNorth,190\n')
      const gone = inner.fetch('../secret.csv')
      answer(3, { status: 404, mediaType: '', body: null })
      expect((await gone).status).toBe(404)
      // The web is left to the page's own fetch.
      await expect(inner.fetch('https://example.com/x.json')).rejects.toThrow('stopped by the policy')
      expect(stopped).toHaveBeenCalledTimes(1)

      const request = new inner.XMLHttpRequest()
      const states: number[] = []
      let loaded = ''
      request.onreadystatechange = () => states.push(request.readyState)
      request.addEventListener('load', function (this: XMLHttpRequest) { loaded = this.responseText })
      request.open('GET', 'data/sales.csv')
      request.send()
      expect(loadsOf().at(-1)).toMatchObject({ id: 4, url: 'data/sales.csv' })
      answer(4, { status: 200, mediaType: 'text/csv', body: text('a,b') })
      await settle()
      expect([request.status, loaded, request.getResponseHeader('Content-Type')]).toEqual([200, 'a,b', 'text/csv'])
      expect(states).toEqual([1, 2, 3, 4])
      const json = new inner.XMLHttpRequest()
      json.responseType = 'json'
      json.open('GET', 'data.json')
      json.send()
      answer(5, { status: 200, mediaType: 'application/json', body: text('{"q3":190}') })
      await settle()
      expect(JSON.stringify(json.response)).toBe('{"q3":190}')
      const web = new inner.XMLHttpRequest()
      let failed = false
      web.onerror = () => { failed = true }
      web.open('GET', 'https://example.com/x.json')
      web.send()
      await settle()
      expect([failed, web.status, loadsOf().length]).toEqual([true, 0, 5])
    } finally {
      vi.restoreAllMocks()
      holder.remove()
    }
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
      const mark = (text: string, look: string, more: Record<string, unknown> = {}) => ({ key: `writer:${text}`, text, look, fresh: false, lit: false, open: false, label: `Show the answer about ${text}`, title: 'why?', figure: null, initials: 'WR', ...more })
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
        { text: 'beat Markov-chain', rects: [{ top: 10, bottom: 30, left: 5, right: 80 }, { top: 10, bottom: 30, left: 5, right: 80 }], missing: false, as: 'beat Markov-chain', dark: false },
        { text: 'Costs fell.', rects: [{ top: 10, bottom: 30, left: 5, right: 80 }], missing: false, as: 'Costs fell.', dark: true },
        { text: 'Sales fell.', rects: [], missing: true, as: 'Sales fell.', dark: false },
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
      expect(said()).toEqual([{ lw: 'reader', type: 'open', key: 'writer:beat Markov-chain' }, { lw: 'reader', type: 'open', key: 'writer:Costs fell.' }])
      // Escape in the page, with nothing marked in it, is passed to the reader: it closes the answer.
      sent.length = 0
      document.dispatchEvent(new inner.KeyboardEvent('keydown', { key: 'Escape' }))
      expect(said()).toEqual([{ lw: 'reader', type: 'escape' }])

      // A look changing leaves the marks in place; nothing asked about any more puts the page back.
      tell({ type: 'marks', asking: null, parts: [mark('beat Markov-chain', 'read', { lit: true }), mark('Costs fell.', 'busy'), mark('Sales fell.', 'read')] })
      expect(document.querySelector('.lw-mark')).toBe(marks[0])
      expect(marks[0].className).toBe('lw-mark lw-read lw-lit')
      // A bubble wears the lightness of the page under it: light on the light part, dark on the dark
      // one; the one whose answer is open is lit.
      expect(bubbles[0].className).toBe('lw-bubble lw-read lw-lit')
      expect(bubbles[1].className).toBe('lw-bubble lw-busy lw-dark')
      tell({ type: 'marks', asking: null, parts: [] })
      expect(document.body.innerHTML).toBe(page)
    } finally {
      vi.restoreAllMocks()
      holder.remove()
    }
  })

  it('shows a bubble for each agent asked about the same words, and the older of two overlapping parts with the newer', async () => {
    const holder = document.createElement('iframe')
    document.body.append(holder)
    const inner = holder.contentWindow! as Window & typeof globalThis
    const doc = holder.contentDocument!
    const sent: unknown[] = []
    vi.spyOn(inner.parent, 'postMessage').mockImplementation((message: unknown) => { sent.push(JSON.parse(JSON.stringify(message))) })
    vi.spyOn(inner.Element.prototype, 'getClientRects').mockImplementation(() => [{ top: 10, bottom: 30, left: 5, right: 80 }] as unknown as DOMRectList)
    vi.spyOn(inner, 'requestAnimationFrame').mockImplementation(() => 1)
    try {
      const page = '<p>Gradient descent is used, <b>not derived</b>. SASRec beat Markov-chain baselines.</p>'
      doc.body.innerHTML = page
      new inner.Function(PAGE_BRIDGE)()
      const tell = (data: Record<string, unknown>) => inner.dispatchEvent(new inner.MessageEvent('message', { data: { lw: 'reader', ...data }, source: inner.parent }))
      const ask = (who: string, text: string, look: string, more: Record<string, unknown> = {}) => ({ key: `${who}:${text}`, text, look, fresh: false, lit: false, open: false, label: `${who}'s answer about ${text}`, title: '', figure: null, initials: who.slice(0, 2).toUpperCase(), ...more })
      const tutor = ask('tutor', 'not derived', 'read')
      const checker = ask('checker', 'not derived', 'waiting', { fresh: true })
      tell({ type: 'marks', asking: null, parts: [tutor, checker] })

      // The words are marked once; after them, one bubble for each agent asked, in the order asked.
      expect([...doc.querySelectorAll('.lw-mark')].map((element) => element.textContent)).toEqual(['not derived'])
      expect(doc.querySelectorAll('.lw-slot')).toHaveLength(1)
      const bubbles = () => [...doc.querySelectorAll<HTMLButtonElement>('.lw-slot > .lw-bubble')]
      expect(bubbles().map((bubble) => bubble.getAttribute('aria-label'))).toEqual(["tutor's answer about not derived", "checker's answer about not derived"])
      expect(bubbles().map((bubble) => bubble.querySelector('.lw-face')!.textContent)).toEqual(['TU', 'CH'])
      // Each bubble wears its own ask's look; the words wear the liveliest of them.
      expect(bubbles().map((bubble) => bubble.className)).toEqual(['lw-bubble lw-read', 'lw-bubble lw-waiting lw-fresh'])
      expect(doc.querySelector('.lw-mark')!.className).toBe('lw-mark lw-waiting lw-fresh')
      expect(doc.querySelector('.lw-slot')!.className).toBe('lw-slot')
      // Pointed at, or reached with the keyboard, a bubble says so, and where it is, for its agent's card.
      sent.length = 0
      bubbles()[1].dispatchEvent(new inner.MouseEvent('mouseenter'))
      bubbles()[1].dispatchEvent(new inner.MouseEvent('mouseleave'))
      bubbles()[0].dispatchEvent(new inner.FocusEvent('focus'))
      inner.dispatchEvent(new inner.Event('scroll'))
      expect(sent.filter((message) => (message as { type: string }).type === 'hover')).toEqual([
        { lw: 'reader', type: 'hover', key: 'checker:not derived', now: false, rect: { top: 0, bottom: 0, left: 0, right: 0 } },
        { lw: 'reader', type: 'hover', key: null, now: false },
        { lw: 'reader', type: 'hover', key: 'tutor:not derived', now: true, rect: { top: 0, bottom: 0, left: 0, right: 0 } },
        // Scrolling the page takes the card away.
        { lw: 'reader', type: 'hover', key: null, now: false },
      ])
      // Each bubble opens its own answer; the words open the one waiting for you.
      sent.length = 0
      bubbles()[0].click()
      bubbles()[1].click()
      doc.querySelector('.lw-mark')!.dispatchEvent(new inner.MouseEvent('click', { bubbles: true }))
      expect(sent).toEqual([
        { lw: 'reader', type: 'open', key: 'tutor:not derived' },
        { lw: 'reader', type: 'open', key: 'checker:not derived' },
        { lw: 'reader', type: 'open', key: 'checker:not derived' },
      ])
      // The page says where the words are once, however many agents were asked about them.
      sent.length = 0
      const [first, second] = bubbles()
      tell({ type: 'marks', asking: null, parts: [tutor, { ...checker, look: 'read', fresh: false, open: true, lit: true }] })
      expect(sent).toEqual([{ lw: 'reader', type: 'parts', parts: [{ text: 'not derived', rects: [{ top: 10, bottom: 30, left: 5, right: 80 }], missing: false, as: 'not derived', dark: false }] }])
      // A look changing keeps each bubble where it is, so none pops up again.
      expect(bubbles()).toHaveLength(2)
      expect(bubbles()[0]).toBe(first)
      expect(bubbles()[1]).toBe(second)
      expect(second.className).toBe('lw-bubble lw-read lw-lit')
      expect(second.getAttribute('aria-expanded')).toBe('true')
      expect(first.getAttribute('aria-expanded')).toBe('false')
      // An agent no longer asked takes its bubble away, and leaves the others where they are: a
      // bubble moved would replay its animations and lose focus.
      const watch = new inner.MutationObserver(() => undefined)
      watch.observe(doc.querySelector('.lw-slot')!, { childList: true })
      tell({ type: 'marks', asking: null, parts: [checker] })
      const left = watch.takeRecords().flatMap((record) => [...record.removedNodes])
      watch.disconnect()
      expect(left).toEqual([first])
      expect(bubbles()).toHaveLength(1)
      expect(bubbles()[0]).toBe(second)
      // The words open the answer waiting for you even when a newer ask is about them too.
      tell({ type: 'marks', asking: null, parts: [ask('checker', 'not derived', 'waiting'), ask('tutor', 'not derived', 'read')] })
      sent.length = 0
      doc.querySelector('.lw-mark')!.dispatchEvent(new inner.MouseEvent('click', { bubbles: true }))
      expect(sent).toEqual([{ lw: 'reader', type: 'open', key: 'checker:not derived' }])

      // Two parts that overlap: the newer is marked, and the older's bubble sits with it.
      tell({ type: 'marks', asking: null, parts: [ask('tutor', 'Markov-chain', 'read'), ask('checker', 'beat Markov-chain baselines', 'busy')] })
      expect([...doc.querySelectorAll('.lw-mark')].map((element) => element.textContent)).toEqual(['beat Markov-chain baselines'])
      expect(bubbles().map((bubble) => bubble.getAttribute('aria-label'))).toEqual(["tutor's answer about Markov-chain", "checker's answer about beat Markov-chain baselines"])
      expect(sent.at(-1)).toEqual({ lw: 'reader', type: 'parts', parts: [
        // The older part is shown on the newer part's words.
        { text: 'Markov-chain', rects: [{ top: 10, bottom: 30, left: 5, right: 80 }], missing: false, as: 'beat Markov-chain baselines', dark: false },
        { text: 'beat Markov-chain baselines', rects: [{ top: 10, bottom: 30, left: 5, right: 80 }], missing: false, as: 'beat Markov-chain baselines', dark: false },
      ] })
      tell({ type: 'marks', asking: null, parts: [] })
      expect(doc.body.innerHTML).toBe(page)
    } finally {
      vi.restoreAllMocks()
      holder.remove()
    }
  })

  it('marks a chart, picture or video in the page from the mark at its corner, sends what it is, where, and its picture, and outlines the things asked about', async () => {
    const holder = document.createElement('iframe')
    document.body.append(holder)
    const inner = holder.contentWindow! as Window & typeof globalThis
    const doc = holder.contentDocument!
    const sent: Record<string, unknown>[] = []
    vi.spyOn(inner.parent, 'postMessage').mockImplementation((message: unknown) => { sent.push(message as Record<string, unknown>) })
    // jsdom lays nothing out: every thing is 300 by 150 at 10,20. It draws nothing either: the
    // picture is whatever the canvas gives.
    let width = 300
    let top = 20
    vi.spyOn(inner.Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top, left: 10, width, height: 150, right: 10 + width, bottom: top + 150, x: 10, y: top, toJSON: () => ({}) }) as DOMRect)
    // The page's own size changes, as a chart that fits itself to the page makes it.
    const resized: (() => void)[] = []
    Object.assign(inner, { ResizeObserver: class { constructor(callback: () => void) { resized.push(callback) } observe() {} unobserve() {} disconnect() {} } })
    vi.spyOn(inner.Element.prototype, 'getClientRects').mockImplementation(() => [{ top: 20, left: 10, right: 310, bottom: 170 }] as unknown as DOMRectList)
    const drawn: unknown[] = []
    vi.spyOn(inner.HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ scale: () => undefined, fillRect: () => undefined, drawImage: (thing: unknown) => drawn.push(thing) }) as unknown as CanvasRenderingContext2D)
    vi.spyOn(inner.HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob(['png']) as Blob))
    vi.spyOn(inner, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1 })
    const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
    try {
      const page = '<h2>Sales by region</h2><canvas id="chart"></canvas><figure><img alt="The team"></figure><section><h3>Launch</h3><video></video><video></video></section>'
      doc.body.innerHTML = page
      new inner.Function(PAGE_BRIDGE)()
      const marks = () => [...doc.querySelectorAll<HTMLButtonElement>('.lw-thing-mark')]
      // Each mark says which thing it asks about (they come after the page), and its tooltip what it is.
      expect(marks().map((mark) => mark.getAttribute('aria-label'))).toEqual(['Ask about the chart under “Sales by region”', 'Ask about the picture “The team”', 'Ask about the video under “Launch”', 'Ask about the video under “Launch”'])
      expect(marks().map((mark) => mark.title)).toEqual(['Ask about this chart', 'Ask about this picture', 'Ask about this video', 'Ask about this video'])
      // The reader is told which kinds the page has, for its tip.
      expect(sent).toContainEqual({ lw: 'reader', type: 'things', what: ['chart', 'picture', 'video'] })
      // The marks and outlines are over the page, never in it.
      expect(doc.body.querySelector('.lw-things, .lw-thing-mark')).toBeNull()

      // Pointing at the chart shows its mark, at its corner; pressing the mark marks the chart.
      doc.querySelector('canvas')!.dispatchEvent(new inner.PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
      expect(marks()[0].classList.contains('lw-on')).toBe(true)
      // Outside the chart, above its top left (its bubbles hang above its top right), so it covers
      // none of the chart; across the corner when the page's top edge leaves no room.
      expect([marks()[0].style.left, marks()[0].style.top]).toEqual(['4px', '6px'])
      top = 100
      doc.querySelector('canvas')!.dispatchEvent(new inner.PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
      marks()[1].focus()
      marks()[0].focus()
      expect([marks()[0].style.left, marks()[0].style.top]).toEqual(['10px', '68px'])
      top = 20
      marks()[0].click()
      await settle()
      const thing = sent.find((message) => message.type === 'thing')!
      expect(thing).toMatchObject({ lw: 'reader', type: 'thing', what: 'chart', path: 'canvas#chart', text: 'The chart under “Sales by region”', rect: { top: 20, bottom: 170, left: 10, right: 310 } })
      expect(Object.prototype.toString.call(thing.picture)).toBe('[object ArrayBuffer]')
      expect(drawn).toEqual([doc.querySelector('canvas')])
      expect(doc.querySelector('.lw-thing-box.lw-marking')).not.toBeNull()
      // Escape lets go of it.
      doc.dispatchEvent(new inner.KeyboardEvent('keydown', { key: 'Escape' }))
      expect(sent.at(-1)).toMatchObject({ type: 'selection', text: '' })
      expect(doc.querySelector('.lw-thing-box')).toBeNull()
      // A picture by its own name; the second of two videos by its place among them.
      sent.length = 0
      marks()[1].click()
      await settle()
      marks()[3].click()
      await settle()
      const things = sent.filter((message) => message.type === 'thing')
      expect(things.map((message) => [message.what, message.path, message.text])).toEqual([
        ['picture', 'body > figure > img', 'The picture “The team”'],
        ['video', 'body > section > video:nth-of-type(2)', 'The video under “Launch”'],
      ])

      // A thing asked about is outlined, with its bubble at its corner, and says where it is; one
      // the page has not drawn yet is missing until it is.
      sent.length = 0
      const tell = (data: Record<string, unknown>) => inner.dispatchEvent(new inner.MessageEvent('message', { data: { lw: 'reader', ...data }, source: inner.parent }))
      const ask = (key: string, path: string) => ({ key, text: `The chart\u0001element:chart@${path}`, at: { kind: 'element', what: 'chart', path }, look: 'read', fresh: false, lit: false, open: false, label: 'Writer’s answer', title: '', figure: null, initials: 'WR' })
      // Asked: the reader lets go of the marked thing.
      tell({ type: 'clear' })
      expect(doc.querySelector('.lw-thing-box.lw-marking')).toBeNull()
      tell({ type: 'marks', asking: null, parts: [ask('a', 'canvas#chart'), ask('b', 'canvas#later')] })
      expect(doc.querySelector('.lw-thing-box')!.className).toBe('lw-thing-box lw-read')
      expect(doc.querySelectorAll('.lw-thing-holder .lw-bubble')).toHaveLength(1)
      // The chart fits itself to the page after it is drawn: its outline and bubble follow it.
      expect(doc.querySelector<HTMLElement>('.lw-thing-box')!.style.width).toBe('300px')
      width = 640
      resized.forEach((callback) => callback())
      expect(doc.querySelector<HTMLElement>('.lw-thing-box')!.style.width).toBe('640px')
      expect(doc.querySelector<HTMLElement>('.lw-thing-holder')!.style.left).toBe('650px')
      width = 300
      resized.forEach((callback) => callback())
      // Each size change looks for things again a moment later: let that go by first.
      await settle(350)
      const reported = () => (sent.filter((message) => message.type === 'parts').at(-1)!.parts as { text: string; missing: boolean; rects: unknown[] }[]).map((part) => [part.text.split('@')[1], part.missing, part.rects.length])
      expect(reported()).toEqual([['canvas#chart', false, 1], ['canvas#later', true, 0]])
      expect(doc.body.innerHTML).toBe(page)
      const later = doc.createElement('canvas')
      later.id = 'later'
      doc.body.append(later)
      await settle(350)
      expect(reported()).toEqual([['canvas#chart', false, 1], ['canvas#later', false, 1]])
      expect(doc.querySelectorAll('.lw-thing-holder .lw-bubble')).toHaveLength(2)
      // The bubble opens the answer.
      sent.length = 0
      doc.querySelector<HTMLButtonElement>('.lw-thing-holder .lw-bubble')!.click()
      expect(sent).toContainEqual({ lw: 'reader', type: 'open', key: 'a' })
      // Nothing asked about any more: the outlines go. A thing whose part is in the message box is
      // outlined dashed; the marks carry the asked agent's face.
      tell({ type: 'marks', asking: 'The chart\u0001element:chart@canvas#chart', parts: [], face: { figure: 'data:image/webp;base64,AAAA' } })
      expect(doc.querySelectorAll('.lw-thing-box')).toHaveLength(1)
      expect(doc.querySelector('.lw-thing-box')!.className).toBe('lw-thing-box lw-asking')
      expect(doc.querySelector('.lw-thing-holder')).toBeNull()
      expect(marks()[0].querySelector('img')!.getAttribute('src')).toBe('data:image/webp;base64,AAAA')
      expect(marks()[0].classList.contains('lw-has-face')).toBe(true)
      tell({ type: 'marks', asking: null, parts: [], face: null })
      expect(doc.querySelector('.lw-thing-box, .lw-thing-holder')).toBeNull()
      expect(marks()[0].querySelector('img')).toBeNull()
    } finally {
      vi.restoreAllMocks()
      holder.remove()
    }
  })

  it('finds the things in a page that first laid out at no size once it has one', async () => {
    const holder = document.createElement('iframe')
    document.body.append(holder)
    // The frame's own load comes and goes first: only its size changing can find the chart.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const inner = holder.contentWindow! as Window & typeof globalThis
    const doc = holder.contentDocument!
    const sent: Record<string, unknown>[] = []
    vi.spyOn(inner.parent, 'postMessage').mockImplementation((message: unknown) => { sent.push(message as Record<string, unknown>) })
    let width = 0
    vi.spyOn(inner.Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, left: 0, width, height: width / 2, right: width, bottom: width / 2, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect)
    const resized: (() => void)[] = []
    Object.assign(inner, { ResizeObserver: class { constructor(callback: () => void) { resized.push(callback) } observe() {} unobserve() {} disconnect() {} } })
    vi.spyOn(inner, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1 })
    try {
      doc.body.innerHTML = '<h2>Sales</h2><canvas id="chart"></canvas>'
      new inner.Function(PAGE_BRIDGE)()
      expect(doc.querySelectorAll('.lw-thing-mark')).toHaveLength(0)
      expect(sent.filter((message) => message.type === 'things')).toEqual([])
      width = 400
      resized.forEach((callback) => callback())
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(doc.querySelectorAll('.lw-thing-mark')).toHaveLength(1)
      expect(sent).toContainEqual({ lw: 'reader', type: 'things', what: ['chart'] })
    } finally {
      vi.restoreAllMocks()
      holder.remove()
    }
  })

  it('calls a drawing with no words a picture, says a video’s moment, and takes a drag across a chart’s labels as the chart', async () => {
    const holder = document.createElement('iframe')
    document.body.append(holder)
    const inner = holder.contentWindow! as Window & typeof globalThis
    const doc = holder.contentDocument!
    const sent: Record<string, unknown>[] = []
    vi.spyOn(inner.parent, 'postMessage').mockImplementation((message: unknown) => { sent.push(message as Record<string, unknown>) })
    vi.spyOn(inner.Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, left: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect)
    vi.spyOn(inner.HTMLMediaElement.prototype, 'currentTime', 'get').mockReturnValue(42.4)
    vi.spyOn(inner.HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
    try {
      doc.body.innerHTML = '<h2>Brand</h2><div><svg id="logo"><circle r="4"></circle></svg></div><h2>Trend</h2><div><svg id="trend"><text>2024</text><text>2025</text></svg></div><div><video id="clip"></video></div>'
        + '<h2>Layers</h2><section><div><svg><text>x</text></svg><svg><text>legend</text></svg></div></section>'
      new inner.Function(PAGE_BRIDGE)()
      const names = [...doc.querySelectorAll('.lw-thing-mark')].map((mark) => mark.getAttribute('aria-label'))
      // A chart drawn in stacked layers is one thing: their holder.
      expect(names).toEqual(['Ask about the picture under “Brand”', 'Ask about the chart under “Trend”', 'Ask about the video under “Trend”, at 0:42', 'Ask about the chart under “Layers”'])
      // A drag across the chart's own labels marks the chart rather than its words.
      sent.length = 0
      const range = doc.createRange()
      range.setStart(doc.querySelectorAll('#trend text')[0].firstChild!, 0)
      range.setEnd(doc.querySelectorAll('#trend text')[1].firstChild!, 4)
      doc.getSelection()!.addRange(range)
      doc.dispatchEvent(new inner.Event('pointerup'))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(sent.filter((message) => message.type === 'selection' && message.text)).toEqual([])
      expect(sent.find((message) => message.type === 'thing')).toMatchObject({ what: 'chart', path: 'svg#trend', text: 'The chart under “Trend”' })
      expect(String(doc.getSelection())).toBe('')
    } finally {
      vi.restoreAllMocks()
      holder.remove()
    }
  })

  it('takes only well-formed messages from the page’s script', () => {
    expect(pageMessage({ lw: 'reader', type: 'ready' })).toEqual({ type: 'ready' })
    expect(pageMessage({ lw: 'reader', type: 'open', key: 'writer:Sales' })).toEqual({ type: 'open', key: 'writer:Sales' })
    expect(pageMessage({ lw: 'reader', type: 'open', text: 'Sales' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'hover', key: 'writer:Sales', now: true, rect: { top: 1, bottom: 2, left: 3, right: 4 } })).toEqual({ type: 'hover', key: 'writer:Sales', now: true, rect: { top: 1, bottom: 2, left: 3, right: 4 } })
    expect(pageMessage({ lw: 'reader', type: 'hover', key: null })).toEqual({ type: 'hover', key: null, now: false })
    expect(pageMessage({ lw: 'reader', type: 'hover', key: 'writer:Sales' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'hover', key: 'writer:Sales', rect: { top: 'x' } })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'parts', parts: [{ text: 'Sales', rects: [], as: 'Sales grew' }] })).toEqual({ type: 'parts', parts: [{ text: 'Sales', rects: [], missing: false, as: 'Sales grew', dark: false }] })
    expect(pageMessage({ lw: 'reader', type: 'escape' })).toEqual({ type: 'escape' })
    expect(pageMessage({ lw: 'reader', type: 'parts', parts: [{ text: 'Sales', rects: [{ top: 1, bottom: 2, left: 3, right: 4 }, { top: 'x' }], dark: true }, { rects: [] }] }))
      .toEqual({ type: 'parts', parts: [{ text: 'Sales', rects: [{ top: 1, bottom: 2, left: 3, right: 4 }], missing: false, dark: true }] })
    expect(pageMessage({ lw: 'reader', type: 'parts', parts: 'x' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'open' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'selection', text: 'Sales', rect: { top: 1, bottom: 2, left: 3, right: 4 } })).toEqual({ type: 'selection', text: 'Sales', rect: { top: 1, bottom: 2, left: 3, right: 4 } })
    expect(pageMessage({ lw: 'reader', type: 'selection', text: 'Sales', rect: { top: 'x' } })).toEqual({ type: 'selection', text: 'Sales', rect: undefined })
    expect(pageMessage({ type: 'selection', text: 'Sales' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'navigate', url: 'x' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'load', id: 3, url: 'data/sales.csv' })).toEqual({ type: 'load', id: 3, url: 'data/sales.csv' })
    expect(pageMessage({ lw: 'reader', type: 'load', id: 1.5, url: 'x.csv' })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'load', id: 2, url: 'x'.repeat(5000) })).toBeNull()
    expect(pageMessage({ lw: 'reader', type: 'load', url: 'x.csv' })).toBeNull()
    const rect = { top: 1, bottom: 2, left: 3, right: 4 }
    const picture = new ArrayBuffer(4)
    expect(pageMessage({ lw: 'reader', type: 'thing', what: 'chart', path: 'canvas#chart', text: 'The chart', rect, picture })).toEqual({ type: 'thing', what: 'chart', path: 'canvas#chart', text: 'The chart', rect, picture })
    expect(pageMessage({ lw: 'reader', type: 'thing', what: 'video', path: 'body > video', text: 'The video', rect, picture: 'x' })).toEqual({ type: 'thing', what: 'video', path: 'body > video', text: 'The video', rect })
    expect(pageMessage({ lw: 'reader', type: 'things', what: ['chart', 'table', 'video', 'chart'] })).toEqual({ type: 'things', what: ['chart', 'video'] })
    expect(pageMessage({ lw: 'reader', type: 'things', what: 'chart' })).toBeNull()
    for (const bad of [{ what: 'table' }, { path: '' }, { path: 'a\nb' }, { path: 'a`b' }, { text: '' }, { rect: { top: 'x' } }]) {
      expect(pageMessage({ lw: 'reader', type: 'thing', what: 'chart', path: 'canvas', text: 'The chart', rect, ...bad })).toBeNull()
    }
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
    expect(readerFormat('/w/deck.pdf')).toBe('pdf')
    expect(readerFormat('/w/deck.pptx')).toBe('slides')
    expect(readerFormat('/w/old.ppt')).toBeNull()
    expect(readerFormat('/w/chart.png')).toBe('picture')
    expect(readerFormat('/w/old.doc')).toBeNull()
    expect(readerFormat('/w/archive.zip')).toBeNull()
  })
})

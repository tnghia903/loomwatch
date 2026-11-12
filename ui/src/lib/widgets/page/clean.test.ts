import { describe, expect, it } from 'vitest'

import { cleanMarkup, drawInto } from './clean'

/** `html` cleaned as a page's frame cleans it, written out again. */
function cleaned(html: string): string {
  const holder = document.createElement('template')
  holder.innerHTML = html
  cleanMarkup(holder.content)
  const out = document.createElement('div')
  out.append(holder.content)
  return out.innerHTML
}

describe('a page\'s markup, cleaned', () => {
  it('loses everything that runs, loads, or goes somewhere', () => {
    const out = cleaned([
      '<script>alert(1)</script>',
      '<iframe src="https://example.com/frame"></iframe>',
      '<object data="https://example.com/o"></object><embed src="https://example.com/e">',
      '<meta http-equiv="refresh" content="0;url=https://example.com/refresh">',
      '<link rel="prefetch" href="https://example.com/prefetch"><base href="https://example.com/">',
      '<video src="https://example.com/v.mp4"></video><audio src="https://example.com/a.mp3"></audio>',
      '<svg><image href="https://example.com/i.png"/><foreignObject><div>inside</div></foreignObject>',
      '<animate attributeName="href" to="javascript:alert(1)"/><set attributeName="x" to="1"/></svg>',
    ].join(''))
    expect(out).not.toMatch(/example\.com|<script|<iframe|<object|<embed|<meta|<link|<base|<video|<audio|<image|foreignObject|<animate|<set|javascript:/iu)
    expect(out).not.toContain('inside')
    expect(out).not.toContain('alert(1)')
  })

  it('keeps a link\'s words and a form\'s fields, without the link or the form', () => {
    const out = cleaned('<a href="https://example.com/x">Read more</a><form action="https://example.com/f"><input type="number" value="3"><button>Go</button></form>')
    expect(out).toContain('Read more')
    expect(out).toContain('<input type="number" value="3">')
    expect(out).toContain('<button>Go</button>')
    expect(out).not.toMatch(/<a\b|<form|example\.com/iu)
  })

  it('drops the fields a page could use to ask for a secret', () => {
    const out = cleaned('<input type="password" name="key"><input type="file"><input type="hidden" value="x"><input type="submit"><input type="checkbox" checked>')
    expect(out).not.toMatch(/password|file|hidden|submit/iu)
    expect(out).toContain('<input type="checkbox" checked="">')
  })

  it('takes out handlers and addresses that run code, however they are written', () => {
    const out = cleaned('<button onclick="location.href=\'https://example.com\'" onmouseover="x()">Tap</button><div style="width:10px" data-act="go" aria-label="Go" title="java&#9;script:alert(1)">box</div>')
    expect(out).toBe('<button>Tap</button><div style="width:10px" data-act="go" aria-label="Go">box</div>')
  })

  it('keeps pictures and styles written into the page, and nothing they would load', () => {
    const picture = 'data:image/png;base64,iVBORw0KGgo='
    const out = cleaned(`<img src="${picture}" alt="dot"><img src="https://example.com/p.png" alt="far"><div style="background:url(https://example.com/b.png);color:red">b</div><style>@import url(https://example.com/s.css); .x { background: url(https://example.com/c.png) } .y { background: url(${picture}) }</style>`)
    expect(out).toContain(`<img src="${picture}" alt="dot">`)
    expect(out).toContain('<img alt="far">')
    expect(out).not.toContain('example.com')
    expect(out).toContain('color:red')
    expect(out).toContain(`url(${picture})`)
  })

  it('keeps SVG\'s own drawing, and <use> only when it points inside the page', () => {
    const out = cleaned('<svg viewBox="0 0 10 10"><defs><path id="p" d="M0 0L5 5"/></defs><use href="#p"/><use href="https://example.com/s.svg#p"/><circle cx="5" cy="5" r="2" fill="var(--series-1)"/></svg>')
    expect(out).toContain('<use href="#p">')
    expect(out).toContain('<circle cx="5" cy="5" r="2" fill="var(--series-1)">')
    expect(out).not.toContain('example.com')
  })

  it('lets an element it doesn\'t know give way to what it holds', () => {
    expect(cleaned('<marquee><b>still here</b></marquee>')).toBe('<b>still here</b>')
  })
})

describe('drawing a page again', () => {
  it('keeps the field being typed in, with its words, and changes only what differs', () => {
    const live = document.createElement('div')
    document.body.append(live)
    live.innerHTML = '<p>Old</p><input type="number" value="1"><span>same</span>'
    const field = live.querySelector('input') as HTMLInputElement
    const same = live.querySelector('span') as HTMLSpanElement
    field.focus()
    field.value = '12'
    const next = document.createElement('template')
    next.innerHTML = '<p>New</p><input type="number" value="1" min="0"><span>same</span>'
    drawInto(live, next.content)
    expect(live.querySelector('p')?.textContent).toBe('New')
    expect(live.querySelector('input')).toBe(field)
    expect(field.value).toBe('12')
    expect(field.getAttribute('min')).toBe('0')
    expect(live.querySelector('span')).toBe(same)
    live.remove()
  })

  it('leaves a canvas the page\'s script draws on as it is', () => {
    const live = document.createElement('div')
    live.innerHTML = '<canvas data-canvas="swing" data-lw-taken="" width="300"></canvas>'
    const canvas = live.querySelector('canvas')
    const next = document.createElement('template')
    next.innerHTML = '<canvas data-canvas="swing" width="10"></canvas><p>below</p>'
    drawInto(live, next.content)
    expect(live.querySelector('canvas')).toBe(canvas)
    expect(canvas?.getAttribute('width')).toBe('300')
    expect(live.querySelector('p')?.textContent).toBe('below')
  })
})

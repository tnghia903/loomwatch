import { describe, expect, it } from 'vitest'

import { answerHtml } from './answerHtml'

describe('an answer, formatted for another app', () => {
  it('keeps its headings, lists, bold, tables and working links, and says its charset', () => {
    const html = answerHtml('# Đà Lạt\n\n- **Day 1:** the [lake](https://x.vn/lake)\n\n| Day | Where |\n| --- | --- |\n| 1 | Lake |')
    expect(html.startsWith('<meta charset="utf-8">')).toBe(true)
    expect(html).toContain('<h1>Đà Lạt</h1>')
    expect(html).toContain('<li><strong>Day 1:</strong> the <a href="https://x.vn/lake">lake</a></li>')
    expect(html).toContain('<td>Lake</td>')
  })

  it('keeps raw HTML as text and takes a script link’s address away, as the chat does', () => {
    const html = answerHtml('<img src=x onerror=alert(1)> and [here](javascript:alert(1))')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('here</a>')
  })
})

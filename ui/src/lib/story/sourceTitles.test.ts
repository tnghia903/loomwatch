import { describe, expect, it } from 'vitest'

import { sourceKey, sourceTitles } from './sourceTitles'

const said = (text: string) => [{ type: 'content', content: { type: 'text', text } }]
const call = (name: string, text: string, kind = 'search') => ({ name, relation: 'invoked tool', toolKind: kind, rawInput: {}, kind: kind as never, content: said(text), rawOutput: null })

describe('the titles of the pages a run’s searches found', () => {
  it('reads a Claude model’s search, a page a line, and a ChatGPT plan’s, a title over its address', () => {
    const titles = sourceTitles([
      call('Search the web: US branches of government', [
        'Branches of the U.S. government | USAGov https://www.usa.gov/branches-of-government',
        'https://www.usa.gov/no-title',
        'Legislative branch | USAGov https://www.usa.gov/legislative-branch/',
      ].join('\n')),
      call('Search the web: Chính phủ Việt Nam', [
        'Searched the web for: Chính phủ Việt Nam',
        '',
        'Cơ cấu tổ chức của Chính phủ',
        'https://xaydungchinhsach.chinhphu.vn/co-cau#muc-1',
        'Chính phủ gồm Thủ tướng, các Phó Thủ tướng…',
      ].join('\n')),
    ])
    expect(titles.get('usa.gov/branches-of-government')).toBe('Branches of the U.S. government | USAGov')
    expect(titles.get('usa.gov/legislative-branch')).toBe('Legislative branch | USAGov')
    // An address with no title on its line and a page's line before it has none.
    expect(titles.has('usa.gov/no-title')).toBe(false)
    expect(titles.get('xaydungchinhsach.chinhphu.vn/co-cau')).toBe('Cơ cấu tổ chức của Chính phủ')
    expect([...titles.values()]).not.toContain('Searched the web for: Chính phủ Việt Nam')
  })

  it('names nothing from what isn’t a search, or a search that kept no titles', () => {
    expect(sourceTitles([
      call('Read https://example.com/a', 'Example page https://example.com/a', 'fetch'),
      call('Run npm test', 'see https://example.com/b', 'execute'),
      call('Search the web: prices', 'Basic: 139,000 VND'),
    ]).size).toBe(0)
  })

  it('matches an address whatever its www., closing slash or place on the page', () => {
    expect(sourceKey('https://www.USA.gov/branches/#top')).toBe('usa.gov/branches')
    expect(sourceKey('http://usa.gov/branches?lang=vi')).toBe('usa.gov/branches?lang=vi')
    expect(sourceKey('mailto:me@usa.gov')).toBeNull()
    expect(sourceKey('not a link')).toBeNull()
  })
})

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The landing page's "Then · It improves" chapter (site/learn.js) on the page itself: Writer's work in
// two teams and the lessons it kept. Undo in the chat and Forget on the Learned tab take back the same
// lesson, and the later work shows it: without the checker's lesson the later draft has no sources
// and the checker sends it back again.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const page = readFileSync(path.join(repo, 'site/index.html'), 'utf8')
const script = readFileSync(path.join(repo, 'site/learn.js'), 'utf8')

function load(run = true): HTMLElement {
  document.body.innerHTML = page.slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>'))
  if (run) new Function(script)()
  return document.getElementById('learn')!
}
const shown = (node: Element) => !node.closest('[hidden]')
const all = (win: HTMLElement, selector: string) => [...win.querySelectorAll<HTMLElement>(selector)].filter(shown)
const chat = (win: HTMLElement) => win.querySelector<HTMLElement>('#learn-chat')!
const list = (win: HTMLElement) => win.querySelector<HTMLElement>('#learn-list')!
// The Launch team's work: Writer's draft, and what the checker said about it.
const laterDraft = (win: HTMLElement) => all(chat(win), '.m-writer .tc-bubble').at(-1)!
const laterSources = (win: HTMLElement) => [...laterDraft(win).querySelectorAll('.src')].map((src) => src.textContent)
const laterVerdict = (win: HTMLElement) => all(chat(win), '.m-checker .verdict').at(-1)!.textContent
const lessonsInChat = (win: HTMLElement) => all(chat(win), '.lesson > span').map((line) => line.textContent)
// What the Learned tab lists, whichever tab is open.
const lessonsListed = (win: HTMLElement) => [...list(win).querySelectorAll<HTMLElement>('.lb-list li')].filter((item) => !item.hidden).map((item) => item.querySelector('div')!.firstChild!.textContent)
const tab = (win: HTMLElement, name: string) => win.querySelector<HTMLElement>(`[data-learn-tab="${name}"]`)!

describe('the improves-itself chapter of the landing page', () => {
  it('reads as written with or without its script: every lesson kept, the later draft passing its check', () => {
    for (const run of [false, true]) {
      const win = load(run)
      expect(laterSources(win)).toEqual(['launch plan', 'task board', 'meeting notes'])
      expect(laterVerdict(win)).toBe('All met')
      expect(lessonsInChat(win)).toEqual(['Writer learned: Put a link to the source next to each number.From the check', 'Writer learned: Start each bullet with its key words in bold.From your Love it'])
      expect(lessonsListed(win)).toHaveLength(2)
      // A lesson comes once the work it is about passes: the check's All met, then what was learned.
      expect(all(chat(win), '.verdict, .lesson').map((node) => node.classList.contains('lesson') ? 'lesson' : node.textContent)).toEqual(['Not met', 'All met', 'lesson', 'All met', 'lesson'])
    }
  })

  it('Undo on the checker’s lesson sends the later draft back again, and takes it off the Learned list', () => {
    const win = load()
    all(chat(win), '[data-undo="src"]')[0].click()
    expect(laterSources(win)).toEqual(['no source', 'no source', 'no source'])
    expect(laterVerdict(win)).toBe('Not met')
    expect(lessonsInChat(win)).toEqual(['Writer learned: Start each bullet with its key words in bold.From your Love it'])
    expect(lessonsListed(win)).toEqual(['Start each bullet with its key words in bold.'])
    expect(tab(win, 'list').textContent).toBe('Learned 1')
    // Its button went with it: the keyboard is on the next Undo.
    expect(document.activeElement).toBe(all(chat(win), '[data-undo="bold"]')[0])
  })

  it('Forget on the Learned tab takes back the same lesson the chat shows', () => {
    const win = load()
    tab(win, 'list').click()
    expect(shown(list(win))).toBe(true)
    expect(shown(chat(win))).toBe(false)
    all(list(win), '[data-undo="src"]')[0].click()
    expect(document.activeElement).toBe(all(list(win), '[data-undo="bold"]')[0])
    tab(win, 'chat').click()
    expect(laterVerdict(win)).toBe('Not met')
    expect(lessonsInChat(win)).toEqual(['Writer learned: Start each bullet with its key words in bold.From your Love it'])
  })

  it('says when nothing is left, and Play again puts every lesson back in the chat', () => {
    const win = load()
    tab(win, 'list').click()
    for (const lesson of ['src', 'bold']) all(list(win), `[data-undo="${lesson}"]`)[0].click()
    expect(lessonsListed(win)).toEqual([])
    expect(all(list(win), '.lb-empty')).toHaveLength(1)
    expect(document.activeElement).toBe(list(win).querySelector('.lb-h'))
    all(list(win), '[data-learn-replay]')[0].click()
    expect(shown(chat(win))).toBe(true)
    expect(document.activeElement).toBe(tab(win, 'chat'))
    expect(laterVerdict(win)).toBe('All met')
    expect(lessonsListed(win)).toHaveLength(2)
    expect(tab(win, 'list').textContent).toBe('Learned 2')
  })

  it('moves between its two tabs with the arrow keys', () => {
    const win = load()
    tab(win, 'chat').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(tab(win, 'list').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab(win, 'list'))
    expect(shown(list(win))).toBe(true)
  })
})

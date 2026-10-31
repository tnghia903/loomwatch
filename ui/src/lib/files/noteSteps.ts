/**
 * A slide's speaker notes walked through a step at a time (ADR 0091), each step tied to the parts of
 * the slide it talks about, so the person reading them sees which part each is about. The ties come
 * from the deck alone: a step is tied to a part when it clearly says that part's own words, and to
 * nothing when no part clearly matches. Nothing is guessed.
 */

/** A part of a slide a step can be about, by the key it is drawn with, and its words. */
export interface SlidePart {
  key: string
  text: string
  /** For a row or a column of a table: the table's own key, and which it is. */
  table?: { key: string; along: 'row' | 'column' }
}

/** A step of the notes: its HTML, and the keys of the parts it is about. */
export interface NoteStep {
  html: string
  parts: string[]
}

/**
 * The notes as steps, each tied to the parts it is about.
 *
 * A step is the paragraphs between empty lines, as a speaker spaces what they will say; in notes with
 * no empty line, each paragraph is one, a line that ends in a colon kept with the one after it, as a
 * heading is with its list. A step whose lines are each about a part of their own, a list walking a
 * table row by row, is a step for each line.
 */
export function noteSteps(note: string | undefined, parts: readonly SlidePart[]): NoteStep[] {
  const tie = tiesFor(parts)
  return groupsOf(blocksOf(String(note ?? ''))).flatMap((group) => {
    if (group.length > 1) {
      const lines = joinColons(group.map((block) => [block])).map((line) => ({ html: line.join(''), parts: tie(line.join('')) }))
      const tied = lines.filter((line) => line.parts.length)
      const own = tied.filter((line) => line.parts.some((key) => tied.every((other) => other === line || !other.parts.includes(key))))
      if (tied.length >= 2 && own.length === tied.length) return lines
    }
    const html = group.join('')
    return [{ html, parts: tie(html) }]
  })
}

/** The paragraphs between empty lines, or each paragraph, in notes with no empty line between two. */
function groupsOf(blocks: readonly string[]): string[][] {
  const said = blocks.map((block) => Boolean(wordsOf(block)))
  const spaced = said.some((words, at) => !words && said.slice(0, at).includes(true) && said.slice(at + 1).includes(true))
  const groups: string[][] = [[]]
  blocks.forEach((block, at) => {
    if (!said[at]) {
      if (groups[groups.length - 1]!.length) groups.push([])
      return
    }
    groups[groups.length - 1]!.push(block)
  })
  const filled = groups.filter((group) => group.length)
  return spaced ? filled : joinColons(filled.flat().map((block) => [block]))
}

/** A line that ends in a colon kept with the one after it. */
function joinColons(lines: readonly string[][]): string[][] {
  const joined: string[][] = []
  let open: string[] | null = null
  for (const line of lines) {
    const into: string[] = open ?? []
    into.push(...line)
    if (!open) joined.push(into)
    open = wordsOf(line.join('')).endsWith(':') ? into : null
  }
  return joined
}

/** The top-level paragraphs and lists of the notes' HTML, and any words between them. */
function blocksOf(html: string): string[] {
  const blocks: string[] = []
  const block = /<(p|ul|ol|div|h[1-6])\b[^>]*>[\s\S]*?<\/\1>/gi
  let last = 0
  for (const found of html.matchAll(block)) {
    const before = html.slice(last, found.index)
    if (wordsOf(before)) blocks.push(`<p>${before}</p>`)
    blocks.push(found[0])
    last = found.index + found[0].length
  }
  const after = html.slice(last)
  if (wordsOf(after)) blocks.push(`<p>${after}</p>`)
  return blocks
}

/** The words in some of the deck's HTML, its tags taken out and its few escapes read. */
export function wordsOf(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|div|h[1-6]|tr|td)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (_, name: string) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[name] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** What ties a step, given as HTML, to the slide's parts: the keys of those it clearly talks about. */
function tiesFor(parts: readonly SlidePart[]): (step: string) => string[] {
  const each = parts.map((part) => ({ ...part, words: termsOf(part.text) })).filter((part) => part.words.size)
  // A word on many of the slide's parts says little about which one a step means.
  const weight = new Map<string, number>()
  for (const part of each) for (const word of part.words) weight.set(word, (weight.get(word) ?? 0) + 1)
  for (const [word, count] of weight) weight.set(word, Math.log(1 + each.length / count))
  const rare = Math.log(1 + each.length)
  return (step) => {
    const said = termsOf(wordsOf(step))
    const tied = each.flatMap((part) => {
      const shared = [...part.words].filter((word) => said.has(word))
      if (!shared.length) return []
      const share = sum(shared, weight) / sum([...part.words], weight)
      // Most of a short part's own words, at least two of them or one only it has; or many of a
      // long part's.
      const one = shared.length === 1 && part.words.size <= 3 && (weight.get(shared[0]!) ?? 0) >= rare
      return (share >= 0.5 && (shared.length >= 2 || one)) || (shared.length >= 4 && share >= 0.3) ? [{ ...part, share }] : []
    })
    // A step that says both rows and columns of a table is about the ones it says most of.
    const best = (table: string, along: string) => Math.max(0, ...tied.filter((part) => part.table?.key === table && part.table.along === along).map((part) => part.share))
    const kept = tied.filter((part) => !part.table || best(part.table.key, part.table.along) >= best(part.table.key, part.table.along === 'row' ? 'column' : 'row'))
    // A step about most of the slide is about the slide, not a part of it.
    if (kept.length > 2 && kept.length > each.length / 2) return []
    return kept.map((part) => part.key)
  }
}

const sum = (words: readonly string[], weight: ReadonlyMap<string, number>) => words.reduce((total, word) => total + (weight.get(word) ?? 0), 0)

/**
 * The words that can tie a step to a part: small common words and the paths of files and links left
 * out, the rest in a plain form.
 */
function termsOf(text: string): Set<string> {
  const words = new Set<string>()
  const kept = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').replace(/(?:[a-z]:)?[\\/]?[^\s\\/]+(?:[\\/][^\s\\/]+){2,}[\\/]?/gi, ' ')
  for (const found of kept.toLowerCase().normalize('NFKC').matchAll(/[\p{L}\p{N}]+(?:'\p{L}+)?/gu)) {
    const word = found[0].replace(/'s$/, '')
    // Two letters say too little, unless a number is in them (Q3, 5G); a number alone needs three.
    if (/^\p{N}+$/u.test(word) ? word.length < 3 : word.length < 3 && !/\p{N}/u.test(word)) continue
    if (COMMON.has(word)) continue
    words.add(plain(word))
  }
  return words
}

/** An English word without its common endings, so "exported" and "export" are one word. */
function plain(word: string): string {
  if (!/^[a-z0-9]+$/.test(word)) return word
  let w = word
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  else if (w.length > 6 && w.endsWith('er')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1)
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

const COMMON = new Set(('the and for are but not you all any can had her was one our out has have him his how its may new now old see two way who did get let put say she too use that with this from they will would there their what about which when your been were them then than into more some such only other also just like over very after most made many much must where while these those here each both does done every could should being same before because between through under again further once well even back down still upon around without within along across against among onto off ours yours itself himself herself themselves ourselves why whom whose yet nor per via etc').split(' '))

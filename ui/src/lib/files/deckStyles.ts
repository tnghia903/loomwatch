import JSZip from 'jszip'

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** PowerPoint's own table style, "Medium Style 2 – Accent 1": the one a new table gets, in PowerPoint and in python-pptx. */
const MEDIUM_STYLE_2_ACCENT_1 = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'

/**
 * A `.pptx` with what its slides take from their slide master written onto them, where `pptxtojson`
 * reads only what a slide says itself:
 *
 * - **Bullets.** A placeholder's paragraphs take their bullets from its layout and its master: a
 *   slide made from a "Title and Content" layout says none itself, yet shows them.
 * - **PowerPoint's own table style.** A table made in PowerPoint or by python-pptx is styled by
 *   name, and a deck rarely carries the style itself: its header row and its bands are written in.
 *
 * The deck is returned unchanged when there is nothing to write in. A part that can't be read is
 * left as it is: the deck is still drawn, with what `pptxtojson` reads.
 */
export async function withInheritedStyles(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(bytes)
  const read = async (path: string | null) => {
    const file = path ? zip.file(path) : null
    return file ? new DOMParser().parseFromString(await file.async('string'), 'application/xml') : null
  }
  const definedStyles = await read('ppt/tableStyles.xml')
  const styleDefined = (id: string) => Array.from(definedStyles?.getElementsByTagNameNS(A, 'tblStyle') ?? []).some((style) => style.getAttribute('styleId') === id)
  let changed = false
  const slides = Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
  for (const path of slides) {
    const slide = await read(path)
    if (!slide || slide.getElementsByTagName('parsererror').length) continue
    const layoutPath = await related(zip, path, 'slideLayout')
    const layout = await read(layoutPath)
    const masterPath = layoutPath ? await related(zip, layoutPath, 'slideMaster') : null
    const master = await read(masterPath)
    let slideChanged = false
    for (const shape of Array.from(slide.getElementsByTagNameNS(P, 'sp'))) {
      if (writeBullets(shape, layout, master)) slideChanged = true
    }
    const tables = Array.from(slide.getElementsByTagNameNS(A, 'tbl'))
    if (tables.some((table) => tableStyleOf(table) === MEDIUM_STYLE_2_ACCENT_1) && !styleDefined(MEDIUM_STYLE_2_ACCENT_1)) {
      const accent = await accentOf(zip, masterPath, read)
      for (const table of tables) if (tableStyleOf(table) === MEDIUM_STYLE_2_ACCENT_1 && writeTableStyle(table, accent)) slideChanged = true
    }
    if (slideChanged) {
      zip.file(path, new XMLSerializer().serializeToString(slide))
      changed = true
    }
  }
  return changed ? zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' }) : bytes
}

/** The part a slide's, layout's or master's relationships name, of `kind`, as a path in the deck. */
async function related(zip: JSZip, from: string, kind: string): Promise<string | null> {
  const folder = from.slice(0, from.lastIndexOf('/'))
  const rels = zip.file(`${folder}/_rels/${from.slice(folder.length + 1)}.rels`)
  if (!rels) return null
  const doc = new DOMParser().parseFromString(await rels.async('string'), 'application/xml')
  const target = Array.from(doc.getElementsByTagNameNS(R, 'Relationship')).find((rel) => rel.getAttribute('Type')?.endsWith(`/${kind}`))?.getAttribute('Target')
  if (!target) return null
  const parts = folder.split('/')
  for (const step of target.split('/')) {
    if (step === '..') parts.pop()
    else if (step && step !== '.') parts.push(step)
  }
  return parts.join('/')
}

/** A placeholder: its kind and its number, as a layout or a master matches it. */
function placeholderOf(shape: Element): { type: string; idx: string | null } | null {
  const ph = shape.getElementsByTagNameNS(P, 'ph')[0]
  if (!ph) return null
  return { type: ph.getAttribute('type') ?? 'obj', idx: ph.getAttribute('idx') }
}

/** The placeholder in a layout or a master that a slide's placeholder takes after: the same number, else the same kind. */
function matchIn(doc: Document | null, wanted: { type: string; idx: string | null }): Element | null {
  if (!doc) return null
  const shapes = Array.from(doc.getElementsByTagNameNS(P, 'sp')).map((shape) => ({ shape, ph: placeholderOf(shape) })).filter((each) => each.ph)
  const sameKind = (type: string) => type === wanted.type || (BODY.has(type) && BODY.has(wanted.type))
  return (wanted.idx !== null ? shapes.find((each) => each.ph!.idx === wanted.idx) : undefined)?.shape
    ?? shapes.find((each) => each.ph!.type === wanted.type)?.shape
    ?? shapes.find((each) => sameKind(each.ph!.type))?.shape
    ?? null
}

/** Placeholder kinds the master styles as body text. */
const BODY = new Set(['body', 'obj', 'subTitle'])

/** The list styles a placeholder's paragraphs take after, nearest first. */
function listStyles(shape: Element, layout: Document | null, master: Document | null): Element[] {
  const ph = placeholderOf(shape)!
  const own = (from: Element | null) => (from ? directChild(directChild(from, P, 'txBody'), A, 'lstStyle') : null)
  const inLayout = matchIn(layout, ph)
  const inMaster = matchIn(master, inLayout ? placeholderOf(inLayout)! : ph)
  const styles = master?.getElementsByTagNameNS(P, 'txStyles')[0] ?? null
  const masterStyle = styles ? directChild(styles, P, ph.type === 'title' || ph.type === 'ctrTitle' ? 'titleStyle' : BODY.has(ph.type) ? 'bodyStyle' : 'otherStyle') : null
  return [own(shape), own(inLayout), own(inMaster), masterStyle].filter((style): style is Element => style !== null)
}

const BULLETS = ['buChar', 'buAutoNum', 'buBlip', 'buNone']

/** The bullet a paragraph of `level` takes from `styles`, or `null` for none. */
function bulletFor(styles: readonly Element[], level: number): Element | null {
  for (const style of styles) {
    const props = directChild(style, A, `lvl${level + 1}pPr`)
    const bullet = props ? Array.from(props.children).find((child) => child.namespaceURI === A && BULLETS.includes(child.localName)) : undefined
    if (bullet) return bullet.localName === 'buNone' || bullet.localName === 'buBlip' ? null : bullet
  }
  return null
}

/** A placeholder's paragraphs given the bullets they take after; whether any was. */
function writeBullets(shape: Element, layout: Document | null, master: Document | null): boolean {
  if (!placeholderOf(shape)) return false
  const body = directChild(shape, P, 'txBody')
  if (!body) return false
  let styles: Element[] | null = null
  let wrote = false
  for (const paragraph of Array.from(body.getElementsByTagNameNS(A, 'p'))) {
    let props = directChild(paragraph, A, 'pPr')
    if (props && Array.from(props.children).some((child) => child.namespaceURI === A && BULLETS.includes(child.localName))) continue
    // An empty line has no bullet to show.
    if (!Array.from(paragraph.getElementsByTagNameNS(A, 't')).some((text) => text.textContent?.trim())) continue
    styles ??= listStyles(shape, layout, master)
    const bullet = bulletFor(styles, Math.min(8, Math.max(0, Number(props?.getAttribute('lvl') ?? 0) || 0)))
    if (!bullet) continue
    if (!props) {
      props = paragraph.ownerDocument.createElementNS(A, 'a:pPr')
      paragraph.insertBefore(props, paragraph.firstChild)
    }
    props.appendChild(bullet.cloneNode(true))
    wrote = true
  }
  return wrote
}

function tableStyleOf(table: Element): string | null {
  const props = directChild(table, A, 'tblPr')
  return (props ? directChild(props, A, 'tableStyleId')?.textContent?.trim() : null) ?? null
}

/**
 * "Medium Style 2 – Accent 1" written onto a table's cells that have no fill of their own: the
 * header row in the accent with white bold words, the rows under it in the accent's light tints,
 * every other one darker where the table bands its rows.
 */
function writeTableStyle(table: Element, accent: string): boolean {
  const props = directChild(table, A, 'tblPr')
  const header = props?.getAttribute('firstRow') === '1'
  const banded = props?.getAttribute('bandRow') === '1'
  const light = tint(accent, 0.2)
  const band = tint(accent, 0.4)
  let wrote = false
  Array.from(table.children).filter((row) => row.namespaceURI === A && row.localName === 'tr').forEach((row, index) => {
    const isHeader = header && index === 0
    const bodyIndex = header ? index - 1 : index
    const fill = isHeader ? accent : banded && bodyIndex % 2 === 0 ? band : light
    for (const cell of Array.from(row.children).filter((child) => child.namespaceURI === A && child.localName === 'tc')) {
      const doc = cell.ownerDocument
      let cellProps = directChild(cell, A, 'tcPr')
      if (!cellProps) {
        cellProps = doc.createElementNS(A, 'a:tcPr')
        cell.appendChild(cellProps)
      }
      if (!Array.from(cellProps.children).some((child) => /Fill$/.test(child.localName))) {
        cellProps.appendChild(solidFill(doc, fill))
        wrote = true
      }
      if (!isHeader) continue
      for (const run of Array.from(cell.getElementsByTagNameNS(A, 'r'))) {
        let runProps = directChild(run, A, 'rPr')
        if (!runProps) {
          runProps = doc.createElementNS(A, 'a:rPr')
          run.insertBefore(runProps, run.firstChild)
        }
        if (!runProps.hasAttribute('b')) runProps.setAttribute('b', '1')
        if (!Array.from(runProps.children).some((child) => /Fill$/.test(child.localName))) runProps.insertBefore(solidFill(doc, 'FFFFFF'), runProps.firstChild)
        wrote = true
      }
    }
  })
  return wrote
}

function solidFill(doc: Document, hex: string): Element {
  const fill = doc.createElementNS(A, 'a:solidFill')
  const colour = doc.createElementNS(A, 'a:srgbClr')
  colour.setAttribute('val', hex)
  fill.appendChild(colour)
  return fill
}

/** The deck's first accent colour, from its master's theme, as `RRGGBB`; Office's own blue when it says none. */
async function accentOf(zip: JSZip, masterPath: string | null, read: (path: string | null) => Promise<Document | null>): Promise<string> {
  const theme = await read(masterPath ? await related(zip, masterPath, 'theme') : null)
  const accent = theme?.getElementsByTagNameNS(A, 'accent1')[0]
  const colour = accent ? Array.from(accent.children)[0] : undefined
  const value = colour?.getAttribute('val') ?? colour?.getAttribute('lastClr') ?? ''
  return /^[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : '4472C4'
}

/** `hex` lightened as Office tints a colour: `share` of it, the rest white, mixed in linear light. */
export function tint(hex: string, share: number): string {
  const channel = (at: number) => {
    const srgb = parseInt(hex.slice(at, at + 2), 16) / 255
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
    const mixed = linear * share + (1 - share)
    const back = mixed <= 0.0031308 ? mixed * 12.92 : 1.055 * mixed ** (1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, back)) * 255).toString(16).padStart(2, '0')
  }
  return `${channel(0)}${channel(2)}${channel(4)}`.toUpperCase()
}

function directChild(parent: Element | null, ns: string, name: string): Element | null {
  if (!parent) return null
  return Array.from(parent.children).find((child) => child.namespaceURI === ns && child.localName === name) ?? null
}

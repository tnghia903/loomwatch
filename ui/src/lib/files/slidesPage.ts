import type { Chart, Element, Fill, Image, LineEnd, Shadow, Shape, Slide, Table, TableCell, Text } from 'pptxtojson'

import { lookOf, PAPER_LOOK, type PageLook } from './pageLook'

/** A slide deck as `pptxtojson` reads it out of a `.pptx`. */
export interface ParsedDeck {
  slides: Slide[]
  size: { width: number; height: number }
}

/**
 * A slide deck drawn inside LoomWatch as a web page of its slides, one under another (ADR 0091), so
 * the reader shows it as it shows a page an agent made: its words marked and asked about, any part
 * picked with the Pick switch. Nothing is needed on the computer but LoomWatch.
 *
 * Each slide is drawn at its own size in points, every part where the deck puts it, and the whole
 * slide scaled to the reader's width by the page's own script. Each slide sits under a heading,
 * "Slide 3", so a part picked on it is named by the slide it is on; its speaker notes fold away
 * under it.
 */
export function slidesPage(deck: ParsedDeck, name: string, look: PageLook = PAPER_LOOK): string {
  const width = positive(deck.size.width, 960)
  const height = positive(deck.size.height, 540)
  const slides = deck.slides.map((slide, index) => slideHtml(slide, index + 1, width, height)).join('\n')
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(name)}</title><style>${deckStyle(lookOf(look))}</style></head>`,
    `<body><main class="lw-deck">${slides}</main>`,
    `<script>${fitScript(width)}</script></body></html>`,
  ].join('')
}

/**
 * Each slide's width set to the page's, by the one scale every slide shares: a deck's slides are all
 * one size. And words the deck says to shrink to their box made smaller, a step at a time, until
 * they fit, as PowerPoint does, once: the scale doesn't change what fits.
 */
function fitScript(width: number): string {
  // Points to CSS pixels: 96 to 72.
  const pixels = width * (4 / 3)
  return `(function(){var root=document.documentElement;function fit(){var deck=document.querySelector('.lw-deck');if(!deck)return;root.style.setProperty('--lw-k',String(Math.max(0.1,deck.clientWidth/${pixels.toFixed(3)})));}`
    + `function shrink(){Array.prototype.forEach.call(document.querySelectorAll('.lw-shrink'),function(words){var box=words.parentElement,zoom=1;while(box.scrollHeight>box.clientHeight+1&&zoom>0.3){zoom-=0.05;words.style.zoom=String(zoom);}});}`
    + `addEventListener('resize',fit);fit();shrink();})();`
}

/** The page around the slides: the reader's ground, and each slide paper on it, as a PDF's pages are. */
const deckStyle = (look: PageLook) => [
  `html{background:${look.ground}}`,
  `body{margin:0;padding:24px;color:${look.ink};font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}`,
  '.lw-deck{max-width:1600px;margin:0 auto;display:flex;flex-direction:column;gap:40px}',
  `.lw-slide-number{margin:0 0 8px;font-size:12px;font-weight:500;color:${look.label};letter-spacing:.02em}`,
  '.lw-frame{position:relative;overflow:hidden;background:#fff;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.12),0 12px 32px rgba(0,0,0,.14)}',
  '.lw-canvas{position:relative;transform:scale(var(--lw-k,1));transform-origin:0 0;overflow:hidden;font-family:Calibri,Carlito,"Helvetica Neue",Arial,sans-serif;color:#000}',
  '.lw-canvas p{margin:0}',
  '.lw-canvas ul,.lw-canvas ol{margin:0;padding:0}',
  '.lw-canvas li{margin-left:1.1em}',
  '.lw-el{position:absolute;box-sizing:border-box}',
  '.lw-shape{position:absolute;inset:0;width:100%;height:100%;overflow:visible}',
  '.lw-text{position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word;line-height:1.2}',
  '.lw-text.up{justify-content:flex-start}.lw-text.mid{justify-content:center}.lw-text.down{justify-content:flex-end}',
  '.lw-text.nowrap{white-space:pre}',
  '.lw-text.vertical{writing-mode:vertical-rl}',
  '.lw-picture{position:absolute;inset:0;overflow:hidden}',
  '.lw-picture img{position:absolute;display:block;max-width:none}',
  '.lw-table{border-collapse:collapse;table-layout:fixed;width:100%;height:100%}',
  '.lw-table td{box-sizing:border-box;padding:3.6pt 7.2pt;overflow:hidden;vertical-align:top;white-space:pre-wrap;overflow-wrap:break-word}',
  '.lw-table td.mid{vertical-align:middle}.lw-table td.down{vertical-align:bottom}',
  '.lw-chart{position:absolute;inset:0;width:100%;height:100%}',
  '.lw-chart text{font-family:Calibri,Carlito,"Helvetica Neue",Arial,sans-serif}',
  '.lw-media{border:1pt dashed #6E6862;border-radius:4pt}',
  '.lw-notes{margin-top:10px;font-size:13px;line-height:1.5}',
  `.lw-notes summary{cursor:pointer;color:${look.label};font-size:12px}`,
  '@media (pointer:coarse){.lw-notes summary{min-height:44px;display:flex;align-items:center}}',
  '.lw-notes p{margin:4px 0}',
].join('')

function slideHtml(slide: Slide, number: number, width: number, height: number): string {
  const parts = [...(slide.layoutElements ?? []), ...(slide.elements ?? [])].map((element) => elementHtml(element, number)).join('')
  const notes = slide.note?.trim() ? `<details class="lw-notes"><summary>Notes</summary>${textContent(slide.note)}</details>` : ''
  const id = `lw-slide-${number}`
  // The frame keeps the slide's shape at any scale; the canvas inside is the slide at its own size.
  return `<section class="lw-slide" aria-labelledby="${id}"><h2 class="lw-slide-number" id="${id}">Slide ${number}</h2>`
    + `<div class="lw-frame" style="aspect-ratio:${num(width)}/${num(height)}">`
    + `<div class="lw-canvas" style="width:${pt(width)};height:${pt(height)};${backgroundOf(slide.fill, '#ffffff')}">${parts}</div></div>${notes}</section>`
}

/** A part of slide `slide`, drawn where the deck puts it. */
function elementHtml(element: Element, slide: number): string {
  const inside = (parts: readonly Element[]) => parts.map((part) => elementHtml(part, slide)).join('')
  switch (element.type) {
    case 'text': return textHtml(element)
    case 'shape': return shapeHtml(element)
    case 'image': return pictureHtml(element)
    case 'table': return tableHtml(element)
    case 'chart': return chartHtml(element, slide)
    // A group's parts and a diagram's are placed inside its own box.
    case 'group': return `<div class="lw-el" style="${boxOf(element)}">${inside(element.elements)}</div>`
    case 'diagram': return `<div class="lw-el" style="${boxOf(element)}">${inside(element.elements)}</div>`
    case 'math': return element.picBase64 && isPicture(element.picBase64)
      ? `<div class="lw-el" style="${boxOf(element)}"><div class="lw-picture"><img src="${escapeHtml(element.picBase64)}" alt="${escapeHtml(element.text ?? element.latex ?? '')}" style="inset:0;width:100%;height:100%"></div></div>`
      : `<div class="lw-el" style="${boxOf(element)}"><div class="lw-text mid">${escapeHtml(element.text ?? element.latex ?? '')}</div></div>`
    // A clip in a deck is not drawn: where it goes is, named by its slide, as a picked part is.
    case 'video':
    case 'audio': {
      const kind = element.type === 'video' ? 'Video' : 'Audio'
      return `<div class="lw-el lw-media" style="${boxOf(element)}" role="img" aria-label="${kind} on slide ${slide}" title="${kind}. Open the file in its own app to play it."></div>`
    }
    default: return ''
  }
}

/** Where a part is on its slide, turned and flipped as the deck has it. */
function boxOf(element: { left: number; top: number; width: number; height: number; rotate?: number; isFlipH?: boolean; isFlipV?: boolean }): string {
  const turns = [
    element.rotate ? `rotate(${num(element.rotate)}deg)` : '',
    element.isFlipH ? 'scaleX(-1)' : '',
    element.isFlipV ? 'scaleY(-1)' : '',
  ].filter(Boolean).join(' ')
  return `left:${pt(element.left)};top:${pt(element.top)};width:${pt(element.width)};height:${pt(element.height)}${turns ? `;transform:${turns}` : ''}`
}

function textHtml(element: Text): string {
  const border = element.borderWidth > 0 && element.borderColor ? `;border:${pt(element.borderWidth)} ${borderStyle(element.borderType)} ${color(element.borderColor)}` : ''
  return `<div class="lw-el" style="${boxOf(element)};${backgroundOf(element.fill, '')}${border}${shadowOf(element.shadow, 'box')}">${wordsHtml(element, element.isVertical)}</div>`
}

/** The words in a text box or a shape, inset and lined up as the deck has them. */
function wordsHtml(element: Text | Shape, vertical = false): string {
  if (!element.content?.trim()) return ''
  const inset = element.textInset ?? { l: 7.2, t: 3.6, r: 7.2, b: 3.6 }
  const align = element.vAlign === 'mid' ? 'mid' : element.vAlign === 'down' ? 'down' : 'up'
  const classes = ['lw-text', align, element.wrap === false ? 'nowrap' : '', vertical ? 'vertical' : ''].filter(Boolean).join(' ')
  // Text shrunk to fit its box is drawn at the size the deck shrank it to; text the deck says to
  // shrink, but not by how much, is shrunk by the page until it fits (`fitScript`).
  const scale = element.autoFit?.fontScale && element.autoFit.fontScale > 0 && element.autoFit.fontScale < 100 ? num(element.autoFit.fontScale / 100) : null
  const shrink = !scale && element.autoFit?.type === 'text'
  const words = textContent(element.content)
  const inner = scale ? `<div style="zoom:${scale}">${words}</div>` : shrink ? `<div class="lw-shrink">${words}</div>` : words
  return `<div class="${classes}" style="padding:${pt(inset.t)} ${pt(inset.r)} ${pt(inset.b)} ${pt(inset.l)}">${inner}</div>`
}

function shapeHtml(shape: Shape): string {
  // A straight line across or down has no height or no width, which leaves nothing to draw it in:
  // it gets a point of room, the line along its middle.
  const flatAcross = !(num(shape.height) >= 1)
  const flatDown = !(num(shape.width) >= 1)
  const element = {
    ...shape,
    left: num(shape.left) - (flatDown ? 0.5 : 0),
    top: num(shape.top) - (flatAcross ? 0.5 : 0),
    width: flatDown ? 1 : num(shape.width),
    height: flatAcross ? 1 : num(shape.height),
  }
  const w = element.width
  const h = element.height
  const given = shape.pathViewBox ?? { x: 0, y: 0, width: w, height: h }
  const view = {
    x: num(given.x) - (flatDown ? 0.5 : 0),
    y: num(given.y) - (flatAcross ? 0.5 : 0),
    width: flatDown ? 1 : positive(given.width, w),
    height: flatAcross ? 1 : positive(given.height, h),
  }
  const defs: string[] = []
  const fill = element.strokeOnly || element.shapType === 'line' ? 'none' : svgFill(element.fill, element.id, defs)
  const stroke = element.borderWidth > 0 && element.borderColor ? color(element.borderColor) : 'none'
  const dash = element.borderStrokeDasharray && element.borderStrokeDasharray !== '0' ? ` stroke-dasharray="${escapeHtml(element.borderStrokeDasharray)}"` : ''
  const ends = [endMarker(element.headEnd, 'start', element.id, stroke, defs), endMarker(element.tailEnd, 'end', element.id, stroke, defs)].join('')
  const drawn = element.path
    ? `<svg class="lw-shape" viewBox="${num(view.x)} ${num(view.y)} ${positive(view.width, w)} ${positive(view.height, h)}" preserveAspectRatio="none" aria-hidden="true"${shadowOf(element.shadow, 'svg')}>`
      + `${defs.length ? `<defs>${defs.join('')}</defs>` : ''}<path d="${escapeHtml(element.path)}" fill="${fill}" stroke="${stroke}" stroke-width="${num(element.borderWidth)}"${dash}${ends} vector-effect="non-scaling-stroke"/></svg>`
    : ''
  return `<div class="lw-el" style="${boxOf(element)}">${drawn}${wordsHtml(element)}</div>`
}

function pictureHtml(element: Image): string {
  if (!isPicture(element.base64)) return ''
  // A cropped picture is the part of it left: the rest is drawn outside its box, which hides it.
  const crop = element.rect ?? {}
  const l = clampPercent(crop.l), r = clampPercent(crop.r), t = clampPercent(crop.t), b = clampPercent(crop.b)
  const across = Math.max(1, 100 - l - r)
  const down = Math.max(1, 100 - t - b)
  const place = `left:${num((-l / across) * 100)}%;top:${num((-t / down) * 100)}%;width:${num((100 / across) * 100)}%;height:${num((100 / down) * 100)}%`
  const round = element.geom === 'ellipse' ? ';border-radius:50%' : element.geom === 'roundRect' ? ';border-radius:8%' : ''
  const border = element.borderWidth > 0 && element.borderColor ? `;outline:${pt(element.borderWidth)} ${borderStyle(element.borderType)} ${color(element.borderColor)}` : ''
  const filters = element.filters ?? {}
  const filter = [
    filters.brightness ? `brightness(${num(1 + filters.brightness / 100)})` : '',
    filters.contrast ? `contrast(${num(1 + filters.contrast / 100)})` : '',
    filters.saturation ? `saturate(${num(filters.saturation / 100)})` : '',
  ].filter(Boolean).join(' ')
  return `<div class="lw-el" style="${boxOf(element)}"><div class="lw-picture" style="${round.slice(1)}${border}">`
    + `<img src="${escapeHtml(element.base64)}" alt="" style="${place}${filter ? `;filter:${filter}` : ''}"></div></div>`
}

function tableHtml(element: Table): string {
  const columns = element.colWidths?.length ? `<colgroup>${element.colWidths.map((width) => `<col style="width:${pt(width)}">`).join('')}</colgroup>` : ''
  const rows = element.data.map((row, index) => {
    const height = element.rowHeights?.[index]
    const cells = row.filter((cell) => !cell.hMerge && !cell.vMerge).map(cellHtml).join('')
    return `<tr${height ? ` style="height:${pt(height)}"` : ''}>${cells}</tr>`
  }).join('')
  const edges = (['top', 'bottom', 'left', 'right'] as const).map((side) => borderSide(side, element.borders?.[side])).join('')
  return `<div class="lw-el" style="${boxOf(element)}"><table class="lw-table" style="${edges}">${columns}<tbody>${rows}</tbody></table></div>`
}

function cellHtml(cell: TableCell): string {
  const spans = `${cell.rowSpan && cell.rowSpan > 1 ? ` rowspan="${Math.floor(cell.rowSpan)}"` : ''}${cell.colSpan && cell.colSpan > 1 ? ` colspan="${Math.floor(cell.colSpan)}"` : ''}`
  const style = [
    cell.fillColor ? `background:${color(cell.fillColor)}` : '',
    cell.fontColor ? `color:${color(cell.fontColor)}` : '',
    cell.fontBold ? 'font-weight:bold' : '',
    ...(['top', 'bottom', 'left', 'right'] as const).map((side) => borderSide(side, cell.borders?.[side]).replace(/;$/, '')),
  ].filter(Boolean).join(';')
  const align = cell.vAlign === 'mid' ? ' class="mid"' : cell.vAlign === 'down' ? ' class="down"' : ''
  return `<td${spans}${align}${style ? ` style="${style}"` : ''}>${textContent(cell.text ?? '')}</td>`
}

function borderSide(side: 'top' | 'bottom' | 'left' | 'right', border: { borderColor: string; borderWidth: number; borderType: string } | undefined): string {
  if (!border || !(border.borderWidth > 0)) return ''
  return `border-${side}:${pt(border.borderWidth)} ${borderStyle(border.borderType)} ${color(border.borderColor)};`
}

/** The colours a chart's series take when the deck gives none: Office's own six. */
const SERIES_COLOURS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']

/**
 * A chart drawn from the numbers the deck keeps for it: columns or bars, lines, areas, a pie or a
 * doughnut, points; any other kind as the table of its numbers. The numbers are the deck's own, so
 * what is drawn says what the deck says, if not always in its exact style.
 */
function chartHtml(element: Chart, slide: number): string {
  const box = `<div class="lw-el" style="${boxOf(element)}" role="img" aria-label="Chart on slide ${slide}">`
  const w = positive(element.width, 100)
  const h = positive(element.height, 100)
  if (element.chartType === 'scatterChart' || element.chartType === 'bubbleChart') {
    return `${box}${pointsChart(element.data as number[][], w, h, element.colors)}</div>`
  }
  const series = (element.data as Array<{ key: string; values: Array<{ x: string; y: number }>; xlabels: Record<string, string> }>)
    .filter((item) => Array.isArray(item?.values))
  if (!series.length) return `${box}</div>`
  const colours = series.map((_, index) => color(element.colors?.[index] ?? '') || SERIES_COLOURS[index % SERIES_COLOURS.length])
  const labels = series[0].values.map((value) => series[0].xlabels?.[value.x] ?? value.x)
  switch (element.chartType) {
    case 'barChart':
    case 'bar3DChart': return `${box}${barsChart(series, labels, colours, w, h, 'barDir' in element && element.barDir === 'bar', 'grouping' in element ? element.grouping ?? '' : '')}</div>`
    case 'lineChart':
    case 'line3DChart':
    case 'areaChart':
    case 'area3DChart': return `${box}${linesChart(series, labels, colours, w, h, element.chartType.startsWith('area'))}</div>`
    case 'pieChart':
    case 'pie3DChart':
    case 'doughnutChart': return `${box}${pieChart(series[0], labels, element.colors, w, h, element.chartType === 'doughnutChart')}</div>`
    default: return `${box}${numbersTable(series, labels)}</div>`
  }
}

type Series = { key: string; values: Array<{ x: string; y: number }> }

/** The room a chart leaves around its plot for its labels and its key, in points. */
const PLOT = { left: 34, right: 10, top: 10, bottom: 34 }
const LABEL = 'font-size="11" fill="#333333"'

function legend(series: readonly Series[], colours: readonly string[], w: number, h: number): string {
  if (series.length < 2) return ''
  const step = Math.min(110, (w - PLOT.left) / series.length)
  return series.map((item, index) => {
    const x = PLOT.left + index * step
    return `<rect x="${num(x)}" y="${num(h - 11)}" width="7" height="7" fill="${colours[index]}"/><text x="${num(x + 10)}" y="${num(h - 4.5)}" ${LABEL}>${escapeHtml(clip(item.key, 18))}</text>`
  }).join('')
}

function scaleOf(values: readonly number[], stacked: boolean, series: readonly Series[]): { low: number; high: number } {
  const totals = stacked ? series[0].values.map((_, index) => series.reduce((sum, item) => sum + Math.max(0, num(item.values[index]?.y)), 0)) : values
  const high = Math.max(0, ...totals.map(num))
  const low = Math.min(0, ...values.map(num))
  return { low, high: high === low ? low + 1 : high }
}

function axisLines(w: number, h: number, low: number, high: number, legendRoom: number): string {
  const bottom = h - PLOT.bottom - legendRoom
  const ticks = [low, (low + high) / 2, high]
  return ticks.map((tick) => {
    const y = bottom - ((tick - low) / (high - low)) * (bottom - PLOT.top)
    return `<line x1="${PLOT.left}" x2="${num(w - PLOT.right)}" y1="${num(y)}" y2="${num(y)}" stroke="#d9d9d9" stroke-width="0.75"/><text x="${PLOT.left - 4}" y="${num(y + 3)}" text-anchor="end" ${LABEL}>${escapeHtml(shortNumber(tick))}</text>`
  }).join('')
}

function barsChart(series: readonly Series[], labels: readonly string[], colours: readonly string[], w: number, h: number, sideways: boolean, grouping: string): string {
  const stacked = grouping === 'stacked' || grouping === 'percentStacked'
  const legendRoom = series.length > 1 ? 14 : 0
  const values = series.flatMap((item) => item.values.map((value) => num(value.y)))
  const { low, high } = scaleOf(values, stacked, series)
  const right = w - PLOT.right
  const bottom = h - PLOT.bottom - legendRoom
  const count = Math.max(1, labels.length)
  const parts: string[] = []
  if (!sideways) parts.push(axisLines(w, h, low, high, legendRoom))
  const band = ((sideways ? bottom - PLOT.top : right - PLOT.left) / count)
  const along = (value: number) => (sideways
    ? PLOT.left + ((value - low) / (high - low)) * (right - PLOT.left)
    : bottom - ((value - low) / (high - low)) * (bottom - PLOT.top))
  labels.forEach((label, index) => {
    const start = (sideways ? PLOT.top : PLOT.left) + index * band + band * 0.15
    const room = band * 0.7
    let base = 0
    series.forEach((item, at) => {
      const value = num(item.values[index]?.y)
      const from = stacked ? base : 0
      const to = stacked ? base + value : value
      base = to
      const thick = stacked ? room : room / series.length
      const offset = stacked ? start : start + at * thick
      const [a, b] = [along(from), along(to)]
      parts.push(sideways
        ? `<rect x="${num(Math.min(a, b))}" y="${num(offset)}" width="${num(Math.abs(b - a))}" height="${num(thick)}" fill="${colours[at]}"/>`
        : `<rect x="${num(offset)}" y="${num(Math.min(a, b))}" width="${num(thick)}" height="${num(Math.abs(b - a))}" fill="${colours[at]}"/>`)
    })
    parts.push(sideways
      ? `<text x="${PLOT.left - 4}" y="${num(start + room / 2 + 3)}" text-anchor="end" ${LABEL}>${escapeHtml(clip(label, 14))}</text>`
      : `<text x="${num(start + room / 2)}" y="${num(bottom + 12)}" text-anchor="middle" ${LABEL}>${escapeHtml(clip(label, 14))}</text>`)
  })
  return svgOf(w, h, parts.join('') + legend(series, colours, w, h))
}

function linesChart(series: readonly Series[], labels: readonly string[], colours: readonly string[], w: number, h: number, filled: boolean): string {
  const legendRoom = series.length > 1 ? 14 : 0
  const values = series.flatMap((item) => item.values.map((value) => num(value.y)))
  const { low, high } = scaleOf(values, false, series)
  const right = w - PLOT.right
  const bottom = h - PLOT.bottom - legendRoom
  const count = Math.max(1, labels.length)
  // Each point in the middle of its category, as Office draws them, so the first and last labels fit.
  const xOf = (index: number) => PLOT.left + ((index + 0.5) / count) * (right - PLOT.left)
  const yOf = (value: number) => bottom - ((value - low) / (high - low)) * (bottom - PLOT.top)
  const parts = [axisLines(w, h, low, high, legendRoom)]
  series.forEach((item, at) => {
    const points = item.values.map((value, index) => `${num(xOf(index))},${num(yOf(num(value.y)))}`)
    if (filled) parts.push(`<polygon points="${num(xOf(0))},${num(yOf(0))} ${points.join(' ')} ${num(xOf(item.values.length - 1))},${num(yOf(0))}" fill="${colours[at]}" fill-opacity="0.55"/>`)
    else parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${colours[at]}" stroke-width="2"/>`)
  })
  labels.forEach((label, index) => parts.push(`<text x="${num(xOf(index))}" y="${num(bottom + 12)}" text-anchor="middle" ${LABEL}>${escapeHtml(clip(label, 14))}</text>`))
  return svgOf(w, h, parts.join('') + legend(series, colours, w, h))
}

function pieChart(item: Series, labels: readonly string[], given: readonly string[] | undefined, w: number, h: number, hole: boolean): string {
  const values = item.values.map((value) => Math.max(0, num(value.y)))
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return svgOf(w, h, '')
  const keyWidth = Math.min(w * 0.4, 90)
  const radius = Math.max(4, Math.min((w - keyWidth) / 2, h / 2) - 6)
  const cx = (w - keyWidth) / 2
  const cy = h / 2
  let angle = -Math.PI / 2
  const parts: string[] = []
  values.forEach((value, index) => {
    const share = value / total
    const colour = color(given?.[index] ?? '') || SERIES_COLOURS[index % SERIES_COLOURS.length]
    const next = angle + share * Math.PI * 2
    if (share >= 0.9999) parts.push(`<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(radius)}" fill="${colour}"/>`)
    else if (share > 0) {
      const [x1, y1, x2, y2] = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), cx + radius * Math.cos(next), cy + radius * Math.sin(next)]
      parts.push(`<path d="M${num(cx)},${num(cy)} L${num(x1)},${num(y1)} A${num(radius)},${num(radius)} 0 ${share > 0.5 ? 1 : 0},1 ${num(x2)},${num(y2)} Z" fill="${colour}" stroke="#fff" stroke-width="1"/>`)
    }
    angle = next
    const keyY = 12 + index * 13
    if (keyY < h - 4) parts.push(`<rect x="${num(w - keyWidth + 4)}" y="${num(keyY - 7)}" width="7" height="7" fill="${colour}"/><text x="${num(w - keyWidth + 14)}" y="${num(keyY)}" ${LABEL}>${escapeHtml(clip(labels[index] ?? '', 16))}</text>`)
  })
  if (hole) parts.push(`<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(radius * 0.5)}" fill="#fff"/>`)
  return svgOf(w, h, parts.join(''))
}

function pointsChart(points: number[][], w: number, h: number, given: readonly string[] | undefined): string {
  // `pptxtojson` keeps a scatter's numbers as its x's, then its y's.
  const [xs = [], ys = []] = Array.isArray(points) ? points : []
  if (!xs.length) return svgOf(w, h, '')
  const lowX = Math.min(...xs.map(num)), highX = Math.max(...xs.map(num))
  const { low, high } = scaleOf(ys.map(num), false, [{ key: '', values: [] }])
  const right = w - PLOT.right
  const bottom = h - PLOT.bottom
  const colour = color(given?.[0] ?? '') || SERIES_COLOURS[0]
  const parts = [axisLines(w, h, low, high, 0)]
  xs.forEach((x, index) => {
    const px = PLOT.left + (highX === lowX ? 0.5 : (num(x) - lowX) / (highX - lowX)) * (right - PLOT.left)
    const py = bottom - ((num(ys[index]) - low) / (high - low)) * (bottom - PLOT.top)
    parts.push(`<circle cx="${num(px)}" cy="${num(py)}" r="2.5" fill="${colour}"/>`)
  })
  return svgOf(w, h, parts.join(''))
}

function numbersTable(series: readonly Series[], labels: readonly string[]): string {
  const head = `<tr><td></td>${series.map((item) => `<td><b>${escapeHtml(item.key)}</b></td>`).join('')}</tr>`
  const rows = labels.map((label, index) => `<tr><td>${escapeHtml(label)}</td>${series.map((item) => `<td>${escapeHtml(String(item.values[index]?.y ?? ''))}</td>`).join('')}</tr>`).join('')
  return `<table class="lw-table" style="font-size:9pt">${head}${rows}</table>`
}

function svgOf(w: number, h: number, inside: string): string {
  return `<svg class="lw-chart" viewBox="0 0 ${num(w)} ${num(h)}" aria-hidden="true">${inside}</svg>`
}

/** A shape's fill as SVG paints it: a colour, or a gradient or picture defined beside it. */
function svgFill(fill: Fill | null | undefined, id: string, defs: string[]): string {
  if (!fill) return 'none'
  if (fill.type === 'color') return color(fill.value) || 'none'
  if (fill.type === 'pattern') return color(fill.value?.foregroundColor) || 'none'
  const ref = `lw-fill-${safeId(id)}-${defs.length}`
  if (fill.type === 'gradient') {
    const stops = (fill.value?.colors ?? []).map((stop) => `<stop offset="${escapeHtml(String(stop.pos ?? '0%'))}" stop-color="${color(stop.color) || '#000'}"/>`).join('')
    defs.push(fill.value?.path === 'line'
      ? `<linearGradient id="${ref}" gradientTransform="rotate(${num(fill.value.rot ?? 0)} 0.5 0.5)">${stops}</linearGradient>`
      : `<radialGradient id="${ref}">${stops}</radialGradient>`)
    return `url(#${ref})`
  }
  if (fill.type === 'image' && isPicture(fill.value?.base64)) {
    defs.push(`<pattern id="${ref}" patternContentUnits="objectBoundingBox" width="1" height="1"><image href="${escapeHtml(fill.value.base64)}" width="1" height="1" preserveAspectRatio="xMidYMid slice"/></pattern>`)
    return `url(#${ref})`
  }
  return 'none'
}

/** A box's background as CSS: a colour, a gradient, or a picture; `fallback` when the deck gives none. */
function backgroundOf(fill: Fill | null | undefined, fallback: string): string {
  if (fill?.type === 'color' && color(fill.value)) return `background:${color(fill.value)}`
  if (fill?.type === 'pattern' && color(fill.value?.foregroundColor)) return `background:${color(fill.value.foregroundColor)}`
  if (fill?.type === 'gradient' && fill.value?.colors?.length) {
    const stops = fill.value.colors.map((stop) => `${color(stop.color) || '#000'} ${escapeCss(String(stop.pos ?? ''))}`).join(',')
    // Office turns a line's gradient clockwise from pointing right; CSS from pointing up.
    return fill.value.path === 'line' ? `background:linear-gradient(${num(90 + (fill.value.rot ?? 0))}deg,${stops})` : `background:radial-gradient(${stops})`
  }
  if (fill?.type === 'image' && isPicture(fill.value?.base64)) return `background:url("${fill.value.base64}") center/cover no-repeat`
  return fallback ? `background:${fallback}` : ''
}

function shadowOf(shadow: Shadow | undefined, on: 'box' | 'svg'): string {
  if (!shadow || !color(shadow.color)) return ''
  const value = `drop-shadow(${pt(shadow.h)} ${pt(shadow.v)} ${pt(shadow.blur)} ${color(shadow.color)})`
  return on === 'box' ? `;filter:${value}` : ` style="filter:${value}"`
}

/** An arrowhead or a dot at one end of a line, drawn in the line's colour. */
function endMarker(end: LineEnd | undefined, at: 'start' | 'end', id: string, stroke: string, defs: string[]): string {
  if (!end || end.type === 'none' || stroke === 'none') return ''
  const ref = `lw-end-${safeId(id)}-${at}`
  const size = end.width === 'lg' ? 5 : end.width === 'sm' ? 2.5 : 3.5
  const shape = end.type === 'oval'
    ? '<circle cx="5" cy="5" r="4"/>'
    : end.type === 'diamond' ? '<path d="M5 0 L10 5 L5 10 L0 5 Z"/>' : '<path d="M0 0 L10 5 L0 10 Z"/>'
  defs.push(`<marker id="${ref}" viewBox="0 0 10 10" refX="${end.type === 'oval' || end.type === 'diamond' ? 5 : 9}" refY="5" markerWidth="${size}" markerHeight="${size}" orient="auto-start-reverse" fill="${stroke}">${shape}</marker>`)
  return ` marker-${at}="url(#${ref})"`
}

/**
 * Words the deck keeps as HTML (`pptxtojson` builds it from the slide, its own words escaped), made
 * to read as the deck does: spaces that can break, so its lines wrap where they would; spacing given
 * as a share of a line at that share (`pptxtojson` 2.2.0 writes 20% as `20em`); and a font this
 * computer may not have falling back to one like it.
 */
export function textContent(html: string): string {
  return String(html ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/(margin-(?:top|bottom)):\s*(-?[\d.]+)em/g, (_, side: string, value: string) => `${side}: ${num(Number(value) / 100)}em`)
    .replace(/font-family:\s*([^;"]+)/g, (_, family: string) => `font-family: ${fontStack(family)}`)
    // A bullet is drawn at its item's size and colour, which are its first words'.
    .replace(/<li><p style="([^"]*)"><span style="([^"]*)"/g, (whole, paragraph: string, words: string) => {
      const look = ['font-size', 'color'].flatMap((property) => {
        const value = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(words)?.[1]?.trim()
        return value ? [`${property}: ${value}`] : []
      }).join(';')
      return look ? `<li style="${look}"><p style="${paragraph}"><span style="${words}"` : whole
    })
}

const SERIF = /times|georgia|cambria|garamond|palatino|book antiqua|baskerville|serif/i
const MONO = /courier|consolas|mono|menlo/i

/** A font named with fonts like it after it, for a computer that doesn't have it. */
export function fontStack(family: string): string {
  const name = family.trim().replace(/^['"]|['"]$/g, '').replace(/'/g, '')
  if (!name) return 'inherit'
  const fallback = MONO.test(name) ? 'Menlo, Consolas, monospace' : SERIF.test(name) ? "Georgia, 'Times New Roman', serif" : "Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif"
  return `'${name}', ${fallback}`
}

function borderStyle(type: string | undefined): string {
  return type === 'dashed' || type === 'dotted' ? type : 'solid'
}

/** A colour from the deck, if it is one: never anything else in a style. */
function color(value: string | null | undefined): string {
  const text = String(value ?? '').trim()
  return /^#[0-9a-f]{3,8}$/i.test(text) || /^rgba?\([\d.,\s%]+\)$/i.test(text) || /^[a-z]{3,20}$/i.test(text) ? text : ''
}



function isPicture(source: string | undefined): source is string {
  return typeof source === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(source)
}

function clampPercent(value: number | undefined): number {
  return Math.min(99, Math.max(0, num(value)))
}

function positive(value: number | undefined, fallback: number): number {
  const number = num(value)
  return number > 0 ? number : fallback
}

function num(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0
}

function pt(value: unknown): string {
  return `${num(value)}pt`
}

function shortNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e6) return `${num(value / 1e6)}M`
  if (abs >= 1e4) return `${num(value / 1e3)}k`
  return String(Math.round(value * 100) / 100)
}

function clip(text: string, most: number): string {
  return text.length > most ? `${text.slice(0, most - 1)}…` : text
}

function safeId(id: string): string {
  return String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '')
}

function escapeCss(text: string): string {
  return text.replace(/[^0-9.%a-z-]/gi, '')
}

export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

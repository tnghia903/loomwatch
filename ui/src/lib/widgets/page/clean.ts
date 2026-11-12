/**
 * A page's markup made safe to draw (ADR 0125): what the agent wrote, with everything that could
 * run, load or go somewhere taken out. The frame's policy already stops scripts and loads; this
 * keeps a page from even trying, and from holding a link a click would follow.
 *
 * Both functions here run inside the page's frame, passed in as source text
 * (`./document.ts`), so each must stay self-contained: no imports, nothing from this module's
 * scope, nothing but what a browser has.
 */

/**
 * The elements of `fragment`, cleaned in place:
 * - scripts, frames, links, forms, media and SVG's own animations go, with what they hold, or
 *   only themselves when what they hold is worth keeping (a link's words, a form's fields);
 * - an element not known here gives way to what it holds;
 * - attributes not known here go, as do any that run code or point at an address.
 *
 * Pictures stay only when written into the page itself (`data:`), and `<use>` only when it points
 * inside the page (`#…`). A password, file or submit field goes.
 */
export function cleanMarkup(fragment: DocumentFragment | Element): void {
  // Gone with what they hold: what they hold would only show as words out of place. Anything else
  // not in KEEP, such as a link or a form, gives way to what it holds.
  const DROP = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'area', 'map', 'audio', 'video', 'source', 'track', 'portal', 'noscript', 'template', 'slot', 'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set', 'image', 'feimage', 'textpath', 'discard', 'dialog'])
  const KEEP = new Set(['div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark', 'code', 'pre', 'kbd', 'blockquote', 'q', 'abbr', 'time', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'label', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'output', 'progress', 'meter', 'details', 'summary', 'fieldset', 'legend', 'canvas', 'img', 'style', 'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'marker', 'symbol', 'use', 'title', 'desc'])
  const ATTRIBUTES = new Set(['class', 'id', 'style', 'title', 'role', 'tabindex', 'hidden', 'dir', 'lang', 'type', 'value', 'min', 'max', 'step', 'checked', 'disabled', 'readonly', 'name', 'placeholder', 'for', 'multiple', 'selected', 'size', 'rows', 'cols', 'maxlength', 'colspan', 'rowspan', 'scope', 'headers', 'open', 'width', 'height', 'alt', 'src', 'href', 'xlink:href', 'viewbox', 'preserveaspectratio', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'dx', 'dy', 'fx', 'fy', 'points', 'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'stroke-miterlimit', 'opacity', 'transform', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'font-size', 'font-family', 'font-weight', 'font-style', 'letter-spacing', 'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight', 'refx', 'refy', 'orient', 'markerunits', 'clip-path', 'mask', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'patternunits', 'patterncontentunits', 'patterntransform', 'vector-effect', 'pathlength', 'xmlns', 'xmlns:xlink', 'paint-order', 'shape-rendering'])
  const BAD_FIELDS = new Set(['password', 'file', 'image', 'submit', 'reset', 'hidden'])
  const RUNS = /(?:javascript|vbscript|livescript):|data:\s*text\/html|expression\s*\(|-moz-binding|behavior\s*:/iu
  const PICTURE = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);/iu

  /** CSS with nothing that loads: every `url()` that isn't a picture written into the page, and
      every `@import`, taken out. */
  const quietCss = (css: string): string => css
    .replace(/@import[^;]*;?/giu, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (whole, _quote: string, target: string) => (PICTURE.test(target) ? whole : 'none'))

  const cleanElement = (element: Element): void => {
    const name = element.localName.toLowerCase()
    if (DROP.has(name) || (name === 'input' && BAD_FIELDS.has((element.getAttribute('type') ?? '').toLowerCase()))) {
      element.remove()
      return
    }
    for (const child of Array.from(element.children)) cleanElement(child)
    if (!KEEP.has(name)) {
      element.replaceWith(...Array.from(element.childNodes))
      return
    }
    for (const attribute of Array.from(element.attributes)) {
      const attr = attribute.name.toLowerCase()
      const value = attribute.value
      // Spaces and control characters a browser skips inside `java\tscript:` go before the check.
      // eslint-disable-next-line no-control-regex
      const plain = value.replace(/[\s\u0000-\u001f]/gu, '')
      // Only attributes known here stay, so a handler (`onclick`) never does.
      const known = ATTRIBUTES.has(attr) || attr.startsWith('data-') || attr.startsWith('aria-')
      let keep = known && !RUNS.test(plain)
      if (keep && (attr === 'href' || attr === 'xlink:href')) keep = name === 'use' && plain.startsWith('#')
      if (keep && attr === 'src') keep = name === 'img' && PICTURE.test(plain)
      if (!keep) element.removeAttribute(attribute.name)
      else if (attr === 'style') element.setAttribute(attribute.name, quietCss(value))
    }
    if (name === 'style') element.textContent = quietCss(element.textContent ?? '')
  }

  for (const child of Array.from(fragment.children)) cleanElement(child)
}

/**
 * Draw `next`'s children into `live`, changing only what differs, so a field being typed in keeps
 * its words and where the caret is, and a canvas the page's script draws on stays the same one.
 * Elements pair up by position, and by `data-key` when the page gives one.
 */
export function drawInto(live: Element, next: Element | DocumentFragment): void {
  const focused = live.ownerDocument.activeElement
  const same = (a: Node, b: Node): boolean => {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false
    if (a.nodeType !== 1) return true
    return (a as Element).getAttribute('data-key') === (b as Element).getAttribute('data-key')
      && (a as Element).getAttribute('data-canvas') === (b as Element).getAttribute('data-canvas')
  }
  const update = (a: Node, b: Node): void => {
    if (a.nodeType !== 1) {
      if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue
      return
    }
    const from = a as Element
    const to = b as Element
    // A canvas the page's script draws on is the page's now: drawn again it would go blank.
    if (from.hasAttribute('data-lw-taken')) return
    for (const attribute of Array.from(from.attributes)) {
      if (!to.hasAttribute(attribute.name)) from.removeAttribute(attribute.name)
    }
    for (const attribute of Array.from(to.attributes)) {
      if (from.getAttribute(attribute.name) !== attribute.value) from.setAttribute(attribute.name, attribute.value)
    }
    if (from instanceof HTMLInputElement || from instanceof HTMLSelectElement || from instanceof HTMLTextAreaElement) {
      if (from !== focused && to.hasAttribute('value')) from.value = to.getAttribute('value') ?? ''
      if (from instanceof HTMLInputElement && from !== focused) from.checked = to.hasAttribute('checked')
    }
    children(from, to)
  }
  const children = (into: Element | DocumentFragment, from: Element | DocumentFragment): void => {
    const before = Array.from(into.childNodes)
    const after = Array.from(from.childNodes)
    after.forEach((node, at) => {
      const old = before[at]
      if (!old) into.appendChild(node)
      else if (same(old, node)) update(old, node)
      else into.replaceChild(node, old)
    })
    for (const old of before.slice(after.length)) old.remove()
  }
  children(live, next)
}

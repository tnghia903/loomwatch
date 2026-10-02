// LoomWatch landing page. The page is one LoomWatch run that the visitor operates: choose apps,
// build a team, ask, watch, review, read the result. No dependencies, no network calls, and the
// static page stays readable without it.
(() => {
  'use strict'

  const root = document.documentElement
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const SVG = 'http://www.w3.org/2000/svg'
  const $ = (sel, from = document) => from.querySelector(sel)
  const $$ = (sel, from = document) => [...from.querySelectorAll(sel)]
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
  const lerp = (a, b, t) => a + (b - a) * t
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t) }
  const store = {
    get(key) { try { return window.localStorage.getItem(key) } catch { return null } },
    set(key, value) { try { window.localStorage.setItem(key, value) } catch { /* private window */ } },
  }
  function el(tag, attrs = {}, ...kids) {
    const node = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue
      if (key === 'text') node.textContent = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value === true ? '' : value)
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid)
    return node
  }
  const clockText = (s) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` }
  const waitText = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` }
  const listText = (items) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
  const scrollToId = (id) => {
    const target = document.getElementById(id)
    if (!target) return
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 64, behavior: reduced ? 'auto' : 'smooth' })
  }

  /* ================================================================ Catalog and state */

  const APPS = [
    { id: 'claude', name: 'Claude', mono: 'C', spawn: 'claude-agent-acp' },
    { id: 'codex', name: 'Codex', mono: 'Cx', spawn: 'codex-acp' },
    { id: 'gemini', name: 'Gemini', mono: 'G', spawn: 'gemini', args: ['--acp'] },
    { id: 'opencode', name: 'OpenCode', mono: 'Oc', spawn: 'opencode', args: ['acp'] },
    { id: 'hermes', name: 'Hermes', mono: 'H', spawn: 'hermes-acp' },
    { id: 'openclaw', name: 'OpenClaw', mono: 'Ow', spawn: 'openclaw', args: ['acp'] },
  ]
  const app = (id) => APPS.find((a) => a.id === id) || APPS[0]

  const REQUESTS = [
    {
      id: 'digest',
      title: "Today's AI news, with a link for every claim",
      reads: 'the web',
      request: "Prepare today's AI and tech news digest, and link every claim.",
      short: "Today's AI news digest, every claim linked",
      tools: ['web search · “open-weight coding model benchmark”', 'fetch · browser release notes', 'fetch · chip export rule'],
      findings: [
        { text: 'A new open-weight coding model tops a public coding benchmark.', src: 'model card' },
        { text: 'Two browser makers ship on-device AI features this week.', src: 'release notes' },
        { text: 'A chip export rule changes next month.', src: null },
        { text: 'An open agent protocol adds a way to resume a session.', src: 'changelog' },
      ],
      note: 'Link claim 3, or drop it.',
      fix: { tool: 'fetch · official notice for claim 3', src: 'official notice' },
      title2: 'AI and tech, today',
      intro: (n, sourced) => `${n === 4 ? 'Four' : 'Three'} stories worth your morning${sourced ? ', each with its source' : ''}.`,
      file: 'digest.md',
      kind: 'Markdown',
    },
    {
      id: 'backup',
      title: 'Compare ways to back up a Mac, and pick one',
      reads: 'the web',
      request: 'Compare three ways to back up my Mac, and recommend one.',
      short: 'Compare Mac backups and pick one',
      tools: ['web search · “Mac backup options”', 'fetch · Time Machine guide', 'fetch · a cloud backup pricing page'],
      findings: [
        { text: 'Time Machine backs up to a drive at your desk every hour, at no extra cost.', src: 'Apple guide' },
        { text: 'A cloud backup keeps a copy away from your desk, for a monthly fee.', src: 'pricing page' },
        { text: 'Swapping two drives, one kept elsewhere, covers fire and theft.', src: 'backup guide' },
        { text: 'A cloud backup restores a full 1 TB in under an hour.', src: null },
      ],
      note: 'Drop claim 4 unless a source backs it.',
      fix: { tool: 'web search · “cloud backup restore time”', drop: 'nothing backed it, and restore speed depends on your connection' },
      title2: 'Backing up your Mac',
      intro: () => 'The pick: Time Machine at your desk, plus one copy somewhere else.',
      file: 'mac-backup.md',
      kind: 'Markdown',
    },
    {
      id: 'readme',
      title: "Rewrite my README's getting-started section",
      reads: 'your project folder',
      request: "Read the README in my project folder and rewrite its getting-started section.",
      short: "Rewrite the README's getting-started section",
      tools: ['read · README.md', 'read · docs/install.md', 'search · “brew”'],
      findings: [
        { text: 'The install steps assume Homebrew but never say so.', src: 'README.md:12' },
        { text: 'The first command runs before moving into the folder.', src: 'README.md:18' },
        { text: "The demo needs no account, and the README doesn't say so.", src: 'docs/demo.md' },
        { text: 'Most new users are on Windows.', src: null },
      ],
      note: 'Drop claim 4: nothing in the project says that.',
      fix: { tool: 'search · “windows”', drop: 'nothing in the folder supports it' },
      title2: 'Getting started, rewritten',
      intro: (n, sourced, reviewed) => `A new section for the README, written from ${reviewed ? 'the findings you approved' : 'what Researcher found'}.`,
      file: 'README.md',
      kind: 'Proposed change',
    },
  ]
  const preset = (id) => REQUESTS.find((r) => r.id === id) || REQUESTS[0]

  const state = {
    apps: ['claude', 'codex', 'opencode'],
    team: { researcher: 'claude', writer: 'codex', review: true },
    request: 'digest',
  }
  const seq = (team) => (team.review ? ['researcher', 'you', 'writer'] : ['researcher', 'writer'])
  const LANE = { researcher: 'Researcher', you: 'You', writer: 'Writer' }

  /* ================================================================ Theme, depth, progress */

  const themeButton = $('#theme')
  function paintShots() {
    const mode = root.dataset.theme === 'light' ? 'light' : 'dark'
    $$('img[data-shot]').forEach((img) => { img.src = `assets/readme/${img.dataset.shot}-${mode}.png` })
  }
  function applyTheme(theme) {
    root.dataset.theme = theme
    themeButton.setAttribute('aria-label', theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme')
    $('meta[name="theme-color"]').content = theme === 'dark' ? '#08080A' : '#FAF8F3'
    paintShots()
  }
  themeButton.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    store.set('loomwatch-site-theme', next)
    applyTheme(next)
  })

  function setDepth(depth) {
    root.dataset.depth = depth
    $$('[role="radio"][data-depth]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.depth === depth)))
    store.set('loomwatch-site-depth', depth)
  }
  $$('[role="radio"][data-depth]').forEach((b) => b.addEventListener('click', () => setDepth(b.dataset.depth)))
  $$('.dial, .depth').forEach((group) => group.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const buttons = $$('[data-depth]', group)
    const at = buttons.findIndex((b) => b.dataset.depth === root.dataset.depth)
    const next = buttons[(at + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]
    setDepth(next.dataset.depth); next.focus(); event.preventDefault()
  }))
  setDepth(root.dataset.depth || 'team')

  const progress = $('.progress')
  let progressQueued = false
  function paintProgress() {
    progressQueued = false
    const max = root.scrollHeight - window.innerHeight
    progress.style.setProperty('--read', max > 0 ? clamp(window.scrollY / max).toFixed(4) : '0')
    paintOpen()
  }
  window.addEventListener('scroll', () => { if (!progressQueued) { progressQueued = true; window.requestAnimationFrame(paintProgress) } }, { passive: true })

  // On a phone the depth dial steps out of the way while you read down the page, and comes back
  // as soon as you scroll up.
  const depthDial = $('.depth')
  let lastY = window.scrollY
  window.addEventListener('scroll', () => {
    const y = window.scrollY
    if (Math.abs(y - lastY) < 8) return
    depthDial.classList.toggle('tuck', window.innerWidth <= 640 && y > lastY && y > 200)
    lastY = y
  }, { passive: true })

  /* ================================================================ Cold open: from glue to loom */

  const open = $('.open')
  const field = $('.open-field')
  const terms = $$('.term', field)
  const youTag = $('.open-you')
  const weftSvg = $('.open-weft')
  const pastePath = $('#paste-path')
  const pasteDot = $('#paste-dot')
  const pasteSvg = $('.open-paste')
  const pasteLabel = $('.paste-label')
  // Where each window sits on the messy desk, as a fraction of the free space, and its tilt.
  const DESK = { claude: [0.04, 0.05, -3], codex: [0.96, 0, 2.4], gemini: [0, 0.9, 1.8], opencode: [0.92, 1, -2.2] }
  const tags = terms.map((term) => { const tag = el('span', { class: 'term-tag', text: term.dataset.app }); field.append(tag); return tag })
  let openReady = false
  let openP = reduced ? 1 : 0
  let fieldBox = { w: 0, h: 0 }
  let deskSize = { w: 260, h: 150 }

  function measureOpen() {
    fieldBox = { w: field.clientWidth, h: field.clientHeight }
    const narrow = window.innerWidth <= 640
    const mid = window.innerWidth <= 900
    const w = Math.round(clamp(fieldBox.w * 0.46, 150, narrow ? 176 : mid ? 230 : 270))
    deskSize = { w, h: Math.round(w * 0.58) }
    weftSvg.setAttribute('viewBox', `0 0 ${fieldBox.w} ${fieldBox.h}`)
    pasteSvg.setAttribute('viewBox', `0 0 ${fieldBox.w} ${fieldBox.h}`)
    openReady = fieldBox.w > 0
  }
  const threadX = (i) => fieldBox.w * (0.1 + i * 0.2)

  function paintOpen() {
    if (!openReady) return
    if (!reduced) {
      const rect = open.getBoundingClientRect()
      const span = open.offsetHeight - window.innerHeight
      openP = span > 0 ? clamp(-rect.top / span) : 1
    }
    const p = openP
    const t = smooth(0.16, 0.52, p)
    const thin = smooth(0.14, 0.36, p) // windows narrow first, then stretch into threads
    const { w: W, h: H } = fieldBox
    const top = H * 0.08
    const tall = H * 0.84
    const centres = []
    terms.forEach((term, i) => {
      const [fx, fy, tilt] = DESK[term.dataset.app]
      const sx = fx * Math.max(0, W - deskSize.w)
      const sy = fy * Math.max(0, H - deskSize.h)
      const w = lerp(deskSize.w, 2, thin)
      const h = lerp(deskSize.h, tall, t)
      const x = lerp(sx, threadX(i) - 1, t)
      const y = lerp(sy, top, t)
      term.style.width = `${w}px`
      term.style.height = `${h}px`
      term.style.transform = `translate(${x}px, ${y}px) rotate(${lerp(tilt, 0, t)}deg)`
      term.style.borderRadius = `${lerp(10, 1, thin)}px`
      term.style.boxShadow = thin > 0.5 ? 'none' : ''
      term.style.setProperty('--content', String(clamp(1 - thin * 2.2)))
      term.style.setProperty('--thread', String(smooth(0.35, 0.85, thin)))
      centres.push([sx + deskSize.w / 2, sy + deskSize.h / 2])
      tags[i].style.left = `${threadX(i)}px`
      tags[i].style.top = `${top - 20}px`
      tags[i].style.opacity = String(smooth(0.75, 1, t))
    })
    youTag.style.left = `${threadX(4)}px`
    youTag.style.top = `${top - 20}px`
    youTag.style.opacity = String(smooth(0.8, 1, t))

    // The copy-and-paste loop between the windows, gone once they are threads.
    const order = [0, 1, 3, 2, 0].map((i) => centres[i])
    pastePath.setAttribute('d', order.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(''))
    const pasteAlpha = clamp(1 - thin * 3)
    pasteSvg.style.opacity = String(pasteAlpha)
    pasteLabel.style.opacity = String(pasteAlpha)

    // Weft rows weave across the threads, one after another, with you on the end.
    weftSvg.replaceChildren()
    const youA = smooth(0.8, 1, t)
    if (youA > 0) weftSvg.append(el('svg:line', { class: 'w-you', x1: threadX(4), x2: threadX(4), y1: top, y2: top + tall, opacity: youA }))
    const rows = 6
    for (let r = 0; r < rows; r++) {
      const q = smooth(0.62 + r * 0.055, 0.7 + r * 0.055, p)
      if (q <= 0) continue
      const y = top + tall * (0.14 + r * 0.14)
      const x0 = threadX(0) - 18
      const x1 = lerp(x0, threadX(4) + 18, q)
      weftSvg.append(el('svg:path', { class: 'w-weft', d: `M${x0} ${y}H${x1}` }))
      for (let i = 0; i < 5; i++) {
        if ((r + i) % 2 || threadX(i) > x1) continue
        const x = threadX(i)
        weftSvg.append(el('svg:line', { class: 'w-halo', x1: x, x2: x, y1: y - 7, y2: y + 7 }))
        weftSvg.append(el('svg:line', { class: i === 4 ? 'w-you' : 'w-warp', x1: x, x2: x, y1: y - 7, y2: y + 7 }))
      }
    }

    open.style.setProperty('--before', String(1 - smooth(0.08, 0.26, p)))
    const after = smooth(0.3, 0.5, p)
    open.style.setProperty('--after', String(after))
    open.style.setProperty('--after-pe', after > 0.5 ? 'auto' : 'none')
  }

  let pasteT = 0
  function animatePaste(now) {
    if (openP < 0.3 && openReady && !document.hidden) {
      pasteT = (now / 3200) % 1
      const length = pastePath.getTotalLength ? pastePath.getTotalLength() : 0
      if (length > 0) {
        const point = pastePath.getPointAtLength(length * pasteT)
        pasteDot.setAttribute('cx', point.x)
        pasteDot.setAttribute('cy', point.y)
      }
    }
    window.requestAnimationFrame(animatePaste)
  }

  if (reduced) open.classList.add('still')
  // A keyboard visitor tabbing into the call to action is taken to where it is fully drawn.
  $('.open-after').addEventListener('focusin', () => {
    if (reduced || openP >= 0.7) return
    window.scrollTo({ top: open.offsetTop + (open.offsetHeight - window.innerHeight) * 0.78, behavior: 'auto' })
  })
  measureOpen()
  paintOpen()
  if (!reduced) window.requestAnimationFrame(animatePaste)
  window.addEventListener('resize', () => { measureOpen(); paintOpen(); drawLanes() })

  /* ================================================================ 01 · Threads */

  const appsList = $('#apps')
  function renderApps() {
    appsList.replaceChildren(...APPS.map((a) => {
      const on = state.apps.includes(a.id)
      const button = el('button', {
        type: 'button', class: 'app', role: 'checkbox', 'aria-checked': String(on),
        onclick: () => toggleApp(a.id),
      },
      el('span', { class: 'mono-tile', 'aria-hidden': 'true', text: a.mono }),
      el('span', { class: 'app-text' }, el('span', { class: 'app-name', text: a.name }), el('span', { class: 'app-meta', text: [a.spawn, ...(a.args || [])].join(' ') })),
      el('span', { class: 'app-check', 'aria-hidden': 'true' }, svgCheck()))
      return el('li', {}, button)
    }))
    $('#apps-count').textContent = `${state.apps.length} on the loom`
  }
  function svgCheck() {
    const svg = el('svg:svg', { viewBox: '0 0 12 12', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    svg.append(el('svg:path', { d: 'M2.5 6.2 5 8.6 9.6 3.6' }))
    return svg
  }
  function toggleApp(id) {
    const on = state.apps.includes(id)
    if (on && state.apps.length === 1) {
      const count = $('#apps-count')
      count.textContent = 'Keep one thread'
      window.setTimeout(() => { count.textContent = `${state.apps.length} on the loom` }, 1400)
      return
    }
    state.apps = APPS.map((a) => a.id).filter((a) => (a === id ? !on : state.apps.includes(a)))
    // An agent whose app left the loom moves to the first thread still on it.
    for (const who of ['researcher', 'writer']) if (!state.apps.includes(state.team[who])) state.team[who] = state.apps[0]
    if (!on && state.apps.length === 2 && state.team.researcher === state.team.writer) state.team.writer = id
    renderTeamViews(['researcher', 'writer'])
    renderApps()
    renderWarpPreview()
    renderSwatch()
  }

  function renderWarpPreview() {
    const svg = $('#warp-preview')
    const names = [...state.apps.map((id) => app(id).name), 'you']
    const n = names.length
    const x = (i) => (n === 1 ? 260 : 40 + (i * 440) / (n - 1))
    svg.replaceChildren()
    names.forEach((name, i) => {
      const you = i === n - 1
      svg.append(el('svg:text', { class: `wp-label${you ? ' you' : ''}`, x: x(i), y: 12, text: name }))
      svg.append(el('svg:line', { class: you ? 'wp-you' : 'wp-warp', x1: x(i), x2: x(i), y1: 24, y2: 106 }))
    })
    ;[48, 66, 84].forEach((y, r) => {
      svg.append(el('svg:path', { class: 'wp-weft', d: `M${x(0) - 16} ${y}H${x(n - 1) + 16}` }))
      names.forEach((name, i) => {
        if ((r + i) % 2) return
        svg.append(el('svg:line', { class: 'wp-halo', x1: x(i), x2: x(i), y1: y - 6, y2: y + 6 }))
        svg.append(el('svg:line', { class: i === n - 1 ? 'wp-you' : 'wp-warp', x1: x(i), x2: x(i), y1: y - 6, y2: y + 6 }))
      })
    })
    svg.setAttribute('aria-label', `The threads on your loom: ${listText(names)}.`)
  }

  /* ================================================================ 02 · Build */

  const sentence = $('#sentence')
  function appSelect(who) {
    const select = el('select', { 'aria-label': `${LANE[who]}'s AI app` })
    for (const id of state.apps) select.append(el('option', { value: id, text: `on ${app(id).name}` }))
    select.value = state.team[who]
    select.addEventListener('change', () => { state.team[who] = select.value; renderTeamViews([who]) })
    return select
  }
  function agentChip(who) {
    return el('span', { class: 'chip' }, el('span', { text: LANE[who] }), appSelect(who))
  }
  function renderSentence() {
    const t = state.team
    const parts = ['When you ask, ', agentChip('researcher'), ' researches, ']
    if (t.review) {
      parts.push('then ', el('span', { class: 'chip dashed' }, 'you',
        el('button', { type: 'button', class: 'x', 'aria-label': 'Take the review step off the team', title: 'Take the review step off', text: '×', onclick: () => setReview(false) })),
      ' approve or send it back, and finally ', agentChip('writer'), ' writes the answer.')
    } else {
      parts.push('and then ', agentChip('writer'), ' writes the answer. ',
        el('button', { type: 'button', class: 'repair', text: 'Add a review step before Writer', onclick: () => setReview(true) }))
    }
    if (run && (run.phase === 'running' || run.phase === 'review')) parts.push(el('span', { class: 'micro', style: 'display:block;margin-top:8px;letter-spacing:.05em', text: 'The team is running · changes apply to the next run' }))
    sentence.replaceChildren(...parts)
  }
  function setReview(on) {
    state.team.review = on
    renderTeamViews(['you'])
    renderReview(true)
  }

  const canvas = $('#canvas')
  function renderCanvas(flash = []) {
    const t = state.team
    const card = (who, step) => {
      const you = who === 'you'
      return el('div', { class: `card${you ? ' you' : ''}${flash.includes(who) ? ' flash' : ''}` },
        el('span', { class: 'step', text: String(step) }),
        el('div', { class: 'kind' }, el('span', { text: you ? 'Review step' : who === 'researcher' ? 'Researcher' : 'Writer' }), step === 1 ? el('span', { class: 'start', text: 'Start' }) : null),
        el('div', { class: 'nm', text: LANE[who] }),
        el('div', { class: 'ln', text: you ? 'Approve, or send it back' : who === 'researcher' ? 'Finds what is true, with sources' : 'Writes the answer' }),
        you ? null : el('div', { class: 'ap', text: `on ${app(t[who]).name}` }))
    }
    const order = seq(t)
    const kids = []
    order.forEach((who, i) => { if (i) kids.push(el('span', { class: 'edge', 'aria-hidden': 'true' })); kids.push(card(who, i + 1)) })
    canvas.replaceChildren(...kids)
    canvas.setAttribute('aria-label', `The team on the canvas: ${order.map((w) => LANE[w]).join(', then ')}.`)
    if (flash.length) window.setTimeout(() => $$('.card.flash', canvas).forEach((c) => c.classList.remove('flash')), 1200)
  }

  const yamlBox = $('#yaml')
  let yamlBefore = null
  function teamYaml() {
    const t = state.team
    const spawn = (id) => { const a = app(id); return `{ cmd: ${a.spawn}${a.args ? `, args: [${a.args.join(', ')}]` : ''}, cwd: . }` }
    const lines = [
      '# research-and-write.yaml: a plain file on your computer',
      'schemaVersion: 1',
      'id: research-and-write',
      'name: Research and write',
      'entrypoint: researcher',
      'agents:',
      '  - id: researcher',
      '    name: Researcher',
      '    role: Find out what is true, with a source for every claim.',
      `    spawn: ${spawn(t.researcher)}`,
    ]
    if (t.review) lines.push(
      '  - id: review           # you: the team stops here',
      '    kind: operator',
      '    name: You',
      '    role: Researcher is done. Approve the findings, or say what to change.')
    lines.push(
      '  - id: writer',
      '    name: Writer',
      '    role: Write the answer from the findings.',
      `    spawn: ${spawn(t.writer)}`,
      'edges:')
    if (t.review) lines.push('  - { from: researcher, to: review, layer: configured, kind: sequence }', '  - { from: review, to: writer, layer: configured, kind: sequence }')
    else lines.push('  - { from: researcher, to: writer, layer: configured, kind: sequence }')
    return lines
  }
  function renderYaml() {
    const lines = teamYaml()
    const before = new Set(yamlBefore || lines)
    yamlBox.replaceChildren(...lines.map((line, i) => {
      const span = el('span', { class: before.has(line) ? '' : 'hl' })
      const hash = line.indexOf('#')
      const body = hash >= 0 ? line.slice(0, hash) : line
      const key = body.match(/^(\s*-?\s*)([A-Za-z]+)(:)(.*)$/)
      if (key) span.append(key[1], el('span', { class: 'k', text: key[2] + key[3] }), el('span', { class: 'v', text: key[4] }))
      else span.append(body)
      if (hash >= 0) span.append(el('span', { class: 'c', text: line.slice(hash) }))
      return [span, i < lines.length - 1 ? '\n' : '']
    }).flat())
    yamlBefore = lines
    window.setTimeout(() => $$('.hl', yamlBox).forEach((s) => s.classList.remove('hl')), 1600)
  }

  function renderTeamViews(flash = []) {
    renderSentence()
    renderCanvas(flash)
    renderYaml()
    if (!run) { renderStages(); drawLanes() }
  }

  // Ask LoomWatch: one of your own apps proposes the team, and nothing changes until Apply.
  const proposeBox = $('#propose')
  const describe = $('#describe')
  let proposing = 0
  describe.addEventListener('click', async () => {
    const mine = ++proposing
    const pool = state.apps
    const pick = (avoid, prefer) => prefer.find((id) => pool.includes(id) && id !== avoid) || pool.find((id) => id !== avoid) || pool[0]
    const researcher = pick(state.team.researcher, ['opencode', 'gemini', 'claude', 'codex', 'hermes', 'openclaw'])
    const writer = pick(researcher, ['claude', 'codex', 'opencode', 'gemini', 'hermes', 'openclaw'])
    const words = `A researcher on ${app(researcher).name}, then me to check its work, then a writer on ${app(writer).name}.`
    const said = el('div', { class: 'said' })
    proposeBox.hidden = false
    proposeBox.replaceChildren(said)
    describe.disabled = true
    for (let i = 1; i <= words.length; i += reduced ? words.length : 2) {
      if (mine !== proposing) return
      said.textContent = words.slice(0, i)
      await new Promise((r) => window.setTimeout(r, 16))
    }
    said.textContent = words
    await new Promise((r) => window.setTimeout(r, reduced ? 0 : 450))
    if (mine !== proposing) return
    const close = () => { proposeBox.hidden = true; describe.disabled = false }
    proposeBox.append(el('div', { class: 'what' },
      el('span', { class: 'micro', text: 'Ask LoomWatch proposes' }),
      el('span', { text: `Researcher on ${app(researcher).name} · You · Writer on ${app(writer).name}` }),
      el('span', { class: 'acts' },
        el('button', { type: 'button', class: 'btn', text: 'Discard', onclick: close }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Apply', onclick: () => {
          state.team = { researcher, writer, review: true }
          close()
          renderTeamViews(['researcher', 'you', 'writer'])
          renderReview(true)
        } }))))
  })

  /* ================================================================ 03 · Ask */

  const requestsBox = $('#requests')
  const requestText = $('#request-text')
  const runButton = $('#run-team')
  function renderRequests() {
    requestsBox.replaceChildren(...REQUESTS.map((r) => el('button', {
      type: 'button', class: 'req', role: 'radio', 'aria-checked': String(r.id === state.request),
      onclick: () => { state.request = r.id; renderRequests() },
    },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('span', { class: 't', text: r.title }),
    el('span', { class: 'm' }, 'Researcher reads ', el('b', { text: r.reads })))))
    requestText.value = preset(state.request).request
  }
  requestsBox.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
    const at = REQUESTS.findIndex((r) => r.id === state.request)
    state.request = REQUESTS[(at + (event.key === 'ArrowDown' ? 1 : REQUESTS.length - 1)) % REQUESTS.length].id
    renderRequests()
    $('.req[aria-checked="true"]', requestsBox).focus()
    event.preventDefault()
  })
  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault()
    if (run && (run.phase === 'running' || run.phase === 'review')) { scrollToId('watch'); return }
    startRun()
    scrollToId('watch')
  })
  requestText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit() }
  })

  /* ================================================================ The run */

  let run = null
  let runCount = 0
  const CANCEL = Symbol('cancel')
  const SIM_MS = 430 // one simulated second, in real milliseconds

  function freshRun() {
    const p = preset(state.request)
    return {
      n: ++runCount,
      team: { ...state.team },
      preset: p,
      findings: p.findings.map((f) => ({ ...f })),
      phase: 'running',
      clock: 0,
      events: [],
      segs: [],
      stitches: [],
      hands: [],
      stages: { researcher: 'idle', you: 'idle', writer: 'idle' },
      stageLog: [],
      pass: 0,
      sendBacks: 0,
      approved: false,
      notes: [],
      waitedMs: 0,
      waitSince: 0,
      tools: { researcher: 0, writer: 0 },
      scrub: null,
    }
  }

  function work(sec) {
    const mine = run
    return new Promise((resolve, reject) => {
      if (reduced) { mine.clock += sec; renderLive(); window.setTimeout(() => (run === mine ? resolve() : reject(CANCEL)), 160); return }
      const target = mine.clock + sec
      let last = performance.now()
      function frame(now) {
        if (run !== mine) { reject(CANCEL); return }
        mine.clock = Math.min(target, mine.clock + Math.min(now - last, 64) / SIM_MS)
        last = now
        renderLive()
        if (mine.clock >= target) resolve()
        else window.requestAnimationFrame(frame)
      }
      window.requestAnimationFrame(frame)
    })
  }

  function log(who, text, extra = {}) {
    run.events.push({ t: run.clock, who, text, ...extra })
    if (extra.tool) run.stitches.push({ lane: who, t: run.clock })
    renderEvents()
    renderNarration()
  }
  function segStart(lane, kind = 'work') { run.segs.push({ lane, kind, from: run.clock, to: null }) }
  function segEnd(lane) { const seg = [...run.segs].reverse().find((s) => s.lane === lane && s.to === null); if (seg) seg.to = run.clock }
  function setStage(lane, value) { run.stages[lane] = value; run.stageLog.push({ t: run.clock, lane, value }); renderStages(); renderBadges() }
  // During a replay the step cards show what each step was doing at that moment.
  function stageAt(lane) {
    if (!run) return 'idle'
    if (run.scrub === null) return run.stages[lane]
    const last = run.stageLog.filter((s) => s.lane === lane && s.t <= run.scrub + 1e-6).at(-1)
    return last ? last.value : 'idle'
  }
  function handOver(from, to) { run.hands.push({ from, to, t: run.clock }) }

  async function startRun() {
    run = freshRun()
    const mine = run
    renderRunUI()
    renderReview(true)
    renderResult(true)
    renderSentence()
    try {
      log('you', `You asked: “${mine.preset.short}”`, { say: `You asked the team: “${mine.preset.request}”` })
      await work(0.8)
      await researcherPass()
      if (mine.team.review) await reviewLoop()
      else { handOver('researcher', 'writer'); log('researcher', 'Researcher handed over to Writer', { say: 'Researcher handed its findings straight to Writer. Nobody checked them.' }) }
      await writerPass()
    } catch (error) {
      if (error !== CANCEL) throw error
    }
  }

  async function researcherPass() {
    const r = run
    const name = app(r.team.researcher).name
    r.pass += 1
    setStage('researcher', 'running')
    segStart('researcher')
    if (r.pass === 1) {
      log('researcher', `Researcher started on ${name}`, { say: `Researcher started on ${name}, reading ${r.preset.reads}.` })
      for (const tool of r.preset.tools) {
        await work(1.7)
        r.tools.researcher += 1
        log('researcher', 'Researcher', { tool, say: `Researcher is working: ${tool.replace(' · ', ', ')}.` })
      }
      await work(1.6)
      log('researcher', `Researcher wrote findings.md`, { tool: 'write · findings.md', say: `Researcher wrote down ${r.findings.length} findings, each with its source, or a gap where it had none.` })
    } else {
      log('researcher', 'Researcher picked up your note', { say: `Researcher picked up your note: “${r.notes.at(-1)?.text || ''}”` })
      await work(1.6)
      r.tools.researcher += 1
      log('researcher', 'Researcher', { tool: r.preset.fix.tool, say: `Researcher is checking: ${r.preset.fix.tool.replace(' · ', ', ')}.` })
      await work(1.4)
      const flagged = r.findings.find((f) => !f.src && !f.dropped)
      if (flagged) {
        if (r.preset.fix.src) { flagged.src = r.preset.fix.src; flagged.fixed = true } else { flagged.dropped = true; flagged.why = r.preset.fix.drop }
      }
      log('researcher', 'Researcher updated findings.md', { tool: 'write · findings.md', say: r.preset.fix.src ? `Researcher found a source for claim ${r.findings.indexOf(flagged) + 1}.` : `Researcher dropped claim ${r.findings.indexOf(flagged) + 1}: ${r.preset.fix.drop}.` })
    }
    await work(0.9)
    segEnd('researcher')
    setStage('researcher', 'done')
  }

  async function reviewLoop() {
    const r = run
    for (;;) {
      handOver('researcher', 'you')
      log('researcher', 'Researcher handed over to you', { say: 'Researcher handed over. The team has stopped, and it is waiting for you.' })
      setStage('you', 'waiting')
      segStart('you', 'wait')
      r.phase = 'review'
      r.waitSince = Date.now()
      renderBadges(); renderNeedsYou(); renderReview(); renderResult(); renderSentence()
      waitTicker(r)
      const decision = await new Promise((resolve) => { r.decide = resolve })
      if (run !== r) throw CANCEL
      r.waitedMs += Date.now() - r.waitSince
      segEnd('you')
      r.phase = 'running'
      if (decision.text) r.notes.push({ t: r.clock, text: decision.text, kind: decision.kind })
      if (decision.kind === 'approve') {
        r.approved = true
        setStage('you', 'done')
        log('you', decision.text ? `You approved: “${decision.text}”` : 'You approved', { say: decision.text ? `You approved, with a note for Writer: “${decision.text}”` : 'You approved the findings as they were.' })
        handOver('you', 'writer')
        renderNeedsYou(); renderReview(); renderResult()
        return
      }
      r.sendBacks += 1
      setStage('you', 'idle')
      log('you', `You sent it back: “${decision.text || 'Try again.'}”`, { say: `You sent it back to Researcher: “${decision.text || 'Try again.'}”` })
      handOver('you', 'researcher')
      renderNeedsYou(); renderReview(); renderResult()
      await work(0.6)
      await researcherPass()
    }
  }

  function waitTicker(r) {
    // While the team waits, the dashed outline keeps growing, up to a point, so the work stays legible.
    let last = performance.now()
    let painted = 0
    function frame(now) {
      if (run !== r || r.phase !== 'review') return
      const seg = [...r.segs].reverse().find((s) => s.lane === 'you' && s.to === null)
      if (seg && r.clock - seg.from < 9) r.clock += Math.min(now - last, 100) / 1000 * 0.8
      last = now
      if (now - painted > 90) { painted = now; renderLive() }
      window.requestAnimationFrame(frame)
    }
    if (!reduced) window.requestAnimationFrame(frame)
  }

  async function writerPass() {
    const r = run
    const name = app(r.team.writer).name
    setStage('writer', 'running')
    segStart('writer')
    log('writer', `Writer started on ${name}`, { say: `Writer started on ${name}, with ${r.team.review ? 'the findings you approved' : 'whatever Researcher found'}.` })
    await work(1.4)
    r.tools.writer += 1
    log('writer', 'Writer', { tool: 'read · findings.md', say: 'Writer is reading the findings.' })
    await work(2.6)
    r.tools.writer += 1
    log('writer', `Writer wrote ${r.preset.file}`, { tool: `write · ${r.preset.file}`, say: `Writer wrote ${r.preset.file}.` })
    await work(1)
    segEnd('writer')
    setStage('writer', 'done')
    r.phase = 'done'
    log('team', 'Writer answered. The run is finished.', { say: 'Writer answered. The run is finished, and the answer has a receipt.' })
    r.scrub = null
    renderRunUI()
    renderReview(true)
    renderResult(true)
    renderSentence()
  }

  // A decision from the review panel.
  function decide(kind) {
    if (!run || run.phase !== 'review' || !run.decide) return
    const note = $('#rv-note')
    const text = note ? note.value.trim() : ''
    const resolve = run.decide
    run.decide = null
    resolve({ kind, text })
  }

  /* ---------------- Run rendering */

  const stagesBox = $('#stages')
  const eventsBox = $('#events')
  const narration = $('#narration')
  const lanes = $('#lanes')
  const scrub = $('#scrub')
  const scrubInput = $('#scrub-input')
  const needsYou = $('#needs-you')
  const STAGE_WORD = { idle: 'Idle', running: 'Working', waiting: 'Waiting for you', done: 'Done' }

  function renderRunUI() {
    renderStages(); renderBadges(); renderEvents(); renderNarration(); drawLanes(); renderNeedsYou(); renderScrub(); renderAskButton()
    $('#watch-clock').textContent = clockText(run ? (run.scrub ?? run.clock) : 0)
  }
  function renderLive() {
    drawLanes()
    $('#watch-clock').textContent = clockText(run ? run.clock : 0)
  }

  function renderStages() {
    const team = run ? run.team : state.team
    const order = seq(team)
    stagesBox.style.setProperty('--n', String(order.length))
    stagesBox.replaceChildren(...order.map((who, i) => {
      const value = stageAt(who)
      return el('li', { class: `stage${who === 'you' ? ' you' : ''}`, 'data-state': value },
        el('div', { class: 'top-line' }, el('i', { class: 'st', 'aria-hidden': 'true' }), el('span', { class: 'n', text: String(i + 1) }), el('span', { class: 'word', text: STAGE_WORD[value] })),
        el('div', { class: 'nm', text: LANE[who] }),
        el('div', { class: 'ap', text: who === 'you' ? 'review step' : `on ${app(team[who]).name}` }))
    }))
  }

  function badgeFor() {
    if (!run) return ['idle', 'Ready']
    if (run.phase === 'review') return ['waiting', 'Waiting for you']
    if (run.phase === 'done') return ['done', 'Finished']
    return ['running', 'Running']
  }
  function renderBadges() {
    const [value, word] = badgeFor()
    $$('[data-run-badge]').forEach((badge) => { badge.dataset.state = value; badge.textContent = word })
    $('#review-win').dataset.state = value
    renderAskButton()
  }
  function renderAskButton() {
    if (!run || run.phase === 'done') { runButton.disabled = false; runButton.textContent = run ? 'Run again' : 'Run team' }
    else { runButton.disabled = false; runButton.textContent = run.phase === 'review' ? 'Waiting for you ↓' : 'Running ↓' }
  }

  function visibleEvents() {
    if (!run) return []
    const at = run.scrub ?? Infinity
    return run.events.filter((e) => e.t <= at + 1e-6)
  }
  function renderEvents() {
    const list = visibleEvents()
    if (!list.length) { eventsBox.replaceChildren(el('li', { class: 'empty', text: 'Every step lands here as it happens.' })); return }
    eventsBox.replaceChildren(...list.slice(-5).map((e) => el('li', { class: e.who === 'you' ? 'you' : '' },
      el('time', { text: clockText(e.t) }),
      el('span', {}, e.tool ? [el('b', { text: e.text }), ' ', el('span', { class: 'tool', text: e.tool })] : el('b', { text: e.text }))))
    )
  }
  function renderNarration() {
    const list = visibleEvents()
    narration.textContent = list.length ? (list.at(-1).say || list.at(-1).text) : 'The team starts when you ask.'
  }
  function renderNeedsYou() { needsYou.hidden = !(run && run.phase === 'review') }

  function drawLanes() {
    const team = run ? run.team : state.team
    const order = seq(team)
    const W = 560
    const left = 92
    const right = W - 10
    const laneH = 34
    const top = 16
    const H = top + order.length * laneH + 14
    lanes.setAttribute('viewBox', `0 0 ${W} ${H}`)
    const now = run ? (run.scrub ?? run.clock) : 0
    const T = Math.max(run ? run.clock : 0, 16)
    const x = (t) => left + (clamp(t / T) * (right - left))
    const y = (lane) => top + order.indexOf(lane) * laneH + laneH / 2
    const kids = []
    order.forEach((lane) => {
      kids.push(el('svg:text', { class: `ln-name${lane === 'you' ? ' you' : ''}`, x: 0, y: y(lane) + 4, text: LANE[lane] }))
      kids.push(el('svg:line', { class: 'ln-warp', x1: left, x2: right, y1: y(lane), y2: y(lane) }))
    })
    if (run) {
      for (const seg of run.segs) {
        if (!order.includes(seg.lane) || seg.from > now) continue
        const live = seg.to === null && run.scrub === null
        const end = Math.min(seg.to ?? run.clock, now)
        const x0 = x(seg.from)
        const w = Math.max(2, x(end) - x0)
        if (seg.kind === 'wait') kids.push(el('svg:rect', { class: `ln-wait${live ? ' live' : ''}`, x: x0, y: y(seg.lane) - 8, width: w, height: 16, rx: 4 }))
        else kids.push(el('svg:rect', { class: `ln-work${live && run.phase === 'running' ? ' live' : ''}`, x: x0, y: y(seg.lane) - 3, width: w, height: 6, rx: 3 }))
      }
      for (const s of run.stitches) {
        if (!order.includes(s.lane) || s.t > now) continue
        kids.push(el('svg:line', { class: 'ln-stitch', x1: x(s.t), x2: x(s.t), y1: y(s.lane) - 11, y2: y(s.lane) - 6 }))
      }
      for (const h of run.hands) {
        if (!order.includes(h.from) || !order.includes(h.to) || h.t > now) continue
        const hx = x(h.t)
        kids.push(el('svg:path', { class: 'ln-hand', d: `M${hx} ${y(h.from)}L${hx} ${y(h.to)}` }))
        kids.push(el('svg:circle', { class: 'ln-dot', cx: hx, cy: y(h.to), r: 2.6 }))
      }
      kids.push(el('svg:line', { class: 'ln-head', x1: x(now), x2: x(now), y1: top - 6, y2: H - 14 }))
    }
    kids.push(el('svg:text', { class: 'ln-axis', x: left, y: H - 2, text: '0:00' }))
    kids.push(el('svg:text', { class: 'ln-axis', x: right, y: H - 2, 'text-anchor': 'end', text: clockText(T) }))
    lanes.replaceChildren(...kids)
  }

  function renderScrub() {
    const done = run && run.phase === 'done'
    scrub.hidden = !done
    if (done) { scrubInput.max = String(run.clock); scrubInput.value = String(run.scrub ?? run.clock) }
  }
  scrubInput.addEventListener('input', () => {
    if (!run || run.phase !== 'done') return
    const value = Number(scrubInput.value)
    run.scrub = value >= run.clock - 0.05 ? null : value
    renderEvents(); renderNarration(); renderStages(); drawLanes()
    $('#watch-clock').textContent = clockText(run.scrub ?? run.clock)
  })

  /* ---------------- 05 · Review panel */

  const reviewBody = $('#review-body')
  let reviewKey = ''
  function renderReview(force = false) {
    const key = run ? `${run.n}:${run.phase}:${run.pass}:${run.sendBacks}:${run.approved}:${run.team.review}:${state.team.review}` : `none:${state.team.review}`
    if (!force && key === reviewKey) return
    reviewKey = key
    const quiet = (shape, big, text, ...more) => el('div', { class: 'rv-quiet' },
      el('div', { class: `rv-shape ${shape}`, 'aria-hidden': 'true' }, el('i')),
      el('p', { class: 'big', text: big }), text ? el('p', { text }) : null, ...more)

    if (!run) {
      reviewBody.replaceChildren(state.team.review
        ? quiet('', 'Nothing to review yet.', 'Run the team. When Researcher hands over, the run stops here and waits for you.',
          el('button', { type: 'button', class: 'btn', text: 'Run team', onclick: () => { startRun(); scrollToId('watch') } }))
        : quiet('warn', 'This team has no review step.', "Researcher's findings would go straight to Writer, unchecked.",
          el('button', { type: 'button', class: 'repair', text: 'Add a review step before Writer', onclick: () => setReview(true) })))
      return
    }
    if (!run.team.review) {
      const flagged = run.findings.findIndex((f) => !f.src)
      const done = run.phase === 'done'
      reviewBody.replaceChildren(quiet('warn', 'Nothing waited for you on this run.',
        done ? `This team had no review step, so Writer used everything Researcher found, including claim ${flagged + 1}, which has no source.`
          : "This team has no review step, so Researcher's findings go straight to Writer, unchecked.",
        state.team.review
          ? el('button', { type: 'button', class: 'btn', text: done ? 'Run again with the review step' : 'Review step added for the next run', disabled: !done, onclick: () => { startRun(); scrollToId('watch') } })
          : el('button', { type: 'button', class: 'repair', text: 'Add a review step before Writer', onclick: () => setReview(true) })))
      return
    }
    if (run.phase === 'review') {
      const pass = run.pass
      const flaggedIndex = run.findings.findIndex((f) => !f.src && !f.dropped)
      const list = el('ol', {}, run.findings.map((f) => {
        if (f.dropped) return el('li', {}, el('span', { class: 'dropped', text: f.text }), el('span', { class: 'src fixed', text: 'dropped' }))
        return el('li', {}, f.text, el('span', { class: `src${f.src ? (f.fixed ? ' fixed' : '') : ' missing'}`, text: f.src || 'no source' }))
      }))
      const fixedOne = run.findings.find((f) => f.fixed || f.dropped)
      const flag = flaggedIndex >= 0
        ? el('p', { class: 'rv-flag' }, el('b', { text: `Claim ${flaggedIndex + 1} has no source.` }), ' Approve it as it is, or send it back with a note.')
        : el('p', { class: 'rv-flag good' }, el('b', { text: fixedOne?.dropped ? `Claim ${run.findings.indexOf(fixedOne) + 1} is gone.` : 'Every claim has a source now.' }), fixedOne?.dropped ? ` Researcher dropped it: ${fixedOne.why}.` : ' Approve to hand the findings to Writer.')
      const note = el('textarea', { id: 'rv-note', rows: '2', placeholder: 'Optional. Sent with either choice.' })
      note.value = pass === 1 ? run.preset.note : ''
      reviewBody.replaceChildren(
        el('p', { class: 'rv-q', text: pass === 1 ? 'Researcher is done. Approve the findings, or say what to change.' : 'Researcher made your change. Approve the findings, or send them back again.' }),
        el('div', { class: 'rv-box' }, el('span', { class: 'micro', text: 'What Researcher handed over' }), list),
        flag,
        el('div', { class: 'rv-note' }, el('label', { class: 'micro', for: 'rv-note', text: 'Your note' }), note),
        el('div', { class: 'rv-acts' },
          el('button', { type: 'button', class: 'btn', text: 'Send back to Researcher', onclick: () => decide('send') }),
          el('button', { type: 'button', class: 'btn btn-primary', text: 'Approve', onclick: () => decide('approve') })))
      return
    }
    if (!run.approved) {
      reviewBody.replaceChildren(quiet('live', run.sendBacks ? 'Researcher is making your change.' : 'Researcher is still working.',
        run.sendBacks ? 'When it hands over again, the review step opens with what changed.' : "The review step opens when it hands over. You'll see exactly what it found, and where it came from."))
      return
    }
    const log = el('ul', { class: 'rv-log' }, run.events.filter((e) => e.who === 'you' && e.t > 0).map((e) => el('li', {}, el('b', { text: clockText(e.t) }), ` ${e.text}`)))
    const flaggedLeft = run.findings.some((f) => !f.src && !f.dropped)
    reviewBody.replaceChildren(quiet(run.phase === 'done' ? 'done' : 'gold',
      run.sendBacks ? `You approved, after ${run.sendBacks === 1 ? 'one send-back' : `${run.sendBacks} send-backs`}.` : 'You approved.',
      run.phase === 'done'
        ? (flaggedLeft ? 'The answer is ready below. The receipt flags the claim you let through, so it stays worth a look.' : 'The answer is ready below, built only on findings you checked.')
        : 'Writer is writing the answer from the findings you approved.',
      log))
  }

  /* ---------------- 06 · Result panel */

  const resultBody = $('#result-body')
  let resultKey = ''
  function receiptRows(r) {
    const apps = [...new Set(['researcher', 'writer'].map((w) => app(r.team[w]).name))]
    const flagged = r.findings.map((f, i) => ({ ...f, i })).filter((f) => !f.src && !f.dropped)
    const call = !r.team.review ? 'No review step on this team'
      : r.sendBacks ? `Sent back ${r.sendBacks === 1 ? 'once' : `${r.sendBacks} times`}, then approved` : r.notes.length ? 'Approved, with a note' : 'Approved'
    const rows = [
      ['Asked', `“${r.preset.short}”`],
      ['Team', seq(r.team).map((w) => LANE[w]).join(' → ')],
      ['Ran on', `${listText(apps)} · your own sign-ins`],
      ['Took', clockText(r.clock)],
    ]
    if (r.team.review) rows.push(['Waited on you', waitText(r.waitedMs)])
    rows.push(['Your call', call])
    rows.push(['Researcher', `${r.findings.filter((f) => !f.dropped).length} findings · ${r.tools.researcher} tool calls`])
    rows.push(['Writer', `wrote ${r.preset.file}`])
    return { rows, flagged }
  }
  function receiptMarkdown(r) {
    const { rows, flagged } = receiptRows(r)
    return [
      `**Run receipt · Run ${r.n} · Finished**`,
      '',
      ...rows.map(([k, v]) => `- **${k}:** ${v}`),
      '',
      flagged.length ? `**Worth a look:** claim ${flagged[0].i + 1} has no source.` : '**Worth a look:** nothing flagged.',
      '',
      '_Simulated on the LoomWatch landing page. No model was called._',
    ].join('\n')
  }
  function renderResult(force = false) {
    const key = run ? `${run.n}:${run.phase}:${run.approved}:${run.sendBacks}` : 'none'
    if (!force && key === resultKey) return
    resultKey = key
    $('#result-file').textContent = run ? run.preset.file : preset(state.request).file
    const empty = (big, text, ...more) => el('div', { class: 'res-empty' }, el('p', { class: 'big', text: big }), el('p', { text }), ...more)
    if (!run) { resultBody.replaceChildren(empty('Nothing to read yet.', "Run the team, and its answer lands here with a receipt.")); return }
    if (run.phase === 'review') {
      resultBody.replaceChildren(empty('The team is waiting for you.', 'Nothing gets written past the review step until you decide.',
        el('a', { class: 'link', href: '#review', style: 'display:inline-block;margin-top:14px', text: 'Go to the review step ↑' })))
      return
    }
    if (run.phase !== 'done') {
      const who = run.stages.writer === 'running' ? 'Writer is writing' : 'Researcher is working'
      resultBody.replaceChildren(empty('Not finished yet.', `${who}. The answer appears here when Writer replies.`))
      return
    }
    const r = run
    const items = r.findings.filter((f) => !f.dropped).map((f) => el('li', { class: f.src ? '' : 'unchecked' }, f.text, el('span', { class: `src${f.src ? '' : ' missing'}`, text: f.src || (r.team.review ? 'no source · approved as it was' : 'no source · nobody checked') })))
    const lastNote = r.notes.filter((n) => n.kind === 'approve').at(-1)
    const reader = el('div', { class: 'reader' },
      el('span', { class: 'micro', text: `Team response · from Writer on ${app(r.team.writer).name}` }),
      el('h3', { text: r.preset.title2 }),
      el('p', { class: 'intro', text: r.preset.intro(items.length, r.findings.every((f) => f.src || f.dropped), r.team.review) }),
      el('ul', {}, items),
      lastNote ? el('p', { class: 'written', text: `Written with your note: “${lastNote.text}”` }) : null,
      el('div', { class: 'filecard' },
        el('span', { class: 'ico', 'aria-hidden': 'true', text: r.preset.file.split('.').pop().toUpperCase() }),
        el('span', {}, el('div', { class: 'fn', text: r.preset.file }), el('div', { class: 'fm', text: `${r.preset.kind} · changed just now · Research and write › Writer` })),
        el('span', { class: 'acts', 'aria-hidden': 'true' }, el('span', { text: 'Open' }), el('span', { text: 'Show in folder' }))))
    const { rows, flagged } = receiptRows(r)
    const slip = el('div', { class: 'slip-wrap' }, el('div', { class: 'slip' },
      el('div', { class: 'head' }, el('span', { text: `Run receipt · Run ${r.n}` }), el('span', { text: 'Finished' })),
      el('dl', {}, rows.map(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]).flat()),
      el('div', { class: 'worth' }, el('b', { text: 'Worth a look: ' }), flagged.length ? el('span', { class: 'bad', text: `claim ${flagged[0].i + 1} has no source.` }) : 'nothing flagged.'),
      el('div', { class: 'foot', text: 'Simulated in your browser · no model was called' })))
    const copied = el('span', { class: 'copied', 'aria-live': 'polite' })
    const acts = el('div', { class: 'res-acts' },
      el('button', { type: 'button', class: 'btn', text: 'Copy as Markdown', onclick: async () => {
        try { await navigator.clipboard.writeText(receiptMarkdown(r)); copied.textContent = 'Copied' } catch { copied.textContent = 'Copy failed' }
        window.setTimeout(() => { copied.textContent = '' }, 1800)
      } }),
      el('button', { type: 'button', class: 'btn', text: 'Run it again', onclick: () => { startRun(); scrollToId('watch') } }),
      el('a', { class: 'link', href: '#watch', style: 'font-size:13px', text: 'Replay the timeline ↑' }),
      copied)
    resultBody.replaceChildren(el('div', { class: 'result-grid' }, reader, slip, acts))
  }

  /* ================================================================ 07 · Tomorrow */

  const DAYS = [
    { d: 'Sep 19', w: 'Sat', runs: ['done'], tag: 'A schedule', when: '10:00 → 10:06', story: 'The first scheduled run. Collector, Editor and Writer were done by 10:06, and the digest was waiting in Notion.' },
    { d: 'Sep 20', w: 'Sun', runs: ['done'], when: '10:00 → 10:05', story: 'An ordinary Sunday. The digest arrived, and nothing needed you.' },
    { d: 'Sep 21', w: 'Mon', runs: ['done', 'short'], tag: 'Follow up', when: '10:00 → 10:05 · 10:31', story: 'You read it over coffee and followed up: <span class="q">“Shorter, please.”</span> Writer did one more pass on the same result. Nobody started over.' },
    { d: 'Sep 22', w: 'Tue', runs: ['fail', 'done'], tag: 'Redo from a step', when: '10:00 → 10:02 · 10:40', story: "Collector couldn't open one of its sources, and the run stopped and said so. You chose Redo from step 1, and only that step and the ones after it ran again." },
    { d: 'Sep 23', w: 'Wed', runs: ['done'], tag: 'Notebook', when: '10:00 → 10:05', story: 'You added a line to the team\'s Notebook: <span class="q">“Five items, not ten.”</span> Every run since has read it before starting.' },
    { d: 'Sep 24', w: 'Thu', runs: ['done'], when: '10:00 → 10:04', story: 'Five items, not ten. It remembered without being told again.' },
    { d: 'Sep 25', w: 'Fri', runs: ['done'], tag: 'Swap a thread', when: '10:00 → 10:05', story: 'A newer app was better at editing, so you moved Editor to it. One change in the sentence. The team, its Brief and its Notebook stayed as they were.' },
    { d: 'Sep 26', w: 'Sat', runs: ['done'], when: '10:00 → 10:04', story: 'Finished before you were up.' },
    { d: 'Sep 27', w: 'Sun', runs: ['wait'], tag: 'A review step waits', when: '10:00 → 18:40', story: "Editor flagged a claim it couldn't confirm, and the review step held the run all Sunday. You approved at 18:40, and the digest went out then, not before." },
    { d: 'Sep 28', w: 'Mon', runs: ['done'], tag: 'Saved job', when: '10:00 → 10:05', story: 'You saved Editor as a job, with its instructions, app and skills, and added it to a second team.' },
    { d: 'Sep 29', w: 'Tue', runs: ['done'], when: '10:00 → 10:04', story: 'Most mornings now need nothing from you. That was the point.' },
    { d: 'Sep 30', w: 'Wed', runs: ['done'], tag: 'Replay any morning', when: '10:00 → 10:05', story: "Every run is kept on your computer, so you can open any morning's timeline and drag back through it." },
    { d: 'Oct 1', w: 'Thu', runs: ['done'], when: '10:00 → 10:05', story: 'Finished at 10:05. Every morning so far is on the record, the failure included.' },
    { d: 'Oct 2', w: 'Today', runs: ['live'], tag: 'Working now', when: '10:00 → now', story: "Today's run is working. Collector is reading, and the timeline fills in as it goes." },
  ]
  const fabric = $('#fabric')
  const dayStory = $('#day-story')
  let dayAt = DAYS.length - 1
  function renderFabric() {
    fabric.replaceChildren(...DAYS.map((day, i) => el('button', {
      type: 'button', class: 'day', role: 'option', 'aria-selected': String(i === dayAt), tabindex: i === dayAt ? '0' : '-1',
      'aria-label': `${day.w === 'Today' ? 'Today' : day.w}, ${day.d}${day.tag ? `: ${day.tag}` : ''}`,
      onclick: () => selectDay(i),
    },
    el('span', { class: `mk${day.tag ? '' : ' none'}`, 'aria-hidden': 'true' }),
    el('span', { class: 'runs', 'aria-hidden': 'true' }, day.runs.map((k) => el('i', { class: `thr ${k}` }))),
    el('span', { class: 'dt', 'aria-hidden': 'true' }, el('b', { text: day.w }), day.d))))
    const day = DAYS[dayAt]
    const tag = el('span', { class: 'when' }, el('b', { text: day.tag || 'Finished' }), `${day.d} · ${day.when}`)
    const story = el('p')
    story.innerHTML = day.story
    dayStory.replaceChildren(tag, story)
  }
  function selectDay(i, focus = false) {
    dayAt = (i + DAYS.length) % DAYS.length
    renderFabric()
    if (focus) $$('.day', fabric)[dayAt].focus()
  }
  fabric.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -dayAt, End: DAYS.length - 1 - dayAt }[event.key]
    if (step === undefined) return
    selectDay(dayAt + step, true)
    event.preventDefault()
  })

  /* ================================================================ 08 · Why a loom */

  let loomMode = 'any'
  const swatch = $('#swatch')
  function renderSwatch() {
    const names = [...state.apps.map((id) => app(id).name), 'you']
    const n = names.length
    const one = loomMode === 'one'
    const x = (i) => (n === 1 ? 240 : 52 + (i * 376) / (n - 1))
    const rotate = n > 5
    swatch.replaceChildren()
    const top = 54
    const bottom = 286
    names.forEach((name, i) => {
      const you = i === n - 1
      const off = one && i !== 0
      const tagAttrs = { class: `sw-tag${you ? ' you' : ''}${off ? ' off' : ''}`, x: x(i), y: 30, text: name }
      if (rotate) Object.assign(tagAttrs, { transform: `rotate(-28 ${x(i)} 30)` })
      swatch.append(el('svg:text', tagAttrs))
      swatch.append(el('svg:line', { class: `sw-warp${you ? ' you' : ''}${off ? ' off' : ''}`, x1: x(i), x2: x(i), y1: top, y2: bottom }))
    })
    const rows = 12
    for (let r = 0; r < rows; r++) {
      const y = top + 16 + r * 18.5
      const from = one ? x(0) - 20 : x(0) - 22
      const to = one ? x(0) + 20 : x(n - 1) + 22
      swatch.append(el('svg:path', { class: 'sw-weft', d: `M${from} ${y}H${to}` }))
      names.forEach((name, i) => {
        if ((r + i) % 2 || (one && i !== 0)) return
        swatch.append(el('svg:line', { class: 'sw-halo', x1: x(i), x2: x(i), y1: y - 7, y2: y + 7 }))
        swatch.append(el('svg:line', { class: `sw-warp${i === n - 1 ? ' you' : ''}`, x1: x(i), x2: x(i), y1: y - 7, y2: y + 7 }))
      })
    }
    const others = state.apps.slice(1).map((id) => app(id).name)
    $('#swatch-cap').textContent = one
      ? `One company's team weaves only its own agents. ${others.length ? `${listText(others)} ${others.length === 1 ? 'stays' : 'stay'} off the loom, and so do you.` : 'And you stay off the loom.'}`
      : `LoomWatch: ${listText(state.apps.map((id) => app(id).name))} on one cloth, with you woven in. Swap any thread and the cloth stays.`
    swatch.setAttribute('aria-label', $('#swatch-cap').textContent)
  }
  $$('[data-loom]').forEach((b) => b.addEventListener('click', () => {
    loomMode = b.dataset.loom
    $$('[data-loom]').forEach((x) => x.setAttribute('aria-checked', String(x === b)))
    renderSwatch()
  }))

  /* ================================================================ 09 · Start */

  const cmds = $('#cmds')
  $('#copy-cmds').addEventListener('click', async (event) => {
    const button = event.currentTarget
    const text = $$('.cmd', cmds).map((c) => c.dataset.full || c.textContent).join('\n')
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied' } catch { button.textContent = 'Select and copy' }
    window.setTimeout(() => { button.textContent = 'Copy' }, 1600)
  })
  let typed = false
  async function typeCommands() {
    if (typed || reduced) return
    typed = true
    const lines = $$('.cmd', cmds)
    const comment = $('.c', cmds)
    lines.forEach((line) => { line.dataset.full = line.textContent; line.textContent = '' })
    comment.style.visibility = 'hidden'
    for (const line of lines) {
      line.classList.add('typing')
      for (let i = 1; i <= line.dataset.full.length; i++) { line.textContent = line.dataset.full.slice(0, i); await new Promise((r) => window.setTimeout(r, 22)) }
      await new Promise((r) => window.setTimeout(r, 260))
      line.classList.remove('typing')
    }
    await new Promise((r) => window.setTimeout(r, 300))
    comment.style.visibility = ''
  }

  const SCREENS = {
    home: { w: 2880, h: 1240, alt: 'LoomWatch Home: the headline Put AI agents to work as a team, a New team button, three steps, and the teams as cards with their recent runs drawn as threads.', cap: 'Home: your teams, each with its recent runs drawn as threads, and the one gold button that starts a new one.' },
    build: { w: 2880, h: 1800, alt: 'LoomWatch Build: the team as one sentence across the top, a Hire by job palette on the left, and agent cards wired left to right on a dotted canvas.', cap: 'Build: the team as one sentence across the top, Hire by job on the left, cards wired left to right.' },
    run: { w: 2880, h: 1800, alt: "LoomWatch Run: the request, the team's steps, a run receipt and the timeline on the left, and the team's answer in a reader on the right.", cap: "Run: the request, the steps, the receipt and the timeline on the left; the team's answer on the right." },
  }
  const realImg = $('#real-img')
  function showScreen(name, focus = false) {
    $$('[role="tab"][data-screen]').forEach((tab) => {
      const on = tab.dataset.screen === name
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (on && focus) tab.focus()
      if (on) $('#real-shot').setAttribute('aria-labelledby', tab.id)
    })
    const screen = SCREENS[name]
    realImg.dataset.shot = name
    realImg.width = screen.w
    realImg.height = screen.h
    realImg.alt = screen.alt
    $('#real-cap').textContent = screen.cap
    paintShots()
  }
  const tabs = $$('[role="tab"][data-screen]')
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showScreen(tab.dataset.screen))
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
      if (!step) return
      showScreen(tabs[(i + step + tabs.length) % tabs.length].dataset.screen, true)
      event.preventDefault()
    })
  })

  /* ================================================================ Scroll-driven moments */

  let nudged = false
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const target = entry.target
        target.classList.add('seen')
        if (target.id === 'threads' && !nudged) { nudged = true; $('.depth').classList.add('nudge') }
        if (target.id === 'start') typeCommands()
      }
    }, { rootMargin: '0px 0px -30% 0px' })
    $$('.chapter, .close, #start').forEach((node) => seen.observe(node))

    // The team starts on its own when its timeline comes into view, if nobody pressed Run.
    const watchPanel = $('#watch .ch-panel')
    const autostart = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !run) startRun()
    }, { threshold: 0.45 })
    autostart.observe(watchPanel)
  } else {
    $$('.chapter, .close').forEach((node) => node.classList.add('seen'))
  }

  /* ================================================================ First paint */

  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark')
  renderApps()
  renderWarpPreview()
  renderTeamViews()
  renderRequests()
  renderRunUI()
  renderReview(true)
  renderResult(true)
  renderFabric()
  renderSwatch()
  showScreen('home')
  paintProgress()
})()

// LoomWatch landing page. The page is one team's chat, and the visitor is in it: choose apps, build
// a team, @ it with a job, write to it while it works, review, read the answer, @ one agent for
// another pass. No dependencies, no network calls, and the static page stays readable without it.
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

  // Gemini CLI is left out: Google refuses it with a personal sign-in (see the README's note).
  const APPS = [
    { id: 'claude', name: 'Claude Code', mono: 'C', spawn: 'claude-agent-acp' },
    { id: 'codex', name: 'Codex', mono: 'Cx', spawn: 'codex-acp' },
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
      ask: { q: 'Which release notes back claim 2?', a: "Both browser makers' notes from this week. The links are under claim 2 in findings.md." },
      tell: { researcher: 'Only stories from the last seven days.', writer: 'Lead with the model release.' },
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
      ask: { q: 'Which page says hourly, for claim 1?', a: "Apple's Time Machine guide. The link is under claim 1 in findings.md." },
      tell: { researcher: 'Include one option that costs nothing.', writer: 'Put the pick first, then why.' },
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
      ask: { q: 'Claim 2: which command runs too early?', a: 'The install command on line 18. It runs before the cd into the project folder.' },
      tell: { researcher: 'Check the Makefile for the real install steps.', writer: 'Keep it under fifteen lines.' },
      title2: 'Getting started, rewritten',
      intro: (n, sourced, reviewed) => `A new section for the README, written from ${reviewed ? 'the findings you approved' : 'what Researcher found'}.`,
      file: 'README.md',
      kind: 'Proposed change',
    },
  ]
  const preset = (id) => REQUESTS.find((r) => r.id === id) || REQUESTS[0]

  // What can be handed to an agent (03 · Give): a folder linked where it is, a file copied beside
  // the team, a skill and a tool from this computer. One card can thread to several agents.
  const SOURCES = [
    { id: 'reports', kind: 'folder', name: 'market-reports/', meta: 'Linked folder', arrives: 'its listing and README', path: '~/Documents/market-reports', reads: 'read · market-reports/README.md' },
    { id: 'brand', kind: 'file', name: 'brand-guide.pdf', meta: 'Added file', arrives: 'its text, all 12 pages', path: 'research-and-write.files/brand-guide.pdf', reads: 'read · brand-guide.pdf' },
    { id: 'style', kind: 'skill', name: 'house-style', meta: 'Skill · from Claude Code', arrives: 'its instructions, required', reads: 'skill · house-style/SKILL.md' },
    { id: 'notes', kind: 'tool', name: 'team-notes', meta: 'Tool · your MCP server', arrives: 'its tools, for this run', reads: 'team-notes · search' },
  ]
  const source = (id) => SOURCES.find((x) => x.id === id)
  const GIVEN_TO = ['researcher', 'writer']
  const ALLOW = [
    { key: 'web', label: 'Search the web' },
    { key: 'edits', label: 'Edit files' },
    { key: 'commands', label: 'Run commands' },
  ]

  const state = {
    apps: ['claude', 'codex', 'opencode'],
    team: { researcher: 'claude', writer: 'codex', review: true },
    request: 'digest',
    give: { researcher: ['reports'], writer: ['brand', 'style'] },
    allow: { researcher: { web: true, edits: false, commands: false }, writer: { web: false, edits: true, commands: false } },
    cwd: { researcher: '~/Documents/research', writer: '~/projects/news-site' },
  }
  const seq = (team) => (team.review ? ['researcher', 'you', 'writer'] : ['researcher', 'writer'])
  const LANE = { researcher: 'Researcher', you: 'You', writer: 'Writer' }

  /* ================================================================ Theme and progress */

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

  // The Build panel's Story · Team · Trace switch: the team as its sentence, its canvas, or its file.
  const teamViews = $('#team-views')
  const viewButtons = $$('.dial [data-view]')
  function setView(view) {
    teamViews.dataset.view = view
    viewButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.view === view)))
  }
  viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)))
  $('.dial').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const at = viewButtons.findIndex((b) => b.dataset.view === teamViews.dataset.view)
    const next = viewButtons[(at + (event.key === 'ArrowRight' ? 1 : viewButtons.length - 1)) % viewButtons.length]
    setView(next.dataset.view); next.focus(); event.preventDefault()
  })
  setView('team')

  const progress = $('.progress')
  let progressQueued = false
  function paintProgress() {
    progressQueued = false
    const max = root.scrollHeight - window.innerHeight
    progress.style.setProperty('--read', max > 0 ? clamp(window.scrollY / max).toFixed(4) : '0')
    paintOpen()
  }
  window.addEventListener('scroll', () => { if (!progressQueued) { progressQueued = true; window.requestAnimationFrame(paintProgress) } }, { passive: true })

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
  const DESK = { claude: [0.04, 0.05, -3], codex: [0.96, 0, 2.4], hermes: [0, 0.9, 1.8], opencode: [0.92, 1, -2.2] }
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
    if (busy()) parts.push(el('span', { class: 'micro', style: 'display:block;margin-top:8px;letter-spacing:.05em', text: 'The team is working · changes apply to its next piece of work' }))
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
        you ? null : el('div', { class: 'ap', text: `on ${app(t[who]).name}` }),
        you || !state.give[who].length ? null : el('a', { class: 'gv', href: '#give', text: `${state.give[who].length} handed over` }))
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
    const spawn = (id, who) => { const a = app(id); return `{ cmd: ${a.spawn}${a.args ? `, args: [${a.args.join(', ')}]` : ''}, cwd: ${state.cwd[who]} }` }
    const given = (who) => {
      const lines = []
      if (state.give[who].length) {
        lines.push('    capabilities:')
        for (const id of state.give[who]) {
          const x = source(id)
          lines.push(x.kind === 'folder' || x.kind === 'file'
            ? `      - { kind: knowledge, name: ${x.name.replace(/\/$/, '')}, path: ${x.path} }`
            : `      - { kind: ${x.kind}, name: ${x.name} }`)
        }
      }
      const on = ALLOW.filter((a) => state.allow[who][a.key]).map((a) => `${a.key}: true`)
      if (on.length) lines.push(`    allow: { ${on.join(', ')} }`)
      return lines
    }
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
      `    spawn: ${spawn(t.researcher, 'researcher')}`,
      ...given('researcher'),
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
      `    spawn: ${spawn(t.writer, 'writer')}`,
      ...given('writer'),
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
    renderGive()
    if (!run) renderChatUI()
  }

  // Ask LoomWatch: one of your own apps proposes the team, and nothing changes until Apply.
  const proposeBox = $('#propose')
  const describe = $('#describe')
  let proposing = 0
  describe.addEventListener('click', async () => {
    const mine = ++proposing
    const pool = state.apps
    const pick = (avoid, prefer) => prefer.find((id) => pool.includes(id) && id !== avoid) || pool.find((id) => id !== avoid) || pool[0]
    const researcher = pick(state.team.researcher, ['opencode', 'claude', 'codex', 'hermes', 'openclaw'])
    const writer = pick(researcher, ['claude', 'codex', 'opencode', 'hermes', 'openclaw'])
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

  /* ================================================================ 03 · Give */

  // Folders, files, skills and tools are cards. Drag one onto an agent (or tap it, then the agent)
  // and that agent is handed it; the same card can thread to several agents. The packet below says
  // exactly what the selected agent gets, where it works and what it may do without asking.
  const giveBox = $('#give-canvas')
  const giveAgents = $('#give-agents')
  const giveShelf = $('#give-shelf')
  const giveThreads = $('#give-threads')
  const packetBox = $('#packet')
  const giveHint = $('#give-hint')
  const GIVE_HINT = giveHint.textContent
  let giveFor = 'researcher'
  let picked = null
  let justDragged = false
  let hintTimer = 0

  const ICONS = {
    folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
    file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M16 13H8M16 17H8M10 9H8'],
    skill: ['M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z'],
    tool: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  }
  function icon(kind) {
    const svg = el('svg:svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })
    for (const d of ICONS[kind]) svg.append(el('svg:path', { d }))
    return svg
  }
  const readOnly = (x) => x.kind === 'folder' || x.kind === 'file'
  const readersOf = (id) => GIVEN_TO.filter((who) => state.give[who].includes(id))
  function say(text) {
    giveHint.textContent = text
    window.clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => { giveHint.textContent = picked ? giveHint.textContent : GIVE_HINT }, 5200)
  }

  function renderGive() {
    giveAgents.replaceChildren(...GIVEN_TO.map((who) => {
      const takes = picked && !state.give[who].includes(picked)
      return el('button', {
        type: 'button', class: `g-agent${who === giveFor ? ' on' : ''}${takes ? ' takes' : ''}`, 'data-who': who, 'aria-pressed': String(who === giveFor),
        'aria-label': picked ? `Hand ${source(picked).name} to ${LANE[who]}` : `${LANE[who]}, on ${app(state.team[who]).name}, ${state.give[who].length} handed over. Show what it is given.`,
        onclick: () => { if (picked) handOverSource(picked, who); else { giveFor = who; renderGive() } },
      },
      el('span', { class: 'kind', text: 'Agent' }),
      el('span', { class: 'nm', text: LANE[who] }),
      el('span', { class: 'ap', text: `on ${app(state.team[who]).name}` }),
      el('span', { class: 'wk', title: 'Works in' }, icon('folder'), el('span', { text: state.cwd[who] })))
    }))
    giveShelf.replaceChildren(...SOURCES.map((x) => {
      const readers = readersOf(x.id)
      return el('button', {
        type: 'button', class: `g-src kind-${x.kind}${picked === x.id ? ' picked' : ''}${readers.length ? ' given' : ''}`, 'data-src': x.id, 'aria-pressed': String(picked === x.id),
        'aria-label': `${x.name}, ${x.meta}. ${readers.length ? `Handed to ${listText(readers.map((w) => LANE[w]))}.` : 'Not handed to anyone yet.'} ${picked === x.id ? 'Picked up: choose an agent.' : 'Drag it onto an agent, or press to pick it up.'}`,
        onpointerdown: (event) => dragSource(event, x.id),
        onclick: () => { if (!justDragged) pickSource(x.id) },
      },
      el('span', { class: 'g-ico' }, icon(x.kind)),
      el('span', { class: 'g-txt' }, el('span', { class: 'g-nm', text: x.name }), el('span', { class: 'g-mt', text: x.meta })),
      readers.length > 1 ? el('span', { class: 'g-shared', text: `shared · ${readers.length}` }) : null)
    }))
    giveBox.classList.toggle('picking', Boolean(picked))
    const threads = GIVEN_TO.reduce((n, who) => n + state.give[who].length, 0)
    $('#give-count').textContent = `${threads} thread${threads === 1 ? '' : 's'}`
    drawGiveThreads()
    renderPacket()
  }

  // One gold thread per agent and card, from the agent across to the card. The selected agent's
  // threads are solid and carry the one way to take a card back, near the card's end.
  function drawGiveThreads() {
    $$('.g-cut', giveBox).forEach((cut) => cut.remove())
    const box = giveBox.getBoundingClientRect()
    if (!box.width) return
    // Pixel coordinates, no viewBox: the threads are redrawn whenever the cards move.
    giveThreads.replaceChildren()
    const at = (p0, p1, p2, p3, t) => {
      const u = 1 - t
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
    }
    for (const who of GIVEN_TO) {
      const agent = $(`.g-agent[data-who="${who}"]`, giveBox)?.getBoundingClientRect()
      for (const id of state.give[who]) {
        const card = $(`.g-src[data-src="${id}"]`, giveBox)?.getBoundingClientRect()
        if (!agent || !card) continue
        const x1 = agent.right - box.left
        const y1 = agent.top + agent.height / 2 - box.top
        const x2 = card.left - box.left
        const y2 = card.top + card.height / 2 - box.top
        const mx = (x1 + x2) / 2
        giveThreads.append(el('svg:path', { class: `g-thread${who === giveFor ? ' lit' : ''}`, d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}` }))
        // Only the selected agent's threads can be cut, so the canvas stays calm.
        if (who !== giveFor) continue
        giveBox.append(el('button', {
          type: 'button', class: 'g-cut', style: `left:${at(x1, mx, mx, x2, 0.72)}px;top:${at(y1, y1, y2, y2, 0.72)}px`, text: '×',
          'aria-label': `Take ${source(id).name} back from ${LANE[who]}`, title: `Take ${source(id).name} back from ${LANE[who]}`,
          onclick: () => takeBack(id, who),
        }))
      }
    }
  }

  function pickSource(id) {
    picked = picked === id ? null : id
    renderGive()
    say(picked ? `Now choose who gets ${source(picked).name}. Press it again to put it back.` : GIVE_HINT)
    if (picked) $('.g-agent', giveBox)?.focus()
  }
  function handOverSource(id, who) {
    picked = null
    if (state.give[who].includes(id)) say(`${LANE[who]} already has ${source(id).name}.`)
    else {
      state.give[who] = SOURCES.map((x) => x.id).filter((x) => x === id || state.give[who].includes(x))
      const readers = readersOf(id)
      say(readers.length > 1 ? `${source(id).name} is shared now: one card, ${['', '', 'two', 'three'][readers.length] || readers.length} threads.` : `${LANE[who]} is handed ${source(id).name}${readOnly(source(id)) ? ', read only' : ''}.`)
    }
    giveFor = who
    renderCanvas(); renderYaml(); renderGive()
  }
  function takeBack(id, who) {
    state.give[who] = state.give[who].filter((x) => x !== id)
    say(`${LANE[who]} no longer gets ${source(id).name}.`)
    giveFor = who
    renderCanvas(); renderYaml(); renderGive()
  }
  // The cards move when the panel resizes, fonts arrive or the layout stacks; the threads follow.
  if ('ResizeObserver' in window) {
    const follow = new ResizeObserver(() => drawGiveThreads())
    ;[giveBox, giveAgents, giveShelf].forEach((node) => follow.observe(node))
  }
  document.fonts?.ready.then(() => drawGiveThreads())
  giveBox.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picked) { picked = null; renderGive(); say(GIVE_HINT) }
  })

  // A mouse or pen drags the card itself; a finger taps it and then the agent, so the page still scrolls.
  function dragSource(event, id) {
    if (event.button !== 0 || event.pointerType === 'touch') return
    const card = event.currentTarget
    const start = { x: event.clientX, y: event.clientY }
    const rect = card.getBoundingClientRect()
    let ghost = null
    let over = null
    let frame = 0
    let at = start
    // At most one move and one hit test per frame, however often the pointer reports.
    const follow = () => {
      frame = 0
      ghost.style.transform = `translate(${at.x - (start.x - rect.left)}px, ${at.y - (start.y - rect.top)}px) rotate(-2.5deg)`
      const target = document.elementFromPoint(at.x, at.y)?.closest('.g-agent')
      if (target !== over) { over?.classList.remove('over'); over = target; over?.classList.add('over') }
    }
    const move = (e) => {
      at = { x: e.clientX, y: e.clientY }
      if (!ghost) {
        if (Math.hypot(at.x - start.x, at.y - start.y) < 6) return
        ghost = card.cloneNode(true)
        ghost.classList.add('g-ghost')
        ghost.style.width = `${rect.width}px`
        // Placed under the pointer before it is shown, so it never appears anywhere else first.
        follow()
        document.body.append(ghost)
        giveBox.classList.add('dragging')
        return
      }
      if (!frame) frame = window.requestAnimationFrame(follow)
    }
    const stop = (e) => {
      card.removeEventListener('pointermove', move)
      card.removeEventListener('pointerup', stop)
      card.removeEventListener('pointercancel', stop)
      window.cancelAnimationFrame(frame)
      if (!ghost) return
      // The drop lands where the pointer let go, even if the last move had not been drawn yet.
      if (e.type === 'pointerup') { at = { x: e.clientX, y: e.clientY }; follow() }
      ghost.remove()
      giveBox.classList.remove('dragging')
      over?.classList.remove('over')
      justDragged = true
      window.setTimeout(() => { justDragged = false }, 0)
      if (over && e.type === 'pointerup') handOverSource(id, over.dataset.who)
    }
    try { card.setPointerCapture(event.pointerId) } catch { /* the moves still reach the card while over it */ }
    card.addEventListener('pointermove', move)
    card.addEventListener('pointerup', stop)
    card.addEventListener('pointercancel', stop)
  }

  function renderPacket() {
    const who = giveFor
    const items = state.give[who].map(source)
    // OpenCode doesn't ask before it acts, so for it the switches below promise nothing.
    const asksFirst = state.team[who] !== 'opencode'
    packetBox.replaceChildren(
      el('div', { class: 'pk-head' },
        el('span', { class: 'micro', text: 'What it gets, every run' }),
        el('b', { text: `${LANE[who]}, on ${app(state.team[who]).name}` })),
      el('dl', { class: 'pk' },
        el('div', {}, el('dt', { text: 'Works in' }), el('dd', {}, el('code', { text: state.cwd[who] }),
          el('span', { class: 'pk-note', text: state.allow[who].edits ? ' Its project. It may change files here.' : asksFirst ? ' Its project. It reads here, and asks before it changes a file.' : ' Its project. OpenCode can change files here without asking.' }))),
        el('div', {}, el('dt', { text: 'Handed over' }), el('dd', {}, items.length
          ? el('ul', { class: 'pk-list' }, items.map((x) => el('li', {}, icon(x.kind), el('span', {}, el('b', { text: x.name }), el('small', { text: `${x.arrives}${readOnly(x) ? ', read only' : ''}` })))))
          : el('span', { class: 'pk-note', text: `Nothing yet. Drag a card onto ${LANE[who]}.` }))),
        el('div', {}, el('dt', { text: 'May, without asking' }), el('dd', { class: 'pk-allow' }, ALLOW.map((a) => el('button', {
          type: 'button', role: 'switch', class: 'sw', 'aria-checked': String(state.allow[who][a.key]),
          onclick: () => { state.allow[who][a.key] = !state.allow[who][a.key]; renderYaml(); renderPacket() },
        }, el('i', { 'aria-hidden': 'true' }), a.label))))),
      el('p', { class: 'pk-foot', text: asksFirst ? 'Anything else it asks for waits for your answer during the run.' : "OpenCode doesn't ask before it acts, so these switches can't hold it back." }))
  }

  /* ================================================================ 04–07 · The team's chat */

  // A team has one chat (ADR 0051 in LoomWatch): what you wrote to it and each piece of work, oldest
  // first. Chapters 04 to 07 are four views of that chat, and its one message box moves down the
  // page with the work, the way the box at the bottom of a LoomWatch chat always says where a
  // message will go before you send it. Only an @ starts work; anything else is a note.
  const chatItems = []
  const TEAM_NOTE = 'Keep it short, in plain words.'
  const FOLLOW = { text: 'Just the top three, please.', intro: 'The top three, most important first, from the same findings.' }
  // What the box holds for each thing it can do. A request and the follow-up are recorded runs, so
  // they are the page's words; notes are yours.
  const drafts = { request: '', teamnote: '', note: '', review: '', followup: `@Writer ${FOLLOW.text}` }
  // In Ask, the box holds a request or a team note. After the work it holds the follow-up, until
  // you pick a new request or the follow-up has been answered, and it goes back up to Ask.
  let home = 'request'
  let boxHome = true

  const askLog = $('#ask-log')
  const requestsBox = $('#requests')
  const requestsHead = $('#requests-h')
  const boxEl = $('#box')
  const boxText = $('#box-text')
  const boxWhere = $('#box-where')
  const boxTry = $('#box-try')
  const boxNow = $('#box-now')
  const boxGo = $('#box-go')
  const CHAPTER = { ask: 'Ask', watch: 'Watch', review: 'Review', result: 'Result' }

  const ROUTE_ICON = {
    team: 'M6 7.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM1.6 13.4c.6-2.3 2.2-3.5 4.4-3.5s3.8 1.2 4.4 3.5M10.6 2.9a2.4 2.4 0 0 1 0 4.6M12.2 9.9c1.3.4 2.1 1.6 2.4 3.5',
    agent: 'M10.6 8a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0zM10.6 8v1.1c0 1.2.9 1.9 1.9 1.9s1.9-.9 1.9-2.6A6.4 6.4 0 1 0 11.6 13.4',
    note: 'M2.5 3.2h11v7.3H7.6l-3.1 2.4v-2.4h-2z',
  }
  const routeIcon = (route) => el('svg:svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, el('svg:path', { d: ROUTE_ICON[route] || ROUTE_ICON.note }))

  function boxPlace() {
    if (run && ['running', 'asking'].includes(run.phase)) return 'watch'
    if (run && run.phase === 'review') return 'review'
    if (run && run.phase === 'done' && !boxHome) return 'result'
    return 'ask'
  }
  const boxMode = () => ({ watch: 'note', review: 'review', result: 'followup' })[boxPlace()] || home
  // The agent a note reaches: the one at work.
  const workingNow = () => (run && ['running', 'asking'].includes(run.phase) ? run.working : null)
  // The first @mention in a message, as LoomWatch reads one: @team, or an agent's name.
  function mentionIn(text) {
    const found = text.match(/(?:^|[\s(“"'])@(team|researcher|writer)(?![\p{L}\p{N}_-])/iu)
    return found ? found[1].toLowerCase() : null
  }

  // Where the message in the box would go, said before it is sent.
  function where() {
    const mode = boxMode()
    const steps = seq(state.team).length
    const starts = (to) => (to === 'team' ? { route: 'team', label: `Starts the team · ${steps} steps` } : { route: 'agent', label: `Starts ${LANE[to]} only` })
    if (mode === 'request') return { ...starts('team'), go: 'Start' }
    if (mode === 'followup') return { ...starts('writer'), go: 'Start', tip: 'Researcher keeps its findings.' }
    if (mode === 'review') return { route: 'answer', label: "A note to go with your review of Researcher's work · press Approve or Send back above" }
    const to = mentionIn(drafts[mode])
    if (mode === 'note') {
      const who = workingNow()
      if (!who) return { route: 'note', label: run.segs.length ? 'Handing over…' : 'Starting…', go: 'Send note', off: '' }
      if (!to || to === who) return { route: 'note', label: `Note for ${LANE[who]} · after its current step`, go: 'Send note', now: true }
      return { ...starts(to), go: 'Start', off: `This page plays one piece of work at a time. Leave out the @ to write to ${LANE[who]}.` }
    }
    if (to) return { ...starts(to), go: 'Start', off: 'This page starts work only from the requests above.' }
    return { route: 'team_note', label: 'Team note · starts nothing', go: 'Send note', tip: drafts.teamnote.trim() ? 'Add @team to start work.' : null }
  }

  function tryChip(text, onclick) {
    return el('button', { type: 'button', class: 'try', text, onclick })
  }

  function renderBox() {
    const place = boxPlace()
    const mode = boxMode()
    // The box goes where the work is; where it was, a line says where it went.
    for (const slot of $$('.box-slot')) {
      const name = slot.dataset.slot
      if (name === place) {
        if (boxEl.parentElement !== slot) {
          const focused = boxEl.contains(document.activeElement)
          slot.replaceChildren(boxEl)
          if (focused) boxText.focus({ preventScroll: true })
        }
        continue
      }
      const away = name === 'ask' && run
        ? el('p', { class: 'box-away' }, 'The message box went with the work. ', el('a', { class: 'link', href: `#${place}`, text: `${CHAPTER[place]} ↓` }))
        : name === 'result' && place === 'ask' && run && run.phase === 'done'
          ? el('p', { class: 'box-away' }, 'New work starts from the message box, back in ', el('a', { class: 'link', href: '#ask', text: 'Ask ↑' }))
          : null
      slot.replaceChildren(...(away ? [away] : []))
    }
    if (mode === 'request') drafts.request = `@team ${preset(state.request).request}`
    if (boxText.value !== drafts[mode]) boxText.value = drafts[mode]
    boxText.readOnly = mode === 'request' || mode === 'followup'
    const who = workingNow()
    const flagged = run && run.findings.some((f) => !f.src && !f.dropped)
    boxText.placeholder = mode === 'teamnote' ? 'A note the team reads the next time it works'
      : mode === 'note' ? `A note for ${who ? LANE[who] : 'the agent at work'}`
        : mode === 'review' ? (flagged ? 'To send it back, say what to change' : 'Optional. A note here goes on with the work.') : ''
    const w = where()
    boxEl.dataset.route = w.route
    boxWhere.replaceChildren(routeIcon(w.route), el('span', { text: w.label }),
      ...(w.off ? [el('em', { class: 'off', text: w.off })] : w.tip ? [el('em', { text: w.tip })] : []))
    const tries = []
    if (mode === 'request') {
      tries.push(tryChip('Or a note, with no @', () => { home = 'teamnote'; if (!drafts.teamnote.trim()) drafts.teamnote = TEAM_NOTE; renderAsk(); boxText.focus() }))
    } else if (mode === 'teamnote') {
      tries.push(tryChip('Back to a request', () => { home = 'request'; renderAsk(); boxText.focus() }))
    } else if (mode === 'note' && who && !drafts.note.trim()) {
      const text = run.preset.tell[who]
      tries.push(tryChip(`Try: “${text}”`, () => { drafts.note = text; renderBox(); boxText.focus() }))
    } else if (mode === 'review' && flagged && !drafts.review.trim()) {
      tries.push(tryChip(`Try: “${run.preset.note}”`, () => { drafts.review = run.preset.note; renderBox(); labelReview(); boxText.focus() }))
    }
    boxTry.replaceChildren(...tries)
    boxTry.hidden = tries.length === 0
    const text = drafts[mode].trim()
    boxNow.hidden = !w.now
    boxNow.disabled = !text
    if (who) boxNow.title = `Stop ${LANE[who]}'s current step and give it this at once`
    // A review is decided with the buttons on its message; the box only holds the note.
    boxGo.hidden = mode === 'review'
    boxGo.textContent = w.go || 'Send'
    boxGo.disabled = !text || w.off !== undefined
  }

  boxText.addEventListener('input', () => {
    if (boxText.readOnly) return
    const mode = boxMode()
    drafts[mode] = boxText.value
    renderBox()
    if (mode === 'review') labelReview()
  })
  boxText.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    // Enter never decides a review by accident.
    if (boxMode() !== 'review') send(false)
  })
  boxEl.addEventListener('submit', (event) => { event.preventDefault(); send(false) })
  boxNow.addEventListener('click', () => send(true))

  function send(now) {
    const mode = boxMode()
    const w = where()
    const text = drafts[mode].trim()
    if (!text || w.off !== undefined || mode === 'review') return
    if (mode === 'request') { startRun(); scrollToId('watch'); return }
    if (mode === 'followup') { startFollowUp(); return }
    if (mode === 'teamnote') {
      chatItems.push({ kind: 'teamnote', text, readBy: null })
      drafts.teamnote = ''
      home = 'request'
      renderAsk()
      return
    }
    // A note to the agent at work joins its next turn; Send now stops its current step first.
    const who = workingNow()
    run.told.push({ to: who, text, now, t: run.clock, takenAt: null })
    if (now) run.interrupt = who
    drafts.note = ''
    log('you', `You wrote to ${LANE[who]}`, { say: now ? `You stopped ${LANE[who]}'s current step to give it your note.` : `Your note waits for ${LANE[who]}'s current step to end.` })
    renderPiece()
    renderBox()
  }

  /* ---------------- 04 · Ask: the chat, and what you can write to it */

  function renderRequests() {
    const open = boxPlace() === 'ask' || (run && run.phase === 'done')
    requestsBox.hidden = !open
    requestsHead.hidden = !open
    requestsHead.textContent = chatItems.some((i) => i.kind === 'piece') ? 'Ask for something else' : 'Try asking'
    const checked = (r) => r.id === state.request && home === 'request' && boxPlace() === 'ask'
    requestsBox.replaceChildren(...REQUESTS.map((r) => el('button', {
      type: 'button', class: 'req', role: 'radio', 'aria-checked': String(checked(r)),
      onclick: () => { state.request = r.id; home = 'request'; boxHome = true; renderAsk() },
    },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('span', { class: 't', text: r.title }),
    el('span', { class: 'm' }, 'Researcher reads ', el('b', { text: r.reads })))))
  }
  requestsBox.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
    const at = REQUESTS.findIndex((r) => r.id === state.request)
    state.request = REQUESTS[(at + (event.key === 'ArrowDown' ? 1 : REQUESTS.length - 1)) % REQUESTS.length].id
    home = 'request'
    boxHome = true
    renderAsk()
    $('.req[aria-checked="true"]', requestsBox)?.focus()
    event.preventDefault()
  })

  const INITIALS = { researcher: 'Re', writer: 'Wr', you: 'You' }
  const avatar = (who, working = false) => el('span', { class: `tc-av m-${who}${working ? ' working' : ''}`, text: INITIALS[who] })
  const mention = (who) => el('span', { class: `tc-at m-${who}`, text: `@${who === 'you' ? 'You' : LANE[who]}` })
  const dots = () => el('span', { class: 'tc-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'))
  // Your message as the chat shows it, its @ picked out.
  function withMention(text) {
    const found = text.match(/^@(\S+)\s+/)
    return found ? [el('span', { class: 'tc-at m-you', text: `@${found[1]}` }), ' ', text.slice(found[0].length)] : [text]
  }
  // One message: an agent's on the left, yours on the right in gold.
  function msg({ from, meta, to, time, body, under, cls = '' }) {
    const mine = from === 'you'
    return el('div', { class: `tc-msg m-${from}${mine ? ' mine' : ''} ${cls}` },
      mine ? el('span', { class: 'tc-gutter' }) : avatar(from),
      el('div', { class: 'tc-main' },
        el('div', { class: 'tc-meta' }, el('b', { text: meta }), to ? el('span', { class: 'tc-to', text: to }) : null, time !== undefined ? el('time', { text: time }) : null),
        body ? el('div', { class: 'tc-bubble' }, ...body) : null,
        under ? el('div', { class: 'tc-under', text: under }) : null))
  }
  const workersOf = (r) => (r && r.only ? [r.only] : ['researcher', 'writer'])
  const worked = (r) => `${listText(workersOf(r).map((w) => LANE[w]))} worked on this · ${clockText(r.clock)}`
  // The team on a piece of work as a thread: each agent a knot, blue while it works.
  const weft = (r) => el('span', { class: 'weft', 'aria-hidden': 'true' }, workersOf(r).map((w) => avatar(w, Boolean(r && r === run && r.scrub === null && r.stages[w] === 'running'))))

  function memberState(who) {
    if (!run || (run.only && who !== run.only)) return 'ready'
    const value = stageAt(who)
    return value === 'running' ? 'working' : value === 'waiting' ? 'waiting' : 'ready'
  }
  const MEMBER_WORD = { ready: 'ready', working: 'working', waiting: 'waiting for you' }
  function renderMembers() {
    const team = run ? run.team : state.team
    for (const list of $$('[data-members]')) {
      list.replaceChildren(...['researcher', 'writer'].map((who) => {
        const value = memberState(who)
        return el('li', { class: `mem ${value}`, title: `${LANE[who]} on ${app(team[who]).name} · ${MEMBER_WORD[value]}` },
          avatar(who, value === 'working'), el('span', { text: LANE[who] }), el('em', { text: MEMBER_WORD[value] }))
      }))
    }
  }

  // A piece of work, as the top of the chat lists it: who worked on it, and where it is now.
  function pieceLine(r) {
    const live = r === run && r.phase !== 'done'
    const [text, href, go] = !live
      ? [worked(r), r === run ? '#result' : null, r === run ? 'Read the answer ↓' : null]
      : r.phase === 'review' ? ["Waiting for you · Researcher's work is ready for your review", '#review', 'Review it ↓']
        : r.phase === 'asking' ? ['Waiting for you · Researcher asked you something', '#watch', 'Answer it ↓']
          : [`${LANE[r.working] || 'The team'} is working`, '#watch', 'Watch it ↓']
    return el('div', { class: 'piece-line' }, weft(r), el('span', { text }), href ? el('a', { class: 'link', href, text: go }) : null)
  }

  function renderAskLog() {
    if (!chatItems.length) {
      askLog.replaceChildren(el('div', { class: 'tc-empty' },
        el('h3', { text: 'Talk to Research and write' }),
        el('p', {}, 'Write ', el('b', { text: '@team' }), ' and what you need to start the whole team, or ', el('b', { text: '@' }), ' a name to ask one agent. Anything without an @ is a note the team reads the next time it works.')))
      return
    }
    askLog.replaceChildren(...chatItems.map((item) => {
      if (item.kind === 'teamnote') {
        return msg({ from: 'you', meta: 'You', to: 'team note', body: [el('p', { text: item.text })], under: item.readBy ? 'Read by the work after it' : 'Starts nothing · the next work reads it', cls: 'teamnote' })
      }
      const r = item.run
      return el('div', { class: 'ask-piece' },
        msg({ from: 'you', meta: 'You', to: `→ ${r.only ? LANE[r.only] : 'the team'}`, body: [el('p', {}, ...withMention(r.asked))] }),
        pieceLine(r))
    }))
    askLog.scrollTop = askLog.scrollHeight
  }

  function renderAsk() {
    renderMembers()
    renderAskLog()
    renderRequests()
    renderBox()
  }

  /* ================================================================ The work */

  let run = null
  let runCount = 0
  // Working, waiting at the review step, or waiting for a permission answer.
  const busy = () => Boolean(run && ['running', 'review', 'asking'].includes(run.phase))
  const CANCEL = Symbol('cancel')
  const SIM_MS = 430 // one simulated second, in real milliseconds

  // A piece of work: the whole team on a request, or one agent on a follow-up to an earlier piece.
  function freshRun(only = null, prev = null) {
    const p = prev ? prev.preset : preset(state.request)
    return {
      n: ++runCount,
      only,
      prev,
      asked: only ? drafts.followup : `@team ${p.request}`,
      // Every piece is handed the conversation so far: earlier work, and team notes not yet read.
      earlier: chatItems.some((i) => i.kind === 'piece'),
      carried: chatItems.filter((i) => i.kind === 'teamnote' && !i.readBy),
      team: { ...(prev ? prev.team : state.team) },
      give: JSON.parse(JSON.stringify(state.give)),
      allow: JSON.parse(JSON.stringify(state.allow)),
      permission: null,
      preset: p,
      findings: (prev ? prev.findings : p.findings).map((f) => ({ ...f })),
      phase: 'running',
      clock: 0,
      events: [],
      chat: [],
      segs: [],
      stitches: [],
      hands: [],
      marks: [],
      stages: { researcher: 'idle', you: 'idle', writer: 'idle' },
      stageLog: [],
      pass: 0,
      sendBacks: 0,
      approved: prev ? prev.approved : false,
      notes: [],
      told: [],
      working: null,
      interrupt: null,
      waitedMs: 0,
      waitSince: 0,
      tools: { researcher: 0, writer: 0 },
      scrub: null,
    }
  }

  // Time passing while an agent works. Send now ends the agent's current step early.
  function work(sec) {
    const mine = run
    return new Promise((resolve, reject) => {
      if (reduced) { mine.clock += sec; renderLive(); window.setTimeout(() => (run === mine ? resolve() : reject(CANCEL)), 160); return }
      const target = mine.clock + sec
      let last = performance.now()
      function frame(now) {
        if (run !== mine) { reject(CANCEL); return }
        if (mine.interrupt && mine.interrupt === mine.working) { mine.interrupt = null; renderLive(); resolve(); return }
        mine.clock = Math.min(target, mine.clock + Math.min(now - last, 64) / SIM_MS)
        last = now
        renderLive()
        if (mine.clock >= target) resolve()
        else window.requestAnimationFrame(frame)
      }
      window.requestAnimationFrame(frame)
    })
  }

  // A note waits for the end of the agent's current step, then joins its next turn.
  async function takeNotes(who) {
    const r = run
    const due = r.told.filter((n) => n.to === who && n.takenAt === null)
    if (!due.length) return
    const now = due.some((n) => n.now)
    for (const n of due) n.takenAt = r.clock
    r.marks.push({ lane: who, t: r.clock, now })
    log(who, `${LANE[who]} took your note`, { say: now ? `${LANE[who]} stopped its current step and took your note: “${due.at(-1).text}”` : `${LANE[who]} took your note into its next turn: “${due.at(-1).text}”` })
    renderPiece()
    await work(1.1)
  }
  async function step(who, sec) {
    await work(sec)
    await takeNotes(who)
  }

  function log(who, text, extra = {}) {
    run.events.push({ t: run.clock, who, text, ...extra })
    if (extra.tool) run.stitches.push({ lane: who, t: run.clock })
    renderChat()
    renderNarration()
  }
  function segStart(lane, kind = 'work') { run.segs.push({ lane, kind, from: run.clock, to: null }) }
  function segEnd(lane) { const seg = [...run.segs].reverse().find((s) => s.lane === lane && s.to === null); if (seg) seg.to = run.clock }
  function setStage(lane, value) { run.stages[lane] = value; run.stageLog.push({ t: run.clock, lane, value }); renderChatUI() }
  // During a replay the chat shows what each agent was doing at that moment.
  function stageAt(lane) {
    if (!run) return 'idle'
    if (run.scrub === null) return run.stages[lane]
    const last = run.stageLog.filter((s) => s.lane === lane && s.t <= run.scrub + 1e-6).at(-1)
    return last ? last.value : 'idle'
  }
  function handOver(from, to) { run.hands.push({ from, to, t: run.clock }) }

  async function startRun() {
    askPerm.hidden = true
    boxHome = false
    run = freshRun()
    for (const note of run.carried) note.readBy = run.n
    chatItems.push({ kind: 'piece', run })
    const mine = run
    renderChatUI(true)
    renderSentence()
    try {
      log('you', `You asked: “${mine.preset.short}”`, { say: `You wrote to the team: “${mine.asked}”` })
      await work(0.8)
      await researcherPass()
      if (mine.team.review) await reviewLoop()
      else {
        handOver('researcher', 'writer')
        post({ kind: 'handover', from: 'researcher', to: 'writer', file: 'findings.md', meta: findingsMeta(mine) })
        log('researcher', 'Researcher handed over to Writer', { say: 'Researcher handed its findings straight to Writer. Nobody checked them.' })
      }
      await writerPass()
    } catch (error) {
      if (error !== CANCEL) throw error
    }
  }

  // @Writer on finished work: Writer alone does one more pass, with the conversation so far.
  async function startFollowUp() {
    const prev = run
    if (!prev || prev.phase !== 'done' || prev.only) return
    askPerm.hidden = true
    run = freshRun('writer', prev)
    for (const note of run.carried) note.readBy = run.n
    chatItems.push({ kind: 'piece', run })
    const mine = run
    renderChatUI(true)
    try {
      log('you', `You asked Writer: “${FOLLOW.text}”`, { say: `You wrote to Writer alone: “${FOLLOW.text}” Researcher's findings stay as they are.` })
      await work(0.6)
      await writerAgain()
    } catch (error) {
      if (error !== CANCEL) throw error
    }
    if (run === mine) scrollToId('result')
  }

  async function researcherPass() {
    const r = run
    const name = app(r.team.researcher).name
    r.pass += 1
    r.working = 'researcher'
    setStage('researcher', 'running')
    segStart('researcher')
    if (r.pass === 1) {
      const context = r.carried.length ? ', with the conversation so far and your note in it' : r.earlier ? ', with the conversation so far' : ''
      log('researcher', `Researcher started on ${name}`, { say: `Researcher started on ${name}${context}, reading ${r.preset.reads}.` })
      for (const id of r.give.researcher) {
        await step('researcher', 1.1)
        r.tools.researcher += 1
        log('researcher', 'Researcher', { tool: source(id).reads, say: `Researcher opened ${source(id).name}, which you handed it.` })
      }
      const web = r.preset.reads === 'the web'
      // OpenCode doesn't ask before it acts, so its switch being off doesn't stop it.
      if (web && !r.allow.researcher.web && r.team.researcher === 'opencode') log('researcher', 'Researcher searched the web without asking', { say: "Researcher's web switch is off, but OpenCode doesn't ask before it acts, so it searched anyway." })
      else if (web && !r.allow.researcher.web && !(await askPermission('researcher', r.preset.tools[0]))) r.deniedWeb = true
      for (const tool of r.deniedWeb ? r.preset.tools.filter((t) => !/^(web search|fetch)/.test(t)) : r.preset.tools) {
        await step('researcher', 1.7)
        r.tools.researcher += 1
        log('researcher', 'Researcher', { tool, say: `Researcher is working: ${tool.replace(' · ', ', ')}.` })
      }
      if (r.deniedWeb) log('researcher', 'Researcher carried on without the web', { say: `Researcher carried on without the web, from ${r.give.researcher.length ? 'what you handed it' : 'what it already knew'}.` })
      await step('researcher', 1.6)
      log('researcher', `Researcher wrote findings.md`, { tool: 'write · findings.md', say: `Researcher wrote down ${r.findings.length} findings, each with its source, or a gap where it had none.` })
    } else {
      log('researcher', 'Researcher picked up your note', { say: `Researcher picked up your review: “${r.notes.at(-1)?.text || ''}”` })
      await step('researcher', 1.6)
      r.tools.researcher += 1
      log('researcher', 'Researcher', { tool: r.preset.fix.tool, say: `Researcher is checking: ${r.preset.fix.tool.replace(' · ', ', ')}.` })
      await step('researcher', 1.4)
      const flagged = r.findings.find((f) => !f.src && !f.dropped)
      if (flagged) {
        if (r.preset.fix.src) { flagged.src = r.preset.fix.src; flagged.fixed = true } else { flagged.dropped = true; flagged.why = r.preset.fix.drop }
      }
      log('researcher', 'Researcher updated findings.md', { tool: 'write · findings.md', say: r.preset.fix.src ? `Researcher found a source for claim ${r.findings.indexOf(flagged) + 1}.` : `Researcher dropped claim ${r.findings.indexOf(flagged) + 1}: ${r.preset.fix.drop}.` })
    }
    await step('researcher', 0.9)
    segEnd('researcher')
    setStage('researcher', 'done')
  }

  async function reviewLoop() {
    const r = run
    for (;;) {
      handOver('researcher', 'you')
      const handed = post({ kind: 'handover', from: 'researcher', to: 'you', file: 'findings.md', meta: findingsMeta(r) })
      log('researcher', 'Researcher handed over to you', { say: 'Researcher handed over. The team has stopped, and it is waiting for you.' })
      const owed = owe('you', 'researcher', 'Waiting for your review')
      r.phase = 'review'
      r.waitSince = Date.now()
      segStart('you', 'wait')
      setStage('you', 'waiting')
      renderSentence()
      waitTicker(r)
      const decision = await new Promise((resolve) => { r.decide = resolve })
      if (run !== r) throw CANCEL
      r.waitedMs += Date.now() - r.waitSince
      segEnd('you')
      paid(owed)
      const quote = { from: 'researcher', text: `Handover: ${handed.file}, ${handed.meta}` }
      r.phase = 'running'
      if (decision.text) r.notes.push({ t: r.clock, text: decision.text, kind: decision.kind })
      if (decision.kind === 'approve') {
        r.approved = true
        r.approvedAt = r.clock
        if (decision.text) post({ kind: 'note', from: 'you', to: 'writer', text: decision.text, quote, under: 'approved · passed on to Writer' })
        else post({ kind: 'notice', from: 'you', text: 'You approved Researcher’s handover · passed on to Writer' })
        log('you', decision.text ? `You approved: “${decision.text}”` : 'You approved', { say: decision.text ? `You approved, with a note for Writer: “${decision.text}”` : 'You approved the findings as they were.' })
        handOver('you', 'writer')
        setStage('you', 'done')
        return
      }
      r.sendBacks += 1
      post({ kind: 'sentback', from: 'you', to: 'researcher', text: decision.text || 'Try again.', quote, under: 'sent back' })
      log('you', `You sent it back: “${decision.text || 'Try again.'}”`, { say: `You sent it back to Researcher: “${decision.text || 'Try again.'}”` })
      handOver('you', 'researcher')
      setStage('you', 'idle')
      await work(0.6)
      await researcherPass()
    }
  }

  function waitTicker(r) {
    // While the team waits, the dashed outline keeps growing, up to a point, so the work stays legible.
    let last = performance.now()
    let painted = 0
    function frame(now) {
      if (run !== r || !['review', 'asking'].includes(r.phase)) return
      const seg = [...r.segs].reverse().find((s) => s.kind === 'wait' && s.to === null)
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
    r.working = 'writer'
    setStage('writer', 'running')
    segStart('writer')
    log('writer', `Writer started on ${name}`, { say: `Writer started on ${name}, with ${r.team.review ? 'the findings you approved' : 'whatever Researcher found'}.` })
    for (const id of r.give.writer) {
      await step('writer', 0.9)
      r.tools.writer += 1
      const x = source(id)
      log('writer', 'Writer', { tool: x.reads, say: x.kind === 'skill' ? `Writer opened ${x.name}, which it is required to follow.` : `Writer opened ${x.name}, which you handed it.` })
    }
    await step('writer', 1.4)
    r.tools.writer += 1
    log('writer', 'Writer', { tool: 'read · findings.md', say: 'Writer is reading the findings.' })
    // A question back to an earlier step goes through the Team Bus, which OpenClaw can't reach.
    if (r.team.writer !== 'openclaw') {
      await step('writer', 1.2)
      const asked = post({ kind: 'question', from: 'writer', to: 'researcher', text: r.preset.ask.q })
      handOver('writer', 'researcher')
      log('writer', 'Writer asked Researcher', { say: `Writer asked Researcher: “${r.preset.ask.q}”` })
      const owed = owe('researcher', 'writer', 'Researcher is writing an answer')
      r.working = 'researcher'
      setStage('researcher', 'running')
      segStart('researcher')
      await step('researcher', 1.8)
      segEnd('researcher')
      setStage('researcher', 'done')
      paid(owed)
      post({ kind: 'answer', from: 'researcher', to: 'writer', text: r.preset.ask.a, quote: { from: 'writer', text: asked.text } })
      handOver('researcher', 'writer')
      r.working = 'writer'
      log('researcher', 'Researcher answered Writer', { say: 'Researcher answered, and Writer carried on with the answer in hand.' })
    }
    await step('writer', 2.6)
    r.tools.writer += 1
    log('writer', `Writer wrote ${r.preset.file}`, { tool: `write · ${r.preset.file}`, say: `Writer wrote ${r.preset.file}.` })
    await step('writer', 1)
    segEnd('writer')
    r.phase = 'done'
    log('team', 'Writer answered. The work is finished.', { say: "Writer answered in the chat. The work is finished, and its record has a receipt." })
    r.scrub = null
    setStage('writer', 'done')
    renderChatUI(true)
    renderSentence()
  }

  async function writerAgain() {
    const r = run
    const name = app(r.team.writer).name
    r.working = 'writer'
    setStage('writer', 'running')
    segStart('writer')
    log('writer', `Writer started on ${name}, alone`, { say: `Writer started alone on ${name}, with the conversation so far: your request, ${r.team.review ? 'the findings you approved' : "Researcher's findings"} and its last answer.` })
    await step('writer', 1.3)
    r.tools.writer += 1
    log('writer', 'Writer', { tool: `read · ${r.preset.file}`, say: 'Writer is reading its last answer.' })
    await step('writer', 1.8)
    r.tools.writer += 1
    log('writer', `Writer rewrote ${r.preset.file}`, { tool: `write · ${r.preset.file}`, say: `Writer cut ${r.preset.file} down to the top three.` })
    await step('writer', 0.8)
    segEnd('writer')
    r.phase = 'done'
    // The follow-up is answered, so the box goes back up to Ask for new work.
    boxHome = true
    log('team', 'Writer answered you.', { say: 'Writer answered you in the chat. Researcher’s findings were kept as they were.' })
    r.scrub = null
    setStage('writer', 'done')
    renderChatUI(true)
  }

  // ADR 0040 on the page: an agent wants something its switches don't allow, so the work stops and
  // asks. Allow is this once; Always allow turns the switch on in Give; Deny lets it carry on without.
  const askPerm = $('#ask-perm')
  async function askPermission(who, tool) {
    const r = run
    const query = (tool.match(/“(.+)”/) || [])[1] || tool
    r.phase = 'asking'
    segEnd(who)
    segStart(who, 'wait')
    r.waitSince = Date.now()
    log(who, `${LANE[who]} asked to search the web`, { say: `${LANE[who]} wants to search the web, and its switch is off. The work waits for your answer.` })
    const answerWith = (value) => () => { if (r.answerPermission) { const resolve = r.answerPermission; r.answerPermission = null; resolve(value) } }
    askPerm.hidden = false
    askPerm.replaceChildren(
      el('p', { class: 'ap-q' }, el('b', { text: `${LANE[who]} wants to search the web` }), ` for “${query}”. It's paused until you answer.`),
      el('div', { class: 'ap-acts' },
        el('button', { type: 'button', class: 'btn', text: 'Deny', onclick: answerWith('deny') }),
        el('button', { type: 'button', class: 'btn', text: 'Always allow', title: `Turns on Search the web for ${LANE[who]}, in Give`, onclick: answerWith('always') }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Allow', onclick: answerWith('once') })))
    setStage(who, 'waiting')
    renderSentence()
    waitTicker(r)
    const answer = await new Promise((resolve) => { r.answerPermission = resolve })
    if (run !== r) throw CANCEL
    askPerm.hidden = true
    r.waitedMs += Date.now() - r.waitSince
    r.permission = answer
    segEnd(who)
    segStart(who)
    r.phase = 'running'
    if (answer === 'always') { state.allow[who].web = true; r.allow[who].web = true; renderYaml(); renderPacket() }
    log('you', answer === 'deny' ? 'You said no to the web' : answer === 'always' ? 'You allowed the web from now on' : 'You allowed the web, once', {
      say: answer === 'deny' ? `You said no. ${LANE[who]} carries on without the web.` : answer === 'always' ? `You allowed it, and turned on Search the web for ${LANE[who]}.` : `You allowed it, for this run only.`,
    })
    setStage(who, 'running')
    renderSentence()
    return answer !== 'deny'
  }

  // A decision from the buttons on Researcher's handover; the note is what the box holds.
  function decide(kind) {
    if (!run || run.phase !== 'review' || !run.decide) return
    const text = drafts.review.trim()
    if (kind === 'send' && !text) return // the button stays off until there is a note
    drafts.review = ''
    const resolve = run.decide
    run.decide = null
    resolve({ kind, text })
  }

  /* ---------------- Drawing the chat */

  const talkWeft = $('#weft')
  const talkLine = $('#talk-line')
  const detailsToggle = $('#details-toggle')
  const details = $('#details')
  const pieceHead = $('#piece-head')
  const narration = $('#narration')
  const lanes = $('#lanes')
  const scrub = $('#scrub')
  const scrubInput = $('#scrub-input')
  const needsYou = $('#needs-you')

  function renderChatUI(force = false) {
    renderAsk()
    renderPiece()
    renderNarration()
    drawLanes()
    renderScrub()
    renderBadges()
    renderNeedsYou()
    renderReview(force)
    renderResult(force)
    $('#watch-clock').textContent = clockText(run ? (run.scrub ?? run.clock) : 0)
  }
  function renderLive() {
    drawLanes()
    $('#watch-clock').textContent = clockText(run ? run.clock : 0)
  }

  function badgeFor() {
    if (!run) return ['idle', 'Ready']
    if (run.phase === 'review' || run.phase === 'asking') return ['waiting', 'Waiting for you']
    if (run.phase === 'done') return ['done', 'Answered']
    return ['running', 'Working']
  }
  function renderBadges() {
    const [value, word] = badgeFor()
    $$('[data-run-badge]').forEach((badge) => { badge.dataset.state = value; badge.textContent = word })
    $('#review-win').dataset.state = value
  }

  function visibleEvents() {
    if (!run) return []
    const at = run.scrub ?? Infinity
    return run.events.filter((e) => e.t <= at + 1e-6)
  }
  function renderNarration() {
    const list = visibleEvents()
    narration.textContent = list.length ? (list.at(-1).say || list.at(-1).text) : 'The team starts when you @ it.'
  }
  function renderNeedsYou() { needsYou.hidden = !(run && run.phase === 'review') }

  /* ---------------- 05 · Watch: the piece of work, and what the agents say */

  function noteMsg(n) {
    const at = run.scrub ?? Infinity
    const taken = n.takenAt !== null && n.takenAt <= at + 1e-6
    const state = taken ? (n.now ? `${LANE[n.to]} stopped its step and took it` : `${LANE[n.to]} took it in its next turn`)
      : run.phase === 'done' && run.scrub === null ? 'The work ended before it was taken'
        : n.now ? `Stopping ${LANE[n.to]}'s current step…` : `Waits for ${LANE[n.to]}'s current step to end`
    return msg({ from: 'you', meta: 'Note', to: `→ ${LANE[n.to]}`, time: clockText(n.t), body: [el('p', { text: n.text })], under: state, cls: `note${taken ? ' taken' : ''}` })
  }

  let talkKey = ''
  function renderPiece() {
    if (!run) {
      pieceHead.replaceChildren()
    } else {
      const at = run.scrub ?? Infinity
      const kids = [msg({ from: 'you', meta: 'You', to: `→ ${run.only ? LANE[run.only] : 'the team'}`, time: '0:00', body: [el('p', {}, ...withMention(run.asked))] })]
      if (run.carried.length || run.earlier) {
        kids.push(el('p', { class: 'picked', text: run.carried.length
          ? `${run.only ? 'Writer' : 'The team'} read the conversation so far, with your note “${run.carried.at(-1).text}”`
          : `${run.only ? 'Writer' : 'The team'} read the conversation so far` }))
      }
      for (const n of run.told) if (n.t <= at + 1e-6) kids.push(noteMsg(n))
      pieceHead.replaceChildren(...kids)
    }
    const key = run ? `${run.n}:${run.phase}:${run.scrub === null ? 'live' : Math.round(run.scrub)}:${workersOf(run).map(stageAt).join(',')}` : 'none'
    if (key !== talkKey) {
      talkKey = key
      talkWeft.replaceChildren(...weft(run).childNodes)
      const r = run
      const live = r && r.scrub === null
      const working = r ? workersOf(r).filter((w) => stageAt(w) === 'running') : []
      talkLine.replaceChildren(...(!r ? ['Nobody is working. The team starts when you write ', el('b', { text: '@team' }), '.']
        : live && r.phase === 'review' ? [el('b', { text: 'Waiting for you' }), " · Researcher's work is ready for your review"]
          : live && r.phase === 'asking' ? [el('b', { text: 'Waiting for you' }), ' · Researcher asked to search the web']
            : live && r.phase === 'done' ? [worked(r)]
              : working.length ? [el('b', { text: listText(working.map((w) => LANE[w])) }), working.length === 1 ? ' is working' : ' are working', live ? dots() : '']
                : [!live ? `Replaying · ${clockText(r.scrub)}` : r.segs.length ? 'Handing over…' : 'Starting…']))
    }
  }

  detailsToggle.addEventListener('click', () => {
    const open = detailsToggle.getAttribute('aria-expanded') !== 'true'
    detailsToggle.setAttribute('aria-expanded', String(open))
    details.hidden = !open
    if (open) drawLanes()
  })

  // What the agents said to each other, inline in the piece as LoomWatch shows it: only messages (a
  // handover, a question and its answer, your review), each at the moment it was sent, so a replay
  // shows the talk as it stood then. Tool calls stay on the timeline in Details.
  const chatLog = $('#tchat-log')
  const chatSeen = { n: 0, ids: new Set(), key: '' }

  function post(item) {
    const message = { id: run.chat.length, t: run.clock, ...item }
    run.chat.push(message)
    renderChat()
    return message
  }
  // An answer someone owes shows as being written until it is given.
  function owe(from, to, word) { return post({ kind: 'waiting', from, to, word, until: null }) }
  function paid(owed) { owed.until = run.clock; renderChat() }
  function findingsMeta(r) {
    const kept = r.findings.filter((f) => !f.dropped)
    const sourced = kept.filter((f) => f.src).length
    return `${kept.length} findings, ${sourced === kept.length ? 'each with a source' : `${sourced} with a source`}`
  }

  function visibleChat() {
    if (!run) return []
    const at = (run.scrub ?? Infinity) + 1e-6
    return run.chat.filter((c) => c.t <= at && !(c.kind === 'waiting' && c.until !== null && c.until <= at))
  }

  function renderChat() {
    const list = visibleChat()
    const key = `${run ? run.n : 0}:${list.map((c) => `${c.id}${c.until === null ? '' : '.'}`).join(',')}`
    if (key === chatSeen.key) return
    chatSeen.key = key
    if (!run || run.n !== chatSeen.n) { chatSeen.n = run ? run.n : 0; chatSeen.ids.clear() }
    if (!list.length) {
      chatLog.replaceChildren(el('li', { class: 'tchat-none', text: run && run.only ? 'Writer is working alone, so nothing passes between the agents.' : 'Nothing has passed between the agents yet.' }))
      markClipped()
      return
    }
    const live = run.scrub === null
    chatLog.replaceChildren(...list.map((c, i) => {
      const fresh = live && !chatSeen.ids.has(c.id) ? ' fresh' : ''
      chatSeen.ids.add(c.id)
      if (c.kind === 'notice') return el('li', { class: `tc-notice${fresh}` }, el('span', { text: c.text }), el('time', { text: clockText(c.t) }))
      const prev = list[i - 1]
      const continued = prev && prev.kind !== 'notice' && prev.from === c.from
      const mine = c.from === 'you'
      const bubble = c.kind === 'waiting'
        ? el('div', { class: 'tc-bubble typing' }, dots(), el('span', { text: c.word }))
        : el('div', { class: 'tc-bubble' },
          c.quote ? el('blockquote', { class: `tc-quote m-${c.quote.from}` }, el('b', { text: LANE[c.quote.from] }), el('span', { text: c.quote.text })) : null,
          c.kind === 'handover'
            ? el('div', { class: 'tc-file' },
              el('span', { class: 'tc-file-to' }, 'Handover to ', mention(c.to)),
              el('span', { class: 'tc-doc' },
                el('svg:svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, el('svg:path', { d: 'M4 1.5h5.2L12.5 4.8V14.5H4z M9 1.5V5h3.5' })),
                el('span', {}, el('b', { text: c.file }), el('span', { text: c.meta }))))
            : el('p', {}, c.kind === 'question' || c.kind === 'note' ? [mention(c.to), ' '] : null, c.text))
      return el('li', { class: `tc-msg m-${c.from}${mine ? ' mine' : ''}${continued ? ' continued' : ''}${fresh}` },
        mine || continued ? el('span', { class: 'tc-gutter' }) : avatar(c.from),
        el('div', { class: 'tc-main' },
          continued ? null : el('div', { class: 'tc-meta' }, el('b', { text: mine ? 'You' : LANE[c.from] }), el('time', { text: clockText(c.t) })),
          bubble,
          c.under ? el('div', { class: 'tc-under', text: c.under }) : null))
    }))
    chatLog.scrollTop = chatLog.scrollHeight
    markClipped()
  }
  function markClipped() { chatLog.classList.toggle('clipped', chatLog.scrollTop > 4) }
  chatLog.addEventListener('scroll', markClipped, { passive: true })

  function drawLanes() {
    const team = run ? run.team : state.team
    const order = run && run.only ? [run.only] : seq(team)
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
      // Where a note of yours joined an agent's turn: a gold diamond, cut first when it was Send now.
      for (const m of run.marks) {
        if (!order.includes(m.lane) || m.t > now) continue
        const mx = x(m.t)
        const my = y(m.lane)
        if (m.now) kids.push(el('svg:line', { class: 'ln-cut', x1: mx - 5, x2: mx - 5, y1: my - 9, y2: my + 9 }))
        kids.push(el('svg:rect', { class: 'ln-note', x: mx - 4, y: my - 4, width: 8, height: 8, transform: `rotate(45 ${mx} ${my})` }))
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
    renderChat(); renderNarration(); renderMembers(); renderPiece(); drawLanes()
    $('#watch-clock').textContent = clockText(run.scrub ?? run.clock)
  })

  /* ---------------- 06 · Review: decided on the message that asks */

  const reviewBody = $('#review-body')
  let reviewKey = ''
  let reviewButtons = null
  // Approve needs no note and says so once one is typed, because the note then goes on with the
  // work; sending it back needs a note that says what to change.
  function labelReview() {
    if (!reviewButtons) return
    const typed = Boolean(drafts.review.trim())
    reviewButtons.go.textContent = typed ? 'Approve with your note' : 'Approve'
    reviewButtons.back.disabled = !typed
    if (typed) reviewButtons.back.removeAttribute('title'); else reviewButtons.back.title = 'Write what should change in the box below first.'
    reviewButtons.tip.hidden = typed
  }
  function renderReview(force = false) {
    const key = run ? `${run.n}:${run.phase}:${run.pass}:${run.sendBacks}:${run.approved}:${run.team.review}:${state.team.review}` : `none:${state.team.review}`
    if (!force && key === reviewKey) return
    reviewKey = key
    reviewButtons = null
    const quiet = (shape, big, text, ...more) => el('div', { class: 'rv-quiet' },
      el('div', { class: `rv-shape ${shape}`, 'aria-hidden': 'true' }, el('i')),
      el('p', { class: 'big', text: big }), text ? el('p', { text }) : null, ...more)

    if (!run) {
      // One control per thing: the work starts from the chat's box, and a review step is added in the sentence.
      reviewBody.replaceChildren(state.team.review
        ? quiet('', 'Nothing to review yet.', 'Write to the team in Ask, above. When Researcher hands over, the work stops here, in the chat, and waits for you.')
        : quiet('warn', 'This team has no review step.', "Researcher's findings would go straight to Writer, unchecked.",
          el('a', { class: 'link', href: '#build', style: 'display:inline-block;margin-top:16px', text: 'Add one in the team sentence ↑' })))
      return
    }
    if (run.only) {
      reviewBody.replaceChildren(quiet('done', 'Nothing waits for you on this piece.', 'You asked Writer alone, after your review. Its new version comes straight back to you in the chat.'))
      return
    }
    if (!run.team.review) {
      const flagged = run.findings.findIndex((f) => !f.src)
      const done = run.phase === 'done'
      reviewBody.replaceChildren(quiet('warn', 'Nothing waited for you this time.',
        done ? `This team had no review step, so Writer used everything Researcher found, including claim ${flagged + 1}, which has no source.`
          : "This team has no review step, so Researcher's findings go straight to Writer, unchecked.",
        state.team.review
          ? el('p', { text: 'The review step is on the team now. @team again, and the work stops here.' })
          : el('a', { class: 'link', href: '#build', style: 'display:inline-block;margin-top:16px', text: 'Add one in the team sentence ↑' })))
      return
    }
    if (run.phase === 'review') {
      const handed = run.chat.filter((c) => c.kind === 'handover' && c.to === 'you').at(-1)
      const flaggedIndex = run.findings.findIndex((f) => !f.src && !f.dropped)
      const list = el('ol', {}, run.findings.map((f) => {
        if (f.dropped) return el('li', {}, el('span', { class: 'dropped', text: f.text }), el('span', { class: 'src fixed', text: 'dropped' }))
        return el('li', {}, f.text, el('span', { class: `src${f.src ? (f.fixed ? ' fixed' : '') : ' missing'}`, text: f.src || 'no source' }))
      }))
      const fixedOne = run.findings.find((f) => f.fixed || f.dropped)
      const flag = flaggedIndex >= 0
        ? el('p', { class: 'rv-flag' }, el('b', { text: `Claim ${flaggedIndex + 1} has no source.` }), ' Approve it as it is, or send it back with a note.')
        : el('p', { class: 'rv-flag good' }, el('b', { text: fixedOne?.dropped ? `Claim ${run.findings.indexOf(fixedOne) + 1} is gone.` : 'Every claim has a source now.' }), fixedOne?.dropped ? ` Researcher dropped it: ${fixedOne.why}.` : ' Approve to hand the findings to Writer.')
      const go = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => decide('approve') })
      const back = el('button', { type: 'button', class: 'btn', text: 'Send back to Researcher', onclick: () => decide('send') })
      const tip = el('p', { class: 'tc-tip', text: 'To send it back, write what to change in the box below.' })
      reviewButtons = { go, back, tip }
      labelReview()
      reviewBody.replaceChildren(el('div', { class: 'tc-msg m-researcher rv-msg' },
        avatar('researcher'),
        el('div', { class: 'tc-main' },
          el('div', { class: 'tc-meta' }, el('b', { text: 'Researcher' }), el('span', { class: 'tc-to', text: '→ You · handover' }), el('time', { text: clockText(handed ? handed.t : run.clock) })),
          el('div', { class: 'tc-bubble' },
            el('p', { class: 'rv-q', text: run.pass === 1 ? 'Here’s what I found, for your review.' : 'I made your change. Here it is again.' }),
            el('div', { class: 'rv-box' }, el('span', { class: 'micro', text: 'findings.md' }), list),
            flag),
          el('div', { class: 'tc-turn', role: 'group', 'aria-label': "Review Researcher's work" }, el('div', { class: 'rv-acts' }, back, go), tip))))
      return
    }
    if (!run.approved) {
      reviewBody.replaceChildren(quiet('live', run.sendBacks ? 'Researcher is making your change.' : 'Researcher is still working.',
        run.sendBacks ? 'When it hands over again, its new findings wait here, in the chat, for you.' : "When it hands over, the work stops here and waits for you, with exactly what it found and where it came from."))
      return
    }
    const note = run.notes.filter((n) => n.kind === 'approve').at(-1)
    const flaggedLeft = run.findings.some((f) => !f.src && !f.dropped)
    reviewBody.replaceChildren(
      msg({ from: 'you', meta: 'You', to: run.sendBacks ? `approved Researcher's work, after ${run.sendBacks === 1 ? 'one send-back' : `${run.sendBacks} send-backs`}` : "approved Researcher's work", time: clockText(run.approvedAt ?? run.clock), body: note ? [el('p', { text: note.text })] : null }),
      quiet(run.phase === 'done' ? 'done' : 'gold',
        run.phase === 'done' ? 'Writer has answered.' : 'Writer is writing.',
        run.phase === 'done'
          ? (flaggedLeft ? 'The answer is below. Its receipt flags the claim you let through, so it stays worth a look.' : 'The answer is below, built only on findings you checked.')
          : 'It writes the answer from the findings you approved.'))
  }

  /* ---------------- 07 · Result: the answer in the chat, its record in Details */

  const resultBody = $('#result-body')
  let resultKey = ''
  const keptOf = (r) => { const kept = r.findings.filter((f) => !f.dropped); return r.only ? kept.slice(0, 3) : kept }
  // Your words that shaped the answer: team notes it read, your note on approving, notes to Writer.
  function writtenWith(r) {
    const texts = [
      ...r.carried.map((n) => n.text),
      ...r.notes.filter((n) => n.kind === 'approve').map((n) => n.text),
      ...r.told.filter((n) => n.to === 'writer' && n.takenAt !== null).map((n) => n.text),
    ]
    return texts.length ? `Written with your ${texts.length === 1 ? 'note' : 'notes'}: ${texts.map((t) => `“${t}”`).join(' · ')}` : null
  }
  function receiptRows(r) {
    const kept = keptOf(r)
    const flagged = r.findings.map((f, i) => ({ ...f, i })).filter((f) => !f.src && !f.dropped && kept.some((k) => k.text === f.text))
    const rows = []
    if (r.only) {
      rows.push(['Asked', `“${FOLLOW.text}”`], ['Team', 'Writer only'], ['Ran on', `${app(r.team.writer).name} · your own account`], ['Took', clockText(r.clock)],
        ['Read first', `the conversation so far: your request, ${r.team.review ? 'the findings you approved' : "Researcher's findings"}, and its last answer`],
        ['Kept', "Researcher's findings, as they were"])
    } else {
      const apps = [...new Set(['researcher', 'writer'].map((w) => app(r.team[w]).name))]
      const call = !r.team.review ? 'No review step on this team'
        : r.sendBacks ? `Sent back ${r.sendBacks === 1 ? 'once' : `${r.sendBacks} times`}, then approved` : r.notes.length ? 'Approved, with a note' : 'Approved'
      rows.push(['Asked', `“${r.preset.short}”`], ['Team', seq(r.team).map((w) => LANE[w]).join(' → ')], ['Ran on', `${listText(apps)} · your own accounts`], ['Took', clockText(r.clock)])
      const handed = GIVEN_TO.filter((w) => r.give[w].length).map((w) => `${LANE[w]}: ${r.give[w].map((id) => source(id).name).join(', ')}`)
      rows.push(['Handed over', handed.length ? handed.join(' · ') : 'nothing'])
      if (r.permission) rows.push(['Asked you', `Researcher wanted the web · ${r.permission === 'deny' ? 'you said no' : r.permission === 'always' ? 'allowed from now on' : 'allowed once'}`])
      if (r.team.review || r.permission) rows.push(['Waited on you', waitText(r.waitedMs)])
      rows.push(['Your call', call])
    }
    if (r.carried.length) rows.push(['From the chat', r.carried.map((n) => `“${n.text}”`).join(' · ')])
    if (r.told.length) rows.push(['Your notes', r.told.map((n) => `“${n.text}” to ${LANE[n.to]}, ${n.takenAt === null ? 'not taken before the end' : n.now ? 'which stopped its step for it' : 'taken in its next turn'}`).join(' · ')])
    if (!r.only) rows.push(['Researcher', `${r.findings.filter((f) => !f.dropped).length} findings · ${r.tools.researcher} tool call${r.tools.researcher === 1 ? '' : 's'}`])
    rows.push(['Writer', `${r.only ? 'rewrote' : 'wrote'} ${r.preset.file}`])
    const worth = [
      ...flagged.slice(0, 1).map((f) => `claim ${f.i + 1} has no source.`),
      ...(!r.only && r.deniedWeb ? ['Researcher wasn’t allowed to search the web, so check where its claims came from.'] : []),
    ]
    return { rows, flagged, worth }
  }
  function receiptMarkdown(r) {
    const { rows, worth } = receiptRows(r)
    return [
      `**Run receipt · Run ${r.n} · Answered**`,
      '',
      ...rows.map(([k, v]) => `- **${k}:** ${v}`),
      '',
      worth.length ? `**Worth a look:** ${worth.join(' ')}` : '**Worth a look:** nothing flagged.',
      '',
      '_Simulated on the LoomWatch landing page. No model was called._',
    ].join('\n')
  }
  const introOf = (r) => (r.only ? FOLLOW.intro : r.preset.intro(keptOf(r).length, r.findings.every((f) => f.src || f.dropped), r.team.review))
  function answerMarkdown(r) {
    return [`# ${r.preset.title2}`, '', introOf(r), '', ...keptOf(r).map((f) => `- ${f.text}${f.src ? ` (${f.src})` : ''}`), '',
      '_Simulated on the LoomWatch landing page. No model was called._'].join('\n')
  }
  // The answer as Writer posts it: in full, or as a document card once newer work follows it.
  function answerMsg(r, folded) {
    const items = keptOf(r)
    const tag = r.team.review ? 'no source · approved as it was' : 'no source · nobody checked'
    const written = writtenWith(r)
    const body = folded
      ? el('div', { class: 'ans-doc' }, el('b', { text: r.preset.title2 }), el('span', { text: introOf(r) }), el('span', { class: 'm', text: `${items.length} items · ${r.preset.file}` }))
      : el('div', { class: 'reader' },
        el('h3', { text: r.preset.title2 }),
        el('p', { class: 'intro', text: introOf(r) }),
        el('ul', {}, items.map((f) => el('li', { class: f.src ? '' : 'unchecked' }, f.text, el('span', { class: `src${f.src ? '' : ' missing'}`, text: f.src || tag })))),
        written ? el('p', { class: 'written', text: written }) : null,
        el('div', { class: 'filecard' },
          el('span', { class: 'ico', 'aria-hidden': 'true', text: r.preset.file.split('.').pop().toUpperCase() }),
          el('span', {}, el('div', { class: 'fn', text: r.preset.file }), el('div', { class: 'fm', text: `${r.preset.kind} · changed just now · Research and write › Writer` })),
          el('span', { class: 'acts', 'aria-hidden': 'true' }, el('span', { text: 'Open' }), el('span', { text: 'Show in folder' }))))
    return el('div', { class: `tc-msg m-writer ans-msg${folded ? ' folded' : ''}` },
      avatar('writer'),
      el('div', { class: 'tc-main' },
        el('div', { class: 'tc-meta' }, el('b', { text: 'Writer' }), el('span', { class: 'tc-to', text: r.only ? 'to you' : "the team's answer" }), el('time', { text: `took ${clockText(r.clock)}` })),
        el('div', { class: 'tc-bubble' }, body),
        folded ? null : answerTools(r)))
  }
  function answerTools(r) {
    const { worth } = receiptRows(r)
    const said = el('span', { class: 'copied', 'aria-live': 'polite' })
    const flash = (text) => { said.textContent = text; window.setTimeout(() => { said.textContent = '' }, 1800) }
    return el('div', { class: 'ans-tools' },
      el('button', { type: 'button', class: `verdict ${worth.length ? 'warn' : 'ok'}`, text: worth.length ? `${worth.length} thing to check` : 'Nothing flagged', onclick: () => {
        const line = $('.slip .worth', resultBody)
        if (!line) return
        line.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
        line.classList.remove('flash'); void line.offsetWidth; line.classList.add('flash')
      } }),
      el('button', { type: 'button', class: 'tbtn', text: 'Copy', onclick: async () => {
        try { await navigator.clipboard.writeText(answerMarkdown(r)); flash('Copied') } catch { flash('Copy failed') }
      } }),
      el('button', { type: 'button', class: 'tbtn', text: 'Download', title: `Save the answer as ${r.preset.file.replace(/\.\w+$/, '')}.md`, onclick: () => {
        const link = el('a', { href: URL.createObjectURL(new Blob([answerMarkdown(r)], { type: 'text/markdown' })), download: `${r.preset.file.replace(/\.\w+$/, '')}.md` })
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      } }),
      said)
  }
  function renderResult(force = false) {
    // Writer's stage is in the key: the panel says who is working, and that changes when Writer starts.
    const key = run ? `${run.n}:${run.phase}:${run.approved}:${run.sendBacks}:${run.stages.writer}` : 'none'
    if (!force && key === resultKey) return
    resultKey = key
    const base = run && run.only ? run.prev : run
    $('#result-file').textContent = run ? run.preset.file : preset(state.request).file
    const empty = (big, text, ...more) => el('div', { class: 'res-empty' }, el('p', { class: 'big', text: big }), el('p', { text }), ...more)
    if (!base) { resultBody.replaceChildren(empty('Nothing to read yet.', 'Write to the team, and its answer lands in the chat with a receipt.')); return }
    if (base.phase === 'review') {
      resultBody.replaceChildren(empty('The team is waiting for you.', 'Nothing gets written past the review step until you decide.',
        el('a', { class: 'link', href: '#review', style: 'display:inline-block;margin-top:14px', text: 'Go to the review ↑' })))
      return
    }
    if (base.phase !== 'done') {
      const who = base.stages.writer === 'running' ? 'Writer is writing' : 'Researcher is working'
      resultBody.replaceChildren(empty('Not finished yet.', `${who}. The answer appears here, in the chat, when Writer replies.`))
      return
    }
    const thread = el('div', { class: 'res-chat' }, answerMsg(base, Boolean(run.only)))
    if (run.only) {
      thread.append(
        msg({ from: 'you', meta: 'You', to: '→ Writer', body: [el('p', {}, ...withMention(run.asked))] }),
        el('div', { class: 'piece-line' }, weft(run), run.phase === 'done' ? el('span', { text: worked(run) }) : el('span', {}, el('b', { text: 'Writer' }), ' is working', dots())))
      if (run.phase === 'done') thread.append(answerMsg(run, false))
    }
    const shown = run.phase === 'done' ? run : base
    const { rows, worth } = receiptRows(shown)
    const slip = el('div', { class: 'slip-wrap' }, el('div', { class: 'slip' },
      el('div', { class: 'head' }, el('span', { text: `Run receipt · Run ${shown.n}` }), el('span', { text: 'Answered' })),
      el('dl', {}, rows.map(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]).flat()),
      el('div', { class: 'worth' }, el('b', { text: 'Worth a look: ' }), worth.length ? el('span', { class: 'bad', text: worth.join(' ') }) : 'nothing flagged.'),
      el('div', { class: 'slip-foot', text: 'Simulated in your browser · no model was called' })))
    const copied = el('span', { class: 'copied', 'aria-live': 'polite' })
    const acts = el('div', { class: 'res-acts' },
      el('button', { type: 'button', class: 'btn', text: 'Copy receipt', onclick: async () => {
        try { await navigator.clipboard.writeText(receiptMarkdown(shown)); copied.textContent = 'Copied' } catch { copied.textContent = 'Copy failed' }
        window.setTimeout(() => { copied.textContent = '' }, 1800)
      } }),
      el('a', { class: 'link', href: '#watch', style: 'font-size:13px', text: 'Replay the timeline ↑' }),
      copied)
    resultBody.replaceChildren(el('div', { class: 'result-grid' }, thread,
      el('section', { class: 'res-details', 'aria-label': 'Details' }, el('span', { class: 'micro', text: 'Details · how it was made' }), slip, acts)))
  }

  /* ================================================================ 07 · Tomorrow */

  // The team's answer as a morning paper. Issues are numbered, never dated, so the page doesn't go
  // stale, and flipping back through the pile shows the paper getting better as the Notebook fills.
  const HEADLINES = [
    ['A new open-weight coding model tops a public benchmark', 'Its weights are public, and the licence allows commercial use.'],
    ['Two browser makers ship on-device AI features', 'Most of them work without a connection.'],
    ['A chip export rule changes next month', 'Two more product lines will need a licence.'],
    ['An open agent protocol adds a way to resume a session', 'Apps can pick a conversation up where it stopped.'],
    ['A lab publishes its safety evaluations', 'Outside testers had four weeks of access.'],
    ['Regulators open a consultation on AI labels', 'Comments are open for sixty days.'],
    ['A coding agent ships a team mode', 'Several agents can now share one repository.'],
    ['Data centre power deals keep growing', 'Utilities report record long-term contracts.'],
    ['A translation model adds forty languages', 'Quality is uneven for less common languages.'],
    ['Universities update their AI coursework rules', 'Most now ask students to say when they used it.'],
  ]
  const ISSUES = [
    { items: 10, when: '10:00 → 10:06', tag: 'A schedule', story: 'The first scheduled issue. Collector, Editor and Writer were done by 10:06, and it was waiting in Notion.' },
    { items: 10, when: '10:00 → 10:05', story: 'An ordinary morning. The issue arrived, and nothing needed you.' },
    { items: 7, when: '10:00 → 10:05 · 10:31', tag: '@Writer', note: ['You, 10:24', '@Writer Shorter, please.'], stamp: ['ok', 'Second pass 10:31'], story: 'You read it over coffee and wrote <span class="q">“@Writer Shorter, please.”</span> in the team’s chat. Writer alone did one more pass on the same issue, back at 10:31. Nobody started over.' },
    { items: 7, when: '10:00 → 10:02 · 10:40', stopped: true, tag: 'Try again', stamp: ['bad', 'First run stopped 10:02', 'Redone 10:40'], story: "Collector couldn't open one of its sources, and the work stopped and said why, right in the chat. You pressed Try again, and the reprint was ready at 10:40." },
    { items: 5, when: '10:00 → 10:05', tag: 'Notebook', note: ['Notebook', 'Five items, not ten.'], story: 'You added a line to the team’s Notebook: <span class="q">“Five items, not ten.”</span> Every issue since has read it before starting.' },
    { items: 5, when: '10:00 → 10:04', story: 'Five items, not ten. It remembered without being told again.' },
    { items: 5, when: '10:00 → 10:05', tag: 'Swap a thread', foot: 'Edited on a newer app', story: 'A newer app was better at editing, so you moved Editor to it. One change in the sentence. The team, its Brief and its Notebook stayed as they were.' },
    { items: 5, when: '10:00 → 10:04', tag: 'Share a source', foot: 'Sources + market-reports', story: 'You dragged market-reports onto Editor too. One card, two threads: Collector and Editor read the same folder, and neither can change it.' },
    { items: 5, when: '10:00 → 18:40', tag: 'A review step waits', stamp: ['wait', 'Held for your review', 'Approved 18:40'], story: "Editor flagged a claim it couldn't confirm, and the review waited in the chat until you were back. You approved at 18:40, and it went out then, not before." },
    { items: 5, when: '10:00 → 10:05', tag: 'Saved job', foot: 'Editor also edits a second team', story: 'You saved Editor as a job, with its instructions, app and skills, and added it to a second team.' },
    { items: 5, when: '10:00 → 10:04', story: 'Most mornings now need nothing from you. That was the point.' },
    { items: 5, when: '10:00 → 10:05', tag: 'Replay any morning', story: 'Every issue stays in the team’s chat with the work that made it, so you can open any morning’s Details and drag back through its timeline.' },
    { items: 5, when: '10:00 → 10:05', story: 'Ready at 10:05. Every issue so far is on the pile, the stopped one included.' },
    { items: 5, when: '10:00 → now', live: true, tag: 'Writing now', stamp: ['live', 'Writing now'], story: "Today's issue is being written. Collector is reading, and it will be on the pile before you sit down." },
  ]
  const pile = $('#pile')
  const dayStory = $('#day-story')
  const today = ISSUES.length - 1
  const readyAt = (issue) => issue.when.split(/→|·/).at(-1).trim()
  // Waiting by 10:10: the first run's answer, unless that run stopped.
  const onTime = (issue) => !issue.live && !issue.stopped && issue.when.split('·')[0].split('→')[1].trim() <= '10:10'
  let issueAt = today
  let playing = 0
  let sorting = false
  let hovered = null
  let cardEls = []
  const pileTag = el('div', { class: 'pile-tag', 'aria-hidden': 'true', hidden: true })

  function issueCard(issue, i) {
    const items = issue.live
      ? [72, 90, 64, 84, 58].map((w) => el('li', { class: 'bar', style: `width:${w}%` }))
      : Array.from({ length: issue.items }, (_, k) => {
        const [head, sub] = HEADLINES[(k + i * 3) % HEADLINES.length]
        return el('li', {}, el('span', {}, head, issue.items <= 5 ? el('small', { text: sub }) : null))
      })
    return el('article', { class: 'issue', 'aria-hidden': 'true', 'data-i': String(i) },
      el('div', { class: 'mast' }, el('b', { text: 'AI and tech, today' }), el('span', { text: `No. ${i + 1}` })),
      el('div', { class: 'sub' }, el('span', { text: `${issue.items} items` }), el('span', { text: issue.live ? 'writing…' : `ready ${readyAt(issue)}` })),
      el('ol', { class: issue.live ? 'writing' : '' }, items),
      issue.stamp ? el('div', { class: `stamp ${issue.stamp[0]}` }, issue.stamp.slice(1).flatMap((line, n) => (n ? [el('br'), line] : [line]))) : null,
      issue.note ? el('div', { class: 'note' }, el('small', { text: issue.note[0] }), issue.note[1]) : null,
      el('div', { class: 'colophon' }, el('span', { text: 'Collector · Editor · You · Writer' }), el('span', { text: issue.foot || 'to Notion' })))
  }
  // The pile is a deck you sort. The chosen issue is on top and every other one is behind it in
  // order, older first and round again to the newest, with their edges fanned out so each can be
  // found by pointing at it: to the left on a wide screen, upward on a narrow one, where a phone has
  // room. Taking the top paper puts it at the bottom; taking one from behind pulls it out and lays
  // it on top.
  const FAN = { dx: 12, dy: 2, turn: 0.6, up: 9 }
  const narrow = () => window.matchMedia('(max-width: 900px)').matches
  const slotOf = (i) => (issueAt - i + ISSUES.length) % ISSUES.length
  function pose(slot, out = 0) {
    if (narrow()) {
      if (slot === 0) return out ? `translate(0, ${-out * 0.4}px)` : 'none'
      return `translate(0, ${-slot * FAN.up - out}px) rotate(${slot % 2 ? 0.4 : -0.4}deg)`
    }
    if (slot === 0) return out ? `translate(0, ${-out * 0.25}px)` : 'none'
    return `translate(${-slot * FAN.dx - out}px, ${slot * FAN.dy - out * 0.3}px) rotate(${-slot * FAN.turn}deg) scale(${1 - slot * 0.01})`
  }
  function layPile(except = null) {
    const lift = narrow() ? 12 : 22
    cardEls.forEach((card, i) => {
      if (card === except) return
      const slot = slotOf(i)
      card.classList.toggle('front', slot === 0)
      card.style.zIndex = String(100 - slot)
      card.style.transform = pose(slot, card === hovered ? lift : 0)
      card.style.filter = slot ? `brightness(${card === hovered ? 1 : 1 - slot * 0.03})` : 'none'
    })
  }
  // Which paper is under a point, worked out from where the point is along the fan rather than from
  // what is drawn there, so drawing one paper out never hides the next one from the pointer.
  function paperAt(x, y) {
    const front = cardEls[issueAt]
    const box = pile.getBoundingClientRect()
    const left = box.left + front.offsetLeft
    const top = box.top + front.offsetTop
    const W = front.offsetWidth
    const H = front.offsetHeight
    let slot
    if (narrow()) {
      if (x < left || x > left + W || y > top + H) return null
      slot = y >= top ? 0 : Math.ceil((top - y) / FAN.up)
    } else {
      if (y < top - 24 || y > top + H + 24 || x > left + W) return null
      slot = x >= left ? 0 : Math.ceil((left - x) / FAN.dx)
    }
    return slot < ISSUES.length ? cardEls[(issueAt - slot + ISSUES.length) % ISSUES.length] : null
  }
  function renderStory() {
    const issue = ISSUES[issueAt]
    const story = el('p')
    story.innerHTML = issue.story
    dayStory.replaceChildren(el('span', { class: 'when' }, el('b', { text: issue.tag || 'On time' }), `No. ${issueAt + 1} · ${issue.when}`), story)
    pile.setAttribute('aria-label', `Issue ${issueAt + 1} of ${ISSUES.length} on top${issue.tag ? `: ${issue.tag}` : ''}. The left arrow puts the top paper at the bottom; the right arrow brings the bottom one up.`)
    const done = ISSUES.slice(0, issueAt + 1).filter((x) => !x.live)
    const n = done.filter(onTime).length
    $('#issue-count').textContent = done.length ? `${n} of ${done.length} ${done.length === 1 ? 'issue was' : 'issues were'} waiting by 10:10.` : ''
  }
  function renderPaper() {
    if (!cardEls.length) { cardEls = ISSUES.map(issueCard); pile.append(...cardEls, pileTag) }
    layPile()
    renderStory()
  }
  // Sorting. Down: the top paper lifts off and is tucked under the pile while the rest move up. Up:
  // a paper is drawn out, then laid on top while the ones above it sink. On a narrow screen both
  // move up and down, so nothing slides off the side of a phone.
  function sortTo(next, how) {
    if (sorting || next === issueAt) return
    sorting = true
    clearHover()
    const W = cardEls[issueAt].offsetWidth
    const mover = how === 'down' ? cardEls[issueAt] : cardEls[next]
    issueAt = next
    renderStory()
    layPile(mover)
    mover.style.transition = `transform ${reduced ? 1 : 230}ms var(--ease), filter .3s var(--ease)`
    mover.style.transform = narrow()
      ? (how === 'down' ? 'translate(0, -46px) rotate(-1.5deg)' : `translate(0, ${-(ISSUES.length * FAN.up + 24)}px) rotate(1.5deg)`)
      : (how === 'down' ? `translate(${W * 0.38}px, -26px) rotate(6deg)` : `translate(${-W * 0.42}px, -26px) rotate(-7deg)`)
    mover.style.filter = 'none'
    if (how === 'down') mover.style.zIndex = '150' // over the new top paper until it is tucked under
    window.setTimeout(() => {
      mover.style.transition = ''
      layPile()
      window.setTimeout(() => { sorting = false }, reduced ? 0 : 430)
    }, reduced ? 0 : 230)
  }
  const older = () => (issueAt + ISSUES.length - 1) % ISSUES.length
  const newer = () => (issueAt + 1) % ISSUES.length
  function stopPlaying() {
    window.clearInterval(playing)
    playing = 0
    $('#issue-play').textContent = 'Read the first two weeks'
  }

  // Pointing at a paper shows which issue it is; one behind the top is drawn out a little. A mouse
  // does it by hovering, a finger by sliding along the papers.
  function clearHover() {
    pileTag.hidden = true
    if (!hovered) return
    hovered = null
    layPile()
  }
  function point(card, event, touch) {
    const behind = card === cardEls[issueAt] ? null : card
    if (behind !== hovered) { hovered = behind; layPile() }
    const i = Number(card.dataset.i)
    const note = behind ? ISSUES[i].tag || (ISSUES[i].live ? 'Today' : 'On time') : touch ? 'Tap to put it at the bottom' : 'Click to put it at the bottom'
    pileTag.replaceChildren(el('b', { text: `No. ${i + 1}` }), el('span', { text: note }))
    const box = pile.getBoundingClientRect()
    pileTag.style.left = `${Math.min(box.width - 80, Math.max(80, event.clientX - box.left))}px`
    pileTag.style.top = `${event.clientY - box.top - (touch ? 26 : 0)}px`
    pileTag.hidden = false
  }
  let touch = null
  let touchedAt = 0
  pile.addEventListener('pointerdown', (event) => {
    event.preventDefault() // pressing never selects the words
    if (event.pointerType !== 'touch' || sorting) return
    const card = paperAt(event.clientX, event.clientY)
    if (!card) return
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY, front: card === cardEls[issueAt] }
    if (!touch.front) point(card, event, true)
  })
  pile.addEventListener('pointermove', (event) => {
    if (touch && event.pointerId === touch.id) {
      if (touch.front) return
      const card = paperAt(event.clientX, event.clientY)
      if (card) point(card, event, true)
      return
    }
    if (sorting || event.pointerType === 'touch') return
    const card = paperAt(event.clientX, event.clientY)
    if (card) point(card, event, false)
    else clearHover()
  })
  pile.addEventListener('pointerup', (event) => {
    if (!touch || event.pointerId !== touch.id) return
    const t = touch
    touch = null
    const dx = event.clientX - t.x
    const dy = event.clientY - t.y
    if (t.front) {
      // A swipe sorts the top paper either way; a tap is left to the click below.
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { touchedAt = performance.now(); stopPlaying(); sortTo(dx < 0 ? older() : newer(), dx < 0 ? 'down' : 'up') }
      return
    }
    // Letting go on a paper behind lays it on top.
    const pick = hovered
    clearHover()
    touchedAt = performance.now()
    if (pick) { stopPlaying(); sortTo(Number(pick.dataset.i), 'up') }
  })
  pile.addEventListener('pointercancel', () => { touch = null; clearHover() })
  pile.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch') clearHover() })
  pile.addEventListener('click', (event) => {
    if (sorting || performance.now() - touchedAt < 500) return
    const card = paperAt(event.clientX, event.clientY) || hovered || event.target.closest?.('.issue')
    if (!card) return
    stopPlaying()
    const i = Number(card.dataset.i)
    if (i === issueAt) sortTo(older(), 'down')
    else sortTo(i, 'up')
  })
  pile.addEventListener('keydown', (event) => {
    const how = { ArrowLeft: 'down', ArrowRight: 'up' }[event.key]
    if (!how) return
    event.preventDefault()
    stopPlaying()
    sortTo(how === 'down' ? older() : newer(), how)
  })
  $('#issue-play').addEventListener('click', () => {
    if (playing) { stopPlaying(); return }
    sortTo(0, 'up')
    $('#issue-play').textContent = 'Stop'
    playing = window.setInterval(() => { if (issueAt >= today) stopPlaying(); else sortTo(newer(), 'up') }, reduced ? 2200 : 1400)
  })
  window.addEventListener('resize', () => layPile())

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
    home: { w: 2880, h: 1600, alt: 'LoomWatch Home: the headline Put AI agents to work as a team, a New team button, a box to describe the job in plain words, three steps, and the teams as cards with their recent runs drawn as threads.', cap: 'Home: your teams, each with its recent runs drawn as threads, and the one gold button that starts a new one.' },
    build: { w: 2880, h: 1800, alt: 'LoomWatch Build: the team as one sentence across the top, a Hire by job palette on the left, and agent cards wired left to right on a dotted canvas, with a folder, a file and a shared skill wired in beneath the agents that use them.', cap: 'Build: the team as one sentence across the top, Hire by job on the left, and under each agent the folder, file and skill it was handed.' },
    chat: { w: 2880, h: 1800, alt: "LoomWatch Chat for a market brief team: on the left, Researcher's handover to you, your approval with a note for Writer, and the team's answer as a document card marked Nothing flagged, with Copy and Share and the message box below; on the right, the brief open in full under an Answer tab beside Details.", cap: 'Chat: the handover, your review and the answer, marked Nothing flagged, with the brief open beside the chat. Details is one tab away.' },
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

  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const target = entry.target
        target.classList.add('seen')
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
  renderChatUI(true)
  renderPaper()
  renderSwatch()
  showScreen('home')
  paintProgress()
})()

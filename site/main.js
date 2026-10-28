// LoomWatch landing page, in the app's three acts. The visitor builds an agent and tries it on its
// own, puts agents in a team, then works with the team in its chat: @ it with a job, write to it
// while it works, review, read the answer, @ one agent for another pass. No dependencies, no network calls, and the static page stays readable without it.
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

  // The models an agent can think with, a few of the many on OpenRouter, as the app's model picker
  // recommends them: one key reaches all of them.
  const MODELS = [
    { id: 'sonnet', name: 'Claude Sonnet 5.5', openrouter: 'anthropic/claude-sonnet-5.5' },
    { id: 'opus', name: 'Claude Opus 5.5', openrouter: 'anthropic/claude-opus-5.5' },
    { id: 'gpt', name: 'GPT-6.1 Sol', openrouter: 'openai/gpt-6.1-sol' },
  ]
  const modelOf = (id) => MODELS.find((m) => m.id === id) || MODELS[0]

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
  // the team, a skill and a Notion page. One card can thread to several agents.
  const SOURCES = [
    { id: 'reports', kind: 'folder', name: 'market-reports/', meta: 'Linked folder', arrives: 'its listing and README', path: '~/Documents/market-reports', reads: 'read · market-reports/README.md' },
    { id: 'brand', kind: 'file', name: 'brand-guide.pdf', meta: 'Added file', arrives: 'its text, all 12 pages', path: 'research-and-write.files/brand-guide.pdf', reads: 'read · brand-guide.pdf' },
    { id: 'style', kind: 'skill', name: 'house-style', meta: 'Skill · from skills.sh', arrives: 'its instructions, required', reads: 'skill · house-style/SKILL.md' },
    { id: 'notes', kind: 'notion', name: 'Team notes', meta: 'Notion page', arrives: 'its text, read at the start', page: '1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6', reads: 'notion · Team notes' },
  ]
  const source = (id) => SOURCES.find((x) => x.id === id)
  const GIVEN_TO = ['researcher', 'writer']
  const ALLOW = [
    { key: 'web', label: 'Search the web' },
    { key: 'edits', label: 'Edit files' },
    { key: 'commands', label: 'Run commands' },
  ]

  const state = {
    models: ['sonnet', 'opus', 'gpt'],
    team: { researcher: 'sonnet', writer: 'opus', review: true },
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
    $$('img[data-shot]').forEach((img) => { img.src = `assets/app/${img.dataset.shot}-${mode}.webp` })
  }
  function applyTheme(theme) {
    root.dataset.theme = theme
    themeButton.setAttribute('aria-label', theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme')
    $('#cord-tag').lastChild.textContent = theme === 'dark' ? ' to turn the light on' : ' to turn the light off'
    $('meta[name="theme-color"]').content = theme === 'dark' ? '#08080A' : '#FAF8F3'
    paintShots()
  }
  // The theme is a lamp (the button is its bulb, and it has a pull cord, below): switched, the new
  // theme spreads out from the bulb across the page, as a room fills when a lamp comes on.
  function switchTheme() {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    store.set('loomwatch-site-theme', next)
    if (reduced || !document.startViewTransition) { applyTheme(next); return }
    const bulb = themeButton.getBoundingClientRect()
    const x = bulb.left + bulb.width / 2
    const y = bulb.top + bulb.height / 2
    const reach = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
    document.startViewTransition(() => applyTheme(next)).ready.then(() => {
      root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${reach}px at ${x}px ${y}px)`] }, { duration: 640, easing: 'cubic-bezier(.3, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' })
    }, () => { /* skipped by the next switch */ })
  }

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
  }
  window.addEventListener('scroll', () => { if (!progressQueued) { progressQueued = true; window.requestAnimationFrame(paintProgress) } }, { passive: true })

  /* ================================================================ Live figures */

  // The figures are the app's own (ui/src/site/landingLive.ts, built into assets/live/live.js with
  // three.js): the crew on the first screen and the agent's bench in Step 1. The module loads only
  // where the browser has WebGL; everywhere else, and where a scene can't make its WebGL context,
  // the still pictures under the canvases stay, and the page works. No canvas is made to find out:
  // the first WebGL context a page makes can take a second, and it would come before the first paint.
  const canDraw = 'WebGLRenderingContext' in window
  const MODEL = 'assets/live/workbench.glb'
  let live = null
  let model = null
  // The model comes down alongside the code, once for all three scenes.
  const loadModel = () => {
    if (!model) {
      model = fetch(MODEL).then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(`${MODEL}: ${response.status}`))))
      model.catch(() => {})
    }
    return model
  }
  const loadLive = () => {
    if (canDraw) loadModel()
    return (live ||= canDraw ? import('./assets/live/live.js') : Promise.reject(new Error('WebGL is off')))
  }
  // What a scene is built from: the model's bytes. A live.js cached from before readModel, for ten
  // minutes after a deploy, takes only its URL and fetches it itself.
  const modelFor = (scenes) => (scenes.readModel ? loadModel() : MODEL)
  // Two frames along: in a task of its own, after what was asked of the screen before it.
  const nextPaint = () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
  // The figures' work on the GPU (their WebGL contexts, then their shaders) starts once the crew's
  // picture is on the screen, so the first screen paints without waiting for it.
  const crewPoster = $('.crew-poster')
  const painted = Promise.resolve(crewPoster?.decode?.()).catch(() => {}).then(nextPaint)

  // Draw a stage only while it can be seen, and size its canvas to it.
  function stageOf(box, scene, onResize) {
    let seen = false
    const sync = () => { if (seen && document.visibilityState === 'visible') scene.start(); else scene.stop() }
    new ResizeObserver(([entry]) => { if (entry) { scene.resize(entry.contentRect.width, entry.contentRect.height); onResize?.() } }).observe(box)
    new IntersectionObserver(([entry]) => { seen = Boolean(entry?.isIntersecting); sync() }).observe(box)
    document.addEventListener('visibilitychange', sync)
  }
  const local = (event, canvas) => { const r = canvas.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top] }
  // A label centred on a point of the picture, kept inside its stage so none runs off an edge.
  // Returns where its centre went.
  function placeTag(tag, at, stage) {
    const half = tag.offsetWidth / 2
    const x = clamp(at.x, half + 6, Math.max(half + 6, stage.clientWidth - half - 6))
    tag.style.transform = `translate(${x.toFixed(1)}px, ${at.y.toFixed(1)}px)`
    return x
  }

  /* ================================================================ The crew */

  // Six agents, each in its own figure. Point at one and it waves; pick one to build one like it.
  const CREW = [
    { id: 'scout', name: 'Scout', does: 'finds sources', job: 'sources', figure: { kind: 'yarn', color: 'clay' } },
    { id: 'writer', name: 'Writer', does: 'writes the brief', job: 'brief', figure: { kind: 'spool', color: 'sky' } },
    { id: 'editor', name: 'Editor', does: 'tightens every line', job: 'brief', figure: { kind: 'button', color: 'butter' } },
    { id: 'checker', name: 'Checker', does: 'checks each claim', job: 'check', figure: { kind: 'thimble', color: 'sage' } },
    { id: 'researcher', name: 'Researcher', does: 'digs into one question', job: 'sources', figure: { kind: 'pincushion', color: 'rose' } },
    { id: 'planner', name: 'Planner', does: 'splits the job up', job: 'check', figure: { kind: 'cone', color: 'lilac' } },
  ]
  const crewBox = $('#crew')
  const crewCanvas = $('#crew-canvas')
  const crewTags = $('#crew-tags')
  const crewPlay = $('#crew-play')
  const touchOnly = window.matchMedia('(hover: none)').matches
  if (touchOnly) $('#crew-hint').replaceChildren('Tap one to build one like it.')
  let crewTag = null
  let crewHover = null

  // What the crew says (ui/src/site/crewTalk.ts plays it): a job passed along the thread the way a
  // team's run goes in the app, ending with the work waiting for you. A few words a line.
  const crew = (id) => CREW.findIndex((member) => member.id === id)
  const TALK = [
    { by: crew('planner'), says: 'Scout, can you find sources?', to: crew('scout') },
    { by: crew('scout'), says: 'Found five. Writer, over to you.', to: crew('writer') },
    { by: crew('writer'), says: 'Brief drafted. Checker?', to: crew('checker') },
    { by: crew('checker'), says: 'One claim has no source.', to: 'you' },
  ]
  let sayEl = null
  let sayKey = ''
  // off (reduced motion, or a live.js from before talk), playing, paused or done.
  let sayStatus = 'off'
  function showSayStatus(status) {
    sayStatus = status
    crewPlay.hidden = status === 'off'
    crewPlay.dataset.status = status
    crewPlay.replaceChildren(el('span', { class: 'crew-play-icon', 'aria-hidden': 'true' }), status === 'playing' ? 'Pause' : status === 'paused' ? 'Play' : 'Play again', el('span', { class: 'sr', text: ' the crew’s conversation' }))
  }
  // One bubble at a time, over the head of the one talking: its name and words, dots while it
  // thinks, and a pill when the work waits for you. The same speaker's bubble changes in place.
  function sayBubble(talk, heads) {
    const bubble = talk?.bubble ?? null
    const key = bubble ? `${bubble.by}|${bubble.says ?? ''}|${bubble.waiting}` : ''
    if (key !== sayKey) {
      sayKey = key
      if (sayEl && (!bubble || sayEl.dataset.by !== String(bubble.by) || bubble.waiting)) { sayEl.remove(); sayEl = null }
      if (bubble) {
        if (!sayEl) sayEl = crewTags.appendChild(el('p', { class: 'crew-say', 'data-by': String(bubble.by) }))
        sayEl.classList.toggle('waiting', bubble.waiting)
        sayEl.replaceChildren(...(bubble.waiting
          ? [el('span', { class: 'say-dot' }), bubble.says]
          : [el('b', { text: CREW[bubble.by].name }), ' ', bubble.says ?? el('span', { class: 'say-dots' }, el('i'), el('i'), el('i'))]))
      }
    }
    if (!sayEl || !bubble) return
    const at = heads[bubble.by]
    // Its tail still points at the head when the bubble is held in from an edge.
    const reach = Math.max(0, sayEl.offsetWidth / 2 - 16)
    sayEl.style.setProperty('--tail', `${clamp(at.x - placeTag(sayEl, at, crewCanvas), -reach, reach).toFixed(1)}px`)
  }

  async function mountCrew() {
    const scenes = await loadLive()
    await painted
    const scene = new scenes.CrewScene(crewCanvas, CREW, {
      onHover: (index) => {
        crewHover = index
        crewCanvas.style.cursor = index === null ? '' : 'pointer'
        crewTag?.remove()
        crewTag = index === null ? null : el('p', { class: 'crew-tag' }, el('b', { text: CREW[index].name }), ` ${CREW[index].does}`)
        if (crewTag) crewTags.append(crewTag)
      },
      onPick: (index) => buildLike(CREW[index]),
      onFrame: (heads, talk) => {
        if (sayStatus !== 'off') {
          sayBubble(talk, heads)
          if (talk?.done && sayStatus === 'playing') showSayStatus('done')
        }
        if (!crewTag || crewHover === null) return
        placeTag(crewTag, heads[crewHover], crewCanvas)
      },
    }, reduced)
    stageOf(crewBox, scene)
    // Each glows what it is doing, as agents do in the app and the chat below, in the theme's own
    // green, blue and gold. A live.js cached from before the glow has no glowColors().
    if (typeof scene.glowColors === 'function') {
      const glowColors = () => {
        const css = getComputedStyle(root)
        return { ready: css.getPropertyValue('--ok').trim(), working: css.getPropertyValue('--live').trim(), waiting: css.getPropertyValue('--accent').trim() }
      }
      scene.glowColors(glowColors())
      new MutationObserver(() => scene.glowColors(glowColors())).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    }
    // Their light is the lamp's: it hangs where the bulb is, wherever the page has scrolled them to
    // (with reduced motion, where it was when they came), so each figure's shadow falls away from it;
    // switched off, they cast none. A live.js cached from before the lamp has no lamp().
    if (typeof scene.lamp === 'function') {
      let lampQueued = false
      const hangLamp = () => {
        lampQueued = false
        const bulb = themeButton.getBoundingClientRect()
        const stage = crewCanvas.getBoundingClientRect()
        scene.lamp(bulb.left + bulb.width / 2 - stage.left, bulb.top + bulb.height / 2 - stage.top, root.dataset.theme === 'light')
      }
      const queueLamp = () => { if (!lampQueued) { lampQueued = true; window.requestAnimationFrame(hangLamp) } }
      hangLamp()
      if (!reduced) window.addEventListener('scroll', queueLamp, { passive: true })
      window.addEventListener('resize', queueLamp)
      new MutationObserver(hangLamp).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    }
    // They look where you point anywhere on the first screen, not only over their canvas.
    window.addEventListener('pointermove', (event) => { const [x, y] = local(event, crewCanvas); scene.pointerMove(x, y) }, { passive: true })
    document.documentElement.addEventListener('pointerleave', () => scene.pointerMove(null, null))
    crewCanvas.addEventListener('pointerup', (event) => { const [x, y] = local(event, crewCanvas); scene.pointerUp(x, y) })
    // Its lighting and figures a frame or two after its WebGL context, so the page answers between them.
    await nextPaint()
    await scene.load(await modelFor(scenes))
    crewBox.classList.add('live')
    // They start talking once the headline has had a moment, twice through, then stop; the button
    // pauses them, and plays it again. A live.js or page cached from before the conversation has no
    // talk() or no button.
    if (reduced || !crewPlay || typeof scene.talk !== 'function') return
    scene.talk(TALK, { delay: 2.2, loops: 2 })
    showSayStatus('playing')
    crewPlay.addEventListener('click', () => {
      if (sayStatus === 'playing') { scene.pauseTalk(); showSayStatus('paused') }
      else if (sayStatus === 'paused') { scene.playTalk(); showSayStatus('playing') }
      else { scene.talk(TALK, { delay: 0.3, loops: 1 }); showSayStatus('playing') }
    })
  }
  const crewMounted = mountCrew().catch(() => crewBox.classList.add('still'))

  /* ================================================================ The lamp's pull cord */

  // A gold thread hangs from the theme button, with one more of the crew tied on the end. Pull it
  // down past the click and the light switches, as a lamp's pull cord does; let go and the switch's
  // spring draws the cord back in, and it bobs and swings. A tap is a short pull, and the button
  // still works on its own (it tugs the cord). Scrolling reels the cord up into the header with the
  // page, so it never hangs over what you read; point at the bulb and it comes back down.
  const lamp = $('#lamp')
  const cord = $('#cord')
  const cordPath = $('.cord-thread path', cord)
  const cordFigure = $('#cord-figure')
  const cordTag = $('#cord-tag')
  const LAMPLIGHTER = { id: 'lamplighter', figure: { kind: 'spool', color: 'butter' } }
  const LINKS = 8
  const STEP = 1 / 120
  const BOX = 64 // the figure's box (styles.css)
  const PULL = 34 // how far the cord comes out of the switch
  const CLICK = 22 // and how far it comes out when the switch clicks
  const GRAVITY = 2200
  // The light is felt as it changes. Phones that can vibrate do (flip, below). A page can't buzz a
  // Mac's trackpad or an iPhone, but Safari does it for its own switch control: as the switch's
  // thumb is dragged across, and on an iPhone as it is tapped. So where Safari has one, an unseen
  // switch lies over the figure, and the figure is pulled by it. WebKit moves the thumb once the
  // pointer has gone 40% of the track from where it was pressed (anywhere, in a square switch), so
  // this one is square, laid along the pull, and long enough that a finger's thumb crosses as the
  // cord clicks (a mouse's is made to, tickMore). Nothing can buzz a Mac's click, but a trackpad's
  // click is felt anyway.
  const BUZZ = CLICK / 0.4
  const buzzSwitch = 'switch' in HTMLInputElement.prototype ? el('input', { class: 'buzz-switch', type: 'checkbox', switch: true, tabindex: '-1', style: `width: ${BUZZ}px; height: ${BUZZ}px` }) : null
  if (buzzSwitch) cord.append(buzzSwitch)
  const handles = [cordFigure, buzzSwitch].filter(Boolean)
  let buzzAt = { x: 0, y: 0 } // where the switch lies, in the cord's box
  // A trackpad's tick is faint, so a mouse's pull ticks three times, a couple of frames apart.
  const TICKS = 3
  const TICK_GAP = 30 // ms
  // On a phone the bulb is tapped more than the cord is pulled, so one lies over the bulb too.
  const bulbSwitch = buzzSwitch && touchOnly ? el('input', { class: 'bulb-switch', type: 'checkbox', switch: true, tabindex: '-1', 'aria-hidden': 'true' }) : null
  if (bulbSwitch) lamp.prepend(bulbSwitch)
  const placeSwitch = (x, y) => { buzzAt = { x, y }; buzzSwitch.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)` }
  const restLength = () => (window.innerWidth <= 640 ? 30 : 44)
  const hiddenAt = () => -(rest + BOX + 12)
  let rest = restLength()
  // The cord comes out of the header at hang: 0, or above it, out of sight, while reeled up. It
  // starts there and drops in once the figure is ready.
  let hang = hiddenAt()
  let ready = false
  let reveal = false
  let revealTimer = 0
  const links = Array.from({ length: LINKS + 1 }, (_, i) => { const y = hang + (i / LINKS) * rest; return { x: 0, y, px: 0, py: y } })
  const end = links[LINKS]
  let out = 0 // how far the cord is out of the switch, beyond its rest
  let outSpeed = 0
  let clicked = false // this pull has clicked; it clicks again once the cord has gone back in
  let tilt = 0 // the figure's own lean on the thread, radians clockwise
  let tiltSpeed = 0
  let held = null
  let tugAt = -1
  let tie = { x: BOX / 2, y: BOX * 0.163 } // where the thread is tied: the spool's hole in the still
  let near = false
  let pointer = null
  let figureScene = null
  let running = false
  let lastTime = 0
  let simTime = 0
  let pending = 0

  const cordPoint = (event) => { const r = cord.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top } }
  const reach = () => rest + PULL
  const shown = () => hang > hiddenAt() + 0.5
  function hangTarget() {
    if (held || tugAt >= 0 || reveal) return 0
    return ready ? Math.max(hiddenAt(), -window.scrollY) : hiddenAt()
  }

  function flip() {
    switchTheme()
    figureScene?.flinch()
    navigator.vibrate?.(8)
  }

  // A short pull down and back, to show a switch that has just clicked (from the button, or a tap).
  function tug() {
    clicked = true
    tugAt = simTime
    wakeCord()
  }

  // Where the end of the cord is held, by a hand or by a tug, or null when it hangs free.
  function grip() {
    if (held) return held
    if (tugAt < 0) return null
    const t = (simTime - tugAt) / 0.16
    if (t < 1) return { x: end.x * 0.9, y: hang + rest + (CLICK + 8) * Math.sin(t * Math.PI / 2) }
    tugAt = -1
    end.px = end.x
    end.py = end.y
    return null
  }

  function stepCord(h) {
    simTime += h
    links[0].x = 0
    links[0].y = hang
    const hand = grip()
    if (hand) {
      // Held, the cord comes out of the switch as far as it is pulled, and no further.
      const dx = hand.x
      const dy = hand.y - hang
      const d = Math.hypot(dx, dy) || 1
      const k = Math.min(1, reach() / d)
      out = clamp(d * k - rest, 0, PULL)
      outSpeed = 0
      end.x = dx * k
      end.y = hang + dy * k
      end.px = end.x
      end.py = end.y
    } else {
      // Let go, the switch's spring draws it back in, almost without overshoot.
      outSpeed += (-out * 320 - outSpeed * (reduced ? 60 : 30)) * h
      out = Math.max(0, out + outSpeed * h)
    }
    if (clicked && out < CLICK * 0.35 && !hand) clicked = false

    // Each link falls and carries on as it was going, a little slowed; a breath of air sways the
    // figure while it hangs.
    const damp = reduced ? 0.9 : 0.996
    const breeze = reduced || hand || !shown() ? 0 : 70 * Math.sin(simTime * 1.1) + 30 * Math.sin(simTime * 2.3 + 1)
    for (let i = 1; i <= LINKS; i += 1) {
      const p = links[i]
      if (i === LINKS && hand) continue
      const vx = (p.x - p.px) * damp
      const vy = (p.y - p.py) * damp
      p.px = p.x
      p.py = p.y
      p.x += vx + (i === LINKS ? breeze : 0) * h * h
      p.y += vy + GRAVITY * h * h
    }
    // The thread doesn't stretch. The top is fixed, and the figure, far heavier than the thread,
    // gives little; held, it gives none.
    const length = (rest + out) / LINKS
    for (let pass = 0; pass < 14; pass += 1) {
      for (let i = 0; i < LINKS; i += 1) {
        const a = links[i]
        const b = links[i + 1]
        const wa = i === 0 ? 0 : 1
        const wb = i + 1 === LINKS ? (hand ? 0 : 0.08) : 1
        if (wa + wb === 0) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 1e-6
        const shift = (d - length) / d / (wa + wb)
        a.x += dx * shift * wa
        a.y += dy * shift * wa
        b.x -= dx * shift * wb
        b.y -= dy * shift * wb
      }
    }
    // The figure leans along the end of the thread, a beat behind it.
    const before = links[LINKS - 2]
    const lean = -Math.atan2(end.x - before.x, end.y - before.y)
    tiltSpeed += (-(tilt - lean) * 170 - tiltSpeed * (reduced ? 40 : 9)) * h
    tilt += tiltSpeed * h
  }

  // The pointer, in the figure's canvas as it hangs upright, for it to look at.
  function pointerOnFigure() {
    if (!pointer) return null
    const r = cord.getBoundingClientRect()
    const dx = pointer.x - r.left - end.x
    const dy = pointer.y - r.top - end.y
    if (Math.hypot(dx, dy) > 420) return null
    const c = Math.cos(-tilt)
    const s = Math.sin(-tilt)
    return { x: tie.x + dx * c - dy * s, y: tie.y + dx * s + dy * c }
  }

  function paintCord(dt) {
    let d = `M${links[0].x.toFixed(2)} ${links[0].y.toFixed(2)}`
    for (let i = 1; i < LINKS; i += 1) {
      const p = links[i]
      const q = links[i + 1]
      d += `Q${p.x.toFixed(2)} ${p.y.toFixed(2)} ${((p.x + q.x) / 2).toFixed(2)} ${((p.y + q.y) / 2).toFixed(2)}`
    }
    cordPath.setAttribute('d', `${d}L${end.x.toFixed(2)} ${end.y.toFixed(2)}`)
    if (figureScene && shown()) tie = figureScene.draw(dt, { swing: tiltSpeed, pull: out / PULL, pointer: pointerOnFigure(), near: near || Boolean(held) })
    cordFigure.style.transform = `translate(${end.x.toFixed(2)}px, ${end.y.toFixed(2)}px) rotate(${tilt.toFixed(4)}rad) translate(${(-tie.x).toFixed(2)}px, ${(-tie.y).toFixed(2)}px)`
    // The switch lies over the middle of the figure; held, it stays where it was taken hold of, so a
    // finger's pull drags its thumb (a mouse's is moved once the light changes, tickMore).
    if (buzzSwitch && !held) {
      const mx = BOX / 2 - tie.x
      const my = BOX / 2 - tie.y
      const c = Math.cos(tilt)
      const s = Math.sin(tilt)
      placeSwitch(end.x + mx * c - my * s - BUZZ / 2, end.y + mx * s + my * c - BUZZ / 2)
    }
    cordTag.style.transform = `translate(${(end.x - BOX * 0.3).toFixed(1)}px, ${(end.y + BOX * 0.4).toFixed(1)}px)`
    cord.classList.toggle('near', near && !held && out < 2 && shown())
  }

  // It lives while it can be seen; reeled up out of sight, it rests until it's wanted.
  function cordSettled() {
    if (held || tugAt >= 0 || out > 0.05 || Math.abs(hang - hangTarget()) > 0.3) return false
    return !shown()
  }

  function cordFrame(time) {
    if (!running) return
    const dt = Math.min(0.05, Math.max(0, (time - lastTime) / 1000))
    lastTime = time
    // The top of the cord follows the page as it scrolls, and drops back when it is wanted.
    const target = hangTarget()
    const move = (target - hang) * (reduced ? 1 : 1 - Math.exp(-dt * (target > hang ? 9 : 16)))
    hang += move
    // The rest of the cord goes with its top, as one piece, so it leaves and arrives hanging. The top
    // moves faster than the thread can fall or follow: alone, it would pass the thread on the way
    // down, or fling it up past itself on the way up, and the thread would fold over it and turn the
    // figure upside down.
    for (const p of links) { p.y += move; p.py += move }
    pending += dt
    while (pending >= STEP) { stepCord(STEP); pending -= STEP }
    paintCord(dt)
    if (cordSettled() || document.visibilityState !== 'visible') { running = false; return }
    window.requestAnimationFrame(cordFrame)
  }
  function wakeCord() {
    if (running) return
    running = true
    lastTime = performance.now()
    window.requestAnimationFrame(cordFrame)
  }

  function takeHold(event) {
    if (event.button !== 0 || held) return
    // The switch has to see the press to follow the pull; the figure's is kept from dragging or
    // selecting its picture.
    if (event.currentTarget === cordFigure) event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const at = cordPoint(event)
    held = { id: event.pointerId, dx: at.x - end.x, dy: at.y - end.y, x: end.x, y: end.y, from: at, moved: 0, vx: 0, vy: 0, t: event.timeStamp, flipped: false }
    if (event.currentTarget === buzzSwitch && event.pointerType === 'mouse') held.tick = { from: at.y - buzzAt.y, count: 0, at: 0 }
    handles.forEach((h) => h.classList.add('held'))
    wakeCord()
  }
  // A mouse's pull: Safari's thumb crosses once the pointer is 40% of the track past where it was
  // pressed, then whenever it crosses the middle. Until the light changes Safari isn't let see the
  // pull (below), so it can't cross early. As it changes, the switch jumps up a whole length, so the
  // thumb crosses on that very move, and from then on the switch goes with the pointer, the thumb
  // crossing back and forth for each tick more, then staying across. A finger's pull is left to
  // Safari: an iPhone stopped buzzing when the page held it back too.
  function tickMore(tick, y, time) {
    if (!tick.count) { tick.count = 1; tick.at = time } else if (tick.count < TICKS && time - tick.at >= TICK_GAP) { tick.count += 1; tick.at = time }
    const local = tick.count === 1 ? tick.from + BUZZ : BUZZ / 2 + (tick.count % 2 ? 10 : -10)
    placeSwitch(buzzAt.x, y - local)
    buzzSwitch.getBoundingClientRect() // so Safari measures the move against where it is now
  }
  function pullCord(event) {
    if (!held || event.pointerId !== held.id) return
    const at = cordPoint(event)
    const x = at.x - held.dx
    const y = at.y - held.dy
    const dt = Math.max(4, event.timeStamp - held.t) / 1000
    held.vx = lerp(held.vx, (x - held.x) / dt, 0.6)
    held.vy = lerp(held.vy, (y - held.y) / dt, 0.6)
    held.x = x
    held.y = y
    held.t = event.timeStamp
    held.moved = Math.max(held.moved, Math.hypot(at.x - held.from.x, at.y - held.from.y))
    // The switch clicks as the cord comes out past the click, here rather than in a frame, so a
    // quick pull counts however few frames the page draws while it happens.
    if (!clicked && Math.hypot(x, y - hang) - rest >= CLICK) { clicked = true; held.flipped = true; flip() }
    if (held.tick && held.flipped) tickMore(held.tick, at.y, event.timeStamp)
  }
  function letGo(event) {
    if (!held || event.pointerId !== held.id) return
    const { moved, vx, vy } = held
    held = null
    handles.forEach((h) => h.classList.remove('held'))
    // Safari's switch is made anew after every pull, once its click (if any) is done. Let go off it,
    // or while the new theme spreads, and a mouse's click never reaches it, so it would carry this
    // pull into the next (and tick early, or on a hover); and on a phone it times every hold from
    // the first touch it ever had. Changing its type renews it, without a tick (but not under a hand
    // that has already taken hold again: that would lose its pull, and it renews it as it lets go).
    if (buzzSwitch) window.setTimeout(() => { if (held) return; buzzSwitch.type = 'text'; buzzSwitch.type = 'checkbox'; buzzSwitch.checked = false }, 50)
    if (moved < 4 && event.type === 'pointerup') {
      // A tap is a short pull, and it switches as the button does.
      flip()
      tug()
      return
    }
    // Thrown, it carries on the way your hand was going, and spins on the thread.
    const speed = Math.hypot(vx, vy)
    const k = speed > 2400 ? 2400 / speed : 1
    end.px = end.x - vx * k * STEP
    end.py = end.y - vy * k * STEP
    figureScene?.spin(clamp(vx / 160, -9, 9) + (Math.random() - 0.5) * 3)
  }
  for (const handle of handles) {
    handle.addEventListener('pointerdown', takeHold)
    handle.addEventListener('pointermove', pullCord)
    handle.addEventListener('pointerup', letGo)
    handle.addEventListener('pointercancel', letGo)
    handle.addEventListener('pointerenter', () => { near = true; wakeCord() })
    handle.addEventListener('pointerleave', () => { near = false })
  }
  // The switch's own click is undone, so it is off for the next pull.
  buzzSwitch?.addEventListener('click', (event) => event.preventDefault())
  // Until the light changes, Safari isn't let see a mouse's pull (tickMore), nor a hover.
  buzzSwitch?.addEventListener('mousemove', (event) => { if (!held?.flipped) event.preventDefault() })
  // The bulb's switch switches as the button does, as it's let go; Safari's own click, which an
  // iPhone feels, is undone, and it isn't let follow a finger, so nothing else is felt.
  bulbSwitch?.addEventListener('pointerup', () => { flip(); tug() })
  bulbSwitch?.addEventListener('click', (event) => event.preventDefault())
  bulbSwitch?.addEventListener('mousemove', (event) => event.preventDefault())
  bulbSwitch?.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false })
  // Point at the bulb (or tab to it) while the cord is reeled up and it comes down to be pulled.
  const showCord = (on) => {
    window.clearTimeout(revealTimer)
    if (on) { reveal = true; wakeCord(); return }
    revealTimer = window.setTimeout(() => { reveal = false; wakeCord() }, 900)
  }
  lamp.addEventListener('pointerenter', () => showCord(true))
  lamp.addEventListener('pointerleave', () => showCord(false))
  themeButton.addEventListener('focus', () => { if (themeButton.matches(':focus-visible')) showCord(true) })
  themeButton.addEventListener('blur', () => showCord(false))
  themeButton.addEventListener('click', () => { flip(); tug() })
  window.addEventListener('pointermove', (event) => { pointer = { x: event.clientX, y: event.clientY } }, { passive: true })
  document.documentElement.addEventListener('pointerleave', () => { pointer = null })
  window.addEventListener('scroll', wakeCord, { passive: true })
  window.addEventListener('resize', () => { rest = restLength(); wakeCord() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeCord() })

  // The figure on the cord is the crew's own, alive; it loads after the crew, from the same model.
  // Until then (and where WebGL is off) the cord carries its still picture.
  async function mountCord() {
    // Once the GPU has drawn the crew (CrewScene.load), whose work its WebGL context would wait for.
    await crewMounted
    await nextPaint()
    const scenes = await loadLive()
    const scene = new scenes.CordScene($('.cord-canvas', cord), LAMPLIGHTER, reduced)
    scene.resize(BOX, BOX)
    await scene.load(await modelFor(scenes))
    figureScene = scene
    cord.classList.add('live')
  }
  const dropIn = () => { ready = true; wakeCord() }
  // Settles once the figure is on the cord, or won't be; the bench waits for it (mountBench).
  const cordMounted = mountCord().then(dropIn, dropIn)
  window.setTimeout(dropIn, 6000)
  if (reduced) hang = hangTarget()
  paintCord(0)

  window.addEventListener('resize', () => drawLanes())

  /* ================================================================ Step 1 · Agents */

  // The same crew as the app: six figures in seven colours (ui/src/lib/library/figures.ts).
  const KINDS = [
    { id: 'yarn', name: 'yarn ball' }, { id: 'spool', name: 'spool' }, { id: 'button', name: 'button' },
    { id: 'thimble', name: 'thimble' }, { id: 'pincushion', name: 'pincushion' }, { id: 'cone', name: 'thread cone' },
  ]
  const COLORS = { clay: '#E3A386', butter: '#F1D488', sage: '#9FBF9E', sky: '#9EC3E6', lilac: '#BDB0E6', rose: '#EBB3C0', oat: '#E8DFCF' }
  const figureSrc = (kind, color) => `assets/figures/${kind}-${color}.webp`
  // The keys an agent may be handed, and what each one means, said beside it as the app says it.
  const KEYS = [
    { key: 'web', word: 'Web', label: 'Search the web', may: 'search the web', asks: 'searches the web', off: 'Asks you before it searches the web.', on: 'Searches the web without asking.' },
    { key: 'edits', word: 'Files', label: 'Change files', may: 'change files in its folder', asks: 'changes a file', off: 'Asks you before it changes a file.', on: 'Changes files in its folder without asking.' },
    { key: 'commands', word: 'Commands', label: 'Run commands', may: 'run commands', asks: 'runs a command', off: 'Asks you before it runs a command.', on: 'Runs commands without asking.' },
  ]
  // A job is its instructions (the pattern on its clipboard), the skills pinned on its board, and
  // the one key its test run reaches for.
  const JOBS = [
    { id: 'sources', label: 'Find sources', does: 'Finds sources', instructions: 'Find what is new this week. Reply with each claim and a link to its source.', skills: ['web-research'], needs: 'web', tool: 'web search', ask: 'search the web for “open-weight models this week”',
      reply: 'Three stories this week, each with its link: a new open coding model, a faster small model for phones, and a licence change.', without: 'Without the web, I can only tell you what I already know, and it may be out of date.' },
    { id: 'brief', label: 'Write the brief', does: 'Writes the brief', instructions: 'Turn the findings into a short brief in plain words. Reply with the brief as Markdown.', skills: ['house-style', 'markdown'], needs: 'edits', tool: 'writing brief.md', ask: 'save the brief as brief.md in its folder',
      reply: 'The brief is in brief.md: five lines, the biggest story first, every claim with its link.', without: 'Here is the brief in my reply instead of a file: five lines, the biggest story first.' },
    { id: 'check', label: 'Check the facts', does: 'Checks each claim', instructions: 'Check every claim in the draft against its source. Reply with what holds and what does not.', skills: ['fact-check', 'web-research'], needs: 'web', tool: 'checking 3 sources', ask: 'open the 3 sources the draft links to',
      reply: 'Two claims hold. One quotes the wrong benchmark: the model card says 61%, not 67%.', without: 'Without opening the sources, I can only say which claims have a link, not whether they hold.' },
    { id: 'slides', label: 'Make the slides', does: 'Makes the slides', instructions: 'Turn the brief into slides, one story on each. Reply with where the file is.', skills: ['house-style'], needs: 'commands', tool: 'making brief.pptx', ask: 'run a command that makes brief.pptx from the brief',
      reply: 'The slides are in brief.pptx: five slides, one story on each, the biggest first.', without: 'Without running a command I can’t make the file, so here are the five slides as an outline.' },
  ]
  const agent = { name: 'Scout', kind: 'pincushion', color: 'rose', model: 'sonnet', job: 'sources', keys: { web: false, edits: false, commands: false } }
  const shelf = [] // { name, job, kind, color }
  let trial = 0 // the test run in flight, or 0; a newer one or an edit ends it
  let trials = 0
  let mood = 'still'
  let asked = null
  let events = 0
  let replied = false
  let allowOnce = null
  const ENDED = Symbol('ended')
  const orText = (items) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`

  const jobOf = () => JOBS.find((j) => j.id === agent.job)
  const agentName = () => agent.name.trim() || 'Your agent'
  const agentJob = () => `${agent.model}|${agent.job}|${KEYS.filter((k) => agent.keys[k.key]).map((k) => k.key).join(',')}`
  const shelved = () => shelf.find((s) => s.name.toLowerCase() === agentName().toLowerCase())
  const looksLike = () => {
    const kind = KINDS.find((k) => k.id === agent.kind).name
    return `${/^[aeiou]/.test(agent.color) ? 'an' : 'a'} ${agent.color} ${kind}`
  }

  // A radio group of buttons: one tab stop, arrow keys move the choice, as the app's pickers do.
  function radios(container, items, current, pick) {
    const buttons = items.map((item) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(item.id === current), 'aria-label': item.label, title: item.label,
      tabindex: item.id === current ? '0' : '-1', style: item.style, onclick: () => pick(item.id),
    }, ...(item.kids || [])))
    buttons.forEach((button, i) => button.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
      if (!step) return
      event.preventDefault()
      pick(items[(i + step + items.length) % items.length].id)
      container.querySelector('[aria-checked="true"]')?.focus()
    }))
    container.replaceChildren(...buttons)
  }

  // ---------------------------------------------------------------- the bench

  const bench = $('#bench')
  const benchCanvas = $('#bench-canvas')
  const benchTags = $('#bench-tags')
  const agImg = $('#ag-img')
  let benchScene = null

  function benchView() {
    const job = jobOf()
    return {
      look: { name: agentName(), instructions: job.instructions, model: modelOf(agent.model).openrouter, skills: job.skills, allow: { ...agent.keys } },
      figure: { kind: agent.kind, color: agent.color },
      pattern: benchPattern(agentName()),
      does: job.does,
      modelName: modelOf(agent.model).name,
      hasReply: replied,
      mood, events, asked, open: null, dropping: false,
    }
  }
  let benchPattern = () => Array.from({ length: 9 }, (_, i) => i % 2 === 0)
  // Words on the bench itself, following the things they name.
  const TAGS = [
    { anchor: 'keys', text: () => { const on = KEYS.filter((k) => agent.keys[k.key]); return on.length ? `On its hooks · ${on.map((k) => k.word).join(', ')}` : 'Its hooks · empty' } },
    { anchor: 'dish', text: () => { const off = KEYS.filter((k) => !agent.keys[k.key]); return off.length ? `You keep · ${off.map((k) => k.word).join(', ')}` : 'Your dish · empty' } },
    { anchor: 'skills', text: () => `Skills · ${jobOf().skills.length}` },
    { anchor: 'reply', text: () => (replied ? 'Its reply is here' : 'Hands back here') },
  ]
  const tagEls = new Map(TAGS.map((t) => [t.anchor, el('span', { class: `bench-tag at-${t.anchor}` })]))
  benchTags.append(...tagEls.values())
  function paintTags() { for (const t of TAGS) tagEls.get(t.anchor).textContent = t.text() }
  // The words on its nameplate, job sheet and laptop lid: text laid over those faces (placeFace),
  // since words painted into the picture blur once the bench is drawn small.
  const faceEls = {
    name: el('div', { class: 'bench-face bench-face-name' }),
    job: el('div', { class: 'bench-face bench-face-job' }),
    app: el('div', { class: 'bench-face bench-face-app' }),
  }
  benchTags.before(el('div', { class: 'bench-faces', 'aria-hidden': 'true' }, ...Object.values(faceEls)))
  let facesSay = ''
  function paintFaces() {
    const job = jobOf()
    const say = [agentName(), job.does, job.instructions, modelOf(agent.model).name]
    if (say.join('\n') === facesSay) return
    facesSay = say.join('\n')
    faceEls.name.replaceChildren(el('p', {}, el('b', { text: say[0] }), say[1] ? el('span', { text: say[1] }) : null))
    faceEls.name.style.setProperty('--chars', say[0].length)
    faceEls.job.replaceChildren(el('p', { text: say[2] }))
    faceEls.app.replaceChildren(el('p', { text: say[3] }))
    faceEls.app.style.setProperty('--chars', say[3].length)
  }

  const PART_BLOCK = {
    name: '#ag-name', app: '#ag-apps [aria-checked="true"]', job: '#ag-jobs [aria-checked="true"]', skills: '#ag-jobs [aria-checked="true"]',
    mind: '#ag-kinds [aria-checked="true"]', keys: '#ag-keys button', reply: '#ag-try',
  }
  async function mountBench() {
    const scenes = await loadLive()
    // The bench's code is a module of its own (bench()); a live.js cached from before has it in itself.
    const { WorkbenchScene, placeFace } = scenes.bench ? await scenes.bench() : scenes
    const { markPattern } = scenes
    benchPattern = (name) => markPattern(name.toLowerCase()).over
    const scene = new WorkbenchScene(benchCanvas, {
      // Clicking a thing on the bench takes you to the block that changes it.
      onPart: (part) => { if (PART_BLOCK[part]) $(PART_BLOCK[part])?.focus() },
      // A key dragged onto its hook is handed over; into your dish, taken back.
      onKey: (key, given) => {
        if (given && asked === key && allowOnce) { agent.keys[key] = true; allowOnce(true); renderAgent(); return }
        agent.keys[key] = given
        edited()
      },
      onHover: (part, grab) => { benchCanvas.style.cursor = grab ? 'grab' : part ? 'pointer' : '' },
      onFrame: (anchors, faces) => {
        for (const [anchor, tag] of tagEls) placeTag(tag, anchors[anchor], benchCanvas)
        // A live.js cached from before placeFace has none for ten minutes after a deploy.
        if (placeFace) for (const [face, element] of Object.entries(faceEls)) placeFace(element, faces[face])
      },
    }, reduced)
    benchScene = scene
    scene.set(benchView())
    stageOf(bench, scene)
    benchCanvas.addEventListener('pointermove', (event) => { const [x, y] = local(event, benchCanvas); scene.pointerMove(x, y) })
    benchCanvas.addEventListener('pointerdown', (event) => {
      const [x, y] = local(event, benchCanvas)
      if (scene.pointerDown(x, y)) { benchCanvas.setPointerCapture(event.pointerId); benchCanvas.style.cursor = 'grabbing' }
    })
    benchCanvas.addEventListener('pointerup', (event) => { const [x, y] = local(event, benchCanvas); scene.pointerUp(x, y); scene.pointerMove(x, y) })
    benchCanvas.addEventListener('pointerleave', (event) => { if (!benchCanvas.hasPointerCapture(event.pointerId)) scene.pointerLeave() })
    benchCanvas.addEventListener('pointercancel', () => scene.pointerLeave())
    await scene.load(await modelFor(scenes))
    bench.classList.add('live')
    paintBench()
  }
  function paintBench() {
    paintTags()
    paintFaces()
    benchScene?.set(benchView())
  }
  // The bench loads when Step 1 is near, and after the crew and the cord are on the screen, so the
  // first screen only waits for the crew and the GPU readies one scene at a time.
  if ('IntersectionObserver' in window) {
    // Its code comes down once the cord's figure is up, so it is here by the time Step 1 is.
    cordMounted.then(loadLive).then((scenes) => scenes.bench?.()).catch(() => {})
    const near = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      near.disconnect()
      cordMounted.then(nextPaint).then(mountBench).catch(() => bench.classList.add('still'))
    }, { rootMargin: '600px 0px' })
    near.observe(bench)
  } else bench.classList.add('still')

  // Without WebGL, the figure's still picture stands in for the bench.
  function paintStill() {
    const src = figureSrc(agent.kind, agent.color)
    bench.style.setProperty('--fig', COLORS[agent.color])
    if (agImg.getAttribute('src') === src) return
    const next = new Image()
    next.src = src
    const show = () => { agImg.src = src }
    if (next.decode) next.decode().then(show, show)
    else show()
  }

  // ---------------------------------------------------------------- the blocks

  function renderAgent() {
    if (!state.models.includes(agent.model)) agent.model = state.models[0]
    paintStill()
    $('#ag-plate-name').textContent = agentName()
    $('#ag-plate-what').textContent = looksLike()
    radios($('#ag-apps'), state.models.map((id) => ({ id, label: modelOf(id).name, kids: [modelOf(id).name] })), agent.model, (id) => { agent.model = id; edited() })
    radios($('#ag-jobs'), JOBS.map((j) => ({ id: j.id, label: j.label, kids: [j.label] })), agent.job, (id) => { agent.job = id; edited() })
    radios($('#ag-kinds'), KINDS.map((k) => ({
      id: k.id, label: k.name[0].toUpperCase() + k.name.slice(1),
      kids: [el('img', { src: figureSrc(k.id, agent.color), width: '96', height: '96', alt: '', loading: 'lazy' })],
    })), agent.kind, (id) => { agent.kind = id; edited() })
    radios($('#ag-colors'), Object.keys(COLORS).map((c) => ({ id: c, label: c[0].toUpperCase() + c.slice(1), style: `--c:${COLORS[c]}` })), agent.color, (id) => { agent.color = id; edited() })
    $('#ag-keys').replaceChildren(...KEYS.map((k, i) => {
      const on = agent.keys[k.key]
      return el('li', { class: on ? 'on' : '' },
        el('b', { text: k.label }),
        el('em', { text: on ? k.on : k.off }),
        el('button', { type: 'button', 'aria-pressed': String(on), 'aria-label': `${on ? 'Take back' : 'Hand over'}: ${k.label}`, onclick: () => { agent.keys[k.key] = !on; edited(); $(`#ag-keys li:nth-child(${i + 1}) button`).focus() } }, on ? 'Take it back' : 'Hand it over'))
    }))
    // The blocks add up to one sentence, so the visitor reads what the agent will do, not settings.
    const free = KEYS.filter((k) => agent.keys[k.key]).map((k) => k.may)
    const asks = KEYS.filter((k) => !agent.keys[k.key]).map((k) => k.asks)
    $('#ag-says').replaceChildren(el('b', { text: agentName() }), ` ${jobOf().does.toLowerCase()}, on ${modelOf(agent.model).name}. `,
      free.length ? `It may ${listText(free)} on its own` : 'It only reads and replies on its own',
      asks.length ? `, and asks you before it ${orText(asks)}.` : ', and never stops to ask you.')
    paintSaved()
    paintBench()
  }

  function paintSaved() {
    const saved = shelved()
    const badge = $('#ag-badge')
    const changed = saved && changedSince(saved)
    $('#ag-name-saved').textContent = saved ? saved.name : 'New agent'
    badge.textContent = !saved ? 'Not saved yet' : changed ? 'Unsaved changes' : 'Saved'
    if (trial) return
    badge.dataset.state = changed ? 'waiting' : ''
    $('#ag-save').textContent = !saved ? 'Save to My agents' : 'Save'
  }
  // An agent lives once, in My agents, with no versions: every team uses it as it was last saved.
  function changedSince(saved) {
    return saved.job !== agentJob() || saved.kind !== agent.kind || saved.color !== agent.color
  }

  // Any edit ends a test run: what was being tried is no longer this agent.
  function edited() {
    if (trial) endTrial()
    replied = false
    renderAgent()
  }

  // ---------------------------------------------------------------- trying it

  // The bench's moods, and the words the app says beside an agent for each.
  const MOOD = { still: 'still', starting: 'starting', thinking: 'quiet', working: 'working', writing: 'working', waiting: 'asking', done: 'done' }
  const TONE = { starting: 'live', thinking: 'live', working: 'live', writing: 'live', waiting: 'you', done: 'done', still: '' }
  const WORDS = { still: 'Ready', starting: 'Starting', thinking: 'Thinking', working: 'Using a tool', writing: 'Writing its reply', waiting: 'Waiting for you', done: 'Done' }
  function mark(stateName, detail = '') {
    mood = MOOD[stateName]
    bench.dataset.mood = stateName
    const status = $('#ag-status')
    status.dataset.tone = TONE[stateName]
    status.lastElementChild.textContent = detail ? `${WORDS[stateName]} · ${detail}` : WORDS[stateName]
    paintBench()
  }
  function endTrial() {
    trial = 0
    asked = null
    allowOnce = null
    mark('still')
    $('#ag-reply').hidden = true
    $('#ag-try').textContent = 'Try it'
    paintSaved()
  }
  const pause = (ms, mine) => new Promise((resolve, reject) => window.setTimeout(() => (trial === mine ? resolve() : reject(ENDED)), reduced ? Math.min(ms, 200) : ms))
  // Each event in the record flickers its screen, as the app's bench does.
  async function busyFor(ms, mine) {
    for (let at = 0; at < ms; at += 420) { events += 1; paintBench(); await pause(Math.min(420, ms - at), mine) }
  }

  // A test run on its own, before any team depends on it: the app's status words, and the stop it
  // makes for the key its job reaches for when you kept it.
  async function tryAgent() {
    if (trial) { endTrial(); return }
    const mine = ++trials
    trial = mine
    replied = false
    const job = jobOf()
    const key = KEYS.find((k) => k.key === job.needs)
    const reply = $('#ag-reply')
    const badge = $('#ag-badge')
    $('#ag-try').textContent = 'Stop'
    badge.textContent = 'Testing'
    badge.dataset.state = 'running'
    reply.hidden = true
    try {
      mark('starting'); await pause(800, mine)
      mark('thinking'); await pause(1400, mine)
      let allowed = agent.keys[job.needs]
      if (!allowed) {
        asked = job.needs
        mark('waiting', `it wants to ${key.label.toLowerCase()}`)
        allowed = await new Promise((resolve) => {
          allowOnce = resolve
          reply.replaceChildren(el('div', { class: 'ag-ask' },
            el('span', {}, el('b', { text: agentName() }), ` wants to ${job.ask}. It points at the key you kept.`),
            el('div', {},
              el('button', { type: 'button', class: 'btn btn-primary', onclick: () => resolve(true) }, 'Allow once'),
              el('button', { type: 'button', class: 'btn', onclick: () => resolve(false) }, 'Decline')),
            el('small', { text: 'Or drag the key from your dish onto its hook.' })))
          reply.hidden = false
        })
        if (trial !== mine) return
        asked = null
        allowOnce = null
        reply.hidden = true
      }
      if (allowed) { mark('working', job.tool); await busyFor(1800, mine) }
      mark('writing'); await busyFor(1300, mine)
      replied = true
      reply.replaceChildren(el('span', {}, allowed ? job.reply : job.without))
      reply.hidden = false
      mark('done')
      $('#ag-try').textContent = 'Try it again'
      trial = 0
      paintSaved()
    } catch (error) {
      if (error !== ENDED) throw error
    }
  }

  function saveAgent() {
    if (trial) endTrial()
    const saved = shelved()
    const note = $('#ag-shelf-note')
    if (!saved) {
      shelf.push({ name: agentName(), job: agentJob(), kind: agent.kind, color: agent.color })
      note.replaceChildren(`${agentName()} is in My agents. `, el('a', { href: '#act-workflow', text: 'Put it in a team ↓' }))
    } else if (changedSince(saved)) {
      Object.assign(saved, { job: agentJob(), kind: agent.kind, color: agent.color })
      note.textContent = `Saved. Every team ${saved.name} is in uses the change from its next run.`
    } else {
      note.textContent = `Nothing changed since you saved ${saved.name}.`
    }
    $('#ag-shelf').hidden = false
    $('#ag-shelf-list').replaceChildren(...shelf.map((s) => el('li', {},
      el('img', { src: figureSrc(s.kind, s.color), width: '60', height: '60', alt: '' }), s.name)))
    paintSaved()
  }

  // The crew's pick: an agent like the one you clicked, ready on the bench.
  function buildLike(member) {
    if (trial) endTrial()
    Object.assign(agent, { name: member.name, kind: member.figure.kind, color: member.figure.color, job: member.job })
    $('#ag-name').value = member.name
    replied = false
    renderAgent()
    scrollToId('act-agents')
  }

  $('#ag-name').addEventListener('input', (event) => { agent.name = event.target.value; edited() })
  $('#ag-try').addEventListener('click', tryAgent)
  $('#ag-save').addEventListener('click', saveAgent)

  /* ================================================================ 03 · Team */

  const sentence = $('#sentence')
  function modelSelect(who) {
    const select = el('select', { 'aria-label': `${LANE[who]}'s model` })
    for (const id of state.models) select.append(el('option', { value: id, text: `on ${modelOf(id).name}` }))
    select.value = state.team[who]
    select.addEventListener('change', () => { state.team[who] = select.value; renderTeamViews([who]) })
    return select
  }
  function agentChip(who) {
    return el('span', { class: 'chip' }, el('span', { class: `face m-${who}`, 'aria-hidden': 'true' }), el('span', { text: LANE[who] }), modelSelect(who))
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
        el('div', { class: 'nm' }, you ? null : el('span', { class: `face m-${who}`, 'aria-hidden': 'true' }), LANE[who]),
        el('div', { class: 'ln', text: you ? 'Approve, or send it back' : who === 'researcher' ? 'Finds what is true, with sources' : 'Writes the answer' }),
        you ? null : el('div', { class: 'ap', text: `on ${modelOf(t[who]).name}` }),
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
    const folder = (who) => `{ cwd: ${state.cwd[who]} }`
    const given = (who) => {
      const lines = []
      if (state.give[who].length) {
        lines.push('    capabilities:')
        for (const id of state.give[who]) {
          const x = source(id)
          lines.push(x.kind === 'folder' || x.kind === 'file'
            ? `      - { kind: knowledge, name: ${x.name.replace(/\/$/, '')}, path: ${x.path} }`
            : x.kind === 'notion'
              ? `      - { kind: knowledge, name: ${x.name}, notion: { page: ${x.page} } }`
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
      `    model: ${modelOf(t.researcher).openrouter}`,
      `    spawn: ${folder('researcher')}`,
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
      `    model: ${modelOf(t.writer).openrouter}`,
      `    spawn: ${folder('writer')}`,
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

  // Ask LoomWatch proposes the team, and nothing changes until Apply.
  const proposeBox = $('#propose')
  const describe = $('#describe')
  let proposing = 0
  describe.addEventListener('click', async () => {
    const mine = ++proposing
    const researcher = 'sonnet'
    const writer = 'opus'
    const words = `A researcher on ${modelOf(researcher).name}, then me to check its work, then a writer on ${modelOf(writer).name}.`
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
      el('span', { text: `Researcher on ${modelOf(researcher).name} · You · Writer on ${modelOf(writer).name}` }),
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
    notion: ['M5 3h11l3 3v15H5z', 'M9 16V8l6 8V8'],
  }
  function icon(kind) {
    const svg = el('svg:svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })
    for (const d of ICONS[kind]) svg.append(el('svg:path', { d }))
    return svg
  }
  const readOnly = (x) => x.kind === 'folder' || x.kind === 'file' || x.kind === 'notion'
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
        'aria-label': picked ? `Hand ${source(picked).name} to ${LANE[who]}` : `${LANE[who]}, on ${modelOf(state.team[who]).name}, ${state.give[who].length} handed over. Show what it is given.`,
        onclick: () => { if (picked) handOverSource(picked, who); else { giveFor = who; renderGive() } },
      },
      el('span', { class: 'kind', text: 'Agent' }),
      el('span', { class: 'nm', text: LANE[who] }),
      el('span', { class: 'ap', text: `on ${modelOf(state.team[who]).name}` }),
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
    $('#give-count').textContent = String(GIVEN_TO.reduce((n, who) => n + state.give[who].length, 0))
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
      say(readers.length > 1 ? `${source(id).name} is shared now: one card, given to ${['', '', 'two', 'three'][readers.length] || readers.length} agents.` : `${LANE[who]} is handed ${source(id).name}${readOnly(source(id)) ? ', read only' : ''}.`)
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
    packetBox.replaceChildren(
      el('div', { class: 'pk-head' },
        el('span', { class: 'micro', text: 'What it gets, every run' }),
        el('b', { text: `${LANE[who]}, on ${modelOf(state.team[who]).name}` })),
      el('dl', { class: 'pk' },
        el('div', {}, el('dt', { text: 'Works in' }), el('dd', {}, el('code', { text: state.cwd[who] }),
          el('span', { class: 'pk-note', text: state.allow[who].edits ? ' Its project. It may change files here.' : ' Its project. It reads here, and asks before it changes a file.' }))),
        el('div', {}, el('dt', { text: 'Handed over' }), el('dd', {}, items.length
          ? el('ul', { class: 'pk-list' }, items.map((x) => el('li', {}, icon(x.kind), el('span', {}, el('b', { text: x.name }), el('small', { text: `${x.arrives}${readOnly(x) ? ', read only' : ''}` })))))
          : el('span', { class: 'pk-note', text: `Nothing yet. Drag a card onto ${LANE[who]}.` }))),
        el('div', {}, el('dt', { text: 'May, without asking' }), el('dd', { class: 'pk-allow' }, ALLOW.map((a) => el('button', {
          type: 'button', role: 'switch', class: 'sw', 'aria-checked': String(state.allow[who][a.key]),
          onclick: () => { state.allow[who][a.key] = !state.allow[who][a.key]; renderYaml(); renderPacket() },
        }, el('i', { 'aria-hidden': 'true' }), a.label))))),
      el('p', { class: 'pk-foot', text: 'Anything else it asks for waits for your answer during the run.' }))
  }

  /* ================================================================ Act II · Workflow tabs */

  // The team and what each agent is given are two tabs of one window.
  const flowTabs = $$('[data-flow]')
  function showFlow(name, focus = false) {
    flowTabs.forEach((tab) => {
      const on = tab.dataset.flow === name
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (on && focus) tab.focus()
    })
    $('#flow-team').hidden = name !== 'team'
    $('#flow-give').hidden = name !== 'give'
    if (name === 'give') drawGiveThreads()
  }
  flowTabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showFlow(tab.dataset.flow))
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
      if (!step) return
      event.preventDefault()
      showFlow(flowTabs[(i + step + flowTabs.length) % flowTabs.length].dataset.flow, true)
    })
  })

  /* ================================================================ Act III · Chat steps */

  // Ask, Watch, Review and Result are four views of the team's one chat (see below), shown one at
  // a time as steps of a single window. The step follows the work: sending starts Watch, a stop
  // for you opens Review, the answer opens Result. You can look back at any step; the next change
  // in the work brings you along again.
  const STEPS = ['ask', 'watch', 'review', 'result']
  const stepTabs = $$('[data-step]')
  let stepFollowed = 'ask'
  function showStep(name, focus = false) {
    stepTabs.forEach((tab) => {
      const on = tab.dataset.step === name
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (on && focus) tab.focus()
    })
    for (const step of STEPS) $(`#step-${step}`).hidden = step !== name
    if (name === 'watch') drawLanes()
  }
  function followStep() {
    const place = boxPlace()
    if (place === stepFollowed) return
    stepFollowed = place
    showStep(place)
  }
  stepTabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showStep(tab.dataset.step))
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
      if (!step) return
      event.preventDefault()
      showStep(stepTabs[(i + step + stepTabs.length) % stepTabs.length].dataset.step, true)
    })
  })
  // The chat's own links ("Review it", "Read the answer") move between the steps, and a card's
  // "handed over" opens what each agent is given.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]')
    if (!link) return
    const to = link.getAttribute('href').slice(1)
    if (STEPS.includes(to)) { event.preventDefault(); showStep(to) }
    else if (to === 'give') { event.preventDefault(); showFlow('give') }
  })

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
          ? el('p', { class: 'box-away' }, 'New work starts from the message box, back in ', el('a', { class: 'link', href: '#ask', text: 'Ask' }))
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
    if (mode === 'request') { startRun(); return }
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
  // An agent is its figure, which glows what it is doing (styles.css); you are initials on a disc.
  const avatar = (who, doing = '') => el('span', { class: `tc-av m-${who}${doing ? ` ${doing}` : ''}`, text: INITIALS[who] })
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
  // The team on a piece of work as a thread: each agent a knot, glowing blue while it works and gold
  // while it waits for you.
  const DOING = { running: 'working', waiting: 'waiting' }
  const weft = (r) => el('span', { class: 'weft', 'aria-hidden': 'true' }, workersOf(r).map((w) => avatar(w, r && r === run && r.scrub === null ? DOING[r.stages[w]] : '')))

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
        return el('li', { class: `mem ${value}`, title: `${LANE[who]} on ${modelOf(team[who]).name} · ${MEMBER_WORD[value]}` },
          avatar(who), el('span', { text: LANE[who] }), el('em', { text: MEMBER_WORD[value] }))
      }))
    }
  }

  // A piece of work, as the top of the chat lists it: who worked on it, and where it is now.
  function pieceLine(r) {
    const live = r === run && r.phase !== 'done'
    const [text, href, go] = !live
      ? [worked(r), r === run ? '#result' : null, r === run ? 'Read the answer →' : null]
      : r.phase === 'review' ? ["Waiting for you · Researcher's work is ready for your review", '#review', 'Review it →']
        : r.phase === 'asking' ? ['Waiting for you · Researcher asked you something', '#watch', 'Answer it →']
          : [`${LANE[r.working] || 'The team'} is working`, '#watch', 'Watch it →']
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
    if (run === mine) showStep('result')
  }

  async function researcherPass() {
    const r = run
    const name = modelOf(r.team.researcher).name
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
      if (web && !r.allow.researcher.web && !(await askPermission('researcher', r.preset.tools[0]))) r.deniedWeb = true
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
    const name = modelOf(r.team.writer).name
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
    // A question back to an earlier step goes through the Team Bus.
    {
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
    const name = modelOf(r.team.writer).name
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
    followStep()
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
          el('a', { class: 'link', href: '#act-workflow', style: 'display:inline-block;margin-top:16px', text: 'Add one in the team sentence ↑' })))
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
          : el('a', { class: 'link', href: '#act-workflow', style: 'display:inline-block;margin-top:16px', text: 'Add one in the team sentence ↑' })))
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
      rows.push(['Asked', `“${FOLLOW.text}”`], ['Team', 'Writer only'], ['Ran on', `${modelOf(r.team.writer).name} · your OpenRouter key`], ['Took', clockText(r.clock)], ['Cost', costText(r)],
        ['Read first', `the conversation so far: your request, ${r.team.review ? 'the findings you approved' : "Researcher's findings"}, and its last answer`],
        ['Kept', "Researcher's findings, as they were"])
    } else {
      const models = [...new Set(['researcher', 'writer'].map((w) => modelOf(r.team[w]).name))]
      const call = !r.team.review ? 'No review step on this team'
        : r.sendBacks ? `Sent back ${r.sendBacks === 1 ? 'once' : `${r.sendBacks} times`}, then approved` : r.notes.length ? 'Approved, with a note' : 'Approved'
      rows.push(['Asked', `“${r.preset.short}”`], ['Team', seq(r.team).map((w) => LANE[w]).join(' → ')], ['Ran on', `${listText(models)} · your OpenRouter key`], ['Took', clockText(r.clock)], ['Cost', costText(r)])
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
  // What the run cost, as OpenRouter reports it in the app: a plausible figure for this sketch,
  // larger with every tool call and pass.
  function costText(r) {
    const dollars = 0.004 + 0.003 * r.tools.researcher + 0.005 * r.tools.writer + 0.002 * r.pass
    return `$${dollars.toFixed(3)}`
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
        el('a', { class: 'link', href: '#review', style: 'display:inline-block;margin-top:14px', text: 'Go to the review →' })))
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
      el('a', { class: 'link', href: '#watch', style: 'font-size:13px', text: 'Replay the timeline →' }),
      copied)
    resultBody.replaceChildren(el('div', { class: 'result-grid' }, thread,
      el('section', { class: 'res-details', 'aria-label': 'Details' }, el('span', { class: 'micro', text: 'Details · how it was made' }), slip, acts)))
  }

  /* ================================================================ 09 · Start */

  // The download for the visitor's computer: Windows when the browser says it runs on Windows, the
  // Mac otherwise (a phone too, as before). The other one is a click away on the switch.
  const get = $('#get')
  const osPick = $('.get-pick')
  const osButtons = $$('.get-pick [data-os]')
  // The switch's highlight is one pill under the buttons, set on the computer picked; it slides there
  // once it has been placed (styles.css, .get-pick::before). A switch by hand brings that computer's
  // download in from the side the pill went.
  function placeOsPill() {
    const on = osButtons.find((b) => b.dataset.os === get.dataset.os)
    osPick.style.setProperty('--pill-x', `${on.offsetLeft}px`)
    osPick.style.setProperty('--pill-w', `${on.offsetWidth}px`)
  }
  function setOs(os, byHand = false) {
    const from = osButtons.findIndex((b) => b.dataset.os === get.dataset.os)
    get.dataset.os = os
    osButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.os === os)))
    placeOsPill()
    const to = osButtons.findIndex((b) => b.dataset.os === os)
    if (!byHand || from === to) return
    const shown = $(`.get-os[data-os="${os}"]`, get)
    shown.classList.remove('get-in-left', 'get-in-right')
    void shown.offsetWidth
    shown.classList.add(to > from ? 'get-in-right' : 'get-in-left')
  }
  osButtons.forEach((b) => b.addEventListener('click', () => setOs(b.dataset.os, true)))
  osPick.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const at = osButtons.findIndex((b) => b.dataset.os === get.dataset.os)
    const next = osButtons[(at + (event.key === 'ArrowRight' ? 1 : osButtons.length - 1)) % osButtons.length]
    setOs(next.dataset.os, true); next.focus(); event.preventDefault()
  })
  setOs(/\bwin/i.test(navigator.userAgentData?.platform || navigator.userAgent) ? 'windows' : 'mac')
  // The buttons are their final width once the fonts are in; only then may the pill slide.
  ;(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
    placeOsPill()
    window.requestAnimationFrame(() => osPick.classList.add('ready'))
  })
  window.addEventListener('resize', placeOsPill)

  const SCREENS = {
    home: { w: 2880, h: 1600, alt: 'LoomWatch Home: the headline Put AI agents to work as one team, They improve themselves, a gold Build an agent button beside New team, a box to describe the job in plain words, the three steps Agents, Workflow and Chat, My agents as a row of your saved agents each with its little figure, and your teams as cards below.', cap: 'Home: start with an agent, then a team. Your agents sit in a row under My agents, each with its figure.' },
    agents: { w: 2880, h: 1600, alt: "LoomWatch's agent workbench for Writer: a sentence saying Writer thinks with Claude Opus 5.5, has one skill and asks before it may act, a mint-green figure at its desk with labels for its keys, its skills, the model it thinks with, its job and its tray, and on the right the blocks that make it, starting with Name and Instructions with a check of what good instructions say.", cap: 'An agent on its workbench: the figure shows what it has, the blocks beside it change it, and the sentence on top says what it all adds up to.' },
    workflow: { w: 2880, h: 1600, alt: 'LoomWatch Workflow for a daily tech digest: the team as one sentence, Every day at 9:00 AM and whenever you ask, Gatherer collects what is needed, then Reader does its part, and finally Writer writes the answer, each with its figure; on the left your saved agents ready to add; on the canvas a schedule trigger at 9 AM wired to Gatherer, Reader and Writer, and the team response.', cap: 'Workflow: your agents wired in order, read back as one sentence, with your saved agents one click away on the left.' },
    chat: { w: 2880, h: 1600, alt: "LoomWatch Chat: you ask the team for a short getting-started guide. Under your message, Researcher's figure, 1 reply and Waiting for you, then a card with Researcher's handover and Approve. On the right, the Replies tab shows what Researcher handed over, with a Details tab next to it.", cap: "Chat: what needs you waits in the chat, the agents' replies open beside it, and every step is a tab away in Details." },
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
      }
    }, { rootMargin: '0px 0px -30% 0px' })
    $$('.chapter, .act, #start').forEach((node) => seen.observe(node))

    // The team starts on its own when its chat comes into view, if nobody pressed Start: the
    // request is already in the box, and the Start button is pressed for you after a moment.
    // Watched by its step bar, which fits on any screen, unlike the whole window on a phone.
    const chatPanel = $('#act-chat .steps')
    let autoTimer = 0
    const autostart = new IntersectionObserver((entries) => {
      const inView = entries.some((e) => e.isIntersecting)
      window.clearTimeout(autoTimer)
      if (!inView || run) return
      boxGo.classList.add('nudge')
      autoTimer = window.setTimeout(() => { boxGo.classList.remove('nudge'); if (!run && boxPlace() === 'ask' && boxMode() === 'request') boxEl.requestSubmit ? boxEl.requestSubmit(boxGo) : startRun() }, reduced ? 600 : 2200)
    }, { threshold: 1, rootMargin: '0px 0px -25% 0px' })
    autostart.observe(chatPanel)
  } else {
    $$('.chapter, .act').forEach((node) => node.classList.add('seen'))
  }

  /* ================================================================ First paint */

  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark')
  renderAgent()
  renderTeamViews()
  renderChatUI(true)
  showScreen('home')
  paintProgress()
})()

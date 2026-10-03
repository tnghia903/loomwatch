// LoomWatch use cases. Tabs between five teams, their team files fetched from the site, and one
// real run told step by step from usecases-run.json, which holds that run's texts verbatim.
// No dependencies; the page reads without it, minus the recorded run.
(() => {
  'use strict'

  const root = document.documentElement
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const $ = (sel, from = document) => from.querySelector(sel)
  const $$ = (sel, from = document) => [...from.querySelectorAll(sel)]
  const store = {
    get(key) { try { return window.localStorage.getItem(key) } catch { return null } },
    set(key, value) { try { window.localStorage.setItem(key, value) } catch { /* private window */ } },
  }
  function el(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue
      if (key === 'text') node.textContent = value
      else if (key === 'html') node.innerHTML = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value === true ? '' : value)
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid)
    return node
  }
  const clock = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`)

  /* ================================================================ Markdown, just enough */

  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  function inline(text) {
    return escape(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // A link's address may itself hold one pair of brackets, as Navipedia's do.
      .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
  }
  const isAside = (line) => /^\*\((First-step|This is a first-step)/.test(line.trim())
  // Blocks: headings, lists, rules, and paragraphs whose single line breaks are kept, the way the
  // team wrote them.
  function markdown(md) {
    const out = []
    let para = []
    let list = null
    const flush = () => {
      if (para.length) out.push(`<p${para.every(isAside) ? ' class="aside"' : ''}>${para.map(inline).join('<br>')}</p>`)
      if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`)
      para = []; list = null
    }
    for (const raw of md.split('\n')) {
      const line = raw.trimEnd()
      const heading = line.match(/^(#{1,4}) (.*)$/)
      const bullet = line.match(/^\s*[-*] (.*)$/)
      const numbered = line.match(/^\s*\d+\. (.*)$/)
      if (!line.trim()) { flush(); continue }
      if (heading) { flush(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue }
      if (/^-{3,}$/.test(line)) { flush(); out.push('<hr>'); continue }
      const quote = line.match(/^>\s?(.*)$/)
      if (quote) { flush(); out.push(`<blockquote><p>${inline(quote[1])}</p></blockquote>`); continue }
      if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol'
        if (para.length || (list && list.tag !== tag)) flush()
        list = list || { tag, items: [] }
        list.items.push((bullet || numbered)[1])
        continue
      }
      if (list) flush()
      para.push(line)
    }
    flush()
    return out.join('')
  }

  /* ================================================================ Theme and progress */

  const themeButton = $('#theme')
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
  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark')

  const progress = $('.progress')
  let queued = false
  function paintProgress() {
    queued = false
    const max = root.scrollHeight - window.innerHeight
    progress.style.setProperty('--read', max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)).toFixed(4) : '0')
  }
  window.addEventListener('scroll', () => { if (!queued) { queued = true; window.requestAnimationFrame(paintProgress) } }, { passive: true })
  paintProgress()

  /* ================================================================ Screens from the app */

  // LoomWatch itself, captured during and after the same runs this page tells, in the page's theme.
  const SHOTS = {
    'learn-build': {
      alt: 'LoomWatch Build view of Learn from first principles: the sentence "When you ask, Mapper does its part, then you approve or send it back, then Teacher does its part, and finally Checker checks the work and replies", and a canvas of Mapper, You, Teacher and Checker, with one skill card, explain-like-im-5, wired to Mapper, Teacher and Checker.',
      cap: 'Build: the team as one sentence, and as a canvas. One skill card, explain-like-im-5, is wired to Mapper, Teacher and Checker, on two different apps.',
    },
    'learn-stop': {
      alt: 'LoomWatch Run view, paused at the review stop: the timeline with Mapper done and You waiting, the stage cards each showing explain-like-im-5 opened, and the handover panel with Mapper’s ladder and the buttons Send back to Mapper, Approve and Stop.',
      cap: 'Run, at your stop: Mapper’s handover is open, and nothing is taught until you approve, send it back, or say where to start.',
    },
    'learn-done': {
      alt: 'LoomWatch Run view after the run: a run receipt reading Took 7m 9s, Ran on Claude Code and Codex, with Mapper, Teacher and Checker each having used 1 skill, beside the lesson Checker handed back, marked Nothing flagged, and the offer to keep 1 new note for the next run.',
      cap: 'Run, finished: the receipt (7m 9s, on Claude Code and Codex, every agent used the skill) beside the lesson Checker handed back, and the Notebook’s offer to keep what you learned.',
    },
    'digest-build': {
      alt: 'LoomWatch Build view of Daily tech digest: the sentence "Every day at 9:00 AM and whenever you ask, Gatherer collects what is needed, then Reader does its part, and finally Writer writes the answer", and a canvas starting from a Schedule trigger card, Daily at 9:00 AM, then Gatherer, Reader and Writer.',
      cap: 'Build: “Every day at 9:00 AM” leads the sentence, and a schedule card starts the canvas.',
    },
    'digest-done': {
      alt: 'LoomWatch Run view of a scheduled run: a run receipt listing Gatherer’s 11 searches and two failed commands, Reader reading 10 web pages and failing to open one site, and Writer finished, beside the digest titled Tech today, marked 3 things to check.',
      cap: 'Its scheduled run, finished: the receipt counts the searches and pages, and flags the two commands that never ran and the one page Reader couldn’t open, beside the digest it wrote.',
    },
  }
  function paintShots() {
    const mode = root.dataset.theme === 'light' ? 'light' : 'dark'
    $$('.uc-shots').forEach((figure) => {
      const img = $('img', figure)
      const src = `assets/usecases/${img.dataset.shot}-${mode}.png`
      if (img.getAttribute('src') !== src) img.src = src
      $('a.shot', figure).href = src
    })
  }
  function showShot(figure, id, focus = false) {
    const tabs = $$('[role="tab"]', figure)
    tabs.forEach((tab) => {
      const on = tab.dataset.shot === id
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (on && focus) tab.focus()
      if (on) $('a.shot', figure).setAttribute('aria-labelledby', tab.id)
    })
    const img = $('img', figure)
    img.dataset.shot = id
    img.alt = SHOTS[id].alt
    $('.shot-cap', figure).textContent = SHOTS[id].cap
    paintShots()
  }
  $$('.uc-shots').forEach((figure) => {
    const tabs = $$('[role="tab"]', figure)
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => showShot(figure, tab.dataset.shot))
      tab.addEventListener('keydown', (event) => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
        if (!step) return
        showShot(figure, tabs[(i + step + tabs.length) % tabs.length].dataset.shot, true)
        event.preventDefault()
      })
    })
    showShot(figure, tabs[0].dataset.shot)
  })

  /* ================================================================ Tabs */

  const tabs = $$('.uc-tabs [role="tab"]')
  const CASES = tabs.map((tab) => tab.dataset.case)
  function selectCase(id, { focus = false, scroll = false, push = true } = {}) {
    if (!CASES.includes(id)) return
    tabs.forEach((tab) => {
      const on = tab.dataset.case === id
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (on && focus) tab.focus()
      if (on && tab.scrollIntoView && window.matchMedia('(max-width: 900px)').matches) tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
    })
    $$('.uc-panel').forEach((panel) => { panel.hidden = panel.id !== id })
    $$('#cover thead button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.case === id)))
    $$('#cover td').forEach((cell) => cell.classList.toggle('col-on', cell.dataset.case === id))
    if (push && window.history.replaceState) window.history.replaceState(null, '', `#${id}`)
    if (scroll) {
      const top = $('.uc-cases').getBoundingClientRect().top + window.scrollY - 76
      window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' })
    }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectCase(tab.dataset.case))
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key]
      let next = step === undefined ? null : (i + step + tabs.length) % tabs.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = tabs.length - 1
      if (next === null) return
      selectCase(tabs[next].dataset.case, { focus: true })
      event.preventDefault()
    })
  })
  // A link to a part of a panel (#run, #skill, #lesson) opens the panel it lives in.
  function caseFromHash() {
    const id = window.location.hash.slice(1)
    if (!id) return null
    if (CASES.includes(id)) return id
    const target = document.getElementById(id)
    const panel = target && target.closest('.uc-panel')
    return panel ? panel.id : null
  }
  window.addEventListener('hashchange', () => {
    const id = caseFromHash()
    if (!id) return
    selectCase(id, { push: false })
    const target = document.getElementById(window.location.hash.slice(1))
    if (target && !CASES.includes(target.id)) target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' })
  })

  /* ================================================================ Team files */

  function highlightYaml(text) {
    return text.split('\n').map((line) => {
      if (/^\s*#/.test(line)) return `<span class="c">${escape(line)}</span>`
      const key = line.match(/^(\s*-?\s*)([A-Za-z][\w-]*)(:)(.*)$/)
      if (key) return `${escape(key[1])}<span class="k">${escape(key[2])}${key[3]}</span>${escape(key[4])}`
      return escape(line)
    }).join('\n')
  }
  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied'
    } catch {
      button.textContent = 'Select and copy'
    }
    window.setTimeout(() => { button.textContent = 'Copy' }, 1600)
  }
  $$('details.file').forEach((details) => {
    details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.loaded) return
      details.dataset.loaded = '1'
      const body = $('.file-body', details)
      const src = details.dataset.src
      const name = src.split('/').pop()
      try {
        const response = await fetch(src)
        if (!response.ok) throw new Error(String(response.status))
        const text = await response.text()
        const copy = el('button', { class: 'btn', type: 'button', text: 'Copy', onclick: (event) => copyText(text, event.currentTarget) })
        const save = el('a', { class: 'btn', href: src, download: name, text: 'Download' })
        const pre = el('pre', { tabindex: '0', 'aria-label': name })
        pre.innerHTML = src.endsWith('.yaml') ? highlightYaml(text) : escape(text)
        body.replaceChildren(el('div', { class: 'file-acts' }, copy, save), pre)
      } catch {
        body.replaceChildren(el('p', { class: 'file-err' }, 'This file could not be loaded here. ', el('a', { class: 'link-inline', href: src, download: name, text: 'Download it' }), ' instead.'))
      }
    })
  })

  /* ================================================================ Coverage */

  // One row per capability; a mark only where that team file has the line that turns it on.
  const COVERAGE = [
    ['Mix AI companies on one team', 'Each agent on its own app and model', ['learn', 'digest']],
    ['You as a step: the review stop', 'Nothing moves on until you answer', ['learn']],
    ['On a schedule, with nobody watching', 'A time and a request in the team file', ['digest']],
    ['One skill, handed to several agents', 'The same instructions reach Claude and Codex', ['learn']],
    ['Agents ask each other', 'Questions go through LoomWatch, on the record', ['learn', 'digest']],
    ['Search the web, and nothing else', 'Anything not switched on waits for you, or is declined', ['learn', 'digest']],
    ['A Brief every agent reads', 'Shared instructions beside the team file', ['learn', 'digest']],
    ['A Notebook that keeps what you teach it', 'Notes you keep reach the next run', ['learn', 'digest']],
  ]
  const coverBody = $('#cover tbody')
  for (const [what, detail, cases] of COVERAGE) {
    coverBody.append(el('tr', {},
      el('th', { scope: 'row' }, what, el('small', { text: detail })),
      CASES.map((id) => el('td', { 'data-case': id }, cases.includes(id) ? [el('span', { class: 'on', 'aria-hidden': 'true' }), el('span', { class: 'sr', text: 'Yes' })] : el('span', { class: 'sr', text: 'No' }))),
    ))
  }
  $$('#cover thead button').forEach((button) => button.addEventListener('click', () => selectCase(button.dataset.case, { scroll: true, focus: true })))

  /* ================================================================ The recorded run */

  const STEPS = [
    { id: 'mapper', n: 1, label: 'Dig down' },
    { id: 'review', n: 2, label: 'You decide' },
    { id: 'teacher', n: 3, label: 'Build up' },
    { id: 'checker', n: 4, label: 'Check' },
  ]
  const view = { step: 'mapper', rung: null }
  let run = null

  function renderSteps() {
    const host = $('#steps')
    host.replaceChildren(...STEPS.map((step) => {
      const stage = run.stages.find((s) => s.id === step.id)
      const who = stage.app ? `${stage.name} · ${stage.app} ${stage.model}` : 'Answered the stop'
      return el('button', {
        type: 'button', role: 'radio', class: `step${step.id === 'review' ? ' you' : ''}`,
        'aria-checked': String(view.step === step.id), tabindex: view.step === step.id ? '0' : '-1',
        onclick: () => setStep(step.id),
      },
      el('span', { class: 'top-line' }, el('span', { class: 'n', text: String(step.n) }), step.label),
      el('span', { class: 'nm', text: step.id === 'review' ? 'You' : stage.name }),
      el('span', { class: 'ap', text: `${step.id === 'review' ? 'Answered the stop' : `${stage.app} · ${stage.model}`} · ${clock(stage.seconds)}` }),
      )
    }))
  }
  function setStep(id, focus = false) {
    view.step = id
    view.rung = null
    renderRun()
    if (focus) $(`#steps [aria-checked="true"]`).focus()
  }
  $('#steps').addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
    if (step === undefined) return
    const at = STEPS.findIndex((s) => s.id === view.step)
    setStep(STEPS[(at + step + STEPS.length) % STEPS.length].id, true)
    event.preventDefault()
  })

  const lessonFor = (step) => (step === 'teacher' ? run.teacher : step === 'checker' ? run.checker : null)
  const sameRung = (a, b) => ['title', 'body', 'picture', 'breaks', 'why', 'check', 'answer'].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))

  function renderLadder() {
    const known = view.step === 'mapper' ? [] : run.review.skipped
    const lesson = lessonFor(view.step)
    const items = run.mapper.ladder.map((rung) => {
      const taught = lesson && lesson.rungs.find((r) => r.n === rung.n)
      const draft = run.teacher.rungs.find((r) => r.n === rung.n)
      const isKnown = known.includes(rung.n)
      let tag = null
      if (isKnown) tag = 'You knew this'
      else if (view.step === 'checker' && taught && draft && !sameRung(taught, draft)) tag = 'Corrected by Checker'
      else if (view.step === 'mapper') tag = `needs ${rung.needs}`
      const cls = ['rung', isKnown ? 'known' : '', taught ? 'taught' : '', tag === 'Corrected by Checker' ? 'fixed' : ''].filter(Boolean).join(' ')
      return el('li', { class: cls },
        el('button', { type: 'button', 'aria-pressed': String(view.rung === rung.n), onclick: () => { view.rung = view.rung === rung.n ? null : rung.n; renderRun() } },
          el('span', { class: 'n', text: String(rung.n) }),
          el('span', { class: 'c', text: taught ? taught.title : rung.claim }),
          tag ? el('span', { class: 'tag', text: tag }) : null,
        ))
    })
    $('#ladder').replaceChildren(...items)
    $('#ladder-q').replaceChildren(el('small', { text: 'The question' }), run.mapper.question)
    $('#bedrock').replaceChildren(el('span', { class: 'micro', text: 'Bedrock: what you already know' }), el('ul', {}, run.mapper.bedrock.map((fact) => el('li', { text: fact }))))
  }

  function rungBody(lines) {
    const host = el('div', { class: 'md' })
    host.innerHTML = markdown(lines.join('\n\n').replace(/\n\n(?=[-*] )/g, '\n'))
    return host
  }
  function sideRung(lesson, n, who) {
    const rung = lesson.rungs.find((r) => r.n === n)
    const answer = el('p', { class: 'a', hidden: true, html: `<b>Answer:</b> ${inline(rung.answer)}` })
    const reveal = el('button', { class: 'btn', type: 'button', text: 'Show the answer', onclick: (event) => { answer.hidden = false; event.currentTarget.remove() } })
    return [
      el('p', { class: 'micro who', text: `Rung ${n} · ${who}` }),
      el('h3', { text: rung.title }),
      rungBody(rung.body),
      el('dl', { class: 'kv' },
        el('div', {}, el('dt', { text: 'Picture it' }), el('dd', { class: 'md', html: markdown(rung.picture) })),
        el('div', { class: 'breaks' }, el('dt', { text: 'Where the picture breaks' }), el('dd', { class: 'md', html: markdown(rung.breaks) })),
        el('div', {}, el('dt', { text: 'Why it has to be so' }), el('dd', { class: 'md', html: markdown(rung.why) })),
      ),
      el('div', { class: 'check' }, el('p', { class: 'q', html: inline(rung.check) }), answer, reveal),
    ]
  }

  function renderSide() {
    const side = $('#run-side')
    const stage = run.stages.find((s) => s.id === view.step)
    let kids
    if (view.step === 'mapper') {
      if (view.rung) {
        const rung = run.mapper.ladder.find((r) => r.n === view.rung)
        kids = [
          el('p', { class: 'micro who', text: `Rung ${rung.n} · as Mapper dug it` }),
          el('h3', { text: rung.claim }),
          el('p', { html: inline(rung.detail) }),
          el('p', { class: 'side-foot', text: `Rests on ${rung.needs}.` }),
        ]
      } else {
        kids = [
          el('p', { class: 'micro who', text: `Mapper · Claude ${stage.model} · ${clock(stage.seconds)}` }),
          el('h3', { text: 'Dug down to what you already know, then refused the big words.' }),
          el('p', { text: 'The usual answer hides its steps inside words a five-year-old can’t check. Mapper named each one and the rung that would build it, before anything was taught.' }),
          el('ul', { class: 'waves' }, run.mapper.waves.map((wave) => el('li', {}, el('s', { text: wave.words }), el('span', { html: inline(wave.note) })))),
          el('p', { class: 'side-foot', text: 'Pick a rung to read what Mapper said it needs.' }),
        ]
      }
    } else if (view.step === 'review') {
      kids = [
        el('p', { class: 'micro who', text: `The run stopped for ${clock(stage.seconds)}` }),
        el('h3', { text: 'Nothing was taught until the learner answered.' }),
        el('p', { class: 'asked', html: `<b>The stop asked:</b> ${inline(run.review.question)}` }),
        el('p', { class: 'said' }, el('small', { text: 'The learner answered' }), run.review.answer),
        el('p', { text: `So Teacher started at rung ${Math.max(...run.review.skipped) + 1}, and left Wi-Fi and phone towers for “Where to go next”, as the learner asked.` }),
        el('p', { class: 'side-foot', text: 'An answer can also send the ladder back to Mapper, with a note on what to change.' }),
      ]
    } else {
      const lesson = lessonFor(view.step)
      const who = view.step === 'teacher' ? 'Teacher’s first draft' : 'the lesson as handed back'
      const n = view.rung && !run.review.skipped.includes(view.rung) ? view.rung : null
      if (n) {
        kids = sideRung(lesson, n, who)
      } else if (view.rung) {
        const rung = run.mapper.ladder.find((r) => r.n === view.rung)
        kids = [
          el('p', { class: 'micro who', text: `Rung ${rung.n} · skipped` }),
          el('h3', { text: rung.claim }),
          el('p', { text: 'The learner said they knew this, so the lesson lists it under “What you already know” instead of teaching it.' }),
        ]
      } else if (view.step === 'teacher') {
        kids = [
          el('p', { class: 'micro who', text: `Teacher · Claude ${stage.model} · ${clock(stage.seconds)}` }),
          el('h3', { text: 'Built back up, one idea per rung.' }),
          el('p', { class: 'said' }, el('small', { text: 'The short answer, first draft' }), el('span', { html: inline(run.teacher.short) })),
          el('p', { text: 'Every rung explains the idea before it names it, gives one picture from a child’s day, says where that picture breaks, and ends with a question.' }),
          el('p', { class: 'side-foot', text: 'Pick a gold rung to read Teacher’s draft of it.' }),
        ]
      } else {
        kids = [
          el('p', { class: 'micro who', text: `Checker · Codex ${stage.model} · ${clock(stage.seconds)}` }),
          el('h3', { text: `A second company’s model made ${run.checker.changes.length} corrections.` }),
          el('p', { text: checkerDid() }),
          changeList(run.checker.changes),
          run.checker.note ? el('p', { class: 'said' }, el('small', { text: 'It left a note in the Notebook, for you to keep or not' }), el('span', { html: `<strong>${escape(run.checker.note.title)}.</strong> ${inline(run.checker.note.body)}` })) : null,
          el('p', { class: 'side-foot', text: 'Pick a rung to read the corrected version. Compare it with step 3.' }),
        ]
      }
    }
    // Step by step, in the order the run went: the side panel ends with the way to the next step.
    const at = STEPS.findIndex((s) => s.id === view.step)
    if (!view.rung && at < STEPS.length - 1) {
      const next = STEPS[at + 1]
      kids.push(el('button', { class: 'btn btn-primary next-step', type: 'button', onclick: () => { setStep(next.id); $('#steps [aria-checked="true"]').focus({ preventScroll: true }) } }, `Next: ${next.label}`, el('span', { 'aria-hidden': 'true', text: '→' })))
    }
    side.replaceChildren(...kids)
  }

  // The first few changes, and the rest one click away: thirteen bullets would bury the ladder.
  function changeList(changes, shown = 4) {
    const list = el('ol', { class: 'changes' }, changes.map((change, i) => el('li', { html: inline(change), hidden: i >= shown })))
    if (changes.length <= shown) return list
    const more = el('button', {
      class: 'btn more', type: 'button', text: `Show all ${changes.length} changes`,
      onclick: (event) => { $$('li', list).forEach((li) => { li.hidden = false }); event.currentTarget.remove() },
    })
    return el('div', {}, list, more)
  }

  // What the record shows Checker did, in words: the ask, the searches, and the sites it cited.
  function checkerDid() {
    const sites = [...new Set([...run.checker.markdown.matchAll(/\]\((https?:\/\/[^)\s]+)/g)].map((m) => new URL(m[1]).hostname.split('.').slice(-2).join('.')))]
    const parts = []
    if (run.checker.asked) parts.push(`asked ${run.checker.asked.agent === 'teacher' ? 'Teacher' : run.checker.asked.agent} for the whole lesson through LoomWatch`)
    if (run.checker.searches) parts.push(`ran ${run.checker.searches} web ${run.checker.searches === 1 ? 'search' : 'searches'}`)
    if (sites.length) parts.push(`cited ${sites.slice(0, -1).join(', ')}${sites.length > 1 ? ' and ' : ''}${sites.at(-1)} where it changed a fact`)
    if (!parts.length) return 'It checked the lesson against the skill’s rules.'
    const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`
    return `It ${text}.`
  }

  function renderRun() {
    renderSteps()
    renderLadder()
    renderSide()
  }

  async function loadRun() {
    try {
      const response = await fetch('usecases-run.json')
      if (!response.ok) throw new Error(String(response.status))
      run = await response.json()
    } catch {
      $('#run-view').replaceChildren(el('p', { class: 'uc-note', text: 'The recorded run could not be loaded. Open this page from its web address, not as a file.' }))
      return
    }
    $('#run-prompt').textContent = `“${run.prompt}”`
    $('#run-badge').textContent = `Done · ${clock(run.seconds)}`
    const total = run.stages.filter((s) => s.app)
    $('#run-note').textContent = `A real run, start to finish in ${clock(run.seconds)}: ${total.map((s) => `${s.name} on ${s.app}`).join(', ')}, and the learner at the stop. The texts are the team’s own, word for word; this page adds only the layout. The skill reached all three agents with the same fingerprint (${run.skill.sha256.slice(0, 8)}), on two different apps, and each one opened it.`
    const lesson = $('#lesson-body')
    lesson.innerHTML = (run.checker.prelude ? `<div class="prelude">${markdown(run.checker.prelude)}</div>` : '') + markdown(run.checker.markdown)
    renderRun()
  }

  /* ================================================================ First paint */

  selectCase(caseFromHash() || 'learn', { push: false })
  if (window.location.hash && !CASES.includes(window.location.hash.slice(1))) {
    const target = document.getElementById(window.location.hash.slice(1))
    if (target) window.setTimeout(() => target.scrollIntoView(), 0)
  }
  loadRun()
})()

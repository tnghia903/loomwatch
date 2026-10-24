// The landing page's "Then · It improves" chapter: Writer's work in two teams, and the lessons it
// kept (ADR 0078). The chat plays once, step by step, when it comes into view. Undo in the chat and
// Forget on the Learned tab take back the same lesson, and the later work shows what that changes:
// without the checker's lesson, the first draft in the Launch team has no sources, and the checker
// sends it back again. Play again puts every lesson back and plays the chat from the top. Without
// this script the page reads as written: every lesson learned, the later draft passing its check.
(() => {
  'use strict'

  const win = document.getElementById('learn')
  if (!win) return
  const ALL = ['src', 'bold']
  const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false
  const count = win.querySelector('[data-learn-count]')
  const shown = (node) => !node.closest('[hidden]')
  const learned = () => (win.dataset.learned || '').split(' ').filter(Boolean)

  // What Writer has learned decides what shows: `data-when="src"` while it has that lesson,
  // `data-when="!src"` while it hasn't, and `data-when="none"` once it has none.
  function show(lessons) {
    win.dataset.learned = lessons.join(' ')
    for (const node of win.querySelectorAll('[data-when]')) {
      const when = node.dataset.when
      node.hidden = when === 'none' ? lessons.length > 0 : when.startsWith('!') ? lessons.includes(when.slice(1)) : !lessons.includes(when)
    }
    count.textContent = String(lessons.length)
  }

  // Undo and Forget take a lesson back, and their button goes with it: the keyboard moves on to the
  // next one in the same tab, or to what stays there.
  function takeBack(button) {
    const panel = button.closest('[role="tabpanel"]')
    const buttons = [...panel.querySelectorAll('[data-undo]')]
    const at = buttons.indexOf(button)
    show(learned().filter((lesson) => lesson !== button.dataset.undo))
    const left = buttons.filter(shown)
    const next = left.find((b) => buttons.indexOf(b) > at) || left.at(-1) || panel.querySelector('[data-learn-rest]')
    if (next) next.focus()
  }

  // The chat and the Learned list are two tabs of one window, as the team's are in Step 2.
  const tabs = [...win.querySelectorAll('[data-learn-tab]')]
  function showTab(name, focus = false) {
    for (const tab of tabs) {
      const on = tab.dataset.learnTab === name
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !on
      if (on && focus) tab.focus()
    }
  }
  tabs.forEach((tab, i) => tab.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
    if (!step) return
    showTab(tabs[(i + step + tabs.length) % tabs.length].dataset.learnTab, true)
    event.preventDefault()
  }))

  // The chat plays its steps one after another (styles.css, .win-learn.played). Under reduced motion
  // it is simply all there.
  function play() {
    if (reduced) return
    win.classList.remove('played')
    void win.offsetWidth
    win.classList.add('played')
  }

  win.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button) return
    if (button.dataset.undo) takeBack(button)
    else if (button.dataset.learnTab) showTab(button.dataset.learnTab)
    else if (button.hasAttribute('data-learn-replay')) {
      // From the Learned tab, the chat takes its place: the keyboard goes to the chat's tab.
      const away = !shown(button) || button.closest('[role="tabpanel"]').id !== 'learn-chat'
      show(ALL)
      showTab('chat', away)
      play()
    }
  })

  if (!reduced && 'IntersectionObserver' in window) {
    win.classList.add('will-play')
    // Its top in the upper three quarters of the window, however tall the chat is on a phone.
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      seen.disconnect()
      win.classList.add('played')
    }, { rootMargin: '0px 0px -25% 0px' })
    seen.observe(win.querySelector('.learn-log'))
  }
  show(learned())
})()

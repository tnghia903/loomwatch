/**
 * What runs a page (ADR 0125), in two places, each passed in as source text by `./document.ts`
 * and so each self-contained: no imports, nothing from this module's scope.
 *
 * - {@link pageRenderer} runs in the page's frame. It is the only script there. It draws the
 *   agent's markup, cleaned, keeps the page's fields and figures bound to LoomWatch's values,
 *   hands events to the worker and passes the few things a page may ask on to the chat.
 * - {@link workerMain} starts the worker the agent's script runs in, apart from the page. It
 *   can't touch the page, move the frame to an address or keep the chat from working, and the
 *   frame's policy stops it reaching anything. It gives the script `lw`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the protocol's messages are plain data */

/** The page's half of the frame: see the module's description. */
export function pageRenderer(
  clean: (fragment: DocumentFragment | Element) => void,
  drawInto: (live: Element, next: Element | DocumentFragment) => void,
): void {
  const boot = JSON.parse(document.getElementById('lw-boot')?.textContent ?? '{}') as { token: string; html: string; script: string; worker: string }
  const root = document.getElementById('lw-root') as HTMLElement
  const look = document.getElementById('lw-look') as HTMLStyleElement
  const send = (message: Record<string, unknown>): void => window.parent.postMessage({ ...message, lw: boot.token }, '*')

  let values: any = { inputs: {}, results: {}, written: {}, presets: [], declared: [] }
  let worker: Worker | null = null
  let broken = false
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let reduced = motion.matches

  // A tap or a key is what lets a page put words in the message box, or keep what it set.
  let gestureAt = -Infinity
  const gestured = (): boolean => performance.now() - gestureAt < 1500
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { gestureAt = performance.now() }, true)

  const breakWith = (why: string): void => {
    if (broken) return
    broken = true
    stopFrames()
    worker?.terminate()
    send({ t: 'broke', why: String(why).slice(0, 200) })
  }

  // --- Drawing ---------------------------------------------------------------------------------

  const parse = (html: string): DocumentFragment => {
    const holder = document.createElement('template')
    holder.innerHTML = html
    clean(holder.content)
    return holder.content
  }
  const reportHeight = (): void => send({ t: 'height', px: Math.ceil(document.documentElement.scrollHeight) })
  const shown = (id: string): boolean => {
    const value = id in values.results ? values.results[id] : values.inputs[id]
    return typeof value === 'number' ? value !== 0 : Boolean(value)
  }
  const bind = (): void => {
    for (const element of Array.from(root.querySelectorAll('[data-result]'))) {
      element.textContent = values.written[element.getAttribute('data-result') ?? ''] ?? '—'
    }
    for (const element of Array.from(root.querySelectorAll('[data-show]'))) {
      (element as HTMLElement).hidden = !shown(element.getAttribute('data-show') ?? '')
    }
    for (const element of Array.from(root.querySelectorAll('[data-input]'))) {
      const id = element.getAttribute('data-input') ?? ''
      const declared = values.declared.find((input: any) => input.id === id)
      if (!declared) continue
      if (!element.hasAttribute('aria-label') && !element.id) element.setAttribute('aria-label', declared.label)
      const value = values.inputs[id]
      if (element instanceof HTMLInputElement && element.type === 'checkbox') element.checked = Boolean(value)
      else if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
        if (element instanceof HTMLInputElement) {
          for (const bound of ['min', 'max', 'step']) {
            if (declared[bound] !== undefined && !element.hasAttribute(bound)) element.setAttribute(bound, String(declared[bound]))
          }
        }
        if (element !== document.activeElement) element.value = String(value)
      }
    }
    for (const holder of Array.from(root.querySelectorAll('[data-presets]'))) {
      holder.classList.add('lw-cases')
      holder.replaceChildren(...values.presets.map((preset: any, at: number) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('aria-pressed', String(Boolean(preset.on)))
        button.setAttribute('data-lw-preset', String(at))
        // The one set now has a check as well as its ring: never colour alone.
        if (preset.on) {
          const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          mark.setAttribute('viewBox', '0 0 12 12')
          mark.setAttribute('width', '12')
          mark.setAttribute('height', '12')
          mark.setAttribute('aria-hidden', 'true')
          const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          tick.setAttribute('d', 'M2 6.5L5 9.5L10 3')
          tick.setAttribute('fill', 'none')
          tick.setAttribute('stroke', 'var(--accent)')
          tick.setAttribute('stroke-width', '1.8')
          tick.setAttribute('stroke-linecap', 'round')
          tick.setAttribute('stroke-linejoin', 'round')
          mark.append(tick)
          button.append(mark)
        }
        button.append(String(preset.label))
        return button
      }))
    }
  }
  /** Draw `html` as the whole page, or as what the element with id `into` holds. */
  const draw = (html: string, into?: string): void => {
    const target = into ? Array.from(root.querySelectorAll('[id]')).find((element) => element.id === into) : undefined
    drawInto(target ?? root, parse(html))
    bind()
    takeCanvases()
    reportHeight()
  }
  /** The look's colours and fonts, for what the script draws on a canvas, where CSS can't reach. */
  const COLOURS = ['ink', 'ink-2', 'ink-3', 'panel', 'well', 'line', 'hairline', 'accent', 'accent-tint', 'ok', 'alert', 'series-1', 'series-2', 'series-3']
  const lookForWorker = (): Record<string, unknown> => {
    const computed = getComputedStyle(document.documentElement)
    const colors: Record<string, string> = {}
    for (const name of COLOURS) colors[name] = computed.getPropertyValue(`--${name}`).trim()
    return { colors, fonts: { sans: computed.getPropertyValue('--font-sans').trim(), serif: computed.getPropertyValue('--font-serif').trim() } }
  }

  // --- Events, from the person to the chat and the script --------------------------------------

  const detail = (element: Element): Record<string, unknown> => {
    const data: Record<string, string> = {}
    for (const [key, value] of Object.entries((element as HTMLElement).dataset)) {
      if (!['act', 'input', 'result', 'show', 'key', 'canvas'].includes(key) && !key.startsWith('lw')) data[key] = value ?? ''
    }
    const field = element as HTMLInputElement
    return { value: 'value' in field ? field.value : null, checked: 'checked' in field ? field.checked : null, data }
  }
  const onField = (target: EventTarget | null, committed: boolean): void => {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return
    const id = target.getAttribute('data-input')
    if (id) {
      const isSwitch = target instanceof HTMLInputElement && target.type === 'checkbox'
      const number = Number(target.value)
      if (isSwitch || (target.value.trim() !== '' && Number.isFinite(number))) {
        send({ t: 'set', id, value: isSwitch ? (target as HTMLInputElement).checked : number, keep: committed, gesture: gestured() })
      }
    }
    const act = target.getAttribute('data-act')
    if (act) toWorker({ t: 'act', name: act, event: detail(target) })
  }
  root.addEventListener('input', (event) => onField(event.target, false))
  root.addEventListener('change', (event) => onField(event.target, true))
  root.addEventListener('click', (event) => {
    const target = event.target as Element | null
    const preset = target?.closest('[data-lw-preset]')
    if (preset) {
      send({ t: 'preset', at: Number(preset.getAttribute('data-lw-preset')), gesture: gestured() })
      return
    }
    const acting = target?.closest('[data-act]')
    if (acting && !(acting instanceof HTMLInputElement || acting instanceof HTMLSelectElement || acting instanceof HTMLTextAreaElement)) {
      toWorker({ t: 'act', name: acting.getAttribute('data-act'), event: detail(acting) })
    }
  })

  // --- The worker --------------------------------------------------------------------------------

  const toWorker = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    if (worker && !broken) worker.postMessage(message, transfer)
  }
  const forWorker = (): Record<string, unknown> => ({
    values: { inputs: values.inputs, results: values.results, written: values.written },
    reducedMotion: reduced,
    width: root.clientWidth,
    ...lookForWorker(),
  })

  const canvases = new Set<string>()
  const takeCanvases = (): void => {
    for (const name of canvases) {
      const canvas = Array.from(root.querySelectorAll('canvas[data-canvas]')).find((each) => each.getAttribute('data-canvas') === name) as HTMLCanvasElement | undefined
      if (!canvas || canvas.hasAttribute('data-lw-taken')) continue
      if (typeof canvas.transferControlToOffscreen !== 'function') {
        breakWith('this browser can\'t draw on a canvas from the page\'s script')
        return
      }
      const box = canvas.getBoundingClientRect()
      const width = Math.max(1, Math.round(box.width || canvas.width))
      const height = Math.max(1, Math.round(box.height || canvas.height))
      const ratio = Math.min(3, window.devicePixelRatio || 1)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.setAttribute('data-lw-taken', '')
      const offscreen = canvas.transferControlToOffscreen()
      toWorker({ t: 'canvas', name, canvas: offscreen, width, height, ratio }, [offscreen])
    }
  }

  let paused = false
  let seen = true
  let wantFrames = false
  let frameBusy = false
  let elapsed = 0
  let lastTick: number | null = null
  let frameId = 0
  const running = (): boolean => wantFrames && !paused && seen && !reduced && !broken && document.visibilityState !== 'hidden'
  const tick = (now: number): void => {
    frameId = 0
    if (!running()) {
      lastTick = null
      return
    }
    if (lastTick !== null) elapsed += Math.min(0.1, (now - lastTick) / 1000)
    lastTick = now
    if (!frameBusy) {
      frameBusy = true
      toWorker({ t: 'frame', time: elapsed })
    }
    frameId = window.requestAnimationFrame(tick)
  }
  function startFrames(): void {
    if (!wantFrames || reduced) return
    if (!frameId && running()) frameId = window.requestAnimationFrame(tick)
  }
  function stopFrames(): void {
    if (frameId) window.cancelAnimationFrame(frameId)
    frameId = 0
    lastTick = null
  }
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? stopFrames() : startFrames()))
  // Reduce motion turned on or off while the page is open: it stops where it is, or moves again.
  motion.addEventListener('change', () => {
    reduced = motion.matches
    if (reduced) stopFrames()
    if (wantFrames) send({ t: 'moving', on: !reduced })
    toWorker({ t: 'values', ...forWorker() })
    if (!reduced) startFrames()
  })

  // A script that never stops answering is stopped: the chat goes on, and the page says so.
  let pingAt: number | null = null
  window.setInterval(() => {
    if (!worker || broken) return
    if (pingAt !== null) {
      if (performance.now() - pingAt > 4000) breakWith('its script ran too long without stopping')
      return
    }
    pingAt = performance.now()
    worker.postMessage({ t: 'ping' })
  }, 1000)

  const fromWorker = (message: any): void => {
    if (broken || !message) return
    switch (message.t) {
      case 'draw': draw(String(message.html), typeof message.into === 'string' ? message.into : undefined); break
      case 'frames':
        if (wantFrames) break
        wantFrames = true
        send({ t: 'moving', on: !reduced })
        // Its first frame at once, so a page that moves shows where it starts even paused, out
        // of sight or with motion reduced.
        frameBusy = true
        toWorker({ t: 'frame', time: elapsed })
        if (!reduced) startFrames()
        break
      case 'frame-done': frameBusy = false; break
      case 'set': send({ t: 'set', id: String(message.id), value: message.value, keep: gestured(), gesture: gestured() }); break
      case 'draft': if (gestured()) send({ t: 'draft', text: String(message.text).slice(0, 2000) }); break
      case 'canvas': canvases.add(String(message.name)); takeCanvases(); break
      case 'pong': pingAt = null; break
      case 'error': breakWith(String(message.message)); break
    }
  }

  const startWorker = (): void => {
    if (!boot.script) return
    const head = `(${boot.worker})(function (lw) {\n`
    const before = head.split('\n').length - 1
    try {
      worker = new Worker(URL.createObjectURL(new Blob([`${head}${boot.script}\n})`], { type: 'text/javascript' })))
    } catch (error) {
      breakWith(`this browser can't run the page's script (${(error as Error).message})`)
      return
    }
    worker.onmessage = (event) => fromWorker(event.data)
    worker.onerror = (event) => {
      event.preventDefault()
      const line = event.lineno ? ` (line ${Math.max(1, event.lineno - before)})` : ''
      breakWith(`${event.message || 'its script stopped'}${line}`)
    }
    toWorker({ t: 'values', ...forWorker() })
  }

  // --- The chat --------------------------------------------------------------------------------

  const applyLook = (given: any): void => {
    look.textContent = String(given?.css ?? '')
    document.documentElement.setAttribute('data-theme', given?.theme === 'dark' ? 'dark' : 'light')
  }
  let started = false
  window.addEventListener('message', (event) => {
    const message = event.data
    if (event.source !== window.parent || !message || message.lw !== boot.token) return
    try {
      switch (message.t) {
        case 'init':
          applyLook(message.look)
          values = message.values
          if (started) break
          started = true
          root.replaceChildren()
          if (boot.html) draw(boot.html)
          else bind()
          startWorker()
          reportHeight()
          break
        case 'values':
          values = message.values
          bind()
          toWorker({ t: 'values', ...forWorker() })
          break
        case 'look':
          applyLook(message.look)
          toWorker({ t: 'values', ...forWorker() })
          break
        case 'pause':
          paused = Boolean(message.on)
          if (paused) stopFrames()
          else startFrames()
          break
        case 'seen':
          seen = Boolean(message.on)
          if (seen) startFrames()
          else stopFrames()
          break
      }
    } catch (error) {
      breakWith(`LoomWatch couldn't draw it (${(error as Error).message})`)
    }
  })
  new ResizeObserver(reportHeight).observe(root)
  send({ t: 'ready' })
}

/** The worker's start, around the agent's script, `page`: see the module's description. */
export function workerMain(page: (lw: unknown) => void): void {
  const scope = self as any
  const post = (message: Record<string, unknown>): void => scope.postMessage(message)
  // The frame's policy already stops these; taking them away makes a page that tries one fail
  // plainly, here, instead of quietly.
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport', 'BroadcastChannel', 'indexedDB', 'caches']) {
    try {
      Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false })
    } catch {
      // Not there in this browser.
    }
  }
  let values: any = { inputs: {}, results: {}, written: {} }
  let started = false
  let time = 0
  let frame: ((seconds: number) => void) | null = null
  const listeners: ((values: unknown) => void)[] = []
  const acts: Record<string, (event: unknown) => void> = {}
  const canvases: Record<string, { draw: (...args: unknown[]) => void; context: any; width: number; height: number }> = {}
  const run = (fn: (...args: any[]) => void, ...args: unknown[]): void => {
    try {
      fn(...args)
    } catch (error) {
      post({ t: 'error', message: String((error as Error)?.message ?? error) })
    }
  }
  const paint = (): void => {
    for (const name of Object.keys(canvases)) {
      const canvas = canvases[name]
      if (canvas.context) run(canvas.draw, canvas.context, canvas.width, canvas.height, time)
    }
  }
  const lw = {
    get values() { return values },
    reducedMotion: false,
    width: 0,
    colors: {} as Record<string, string>,
    fonts: {} as Record<string, string>,
    draw(html: unknown, into?: unknown) { post({ t: 'draw', html: String(html), into: into === undefined ? undefined : String(into) }) },
    on(fn: (values: unknown) => void) {
      listeners.push(fn)
      if (started) run(fn, values)
    },
    frame(fn: (seconds: number) => void) {
      frame = fn
      post({ t: 'frames' })
    },
    act(name: unknown, fn: (event: unknown) => void) { acts[String(name)] = fn },
    set(id: unknown, value: unknown) { post({ t: 'set', id: String(id), value }) },
    draft(words: unknown) { post({ t: 'draft', text: String(words) }) },
    canvas(name: unknown, draw: (...args: unknown[]) => void) {
      canvases[String(name)] = { draw, context: null, width: 0, height: 0 }
      post({ t: 'canvas', name: String(name) })
    },
  }
  scope.addEventListener('unhandledrejection', (event: any) => post({ t: 'error', message: String(event.reason?.message ?? event.reason) }))
  scope.onmessage = (event: MessageEvent) => {
    const message = event.data
    switch (message?.t) {
      case 'values':
        values = message.values
        lw.reducedMotion = Boolean(message.reducedMotion)
        lw.width = Number(message.width) || 0
        lw.colors = message.colors ?? {}
        lw.fonts = message.fonts ?? {}
        if (!started) {
          run(page, lw)
          started = true
        }
        for (const fn of listeners) run(fn, values)
        paint()
        break
      case 'frame':
        time = Number(message.time) || 0
        if (frame) run(frame, time)
        paint()
        post({ t: 'frame-done' })
        break
      case 'act':
        if (acts[message.name]) run(acts[message.name], message.event)
        break
      case 'canvas': {
        const canvas = canvases[message.name]
        if (!canvas) break
        const context = message.canvas.getContext('2d')
        context.scale(message.ratio, message.ratio)
        canvas.context = context
        canvas.width = message.width
        canvas.height = message.height
        run(canvas.draw, context, canvas.width, canvas.height, time)
        break
      }
      case 'ping':
        post({ t: 'pong' })
        break
    }
  }
}

import { readFile, rawFileUrl } from './reader'

/**
 * A web page an agent made, shown in the reader (ADR 0077). It runs as it would in a browser — its
 * own scripts and styles, and those it loads from the web — but in a sandbox of its own: a frame
 * with no origin, so it cannot reach LoomWatch's page or the daemon, under a policy that lets it
 * fetch nothing and reach nothing on this computer (`https:` only). A small script LoomWatch adds
 * tells the reader what is marked, so a part of the page can be asked about as any file's can, and
 * shows the parts already asked about. The files beside the page — its data, clips, pictures and
 * fonts — are read for it by the reader, inside the page's own folder and the folders in it only
 * (ADR 0091): a dashboard's `fetch('sales.csv')` works, and nothing above its folder is reached.
 */

/** What the page may load: from the web over https, or from itself. Nothing on this computer, no requests of its own, no forms. */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  'img-src https: data: blob:',
  'font-src https: data:',
  'media-src https: data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  'worker-src blob:',
].join('; ')

/**
 * A part's bubble's point (PartBubble.tsx `BubblePoint`), a chat bubble's tail low on its left, in a
 * 10 by 7 box placed 5px left of the bubble and 13px down: a flat bottom and a side at 45° that leave
 * the round end where its edge is and meet at an acute angle pointing left, at the words. Filled in
 * the bubble's colour over the circle's edge between them, and edged on those two sides only.
 */
export const BUBBLE_POINT_FILL = 'M1 6 L5.56 1.45 L10 1.45 L10 6 Z'
export const BUBBLE_POINT_EDGE = 'M5.56 1.45 L1 6 L8.45 6'

/** The sandbox the frame runs in: scripts, and links that open in a browser, but no origin. */
export const PAGE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

/**
 * The script added to the page. It reports the marked words and where they are, lets go of them on
 * Escape (the key reaches the page, not the reader, once words in it are marked; with none marked it
 * passes the key on), opens web links
 * outside the reader, and lights the part being asked about. It says where each part already asked
 * about is, line by line and whether the page is dark behind it, as the page scrolls (the reader
 * draws their marks over the frame), or that the page no longer has it, and which one was clicked,
 * so its answer opens beside it. Parts are found as the reader finds them: whitespace aside.
 * Written as plain script, not compiled: it runs inside the page.
 */
export const PAGE_BRIDGE = `(function () {
  var send = function (message) { message.lw = 'reader'; parent.postMessage(message, '*'); };
  // The page's own files (ADR 0091). The frame can reach nothing itself, so what the page asks for
  // beside it — by fetch, by XMLHttpRequest, or as a clip to play — is asked of the reader, which
  // reads it inside the page's folder and hands the bytes back. Anything else is left to the page's
  // own fetch, which the policy stops, as before.
  var loads = {}, loadCount = 0;
  function beside(url) {
    var value = String(url == null ? '' : url).trim();
    return value !== '' && value.charAt(0) !== '#' && !/^[a-z][a-z0-9+.-]*:/i.test(value) && value.slice(0, 2) !== '//';
  }
  function load(url) {
    return new Promise(function (resolve) { var id = ++loadCount; loads[id] = resolve; send({ type: 'load', id: id, url: String(url) }); });
  }
  var pageFetch = window.fetch;
  window.fetch = function (input) {
    var url = typeof input === 'string' ? input : null;
    if (url === null || !beside(url)) return pageFetch.apply(this, arguments);
    return load(url).then(function (answer) {
      if (!answer.status) throw new TypeError('Failed to fetch');
      return new Response(answer.status === 200 ? answer.body : null, { status: answer.status, headers: { 'Content-Type': answer.type || 'application/octet-stream' } });
    });
  };
  // An XMLHttpRequest for a file beside the page, as far as the libraries that still use one read
  // it (PapaParse, jQuery): its events and handlers, its status and headers, and its response as
  // text, JSON, bytes or a blob. Any other address fails as the policy would make it.
  function PageRequest() {
    this.readyState = 0; this.status = 0; this.statusText = ''; this.response = null; this.responseText = ''; this.responseType = '';
    this.responseURL = ''; this.responseXML = null; this.timeout = 0; this.withCredentials = false;
    this.upload = { addEventListener: function () {}, removeEventListener: function () {} };
    this.onreadystatechange = this.onloadstart = this.onprogress = this.onload = this.onloadend = this.onerror = this.onabort = this.ontimeout = null;
    this.lwOn = {}; this.lwUrl = ''; this.lwType = ''; this.lwDone = false;
  }
  ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (name, value) { PageRequest[name] = value; PageRequest.prototype[name] = value; });
  PageRequest.prototype.addEventListener = function (type, listener) { (this.lwOn[type] = this.lwOn[type] || []).push(listener); };
  PageRequest.prototype.removeEventListener = function (type, listener) { var list = this.lwOn[type] || [], at = list.indexOf(listener); if (at >= 0) list.splice(at, 1); };
  PageRequest.prototype.lwFire = function (type) {
    var request = this, event = { type: type, target: request, currentTarget: request, lengthComputable: false, loaded: 0, total: 0 };
    if (typeof request['on' + type] === 'function') request['on' + type].call(request, event);
    (request.lwOn[type] || []).slice().forEach(function (listener) {
      if (typeof listener === 'function') listener.call(request, event);
      else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event);
    });
  };
  PageRequest.prototype.open = function (method, url) { this.lwUrl = String(url); this.lwDone = false; this.readyState = 1; this.lwFire('readystatechange'); };
  PageRequest.prototype.setRequestHeader = function () {};
  PageRequest.prototype.overrideMimeType = function () {};
  PageRequest.prototype.getResponseHeader = function (name) { return this.readyState >= 2 && this.lwType && String(name).toLowerCase() === 'content-type' ? this.lwType : null; };
  PageRequest.prototype.getAllResponseHeaders = function () { return this.readyState >= 2 && this.lwType ? 'content-type: ' + this.lwType + '\\r\\n' : ''; };
  PageRequest.prototype.abort = function () { if (this.lwDone) return; this.lwDone = true; this.readyState = 0; this.lwFire('abort'); this.lwFire('loadend'); };
  PageRequest.prototype.send = function () {
    var request = this;
    request.lwFire('loadstart');
    function finish(answer) {
      if (request.lwDone) return;
      request.lwDone = true;
      if (!answer.status) { request.readyState = 4; request.lwFire('readystatechange'); request.lwFire('error'); request.lwFire('loadend'); return; }
      request.status = answer.status; request.statusText = answer.status === 200 ? 'OK' : 'Not Found';
      request.responseURL = request.lwUrl; request.lwType = answer.type || '';
      request.readyState = 2; request.lwFire('readystatechange');
      var bytes = answer.status === 200 && answer.body ? answer.body : new ArrayBuffer(0), kind = request.responseType;
      var text = function () { return new TextDecoder().decode(bytes); };
      if (kind === 'arraybuffer') request.response = bytes;
      else if (kind === 'blob') request.response = new Blob([bytes], { type: request.lwType });
      else if (kind === 'json') { try { request.response = JSON.parse(text()); } catch (error) { request.response = null; } }
      else if (kind === 'document') request.response = null;
      else { request.responseText = text(); request.response = request.responseText; }
      request.readyState = 3; request.lwFire('readystatechange'); request.lwFire('progress');
      request.readyState = 4; request.lwFire('readystatechange'); request.lwFire('load'); request.lwFire('loadend');
    }
    if (!beside(request.lwUrl)) { setTimeout(function () { finish({ status: 0 }); }, 0); return; }
    load(request.lwUrl).then(finish);
  };
  window.XMLHttpRequest = PageRequest;
  // A clip beside the page plays from a blob: made here, rather than written into the page.
  function clips() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-lw-src]'), function (element) {
      var url = element.getAttribute('data-lw-src');
      element.removeAttribute('data-lw-src');
      load(url).then(function (answer) {
        if (answer.status !== 200 || !answer.body) return;
        element.src = URL.createObjectURL(new Blob([answer.body], { type: answer.type }));
        if (element.tagName === 'SOURCE' && element.parentElement && typeof element.parentElement.load === 'function') element.parentElement.load();
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', clips); else clips();
  var down = false, shown = false, timer = 0, queued = false;
  function report() {
    var selection = document.getSelection();
    var text = selection && selection.rangeCount && !selection.isCollapsed ? String(selection) : '';
    if (!text.trim()) { if (shown) { shown = false; send({ type: 'selection', text: '' }); } return; }
    var box = selection.getRangeAt(0).getBoundingClientRect();
    shown = true;
    send({ type: 'selection', text: text, rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right } });
  }
  document.addEventListener('pointerdown', function () { down = true; if (shown) { shown = false; send({ type: 'selection', text: '' }); } }, true);
  document.addEventListener('pointerup', function () { down = false; setTimeout(report, 0); }, true);
  document.addEventListener('selectionchange', function () { if (down) return; clearTimeout(timer); timer = setTimeout(report, 120); });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    // With nothing marked, Escape is the reader's: it closes an answer open over the page.
    if (!shown) { send({ type: 'escape' }); return; }
    var selection = document.getSelection();
    if (selection) selection.removeAllRanges();
    shown = false; send({ type: 'selection', text: '' });
  }, true);
  // The parts asked about, marked in the page as the reader marks its own text (lib/files/partMarks.ts):
  // each part's words wrapped in a mark, and after the last word a slot with a bubble for each agent
  // asked about them, in the order asked, so the line makes room for them. Where two parts overlap,
  // the newer is marked and the older's bubbles sit with it. Every change is undone exactly, last
  // first, before the page is marked again.
  var marked = { key: null, undo: [], parts: {}, found: {} }, wanted = [], texts = [], hovered = null, pressing = false;
  function dark(element) {
    for (var at = element; at && at.nodeType === 1; at = at.parentElement) {
      var colour = /rgba?\\(([^)]*)\\)/.exec(getComputedStyle(at).backgroundColor);
      var parts = colour ? colour[1].split(',').map(parseFloat) : [];
      if (parts.length >= 3 && (parts.length < 4 || parts[3] > 0.5)) return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255 < 0.45;
    }
    return false;
  }
  function unmark() {
    for (var i = marked.undo.length - 1; i >= 0; i--) marked.undo[i]();
    marked = { key: null, undo: [], parts: {}, found: {} };
  }
  function textIn(range) {
    var root = range.commonAncestorContainer, pieces = [];
    var walker = document.createTreeWalker(root, 4);
    for (var node = root.nodeType === 3 ? root : walker.nextNode(); node; node = walker.nextNode()) {
      var inSlot = node.parentNode && node.parentNode.closest && node.parentNode.closest('.lw-slot');
      if (!inSlot && range.intersectsNode(node)) {
        var start = node === range.startContainer ? range.startOffset : 0;
        var end = node === range.endContainer ? range.endOffset : node.length;
        if (end > start && node.data.slice(start, end).trim()) pieces.push({ node: node, start: start, end: end });
      }
      if (node === root) break;
    }
    return pieces;
  }
  function overlaps(a, b) { return a.compareBoundaryPoints(Range.END_TO_START, b) < 0 && a.compareBoundaryPoints(Range.START_TO_END, b) > 0; }
  function lit(at, bubble, on) {
    at.marks.forEach(function (element) { element.classList.toggle('lw-lit', on || at.lit); });
    bubble.classList.toggle('lw-lit', on || bubble.lwLit);
  }
  function wrap(piece, text, marks) {
    var node = piece.node, data = node.data, target = node, added = [];
    if (piece.end < node.length) added.push(node.splitText(piece.end));
    if (piece.start > 0) { target = node.splitText(piece.start); added.push(target); }
    var mark = document.createElement('span');
    mark.className = 'lw-mark';
    mark.lwPart = text;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    marks.unshift(mark);
    marked.undo.push(function () {
      if (target === node) mark.parentNode.insertBefore(node, mark);
      if (mark.parentNode) mark.parentNode.removeChild(mark);
      added.forEach(function (extra) { if (extra.parentNode) extra.parentNode.removeChild(extra); });
      node.data = data;
    });
  }
  function slotAfter(last) {
    var slot = document.createElement('span');
    slot.className = 'lw-slot';
    slot.setAttribute('contenteditable', 'false');
    last.parentNode.insertBefore(slot, last.nextSibling);
    marked.undo.push(function () { if (slot.parentNode) slot.parentNode.removeChild(slot); });
    return slot;
  }
  function bubbleFor(at, key) {
    var bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.innerHTML = '<svg class="lw-point" viewBox="0 0 10 7" aria-hidden="true" focusable="false"><path class="lw-point-fill" d="${BUBBLE_POINT_FILL}"/><path class="lw-point-edge" d="${BUBBLE_POINT_EDGE}"/></svg><span class="lw-face"></span><span class="lw-dots"><i></i><i></i><i></i></span><i class="lw-new"></i><span class="lw-stop">\u00d7</span>';
    bubble.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); unhover(true); send({ type: 'open', key: key }); });
    // Pointed at with the mouse, or reached with the keyboard, the reader shows the agent's card.
    bubble.addEventListener('mouseenter', function () { lit(at, bubble, true); hover(bubble, key, false); });
    bubble.addEventListener('pointerdown', function () { pressing = true; });
    bubble.addEventListener('focus', function () { lit(at, bubble, true); if (!pressing) hover(bubble, key, true); pressing = false; });
    ['mouseleave', 'blur'].forEach(function (name) { bubble.addEventListener(name, function () { lit(at, bubble, false); unhover(false); }); });
    return bubble;
  }
  function hover(bubble, key, now) {
    var box = bubble.getBoundingClientRect();
    hovered = key;
    send({ type: 'hover', key: key, now: now, rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right } });
  }
  function unhover(now) {
    if (hovered === null) return;
    hovered = null;
    send({ type: 'hover', key: null, now: now });
  }
  function mark(list) {
    var kept = [], joined = [];
    for (var i = list.length - 1; i >= 0; i--) {
      var part = list[i], over = null;
      if (part.range.collapsed) continue;
      for (var k = 0; k < kept.length && !over; k++) if (overlaps(kept[k].range, part.range)) over = kept[k];
      if (over) joined.push([part.text, over.text]); else kept.push(part);
    }
    kept.sort(function (a, b) { return b.range.compareBoundaryPoints(Range.START_TO_START, a.range); });
    kept.forEach(function (part) {
      var pieces = textIn(part.range).reverse(), marks = [];
      if (!pieces.length) return;
      pieces.forEach(function (piece) { wrap(piece, part.text, marks); });
      var last = marks[marks.length - 1];
      marked.parts[part.text] = { text: part.text, marks: marks, slot: slotAfter(last), bubbles: {}, asks: [], lit: false, dark: dark(last.parentNode) };
    });
    joined.forEach(function (pair) { if (marked.parts[pair[1]]) marked.parts[pair[0]] = marked.parts[pair[1]]; });
  }
  // How marked words look with several asks on them, and which one a press on them opens (passage.ts wordsLook, wordsOpen).
  var LOOKS = ['busy', 'waiting', 'failed', 'read'];
  function wordsLook(asks) { return LOOKS.filter(function (look) { return asks.some(function (ask) { return ask.look === look; }); })[0] || 'read'; }
  function wordsOpen(asks) {
    for (var i = asks.length - 1; i >= 0; i--) if (asks[i].look === 'waiting') return asks[i];
    return asks[asks.length - 1];
  }
  function show() {
    var shown = [];
    wanted.forEach(function (ask) {
      var at = marked.parts[ask.text];
      if (!at) return;
      if (shown.indexOf(at) < 0) { shown.push(at); at.asks = []; }
      at.asks.push(ask);
    });
    shown.forEach(function (at) {
      var any = function (name) { return at.asks.some(function (ask) { return ask[name]; }); };
      at.lit = any('lit');
      var look = ' lw-' + wordsLook(at.asks) + (at.dark ? ' lw-dark' : '') + (any('fresh') ? ' lw-fresh' : '') + (at.lit ? ' lw-lit' : '');
      at.marks.forEach(function (element) { element.className = 'lw-mark' + look; });
      // A bubble for each ask, in the order asked: kept while its ask is, so it does not pop up
      // again. Those no longer asked go first, so the rest are moved only if their order changed
      // (a moved bubble replays its animations and loses focus).
      var kept = {};
      at.asks.forEach(function (ask) { kept[ask.key] = true; });
      Object.keys(at.bubbles).forEach(function (key) {
        if (kept[key]) return;
        at.slot.removeChild(at.bubbles[key]);
        delete at.bubbles[key];
      });
      at.asks.forEach(function (ask, i) {
        var bubble = at.bubbles[ask.key] || (at.bubbles[ask.key] = bubbleFor(at, ask.key));
        if (at.slot.children[i] !== bubble) at.slot.insertBefore(bubble, at.slot.children[i] || null);
        dress(bubble, ask, at.dark);
      });
    });
  }
  function dress(bubble, ask, dark) {
    bubble.lwLit = Boolean(ask.lit);
    bubble.className = 'lw-bubble lw-' + ask.look + (dark ? ' lw-dark' : '') + (ask.fresh ? ' lw-fresh' : '') + (ask.lit ? ' lw-lit' : '');
    bubble.setAttribute('aria-label', String(ask.label || ''));
    bubble.setAttribute('aria-expanded', ask.open ? 'true' : 'false');
    bubble.title = String(ask.title || '');
    var face = bubble.querySelector('.lw-face'), src = String(ask.figure || ''), says = src || String(ask.initials || '');
    if (face.getAttribute('data-shows') === says) return;
    face.setAttribute('data-shows', says);
    face.textContent = '';
    if (/^data:image\\//.test(src)) {
      var image = document.createElement('img');
      image.alt = '';
      image.src = src;
      face.appendChild(image);
    } else face.textContent = String(ask.initials || '');
  }
  function parts() {
    send({ type: 'parts', parts: texts.map(function (text) {
      var at = marked.parts[text], rects = [];
      if (!at) return { text: text, rects: rects, missing: !marked.found[text], as: text, dark: false };
      at.marks.forEach(function (element) {
        var list = element.getClientRects();
        for (var i = 0; i < list.length && rects.length < 60; i++) rects.push({ top: list[i].top, bottom: list[i].bottom, left: list[i].left, right: list[i].right });
      });
      return { text: text, rects: rects, missing: false, as: at.text, dark: at.dark };
    }) });
  }
  function later() {
    if (queued || !wanted.length) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; parts(); });
  }
  // The agent's card belongs to where the bubble was: scrolling the page takes it away.
  addEventListener('scroll', function () { if (shown) report(); unhover(false); later(); }, true);
  addEventListener('resize', function () { if (shown) report(); later(); });
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) {
      var selection = document.getSelection();
      if (selection && !selection.isCollapsed) return;
      var marking = event.target && event.target.closest ? event.target.closest('.lw-mark') : null;
      var at = marking && marking.lwPart ? marked.parts[marking.lwPart] : null, opens = at && wordsOpen(at.asks);
      if (opens) send({ type: 'open', key: opens.key });
      return;
    }
    if ((link.getAttribute('href') || '').charAt(0) === '#') return;
    event.preventDefault();
    if (/^https?:/i.test(link.href)) window.open(link.href, '_blank', 'noopener');
  }, true);
  function index() {
    var skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    var walker = document.createTreeWalker(document.body || document.documentElement, 4, {
      acceptNode: function (node) {
        var parent = node.parentNode;
        return parent && (skip[parent.nodeName] || (parent.closest && parent.closest('.lw-slot'))) ? 2 : 1;
      }
    });
    var page = { chars: '', nodes: [], node: [], offset: [] };
    for (var current = walker.nextNode(); current; current = walker.nextNode()) {
      var at = page.nodes.push(current) - 1, value = current.data;
      for (var i = 0; i < value.length; i++) {
        if (/\\s/.test(value[i])) continue;
        page.chars += value[i]; page.node.push(at); page.offset.push(i);
      }
    }
    return page;
  }
  function find(page, passage) {
    var wanted = String(passage || '').replace(/\\u2026$/, '').replace(/\\s/g, '');
    if (!wanted) return null;
    var start = page.chars.indexOf(wanted);
    if (start < 0 && wanted.length > 400) { wanted = wanted.slice(0, 400); start = page.chars.indexOf(wanted); }
    if (start < 0) return null;
    var end = start + wanted.length - 1, range = document.createRange();
    range.setStart(page.nodes[page.node[start]], page.offset[start]);
    range.setEnd(page.nodes[page.node[end]], page.offset[end] + 1);
    return range;
  }
  function light(name, ranges) {
    var highlight = new Highlight();
    ranges.forEach(function (range) { if (range) highlight.add(range); });
    CSS.highlights.set(name, highlight);
  }
  addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.lw !== 'reader') return;
    if (data.type === 'loaded' && loads[data.id]) {
      var answered = loads[data.id];
      delete loads[data.id];
      answered({ status: typeof data.status === 'number' ? data.status : 0, type: String(data.mediaType || ''), body: Object.prototype.toString.call(data.body) === '[object ArrayBuffer]' ? data.body : null });
      return;
    }
    if (data.type === 'clear') { var selection = document.getSelection(); if (selection) selection.removeAllRanges(); shown = false; }
    if (data.type === 'marks') {
      wanted = (Array.isArray(data.parts) ? data.parts : []).filter(function (ask) { return ask && typeof ask.text === 'string' && typeof ask.key === 'string'; });
      // Each part's words once, in the order of its newest ask (passage.ts partTexts).
      texts = [];
      wanted.forEach(function (ask) { var at = texts.indexOf(ask.text); if (at >= 0) texts.splice(at, 1); texts.push(ask.text); });
      var key = texts.join('\\u0000');
      if (key !== marked.key) {
        unmark();
        var page = index(), list = [];
        texts.forEach(function (text) {
          var range = find(page, text);
          if (!range) return;
          marked.found[text] = true;
          list.push({ text: text, range: range });
        });
        mark(list);
        marked.key = key;
      }
      show();
      if (window.CSS && CSS.highlights && typeof Highlight === 'function') light('lw-read-asking', data.asking ? [find(index(), data.asking)] : []);
      parts();
    }
  });
  var style = document.createElement('style');
  // The reader's own look (reader.css .rd-mark, .rd-slot, .rd-bubble), in the page's own words:
  // the page has none of the reader's colours. Keep the two alike.
  // Its picture is the page's to keep, its size and place the animations' (an important rule would stop them).
  var stroke = 'linear-gradient(100deg,color-mix(in srgb,#E9C46A var(--lw-a),transparent),color-mix(in srgb,#D8A93C calc(var(--lw-a)*.7),transparent) 60%,color-mix(in srgb,#E9C46A var(--lw-a),transparent))';
  var plain = 'background-image:' + stroke + '!important;background-repeat:no-repeat!important;background-size:100% 74%;background-position:0 62%';
  var shine = function (colour) { return 'background-image:linear-gradient(100deg,transparent 0 35%,' + colour + ' 50%,transparent 65%),' + stroke + '!important;background-size:250% 74%,100% 74%;background-position:0 62%,0 62%'; };
  // The page's own styles must not undo the marks: what they need is set past its rules.
  style.textContent = '::highlight(lw-read-asking){background-color:rgba(214,168,54,.5)}'
    + '::selection{background-color:rgba(214,168,54,.4)}'
    + '.lw-mark{display:inline!important;--lw-a:58%;margin:0 -2px!important;padding:0 2px!important;border-radius:3px 9px 4px 10px/8px 4px 10px 3px!important;cursor:pointer;' + plain + ';-webkit-box-decoration-break:clone;box-decoration-break:clone}'
    + '.lw-mark.lw-read,.lw-mark.lw-failed{--lw-a:36%}.lw-mark.lw-dark{--lw-a:30%}.lw-mark.lw-dark.lw-read,.lw-mark.lw-dark.lw-failed{--lw-a:18%}'
    + '.lw-mark.lw-lit{box-shadow:inset 0 -2px 0 #8A6A16!important}.lw-mark.lw-dark.lw-lit{box-shadow:inset 0 -2px 0 #E9C46A!important}'
    + '.lw-mark.lw-busy{' + shine('rgba(255,255,255,.7)') + '}'
    + '.lw-mark.lw-dark.lw-busy{' + shine('rgba(233,196,106,.4)') + '}'
    + '.lw-slot{position:relative!important;display:inline-block!important;margin:0 2px 0 9px!important;padding:0!important;line-height:0!important;text-indent:0;vertical-align:middle!important;translate:0 -0.4em;-webkit-user-select:none;user-select:none}'
    + '.lw-slot:hover,.lw-slot:focus-within{z-index:2!important}'
    // The bubble is round, washed with the marker's gold and edged in it, in the lightness of the page under it (reader.css .rd-bubble).
    + '.lw-bubble{all:unset;box-sizing:border-box!important;position:relative!important;display:inline-flex!important;align-items:center!important;gap:3px;height:22px!important;padding:0 7px 0 2px!important;margin:0!important;border:0!important;border-radius:999px!important;background:#F5F0E4!important;color:#17150F!important;'
    + 'font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;white-space:nowrap;cursor:pointer;vertical-align:middle;'
    + 'box-shadow:0 0 0 1px color-mix(in srgb,#8A6A16 40%,#F5F0E4),0 3px 10px rgba(0,0,0,.16)!important}'
    + '.lw-bubble.lw-dark{background:#1A1508!important;color:#F5F3EE!important;box-shadow:0 0 0 1px color-mix(in srgb,#E9C46A 40%,#1A1508),0 3px 10px rgba(0,0,0,.4)!important}'
    + '.lw-bubble::after{content:"";position:absolute;inset:-11px -8px}'
    + '.lw-point{position:absolute!important;left:-5px!important;top:13px!important;width:10px!important;height:7px!important;max-width:none!important;overflow:visible!important;pointer-events:none;display:block!important;margin:0!important}'
    + '.lw-point-fill{fill:#F5F0E4!important;stroke:none!important}.lw-point-edge{fill:none!important;stroke:color-mix(in srgb,#8A6A16 40%,#F5F0E4)!important;stroke-width:1px!important;stroke-linejoin:round;stroke-linecap:round}'
    + '.lw-dark .lw-point-fill{fill:#1A1508!important}.lw-dark .lw-point-edge{stroke:color-mix(in srgb,#E9C46A 40%,#1A1508)!important}'
    + '.lw-bubble.lw-read{padding-right:2px!important}.lw-bubble.lw-failed{padding-right:0!important}'
    + '.lw-bubble:hover,.lw-bubble:focus-visible,.lw-bubble.lw-lit{scale:1.08}.lw-bubble:focus-visible{outline:2px solid #8A6A16!important;outline-offset:2px}'
    // Several agents asked about the same words: their bubbles stack, each over the one before, and only the first points at the words.
    // The one pointed at comes up over the rest, and the one whose answer is open stays above the others.
    + '.lw-bubble+.lw-bubble{margin-left:-8px!important}.lw-bubble+.lw-bubble .lw-point{display:none!important}.lw-bubble+.lw-bubble::after{left:0}.lw-bubble:not(:last-child)::after{right:0}'
    // A bubble that ends in a mark (typing, an answer waiting, stopped) is overlapped only on its edge, so the mark shows.
    + '.lw-bubble:is(.lw-busy,.lw-waiting,.lw-failed)+.lw-bubble{margin-left:-3px!important}'
    // With no hover to bring one up, a finger needs each bubble whole.
    + '@media (pointer:coarse){.lw-bubble+.lw-bubble{margin-left:4px!important}}'
    + '.lw-bubble.lw-lit{z-index:1!important}.lw-bubble:hover,.lw-bubble:focus-visible{z-index:2!important;translate:0 -2px}'
    + '.lw-face{position:relative;display:inline-grid;place-items:center;flex:none;width:18px;height:18px;border-radius:50%;font:600 9px/1 sans-serif;color:inherit}'
    + '.lw-face:not(:has(img)):not(:empty){background:color-mix(in srgb,currentColor 12%,transparent)}'
    + '.lw-face img{position:absolute;inset:-20%;width:140%;height:140%;max-width:none;object-fit:contain}'
    + '.lw-dots{display:none;gap:3px}.lw-busy .lw-dots{display:inline-flex}'
    + '.lw-bubble{--lw-ink-2:#56524A;--lw-fill:#8A6A16;--lw-live:#175CD3;--lw-alert:#C0342E}'
    + '.lw-bubble.lw-dark{--lw-ink-2:#A9A59C;--lw-fill:#D8A93C;--lw-live:#6AB8FF;--lw-alert:#F2635C}'
    + '.lw-dots i{width:4px;height:4px;border-radius:50%;background:var(--lw-ink-2)}'
    + '.lw-new{display:none;width:7px;height:7px;border-radius:50%;background:var(--lw-fill)}.lw-waiting .lw-new{display:inline-block}'
    + '.lw-stop{display:none;margin-right:4px;color:var(--lw-alert);font:700 12px/1 sans-serif}.lw-failed .lw-stop{display:inline}'
    + '.lw-bubble.lw-busy img{filter:drop-shadow(0 0 1px var(--lw-live)) drop-shadow(0 0 2px var(--lw-live))}'
    + '.lw-bubble.lw-waiting img{filter:drop-shadow(0 0 1px var(--lw-fill)) drop-shadow(0 0 2px var(--lw-fill))}'
    + '.lw-bubble.lw-failed img{rotate:8deg;translate:0 2px;filter:saturate(.35) drop-shadow(0 0 1px var(--lw-alert)) drop-shadow(0 0 2px var(--lw-alert))}'
    + '@media (prefers-reduced-motion:no-preference){'
    + '.lw-bubble{transition:scale .16s cubic-bezier(.2,0,0,1),translate .16s cubic-bezier(.2,0,0,1)}'
    + '.lw-mark.lw-fresh{animation:lw-sweep .56s cubic-bezier(.2,0,0,1) both}.lw-mark.lw-busy{animation:lw-shine 1.4s linear infinite}'
    + '.lw-mark.lw-fresh.lw-busy{animation:lw-sweep .56s cubic-bezier(.2,0,0,1) both,lw-shine 1.4s linear .56s infinite}'
    + '.lw-bubble.lw-fresh{animation:lw-pop .56s cubic-bezier(.32,1.36,.5,1) .2s both}.lw-waiting .lw-new{animation:lw-pop .56s cubic-bezier(.32,1.36,.5,1) both}'
    + '.lw-dots i{animation:lw-typing 1.2s ease-in-out infinite}.lw-dots i:nth-child(2){animation-delay:.15s}.lw-dots i:nth-child(3){animation-delay:.3s}}'
    + '@media (prefers-reduced-motion:reduce){.lw-mark.lw-busy,.lw-mark.lw-dark.lw-busy{' + plain + '}.lw-dots i{opacity:1}}'
    + '@keyframes lw-sweep{from{background-size:0% 74%}}@keyframes lw-shine{from{background-position:100% 62%,0 62%}to{background-position:-150% 62%,0 62%}}'
    + '@keyframes lw-pop{from{opacity:0;scale:.3}}@keyframes lw-typing{50%{opacity:.25}}';
  (document.head || document.documentElement).appendChild(style);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { send({ type: 'ready' }); });
  else send({ type: 'ready' });
})();`

type PageRect = { top: number; bottom: number; left: number; right: number }

/**
 * An ask about a part, as the reader asks the page to show it: the part's words to mark, and the
 * ask's bubble after them, how it looks, its agent and words. Several asks may be about the same words.
 */
export interface PageMark {
  /** Which ask it is (passage.ts `askKey`): what the page says when its bubble is pressed. */
  key: string
  text: string
  look: 'busy' | 'waiting' | 'read' | 'failed'
  /** Asked just now: its stroke sweeps on. */
  fresh: boolean
  /** Its answer is open, or it is pointed at. */
  lit: boolean
  open: boolean
  label: string
  title: string
  /** The agent's figure as a `data:` picture (the page can load nothing else), or `null` for its initials. */
  figure: string | null
  initials: string
}

/**
 * A part asked about, as the page has it now: its lines on screen, or `missing` when the page no
 * longer has its words. `as`: the words it is shown on, a newer part's where one overlaps it.
 */
export interface PagePart { text: string; rects: PageRect[]; missing: boolean; as?: string; dark: boolean }

/**
 * A message from the page's script, once checked to be one: the words marked, where the parts
 * asked about are now, or a part asked about that was clicked.
 */
export type PageMessage =
  | { type: 'selection'; text: string; rect?: PageRect }
  | { type: 'parts'; parts: PagePart[] }
  /** An ask's bubble, or the words it is about, was pressed: its answer opens. */
  | { type: 'open'; key: string }
  /** An ask's bubble was pointed at (`now`: reached with the keyboard), or no longer is (`key` null): its agent's card opens or closes. */
  | { type: 'hover'; key: string | null; now: boolean; rect?: PageRect }
  | { type: 'escape' }
  | { type: 'ready' }
  /** The page asked for a file beside it, by the address it wrote (`fetch`, `XMLHttpRequest`, a clip): the reader answers `loaded` with the same id. */
  | { type: 'load'; id: number; url: string }

const isRect = (value: unknown): value is PageRect => {
  const rect = value as Record<string, unknown> | null
  return Boolean(rect) && ['top', 'bottom', 'left', 'right'].every((key) => typeof rect![key] === 'number' && Number.isFinite(rect![key]))
}

export function pageMessage(data: unknown): PageMessage | null {
  if (!data || typeof data !== 'object' || (data as { lw?: unknown }).lw !== 'reader') return null
  const message = data as { type?: unknown; text?: unknown; rect?: unknown }
  if (message.type === 'ready') return { type: 'ready' }
  if (message.type === 'escape') return { type: 'escape' }
  if (message.type === 'load') {
    const { id, url } = data as { id?: unknown; url?: unknown }
    return Number.isSafeInteger(id) && typeof url === 'string' && url.length <= 4096 ? { type: 'load', id: id as number, url } : null
  }
  if (message.type === 'parts') {
    const parts = (data as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return null
    return {
      type: 'parts',
      parts: parts.slice(0, 200).flatMap((part: Record<string, unknown> | null) => (part && typeof part.text === 'string'
        ? [{
          text: part.text.slice(0, 100_000), rects: Array.isArray(part.rects) ? part.rects.filter(isRect).slice(0, 60) : [], missing: part.missing === true,
          ...(typeof part.as === 'string' ? { as: part.as.slice(0, 100_000) } : {}), dark: part.dark === true,
        }]
        : [])),
    }
  }
  if (message.type === 'hover') {
    const { key, now, rect } = data as { key?: unknown; now?: unknown; rect?: unknown }
    if (key === null) return { type: 'hover', key: null, now: now === true }
    return typeof key === 'string' && isRect(rect) ? { type: 'hover', key: key.slice(0, 100_000), now: now === true, rect } : null
  }
  if (message.type === 'open') {
    const key = (data as { key?: unknown }).key
    return typeof key === 'string' ? { type: 'open', key: key.slice(0, 100_000) } : null
  }
  if (typeof message.text !== 'string') return null
  const text = message.text.slice(0, 100_000)
  if (message.type !== 'selection') return null
  return { type: 'selection', text, rect: isRect(message.rect) ? message.rect : undefined }
}

/** The most of a page's own files (pictures beside it, its stylesheets, scripts and fonts) taken in. */
const MAX_OWN_FILES = 80

/** The largest file beside a page handed to it as it runs (a clip is handed whole, as a `blob:`). */
const PAGE_FILE_MAX_BYTES = 512 * 1024 * 1024

/** A link to a file beside the page: not the web, not data, not a part of the page itself. */
function isBeside(url: string): boolean {
  const value = url.trim()
  return value !== '' && !value.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//')
}

/**
 * `chart.png` beside `/a/b/page.html` → `/a/b/chart.png`; a query or fragment is dropped. `from` is
 * the file the link is written in, when not the page itself (its stylesheet). A page reaches only its
 * own folder and the folders in it (ADR 0091): a link that steps above its folder is `null`, so a
 * page can't read another team's files, or any file it could then send to the web.
 */
export function besidePath(page: string, url: string, from = page): string | null {
  const clean = decodeURIComponentSafe(url.trim().replace(/[?#].*$/, ''))
  if (!clean) return null
  const windows = /^[A-Za-z]:[\\/]/.test(page)
  const separator = windows ? '\\' : '/'
  const folder = page.split(/[\\/]/).slice(0, -1)
  const parts = from.split(/[\\/]/).slice(0, -1)
  if (folder.some((name, at) => parts[at] !== name)) return null
  for (const part of clean.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length <= folder.length) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.length > folder.length ? parts.join(separator) : null
}

/** A file the page asked for as it runs, as it is handed over: what the page's `fetch` makes of it. */
export interface PageFile {
  /** 200 with the bytes; 404 for a file not there, outside the page's folder, or not one a page loads; 0 when the daemon couldn't be reached. */
  status: number
  mediaType: string
  body: ArrayBuffer | null
}

/** What a page asked for beside it (`url` as it wrote it), read inside its folder, or why not. */
export async function pageFile(page: string, url: string, signal?: AbortSignal): Promise<PageFile> {
  const missing: PageFile = { status: 404, mediaType: '', body: null }
  const file = isBeside(url) ? besidePath(page, url) : null
  if (!file) return missing
  const response = await fetch(rawFileUrl(file), { signal, cache: 'no-store' }).catch(() => null)
  if (!response) return { status: 0, mediaType: '', body: null }
  if (!response.ok || Number(response.headers.get('content-length')) > PAGE_FILE_MAX_BYTES) return missing
  return { status: 200, mediaType: response.headers.get('content-type') ?? '', body: await response.arrayBuffer() }
}

/** A `url(…)` in CSS. */
const CSS_URL = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g

/** CSS with the pictures and fonts it names taken in as data: named from `from` (its own file), inside the page's folder. */
async function cssTakenIn(css: string, page: string, from: string, take: () => boolean, signal?: AbortSignal): Promise<string> {
  const found = new Map<string, string>()
  for (const match of css.matchAll(CSS_URL)) {
    const url = match[2]
    if (found.has(url) || !isBeside(url) || !besidePath(page, url, from) || !take()) continue
    found.set(url, '')
  }
  await Promise.all([...found.keys()].map(async (url) => {
    const response = await fetch(rawFileUrl(besidePath(page, url, from)!), { signal }).catch(() => null)
    if (response?.ok) found.set(url, await dataUrl(response).catch(() => ''))
  }))
  return css.replace(CSS_URL, (whole: string, _quote: string, url: string) => (found.get(url) ? `url("${found.get(url)}")` : whole))
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function dataUrl(response: Response): Promise<string> {
  const type = response.headers.get('content-type') ?? 'application/octet-stream'
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}

/**
 * The page as the frame is given it: the policy first, LoomWatch's script next, and the files it
 * names beside it taken in — pictures as data, its own stylesheets and scripts as text, and the
 * pictures and fonts its CSS names as data — since the sandboxed frame cannot ask the daemon for
 * them. A clip is handed over as the page runs, by LoomWatch's script (`data-lw-src`), rather than
 * written into the page. A file that is not there, or is outside the page's folder, is left as
 * written.
 */
export async function pageDocument(html: string, path: string, signal?: AbortSignal): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body)
  let taken = 0
  const take = () => taken++ < MAX_OWN_FILES
  const jobs: Promise<void>[] = []
  const asData = (element: Element, attribute: string) => {
    const value = element.getAttribute(attribute) ?? ''
    const file = isBeside(value) ? besidePath(path, value) : null
    if (!file || !take()) return
    jobs.push(fetch(rawFileUrl(file), { signal }).then(async (response) => { if (response.ok) element.setAttribute(attribute, await dataUrl(response)) }).catch(() => undefined))
  }
  for (const clip of Array.from(doc.querySelectorAll('video[src], audio[src], video > source[src], audio > source[src]'))) {
    const src = clip.getAttribute('src') ?? ''
    if (!isBeside(src) || !besidePath(path, src)) continue
    clip.setAttribute('data-lw-src', src)
    clip.removeAttribute('src')
  }
  for (const image of Array.from(doc.querySelectorAll('img[src], picture > source[src]'))) asData(image, 'src')
  for (const video of Array.from(doc.querySelectorAll('video[poster]'))) asData(video, 'poster')
  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) {
    const href = link.getAttribute('href') ?? ''
    const file = isBeside(href) ? besidePath(path, href) : null
    if (!file || !take()) continue
    jobs.push(readFile(file, signal).then(async (read) => {
      const style = doc.createElement('style')
      // Its pictures and fonts are named from where the stylesheet is, not the page.
      style.textContent = await cssTakenIn(read.text, path, file, take, signal)
      link.replaceWith(style)
    }).catch(() => undefined))
  }
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    jobs.push(cssTakenIn(style.textContent ?? '', path, path, take, signal).then((css) => { style.textContent = css }).catch(() => undefined))
  }
  for (const element of Array.from(doc.querySelectorAll('[style*="url("]'))) {
    jobs.push(cssTakenIn(element.getAttribute('style') ?? '', path, path, take, signal).then((css) => { element.setAttribute('style', css) }).catch(() => undefined))
  }
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    const src = script.getAttribute('src') ?? ''
    const file = isBeside(src) ? besidePath(path, src) : null
    if (!file || !take()) continue
    jobs.push(readFile(file, signal).then((read) => {
      script.removeAttribute('src')
      // A script's text cannot close the tag it sits in.
      script.textContent = read.text.replace(/<\/script/gi, '<\\/script')
    }).catch(() => undefined))
  }
  await Promise.all(jobs)
  // Anything the page set as its base or its own policy gives way to the reader's.
  doc.querySelectorAll('base, meta[http-equiv="Content-Security-Policy" i]').forEach((node) => node.remove())
  const policy = doc.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', PAGE_POLICY)
  const bridge = doc.createElement('script')
  bridge.textContent = PAGE_BRIDGE
  head.prepend(policy, bridge)
  if (!head.querySelector('meta[charset]')) {
    const charset = doc.createElement('meta')
    charset.setAttribute('charset', 'utf-8')
    head.prepend(charset)
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}

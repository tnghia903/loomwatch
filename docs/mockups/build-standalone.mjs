#!/usr/bin/env node
/* ===========================================================================
   build-standalone.mjs — TNG-99
   Emits docs/mockups/prototype-standalone.html: ONE file, no local CSS/JS
   dependencies, no required network fonts.

   Why this exists: the first hand-rolled standalone drifted out of date the
   moment prototype.css/js changed. The reviewable artifact is generated, never
   edited by hand.

   What it does
     1. tokens.css + prototype.css  -> a single inline <style>
     2. prototype.js                -> a single inline <script>
     3. the three Google Fonts <link>s -> inline @font-face rules whose src is
        a base64 woff2 data: URI (latin + latin-ext subsets only)

   Fonts are fetched once into .font-cache/ (gitignored). Building needs the
   network; VIEWING THE OUTPUT DOES NOT. Run with --no-fonts to build a
   system-stack-only file with no network at all; the fallbacks in
   tokens.css §type already carry the layout, only the texture changes.

   Usage:  node docs/mockups/build-standalone.mjs [--no-fonts]
   =========================================================================== */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.font-cache');
const OUT = join(HERE, 'prototype-standalone.html');
const NO_FONTS = process.argv.includes('--no-fonts');

const GF_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600' +
  '&family=JetBrains+Mono:wght@400&family=Instrument+Serif&display=swap';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* Inter ships from Google as a single variable file reused by 400/500/600, so
   one @font-face per subset with a weight RANGE is both correct and 3x
   smaller than repeating the base64. Verified by measuring 400 vs 600 advance
   width in the headless pass. */
const WEIGHT_RANGE = { Inter: '100 900' };

const read = (f) => readFile(join(HERE, f), 'utf8');

async function cached(url) {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, url.split('/').pop());
  try {
    await stat(file);
  } catch {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(file);
}

async function fontCss() {
  const res = await fetch(GF_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Google Fonts CSS: ${res.status}`);
  const css = await res.text();

  // Google's CSS2 output is `/* subset */ @font-face { ... }` repeated.
  const faces = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)]
    .map(([, subset, block]) => ({
      subset,
      family: /font-family:\s*'([^']+)'/.exec(block)[1],
      weight: /font-weight:\s*([^;]+);/.exec(block)[1].trim(),
      unicode: /unicode-range:\s*([^;]+);/.exec(block)[1].trim(),
      url: /url\((https[^)]+)\)/.exec(block)[1],
    }))
    .filter((f) => f.subset === 'latin' || f.subset === 'latin-ext');

  if (!faces.length) throw new Error('no latin faces parsed from Google Fonts CSS');

  const seen = new Set();
  const out = [];
  let bytes = 0;
  for (const f of faces) {
    const key = `${f.family}|${f.subset}`;
    if (seen.has(key)) continue; // variable file already emitted for this subset
    seen.add(key);
    const buf = await cached(f.url);
    bytes += buf.length;
    out.push(
      `@font-face{font-family:'${f.family}';font-style:normal;` +
        `font-weight:${WEIGHT_RANGE[f.family] || f.weight};font-display:swap;` +
        `src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');` +
        `unicode-range:${f.unicode};}`
    );
  }
  console.log(`  fonts: ${out.length} faces, ${(bytes / 1024).toFixed(0)} KB woff2`);
  return (
    '/* --- INLINED WEBFONTS (latin + latin-ext, woff2, base64) -------------\n' +
    '   Inter, JetBrains Mono, Instrument Serif are all SIL Open Font License\n' +
    '   1.1. Embedded so this file renders identically with no network at all.\n' +
    '   --------------------------------------------------------------------- */\n' +
    out.join('\n')
  );
}

const banner = (t) =>
  `\n/* ==========================================================================\n` +
  `   ${t}\n` +
  `   ========================================================================== */\n`;

const [html, tokens, proto, js] = await Promise.all([
  read('prototype.html'),
  read('tokens.css'),
  read('prototype.css'),
  read('prototype.js'),
]);

const fonts = NO_FONTS
  ? '/* --- built with --no-fonts: system stack only, zero embedded bytes --- */'
  : await fontCss();

let out = html;

// 1. font links + both stylesheet links -> one <style>
const linkBlock =
  /<link rel="preconnect"[\s\S]*?<link rel="stylesheet" href="prototype\.css">/;
if (!linkBlock.test(out)) throw new Error('link block not found in prototype.html');
out = out.replace(
  linkBlock,
  `<style>\n${fonts}\n${banner('tokens.css')}${tokens}\n${banner('prototype.css')}${proto}\n</style>`
);

// 2. external script -> inline
if (!out.includes('<script src="prototype.js"></script>'))
  throw new Error('script tag not found in prototype.html');
out = out.replace(
  '<script src="prototype.js"></script>',
  `<script>\n${js}\n</script>`
);

/* 3. provenance stamp, and a guard against hand-editing the output.
   TNG-125: this stamp used to be `new Date()`, which made two builds of
   identical sources differ by exactly one line — so the artifact the board
   approves could never be checked against a rebuild from the commit. It now
   names the sources it came from instead of the moment it ran, which is the
   question an approval baseline actually has to answer; the commit already
   records the when. Same sources in, same bytes out. */
const sourceDigest = createHash('sha256')
  .update(html).update(tokens).update(proto).update(js).update(fonts)
  .digest('hex').slice(0, 16);
out = out.replace(
  '<head>',
  `<head>\n<!-- GENERATED by docs/mockups/build-standalone.mjs from sources ${sourceDigest}${NO_FONTS ? ' (--no-fonts)' : ''}. DO NOT EDIT.\n` +
    `     Source of truth: prototype.html + tokens.css + prototype.css + prototype.js.\n` +
    `     Deterministic: rebuilding those sources reproduces this file byte for byte.\n` +
    `     Self-contained: no local CSS/JS dependencies, no network fonts. -->`
);

// 4. fail loudly if anything external survived
const leftovers = [...out.matchAll(/(?:src|href)\s*=\s*"(?!#|data:)([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('#'));
if (leftovers.length) throw new Error(`external references survived: ${leftovers.join(', ')}`);

await writeFile(OUT, out);
const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`  wrote prototype-standalone.html (${kb} KB, ${out.split('\n').length} lines)`);

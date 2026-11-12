/**
 * A page's look (ADR 0125): what makes plain HTML an agent writes read as LoomWatch, in light and
 * dark, without the agent styling it. One stylesheet for every page, not a widget.
 *
 * The colours, fonts and spacing are variables the chat fills in from its own tokens
 * ({@link lookOf}), under short names the agent's guide uses (`--ink`, `--accent`, …), and sends
 * again when the theme changes.
 */

/** The frame's stylesheet, before the chat's variables. */
export const PAGE_STYLE = `
*,*::before,*::after{box-sizing:border-box}
html{background:transparent;color:var(--ink);font:400 14px/20px var(--font-sans);-webkit-text-size-adjust:100%}
body{margin:0;overflow-x:hidden}
#lw-root{display:flex;flex-direction:column;gap:12px}
#lw-root>*{margin:0}
#lw-root>button,#lw-root>label{align-self:flex-start}
h1,h2,h3{margin:0;font-weight:400;font-family:var(--font-serif);color:var(--ink);text-wrap:balance}
h1{font-size:18px;line-height:24px}h2{font-size:16px;line-height:22px}h3{font-size:15px;line-height:20px}
h4{margin:0;font:600 13px/18px var(--font-sans)}
code,pre,kbd{font-family:var(--font-mono);font-size:12px}
mark{background:var(--accent-tint);color:inherit}
progress,meter{accent-color:var(--ink)}
p{margin:0}
small,.lw-note{color:var(--ink-2);font-size:12px;line-height:16px}
ul,ol{margin:0;padding-left:20px}li+li{margin-top:4px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th{font:500 12px/16px var(--font-sans);color:var(--ink-2);text-align:left;padding:6px 8px}
td{padding:6px 8px;border-top:1px solid var(--hairline)}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--ink);font:500 13px/18px var(--font-sans);cursor:pointer}
button:hover{border-color:var(--ink-3)}
button[aria-pressed="true"]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);background:var(--accent-tint)}
button:disabled{opacity:.6;cursor:default}
label{display:inline-flex;align-items:center;gap:8px}
input:not([type]),input[type="number"],input[type="text"],select,textarea{min-height:36px;padding:0 8px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:400 14px/20px var(--font-sans);font-variant-numeric:tabular-nums}
input[type="number"]{width:8ch;text-align:right}
input[type="range"],input[type="checkbox"],input[type="radio"]{accent-color:var(--ink)}
input[type="range"]{width:100%}
input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
@media (pointer:coarse){button,input:not([type="range"]):not([type="checkbox"]):not([type="radio"]),select{min-height:44px}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
svg,canvas,img{display:block;max-width:100%}
canvas{width:100%}
.lw-figure{font:400 32px/38px var(--font-serif);letter-spacing:-.015em;font-variant-numeric:lining-nums tabular-nums;color:var(--ink)}
.lw-well{padding:12px 16px;border-radius:10px;background:var(--well)}
.lw-row{display:flex;flex-wrap:wrap;gap:12px}
.lw-row>*{flex:1 1 200px;min-width:0}
.lw-cases{display:flex;flex-wrap:wrap;gap:6px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`

/** The chat's own fonts, in Latin, as a page's frame takes them: written into its look as `data:`,
    since the frame loads nothing from any address. */
const FONTS: readonly { family: string; weight: string; file: string }[] = [
  { family: 'Fraunces', weight: '400', file: 'fraunces-latin.woff2' },
  { family: 'Inter', weight: '100 900', file: 'inter-4.woff2' },
  { family: 'JetBrains Mono', weight: '400', file: 'jetbrains-mono-6.woff2' },
]

let fontRules: Promise<string> | null = null

/** The `@font-face` rules for the chat's fonts, read once from the app's own files; '' when they
    can't be read, and the page draws with the system's fonts. */
export function pageFonts(): Promise<string> {
  fontRules ??= Promise.all(FONTS.map(async ({ family, weight, file }) => {
    const response = await fetch(`/fonts/${file}`)
    if (!response.ok) throw new Error(`${file}: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${btoa(binary)}) format('woff2')}`
  })).then((rules) => rules.join(''), () => {
    fontRules = null
    return ''
  })
  return fontRules
}

/** The chat's tokens a page gets, under the names its guide uses. */
const TOKENS: readonly (readonly [string, string])[] = [
  ['--ink', '--color-ink'],
  ['--ink-2', '--color-ink-2'],
  ['--ink-3', '--color-ink-3'],
  ['--panel', '--color-panel-solid'],
  ['--hairline', '--color-hairline'],
  ['--accent', '--color-accent'],
  ['--accent-tint', '--color-accent-tint'],
  ['--ok', '--color-ok'],
  ['--alert', '--color-alert'],
  ['--series-1', '--color-series-1'],
  ['--series-2', '--color-series-2'],
  ['--series-3', '--color-series-3'],
  ['--font-sans', '--font-sans'],
  ['--font-serif', '--font-serif'],
  ['--font-mono', '--font-mono'],
]

/** What a page's look is now: `{css, theme}`, its variables read from the chat's own. */
export function lookOf(root: HTMLElement): { css: string; theme: 'light' | 'dark' } {
  const computed = getComputedStyle(root)
  // A value that could end the rule is no token of ours.
  const read = (name: string) => computed.getPropertyValue(name).trim().replace(/[;{}<>]/gu, '')
  const theme = root.getAttribute('data-theme') === 'dark'
    || (root.getAttribute('data-theme') !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light'
  const ink = read('--color-ink') || 'currentColor'
  const lines = TOKENS.map(([mine, theirs]) => `${mine}:${read(theirs)}`)
  lines.push(`--well:color-mix(in srgb, ${ink} 5%, transparent)`, `--line:color-mix(in srgb, ${ink} 20%, transparent)`, `color-scheme:${theme}`)
  return { css: `:root{${lines.join(';')}}`, theme }
}

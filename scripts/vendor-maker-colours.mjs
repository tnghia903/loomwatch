// Copies the colour marks the model picker uses out of LobeHub Icons 1.95.1 (MIT) and OpenRouter's
// own brand glyphs into ui/src/lib/ai/makerColours.ts, unaltered.
//
//   curl -sSfLO https://registry.npmjs.org/@lobehub/icons-static-svg/-/icons-static-svg-1.95.1.tgz && tar -xzf icons-static-svg-1.95.1.tgz
//   curl -sSfLO https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-grape.svg   (and glyph-volt.svg)
//   node scripts/vendor-maker-colours.mjs package/icons <folder with the glyphs> ui/src/lib/ai/makerColours.ts
//
// It prints any mark with very dark fills, which would vanish on the dark theme.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [icons, openrouter, out] = process.argv.slice(2)

// The maker table's mark name -> the LobeHub colour file. Anthropic has no colour mark of its own,
// so its models' Claude mark. (Kimi's is white for dark grounds only, so Moonshot keeps its one-colour mark.)
const FROM = {
  anthropic: 'claude-color', google: 'google-color', qwen: 'qwen-color', mistral: 'mistral-color',
  deepseek: 'deepseek-color', nvidia: 'nvidia-color', meta: 'meta-color',
  bytedance: 'bytedance-color', minimax: 'minimax-color', aws: 'aws-color', cohere: 'cohere-color',
  sakana: 'sakana-color', stepfun: 'stepfun-color', upstage: 'upstage-color', tencent: 'tencent-color',
  arcee: 'arcee-color', fireworks: 'fireworks-color', longcat: 'longcat-color', perplexity: 'perplexity-color',
  microsoft: 'microsoft-color', aionlabs: 'aionlabs-color', poolside: 'poolside-color',
}

const inner = (svg) => svg
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(/<title>[\s\S]*?<\/title>/, '')
  .replace(/\s+/g, ' ')
  .trim()
const viewBox = (svg) => /viewBox="([^"]+)"/.exec(svg)[1]

const luminance = (hex) => {
  const v = hex.replace('#', '')
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const marks = {}
for (const [name, file] of Object.entries(FROM)) {
  const svg = readFileSync(join(icons, `${file}.svg`), 'utf8')
  marks[name] = { viewBox: viewBox(svg), svg: inner(svg) }
  const dark = [...svg.matchAll(/(?:fill|stop-color)="(#[0-9a-fA-F]{3,6})"/g)].map((m) => m[1]).filter((hex) => luminance(hex) < 0.12)
  const usesCurrent = /currentColor/.test(svg)
  if (dark.length || usesCurrent) console.error(`${name} (${file}): dark fills ${[...new Set(dark)].join(' ') || '-'}${usesCurrent ? ', currentColor' : ''}`)
}

// OpenRouter's own glyphs, as its brand page gives them: Grape on light, Volt on dark.
const grape = readFileSync(join(openrouter, 'glyph-grape.svg'), 'utf8')
const volt = readFileSync(join(openrouter, 'glyph-volt.svg'), 'utf8')
marks.openrouter = { viewBox: viewBox(grape), svg: inner(grape), dark: inner(volt) }

const body = Object.entries(marks)
  .map(([name, mark]) => `  ${/^[a-z]+$/.test(name) ? name : JSON.stringify(name)}: ${JSON.stringify(mark)},`)
  .join('\n')
writeFileSync(out, `// Each maker's mark in its own colours, for the model picker and anywhere a model's maker is shown.
// Copied unaltered from LobeHub Icons 1.95.1 (@lobehub/icons-static-svg, MIT License, Copyright (c)
// 2023 LobeHub; see third-party-notices.txt), and OpenRouter's from its own brand page
// (openrouter.ai/brand: Grape on light, Volt on dark). Each mark is its company's trademark and is
// shown only to say who made the model; LoomWatch is not affiliated with any of them.
// Generated: do not edit by hand.

export interface ColourMark {
  viewBox: string
  /** The mark's own SVG, inside an <svg> with that viewBox. */
  svg: string
  /** A version for the dark theme, where the mark's maker gives one. */
  dark?: string
}

export const COLOUR_MARKS: Record<string, ColourMark> = {
${body}
}
`)
console.error(`wrote ${Object.keys(marks).length} marks to ${out}`)

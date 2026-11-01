/**
 * Math as remark-math reads it: `\[…\]` starting a line becomes a `$$` block on lines of its own, and `\(…\)` a
 * `$$…$$` inside the line. Code is left as it is, and so is an escaped bracket with no math in it
 * (`\[Sourced\]`).
 */
export function withMathMarks(text: string): string {
  if (!text.includes('\\[') && !text.includes('\\(')) return text
  return text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/).map((part, index) => (index % 2 ? part : part
    .replace(/^([ \t]*)\\\[([\s\S]+?)\\\][ \t]*$/gm, (all, indent: string, math: string) => (MATHY.test(math) ? `${indent}$$\n${indent}${math.trim()}\n${indent}$$` : all))
    .replace(/\\\[([^\n]+?)\\\]/g, (all, math: string) => (MATHY.test(math) ? `$$${math.trim()}$$` : all))
    .replace(/\\\(([^\n]+?)\\\)/g, (all, math: string) => (MATHY.test(math) ? `$$${math.trim()}$$` : all)))).join('')
}
const MATHY = /[\\^_={}+\-<>]|^\s*[a-zA-Z]\s*$/

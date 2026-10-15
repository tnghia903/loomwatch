/** One run of words a change kept, took out or put in. */
export interface DiffPart {
  kind: 'same' | 'removed' | 'added'
  text: string
}

/** Above this many words on a side, the whole text is shown as replaced rather than compared. */
const MAX_WORDS = 2_000

/**
 * What changed between two versions of a piece of prose, word by word, for showing a person an
 * edit they did not make themselves. Whitespace travels with the word before it, so the parts join
 * back into each version exactly.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before)
  const b = tokens(after)
  if (a.length > MAX_WORDS || b.length > MAX_WORDS) return merge([{ kind: 'removed', text: before }, { kind: 'added', text: after }])
  // Longest common subsequence, filled from the end so the walk below reads front to back.
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = word(a[i]) === word(b[j]) ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }
  const parts: DiffPart[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (word(a[i]) === word(b[j])) {
      // The same word, perhaps with other spacing after it: a line break added or taken out.
      const kept = word(a[i])
      const [spaceBefore, spaceAfter] = [a[i].slice(kept.length), b[j].slice(kept.length)]
      parts.push({ kind: 'same', text: spaceBefore === spaceAfter ? a[i] : kept })
      if (spaceBefore !== spaceAfter) parts.push({ kind: 'removed', text: spaceBefore }, { kind: 'added', text: spaceAfter })
      i += 1
      j += 1
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      parts.push({ kind: 'removed', text: a[i] })
      i += 1
    } else {
      parts.push({ kind: 'added', text: b[j] })
      j += 1
    }
  }
  for (; i < a.length; i += 1) parts.push({ kind: 'removed', text: a[i] })
  for (; j < b.length; j += 1) parts.push({ kind: 'added', text: b[j] })
  return merge(parts)
}

/** Each word with the whitespace after it; leading whitespace is a token of its own. */
function tokens(text: string): string[] {
  return text.match(/^\s+|\S+\s*/g) ?? []
}

const word = (token: string) => token.trimEnd()

function merge(parts: DiffPart[]): DiffPart[] {
  const merged: DiffPart[] = []
  for (const part of parts) {
    if (!part.text) continue
    const last = merged[merged.length - 1]
    if (last && last.kind === part.kind) last.text += part.text
    else merged.push({ ...part })
  }
  return merged
}

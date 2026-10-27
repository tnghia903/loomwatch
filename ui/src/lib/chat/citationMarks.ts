const OPEN = ''
const CLOSE = ''
const SPLIT = ''

/**
 * `text` without the private-use citation marks `OpenAI`'s models write into an answer for
 * ChatGPT's own page to turn into links (`citeturn2search1`): they name search
 * results LoomWatch is never given, and read as "cite turn2search1" between boxes. A mark around a
 * link (`3†words†site`) keeps the link's words; any other mark goes, and a mark left open loses only
 * its opening sign.
 *
 * The daemon takes them out of answers as they arrive (`plain` in agent/chatgpt.rs, with the same
 * cases); this is for answers saved before it did.
 */
export function withoutCitationMarks(text: string): string {
  if (!text.includes(OPEN)) return text
  let out = ''
  let rest = text
  for (let start = rest.indexOf(OPEN); start >= 0; start = rest.indexOf(OPEN)) {
    out += rest.slice(0, start)
    const mark = rest.slice(start + OPEN.length)
    const end = mark.indexOf(CLOSE)
    if (end < 0) {
      rest = mark
      break
    }
    out += mark.slice(0, end).split(SPLIT)[1]?.split('†')[1] ?? ''
    rest = mark.slice(end + CLOSE.length)
  }
  return out + rest
}

import { X } from 'lucide-react'

import { BUBBLE_POINT_EDGE, BUBBLE_POINT_FILL } from '../../lib/files/pageFrame'
import { bubbleAgent, bubbleLabel, bubbleTitle, type AskedPassage, type PartLook } from '../../lib/files/passage'
import { AvatarFace } from '../agents/AvatarFace'

interface PartBubbleProps {
  passage: AskedPassage
  look: PartLook
  name: (id: string) => string
  hue: (id: string) => number
  open: boolean
  onOpen: () => void
  onFocus: (on: boolean) => void
}

/**
 * The bubble after a part asked about (ADR 0077), in the line with its words: the face of the agent
 * asked, typing while it works on it, with a gold dot once its answer waits for you. It is the way
 * to the answer. Drawn in the slot FileReader leaves after the part's last word (lib/files/partMarks.ts),
 * so the line makes room for it; a web page draws its own the same way (pageFrame.ts).
 */
export function PartBubble({ passage, look, name, hue, open, onOpen, onFocus }: PartBubbleProps) {
  const by = bubbleAgent(passage)
  return (
    <button type="button" className={`rd-bubble ${look}`} aria-label={bubbleLabel(passage, look, name)} aria-expanded={open} title={bubbleTitle(passage, look, name)}
      onClick={onOpen} onMouseEnter={() => onFocus(true)} onMouseLeave={() => onFocus(false)} onFocus={() => onFocus(true)} onBlur={() => onFocus(false)}>
      <BubblePoint />
      <AvatarFace id={by} hue={hue(by)} size={18} fontSize={9} text={initials(name(by))} className="rd-bubble-face" />
      {look === 'busy' && <span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>}
      {look === 'waiting' && <i className="rd-bubble-new" aria-hidden="true" />}
      {look === 'failed' && <X size={10} strokeWidth={3} className="rd-bubble-stop" aria-hidden="true" />}
    </button>
  )
}

/**
 * The bubble's point at the marked words, a chat bubble's tail low on its left: a flat bottom and a
 * side at 45° that leave the round end where its edge is and meet at an acute angle pointing left,
 * at the words. Filled in the bubble's own colour over its edge, and edged on those two sides only,
 * so one edge runs round the bubble and its point. In the 10 by 7 box reader.css places 5px left of
 * the bubble and 13px down. The web page draws the same (pageFrame.ts `BUBBLE_POINT`).
 */
function BubblePoint() {
  return (
    <svg className="rd-bubble-point" viewBox="0 0 10 7" aria-hidden="true" focusable="false">
      <path className="rd-bubble-point-fill" d={BUBBLE_POINT_FILL} />
      <path className="rd-bubble-point-edge" d={BUBBLE_POINT_EDGE} />
    </svg>
  )
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}

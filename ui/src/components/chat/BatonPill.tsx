import { useState } from 'react'

import { Swap } from './Appearing'

/**
 * What an agent's face in the chat's header grows into while the work is with it (lib/chat/baton.ts):
 * a pill in the agent's colour that says how the work reached it — "Asking Researcher…". Every face
 * has one, folded away, so as the work moves on, the pill that had it folds back into its face with
 * its last words while the next one grows.
 */
export function BatonPill({ words, hue, waiting }: { words: string | null; hue: number; waiting: boolean }) {
  // The words it last said, kept while it folds away.
  const [last, setLast] = useState({ words, waiting })
  if (words !== null && (words !== last.words || waiting !== last.waiting)) setLast({ words, waiting })
  const shown = words !== null ? { words, waiting } : last
  return (
    <span className={`tc-baton hue-${hue}${words !== null ? ' on' : ''}${shown.waiting ? ' waiting' : ''}`} aria-hidden="true">
      <span className="tc-baton-in">
        {shown.words !== null && !shown.waiting && <span className="chat-dots"><i /><i /><i /></span>}
        {shown.words !== null && <Swap key={shown.words} className="tc-baton-words">{shown.words}</Swap>}
      </span>
    </span>
  )
}

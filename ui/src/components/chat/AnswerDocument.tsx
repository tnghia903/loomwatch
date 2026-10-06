import { useMemo } from 'react'

import { withFolderPaths } from '../../lib/files/fileRefs'
import { Markdown } from '../ui/Markdown'

/**
 * A team's answer read as a document, in the pane beside the chat (ADR 0051): the chat shows it as
 * a card, and this is where it is read in full. Copying, saving, sending and its review stay under
 * the card, so each lives in one place.
 */
export function AnswerDocument({ text, by, streaming }: { text: string; by: string; streaming: boolean }) {
  // Names listed under a folder read as files in the sentence too.
  const shown = useMemo(() => withFolderPaths(text), [text])
  return (
    <article className="tc-document" aria-label="The team’s answer">
      <p className="tc-document-by">{streaming ? `${by} is writing this` : `Written by ${by}`}</p>
      <div className="tc-document-page delivery-response selectable">
        <Markdown>{shown}</Markdown>
        {streaming && <span key={text.length} className="caret" aria-label="Being written" />}
      </div>
    </article>
  )
}

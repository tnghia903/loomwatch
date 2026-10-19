import { useMemo } from 'react'

import { withFolderPaths } from '../../lib/files/fileRefs'
import { Markdown } from '../ui/Markdown'

/**
 * A team's answer read as a document, in the pane beside the chat (ADR 0051): the chat shows it as
 * a card, and this is where it is read in full. Copying, saving, sending and its review stay under
 * the card, so each lives in one place.
 *
 * `touched` is every file the run's agents read or wrote (`filesTouched`) and `folder` the one the
 * answering agent works in, so a file the answer names from the agent's own folder opens too.
 */
export function AnswerDocument({ text, by, streaming, touched = NONE, folder = null }: { text: string; by: string; streaming: boolean; touched?: readonly string[]; folder?: string | null }) {
  // Names listed under a folder, or given from the agent's own folder, read as files too.
  const shown = useMemo(() => withFolderPaths(text, touched, folder), [text, touched, folder])
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

const NONE: readonly string[] = []

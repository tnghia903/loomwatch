import { useMemo } from 'react'

import { FindScopeContext } from '../../lib/chat/findWords'
import { withFolderPaths } from '../../lib/files/fileRefs'
import { Markdown } from '../ui/Markdown'

/**
 * A team's answer read as a document, in the pane beside the chat (ADR 0051): the chat shows it as
 * a card, and this is where it is read in full. Copying, saving, sending and its review stay under
 * the card, so each lives in one place.
 *
 * `touched` is every file the run's agents read or wrote (`filesTouched`) and `folder` the one the
 * answering agent works in, so a file the answer names from the agent's own folder opens too;
 * `written` is what they wrote (`filesWritten`), so one it names in plain words opens as well.
 */
export function AnswerDocument({ text, by, streaming, touched = NONE, folder = null, written = NONE }: { text: string; by: string; streaming: boolean; touched?: readonly string[]; folder?: string | null; written?: readonly string[] }) {
  // Names listed under a folder, given from the agent's own folder, or of a file it wrote, read as files too.
  const shown = useMemo(() => withFolderPaths(text, touched, folder, written), [text, touched, folder, written])
  return (
    <article className="tc-document" aria-label="The team’s answer">
      <p className="tc-document-by">{streaming ? `${by} is writing this` : `Written by ${by}`}</p>
      <div className="tc-document-page delivery-response selectable">
        {/* The words a chat search found light here too, when the search opened this answer (ADR 0081). */}
        <FindScopeContext.Provider value><Markdown>{shown}</Markdown></FindScopeContext.Provider>
        {streaming && <span key={text.length} className="caret" aria-label="Being written" />}
      </div>
    </article>
  )
}

const NONE: readonly string[] = []

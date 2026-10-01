import { createElement } from 'react'

import { baseName, extensionOf, fileLabel } from '../../lib/files/fileRefs'
import { fileIcon } from '../../lib/files/icons'
import { useFileActions, useFileLookup } from '../../lib/files/useFile'

/**
 * A file named in the middle of a sentence (ADR 0026): its name and icon in place of the path, and
 * a click opens it — or shows it in its folder when it is not a kind LoomWatch opens. The full
 * card, with size and folder, sits in the output header; this keeps the sentence a sentence.
 */
export function FileChip({ path }: { path: string }) {
  const lookup = useFileLookup(path)
  const { said, busy, open } = useFileActions(path)
  const facts = lookup?.state === 'found' ? lookup.facts : null
  const name = facts?.name ?? baseName(path)
  const usable = Boolean(facts?.exists)
  const reveal = usable && !facts?.openable
  const why = !lookup
    ? 'Checking…'
    : lookup.state === 'outside'
      ? 'Outside your teams folder'
      : lookup.state === 'unknown' || !facts
        ? fileLabel(path)
        : !facts.exists
          ? 'Not on this computer any more'
          : reveal ? `${fileLabel(path)} · show in folder` : `${fileLabel(path)} · open`
  return (
    <span className="file-chip-wrap">
      <button type="button" className={`file-chip ${usable ? '' : 'muted'}`} disabled={!usable || busy} onClick={() => void open(reveal)} title={`${path}\n${why}`} aria-label={usable ? `${reveal ? 'Show' : 'Open'} ${name} (${fileLabel(path)})` : `${name}: ${why}`}>
        {createElement(fileIcon(facts?.kind, path), { size: 13, 'aria-hidden': true })}
        <span className="file-chip-name">{name}</span>
        {extensionOf(path) && <span className="file-chip-ext" aria-hidden="true">{extensionOf(path).toUpperCase()}</span>}
      </button>
      <span className="file-chip-said" role="status">{said}</span>
    </span>
  )
}

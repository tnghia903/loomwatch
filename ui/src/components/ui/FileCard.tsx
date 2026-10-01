import { Check, Copy, ExternalLink, FolderOpen } from 'lucide-react'
import { createElement } from 'react'

import { baseName, extensionOf, fileLabel, fileNoun, fileTitle, folderWords, formatBytes, workspaceAgent } from '../../lib/files/fileRefs'
import { fileIcon } from '../../lib/files/icons'
import { useFileActions, useFileLookup } from '../../lib/files/useFile'
import { relativeTime } from '../../lib/format'
import { AgentMark } from './AgentMark'

interface FileCardProps {
  path: string
  /** A row in a list of several files, rather than the one deliverable. */
  compact?: boolean
  /** The team's agents, so a file in an agent's workspace is credited to it by name and mark. */
  agents?: ReadonlyArray<{ id: string; name: string }>
}

/**
 * A file an agent produced, presented as the deliverable it is (ADR 0026): drawn as a sheet with
 * its type, titled in words, with its size, age and maker — and one click to open it in its own
 * app, show it in its folder, or copy the path. The gilt woven edge marks it as finished work.
 */
export function FileCard({ path, compact = false, agents = [] }: FileCardProps) {
  const lookup = useFileLookup(path)
  const { said, busy, open, copy } = useFileActions(path)
  const facts = lookup?.state === 'found' ? lookup.facts : null
  const name = facts?.name ?? baseName(path)
  const extension = extensionOf(path).toUpperCase()
  const missing = facts ? !facts.exists : false
  const outside = lookup?.state === 'outside'
  const canOpen = Boolean(facts?.exists && facts.openable)
  const meta = !lookup
    ? 'Checking…'
    : outside
      ? 'Outside your teams folder, so LoomWatch won’t open it. Copy the path instead.'
      : lookup.state === 'unknown'
        ? fileLabel(path)
        : missing
          ? 'Not on this computer any more'
          : [fileLabel(path), facts?.sizeBytes != null ? formatBytes(facts.sizeBytes) : null, facts?.modifiedAt ? `changed ${relativeTime(new Date(facts.modifiedAt))}` : null].filter(Boolean).join(' · ')
  const eyebrow = canOpen ? 'Ready to open' : facts?.exists ? 'Ready in its folder' : missing ? 'Missing' : outside ? 'Can’t open here' : 'File'
  const workspace = facts?.exists ? workspaceAgent(facts.folder) : null
  const maker = workspace ? agents.find((agent) => agent.id === workspace.agent) : undefined
  const icon = createElement(fileIcon(facts?.kind, path), { size: compact ? 13 : 14 })

  return (
    <span className={['file-card', compact ? 'compact' : 'hero', canOpen && 'ready', (missing || outside) && 'muted'].filter(Boolean).join(' ')} title={path}>
      <span className="file-sheet" aria-hidden="true">
        <span className="file-sheet-icon">{icon}</span>
        {!compact && <span className="file-sheet-rules"><i /><i /><i /><i /></span>}
        {extension && <span className="file-sheet-ext">{extension}</span>}
      </span>
      <span className="file-card-body">
        {!compact && <span className="file-card-eyebrow">{eyebrow}</span>}
        {!compact && <span className="file-card-title">{fileTitle(name)}</span>}
        <span className="file-card-name">{name}</span>
        <span className="file-card-meta">{meta}</span>
        {!compact && maker && workspace && (
          <span className="file-card-by"><AgentMark id={maker.id} size={16} />Made by {maker.name} · {workspace.team}</span>
        )}
        {!compact && !maker && facts?.exists && <span className="file-card-where">{folderWords(facts.folder, path)}</span>}
      </span>
      <span className="file-card-acts">
        <button type="button" className="file-card-open" disabled={!canOpen || busy} onClick={() => void open()} aria-label={`Open ${name}`} title={canOpen ? 'Open in its own app' : facts?.exists ? 'This kind of file opens from its folder' : undefined}>
          <ExternalLink size={compact ? 13 : 15} aria-hidden="true" />{compact ? 'Open' : `Open ${fileNoun(path)}`}
        </button>
        {!compact && (
          <button type="button" className="file-card-reveal" disabled={!facts?.exists || busy} onClick={() => void open(true)} aria-label={`Show ${name} in its folder`} title="Show in folder">
            <FolderOpen size={14} aria-hidden="true" /><span className="file-card-reveal-label">Show in folder</span>
          </button>
        )}
        <button type="button" className="file-card-icon" onClick={() => void copy()} aria-label={`Copy the path of ${name}`} title="Copy path">{said === 'Path copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button>
      </span>
      <span className="file-card-said" role="status">{said === 'Path copied' ? '' : said}</span>
    </span>
  )
}

import { memo } from 'react'

import type { ChatFile } from '../../lib/chat/client'
import { rawFileUrl, useReadHere } from '../../lib/files/reader'
import { FileCard } from '../ui/FileCard'

/** How big a sent picture is drawn in the chat, in CSS pixels: the box it fits inside. */
const THUMB = 120

/**
 * The files you sent with a message (ADR 0081): pictures drawn small, each opening full size in the
 * reader beside the chat, and any other file as the card a file in the chat always is.
 *
 * Kept by path: the chat reads its page again every few seconds, and a picture whose address never
 * changes is never fetched again.
 */
export const ChatFiles = memo(function ChatFiles({ files }: { files: readonly ChatFile[] }) {
  if (files.length === 0) return null
  const pictures = files.filter((file) => file.picture)
  const others = files.filter((file) => !file.picture)
  return (
    <div className="tc-sent-files tc-files">
      {pictures.length > 0 && (
        <div className="tc-sent-pictures">
          {pictures.map((file) => <SentPicture key={file.path} file={file} />)}
        </div>
      )}
      {others.map((file) => <FileCard key={file.path} path={file.path} compact />)}
    </div>
  )
}, (before, after) => before.files.length === after.files.length && before.files.every((file, index) => file.path === after.files[index].path))

function SentPicture({ file }: { file: ChatFile }) {
  const read = useReadHere(file.path)
  const open = read ?? (() => window.open(rawFileUrl(file.path), '_blank', 'noopener'))
  return (
    <button type="button" className="tc-sent-picture" onClick={open} aria-label={`Look at ${file.name}`} title={file.name}>
      <img src={rawFileUrl(file.path)} alt="" loading="lazy" decoding="async" width={THUMB} height={THUMB} />
    </button>
  )
}

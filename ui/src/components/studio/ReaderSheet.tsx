import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { FileToRead } from '../../lib/files/reader'
import { FileReader } from '../reader/FileReader'

const NO_HUE = () => 1

/**
 * A file the agents made, read where you are, on Home or in a room (ADR 0097): the reader, over the
 * page. Asking about a part of it is done in the team's chat, where the work is.
 */
export function ReaderSheet({ file, name, onClose }: { file: FileToRead; name: (id: string) => string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    close.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  return (
    <div className="reader-sheet-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="reader-sheet" role="dialog" aria-modal="true" aria-label={file.path.split(/[\\/]/).pop() ?? 'File'}>
        <div className="reader-sheet-top">
          <button ref={close} type="button" className="iconbtn" onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button>
        </div>
        {/* The reader fills what holds it, as it fills the chat's pane. */}
        <div className="reader-sheet-body">
          <FileReader key={file.path} file={file} name={name} hue={NO_HUE} />
        </div>
      </section>
    </div>
  )
}

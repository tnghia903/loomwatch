import { File, FileArchive, FileAudio, FileCode, FileImage, FileJson, FileSpreadsheet, FileText, FileVideo, Folder, Globe, Presentation, type LucideIcon } from 'lucide-react'

import { extensionOf } from './fileRefs'

const ICONS: Record<string, LucideIcon> = {
  document: FileText, spreadsheet: FileSpreadsheet, slides: Presentation, pdf: FileText, image: FileImage,
  media: FileVideo, markdown: FileText, text: FileText, web: Globe, data: FileJson, archive: FileArchive,
  code: FileCode, folder: Folder,
}

/** The icon for a file: by the daemon's `kind` once known, else a plain page. */
export function fileIcon(kind: string | undefined, path: string): LucideIcon {
  if (!kind || !ICONS[kind]) return File
  return kind === 'media' && /^(mp3|wav|m4a)$/.test(extensionOf(path)) ? FileAudio : ICONS[kind]
}

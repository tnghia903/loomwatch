import { File, FileArchive, FileAudio, FileCode, FileImage, FileJson, FileSpreadsheet, FileText, FileVideo, Folder, Globe, Presentation, type IconComponent } from '../../components/ui/icon'

import { extensionOf } from './fileRefs'

const ICONS: Record<string, IconComponent> = {
  document: FileText, spreadsheet: FileSpreadsheet, slides: Presentation, pdf: FileText, image: FileImage,
  media: FileVideo, markdown: FileText, text: FileText, web: Globe, data: FileJson, archive: FileArchive,
  code: FileCode, folder: Folder,
}

/** The icon for a file: by the daemon's `kind` once known, else a plain page. */
export function fileIcon(kind: string | undefined, path: string): IconComponent {
  if (!kind || !ICONS[kind]) return File
  return kind === 'media' && /^(mp3|wav|m4a)$/.test(extensionOf(path)) ? FileAudio : ICONS[kind]
}

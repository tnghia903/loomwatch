// What went into the notch's slot for the pinned agent (ADR 0083, decision 10): files, a picture,
// a link or some text, dragged from any app. Pure: what it is, what to call it, the jobs that fit
// it, and the words sent with it.

export interface Intake {
  files: readonly File[]
  /** A link dragged in, from a browser's address bar or a page. */
  link: string | null
  /** Text dragged in, a selection from any app. */
  text: string | null
}

export type IntakeKind = 'email' | 'document' | 'picture' | 'table' | 'files' | 'link' | 'text'

// The kinds the pinned agent opens (`readable`): a HEIC photo or a Numbers file never gets in.
const PICTURE = /\.(png|jpe?g|gif|webp)$/i
const TABLE = /\.(csv|tsv|xlsx|xlsm|xlsb|xls|ods)$/i
/** A message dragged from Mail comes as a file of this kind. */
const EMAIL = /\.eml$/i

const emails = (intake: Intake) => intake.files.length > 0 && intake.files.every((file) => EMAIL.test(file.name))

/** What a drop carries, or `null` when it carries nothing the agent can take. */
export function intakeFrom(data: { files: Iterable<File> | null; getData: DataTransfer['getData'] }): Intake | null {
  const files = [...(data.files ?? [])]
  const uris = (data.getData('text/uri-list') || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  const plain = (data.getData('text/plain') || '').trim()
  const link = files.length ? null : uris.find((uri) => /^https?:\/\//i.test(uri)) ?? (/^https?:\/\/\S+$/i.test(plain) ? plain : null)
  const text = files.length || link ? null : plain || null
  if (!files.length && !link && !text) return null
  return { files, link, text }
}

/** What waits in the box after another drop: its files join the files already there, each once;
    a link or some text takes the place of what was there, as files do of a link or text. */
export function withDropped(waiting: Intake | null, dropped: Intake): Intake {
  if (!waiting?.files.length || !dropped.files.length) return dropped
  const key = (file: File) => `${file.name}\n${file.size}`
  const there = new Set(waiting.files.map(key))
  return { ...dropped, files: [...waiting.files, ...dropped.files.filter((file) => !there.has(key(file)))] }
}

export function kindOf(intake: Intake): IntakeKind {
  if (emails(intake)) return 'email'
  if (intake.files.length > 1) return 'files'
  const file = intake.files[0]
  if (file) return PICTURE.test(file.name) || file.type.startsWith('image/') ? 'picture' : TABLE.test(file.name) ? 'table' : 'document'
  return intake.link ? 'link' : 'text'
}

/** The three jobs offered for what went in, most likely first. Plain words a person would say. */
export function jobsFor(kind: IntakeKind): readonly [string, string, string] {
  switch (kind) {
    case 'email': return ['Draft a reply', 'Summarize it', 'What do they want?']
    case 'document': return ['What should I check?', 'Summarize it', 'Pull out the dates']
    case 'picture': return ['What is this?', 'Describe it', 'Copy out the words']
    case 'table': return ['What stands out?', 'Summarize it', 'Find the totals']
    case 'files': return ['Compare them', 'Summarize each', 'What should I check?']
    case 'link': return ['Summarize the page', 'Is it worth reading?', 'Pull out the key points']
    case 'text': return ['Explain it', 'Reply to it', 'Make it shorter']
  }
}

/** What the chip in the box says went in: "Lease 2027.pdf", "3 files", "a link to example.com". */
export function intakeLabel(intake: Intake): string {
  // An email is called by its subject, as Mail names its file.
  if (emails(intake)) return intake.files.length > 1 ? `${intake.files.length} emails` : intake.files[0].name.replace(EMAIL, '')
  if (intake.files.length > 1) return `${intake.files.length} files`
  if (intake.files[0]) return intake.files[0].name
  if (intake.link) {
    try { return `a link to ${new URL(intake.link).hostname.replace(/^www\./, '')}` } catch { return 'a link' }
  }
  const words = (intake.text ?? '').replace(/\s+/g, ' ').trim()
  return `“${words.length > 40 ? `${words.slice(0, 39).trimEnd()}…` : words}”`
}

/** The message sent: what to do, then the link or the text it is about. Files go with it as the
    chat's own attachments. */
export function messageFor(intake: Intake, job: string): string {
  const ask = job.trim()
  if (intake.link) return `${ask}\n\n${intake.link}`
  if (intake.text) return `${ask}\n\n${intake.text.split('\n').map((line) => `> ${line}`).join('\n')}`
  return ask
}

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

export type IntakeKind = 'document' | 'picture' | 'table' | 'files' | 'link' | 'text'

const PICTURE = /\.(png|jpe?g|gif|webp|heic|tiff?)$/i
const TABLE = /\.(csv|tsv|xlsx?|numbers)$/i

/** What a drop carries, or `null` when it carries nothing the agent can take. */
export function intakeFrom(data: Pick<DataTransfer, 'files' | 'getData'>): Intake | null {
  const files = [...(data.files ?? [])]
  const uris = (data.getData('text/uri-list') || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  const plain = (data.getData('text/plain') || '').trim()
  const link = files.length ? null : uris.find((uri) => /^https?:\/\//i.test(uri)) ?? (/^https?:\/\/\S+$/i.test(plain) ? plain : null)
  const text = files.length || link ? null : plain || null
  if (!files.length && !link && !text) return null
  return { files, link, text }
}

export function kindOf(intake: Intake): IntakeKind {
  if (intake.files.length > 1) return 'files'
  const file = intake.files[0]
  if (file) return PICTURE.test(file.name) || file.type.startsWith('image/') ? 'picture' : TABLE.test(file.name) ? 'table' : 'document'
  return intake.link ? 'link' : 'text'
}

/** The three jobs offered for what went in, most likely first. Plain words a person would say. */
export function jobsFor(kind: IntakeKind): readonly [string, string, string] {
  switch (kind) {
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

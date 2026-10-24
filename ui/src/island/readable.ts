// What dropped on the island the box's agent can open, decided before it goes (ADR 0083,
// decision 10): the same rule `read_file` follows in the daemon (`documents::Kind::of`, and a NUL
// in a file's first 8 KB for one that is none of those kinds). The daemon is the twin: a kind it
// learns to read is taken here too. A photo or picture in a kind it can't open is turned into a
// JPEG here, as WebKit can draw it. Anything else it can't open is turned away at the notch, with
// why and what to do instead, rather than sent for the agent to find it can't.

import { MAX_CHAT_FILE_BYTES, MAX_CHAT_FILES } from '../lib/chat/attachments'

/** How much of a file is looked at to tell text from a file of another kind. */
const HEAD_BYTES = 8192

/** Kinds `read_file` reads: as text (PDF, Word, Excel, PowerPoint) or as a picture. */
const READ = /\.(pdf|docx|docm|dotx|xlsx|xlsm|xlsb|xls|ods|pptx|pptm|ppsx|png|jpe?g|gif|webp)$/i

/** Pictures it can't open that are turned into a JPEG first: an iPhone's HEIC photos, TIFF, BMP. */
const TURNED_INTO_JPEG = /\.(heic|heif|tiff?|bmp)$/i
/** The longest side of a picture turned into a JPEG: no more than the daemon sends a model. */
const PICTURE_SIDE = 2576

/** Kinds it can't open, with what the person can do instead, in their words. A kind is told by its
    name only when the file isn't text, so a text file that happens to end in `.key` still goes. */
const NOT_READ: ReadonlyArray<readonly [RegExp, (who: string) => string]> = [
  [/\.pages$/i, (who) => `${who} can’t open Pages files. In Pages, choose File › Export To › PDF, then drop the PDF.`],
  [/\.numbers$/i, (who) => `${who} can’t open Numbers files. In Numbers, choose File › Export To › Excel, then drop that.`],
  [/\.key$/i, (who) => `${who} can’t open Keynote files. In Keynote, choose File › Export To › PDF, then drop the PDF.`],
  [/\.(heic|heif)$/i, (who) => `${who} can’t open this photo. In Preview, choose File › Export, pick JPEG, then drop the new photo.`],
  [/\.(tiff?|bmp)$/i, (who) => `${who} can’t open this kind of picture. In Preview, choose File › Export, pick PNG, then drop the new picture.`],
  [/\.doc$/i, (who) => `${who} can’t open old Word files. Open it in Pages, choose File › Export To › PDF, then drop the PDF.`],
  [/\.(ppt|pps)$/i, (who) => `${who} can’t open old PowerPoint files. Open it in Keynote, choose File › Export To › PDF, then drop the PDF.`],
  [/\.(zip|rar|7z|tar|gz|tgz)$/i, (who) => `${who} can’t open compressed files. Double-click to open, then drop the files inside.`],
  [/\.(mp3|m4a|wav|aiff?|aac|flac|ogg)$/i, (who) => `${who} can’t listen to recordings.`],
  [/\.(mov|mp4|m4v|avi|mkv|webm)$/i, (who) => `${who} can’t watch videos.`],
]

const TOO_BIG = 'Files over 25 MB are too big to send.'
const TOO_MANY = `Only ${MAX_CHAT_FILES} files at a time. Send these, then drop the rest.`

/** Whether a file's first bytes are a PDF or a picture `read_file` takes, whatever its name. */
function readByContent(head: Uint8Array): boolean {
  const starts = (bytes: readonly number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte)
  const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))
  return starts(ascii('%PDF-'))
    || starts([0x89, ...ascii('PNG\r\n'), 0x1a, 0x0a])
    || starts([0xff, 0xd8, 0xff])
    || starts(ascii('GIF8'))
    || (starts(ascii('RIFF')) && starts(ascii('WEBP'), 8))
}

/** Why `who` can't open a file named `name` of `size` bytes starting with `head`, or `null` when
    it can. Pure: the rule itself. What it is comes before how big, so a video over 25 MB says it
    is a video. */
export function cantOpen(name: string, size: number, head: Uint8Array, who: string): string | null {
  const text = !head.includes(0)
  const known = text ? undefined : NOT_READ.find(([kind]) => kind.test(name))
  if (known) return known[1](who)
  if (!READ.test(name) && !readByContent(head) && !text) return `${who} can’t open this kind of file.`
  return size > MAX_CHAT_FILE_BYTES ? TOO_BIG : null
}

/** What a drop holds, sorted: the files `who` can open, with `waiting` files already in the box,
    and what was left out and why, a line for each reason, or `null` when nothing was. */
export async function sortDropped(files: readonly File[], folders: readonly string[], who: string, waiting = 0): Promise<{ taken: File[]; away: string | null }> {
  const checked = await Promise.all(files.map(async (file) => {
    const turned = TURNED_INTO_JPEG.test(file.name) ? await asJpeg(file) : null
    const opened = turned ?? file
    return { file: opened, why: cantOpen(opened.name, opened.size, await head(opened), who) }
  }))
  const opened = checked.filter((each) => each.why === null).map((each) => each.file)
  const room = Math.max(0, MAX_CHAT_FILES - waiting)
  const taken = opened.slice(0, room)
  const left = [
    // A Pages, Numbers or Keynote file may come as a folder: it says what it is.
    ...folders.map((name) => ({ name, why: NOT_READ.find(([kind]) => kind.test(name))?.[1](who) ?? `${who} can’t take a folder here. Open it and drop the files inside.` })),
    ...checked.filter((each) => each.why !== null).map((each) => ({ name: each.file.name, why: each.why! })),
    ...opened.slice(room).map((file) => ({ name: file.name, why: TOO_MANY })),
  ]
  if (!left.length) return { taken, away: null }
  // One thing dropped: why, as it is. More: which were left out, a line for each reason.
  if (files.length + folders.length === 1) return { taken, away: left[0].why }
  const byReason = new Map<string, string[]>()
  for (const { name, why } of left) byReason.set(why, [...(byReason.get(why) ?? []), name])
  return { taken, away: [...byReason].map(([why, names]) => `Left out ${listed(names)}. ${why}`).join('\n') }
}

/** "A", "A and B", "A, B and C", or "A, B and 4 more". */
function listed(names: readonly string[]): string {
  if (names.length === 1) return names[0]
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

/** A picture WebKit can draw, as a JPEG no bigger than a model is sent, or `null` when it can't. */
async function asJpeg(file: File): Promise<File | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    const picture = await createImageBitmap(file)
    const scale = Math.min(1, PICTURE_SIDE / Math.max(picture.width, picture.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(picture.width * scale))
    canvas.height = Math.max(1, Math.round(picture.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    // A JPEG has no see-through parts: they come out white, as on paper.
    context.fillStyle = 'white'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(picture, 0, 0, canvas.width, canvas.height)
    picture.close()
    const jpeg = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.9))
    return jpeg ? new File([jpeg], file.name.replace(TURNED_INTO_JPEG, '.jpg'), { type: 'image/jpeg' }) : null
  } catch {
    return null
  }
}

/** A file's first bytes, or a NUL when it can't be read (a folder, or a file gone since). */
async function head(file: File): Promise<Uint8Array> {
  try {
    return new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())
  } catch {
    return new Uint8Array([0])
  }
}

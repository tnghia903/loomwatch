import type { BoxAt, TimeAt } from '../chat/client'
import { WHOLE } from './parts'

/**
 * Parts of a recording (ADR 0091): a moment or a span of it, kept in milliseconds from its start
 * (`chat::PartAt::Time`), named as a player shows time, and sent as the frames at it so the agent
 * sees what was on screen.
 */

/** The longest side of a frame sent to the agent. */
const FRAME_MOST = 1_600
/** How long to wait for a recording to reach a moment before giving up on its frame. */
const SEEK_LIMIT_MS = 4_000

/** `42_000` → "0:42", `3_723_000` → "1:02:03": time as a player shows it, to the second. */
export function clockTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** A moment, or the span between two moments either way round; a span under a second is a moment. */
export function timeBetween(a: number, b: number): TimeAt {
  const start = Math.max(0, Math.round(Math.min(a, b)))
  const end = Math.round(Math.max(a, b))
  return end - start >= 1000 ? { kind: 'time', start, end } : { kind: 'time', start }
}

/** What a moment or a span is called in the chat's quote. */
export function timeLabel(at: TimeAt): string {
  return at.end === undefined ? `The moment at ${clockTime(at.start)}` : `From ${clockTime(at.start)} to ${clockTime(at.end)}`
}

/** The moments whose frames are sent: the moment itself, or a span's start, middle and end. */
export function frameTimes(at: TimeAt | BoxAt): number[] {
  if (at.kind === 'box') return at.ms === undefined ? [] : [at.ms]
  if (at.end === undefined) return [at.start]
  return [at.start, Math.round((at.start + at.end) / 2), at.end]
}

/** Goes to `ms` in the recording and answers once its frame is there; `false` if it never came. */
function seekTo(video: HTMLVideoElement, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const target = ms / 1000
    if (Math.abs(video.currentTime - target) < 0.04 && video.readyState >= 2) { done(true); return }
    const finish = (ok: boolean) => { video.removeEventListener('seeked', seeked); window.clearTimeout(timer); done(ok) }
    const seeked = () => finish(true)
    const timer = window.setTimeout(() => finish(false), SEEK_LIMIT_MS)
    video.addEventListener('seeked', seeked)
    video.currentTime = target
  })
}

/**
 * A hidden copy of a recording to take its frames from, so the one on screen neither jumps nor
 * flickers while they are taken; `null` when the copy can't load in time.
 */
export function stillCopy(video: HTMLVideoElement): Promise<HTMLVideoElement | null> {
  const src = video.currentSrc || video.src
  if (!src) return Promise.resolve(null)
  const copy = document.createElement('video')
  copy.muted = true
  copy.preload = 'auto'
  copy.src = src
  if (copy.readyState >= 2) return Promise.resolve(copy)
  return new Promise((done) => {
    const finish = (ok: boolean) => {
      copy.removeEventListener('loadeddata', loaded)
      copy.removeEventListener('error', failed)
      window.clearTimeout(timer)
      done(ok ? copy : null)
    }
    const loaded = () => finish(true)
    const failed = () => finish(false)
    const timer = window.setTimeout(() => finish(false), SEEK_LIMIT_MS)
    copy.addEventListener('loadeddata', loaded)
    copy.addEventListener('error', failed)
  })
}

/**
 * The frames of a recording at `times`, as PNG files named after it, each no longer than
 * `FRAME_MOST`; `box` cuts each down to a part of the frame. The recording is left where it was.
 */
export async function framesOf(video: HTMLVideoElement, times: readonly number[], name: (index: number) => string, box?: BoxAt): Promise<File[]> {
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height || times.length === 0) return []
  const was = video.currentTime
  const paused = video.paused
  video.pause()
  const files: File[] = []
  for (const [index, ms] of times.entries()) {
    if (!(await seekTo(video, ms))) continue
    const sx = box ? (width * box.x) / WHOLE : 0
    const sy = box ? (height * box.y) / WHOLE : 0
    const sw = box ? Math.max(1, (width * box.w) / WHOLE) : width
    const sh = box ? Math.max(1, (height * box.h) / WHOLE) : height
    const scale = Math.min(1, FRAME_MOST / Math.max(sw, sh))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sw * scale))
    canvas.height = Math.max(1, Math.round(sh * scale))
    const context = canvas.getContext('2d')
    if (!context) break
    try {
      context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    } catch {
      break
    }
    const blob = await new Promise<Blob | null>((resolve) => {
      try { canvas.toBlob(resolve, 'image/png') } catch { resolve(null) }
    })
    if (blob) files.push(new File([blob], name(index), { type: 'image/png' }))
  }
  await seekTo(video, was * 1000)
  if (!paused) void video.play().catch(() => undefined)
  return files
}

// "Send feedback": a prefilled GitHub issue, opened by the operator in their own browser.
// LoomWatch never posts anything itself; it only builds the link and the details it carries.
import { daemonFetch } from '../daemonFetch'
import { harnessProblem, type DetectedHarness } from '../harnesses'

/** Where LoomWatch's issues live. */
export const FEEDBACK_REPOSITORY = 'https://github.com/tnghia903/loomwatch'

export type FeedbackKind = 'problem' | 'idea'

/** The issue form each kind opens, in `.github/ISSUE_TEMPLATE/`. */
const TEMPLATES: Record<FeedbackKind, string> = { problem: 'bug_report.yml', idea: 'feedback.yml' }

/**
 * The form field both templates prefill with {@link describeSystem}'s text. GitHub fills an issue
 * form's field from the query parameter named after its `id`, so this must match both forms.
 */
export const DETAILS_FIELD = 'details'

/**
 * Longest details text put in the link. GitHub answers an overlong URL with 414, so a huge error
 * message is cut rather than costing the operator the whole report.
 */
const MAX_DETAILS = 3000

/** `GET /api/about`: which LoomWatch is running, and on what. */
export interface AboutLoomWatch {
  version: string
  /** The checkout `./loomwatch` started, such as `b4e3373` or `b4e3373-dirty`. */
  commit: string | null
  /** Rust's name for the system: `macos`, `linux`, `windows`. */
  os: string
  /** The macOS release, such as `26.0`. */
  osVersion: string | null
  arch: string
  /** When this daemon started. Tells one start from the next; absent before Update and restart. */
  startedAt?: string
}

export async function fetchAbout(signal?: AbortSignal): Promise<AboutLoomWatch> {
  const response = await daemonFetch('/api/about', signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`The server answered ${response.status}.`)
  return (await response.json()) as AboutLoomWatch
}

export type FeedbackScreen = 'home' | 'build' | 'run'

/** What the operator was looking at, and any error they are reporting. */
export interface FeedbackContext {
  screen?: FeedbackScreen
  /** An error to report, such as the one the crash screen shows. */
  error?: string
}

const SCREENS: Record<FeedbackScreen, string> = { home: 'Home', build: 'Build (editing a team)', run: 'Run (watching a run)' }
const SYSTEMS: Record<string, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' }

/** The browser and its major version, from a user agent string. Unknown agents pass through. */
export function browserName(userAgent: string): string {
  const major = (pattern: RegExp) => userAgent.match(pattern)?.[1]
  const edge = major(/Edg\/(\d+)/)
  if (edge) return `Edge ${edge}`
  const firefox = major(/Firefox\/(\d+)/)
  if (firefox) return `Firefox ${firefox}`
  const chrome = major(/Chrome\/(\d+)/)
  if (chrome) return `Chrome ${chrome}`
  const safari = major(/Version\/([\d.]+).*Safari\//)
  if (safari) return `Safari ${safari}`
  return userAgent.slice(0, 120) || 'unknown'
}

/**
 * Replace the operator's home folder with `~`, so a path inside an error message does not carry
 * their account name into a report others can read.
 */
export function withoutHomeFolder(text: string): string {
  return text.replace(/\/(Users|home)\/[^/\s'"`)]+/g, '~').replace(/[A-Za-z]:\\Users\\[^\\\s'"`)]+/g, '~')
}

/**
 * The details added to a report, one fact per line. It names the build, the system, the browser,
 * the screen and which AI apps can start, never a team, a file, a prompt or a run's contents.
 */
export function describeSystem(
  about: AboutLoomWatch | null,
  harnesses: readonly DetectedHarness[] | null,
  context: FeedbackContext,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): string {
  const lines: string[] = []
  if (about) {
    lines.push(`LoomWatch: ${about.version}${about.commit ? ` (${about.commit})` : ''}`)
    const system = SYSTEMS[about.os] ?? about.os
    lines.push(`System: ${system}${about.osVersion ? ` ${about.osVersion}` : ''} (${about.arch})`)
  } else {
    lines.push('LoomWatch: unknown (the LoomWatch server did not answer)')
  }
  lines.push(`Browser: ${browserName(userAgent)}`)
  if (context.screen) lines.push(`Screen: ${SCREENS[context.screen]}`)
  if (harnesses) {
    const apps = harnesses.map((harness) => {
      const problem = harnessProblem(harness)
      return problem ? `${harness.name} (can't start: ${problem.slice(0, 160)})` : `${harness.name} (ready)`
    })
    lines.push(`AI apps: ${apps.length > 0 ? apps.join('; ') : 'none found'}`)
  }
  if (context.error) lines.push(`Error: ${context.error.slice(0, 1200)}`)
  const text = withoutHomeFolder(lines.join('\n'))
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS - 1)}…` : text
}

/** The GitHub "new issue" link for a kind of report, with its form's details field filled in. */
export function issueUrl(kind: FeedbackKind, details: string, title?: string): string {
  const url = new URL(`${FEEDBACK_REPOSITORY}/issues/new`)
  url.searchParams.set('template', TEMPLATES[kind])
  if (title) url.searchParams.set('title', withoutHomeFolder(title).slice(0, 120))
  url.searchParams.set(DETAILS_FIELD, details)
  return url.toString()
}

/** Asks the app's one feedback dialog to open; see `components/feedback/Feedback.tsx`. */
export const FEEDBACK_EVENT = 'loomwatch:feedback'

export function openFeedback(context: FeedbackContext = {}): void {
  window.dispatchEvent(new CustomEvent<FeedbackContext>(FEEDBACK_EVENT, { detail: context }))
}

/**
 * Why a call didn't work, in words someone who has never opened Terminal can follow.
 *
 * A failed call leaves its reason in its output: a Python traceback ending `HTTP Error 403:
 * Forbidden`, npm's `EPERM` eight lines above a last line that only says how to see more logs,
 * LoomWatch's own "facts.md doesn't exist.". The record's panel led with that output, so a
 * newcomer met a traceback where they wanted a sentence. Here the whole output is read for the
 * reasons that come up, most specific first, and each is said as what happened: "The website
 * said no." The code it was read from stays beside it, small, for anyone who wants to look it up.
 *
 * Output that matches none of them is said to be beyond plain words (`known: false`), and the
 * panel opens its technical details instead of guessing.
 */

import { baseName } from '../files/paths'
import { thisComputer } from '../platform'
import type { EvidenceKind } from '../watch/events'

export interface Why {
  /** The reason as a sentence: "The website said no." */
  text: string
  /** The code the reason was read from, shown small beside it: "403". */
  code?: string
  /** False when nothing in the output said why. */
  known: boolean
}

/** A URL's site, without `www.`, or `null`. */
function siteOf(text: string | undefined): string | null {
  if (!text) return null
  try { return new URL(text).hostname.replace(/^www\./, '') } catch { return null }
}

/** What an HTTP status says, from the site's side. */
function website(status: number, site: string | null): Why {
  const it = site ?? 'The website'
  const code = String(status)
  if (status === 401) return { text: `${it} wants a sign-in first.`, code, known: true }
  if (status === 403) return { text: `${it} said no.`, code, known: true }
  if (status === 404 || status === 410) return { text: site ? `That page isn’t on ${site}.` : 'That page isn’t there.', code, known: true }
  if (status === 429) return { text: `${it} asked it to slow down.`, code, known: true }
  if (status >= 500) return { text: `${it} had a problem on its side.`, code, known: true }
  return { text: `${it} turned the request down.`, code, known: true }
}

/** The HTTP status a failed request reported, and the page when the error names it. */
function httpError(output: string): { status: number; url?: string } | null {
  const patterns = [
    /HTTP Error (\d{3})/, // Python's urllib
    /\b(\d{3}) (?:Client|Server) Error\b[^\n]*?(?:for url: (\S+))?$/m, // requests
    /returned error: (\d{3})/, // curl --fail
    /\bHTTP\/[\d.]+ ([45]\d\d)\b/, // a status line
    /\bstatus(?: code)?[:= ]+([45]\d\d)\b/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(output)
    if (match && Number(match[1]) >= 400) return { status: Number(match[1]), url: match[2] }
  }
  return null
}

/** A path a message named, as its file's name. */
const named = (path: string | undefined) => (path ? baseName(path.trim().replace(/[.:]$/, '')) : null)
/** "This Mac", or "This PC" on Windows, to start a sentence with. */
const ThisComputer = () => { const said = thisComputer(); return `${said[0].toUpperCase()}${said.slice(1)}` }

/** Why the call that left this output failed. `kind` picks the words when nothing says. */
export function whyItFailed(output: string, kind: EvidenceKind): Why {
  const text = output.trim()
  const known = (reason: string, code?: string): Why => ({ text: reason, code, known: true })

  // LoomWatch's own limits, named as such: it is the reason, whatever the program made of it.
  const sandbox = text.indexOf('(The sandbox blocked this')
  if (sandbox >= 0) {
    // The note names both limits, so it is what came before it that says which one this was.
    return /resolve|network|connect|getaddrinfo|nodename|urlopen error/i.test(text.slice(0, sandbox))
      ? known('This agent isn’t allowed on the web.')
      : known('Agents may only change files in their own folder.')
  }
  if (text.includes('The person declined this')) return known('You said no.')
  if (text.includes('the turn was cancelled')) return known('It was stopped when the run was stopped.')
  const stopped = /stopped after (\d+) seconds without finishing/.exec(text)
  if (stopped) return known(`It ran for ${stopped[1]} seconds without finishing, so it was stopped.`)

  // The web.
  const certificate = /CERTIFICATE_VERIFY_FAILED|certificate verify failed|unable to get local issuer certificate|SSL: /i.test(text)
  if (certificate) return known('It couldn’t check the website’s security certificate.')
  const http = httpError(text)
  if (http) return website(http.status, siteOf(http.url))
  if (/timed out|TimeoutError|ETIMEDOUT/i.test(text)) return known('It waited too long for an answer.')
  const host = /Could not resolve host:? (\S+)/.exec(text)?.[1]
  // Case matters: "ModuleNotFoundError" holds "eNotFound".
  if (host || /nodename nor servname|Name or service not known|Temporary failure in name resolution|getaddrinfo|\bENOTFOUND\b|Network is unreachable|No route to host/.test(text)) {
    return known(host ? `It couldn’t find ${host}. The address may be wrong, or ${thisComputer()} is offline.` : `It couldn’t reach the website. The address may be wrong, or ${thisComputer()} is offline.`)
  }
  if (/Connection refused|ECONNREFUSED/.test(text)) return known('Nothing answered at that address.')

  // What a program needed and didn't have.
  const pythonAddOn = /No module named '([\w.]+)'/.exec(text)?.[1]
  if (pythonAddOn) return known(`A Python add-on it needs, ${pythonAddOn.split('.')[0]}, isn’t installed.`)
  const jsAddOn = /Cannot find (?:module|package) '([^']+)'/.exec(text)?.[1]
  if (jsAddOn && !/^[./]/.test(jsAddOn)) return known(`A JavaScript add-on it needs, ${jsAddOn}, isn’t installed.`)
  const program = /command not found: (\S+)/.exec(text)?.[1] ?? /(?:^|\n)(?:\S+: )?(?:line \d+: )?([\w.+-]+): command not found/.exec(text)?.[1] ?? /env: ['‘]?([\w.+-]+)['’]?: No such file or directory/.exec(text)?.[1]
  if (program) return known(`${ThisComputer()} doesn’t have the program ${program}.`)
  if (/No space left on device|ENOSPC/.test(text)) return known(`${ThisComputer()} is out of disk space.`)

  // LoomWatch's own file tools, in their own words.
  if (/can't see pictures/.test(text)) return known('Its AI model can’t see pictures.')
  if (/as many pictures as one may|leave no room for one this large/.test(text)) return known('It already had as many pictures open as it can hold.')
  const missing = /^(.+?) doesn't exist\.$/m.exec(text)?.[1]
  if (missing) return known(`There’s no file called ${named(missing)}.`)
  const folder = /^(.+?) is a folder\b/m.exec(text)?.[1]
  if (folder) return known(`${named(folder)} is a folder, not a file.`)
  if (/is past the end/.test(text)) return known('It asked for more of the file than there is.')
  if (/is not a text file/.test(text)) return known('It can’t read that kind of file.')
  if (/old_text doesn't appear in/.test(text)) return known('The words it meant to change aren’t in the file any more.')
  if (/old_text appears \d+ times/.test(text)) return known('The words it meant to change are in the file more than once.')
  if (/isn't a valid regular expression/.test(text)) return known('Its search had a mistake in it.')
  const tool = /There's no tool called (\S+?)\.?$/m.exec(text)?.[1]
  if (tool) return known('It tried to use a tool it doesn’t have.')

  // Teammates.
  const finished = /(?:^|["\s])([^"\n]+?) has finished its part of this run and is no longer open/.exec(text)?.[1]
  if (finished) return known(`${finished} had already finished its part.`)
  if (/is not on this team/.test(text)) return known('There’s no teammate by that name.')
  if (/(?:That run has|run \S+ is) already finished/.test(text)) return known('The run had already finished.')

  // Files and permissions, as any program reports them.
  const absent = /No such file or directory: '([^']+)'/.exec(text)?.[1] ?? /(?:can't open file|cannot access|cannot open|open) '([^']+)'.*No such file/.exec(text)?.[1]
  if (absent) return known(`There’s no file called ${named(absent)}.`)
  if (/No such file or directory|ENOENT|FileNotFoundError/.test(text)) return known('A file or folder it needed isn’t there.')
  if (/EPERM|EACCES|Operation not permitted|Permission denied|PermissionError/.test(text)) return known(`${ThisComputer()} didn’t let it change files there.`)

  // The program itself.
  if (/SyntaxError|IndentationError|TabError|Unexpected token|ParseError/.test(text)) return known('The program it wrote had a mistake in it.')

  return { text: kind === 'command' ? 'Its program stopped with an error.' : 'It stopped with an error.', known: false }
}

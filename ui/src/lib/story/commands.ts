/**
 * Shell commands read as the programs they ran.
 *
 * Claude Code titles a Bash call with the whole command, and nearly every one starts by moving into
 * a folder: `cd /tmp/build && python3 build.py`. Named by the first path in it, that call was
 * "build" — and so was every other command run from the same folder, whatever it did. A command is
 * named instead by the program it was run for: the first one that is not moving between folders,
 * making them or looking at files, with its first few arguments — "python3 build.py".
 *
 * The same reading tells when a failed command was put right. An agent that fixes a script and runs
 * it again did not carry on without it. So a failed command counts as redone when every program it
 * was run for later ran again — same folder, same arguments, same input — in a command that
 * succeeded, at a place where its failure could not have been hidden: last, or followed by `&&`,
 * which makes the rest wait on it. Behind `;`, `|`, `||` or `&` a failure goes unseen, so a run
 * there proves nothing.
 *
 * A title that is not a shell command ("Terminal" before Claude Code names the call, a harness's
 * own "Read file …", an MCP tool id) is not read as one: `null`.
 *
 * On Windows, Codex runs each command through PowerShell (`"C:\…\powershell.exe" -Command "npm test"`),
 * and programs are named by paths like `C:\…\node.exe`. These read the same way: the PowerShell or
 * cmd script is unwrapped as bash's is, and a program is named without its `.exe`.
 */

import { baseName, isAbsolutePath, joinUnderRoot } from '../files/paths'

interface Run {
  /** The words the shell passes, quotes removed: the program first. */
  words: string[]
  /** What a heredoc or here-string fed it. */
  input: string
  /** What joins it to the next run: `&&`, `||`, `|`, `;`, `&`, or '' for the last. */
  next: string
  /** The folder an earlier `cd` in the same command moved to, or '' when none did. */
  cwd: string
}

/** Moving about and shell setup: never what a command was run for. */
const NAVIGATION = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'true', ':', 'sleep', 'wait', 'shopt', 'alias', 'trap', 'umask', 'ulimit'])
/** Making folders, moving files about and looking at them: what a command does on the way. */
const SETUP = new Set(['mkdir', 'ls', 'cat', 'echo', 'printf', 'head', 'tail', 'wc', 'pwd', 'which', 'type', 'rm', 'cp', 'mv', 'touch', 'chmod', 'ln', 'sort', 'uniq', 'cut', 'tr', 'tee', 'basename', 'dirname', 'realpath', 'readlink', 'file', 'stat', 'du', 'df', 'date', 'test', '[', 'clear'])
/** Words that open, continue or close a shell construct rather than name a program. */
const LEADING = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time'])
const CLOSING = new Set(['fi', 'done', 'esac', '}'])
/** Programs that run the program after them. */
const WRAPPERS = new Set(['sudo', 'nohup', 'exec', 'command', 'builtin', 'nice', 'caffeinate', 'env', 'timeout'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
/** Windows' shells: PowerShell's `-Command` and cmd's `/c` run the rest of the line as a script. */
const WINDOWS_SHELLS = new Set(['powershell', 'pwsh', 'cmd'])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PATH = /^(?:~|\.{1,2}|\$\{?\w+\}?)?\/|^[\w.@+-]+(?:\/[\w.@+-]+)+\/?$/
/** A path written the Windows way: `C:\…`, `C:/…`, `.\…`, `%USERPROFILE%\…`, `\\server\…` or `src\app.ts`. */
const WINDOWS_PATH = /^(?:[A-Za-z]:|\.{1,2}|%\w+%|\$env:\w+)?\\|^[A-Za-z]:\/|^[\w.@+-]+(?:\\[\w.@+-]+)+\\?$/
/** A command that starts with a program's full Windows path: `C:\…\node.exe build.js`. */
const DRIVE = /^[A-Za-z]:[\\/]/
const URL = /^[a-z][a-z0-9+.-]*:\/\//i

/** The index just past the `)` that closes the `(` at `open`, stepping over quoted text. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') i++
    else if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1)
      i = end === -1 ? text.length : end
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
  }
  return text.length
}

/**
 * The command's simple commands in order, as written: nothing is dropped or unwrapped yet. In a
 * `windows` script (PowerShell's or cmd's) `\` is part of a path, and PowerShell escapes with `` ` ``.
 */
function lex(text: string, windows = false): Run[] {
  const runs: Run[] = []
  let run: Run = { words: [], input: '', next: '', cwd: '' }
  let word: string | null = null
  // What the next word is: an argument, a redirection's target (dropped), a heredoc's delimiter,
  // or a here-string's text.
  let target: 'word' | 'redirect' | 'heredoc' | 'herestring' = 'word'
  let stripTabs = false
  let heredocs: { delimiter: string; strip: boolean; run: Run }[] = []

  const add = (part: string) => { word = (word ?? '') + part }
  const endWord = () => {
    if (word === null) return
    if (target === 'heredoc') heredocs.push({ delimiter: word, strip: stripTabs, run })
    else if (target === 'herestring') run.input += word
    else if (target === 'word') run.words.push(word)
    word = null
    target = 'word'
  }
  const endRun = (next: string) => {
    endWord()
    if (run.words.length > 0) {
      run.next = next
      runs.push(run)
      run = { words: [], input: '', next: '', cwd: '' }
    }
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\n') {
      endRun(';')
      i++
      // A heredoc's text starts on the line after the one that asked for it.
      for (const doc of heredocs) {
        let body = ''
        while (i < text.length) {
          const end = text.indexOf('\n', i)
          const line = text.slice(i, end === -1 ? text.length : end)
          i = end === -1 ? text.length : end + 1
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
          body += `${line}\n`
        }
        doc.run.input += body
      }
      heredocs = []
    } else if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++ }
    else if (c === (windows ? '`' : '\\')) { if (text[i + 1] !== '\n') add(text[i + 1] ?? ''); i += 2 }
    else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      add(text.slice(i + 1, end === -1 ? text.length : end))
      i = end === -1 ? text.length : end + 1
    } else if (c === '"') {
      let j = i + 1
      let part = ''
      while (j < text.length && text[j] !== '"') {
        if (!windows && text[j] === '\\' && '"\\$`\n'.includes(text[j + 1] ?? '')) { if (text[j + 1] !== '\n') part += text[j + 1]; j += 2 }
        else if (text.startsWith('$(', j)) { const end = closing(text, j + 1); part += text.slice(j, end); j = end }
        else part += text[j++]
      }
      add(part)
      i = j + 1
    } else if (c === '$' && text[i + 1] === '(') { const end = closing(text, i + 1); add(text.slice(i, end)); i = end }
    else if (c === '`') { const end = text.indexOf('`', i + 1); add(text.slice(i, end === -1 ? text.length : end + 1)); i = end === -1 ? text.length : end + 1 }
    else if (c === '#' && word === null) { const end = text.indexOf('\n', i); i = end === -1 ? text.length : end }
    else if (c === ';') { endRun(';'); i += text[i + 1] === ';' ? 2 : 1 }
    else if (c === '&') {
      if (text[i + 1] === '&') { endRun('&&'); i += 2 }
      else if (text[i + 1] === '>') { endWord(); target = 'redirect'; i += text[i + 2] === '>' ? 3 : 2 }
      else { endRun('&'); i++ }
    } else if (c === '|') {
      if (text[i + 1] === '|') { endRun('||'); i += 2 }
      else { endRun('|'); i += text[i + 1] === '&' ? 2 : 1 }
    } else if (c === '(' || c === ')') { endRun(';'); i++ }
    else if (c === '<' || c === '>') {
      // A file descriptor written against the arrow (`2>`) belongs to the redirection.
      if (word !== null && /^\d+$/.test(word)) word = null
      else endWord()
      if (c === '<' && text[i + 1] === '<') {
        if (text[i + 2] === '<') { target = 'herestring'; i += 3 }
        else { stripTabs = text[i + 2] === '-'; target = 'heredoc'; i += stripTabs ? 3 : 2 }
      } else {
        i++
        while (text[i] === '>' || text[i] === '&') i++
        target = 'redirect'
      }
    } else { add(c); i++ }
  }
  endRun('')
  // Whatever separator trails the text, the last run's exit is the command's.
  const last = runs.at(-1)
  if (last && last.next !== '&') last.next = ''
  return runs
}

/** A program by its name alone: `node` for `C:\…\node.exe`, `npm` for `npm.cmd`. */
const programName = (word: string) => baseName(word).replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
const programOf = (run: Run) => programName(run.words[0])

/**
 * The script a shell was handed, or `null`: bash's `-c` takes the word after it, PowerShell's
 * `-Command` (or `-c`) and cmd's `/c` the rest of the line.
 */
function shellScript(words: string[]): { text: string; windows: boolean } | null {
  const shell = programName(words[0]).toLowerCase()
  const windows = WINDOWS_SHELLS.has(shell)
  if (!windows && !SHELLS.has(shell)) return null
  const flag = !windows ? /^-[a-z]*c[a-z]*$/ : shell === 'cmd' ? /^\/c$/i : /^-c(?:ommand)?$/i
  const at = words.findIndex((part, index) => index > 0 && flag.test(part))
  if (at < 0 || words[at + 1] === undefined) return null
  return { text: windows ? words.slice(at + 1).join(' ') : words[at + 1], windows }
}

/**
 * The program a run is for: shell keywords, variable settings and wrappers (`sudo`, `env`,
 * `timeout 60`) taken off its front. A shell handed a script (`bash -lc "…"`, `powershell -Command
 * "…"`) is the runs of that script. Nothing, for a run that only opens or closes a construct (`for i in 1 2`, `done`).
 */
function unwrap(run: Run): Run[] {
  const words = [...run.words]
  while (words.length > 0 && LEADING.has(words[0])) words.shift()
  if (words.length === 0 || CLOSING.has(words[0]) || ['for', 'select', 'case', 'function'].includes(words[0])) return []
  for (;;) {
    while (words.length > 0 && ASSIGNMENT.test(words[0])) words.shift()
    if (words.length === 0 || !WRAPPERS.has(programName(words[0]))) break
    const wrapper = programName(words.shift() as string)
    while (words.length > 0 && words[0].startsWith('-')) words.shift()
    if (wrapper === 'timeout' && words.length > 0) words.shift()
  }
  if (words.length === 0) return []
  const script = shellScript(words)
  if (script) {
    const inner = lex(script.text, script.windows).flatMap(unwrap)
    if (inner.length > 0) inner[inner.length - 1].next = run.next
    return inner
  }
  return [{ ...run, words }]
}

/**
 * Each program a shell command ran, in order, or `null` when the text is not a shell command. A
 * command starts with a lower-case program, a variable setting (`FOO=1 npm test`) or a drive
 * (`C:\…\node.exe`); a harness's own title ("Terminal", "Read file …") starts with a capital, and
 * an MCP tool id with `mcp.` or `mcp__`.
 */
function commandRuns(text: string): Run[] | null {
  const start = text.trimStart()
  const drive = DRIVE.test(start)
  if (!start || (/^[A-Z]/.test(start) && !ASSIGNMENT.test(start) && !drive) || /^mcp[._]/i.test(start)) return null
  const runs = lex(start, drive).flatMap(unwrap)
  let cwd = ''
  for (const run of runs) {
    if (['cd', 'pushd'].includes(programOf(run))) {
      const to = run.words[1] ?? '~'
      cwd = isAbsolutePath(to) || to.startsWith('~') || !cwd ? to : joinUnderRoot(cwd, to)
    }
    run.cwd = cwd
  }
  return runs.length > 0 ? runs : null
}

/** One word as short as a sentence needs it, or `null` when it is too long to show at all. */
function shortWord(word: string): string | null {
  if (word.includes('\n')) return null
  if (URL.test(word)) return word.length > 48 ? null : word
  const short = PATH.test(word) || WINDOWS_PATH.test(word) ? baseName(word) : word
  const shown = /\s/.test(short) ? `"${short}"` : short
  return shown.length > 40 ? null : shown
}

/** A run as a person would name it: the program and the arguments that fit, then "…". */
function label(run: Run): string {
  let text = programOf(run)
  let cut = run.input !== ''
  for (const word of run.words.slice(1)) {
    const short = shortWord(word)
    if (short === null || text.length + 1 + short.length > 48) { cut = true; break }
    text += ` ${short}`
  }
  return cut ? `${text} …` : text
}

/** What the command was for, among its runs: the first that is not moving about or looking. */
function mainRuns(runs: Run[]): Run[] {
  const real = runs.filter((run) => !NAVIGATION.has(programOf(run)) && !SETUP.has(programOf(run)))
  if (real.length > 0) return real
  const moved = runs.filter((run) => !NAVIGATION.has(programOf(run)))
  return moved.length > 0 ? moved : runs
}

/** A shell command named by the program it was run for: "python3 build.py". `null` for a title that is not one. */
export function commandName(text: string): string | null {
  const runs = commandRuns(text)
  return runs ? label(mainRuns(runs)[0]) : null
}

const key = (run: Run) => JSON.stringify([run.cwd, run.words, run.input])

/**
 * Which later command ran a failed one again where it could not have failed unseen: an index into
 * `later`, the titles of the same agent's commands that succeeded after it, or `null`. When the
 * failed command ran several programs, it is the command that ran the last of them again.
 */
export function commandRedone(failed: string, later: readonly string[]): number | null {
  const runs = commandRuns(failed)
  if (!runs) return null
  const needed = new Set(mainRuns(runs).map(key))
  for (const [index, text] of later.entries()) {
    for (const run of commandRuns(text) ?? []) if (run.next === '&&' || run.next === '') needed.delete(key(run))
    if (needed.size === 0) return index
  }
  return null
}

/**
 * The command a call ran. LoomWatch's own engine titles a command "Run: " and its first line, cut
 * at 120 characters, so a heredoc's script and every line after the first are only in the call's
 * input: the command is read from there when it has one. A permission request carries the call it
 * asks about under `toolCall`.
 */
export function commandOf(item: { name: string; rawInput?: unknown }): string {
  const fields = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})
  const input = fields(item.rawInput)
  const command = input.command ?? fields(fields(input.toolCall).rawInput).command
  if (typeof command === 'string' && command.trim()) return command
  return item.name.replace(/^Run:\s*/, '')
}

/** What a command did, as a sentence needs it: "fetch" "2 web pages", with the sites it reached. */
export interface CommandPlan {
  /** The verb as "couldn’t …", "… -ed" and "is …ing" need it. */
  verb: readonly [base: string, past: string, ing: string]
  /** What it was done to: "2 web pages", "build.py", "a short Python program", "“git push”". */
  object: string
  /** What it reached for, when the sentence doesn't name it: the sites it fetched, the add-ons it installed. */
  targets: { label: 'Sites' | 'Add-ons'; items: string[] } | null
}

const RUN = ['run', 'ran', 'running'] as const
/** Programs that fetch a page, and the code that does it from inside a script. */
const FETCHERS = new Set(['curl', 'wget', 'http', 'https', 'xh'])
const FETCH_CODE = /urlopen|urlretrieve|requests\.(?:get|post|head)\(|httpx\.|\bfetch\(|aiohttp|https?\.get\(|Invoke-WebRequest|Invoke-RestMethod/
const URLS = /https?:\/\/[^\s'"`)<>\]}]+/g
/** Package managers, by the words that install with them. */
const INSTALLERS: Record<string, string[]> = { pip: ['install'], pip3: ['install'], npm: ['install', 'i', 'add', 'ci'], pnpm: ['add', 'install', 'i'], yarn: ['add'], bun: ['add', 'install', 'i'], brew: ['install'], gem: ['install'], cargo: ['install'], uv: ['add'], apt: ['install'], 'apt-get': ['install'] }
/** Programs that run a script, by the language people would name. */
const LANGUAGES: Record<string, string> = { python: 'Python', python3: 'Python', node: 'JavaScript', deno: 'JavaScript', bash: 'shell', sh: 'shell', zsh: 'shell', ruby: 'Ruby', perl: 'Perl', php: 'PHP', Rscript: 'R', osascript: 'AppleScript', swift: 'Swift' }

// `globalThis`: this module's own `URL` is the pattern above.
const siteOf = (url: string) => { try { return new globalThis.URL(url).hostname.replace(/^www\./, '') } catch { return null } }

/** The add-ons an install names: its words that are not flags, files or folders, without their versions. */
function packagesOf(words: string[]): string[] {
  return [...new Set(words
    .filter((word) => !/^[-./~]/.test(word) && !/\.(?:txt|toml|cfg|json|lock|ya?ml)$/.test(word))
    .map((word) => word.replace(/(?<=.)[@=<>~^!].*$/, ''))
    .filter((word) => /^@?[\w.-]+(?:\/[\w.-]+)?$/.test(word)))]
}

/**
 * A shell command read as what it did, for someone who reads no shell: it fetched web pages,
 * installed add-ons, ran a script or a short program. Anything else is named as `commandName`
 * names it.
 */
export function commandPlan(text: string): CommandPlan {
  const runs = commandRuns(text) ?? []
  // A page is fetched by a program that fetches, or by a script's own code: urllib, requests, fetch.
  const urls = [...new Set((text.match(URLS) ?? []).map((url) => url.replace(/[.,;:]+$/, '')))]
  if (urls.length > 0 && (runs.some((run) => FETCHERS.has(programOf(run))) || FETCH_CODE.test(text))) {
    const sites = [...new Set(urls.map(siteOf).filter((name): name is string => name !== null))]
    return { verb: ['fetch', 'fetched', 'fetching'], object: urls.length === 1 ? 'a web page' : `${urls.length} web pages`, targets: sites.length > 0 ? { label: 'Sites', items: sites } : null }
  }
  const run = runs.length > 0 ? mainRuns(runs)[0] : null
  if (run) {
    const program = programOf(run)
    let words = run.words.slice(1)
    // `python3 -m pip install x` and `uv pip install x` install as pip does.
    if (LANGUAGES[program] === 'Python' && words[0] === '-m' && /^pip3?$/.test(words[1] ?? '')) words = words.slice(2)
    else if (program === 'uv' && words[0] === 'pip') words = words.slice(1)
    const pip = LANGUAGES[program] === 'Python' || program === 'uv'
    if ((INSTALLERS[program] ?? []).includes(words[0] ?? '') || (pip && words[0] === 'install')) {
      const packages = packagesOf(words.slice(1))
      return { verb: ['install', 'installed', 'installing'], object: packages.length === 1 ? 'an add-on' : 'add-ons', targets: packages.length > 0 ? { label: 'Add-ons', items: packages } : null }
    }
    const language = LANGUAGES[program]
    const short = { verb: RUN, object: `a short ${language} program`, targets: null }
    if (language && words.some((word) => ['-c', '-e', '-'].includes(word))) return short
    const script = language ? words.find((word) => !word.startsWith('-')) : undefined
    if (script && (PATH.test(script) || /\.\w{1,5}$/.test(script))) return { verb: RUN, object: baseName(script), targets: null }
    if (language && run.input) return short
    if (PATH.test(run.words[0]) && /\.\w{1,5}$/.test(run.words[0])) return { verb: RUN, object: baseName(run.words[0]), targets: null }
  }
  const named = commandName(text)
  return { verb: RUN, object: named ? `“${named}”` : 'a command', targets: null }
}

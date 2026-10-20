import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { whyItFailed } from './why'

/** Outputs as recorded runs have them (home folder renamed). */
const RECORDED = {
  urllib403: `The command failed with exit code 1.
Traceback (most recent call last):
  File "<stdin>", line 12, in <module>
  File "/Users/you/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none/lib/python3.11/urllib/request.py", line 216, in urlopen
    return opener.open(url, data, timeout)
  File "/Users/you/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none/lib/python3.11/urllib/request.py", line 643, in http_error_default
    raise HTTPError(req.full_url, code, msg, hdrs, fp)
urllib.error.HTTPError: HTTP Error 403: Forbidden
`,
  npmEperm: `The command failed with exit code 1.
npm error code EPERM
npm error syscall open
npm error path /Users/you/.npm/_cacache/tmp/***
npm error errno EPERM
npm error
npm error Your cache folder contains root-owned files, due to a bug in previous versions of npm which has since been addressed.
npm error
npm error To permanently fix this problem, please run:
npm error   sudo chown -R 501:20 "/Users/you/.npm"
npm error Log files were not written due to an error writing to the directory: /Users/you/.npm/_logs
npm error You can rerun the command with \`--loglevel=verbose\` to see the logs in your terminal
`,
  missing: "facts.md doesn't exist.",
  pastTheEnd: 'Transformer Recommendation Guide.html has 81 lines; offset 105 is past the end.',
  finishedTeammate: '{"error": "Researcher has finished its part of this run and is no longer open, so it can\'t be asked. Its work reached you in your prompt, under \\"Results from preceding stages\\": work from that, and say plainly what it does not cover.", "refused": "finished"}',
  declined: 'The person declined this. Carry on without it, or say what you need and why.',
}

// What a failure says names the computer it ran on (lib/platform.ts), and jsdom's browser reports
// the platform the tests run on: these are read on a Mac unless a test says otherwise.
beforeEach(() => { vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('whyItFailed, on outputs recorded runs left', () => {
  it('says a website refused, with the status beside it', () => {
    expect(whyItFailed(RECORDED.urllib403, 'command')).toEqual({ text: 'The website said no.', code: '403', known: true })
  })

  it('finds npm’s reason above its last line, which only says how to see more', () => {
    expect(whyItFailed(RECORDED.npmEperm, 'command')).toEqual({ text: 'This Mac didn’t let it change files there.', known: true })
  })

  it('names the file that isn’t there', () => {
    expect(whyItFailed(RECORDED.missing, 'file').text).toBe('There’s no file called facts.md.')
  })

  it('says a read asked for more of the file than there is', () => {
    expect(whyItFailed(RECORDED.pastTheEnd, 'file').text).toBe('It asked for more of the file than there is.')
  })

  it('names the teammate who had already finished', () => {
    expect(whyItFailed(RECORDED.finishedTeammate, 'delegation').text).toBe('Researcher had already finished its part.')
  })

  it('says you said no', () => {
    expect(whyItFailed(RECORDED.declined, 'command').text).toBe('You said no.')
  })
})

describe('whyItFailed, on the computer it ran on', () => {
  // LoomWatch runs on Windows too: there the computer is "this PC", as everywhere else the app says.
  it('says this PC on Windows, never this Mac', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(whyItFailed('curl: (6) Could not resolve host: exmaple.com', 'command').text).toBe('It couldn’t find exmaple.com. The address may be wrong, or this PC is offline.')
    expect(whyItFailed('zsh:1: command not found: pdftotext', 'command').text).toBe('This PC doesn’t have the program pdftotext.')
    expect(whyItFailed('OSError: [Errno 28] No space left on device', 'command').text).toBe('This PC is out of disk space.')
    expect(whyItFailed('PermissionError: [Errno 13] Permission denied', 'command').text).toBe('This PC didn’t let it change files there.')
  })
})

describe('whyItFailed, for the other reasons a call fails', () => {
  it.each([
    ['requests.exceptions.HTTPError: 404 Client Error: Not Found for url: https://docs.example.com/missing', 'That page isn’t on docs.example.com.', '404'],
    ['curl: (22) The requested URL returned error: 429', 'The website asked it to slow down.', '429'],
    ['urllib.error.HTTPError: HTTP Error 503: Service Unavailable', 'The website had a problem on its side.', '503'],
    ['urllib.error.HTTPError: HTTP Error 401: Unauthorized', 'The website wants a sign-in first.', '401'],
  ])('reads a website’s answer: %s', (output, text, code) => {
    expect(whyItFailed(output, 'command')).toEqual({ text, code, known: true })
  })

  it.each([
    ['curl: (6) Could not resolve host: exmaple.com', 'It couldn’t find exmaple.com. The address may be wrong, or this Mac is offline.'],
    ['urllib.error.URLError: <urlopen error [Errno 8] nodename nor servname provided, or not known>', 'It couldn’t reach the website. The address may be wrong, or this Mac is offline.'],
    ['ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed', 'It couldn’t check the website’s security certificate.'],
    ['TimeoutError: The read operation timed out', 'It waited too long for an answer.'],
    ['The command was stopped after 120 seconds without finishing.', 'It ran for 120 seconds without finishing, so it was stopped.'],
    ["ModuleNotFoundError: No module named 'PIL'", 'A Python add-on it needs, PIL, isn’t installed.'],
    ["ModuleNotFoundError: No module named 'google.protobuf'", 'A Python add-on it needs, google, isn’t installed.'],
    ["Error: Cannot find module 'jsdom'", 'A JavaScript add-on it needs, jsdom, isn’t installed.'],
    ['zsh:1: command not found: pdftotext', 'This Mac doesn’t have the program pdftotext.'],
    ['bash: line 1: rg: command not found', 'This Mac doesn’t have the program rg.'],
    ["python3: can't open file '/tmp/build/build.py': [Errno 2] No such file or directory", 'There’s no file called build.py.'],
    ['OSError: [Errno 28] No space left on device', 'This Mac is out of disk space.'],
    ['  File "build.py", line 4\n    print(f"{a\\n}")\nSyntaxError: f-string expression part cannot include a backslash', 'The program it wrote had a mistake in it.'],
    ['research is a folder; use list_files.', 'research is a folder, not a file.'],
  ])('reads %s', (output, text) => {
    expect(whyItFailed(output, 'command')).toMatchObject({ text, known: true })
  })

  it('names LoomWatch’s own limits as the reason, over what the program made of them', () => {
    const files = 'cp: /etc/hosts: Operation not permitted\n(The sandbox blocked this: commands may change files only in the work folder, and reach the network only when this agent may use the web.)'
    const web = 'curl: (6) Could not resolve host: example.com\n(The sandbox blocked this: commands may change files only in the work folder, and reach the network only when this agent may use the web.)'
    expect(whyItFailed(files, 'command').text).toBe('Agents may only change files in their own folder.')
    expect(whyItFailed(web, 'command').text).toBe('This agent isn’t allowed on the web.')
  })

  it('says when nothing in the output tells why, rather than guessing', () => {
    expect(whyItFailed('The command failed with exit code 2.\nKeyError: \'rows\'', 'command')).toEqual({ text: 'Its program stopped with an error.', known: false })
    expect(whyItFailed('', 'tool')).toEqual({ text: 'It stopped with an error.', known: false })
  })
})

import { describe, expect, it } from 'vitest'

import { commandName, commandRedone } from './commands'

// Shaped like the Editor's commands in a recorded run (6ca4befe), with the scripts cut short. Every
// one starts in /tmp/build, which is what the receipt used to call them all.
const WRITE_AND_BUILD = [
  "mkdir -p /tmp/build && cat > /tmp/build/build.py <<'E'",
  'import re, json',
  "def H1(t,brk=False): return f'<w:p>{\"<w:pageBreakBefore w:val=\\\"1\\\"/>\" if brk else \"\"}</w:p>'",
  "print('a && b; c | d')",
  'E',
  'cd /tmp/build && ls /tmp/ref/u /tmp/ref/u/_rels -a | head; python3 build.py && ls -la out.docx',
].join('\n')
const MONTAGE = ['cd /tmp/build && python3 -c "', 'from PIL import Image', "m.save('montage.jpg')", 'print(m.size)"'].join('\n')
const PATCH_AND_REBUILD = [
  "cd /tmp/build && python3 - <<'E'",
  "s=open('build.py').read()",
  "open('build.py','w').write(s.replace('x','y'))",
  'E',
  'python3 build.py && ls -la out.docx && python3 $S/soffice.py --headless --convert-to pdf out.docx >/dev/null 2>&1; ls; pdfinfo out.pdf | grep Pages',
].join('\n')

describe('commandName', () => {
  it('names a command by the program it ran, not the folder it ran in', () => {
    expect(commandName(WRITE_AND_BUILD)).toBe('python3 build.py')
    expect(commandName(MONTAGE)).toBe('python3 -c …')
    expect(commandName(PATCH_AND_REBUILD)).toBe('python3 - …')
    expect(commandName('cd /tmp/build && rm pg-*; pdftoppm -jpeg -r 70 -f 1 -l 4 out.pdf a; ls')).toBe('pdftoppm -jpeg -r 70 -f 1 -l 4 out.pdf a')
  })

  it('falls back to what it looked at when that is all it did', () => {
    expect(commandName("cat '/Users/me/teams/daily-news/notes.md'")).toBe('cat notes.md')
    expect(commandName('cd /repo && ls -la && cat README.md')).toBe('ls -la')
    expect(commandName('pwd')).toBe('pwd')
  })

  it('keeps an address whole and cuts what does not fit', () => {
    expect(commandName('curl -sS https://github.blog/changelog/feed/')).toBe('curl -sS https://github.blog/changelog/feed/')
    expect(commandName('grep -n -i "second opinion\\|Code with a second\\|Research and review" -r README.md docs')).toBe('grep -n -i …')
  })

  it('looks through settings, wrappers, loops and a shell handed a script', () => {
    expect(commandName('FOO=1 timeout 60 npm test 2>&1 | tail -20')).toBe('npm test')
    expect(commandName('bash -lc "cd /repo && cargo test -p loomwatch-backend"')).toBe('cargo test -p loomwatch-backend')
    expect(commandName('cd /tmp/build && for i in 1 2; do python3 build.py; done')).toBe('python3 build.py')
  })

  it('does not read a heredoc’s text as commands', () => {
    expect(commandName("cat > x.sh <<'EOF'\nrm -rf /tmp/x && curl https://example.com\nEOF\nbash x.sh")).toBe('bash x.sh')
  })

  it('leaves titles that are not shell commands alone', () => {
    expect(commandName('Terminal')).toBeNull()
    expect(commandName("Read file '/Users/me/.agents/skills/explain/SKILL.md'")).toBeNull()
    expect(commandName('mcp.loomwatch-team-bus.ask')).toBeNull()
  })
})

describe('commandRedone', () => {
  it('counts the script fixed and run again', () => {
    expect(commandRedone(WRITE_AND_BUILD, [PATCH_AND_REBUILD])).not.toBeNull()
    expect(commandRedone(WRITE_AND_BUILD, ['cd /tmp/build && python3 build.py'])).not.toBeNull()
  })

  it('does not count a run whose failure the command would have hidden', () => {
    expect(commandRedone(WRITE_AND_BUILD, ['cd /tmp/build && python3 build.py; echo done'])).toBeNull()
    expect(commandRedone(WRITE_AND_BUILD, ['cd /tmp/build && python3 build.py 2>&1 | tail -20'])).toBeNull()
    expect(commandRedone(WRITE_AND_BUILD, ['cd /tmp/build && python3 build.py || true'])).toBeNull()
    expect(commandRedone(WRITE_AND_BUILD, ['cd /tmp/build && python3 build.py &'])).toBeNull()
  })

  it('needs the same folder, the same arguments and the same input', () => {
    expect(commandRedone(WRITE_AND_BUILD, ['cd /tmp/other && python3 build.py'])).toBeNull()
    expect(commandRedone(WRITE_AND_BUILD, ['cd /tmp/build && python3 build.py --fast'])).toBeNull()
    expect(commandRedone(MONTAGE, ['cd /tmp/build && python3 -c "print(1)"'])).toBeNull()
    expect(commandRedone("python3 - <<'E'\nprint(1)\nE", ["python3 - <<'E'\nprint(2)\nE"])).toBeNull()
    expect(commandRedone("python3 - <<'E'\nprint(1)\nE", ["python3 - <<'E'\nprint(1)\nE"])).not.toBeNull()
  })

  it('needs every program the command was for', () => {
    expect(commandRedone('cd /repo && npm install && npm test', ['cd /repo && npm install'])).toBeNull()
    expect(commandRedone('cd /repo && npm install && npm test', ['cd /repo && npm install && npm test'])).toBe(0)
    // Spread over two commands, it was put right by the one that ran the last of them.
    expect(commandRedone('cd /repo && npm install && npm test', ['cd /repo && npm install', 'cd /repo && ls', 'cd /repo && npm test'])).toBe(2)
  })

  it('never counts a title that is not a command', () => {
    expect(commandRedone('Terminal', ['Terminal'])).toBeNull()
  })
})

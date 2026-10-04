# Security

## Report a vulnerability

Please report security problems privately, not in a public issue or discussion: use
[Report a vulnerability](https://github.com/tnghia903/loomwatch/security/advisories/new) on
GitHub. Say what an attacker can do, the steps to reproduce it, and the LoomWatch version
(`~/LoomWatch/app/VERSION`, or the commit of your copy of the source).

LoomWatch is a small open-source project. You will get a first answer within a week, usually
sooner. A fix for a confirmed problem ships as a new release, and the advisory credits you unless
you'd rather it didn't.

Only the newest release, and `main`, get security fixes.

## What LoomWatch protects, and what it doesn't

LoomWatch starts AI apps on your computer and lets them work. It is not a sandbox: an agent runs
as you, with your files and your sign-ins, inside the AI app you chose. Here is what LoomWatch
does about that, so you can judge it for yourself.

**It does:**

- **Stay on your computer.** The app and its API answer only on `127.0.0.1`. Requests from other
  websites, and from pages that rebind their address to `127.0.0.1`, are refused. The database is
  published on `127.0.0.1` only.
- **Check a team before it first runs.** A team file you didn't build in LoomWatch shows
  what it runs before its first run. That covers a file you downloaded, unzipped or edited by hand.
  You see each program, the folders it reads and what it may do without asking, then choose
  **Trust and run**. Its schedule waits until then.
- **Refuse settings that disguise an app.** A team file cannot set variables that change which
  code an app loads or where it sends your traffic, such as `NODE_OPTIONS`, `DYLD_*`, proxies or
  API base addresses.
- **Keep its own secrets from agents.** Agents don't inherit LoomWatch's database address or its
  settings, and they can't read the keys of the apps connected to LoomWatch without asking you.
- **Ask before agents act.** LoomWatch puts each app in its ask-first mode and answers requests
  by the switches you set for each agent. Web, edits in the agent's own folder, and commands are
  all off by default. Anything else waits for you.
- **Start agents without tools that reach past the run.** For example, Claude Code's publishing
  and messaging tools, and Codex's plugins and apps. The run receipt flags any that ran anyway.
- **Send nothing about you anywhere.** LoomWatch has no account and no telemetry. It contacts
  only Notion, when you connect it, and the npm registry, the first time an app's connector has to
  be downloaded.

**It doesn't:**

- Stop an approved team from running the commands it names. Read the review, and only trust teams
  from people you trust.
- Hold back OpenCode, which acts without asking. The allow switches can't stop it.
- Switch off MCP servers in Codex's own settings (`~/.codex/config.toml`); they still load.
- Keep your prompts and files on your computer. Each AI app sends them to its model provider, as
  it does when you use it yourself.
- Protect you from an app or model that is itself compromised, or from a prompt that talks an
  agent into misusing a permission you gave it. Keep **Run commands** off unless a job needs it.

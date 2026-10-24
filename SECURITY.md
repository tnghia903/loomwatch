# Security

## Report a vulnerability

Please report security problems privately, not in a public issue or discussion: use
[Report a vulnerability](https://github.com/tnghia903/loomwatch/security/advisories/new) on
GitHub. Say what an attacker can do, the steps to reproduce it, and the LoomWatch version
(**Check for updates…** in ⌘K shows it, or the commit of your copy of the source).

LoomWatch is a small open-source project. You will get a first answer within a week, usually
sooner. A fix for a confirmed problem ships as a new release, and the advisory credits you unless
you'd rather it didn't.

Only the newest release, and `main`, get security fixes.

## What LoomWatch protects, and what it doesn't

LoomWatch runs AI agents on your computer and lets them work. Each agent runs inside LoomWatch
itself and thinks with the model you chose: on your ChatGPT plan, on your Claude API credit, or
through OpenRouter with your OpenRouter key. It is not a full sandbox: what you let an agent do, it
does as you, with your files. Here is what LoomWatch does about that, so you can judge it for
yourself.

**It does:**

- **Stay on your computer.** The app and its API answer only on `127.0.0.1`. Requests from other
  websites, and from pages that rebind their address to `127.0.0.1`, are refused. In Docker, its
  port is published on `127.0.0.1` only.
- **Keep your keys and your ChatGPT sign-in to itself.** You paste an OpenRouter or Claude API key
  into LoomWatch, which checks it with its company before keeping it. LoomWatch takes only a Claude
  API key: it refuses a Claude sign-in token (`sk-ant-oat…`) and an Admin key. On a Mac the
  OpenRouter key is kept in the Keychain as `LoomWatch.OpenRouter`, and the Claude key and the
  ChatGPT sign-in together as `LoomWatch.Plans`. On Windows they are kept in Windows Credential
  Manager, as `api-key.LoomWatch.OpenRouter` and `plans.LoomWatch.Plans`, which only your Windows
  account can read (as with every credential there, so can any program you run). On Linux they are
  kept in `keys.json` and `plans.json` in LoomWatch's state folder, readable by your account only.
  Your Notion connection is kept the same way, as `LoomWatch.Notion`, except that Linux keeps none.
  Each key is sent to its own company and nowhere else: never to agents or the commands they run,
  and never into team files, the run history or logs. Anything shaped like a key or a sign-in token
  is cut out of an error message before it is shown or kept. Only what you enter or sign in to in
  LoomWatch is used: an `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the
  environment is ignored, and LoomWatch never reads another app's credentials or sign-in. Other
  websites can't set or change a key.
- **Sign in with ChatGPT the way OpenAI asks.** **Continue with ChatGPT** opens ChatGPT's own page,
  so LoomWatch never sees your password. It uses PKCE, and it takes the answer only on
  `127.0.0.1`, only for a sign-in it started in the last 10 minutes, and only with that sign-in's
  random `state`. It checks that the ID token was issued by OpenAI, for LoomWatch, for this sign-in
  and not expired. It keeps only the refresh token; each hour's access token stays in memory.
  **Sign out** asks OpenAI to revoke the sign-in, then forgets it; if OpenAI couldn't be reached,
  LoomWatch says so, and you can remove it in ChatGPT's settings. An agent on your ChatGPT plan
  never moves to another way of paying by itself, even at the plan's limit.
- **Check a team before it first runs.** A team file you didn't build in LoomWatch shows what it
  does before its first run. That covers a file you downloaded, unzipped or edited by hand. You see
  each agent and the model it runs on ("Writer runs on LoomWatch with anthropic/claude-opus-5.5"),
  the folders it works in and reads, the Notion pages it reads and what it may do without asking,
  then choose **Trust and run**. Its schedule waits until then.
- **Never start a program a team file names.** Team files made for earlier versions of LoomWatch
  named an AI app to start for each agent. LoomWatch reads only the agent's folder from them; the
  program, its arguments and its settings are never used.
- **Keep its own files from agents.** An agent can't read LoomWatch's state folder (the database,
  the approvals) without asking you, wherever its folders reach; only LoomWatch's skills folder is
  open to it. The key file is refused outright, without asking, so no answer can hand the key to a
  model. An agent that starts in your teams folder always works in a folder of its own, so its edits
  and commands stay out of your team files. File edits you switch on cover only the agent's own folder, and never
  its `.git`, its `.agents` and `.claude` skill folders or LoomWatch's `.loomwatch` folder; any other
  edit asks you.
- **Run commands without your keys.** A command an agent runs gets your environment with every
  `*_API_KEY`, `*_API_TOKEN` and `*_AUTH_TOKEN` variable taken out, along with everything starting
  `OPENROUTER_`, `ANTHROPIC_`, `OPENAI_`, `GEMINI_` or `GOOGLE_API`, and LoomWatch's own settings
  and database address.
- **Fence commands in on a Mac.** On a Mac every command an agent runs goes through macOS's sandbox
  (Seatbelt, `/usr/bin/sandbox-exec`). It can change files only in the agent's work folder and in
  temporary and cache folders, and it can reach the network only when the agent may use the web.
  Every command is approved before it runs, so the sandbox is the second line of defence, not the
  first.
- **Stop commands whole.** A command stops at its time limit (two minutes unless the agent asks
  for more, ten at most) or when its turn is stopped, and everything it started stops with it. On
  Windows, where commands run in `cmd.exe`, each one runs in a Windows job of its own, so nothing it
  started keeps running after it finishes either.
- **Ask before agents act.** LoomWatch answers each agent's requests by the switches you set for
  it. Reading inside its own folder and what you gave it needs no switch; web, file edits in its
  own folder, and commands are all off by default. Anything else waits for you: **Allow**, **Allow
  for this run**, **Allow for the whole team**, **Always allow** or **Deny**. **Edit, then allow**
  changes a command before it runs, this once. **Answer instead** sends your words back to the
  agent as the tool's answer, and nothing runs. A request nobody answers within 10 minutes is
  declined, and a scheduled run, with nobody to ask, declines at once. In Auto mode, commands that
  only read files, or download pages for an agent allowed the web, run without asking; everything
  else still asks.
- **Give agents no tools that reach past the run.** An agent's tools are its files, the web,
  commands, its plan and the Team Bus to its teammates. None of them publishes, posts or sends a
  message anywhere. Tools set up in another AI app's settings (MCP servers) are not given to
  agents; an agent wired to one is told it is unavailable.
- **Show a skill before it is installed.** The Skills page installs skills from skills.sh, ClawHub
  or a GitHub link. It shows each skill's license, scripts and files first, and refuses a skill
  whose license says "All rights reserved" or "proprietary". It caps a download at 50 MB and a
  skill at 200 MB and 2,000 files, leaves out links, and refuses a download with a path outside its
  own folder. Nothing in a skill runs when it is installed: an agent can run a skill's script only
  as a command, which asks like any other. **Look on this computer** copies skills from your AI
  apps' skill folders only when you click it, and reads nothing there but skill folders.
- **Collect nothing about you.** LoomWatch has no account and no telemetry. It contacts only:
  - OpenAI, once you sign in with ChatGPT: `auth.openai.com` for the sign-in, and
    `api.openai.com` for your plan's models and the model calls of agents on your plan;
  - Anthropic, once you add a Claude API key: `api.anthropic.com` to check the key, list its
    models, and make the model calls of agents on your Claude credit;
  - OpenRouter, for the model calls of agents and Ask paid through it, to check your key, and for
    its public list of models, which also gives the list prices used for Claude amounts. Once you turn on **Let AI choose** under an agent's suggestion in its
    model list (it is off until you do), OpenRouter is also asked to read any agent whose job its
    name and instructions don't make plain, when you open its model list or, for an agent whose
    model follows its suggestion, when you change it.
    What is sent is that agent's name, instructions and Done when, and the names of its skills,
    tools and what it reads. Its instructions go as written, so anything they mention goes too.
    The reading model is TypeSafe's Jev;
  - Notion, when you connect it;
  - GitHub, each time you open LoomWatch, to see whether a new version is out (you can turn this
    off);
  - GitHub, skills.sh and ClawHub, when you search for or install a skill.

**It doesn't:**

- Stop an approved team from doing what you allowed. Read the review, and only trust teams from
  people you trust.
- Keep your prompts and files on your computer. Everything an agent works with goes to the
  company whose model it uses (OpenAI on your ChatGPT plan, Anthropic on your Claude credit), or to
  OpenRouter and on to that company: its instructions, your prompt, the team's Brief and notes, the
  Notion pages you give it, what its teammates hand it, and what its tools return, such as the
  files it reads and the output of its commands.
- Ask before each web search. An agent allowed the web searches and reads pages through the company
  that runs its model (OpenAI, Anthropic or OpenRouter), which runs them for it; each one shows in
  the run afterwards.
- Limit what an allowed command reads. The sandbox limits where a command writes and whether it
  reaches the network, not which of your files it reads.
- Sandbox commands on Windows. A command an agent runs there can read and change every file your
  Windows account can, and reach the internet even when the agent may not use the web. Approving
  each command is the only line, and in Auto mode LoomWatch's own reading of the command line is
  all that lets a read-only command through. On Windows, keep **Run commands** off for any agent
  whose job doesn't need it, and read each command before you allow it.
- Sandbox commands on Linux yet. There too, approving each command is the only line.
- Protect you from a model that is itself compromised, or from a prompt that talks an agent into
  misusing a permission you gave it. Keep **Run commands** off unless a job needs it.

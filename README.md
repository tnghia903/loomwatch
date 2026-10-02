<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/banner-dark.png">
    <img src="docs/assets/readme/banner-light.png" width="880" alt="LoomWatch. Put AI agents to work as a team. Build a team from the AI apps already on your computer, ask in plain words, and review every step before you use the result.">
  </picture>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#how-a-run-works"><strong>How it works</strong></a> &middot;
  <a href="#features"><strong>Features</strong></a> &middot;
  <a href="#try-your-first-run"><strong>First run</strong></a> &middot;
  <a href="#faq"><strong>FAQ</strong></a> &middot;
  <a href="#more-guides"><strong>Guides</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runs%20on-your%20computer-AD8A20" alt="Runs on your computer">
  <img src="https://img.shields.io/badge/first%20run-offline%20demo%2C%20no%20API%20key-17724A" alt="First run: offline demo, no API key">
  <img src="https://img.shields.io/badge/agents%20over-ACP-56524A" alt="Agents over ACP">
  <img src="https://img.shields.io/badge/built%20with-Rust%20%2B%20React-56524A" alt="Built with Rust and React">
</p>

<p align="center">
  <img src="docs/assets/readme/demo.gif" width="880" alt="The offline demo in LoomWatch: a three-step team is built, the request is typed, the team pauses for the operator's review, the operator approves, and the team response appears with a run receipt.">
  <br>
  <sub>The bundled offline demo: build a team, ask in plain words, approve at the review step, read the result.</sub>
</p>

<br>

## Your AI apps are the threads. LoomWatch is the loom.

LoomWatch runs on your computer and opens in your browser. Arrange agents on a canvas, connect them
into a workflow, and watch their progress, tool calls, handovers and final answer in one place. Run a
single agent, a step-by-step pipeline, or a team that delegates work as it goes. When the team needs
you, it stops and asks.

| | Step | What you do |
| :-: | --- | --- |
| **01** | **Build** | Pick agents from the AI apps on this computer and connect them on a canvas. |
| **02** | **Ask** | Describe the job in plain words: _"Prepare today's AI and tech news digest, and link every claim."_ |
| **03** | **Review** | Watch each step happen, approve or send work back, and check the evidence before you use the result. |

<p align="center">
  <sub>WORKS WITH THE AI APPS YOU ALREADY USE</sub><br>
  <strong>Claude Code</strong> &nbsp;·&nbsp; <strong>Codex</strong> &nbsp;·&nbsp; <strong>Gemini CLI</strong> &nbsp;·&nbsp;
  <strong>OpenCode</strong> &nbsp;·&nbsp; <strong>Hermes</strong> &nbsp;·&nbsp; <strong>OpenClaw</strong><br>
  <sub>and, through OpenCode, models such as DeepSeek, Kimi, GLM, Qwen and Mistral</sub>
</p>

## LoomWatch is right for you if

- ✅ You use one or more AI apps, such as Claude Code, Codex, Gemini CLI or OpenCode, and want them
  to **work on one job together**.
- ✅ You want to **see what each agent did**, not just read a final answer: every tool call, file and
  handover is recorded.
- ✅ You want to **approve or redirect work** before the next agent builds on it.
- ✅ You want it **on your own computer**, with the skills, MCP tools and sign-ins you already have.
- ✅ You run the same kind of job again and again, such as a daily digest or a research brief, and
  want it **repeatable, or scheduled**.

## How a run works

```mermaid
flowchart LR
    ask(["You ask, in plain words"]) --> researcher["Researcher<br/>on Claude Code"]
    researcher -- "hands over" --> review{{"You review"}}
    review -- "approve" --> writer["Writer<br/>on Codex"]
    review -. "send back" .-> researcher
    writer --> response[["Team response<br/>with its evidence"]]
    classDef stop stroke:#AD8A20,stroke-width:2px
    class review stop
```

Each agent is its own AI app, started by LoomWatch on your computer and driven over
[ACP](https://agentclientprotocol.com) (the Agent Client Protocol). Agents can hand work to each
other, or ask each other questions, through LoomWatch's Team Bus. Every message, tool call and
handover is recorded in a local database, so you can watch a run live, replay it later, and follow
up from any step.

## Features

<table>
<tr>
<td width="33%" valign="top">

### 🧵 One team, many apps

Each agent runs on its own app and model: Claude Code researches, Codex reviews, Gemini writes. Real
runs use the sign-in and plan you already have.

</td>
<td width="33%" valign="top">

### 🗺️ Build on a canvas

Drag agents in from the library, connect them in order, and read your team back as one plain
sentence. **Organize** tidies the layout in one click.

</td>
<td width="33%" valign="top">

### 👀 Watch every step

Live stages, tool calls, handovers and a run receipt. Drag the timeline to replay what happened, and
when.

</td>
</tr>
<tr>
<td valign="top">

### ✋ You stay in the loop

Add a **You** step to approve the work or send it back with changes. Agents can also stop and ask you
a question mid-run.

</td>
<td valign="top">

### 🧾 Evidence you can check

A skill shows as loaded only when it was actually sent, and as opened only when the agent's own
stream read it. Nothing is guessed from a title.

</td>
<td valign="top">

### 🧰 Your skills, tools and files

Wire in the skills, MCP tools and project folders already on your computer. LoomWatch delivers each
one to the agents you choose.

</td>
</tr>
<tr>
<td valign="top">

### 🧠 Team memory

A **Brief** of shared instructions and files, and a **Notebook** of reusable notes and checkpoints
that carry from one run to the next.

</td>
<td valign="top">

### 🔁 Follow up or redo

Ask for another pass on the result, or **Redo from** a chosen step, without starting the whole team
again.

</td>
<td valign="top">

### ⏰ Schedules and Notion

Run a team every morning and send the answer to Notion. A review stop still waits for you.

</td>
</tr>
<tr>
<td valign="top">

### 💼 Saved jobs

Save an agent that works as a job, with its instructions, app, model and skills, and add it to any
team.

</td>
<td valign="top">

### 🎓 Guided first run

An offline demo team and a three-minute guide. You can learn the whole app before you connect an AI
account.

</td>
<td valign="top">

### 🔒 Runs on your computer

The app, your teams and your run history stay on this computer. Agents' apps still talk to their own
model providers, as they always do.

</td>
</tr>
</table>

## See it

<table>
<tr>
<td align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/build-dark.png">
  <img src="docs/assets/readme/build-light.png" alt="Build view: a daily news team on the canvas. A schedule trigger feeds News Collector, News Editor and Digest Writer, which produce the team response. Above the canvas, the team is described in one sentence.">
</picture>
<br><sub><strong>Build.</strong> A news team that runs every morning, with the whole pipeline summed up in one sentence.</sub>
</td>
</tr>
<tr>
<td align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/run-dark.png">
  <img src="docs/assets/readme/run-light.png" alt="Run view of a finished run: the request, a run receipt listing each step, a replay timeline, and the team response with Retry and Follow up controls.">
</picture>
<br><sub><strong>Run.</strong> The receipt says who did what, the timeline replays it, and the answer sits beside it, ready for review.</sub>
</td>
</tr>
<tr>
<td align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/home-dark.png">
  <img src="docs/assets/readme/home-light.png" alt="Home: Put AI agents to work as a team. A New team button, the Build, Ask, Review steps, and three team cards with their last run.">
</picture>
<br><sub><strong>Home.</strong> Your teams at a glance, each with a woven mark of how its recent runs went.</sub>
</td>
</tr>
</table>

## Quickstart

```sh
git clone git@github.com:tnghia903/loomwatch.git
cd loomwatch
./loomwatch
```

The first start takes a few minutes, then opens **<http://127.0.0.1:3000>** with an offline demo team
ready to run. No AI account, API key or model usage is needed for the demo, though installing does
need internet access. Then follow [Try your first run](#try-your-first-run).

This recommended setup runs LoomWatch itself on your computer and keeps only its database
(PostgreSQL) in Docker. That way LoomWatch can use the agent apps, skills, MCP tools, sign-ins,
memory and workspace folders already set up for your user account.

### What you need

LoomWatch is built on your computer the first time you start it, so it needs a few free tools. You
don't have to check for them yourself: `./loomwatch` lists anything missing and how to install it.

| Tool | Why |
| --- | --- |
| [Docker Desktop](https://docs.docker.com/desktop/) (or OrbStack, or Docker Engine with Compose) | Runs the database that keeps your run history |
| [Node.js](https://nodejs.org/) 22.12 or newer | Builds the browser app |
| [Rust](https://rustup.rs/) | Builds the LoomWatch program. The exact version it needs downloads on its own during the first build |
| [Git](https://git-scm.com/downloads), plus access to this private repository | Downloads LoomWatch |
| Python 3 | Runs the offline demo. Usually already installed on macOS |

On a Mac with [Homebrew](https://brew.sh/), these two commands install everything:

```sh
brew install --cask docker-desktop && brew install node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

Then open a new terminal window so it finds the new tools.

To run real agents, you also need at least one AI app installed and signed in, such as Claude Code,
Codex, Gemini CLI or OpenCode. You do **not** need one for the demo.

Everything below is typed in a terminal (Terminal on macOS). Use a terminal where your AI app's
command already works, because LoomWatch finds your apps, skills and tools through it.

### 1. Download LoomWatch

The repository is private, so use a method that is signed in to GitHub. With an SSH key set up for
GitHub:

```sh
git clone git@github.com:tnghia903/loomwatch.git
cd loomwatch
```

Or, with the [GitHub CLI](https://cli.github.com/) after `gh auth login`:

```sh
gh repo clone tnghia903/loomwatch
cd loomwatch
```

### 2. Start LoomWatch

From inside the `loomwatch` folder:

```sh
./loomwatch
```

The first start takes a few minutes. It sets everything up for you:

1. Creates your settings file (`.env`) with a random database password.
2. Creates your teams folder, `~/LoomWatch/teams`, with an offline demo team in it.
3. Opens Docker Desktop if it is not running, then starts the database. The database keeps your
   run history, notes and checkpoints in a Docker volume, so they survive restarts.
4. Builds LoomWatch. This happens only the first time and after an update.
5. Starts LoomWatch and opens **<http://127.0.0.1:3000>** in your browser.

Keep this terminal window open while you use LoomWatch. To stop LoomWatch, press **Ctrl-C** in it.

LoomWatch looks for your skills and tools in the usual places in your home folder (`.claude`,
`.codex`, `.agents`, `.config/opencode` and similar) and for AI apps on the terminal's `PATH`. It
reads them only on your computer; nothing is uploaded.

### Every day

| To | Run, from the `loomwatch` folder |
| --- | --- |
| Start LoomWatch, or open it if it is already running | `./loomwatch` |
| Stop LoomWatch | Press **Ctrl-C** in its window |
| Also stop the database, for example before quitting Docker Desktop | `./loomwatch stop` |
| Update to the latest version (stop it first) | `./loomwatch update` |
| See every option | `./loomwatch help` |

Your teams and history are kept in every case. `./loomwatch update` downloads the latest version,
rebuilds it and starts it. If you installed LoomWatch with the older step-by-step instructions,
`./loomwatch` keeps using your existing settings, teams folder and database.

To stop one run, click **Stop** in the composer. Closing the browser tab does not stop LoomWatch or
its runs. Scheduled teams run only while LoomWatch and its database are running and the computer is
awake. For scheduled runs and optional Notion delivery, see [Routines](docs/WATCH.md#routines) and
[Notion setup](docs/NOTION.md).

### Change the defaults

| Setting | Default | For example |
| --- | --- | --- |
| Browser port | `3000` (or `LOOMWATCH_PORT` in `.env`) | `LOOMWATCH_PORT=3001 ./loomwatch` |
| Teams folder | `~/LoomWatch/teams` | `LOOMWATCH_TEAMS_ROOT=~/Work/teams ./loomwatch` |
| Database | PostgreSQL in Docker | `LOOMWATCH_DATABASE_URL=postgres://… ./loomwatch` uses your own PostgreSQL, and Docker is not needed |

`./loomwatch --no-open` starts without opening the browser, `./loomwatch --rebuild` builds again
even when nothing changed, and `./loomwatch help` lists everything.

<details>
<summary>What <code>./loomwatch</code> runs, if you prefer to do it by hand</summary>

```sh
cp .env.example .env   # then replace both replace-with-… values with long random letters and numbers
docker compose up -d --wait postgres
(cd ui && npx --yes pnpm@12 install --frozen-lockfile && npx --yes pnpm@12 run build)
cargo build --release --locked --bin loomwatchd
mkdir -p "$HOME/LoomWatch/teams"
cp -n examples/operator-stop.yaml examples/operator-stop-harness.py "$HOME/LoomWatch/teams/"
set -a; . ./.env; set +a
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"
unset LOOMWATCH_CAPABILITY_HOME LOOMWATCH_HOST_RUNNER_ADDR LOOMWATCH_HOST_RUNNER_TOKEN
./target/release/loomwatchd serve --teams-root "$HOME/LoomWatch/teams" --listen 127.0.0.1:3000
```

The browser app is built before the program because it is packed into it. The `unset` line keeps
settings meant for the Docker Compose mode below out of a local run.

</details>

## Try your first run

The first time you open LoomWatch, a short guide offers to walk you through creating a team and
running it with one of your own AI apps. Reopen it any time from the menu in a team, or press
**⌘K** and choose **Getting started guide**.

To try a team without calling a model provider, pick **Review stop demo** under **Your teams**. The
demo is a three-step workflow: **Researcher → You → Writer**. Its agents produce fixed responses so
you can learn the interface without calling a model provider.

1. Click **Run team**, type `Prepare a short getting-started guide for new users.` in the box at
   the bottom right, and press **Enter** (**Shift+Enter** adds a new line).
2. When the team pauses for you, open **What Researcher handed over** to read it.
3. To ask for changes, type `Use the short guide and remove the detailed walkthrough.` and click
   **Send back to Researcher**. The researcher revises its work and asks again.
4. Click **Approve** to let the team continue. You can also type a note first; it is passed on as
   your direction.
5. Read the **Team response**. The demo writer echoes the direction it received, and the run
   finishes as **Finished**.

Use the history button beside the request box to reopen a run. The replay slider lets you
inspect earlier events without running the agents again. To request another pass, type
new instructions and choose **Follow up**; **Redo from** can start again at a selected step.

## Run your own agents

1. Install and sign in to the AI app you want to use (Claude Code, Codex or OpenCode, for example)
   in Terminal, and confirm it works on its own.
2. Start LoomWatch from a terminal where that app is available. The bottom of the home screen
   lists the AI apps it found.
3. Click **New team**, give it a name and choose how it should start:
   - **One assistant** — a single agent that does the whole task (recommended to begin with).
   - **Researcher and writer** — one agent gathers facts, a second writes the result.
   - **Research, your approval, then writing** — the team pauses so you can approve the research.
   - **Empty team** — build it yourself from the library on the left.

   Ready-made teams are saved straight away with your AI app's own default model, so you can
   run them immediately.
4. Click **Run team**, describe what you want in plain words, and press **Enter**.
5. To customise, open **Build**: click **+** next to an AI app to add an agent, select a card to
   edit its instructions, app and model, and drag from the dot on a card's right edge to the next
   card to make them work in order. Add **You (review step)** wherever you want to approve work
   before the team continues.

LoomWatch connects to agent apps through ACP, a protocol for exchanging tasks and results.
The Library recognizes these integrations:

| Agent app | Connection used by LoomWatch |
| --- | --- |
| Claude | `claude-agent-acp`, with an `npx` bridge fallback |
| Codex | `codex-acp`, with an `npx` bridge fallback |
| Gemini | `gemini --acp` |
| OpenCode | `opencode acp` |
| Hermes | `hermes-acp` |
| OpenClaw | `openclaw acp` |

Bridge fallbacks may download a package on first use. Availability in the Library means
the required commands were found; it does not confirm that your account is signed in or
has model access. Delegation and session-resume support vary by integration.

Provider authentication stays with your agent app. Real runs use your existing provider
account and its usage limits or billing. The offline demo does not consume that usage.
Agent apps may send prompts and files to their configured model providers; running
LoomWatch locally does not make cloud models offline.

<details>
<summary><strong>Keep the pipeline easy to follow</strong></summary>

Click **Organize** in the canvas controls (or press **⌥⌘L**) to arrange stages from left to
right and group skills and sources below their agents. The view fits the arranged pipeline
above the composer. **Undo organize** restores the previous arrangement. Positions are saved
with the canvas layout; organizing does not change the workflow or start a run.

</details>

<details>
<summary><strong>Connect skills, knowledge and tools</strong></summary>

The library on the left of **Build** lists the skills, MCP tools and knowledge sources found on your
computer. Add one to the canvas, then drag from an agent to it, or open the card's
**Details & connections** and tick the agents that should use it. Save the team, and the next run
delivers it:

- A **skill** is copied into the agent's working folder and its instructions are given to the agent.
- A **knowledge source**, such as a project folder, is given to the agent as reference material:
  the same contents you see under **Contents** in its details. The agent can also read the folder.
- A **tool** is your own MCP server, handed to that agent's app with the settings you already gave it
  in Claude Code, Codex or OpenCode.

If something cannot be delivered (for example, a tool that is turned off in your app's settings),
the run stops before it starts and says what to change. If an older team shows "drawn but not
delivered to agents yet" at the top of Build, click **Deliver on the next run**, then save.

</details>

<details>
<summary><strong>Give the team context and review its work</strong></summary>

Open **Memory** to add shared instructions or reference files to the **Brief**. Use the
**Notebook** to review reusable notes and checkpoints. An agent's **What it was given**
control shows the context supplied at the start of its session.

For a review checkpoint in a pipeline, add a **You** node between two agents and describe
what you want to review in its role. **Continue** passes your answer to the next stage;
**Send back** requests a revision while the previous session is available. An agent can
also ask you a question during its work. Answer it in the composer when prompted.

</details>

## FAQ

<details>
<summary><strong>Do I need an API key?</strong></summary>

No. LoomWatch drives the AI apps you have already signed in to, such as Claude Code, Codex, Gemini
CLI or OpenCode, with their own sign-in. The offline demo needs no AI account at all.

</details>

<details>
<summary><strong>What does a run cost?</strong></summary>

Real runs use your AI apps' own accounts, so they count against those plans' usage limits or
billing, as if you had used the apps yourself. The offline demo uses none.

</details>

<details>
<summary><strong>Is my work sent anywhere?</strong></summary>

LoomWatch serves everything on `127.0.0.1` and keeps your run history in a database on this
computer. It reads your skills and tools only on your computer. The agents' own apps still send
prompts and files to their model providers, as they do when you use them directly.

</details>

<details>
<summary><strong>Can different agents in one team use different apps and models?</strong></summary>

Yes. Each agent card has its own app and model. A team can research with Claude Code, review with
Codex and write with Gemini. Through OpenCode, an agent can also use models such as DeepSeek, Kimi,
GLM, Qwen or Mistral.

</details>

<details>
<summary><strong>What happens when an agent asks for permission to do something?</strong></summary>

LoomWatch declines interactive permission requests, and the run records each one, so nothing happens
behind your back. Give the agent app the specific permissions the task needs in its own settings.

</details>

<details>
<summary><strong>Can I run it on a server, or entirely in Docker?</strong></summary>

Yes. See [Run everything with Docker Compose](#optional-run-everything-with-docker-compose). The
recommended desktop setup runs LoomWatch itself on your computer so it can use the apps, skills and
sign-ins already there.

</details>

## Optional: run everything with Docker Compose

Use this mode for CI, demos, or an intentionally isolated Linux deployment. It is not the
recommended desktop setup: a container cannot automatically see host executables, skills, MCP
configuration, credentials, or arbitrary host workspace paths.

<details>
<summary>Set up the Compose stack</summary>

Create your settings file with `cp .env.example .env` and replace both `replace-with-…` values with
long random letters and numbers (or run `./loomwatch` once, which does this for you). Then create a
repository-local teams folder, and build and start the complete stack:

```sh
mkdir -p teams
cp -n examples/operator-stop.yaml examples/operator-stop-harness.py teams/
docker compose up --build --detach --wait
```

Open the [offline review-stop demo](http://127.0.0.1:3000/?path=operator-stop.yaml). The UI is
embedded in the `loomwatch` image, PostgreSQL holds run history, context packets, Notebook entries,
and checkpoints, and both services are published only on host loopback. To stop, finish or stop
active runs, then run `docker compose stop`: it preserves both named volumes, and
`docker compose up --detach --wait` resumes the stack.

The defaults mount these explicit roots:

| Container path | Default host path | Access | Purpose |
| --- | --- | --- | --- |
| `/data/teams` | `./teams` | Read/write | Team YAML, Brief files, layouts, and managed `.loomwatch` workspaces |
| `/workspaces` | `./container/workspaces` | Read/write | Repositories used by container-native agents |
| `/opt/loomwatch/capabilities` | `./container/capabilities` | Read-only | Skills and plugin metadata intentionally imported for discovery |
| `/home/node` | `loomwatch-home` volume | Read/write | Harness credentials and mutable CLI state |

</details>

<details>
<summary>Use harnesses installed on the host</summary>

A Linux container cannot execute a macOS or Windows binary, so LoomWatch uses a narrow native
runner instead of mounting your home directory or Docker socket. Set a random
`LOOMWATCH_HOST_RUNNER_TOKEN` in `.env`, then start the companion from the repository in a host
terminal:

```sh
./container/run-host-runner.sh
```

Keep that terminal open and start the Compose stack normally in another terminal. The Library now
shows the harnesses found on the host. Agents added from those rows use an internal
`loomwatchd harness-client` command: model discovery and runs stream over the same authenticated
connection to the native ACP adapter. The runner accepts only LoomWatch's known ACP harnesses and
maps working directories only beneath `/data/teams` and `/workspaces` back to their configured host
bind mounts.

The runner listens on `0.0.0.0:3031` so Docker Desktop's `host.docker.internal` gateway can reach
it. It requires the token on every connection. If port 3031 is already used, change both
`LOOMWATCH_HOST_RUNNER_LISTEN` and `LOOMWATCH_HOST_RUNNER_ADDR` in `.env`.

Override the three bind-mounted host directories in `.env`. Do not point the capability import at
your complete home directory. Its README documents the expected `.codex`, `.claude`, `.agents`, and
OpenCode subdirectories.

</details>

<details>
<summary>Harnesses and skills in the container</summary>

The Library combines harness commands executable inside the container with harnesses reported by a
reachable native companion; host entries win when both environments provide the same app. The base
image includes Node.js, Python, Git, curl, and everything needed by the offline demo, but it does
not bundle third-party provider CLIs. Without the native companion, build a derived image with the
required Linux harnesses or install user-scoped CLI packages into the persistent runtime home. The
image's `PATH` includes `/home/node/.local/bin`.

Authenticate from the same runtime after installing a harness:

```sh
docker compose exec loomwatch sh
npm config set prefix "$HOME/.local"
# Install and authenticate only the provider CLIs you intend to use.
```

Import skill definitions through `container/capabilities`, preserving their conventional paths.
Imports are read-only; LoomWatch copies only a skill explicitly wired to an agent into that team's
managed workspace. Do not put provider tokens, SSH keys, or other credentials in the import.

Team files running against a mounted repository should use a path below `/workspaces`. Absolute
host paths such as `/Users/name/project` do not exist inside the Linux container.

</details>

## Where your work is saved

| Data | Location in this guide |
| --- | --- |
| Team definitions and canvas layouts | `~/LoomWatch/teams`; Compose-only deployments use `LOOMWATCH_TEAMS_DIR` |
| Brief files | Paths configured by the team, usually beside its YAML file |
| Deleted teams | `.trash` inside your teams folder, one folder per deleted team |
| Your saved jobs | `.jobs` inside your teams folder, one `<job>.yaml` per job; removed jobs move to `.jobs/.removed` |
| Run history, recorded events, and Notebook entries | The local PostgreSQL Docker volume |
| Database settings | `.env` in the source repository |
| Provider sign-in | Managed by each host agent app; Compose-only deployments use `loomwatch-home` |

Back up your teams folder and PostgreSQL database if you want to move or preserve your work.
`docker compose stop` preserves data. Avoid `docker compose down -v` for normal shutdown:
it deletes the database volume, including history and Notebook entries.

<details>
<summary>Deleting and restoring a team</summary>

To delete a team, choose **Delete team…** from its **…** menu on Home or from the team switcher.
LoomWatch refuses while the team is running, or while another team reads its memory. Nothing is
erased. The team file, its layout and its own notes folder (`<team>.brief`, if it has one) move to
`.trash/<date>-<team>/` inside your teams folder. Its run history and Notebook entries stay in the
database, and no new team takes its file name while it is in the trash. To restore it, move the
files in that folder back to where `path` in its `deleted.json` says the team file was, and leave
`deleted.json` behind. In Finder, press ⌘⇧. to show hidden folders. To remove a team for good,
delete its folder from `.trash`.

</details>

<details>
<summary>Reusing an agent as a saved job</summary>

To reuse an agent that works, select it in Build and choose **Save as job**. It appears under
**Your jobs** at the top of the palette, with its instructions, app, model and skills, and can be
added to any team. Placing a job copies it into the team, so changing or removing the job later
leaves existing teams alone. A job is one small file, so you can share it by copying it into another
teams folder's `.jobs`.

</details>

## Troubleshooting

<details>
<summary>Something did not work? Find what you see in this table.</summary>

| What you see | What to check |
| --- | --- |
| `git clone` asks for a username, or says the repository is not found | The repository is private. Clone with SSH or `gh repo clone` as in step 1, using a GitHub account that has access. |
| `./loomwatch` says something needs to be installed first | Install what it lists, open a new terminal window so it picks up the new `PATH`, then run `./loomwatch` again. |
| `permission denied: ./loomwatch` | Run `chmod +x loomwatch` once, or start it with `bash loomwatch`. |
| Docker did not start within two minutes | Open Docker Desktop yourself, finish any first-start steps it shows, wait until it says it is running, then run `./loomwatch` again. |
| Another program is using port 5433 | Change `POSTGRES_PORT` in `.env` to a free port such as `5434`, then run `./loomwatch` again. |
| Password authentication failed | Use the credentials from the database's first initialization. Editing `.env` does not change the password in an existing database volume. |
| Archive disabled / Run unavailable | LoomWatch was started without its database. Stop it and start it with `./loomwatch`. |
| Another program is using port 3000 | Start LoomWatch on another port with `LOOMWATCH_PORT=3001 ./loomwatch`. |
| Team file not found | Confirm the file is in your teams folder (`~/LoomWatch/teams` unless you set `LOOMWATCH_TEAMS_ROOT`). The demo link uses `?path=operator-stop.yaml`, relative to that folder. |
| Agent is missing or unavailable | Run `command -v <agent-command>` in the LoomWatch terminal. Authenticate the app, then restart LoomWatch from that same terminal. Compose-only deployments scan the container unless the native companion is running. |
| Skill or tool is missing locally | Confirm it exists below the current user's `.codex`, `.claude`, `.agents`, or `.config/opencode` tree, then choose **Scan again**. Check that LoomWatch was not started with `LOOMWATCH_CAPABILITY_HOME` pointing elsewhere. |
| Skill is missing in Compose | Copy its definition below `LOOMWATCH_CAPABILITIES_DIR` using the conventional harness path, then choose **Scan again**. Symlinks whose targets are outside that mounted root cannot be followed. |
| Harness working directory is missing | Native teams should use a real host path accessible to the agent app. Container-run teams must use `/workspaces/...` and mount its host parent through `LOOMWATCH_WORKSPACES_DIR`. |
| Agent cannot perform a tool action | Review the recorded permission request and that agent app's project permissions. LoomWatch declines interactive ACP permission requests; configure the specific permissions the task needs in the agent app. |
| Build reports an unsupported Node version | Install the current Node.js from <https://nodejs.org/>, reopen Terminal, and check `node --version`. |
| UI assets are missing or look out of date | Stop LoomWatch, then start it with `./loomwatch --rebuild`. |
| Cannot connect from another device | This setup serves runs and history only on your own computer at `127.0.0.1`. Use the browser on that computer. |

</details>

## Under the hood

| Piece | What it does |
| --- | --- |
| `loomwatchd` | One Rust program that starts each agent's app, supervises it, and serves the browser app |
| [ACP](https://agentclientprotocol.com) | How LoomWatch talks to every agent app, over its standard input and output |
| Team Bus | A tool server the agents call back into to hand work over, ask each other questions, or report |
| Event archive | PostgreSQL, holding every message, tool call and handover, so runs can be replayed |
| Browser app | React, streamed live over a WebSocket and packed into the program |

## More guides

- [Team configuration](docs/TEAM_CONFIG.md) — roles, models, working directories, and workflow rules.
- [Team memory](docs/TEAM_MEMORY.md) — Brief, Notebook, inheritance, and checkpoints.
- [Watch and replay](docs/WATCH.md) — inspecting runs, routines, and the local API.
- [Architecture](docs/ARCHITECTURE.md) — technical details for developers.
- [Container runtime decision](docs/decisions/0018-container-native-compose.md) — execution, mount, and trust boundaries.

<br>

<p align="center">
  <sub>Woven with Rust, React and ACP. Watch every thread.</sub>
</p>

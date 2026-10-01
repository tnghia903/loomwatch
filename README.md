# LoomWatch

**Build a team of AI agents. Give them a task. Watch the work happen.**

LoomWatch runs on your computer and opens in your browser. Arrange agents on a canvas,
connect them into a workflow, and see their progress, tool calls, handovers, and final
answer in one place. Add a **You** step when the team needs your review before continuing.

You can:

- Run a single agent, a step-by-step pipeline, or a team that delegates work as it goes.
- Mix supported agent tools from different providers.
- Give the team shared instructions and reusable notes through **Memory**.
- Review findings, send work back for changes, and answer an agent's questions.
- Reopen earlier runs, inspect their evidence, and start a follow-up from a selected stage.

The recommended installation runs LoomWatch itself on your computer and keeps only PostgreSQL in
Docker. This lets LoomWatch use the agent harnesses, skills, MCP tools, credentials, memory, and
workspace paths already installed for your user account. The first run uses a bundled offline demo:
no AI account, API key, or model usage is needed. Installation still requires internet access.

## What you need

Install these once, before you start:

| Requirement | Why | Check it with |
| --- | --- | --- |
| [Docker Desktop](https://docs.docker.com/desktop/) (or Docker Engine with Compose) | Runs the database that keeps your run history. Open it and leave it running. | `docker compose version` |
| [Git](https://git-scm.com/downloads), plus access to this private repository | Downloads LoomWatch. | `git --version` |
| [Node.js 24](https://nodejs.org/) | Builds the browser app. | `node --version` |
| [Rust via rustup](https://rustup.rs/) | Builds the LoomWatch program. The exact Rust version this project needs (pinned in `rust-toolchain.toml`) downloads on its own the first time you build. | `cargo --version` |
| Python 3 | Runs the offline demo. Usually already installed on macOS. | `python3 --version` |

To run real agents, you also need at least one AI app installed and signed in, such as Claude Code,
Codex, Gemini CLI or OpenCode. You do **not** need one for the demo.

Everything below is typed in a terminal (Terminal on macOS). Use a terminal where your AI app's
command already works, because LoomWatch finds your apps, skills and tools through it.

## Install and run LoomWatch

LoomWatch runs on your own computer and opens in your browser. Only the database runs in Docker.
The first install takes a few minutes, most of it downloads and the one-time build.

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

Run every remaining command from inside this `loomwatch` folder.

### 2. Set up and start the database

Create your settings file:

```sh
cp .env.example .env
```

Open `.env` in a text editor and replace `replace-with-a-local-password` with a long password of
letters and numbers only. Leave the other values alone unless port 5433 is already in use on your
computer. Then start the database:

```sh
docker compose up -d --wait postgres
```

It is ready when the output ends with `Healthy`. The database keeps your run history, notes and
checkpoints in a Docker volume, so they survive restarts.

### 3. Build LoomWatch

```sh
cd ui
npx --yes pnpm@12 install --frozen-lockfile
npx --yes pnpm@12 run build
cd ..
cargo build --release --locked
```

The order matters: the browser app is built first because it is packed into the LoomWatch program.
The last command takes a couple of minutes the first time.

### 4. Create your teams folder

Your teams live in their own folder, outside the source code. Create it and copy in the offline
demo:

```sh
mkdir -p "$HOME/LoomWatch/teams"
cp -n examples/operator-stop.yaml examples/operator-stop-harness.py "$HOME/LoomWatch/teams/"
```

### 5. Start LoomWatch

```sh
set -a; . ./.env; set +a
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"
unset LOOMWATCH_CAPABILITY_HOME LOOMWATCH_HOST_RUNNER_ADDR LOOMWATCH_HOST_RUNNER_TOKEN
./target/release/loomwatchd serve --teams-root "$HOME/LoomWatch/teams" --listen 127.0.0.1:3000
```

When the terminal shows `loomwatchd listening on http://127.0.0.1:3000`, open
**<http://127.0.0.1:3000>** in your browser, or go straight to the
[offline demo](http://127.0.0.1:3000/?path=operator-stop.yaml) and follow
[Try your first run](#try-your-first-run).

Keep this terminal window open while you use LoomWatch. To stop LoomWatch, press **Ctrl-C** in it.

LoomWatch looks for your skills and tools in the usual places in your home folder (`.claude`,
`.codex`, `.agents`, `.config/opencode` and similar) and for AI apps on the terminal's `PATH`. It
reads them only on your computer; nothing is uploaded.

### Start it again later

After a restart, or any time LoomWatch is not running: make sure Docker Desktop is open, then in a
terminal:

```sh
cd loomwatch
docker compose up -d --wait postgres
set -a; . ./.env; set +a
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"
unset LOOMWATCH_CAPABILITY_HOME LOOMWATCH_HOST_RUNNER_ADDR LOOMWATCH_HOST_RUNNER_TOKEN
./target/release/loomwatchd serve --teams-root "$HOME/LoomWatch/teams" --listen 127.0.0.1:3000
```

Use the path where you cloned LoomWatch in the first line. To stop the database too when you are
done (your data is kept):

```sh
docker compose stop postgres
```

### Update to a newer version

Stop LoomWatch with **Ctrl-C**, then:

```sh
git pull
cd ui
npx --yes pnpm@12 install --frozen-lockfile
npx --yes pnpm@12 run build
cd ..
cargo build --release --locked
```

Start it again as in [Start it again later](#start-it-again-later). Your teams and history are kept.

## Optional: run everything with Docker Compose

Use this mode for CI, demos, or an intentionally isolated Linux deployment. It is not the
recommended desktop setup: a container cannot automatically see host executables, skills, MCP
configuration, credentials, or arbitrary host workspace paths.

Create a repository-local teams folder, then build and start the complete stack:

```sh
mkdir -p teams
cp -n examples/operator-stop.yaml examples/operator-stop-harness.py teams/
docker compose up --build --detach --wait
```

Open the [offline review-stop demo](http://127.0.0.1:3000/?path=operator-stop.yaml). The UI is embedded in the `loomwatch` image, PostgreSQL
holds run history, context packets, Notebook entries, and checkpoints, and both services are
published only on host loopback. `docker compose stop` preserves both named volumes.

The defaults mount these explicit roots:

| Container path | Default host path | Access | Purpose |
| --- | --- | --- | --- |
| `/data/teams` | `./teams` | Read/write | Team YAML, Brief files, layouts, and managed `.loomwatch` workspaces |
| `/workspaces` | `./container/workspaces` | Read/write | Repositories used by container-native agents |
| `/opt/loomwatch/capabilities` | `./container/capabilities` | Read-only | Skills and plugin metadata intentionally imported for discovery |
| `/home/node` | `loomwatch-home` volume | Read/write | Harness credentials and mutable CLI state |

### Use harnesses installed on the host

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

### Harnesses and skills in the container

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

## Try your first run

Open LoomWatch and pick **Review stop demo** under **Your teams**. The demo is a three-step
workflow: **Researcher → You → Writer**. Its agents produce fixed responses so you can learn the
interface without calling a model provider.

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

### Keep the pipeline easy to follow

Click **Organize** in the canvas controls (or press **⌥⌘L**) to arrange stages from left to
right and group skills and sources below their agents. The view fits the arranged pipeline
above the composer. **Undo organize** restores the previous arrangement. Positions are saved
with the canvas layout; organizing does not change the workflow or start a run.

### Connect skills, knowledge and tools

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

### Give the team context and review its work

Open **Memory** to add shared instructions or reference files to the **Brief**. Use the
**Notebook** to review reusable notes and checkpoints. An agent's **What it was given**
control shows the context supplied at the start of its session.

For a review checkpoint in a pipeline, add a **You** node between two agents and describe
what you want to review in its role. **Continue** passes your answer to the next stage;
**Send back** requests a revision while the previous session is available. An agent can
also ask you a question during its work. Answer it in the composer when prompted.

## Stop and start again

To stop one run, click **Stop** in the composer. Closing the browser tab does not stop the
server or its runs.

For the optional full-Compose installation, stop active runs and then stop the stack:

```sh
docker compose stop
```

For the recommended local run, press **Ctrl-C** in the terminal running `loomwatchd`, then stop the
database if you do not need it:

```sh
docker compose stop postgres
```

Your teams and database remain on disk. Resume the full-Compose installation with
`docker compose up --detach --wait`, or resume the local install with
[Start it again later](#start-it-again-later).

Scheduled teams run only while the server and database are running and the computer is
awake. For scheduled runs and optional Notion delivery, see [Routines](docs/WATCH.md#routines)
and [Notion setup](docs/NOTION.md).

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

To delete a team, choose **Delete team…** from its **…** menu on Home or from the team switcher.
LoomWatch refuses while the team is running, or while another team reads its memory. Nothing is
erased. The team file, its layout and its own notes folder (`<team>.brief`, if it has one) move to
`.trash/<date>-<team>/` inside your teams folder. Its run history and Notebook entries stay in the
database, and no new team takes its file name while it is in the trash. To restore it, move the
files in that folder back to where `path` in its `deleted.json` says the team file was, and leave
`deleted.json` behind. In Finder, press ⌘⇧. to show hidden folders. To remove a team for good,
delete its folder from `.trash`.

To reuse an agent that works, select it in Build and choose **Save as job**. It appears under
**Your jobs** at the top of the palette, with its instructions, app, model and skills, and can be
added to any team. Placing a job copies it into the team, so changing or removing the job later
leaves existing teams alone. A job is one small file, so you can share it by copying it into another
teams folder's `.jobs`.

Back up your teams folder and PostgreSQL database if you want to move or preserve your work.
`docker compose stop` preserves data. Avoid `docker compose down -v` for normal shutdown:
it deletes the database volume, including history and Notebook entries.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| `git clone` asks for a username, or says the repository is not found | The repository is private. Clone with SSH or `gh repo clone` as in step 1, using a GitHub account that has access. |
| `command not found: cargo`, `node` or `npx` | Finish installing rustup or Node.js, then open a new terminal window so it picks up the new `PATH`. |
| Docker cannot connect | Open Docker Desktop, wait for it to start, then retry the database command. |
| Database connection failed | Run `docker compose ps postgres`; PostgreSQL should be healthy. Load `.env` and export `DATABASE_URL` in the terminal that starts LoomWatch. |
| Password authentication failed | Use the credentials from the database's first initialization. Editing `.env` does not change the password in an existing database volume. |
| Archive disabled / Run unavailable | Restart the server with `DATABASE_URL` set, as in [Start it again later](#start-it-again-later). |
| Address already in use | Stop the other LoomWatch server, or use `--listen 127.0.0.1:3001` and open port 3001 in the browser. |
| Team file not found | Confirm the file is under `--teams-root`. The demo link uses `?path=operator-stop.yaml`, relative to that folder. |
| Agent is missing or unavailable | Run `command -v <agent-command>` in the LoomWatch terminal. Authenticate the app, then restart LoomWatch from that same terminal. Compose-only deployments scan the container unless the native companion is running. |
| Skill or tool is missing locally | Confirm it exists below the current user's `.codex`, `.claude`, `.agents`, or `.config/opencode` tree, then choose **Scan again**. Check that LoomWatch was not started with `LOOMWATCH_CAPABILITY_HOME` pointing elsewhere. |
| Skill is missing in Compose | Copy its definition below `LOOMWATCH_CAPABILITIES_DIR` using the conventional harness path, then choose **Scan again**. Symlinks whose targets are outside that mounted root cannot be followed. |
| Harness working directory is missing | Native teams should use a real host path accessible to the agent app. Container-run teams must use `/workspaces/...` and mount its host parent through `LOOMWATCH_WORKSPACES_DIR`. |
| Agent cannot perform a tool action | Review the recorded permission request and that agent app's project permissions. LoomWatch declines interactive ACP permission requests; configure the specific permissions the task needs in the agent app. |
| Build reports an unsupported Node version | Install Node 24, reopen Terminal, and check `node --version`. |
| UI assets are missing or look out of date | Rebuild `ui` first, rebuild the release executable, then restart LoomWatch. |
| Cannot connect from another device | This setup serves runs and history only on your own computer at `127.0.0.1`. Use the browser on that computer. |

## More guides

- [Team configuration](docs/TEAM_CONFIG.md) — roles, models, working directories, and workflow rules.
- [Team memory](docs/TEAM_MEMORY.md) — Brief, Notebook, inheritance, and checkpoints.
- [Watch and replay](docs/WATCH.md) — inspecting runs, routines, and the local API.
- [Architecture](docs/ARCHITECTURE.md) — technical details for developers.
- [Container runtime decision](docs/decisions/0018-container-native-compose.md) — execution, mount, and trust boundaries.

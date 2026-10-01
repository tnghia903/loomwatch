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

Install these before starting:

| Requirement | What it is used for |
| --- | --- |
| [Docker Desktop](https://docs.docker.com/desktop/) or Docker Engine with Compose | Runs the local PostgreSQL database. |
| Git | Downloads the source. |
| Node.js 24 and Rust 1.98 | Build the UI and native LoomWatch executable. |
| Python 3 | Runs the bundled offline demo harness. |

You also need access to this repository. Start LoomWatch from a terminal where your agent commands
already work so it inherits the correct `PATH` and `HOME`.

## Recommended: run LoomWatch locally

This layout keeps host capability discovery accurate while PostgreSQL remains isolated and
persistent in Docker.

### 1. Get the source and configure the database

Clone the repository, create the local configuration, and choose a database password:

```sh
git clone https://github.com/tnghia903/loomwatch.git
cd loomwatch
test -f .env || cp .env.example .env
```

Open `.env` and replace `replace-with-a-local-password` with a long alphanumeric password. Keep
these defaults unless the port is already occupied:

```dotenv
POSTGRES_USER=loomwatch
POSTGRES_PASSWORD=replace-with-a-local-password
POSTGRES_DB=loomwatch
POSTGRES_PORT=5433
```

Start only PostgreSQL:

```sh
docker compose up -d --wait postgres
```

The database lives in a Docker volume, so stopping the container does not erase run history,
context packets, Notebook entries, or checkpoints.

### 2. Build LoomWatch

```sh
cd ui
npx --yes pnpm@10 install --frozen-lockfile
npx --yes pnpm@10 run build
cd ..
cargo build --release --locked
```

Build the browser app first because its assets are embedded in `target/release/loomwatchd`. A
separate frontend server is not required.

### 3. Create a teams folder

Keep user teams outside the source checkout and copy in the offline demo:

```sh
mkdir -p "$HOME/LoomWatch/teams"
cp -n examples/operator-stop.yaml examples/operator-stop-harness.py "$HOME/LoomWatch/teams/"
```

### 4. Start LoomWatch

In the same terminal where commands such as `codex`, `claude`, `gemini`, or `opencode` work, load
the database settings and start the native server:

```sh
set -a
. ./.env
set +a
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"

# Native mode scans this user's HOME and PATH directly; it does not need the container bridge.
unset LOOMWATCH_CAPABILITY_HOME LOOMWATCH_HOST_RUNNER_ADDR LOOMWATCH_HOST_RUNNER_TOKEN

./target/release/loomwatchd serve \
  --teams-root "$HOME/LoomWatch/teams" \
  --listen 127.0.0.1:3000
```

Wait for `loomwatchd listening on http://127.0.0.1:3000`, then open the
[offline review-stop demo](http://127.0.0.1:3000/?path=operator-stop.yaml). Keep this terminal open
while using LoomWatch.

The Library scans the conventional skill and tool locations beneath the current `HOME`, including
`.codex`, `.claude`, `.agents`, and `.config/opencode`. It also scans the server's `PATH` for
supported ACP harnesses. Only capability metadata is listed; private skill contents and connector
configuration remain local. Without `DATABASE_URL`, team editing works but runs, history, and
Notebook features are unavailable.

To stop the app, press **Ctrl-C** in its terminal. To stop PostgreSQL without deleting its data:

```sh
docker compose stop postgres
```

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

The demo is a three-step workflow: **Researcher → You → Writer**. Its agents produce fixed
responses so you can learn the interface without calling a model provider.

1. Type `Prepare a short getting-started guide for new users.` in the bottom composer.
2. Click **Run**, or press **⌘ Enter**. If you edited the team, use **Save & run**.
3. When the run says **Waiting for you**, open **What Researcher handed over**.
4. Enter `Use the short guide and remove the detailed walkthrough.` and click
   **Send back to researcher**. The researcher revises its handover and asks again.
5. Enter `Approved. Write a short guide for new users.` and click **Continue**.
6. Read the **Output** card. The demo writer echoes the direction it received, and the run
   finishes as **Succeeded**.

Use the history button beside the composer to reopen a run. The replay slider lets you
inspect earlier events without running the agents again. To request another pass, type
new instructions and choose **Follow up**; its target menu can start from a selected stage.

## Run your own agents

Once the demo works, create a new team using the team menu at the top of the canvas.

1. Install and authenticate your chosen agent app in Terminal. Confirm it works on its own
   before using it through LoomWatch.
2. Start LoomWatch from a terminal where that app is available. Open the **Library** to see
   detected agents and any missing requirements.
3. Drag an available agent onto the canvas. Select its card and fill in its role, a model
   available to your account, its working directory, and its budget. The first agent becomes
   the team's starting agent.
4. Start with one agent and a small task. Add more agents when you want separate roles, such
   as researcher, reviewer, and writer. Connect them in order for a pipeline, or leave them
   unconnected to let the starting agent delegate when its integration supports Team Bus.
5. Save the team inside your teams folder and use **Run** or **Save & run**.

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
`docker compose up --detach --wait`, or resume the local workflow by starting `postgres` and
repeating the server command in **Step 4**.

Scheduled teams run only while the server and database are running and the computer is
awake. For scheduled runs and optional Notion delivery, see [Routines](docs/WATCH.md#routines)
and [Notion setup](docs/NOTION.md).

## Where your work is saved

| Data | Location in this guide |
| --- | --- |
| Team definitions and canvas layouts | `~/LoomWatch/teams`; Compose-only deployments use `LOOMWATCH_TEAMS_DIR` |
| Brief files | Paths configured by the team, usually beside its YAML file |
| Run history, recorded events, and Notebook entries | The local PostgreSQL Docker volume |
| Database settings | `.env` in the source repository |
| Provider sign-in | Managed by each host agent app; Compose-only deployments use `loomwatch-home` |

Back up your teams folder and PostgreSQL database if you want to move or preserve your work.
`docker compose stop` preserves data. Avoid `docker compose down -v` for normal shutdown:
it deletes the database volume, including history and Notebook entries.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| Docker cannot connect | Open Docker Desktop, wait for it to start, then retry the database command. |
| Database connection failed | Run `docker compose ps postgres`; PostgreSQL should be healthy. Load `.env` and export `DATABASE_URL` in the terminal that starts LoomWatch. |
| Password authentication failed | Use the credentials from the database's first initialization. Editing `.env` does not change the password in an existing database volume. |
| Archive disabled / Run unavailable | Restart the server with `DATABASE_URL` set as shown in Step 4. |
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

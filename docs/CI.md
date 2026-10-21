# Continuous integration

Every check runs on GitHub-hosted runners. CI's job is to prove that every pull request, before it
merges, and `main`, after it, builds, passes its tests on Linux and Windows and still produces a
container image. `scripts/ci-local.sh` runs most of it on your computer first, when you want a
quicker answer. Two workflows publish:
**Pages** puts the landing page and the installer on https://loomwatch.github.io, and **Release**
builds the ready-to-run program for a version tag.

## Workflows

| Workflow | Runs on | What it proves | Typical time |
| --- | --- | --- | --- |
| `ci.yml` — **Frontend**, then **Rust** | every pull request (`pull-requests.yml` calls it), every push to `main`, by hand | UI lint (warnings fail), typecheck, build and tests; then `cargo fmt`, Clippy (`-D warnings`) and the full test suite, each database test on a SQLite file of its own, building on the exact `ui/dist` the Frontend job produced | 2 + 5–8 min |
| `ci.yml` — **Windows** | the same, after Frontend | on a Windows runner: the PowerShell scripts parse and are ASCII, Clippy (`-D warnings`) and the full test suite; then the release zip and `LoomWatch-windows-setup.exe` are packed and `scripts/smoke-windows.ps1` tries both: the PowerShell install driven through the offline demo's review stop, an agent on a stand-in for OpenRouter (`scripts/mock-openrouter.py`) keeping its key in Credential Manager and running a `cmd.exe` command in its own folder, `LoomWatch.exe` (one at a time, `--quit`), and the installer installing, updating over a running LoomWatch, and uninstalling | 20–30 min |
| `ci.yml` — **Launcher** | the same, beside Frontend | ShellCheck on the launcher and installer, and `scripts/test-update.sh`: `update`, `rollback` and `version` on an installed copy, with stand-ins for Docker, GitHub and the program | < 1 min |
| `ci.yml` — **Dependency review** | the same, not by hand | comparing a pull request with its base, or `main` before and after a push: the change adds no dependency with a known vulnerability of moderate severity or worse (`Cargo.lock`, `ui/pnpm-lock.yaml`) | < 1 min |
| `ci.yml` — **CI result** | after the jobs above | every job above passed: the one answer to read for a run | seconds |
| `pull-requests.yml` | every pull request | runs `ci.yml`; a newer push to the pull request cancels the older run | seconds, then `ci.yml` |
| `container.yml` — **Build image** | a pull request or push to `main` that changes the Dockerfile or a lockfile/toolchain/manifest it builds from, monthly, by hand | `docker build` still succeeds; the image is never pushed | ~10–15 min (estimate) |
| `actionlint.yml` | a pull request or push to `main` that changes `.github/workflows/`, by hand | the workflow files themselves are valid | < 1 min |
| `pages.yml` — **Publish** | a change to `site/`, `scripts/install.sh`, the README screenshots or fonts it borrows, by hand | builds the landing page with `site/build.sh` and pushes it to the `loomwatch/loomwatch.github.io` repository, which GitHub Pages serves | < 1 min |
| `release.yml` | a `v*` tag, by hand | builds the browser app once, then `loomwatchd` for macOS (one universal program, on macOS), Linux x86_64/arm64 (on Ubuntu 22.04) and Windows x86_64, packs each with `scripts/package-release.sh`, builds `LoomWatch-macos.dmg` and `LoomWatch-windows-setup.exe` (Inno Setup, from Chocolatey), and, for a tag, attaches them to a **draft** release. Run by hand, it only builds the files | ~15 min |

```
pull request / push to main
        │
        ▼
   Frontend ───ui/dist──▶ Rust (fmt → clippy → test) ──────────────────┐
                    └───▶ Windows (clippy → test → pack → smoke) ──────┤
   Launcher (shellcheck → update/rollback test) ───────────────────────┼──▶ CI result
   Dependency review (base and head of the change) ────────────────────┘
```

## Conventions

- **Every pull request, then every commit on `main`.** A pull request runs CI as GitHub would merge
  it into its base branch, and a newer push to it cancels the older run. Pushing a branch with no
  pull request runs nothing; dispatch CI on it by hand (`gh workflow run ci.yml --ref <branch>`).
  Once a change merges, CI runs on `main`, every commit with a run of its own (no concurrency
  group), so when several merges land together none goes unchecked.
- **Free, and it keeps going without you.** Standard GitHub-hosted runners, Windows included, cost
  nothing for a public repository, so a pull request runs everything. The run carries on while your
  computer sleeps.
- **One answer to read.** **CI result** waits for every other CI job and passes only if they all
  did. On a pull request it shows as **CI / CI result**, since `pull-requests.yml` calls `ci.yml`.
  The path-filtered workflows (container, actionlint) report only when their files change.
- **Safe for pull requests from forks.** Workflows use `pull_request`, never `pull_request_target`,
  so code from a fork runs with a read-only token and no secrets, and none of the checks need one.
  A first-time contributor's run waits for a maintainer to approve it.
- **Pinned and least-privileged.** Actions are pinned to full commit SHAs (the version is in the
  trailing comment), the workflow token is read-only, and checkouts do not keep credentials.
  Dependabot (`.github/dependabot.yml`) proposes updates monthly, grouped, and its pull requests run
  the same checks.
- **Reproducible.** `pnpm install --frozen-lockfile` and `cargo … --locked` fail on a stale
  lockfile. Versions come from one place each: Node from `.node-version`, pnpm from
  `packageManager` in the root `package.json`, Rust from `rust-toolchain.toml`.
- **Cheap where it can be.** The pnpm store, Rust build and container layers are cached (only
  `main` writes the Rust and container caches; pull requests restore them), and the expensive
  container build is path-filtered. Each job has a timeout.
- **Never skip a test to get green.** A red check is fixed or explained, not muted.

## Check a branch on your computer first

```sh
scripts/ci-local.sh
```

A quicker answer before you push, when you want one: about 2 minutes once the build folders exist,
against about 9 for CI. It runs what CI runs, from anywhere in the checkout, and ends with a summary
of each check: passed, failed, or skipped and why. It exits non-zero when any check failed. Your
computer stops it when it sleeps; `caffeinate -i scripts/ci-local.sh` keeps a Mac awake while it
runs, unless the lid closes.

- **Launcher**: ShellCheck and `scripts/test-update.sh`.
- **Workflows**: actionlint, when it is installed (`brew install actionlint`).
- **Frontend**: install, lint, build and tests, exactly as the job runs them.
- **Rust**: `cargo fmt`, Clippy and the full test suite. These need the Frontend build, since the
  daemon embeds `ui/dist`; they are skipped when it failed.
- **Windows**, what a Mac can check: the PowerShell scripts are ASCII; they parse, when `pwsh` is
  installed (`brew install powershell`); and Clippy for Windows, with `brew install mingw-w64` and
  `rustup target add x86_64-pc-windows-gnu`. That compiles everything Windows-only,
  `LoomWatch.exe`'s icon among it, but runs nothing: the **Windows** job is what runs it.
- **Container**: `docker build`, only when the branch changes what the Dockerfile builds from and
  Docker is running.

Dependency review reads GitHub's dependency graph, so it runs only on GitHub.

No check needs a database server: each database test makes a SQLite file of its own.

`scripts/test-update.sh` touches nothing outside its scratch folder: Docker, GitHub and the program
are stand-ins on its `PATH`. The stand-in program also plays the app's **Update and restart**: it
names a release and exits with 75, and the checks follow the launcher through the update and the
restart. It cannot prove the real program's `backup` and the restored file; for a change to how
`update` saves or `rollback` restores the run history, also try it on a release trial (step 3
below): stop the trial, run its `loomwatch update`, add a row to `_sqlx_migrations` in its
`.loomwatch/loomwatch.db` with a newer version (`sqlite3`), and run `loomwatch rollback`. For a
change to Update and restart, serve two releases and a stand-in for GitHub's answer
(`LOOMWATCH_UPDATE_URL`) and click it in the trial's page.

The Mac app's Update and restart (`crates/loomwatch-app/src/update.rs`) is tested with a local file
server and disk images built from stand-in bundles (`cargo test -p loomwatch-app`, on a Mac). For a
change to it, build `LoomWatch.app` twice with `scripts/package-macos-app.sh`, the second with a
higher `version` in both crates' `Cargo.toml`. Serve the newer one's `.dmg` and `.sha256`
(`LOOMWATCH_DOWNLOAD_BASE`) and a stand-in for GitHub's answer naming its tag
(`LOOMWATCH_UPDATE_URL`), copy the older app to a scratch folder (never `/Applications`), and open
it with `open -n --env LOOMWATCH_…=… <app> --args --background` for each of those two,
`LOOMWATCH_STATE_DIR`, `LOOMWATCH_TEAMS_ROOT`, `LOOMWATCH_BACKUP_DIR`, `LOOMWATCH_KEY_STORE=file`
and `LOOMWATCH_PORT`. The app hands every `LOOMWATCH_` setting on to the version it opens. The
**Windows** job's smoke test runs the same flow through the real installer.

## Making a release

The installer (`curl -fsSL https://loomwatch.github.io/install.sh | bash`) always downloads the
newest **published** release, so a release is drafted first and published only after its files
have been tried.

1. Set `version` in `crates/loomwatch-backend/Cargo.toml` (the app reports it in Send feedback),
   build once so `Cargo.lock` follows, and push that commit to `main`. Tag it once CI on `main`
   has passed on that commit.
2. Tag it and push the tag: `git tag v0.2.0 && git push origin v0.2.0`. The Release workflow
   checks the tag matches the version and drafts the release with `loomwatch-macos-universal.tar.gz`,
   `loomwatch-linux-x86_64.tar.gz`, `loomwatch-linux-arm64.tar.gz`, `loomwatch-windows-x86_64.zip`,
   `LoomWatch-macos.dmg`, `LoomWatch-windows-setup.exe` and a `.sha256` for each.
3. Try the draft with the real installer, apart from the LoomWatch installed on this computer:

   ```sh
   gh release download v0.2.0 -D /tmp/lw-release
   python3 -m http.server -d /tmp/lw-release 8765 &
   export LOOMWATCH_DOWNLOAD_BASE=http://127.0.0.1:8765 LOOMWATCH_APP_DIR=/tmp/lw-try/app \
     LOOMWATCH_TEAMS_ROOT=/tmp/lw-try/teams LOOMWATCH_PORT=3320 \
     LOOMWATCH_STATE_DIR=/tmp/lw-try/state LOOMWATCH_KEY_STORE=file
   bash scripts/install.sh
   ```

   Everything the trial keeps is in `/tmp/lw-try`, and the installed app's state folder and
   Keychain items are left as they were:

   - A copy installed anywhere but `~/LoomWatch/app` keeps its run history in its own folder
     (`/tmp/lw-try/app/.loomwatch/loomwatch.db`).
   - `LOOMWATCH_STATE_DIR` puts the rest of its state (approved team files, skills, what
     Connections shows) in `/tmp/lw-try/state` instead of `~/Library/Application Support/LoomWatch`.
   - `LOOMWATCH_KEY_STORE=file` keeps an OpenRouter key, a Claude key, a ChatGPT sign-in and
     connected tools' sign-ins, Notion's among them, in private files in that folder (`keys.json`,
     `plans.json`, `tool-credentials.json`). The Keychain items `LoomWatch.OpenRouter`,
     `LoomWatch.Plans`, `LoomWatch.Tools` and the old `LoomWatch.Notion` are never read or written,
     so the trial starts with nothing connected.

   The launcher passes both settings on to `loomwatchd`. Without them a trial reads and writes the
   installed app's state folder and Keychain items. They are exported so that starting the trial
   again from the same terminal (`/tmp/lw-try/app/loomwatch`) uses them too. Stop it with Ctrl-C,
   then stop the file server, remove the trial and clear its settings:

   ```sh
   kill %1
   rm -rf /tmp/lw-try /tmp/lw-release
   unset LOOMWATCH_DOWNLOAD_BASE LOOMWATCH_APP_DIR LOOMWATCH_TEAMS_ROOT LOOMWATCH_PORT \
     LOOMWATCH_STATE_DIR LOOMWATCH_KEY_STORE
   ```
4. Edit the notes, then publish: `gh release edit v0.2.0 --draft=false`. Write the notes for the
   people using LoomWatch: every copy on an older version shows them in its **Update available**
   dialog within a day (ADR 0052), as Markdown without images. Say when a release changes how the
   run history is stored, since going back from it means putting back the copy `update` saved.

## Repository settings (not in code)

These live in GitHub's settings and must be set by an admin:

| Setting | Recommended value | Why |
| --- | --- | --- |
| Ruleset "Protect main" (Rules → Rulesets) | To block a red pull request, add **Require status checks to pass** with the one check **CI / CI result** (source: GitHub Actions) | A pull request can't merge while its checks fail. Admins keep their bypass, so they can still push a release commit directly. Don't require the container or actionlint checks: they are path-filtered and would block every pull request they skip. |
| Fork pull request workflows (Actions → General) | Require approval for first-time contributors | A stranger's first pull request runs nothing until a maintainer has read it. |
| Workflow permissions (Actions → General) | Read repository contents; Actions may not approve pull requests | The default token is read-only; a workflow that needs more asks for it per job, as `release.yml` does. |
| Require actions to be pinned to a full-length commit SHA (Actions → General) | On | Every action is pinned already; this refuses a workflow that adds one by tag. |
| Dependency graph, Dependabot alerts and security updates | On | Dependency review reads the graph; alerts and fix pull requests cover Cargo and pnpm dependencies. |
| Actions budget (Billing) | Keep the $0 "stop usage" budget | Standard GitHub-hosted runners are free for a public repository, so checking every pull request and `main` costs nothing. The budget matters only if the repository goes private or a job asks for a larger runner; then jobs stop instead of billing. |

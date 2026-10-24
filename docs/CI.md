# Continuous integration

Every check runs on GitHub-hosted runners. CI's job is to prove that every pull request, before it
merges, and `main`, after it, builds, passes its tests on Linux and Windows and still produces a
container image. `scripts/ci-local.sh` runs most of it on your computer first, when you want a
quicker answer. Two workflows publish:
**Pages** puts the landing page and its guides on https://loomwatch.github.io, and **Release**
builds the Mac and Windows apps for a version tag.

## Workflows

| Workflow | Runs on | What it proves | Typical time |
| --- | --- | --- | --- |
| `ci.yml` — **Frontend**, then **Rust** | every pull request (`pull-requests.yml` calls it), every push to `main`, by hand | UI lint (warnings fail), typecheck, build and tests; then `cargo fmt`, Clippy (`-D warnings`) and the full test suite, each database test on a SQLite file of its own, building on the exact `ui/dist` the Frontend job produced | 2 + 5–8 min |
| `ci.yml` — **Windows** | the same, after Frontend | on a Windows runner: the PowerShell scripts parse and are ASCII, Clippy (`-D warnings`) and the full test suite; then the app's files are gathered (`scripts/package-release.sh`), `LoomWatch-windows-setup.exe` is built from them, and `scripts/smoke-windows.ps1` tries both: the program from those files driven through the offline demo's review stop, an agent on a stand-in for OpenRouter (`scripts/mock-openrouter.py`) keeping its key in Credential Manager and running a `cmd.exe` command in its own folder, `LoomWatch.exe` (one at a time, `--quit`), and the installer installing, updating over a running LoomWatch, and uninstalling | 20–30 min |
| `ci.yml` — **Launcher** | the same, beside Frontend | ShellCheck on the source launcher (`./loomwatch`), the packing scripts and `scripts/ci-local.sh` | < 1 min |
| `ci.yml` — **Dependency review** | the same, not by hand | comparing a pull request with its base, or `main` before and after a push: the change adds no dependency with a known vulnerability of moderate severity or worse (`Cargo.lock`, `ui/pnpm-lock.yaml`) | < 1 min |
| `ci.yml` — **CI result** | after the jobs above | every job above passed: the one answer to read for a run | seconds |
| `pull-requests.yml` | every pull request | runs `ci.yml`; a newer push to the pull request cancels the older run | seconds, then `ci.yml` |
| `container.yml` — **Build image** | a pull request or push to `main` that changes the Dockerfile or a lockfile/toolchain/manifest it builds from, monthly, by hand | `docker build` still succeeds; the image is never pushed | ~10–15 min (estimate) |
| `actionlint.yml` | a pull request or push to `main` that changes `.github/workflows/`, by hand | the workflow files themselves are valid | < 1 min |
| `pages.yml` — **Publish** | a change to `site/`, the README screenshots or fonts it borrows, by hand | builds the landing page with `site/build.sh` and pushes it to the `loomwatch/loomwatch.github.io` repository, which GitHub Pages serves | < 1 min |
| `release.yml` | a `v*` tag, by hand | builds the browser app once, then `loomwatchd`, the `osascript` stand-in and the app around them for macOS (universal programs, on macOS) and Windows x86_64, packs `LoomWatch-macos.dmg` (`scripts/package-macos-app.sh`) and `LoomWatch-windows-setup.exe` (Inno Setup, from Chocolatey, from the files `scripts/package-release.sh` gathers), and, for a tag, attaches them and a `.sha256` for each to a **draft** release. Run by hand, it only builds the files | ~15 min |

```
pull request / push to main
        │
        ▼
   Frontend ───ui/dist──▶ Rust (fmt → clippy → test) ──────────────────┐
                    └───▶ Windows (clippy → test → pack → smoke) ──────┤
   Launcher (shellcheck) ──────────────────────────────────────────────┼──▶ CI result
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

- **Launcher**: ShellCheck.
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

The source launcher (`./loomwatch`, and `loomwatch.cmd` on Windows) has no test beyond ShellCheck
and the PowerShell parse. Try a change to its `update` in a scratch clone of the repository, with
`LOOMWATCH_BACKUP_DIR` and `LOOMWATCH_STATE_DIR` in scratch folders.

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

The download buttons on the landing page and every app's **Update and restart** take the newest
**published** release, so a release is drafted first and published only after its files have been
tried.

1. Set `version` in `crates/loomwatch-backend/Cargo.toml` (the app reports it in Send feedback)
   and `crates/loomwatch-app/Cargo.toml`, build once so `Cargo.lock` follows, and push that commit
   to `main`. Tag it once CI on `main` has passed on that commit.
2. Tag it and push the tag: `git tag v0.2.0 && git push origin v0.2.0`. The Release workflow
   checks the tag matches the version and drafts the release with `LoomWatch-macos.dmg`,
   `LoomWatch-windows-setup.exe` and a `.sha256` for each.
3. Try the draft's Mac app, apart from the LoomWatch installed on this computer. From the
   checkout:

   ```sh
   mkdir -p /tmp/lw-release /tmp/lw-try/teams
   gh release download v0.2.0 -D /tmp/lw-release -p 'LoomWatch-macos.dmg*'
   (cd /tmp/lw-release && shasum -a 256 -c LoomWatch-macos.dmg.sha256)
   hdiutil attach -nobrowse -readonly -mountpoint /tmp/lw-release/disk /tmp/lw-release/LoomWatch-macos.dmg
   cp -R /tmp/lw-release/disk/LoomWatch.app /tmp/lw-try/
   hdiutil detach /tmp/lw-release/disk
   lipo -info /tmp/lw-try/LoomWatch.app/Contents/MacOS/loomwatchd
   cp examples/operator-stop.yaml /tmp/lw-try/teams/
   LOOMWATCH_STATE_DIR=/tmp/lw-try/state LOOMWATCH_KEY_STORE=file LOOMWATCH_UPDATE_CHECK=off \
     /tmp/lw-try/LoomWatch.app/Contents/MacOS/loomwatchd serve \
     --teams-root /tmp/lw-try/teams --listen 127.0.0.1:3320
   ```

   `lipo` names both `x86_64` and `arm64`, and http://127.0.0.1:3320/api/about the new version.
   Run the offline demo team in http://127.0.0.1:3320 and look for what the release changes.
   Everything the trial keeps is in `/tmp/lw-try`, and the installed app's state folder and
   Keychain items are left as they were:

   - `LOOMWATCH_STATE_DIR` puts the run history (`loomwatch.db`) and the rest of the state
     (approved team files, skills, what Connections shows) in `/tmp/lw-try/state` instead of
     `~/Library/Application Support/LoomWatch`.
   - `LOOMWATCH_KEY_STORE=file` keeps an OpenRouter key, a Claude key, a ChatGPT sign-in and
     connected tools' sign-ins, Notion's among them, in private files in that folder (`keys.json`,
     `plans.json`, `tool-credentials.json`). The Keychain items `LoomWatch.OpenRouter`,
     `LoomWatch.Plans`, `LoomWatch.Tools` and the old `LoomWatch.Notion` are never read or written,
     so the trial starts with nothing connected.
   - `LOOMWATCH_UPDATE_CHECK=off` keeps it from asking GitHub for a newer release.

   This runs the program inside the app without the app around it: the menu bar, the notch and
   Update and restart need the app itself, opened as the paragraph on the Mac app's Update and
   restart above says. The **Windows** job has already tried the Windows setup, built from the same
   commit. Stop the trial with Ctrl-C and remove it: `rm -rf /tmp/lw-try /tmp/lw-release`.
4. Edit the notes, then publish: `gh release edit v0.2.0 --draft=false`. Write the notes for the
   people using LoomWatch: every copy on an older version shows them in its **Update available**
   dialog within a day (ADR 0052), as Markdown without images. Say when a release changes how the
   run history is stored, since going back from it means putting back the copy Update and restart
   saved.

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

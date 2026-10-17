# Continuous integration

Every check runs on GitHub-hosted runners. CI's job is to prove that every pull request, before it
merges, and `main`, after it, builds, passes its tests and still produces a container image. Two
workflows publish: **Pages** puts the landing page and the installer on https://loomwatch.github.io,
and **Release** builds the ready-to-run program for a version tag.

## Workflows

| Workflow | Runs on | What it proves | Typical time |
| --- | --- | --- | --- |
| `ci.yml` — **Frontend**, then **Rust** | every pull request, push to `main`, by hand | UI lint (warnings fail), typecheck, build and tests; then `cargo fmt`, Clippy (`-D warnings`) and the full test suite, each database test on a SQLite file of its own, building on the exact `ui/dist` the Frontend job produced | 2 + 5–8 min |
| `ci.yml` — **Windows** | the same, after Frontend | on a Windows runner: the PowerShell scripts parse and are ASCII, Clippy (`-D warnings`) and the full test suite; then the release zip and `LoomWatch-windows-setup.exe` are packed and `scripts/smoke-windows.ps1` tries both: the PowerShell install driven through the offline demo's review stop, an agent on a stand-in for OpenRouter (`scripts/mock-openrouter.py`) keeping its key in Credential Manager and running a `cmd.exe` command in its own folder, `LoomWatch.exe` (one at a time, `--quit`), and the installer installing, updating over a running LoomWatch, and uninstalling | 20–30 min |
| `ci.yml` — **PostgreSQL import** | the same, after Frontend | `loomwatchd import-postgres` copies every table of the old PostgreSQL archive whole, against PostgreSQL 17.6 | 5–8 min |
| `ci.yml` — **Launcher** | the same, beside Frontend | ShellCheck on the launcher and installer, and `scripts/test-update.sh`: `update`, `rollback`, `version` and `import` on an installed copy, with stand-ins for Docker, GitHub and the program | < 1 min |
| `ci.yml` — **Dependency review** | every pull request | the change adds no dependency with a known vulnerability of moderate severity or worse (`Cargo.lock`, `ui/pnpm-lock.yaml`) | < 1 min |
| `ci.yml` — **CI result** | after the jobs above | every job above passed. This is the check the branch rule requires | seconds |
| `container.yml` — **Build image** | a pull request or push to `main` that changes the Dockerfile or a lockfile/toolchain/manifest it builds from, monthly, by hand | `docker build` still succeeds; the image is never pushed | ~10–15 min (estimate) |
| `actionlint.yml` | a pull request or push to `main` that changes `.github/workflows/`, by hand | the workflow files themselves are valid | < 1 min |
| `pages.yml` — **Publish** | a change to `site/`, `scripts/install.sh`, the README screenshots or fonts it borrows, by hand | builds the landing page with `site/build.sh` and pushes it to the `loomwatch/loomwatch.github.io` repository, which GitHub Pages serves | < 1 min |
| `release.yml` | a `v*` tag, by hand | builds the browser app once, then `loomwatchd` for macOS (one universal program, on macOS), Linux x86_64/arm64 (on Ubuntu 22.04) and Windows x86_64, packs each with `scripts/package-release.sh`, builds `LoomWatch-macos.dmg` and `LoomWatch-windows-setup.exe` (Inno Setup, from Chocolatey), and, for a tag, attaches them to a **draft** release. Run by hand, it only builds the files | ~15 min |

```
pull request / push to main
        │
        ▼
   Frontend ─┬─ui/dist──▶ Rust (fmt → clippy → test) ──────────────────┐
             └─ui/dist──▶ PostgreSQL import (Postgres service) ─────────┤
   Launcher (shellcheck → update/rollback test) ───────────────────────┼──▶ CI result
   Dependency review (pull requests only) ─────────────────────────────┘
```

## Conventions

- **One run per change.** CI runs for pull requests and for pushes to `main`, not for every push to
  every branch, so a commit is not built twice. A pull request is tested as GitHub would merge it
  into its base branch. A newer push to a pull request cancels the older run; runs on `main` are
  never cancelled, so every commit there keeps a result.
- **One required check.** The **CI result** job waits for every other CI job and passes only if they
  all did, so the branch rule names that one check and survives jobs being added or renamed. The
  path-filtered workflows (container, actionlint) are not required: on a pull request they skip,
  they never report, and a required check that never reports blocks the merge.
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

## Run the same checks locally

```sh
cd ui && pnpm install --frozen-lockfile && pnpm run lint --deny-warnings && pnpm run build && pnpm test && cd ..
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
LOOMWATCH_TEST_POSTGRES_URL=postgres://… cargo test --locked -p loomwatch-backend --lib import:: -- --include-ignored
shellcheck loomwatch scripts/install.sh scripts/package-release.sh scripts/test-update.sh
scripts/test-update.sh
```

On a Mac, the Windows build can be checked without Windows (`brew install mingw-w64`, then
`rustup target add x86_64-pc-windows-gnu`):

```sh
cargo clippy --workspace --all-targets --target x86_64-pc-windows-gnu -- -D warnings
```

It compiles everything Windows-only, `LoomWatch.exe`'s icon among it, but runs nothing; the
**Windows** job is what runs it. To run that job on a branch before opening a pull request:
`gh workflow run ci.yml --ref <branch>`.

The import tests create and drop a database of their own on the PostgreSQL you name; without
`LOOMWATCH_TEST_POSTGRES_URL` they are skipped. Nothing else needs a database server.

`scripts/test-update.sh` touches nothing outside its scratch folder: Docker, GitHub and the program
are stand-ins on its `PATH`. The stand-in program also plays the app's **Update and restart**: it
names a release and exits with 75, and the checks follow the launcher through the update and the
restart. It cannot prove the real program's `backup` and the restored file; for a change to how
`update` saves or `rollback` restores the run history, also try it on a release trial (step 3
below): stop the trial, run its `loomwatch update`, add a row to `_sqlx_migrations` in its
`.loomwatch/loomwatch.db` with a newer version (`sqlite3`), and run `loomwatch rollback`. For a
change to Update and restart, serve two releases and a stand-in for GitHub's answer
(`LOOMWATCH_UPDATE_URL`) and click it in the trial's page.

## Making a release

The installer (`curl -fsSL https://loomwatch.github.io/install.sh | bash`) always downloads the
newest **published** release, so a release is drafted first and published only after its files
have been tried.

1. Set `version` in `crates/loomwatch-backend/Cargo.toml` (the app reports it in Send feedback),
   build once so `Cargo.lock` follows, and push that commit to `main`.
2. Tag it and push the tag: `git tag v0.2.0 && git push origin v0.2.0`. The Release workflow
   checks the tag matches the version and drafts the release with `loomwatch-macos-universal.tar.gz`,
   `loomwatch-linux-x86_64.tar.gz`, `loomwatch-linux-arm64.tar.gz`, `loomwatch-windows-x86_64.zip`,
   `LoomWatch-macos.dmg`, `LoomWatch-windows-setup.exe` and a `.sha256` for each.
3. Try the draft with the real installer, in a folder of its own:

   ```sh
   gh release download v0.2.0 -D /tmp/lw-release
   python3 -m http.server -d /tmp/lw-release 8765 &
   LOOMWATCH_DOWNLOAD_BASE=http://127.0.0.1:8765 \
     LOOMWATCH_APP_DIR=/tmp/lw-try/app LOOMWATCH_TEAMS_ROOT=/tmp/lw-try/teams LOOMWATCH_PORT=3320 \
     bash scripts/install.sh
   ```

   A copy installed anywhere but `~/LoomWatch/app` keeps its run history in its own folder
   (`/tmp/lw-try/app/.loomwatch/loomwatch.db`), never the installed app's. Stop it with Ctrl-C and
   the file server with `kill %1`, then remove the trial: `rm -rf /tmp/lw-try /tmp/lw-release`.
4. Edit the notes, then publish: `gh release edit v0.2.0 --draft=false`. Write the notes for the
   people using LoomWatch: every copy on an older version shows them in its **Update available**
   dialog within a day (ADR 0052), as Markdown without images. Say when a release changes how the
   run history is stored, since going back from it means putting back the copy `update` saved.

## Repository settings (not in code)

These live in GitHub's settings and must be set by an admin:

| Setting | Recommended value | Why |
| --- | --- | --- |
| Ruleset "Protect main" (Rules → Rulesets) | Add **Require status checks to pass** with the one check **CI result** (source: GitHub Actions) | A pull request can't merge while its checks fail. Admins keep their bypass, so they can still push a release commit directly. Don't require the container or actionlint checks: they are path-filtered and would block every pull request they skip. |
| Fork pull request workflows (Actions → General) | Require approval for first-time contributors | A stranger's first pull request runs nothing until a maintainer has read it. |
| Workflow permissions (Actions → General) | Read repository contents; Actions may not approve pull requests | The default token is read-only; a workflow that needs more asks for it per job, as `release.yml` does. |
| Require actions to be pinned to a full-length commit SHA (Actions → General) | On | Every action is pinned already; this refuses a workflow that adds one by tag. |
| Dependency graph, Dependabot alerts and security updates | On | Dependency review reads the graph; alerts and fix pull requests cover Cargo and pnpm dependencies. |
| Actions budget (Billing) | Keep the $0 "stop usage" budget | Standard GitHub-hosted runners are free for a public repository, so checking every pull request costs nothing. The budget matters only if the repository goes private or a job asks for a larger runner; then jobs stop instead of billing. |

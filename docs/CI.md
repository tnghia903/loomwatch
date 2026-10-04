# Continuous integration

Every check runs on GitHub-hosted runners. CI's job is to prove that `main` builds, passes its tests
and still produces a container image. Two workflows publish: **Pages** puts the landing page and the
installer on https://loomwatch.github.io, and **Release** builds the ready-to-run program for a
version tag.

## Workflows

| Workflow | Runs on | What it proves | Typical time |
| --- | --- | --- | --- |
| `ci.yml` — **Frontend**, then **Rust** | push to `main`, every pull request, by hand | UI lint (warnings fail), typecheck, build and tests; then `cargo fmt`, Clippy (`-D warnings`) and the full test suite against PostgreSQL 17.6, building on the exact `ui/dist` the Frontend job produced | 2 + 5–8 min |
| `container.yml` — **Build image** | a change to the Dockerfile or a lockfile/toolchain/manifest it builds from, monthly, by hand | `docker build` still succeeds; the image is never pushed | ~10–15 min (estimate) |
| `actionlint.yml` | a change under `.github/workflows/` | the workflow files themselves are valid | < 1 min |
| `pages.yml` — **Publish** | a change to `site/`, `scripts/install.sh`, the README screenshots or fonts it borrows, by hand | builds the landing page with `site/build.sh` and pushes it to the `loomwatch/loomwatch.github.io` repository, which GitHub Pages serves | < 1 min |
| `release.yml` | a `v*` tag, by hand | builds the browser app once, then `loomwatchd` for macOS (one universal program, on macOS) and Linux x86_64/arm64 (on Ubuntu 22.04), packs each with `scripts/package-release.sh`, and, for a tag, attaches them to a **draft** release. Run by hand, it only builds the files | ~15 min |

```
pull request / push to main
        │
        ▼
   Frontend ──ui/dist──▶ Rust (fmt → clippy → test, Postgres service)
```

## Conventions

- **One run per change.** CI runs for pushes to `main` and for pull requests, not for every push to
  every branch, so a commit is not built twice. A newer push to a pull request cancels the older run;
  runs on `main` are never cancelled.
- **Pinned and least-privileged.** Actions are pinned to full commit SHAs (the version is in the
  trailing comment), the workflow token is read-only, and checkouts do not keep credentials.
  Dependabot (`.github/dependabot.yml`) proposes updates monthly, grouped.
- **Reproducible.** `pnpm install --frozen-lockfile` and `cargo … --locked` fail on a stale
  lockfile. Versions come from one place each: Node from `.node-version`, pnpm from
  `packageManager` in the root `package.json`, Rust from `rust-toolchain.toml`.
- **Cheap where it can be.** The pnpm store and Rust build are cached (only `main` writes the Rust
  cache), and the expensive container build is path-filtered. Each job has a timeout.
- **Never skip a test to get green.** A red check is fixed or explained, not muted.

## Run the same checks locally

```sh
cd ui && pnpm install --frozen-lockfile && pnpm run lint --deny-warnings && pnpm run build && pnpm test && cd ..
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
DATABASE_URL=postgres://… cargo test --workspace --locked
```

## Making a release

The installer (`curl -fsSL https://loomwatch.github.io/install.sh | bash`) always downloads the
newest **published** release, so a release is drafted first and published only after its files
have been tried.

1. Set `version` in `crates/loomwatch-backend/Cargo.toml` (the app reports it in Send feedback),
   build once so `Cargo.lock` follows, and push that commit to `main`.
2. Tag it and push the tag: `git tag v0.2.0 && git push origin v0.2.0`. The Release workflow
   checks the tag matches the version and drafts the release with `loomwatch-macos-universal.tar.gz`,
   `loomwatch-linux-x86_64.tar.gz`, `loomwatch-linux-arm64.tar.gz` and a `.sha256` for each.
3. Try the draft with the real installer, in a folder of its own:

   ```sh
   gh release download v0.2.0 -D /tmp/lw-release
   python3 -m http.server -d /tmp/lw-release 8765 &
   LOOMWATCH_DOWNLOAD_BASE=http://127.0.0.1:8765 LOOMWATCH_APP_DIR=/tmp/lw-try/app \
     LOOMWATCH_TEAMS_ROOT=/tmp/lw-try/teams LOOMWATCH_PORT=3320 bash scripts/install.sh
   ```

   Stop it with Ctrl-C, then remove its database with `cd /tmp/lw-try/app && docker compose down -v`.
4. Edit the notes, then publish: `gh release edit v0.2.0 --draft=false`.

## Repository settings (not in code)

These live in GitHub's settings and must be set by an admin:

| Setting | Recommended value | Why |
| --- | --- | --- |
| Branch rule for `main` | Require status checks **Frontend** and **Rust** to pass; optionally require a pull request | Keeps `main` green. Requiring a pull request also means changes reach `main` only through a reviewed, tested PR, which is the point of CI, but it stops direct pushes. |
| Dependabot alerts and security updates | On | Vulnerability alerts and fix PRs for Cargo and pnpm dependencies. |
| Actions budget (Billing) | Keep the $0 "stop usage" budget unless overage is intended | Private repositories have a monthly allowance of hosted-runner minutes; past it, jobs stop instead of billing. |

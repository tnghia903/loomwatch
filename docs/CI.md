# Continuous integration

Every check runs on GitHub-hosted Ubuntu runners. Nothing is deployed or published: LoomWatch is
built from source (see the README), so CI's job is to prove that `main` builds, passes its tests and
still produces a container image.

## Workflows

| Workflow | Runs on | What it proves | Typical time |
| --- | --- | --- | --- |
| `ci.yml` — **Frontend**, then **Rust** | push to `main`, every pull request, by hand | UI lint (warnings fail), typecheck, build and tests; then `cargo fmt`, Clippy (`-D warnings`) and the full test suite against PostgreSQL 17.6, building on the exact `ui/dist` the Frontend job produced | 2 + 5–8 min |
| `container.yml` — **Build image** | a change to the Dockerfile or a lockfile/toolchain/manifest it builds from, monthly, by hand | `docker build` still succeeds; the image is never pushed | ~10–15 min (estimate) |
| `actionlint.yml` | a change under `.github/workflows/` | the workflow files themselves are valid | < 1 min |

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

## Repository settings (not in code)

These live in GitHub's settings and must be set by an admin:

| Setting | Recommended value | Why |
| --- | --- | --- |
| Branch rule for `main` | Require status checks **Frontend** and **Rust** to pass; optionally require a pull request | Keeps `main` green. Requiring a pull request also means changes reach `main` only through a reviewed, tested PR, which is the point of CI, but it stops direct pushes. |
| Dependabot alerts and security updates | On | Vulnerability alerts and fix PRs for Cargo and pnpm dependencies. |
| Actions budget (Billing) | Keep the $0 "stop usage" budget unless overage is intended | Private repositories have a monthly allowance of hosted-runner minutes; past it, jobs stop instead of billing. |

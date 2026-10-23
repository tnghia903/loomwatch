#!/usr/bin/env bash
# CI's checks for a branch, run on this computer: a quicker check before pushing, when you want
# one. Every pull request runs the full CI on GitHub anyway (docs/CI.md). From anywhere in the
# checkout:
#
#   scripts/ci-local.sh
#
# Every check runs even when one before it failed, except those that build the daemon, which
# embeds the ui/dist the Frontend build makes. A check this computer can't run says why and is left
# to CI. Ends with a summary, and exits non-zero when any check failed.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1

results=()
failed=0

# check <name> <command...>: runs one check and records whether it passed.
check() {
  local name=$1
  shift
  printf '\n==> %s\n' "$name"
  if "$@"; then
    results+=("passed   $name")
  else
    results+=("FAILED   $name")
    failed=1
    return 1
  fi
}

# skip <name> <reason>: records a check this computer leaves to CI.
skip() {
  printf '\n==> %s: skipped, %s\n' "$1" "$2"
  results+=("skipped  $1: $2")
}

in_ui() { (cd ui && "$@"); }

# The files this branch changes from main, as last fetched, uncommitted changes included.
base=$(git merge-base origin/main HEAD 2>/dev/null || true)
changes() { [ -n "$base" ] && [ -n "$(git diff --name-only "$base" -- "$@")" ]; }

# Launcher job.
check "Launcher: ShellCheck" \
  shellcheck loomwatch scripts/package-release.sh scripts/package-macos-app.sh scripts/ci-local.sh

# Workflow lint.
if command -v actionlint >/dev/null; then
  check "Workflows: actionlint" actionlint
else
  skip "Workflows: actionlint" "actionlint is not installed (brew install actionlint)"
fi

# Frontend job.
ui_built=0
check "Frontend: install" in_ui pnpm install --frozen-lockfile --prefer-offline
check "Frontend: lint" in_ui pnpm run lint --deny-warnings
check "Frontend: build (includes typecheck)" in_ui pnpm run build && ui_built=1
check "Frontend: test" in_ui pnpm test

# Rust job.
check "Rust: format" cargo fmt --all -- --check
if [ "$ui_built" = 1 ]; then
  check "Rust: Clippy" cargo clippy --workspace --all-targets --locked -- -D warnings
  check "Rust: test" cargo test --workspace --locked
else
  skip "Rust: Clippy" "the Frontend build failed"
  skip "Rust: test" "the Frontend build failed"
fi

# Windows job: what a Mac can check of it. Windows PowerShell 5.1 reads a file without a
# byte-order mark in the local code page, so every script must be ASCII.
ps1_ascii() {
  perl -ne 'if (/[^\x00-\x7F]/) { print "$ARGV:$.: not ASCII\n"; $bad = 1 } close ARGV if eof;
    END { exit($bad ? 1 : 0) }' scripts/*.ps1
}
check "Windows: PowerShell scripts are ASCII" ps1_ascii

ps1_parse() {
  # shellcheck disable=SC2016 # PowerShell's own variables, not the shell's.
  pwsh -NoProfile -NonInteractive -Command '
    $failed = $false
    foreach ($file in Get-ChildItem -Path scripts -Filter *.ps1) {
      $errors = $null
      [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
      foreach ($e in $errors) { Write-Host "scripts/$($file.Name):$($e.Extent.StartLineNumber): $($e.Message)"; $failed = $true }
    }
    if ($failed) { exit 1 }'
}
if command -v pwsh >/dev/null; then
  check "Windows: PowerShell scripts parse" ps1_parse
else
  skip "Windows: PowerShell scripts parse" "pwsh is not installed (brew install powershell)"
fi

# Compiles everything Windows-only but runs none of it: the tests, the packed release and the
# installer run in CI's Windows job.
if ! rustup target list --installed 2>/dev/null | grep -qx x86_64-pc-windows-gnu \
  || ! command -v x86_64-w64-mingw32-gcc >/dev/null; then
  skip "Windows: Clippy" "needs brew install mingw-w64 and rustup target add x86_64-pc-windows-gnu"
elif [ "$ui_built" = 1 ]; then
  check "Windows: Clippy" \
    cargo clippy --workspace --all-targets --locked --target x86_64-pc-windows-gnu -- -D warnings
else
  skip "Windows: Clippy" "the Frontend build failed"
fi

# Container image, only when the branch changes what the Dockerfile builds from (the paths in
# .github/workflows/container.yml).
container_inputs=(Dockerfile .dockerignore Cargo.lock ':(glob)**/Cargo.toml' rust-toolchain.toml
  ui/package.json ui/pnpm-lock.yaml .github/workflows/container.yml)
if [ -z "$base" ]; then
  skip "Container: build" "no origin/main to compare the branch with"
elif ! changes "${container_inputs[@]}"; then
  skip "Container: build" "the branch doesn't change what the Dockerfile builds from"
elif ! docker info >/dev/null 2>&1; then
  skip "Container: build" "Docker is not running"
else
  check "Container: build" docker build --tag loomwatch:ci-local .
fi

printf '\n==> Summary\n'
printf '  %s\n' "${results[@]}"
printf '  CI on GitHub also runs these on Linux and Windows, and checks new dependencies for known\n'
printf '  vulnerabilities.\n'
if [ "$failed" = 1 ]; then
  printf '\nA check failed.\n'
  exit 1
fi
printf '\nEvery check that ran passed.\n'

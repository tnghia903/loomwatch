#!/usr/bin/env bash
# Build the UI + backend and run loomwatchd with local dev settings.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TEAMS_ROOT="${TEAMS_ROOT:-teams}"
# This checkout's own run history, apart from any installed LoomWatch's.
LOOMWATCH_DATABASE="${LOOMWATCH_DATABASE:-.loomwatch/loomwatch.db}"

(cd ui && pnpm install && pnpm build)
# loomwatch-osascript: agents' `osascript` on a Mac, found beside loomwatchd (ADR 0087).
cargo build --release -p loomwatch-backend -p loomwatch-osascript

exec ./target/release/loomwatchd serve \
  --teams-root "$TEAMS_ROOT" \
  --database "$LOOMWATCH_DATABASE"

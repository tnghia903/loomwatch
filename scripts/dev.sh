#!/usr/bin/env bash
# Build the UI + backend and run loomwatchd with local dev settings.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TEAMS_ROOT="${TEAMS_ROOT:-teams}"
DATABASE_URL="${DATABASE_URL:-postgres://loomwatch:local-test-only@127.0.0.1:5433/loomwatch}"

(cd ui && pnpm install && pnpm build)
cargo build --release -p loomwatch-backend

exec ./target/release/loomwatchd serve \
  --teams-root "$TEAMS_ROOT" \
  --database-url "$DATABASE_URL"

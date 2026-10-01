#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$repo_root"

if [ -f .env ]; then
  # This is the same operator-owned configuration Docker Compose reads.
  . ./.env
fi

if [ -z "${LOOMWATCH_HOST_RUNNER_TOKEN:-}" ]; then
  LOOMWATCH_HOST_RUNNER_TOKEN=${POSTGRES_PASSWORD:-}
fi
if [ "${#LOOMWATCH_HOST_RUNNER_TOKEN}" -lt 16 ]; then
  echo "Set LOOMWATCH_HOST_RUNNER_TOKEN in .env to a random value of at least 16 characters." >&2
  exit 2
fi
export LOOMWATCH_HOST_RUNNER_TOKEN

teams_dir=${LOOMWATCH_TEAMS_DIR:-./teams}
workspaces_dir=${LOOMWATCH_WORKSPACES_DIR:-./container/workspaces}
if [ ! -d "$teams_dir" ] || [ ! -d "$workspaces_dir" ]; then
  echo "The configured teams and workspaces directories must exist before starting the host runner." >&2
  exit 2
fi
teams_root=$(CDPATH= cd -- "$teams_dir" && pwd -P)
workspaces_root=$(CDPATH= cd -- "$workspaces_dir" && pwd -P)

exec cargo run --release --locked --bin loomwatchd -- host-runner \
  --listen "${LOOMWATCH_HOST_RUNNER_LISTEN:-0.0.0.0:3031}" \
  --map "/data/teams=$teams_root" \
  --map "/workspaces=$workspaces_root"

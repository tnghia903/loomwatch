# Container workspaces

This directory is mounted read-write at `/workspaces`. Put repositories used by container-native
harnesses here, or set `LOOMWATCH_WORKSPACES_DIR` in `.env` to an existing parent directory.

Team files should use container paths such as `/workspaces/my-project`, or paths relative to the team
file. Absolute macOS or Windows paths do not exist inside the Linux container.

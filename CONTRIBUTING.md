# Contributing to LoomWatch

Thanks for helping. LoomWatch is young and moves fast, so a short conversation first saves work:
for anything bigger than a small fix, open an [issue](https://github.com/tnghia903/loomwatch/issues)
or a [discussion](https://github.com/tnghia903/loomwatch/discussions) and describe what you want to
change and why.

## Reporting problems

- **Bugs and ideas:** use **Send feedback** in the app (☰ menu). It opens a GitHub issue form with
  your LoomWatch version, system, browser and whether an OpenRouter key is added filled in, never
  the key itself or your teams. You can also open the forms directly.
- **Security problems:** report them privately, as [SECURITY.md](SECURITY.md) describes, never in a
  public issue.

## Building from source

You need Node.js 22.12 or newer and Rust (the exact toolchain installs itself from
`rust-toolchain.toml`). The database is SQLite, built into the program, and agents run inside it,
so nothing else. Then:

```sh
git clone https://github.com/tnghia903/loomwatch.git
cd loomwatch
./loomwatch
```

On Windows, run `.\loomwatch.cmd` instead of `./loomwatch`; Rust's installer adds the Visual Studio
C++ build tools it needs.

`./loomwatch` builds the browser app and the program the first time and after every change to
them, starts it and opens the app. See [the README](README.md#build-from-source) for the
details and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit.

Real runs need an [OpenRouter](https://openrouter.ai) API key. To try a change without one, use a
team whose agents run on `model: fake/offline`, LoomWatch's built-in offline demo model, such as the
offline demo team ([examples/operator-stop.yaml](examples/operator-stop.yaml)) that `./loomwatch`
puts in a new teams folder. It calls no model and costs nothing
([docs/WATCH.md](docs/WATCH.md#verifying-without-a-model-provider)).

To try real runs end to end without spending, with tool calls, permission cards, the Team Bus and
costs, point LoomWatch at the stand-in for OpenRouter in
[scripts/mock-openrouter.py](scripts/mock-openrouter.py):

```sh
python3 scripts/mock-openrouter.py 4100 &
LOOMWATCH_OPENROUTER_URL=http://127.0.0.1:4100/api/v1 LOOMWATCH_KEY_STORE=file \
  LOOMWATCH_STATE_DIR=/tmp/lw-trial ./target/debug/loomwatchd serve --teams-root /tmp/lw-trial/teams
```

Add any key starting `sk-or-v1-mock`. `LOOMWATCH_OPENROUTER_URL` is taken only for an address on
this computer, so a key can never be sent anywhere else. The script's opening comment lists the
requests that make it run a command, write a file or hand out research.

## Before you open a pull request

CI runs on every pull request, and its **CI result** check says whether everything passed. If this
is your first pull request here, a maintainer approves the run before it starts. Run the same checks
yourself first, which is quicker than waiting for CI ([docs/CI.md](docs/CI.md)):

```sh
cd ui && pnpm install --frozen-lockfile && pnpm run lint --deny-warnings && pnpm run build && pnpm test && cd ..
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Every database test makes a SQLite file of its own. The tests of `loomwatchd import-postgres` also
need a PostgreSQL they may create a database on; they are skipped unless you name one:
`LOOMWATCH_TEST_POSTGRES_URL=postgres://… cargo test --locked -p loomwatch-backend --lib import:: -- --include-ignored`.

- Add a test that fails without your change.
- Paths, programs and processes behave differently on Windows: go through `src/platform.rs` (and
  `ui/src/lib/files/paths.ts` in the browser app) rather than `/`-only string handling, and expect
  the **Windows** CI job to run your change there. Test fixtures that are shell scripts use
  `test_support::SH` and `fake_program`, which run them with Git's `sh` on Windows.
- Keep user-facing text plain: short sentences, the words a person who has never used LoomWatch
  would use, and labels that match what the app shows.
- A change to how LoomWatch decides something (permissions, what an agent is given, where data
  goes) explains its reasons in the pull request description.

## License

By contributing, you agree that your contribution is licensed under the MIT License or the Apache
License 2.0, at the user's option, like the rest of LoomWatch, with no extra terms.

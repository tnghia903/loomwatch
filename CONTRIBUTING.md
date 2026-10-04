# Contributing to LoomWatch

Thanks for helping. LoomWatch is young and moves fast, so a short conversation first saves work:
for anything bigger than a small fix, open an [issue](https://github.com/tnghia903/loomwatch/issues)
or a [discussion](https://github.com/tnghia903/loomwatch/discussions) and describe what you want to
change and why.

## Reporting problems

- **Bugs and ideas:** use **Send feedback** in the app (☰ menu). It opens a GitHub issue form with
  your LoomWatch version, system and AI apps filled in. You can also open the forms directly.
- **Security problems:** report them privately, as [SECURITY.md](SECURITY.md) describes, never in a
  public issue.

## Building from source

You need Docker (for PostgreSQL), Node.js 22.12 or newer and Rust (the exact toolchain installs
itself from `rust-toolchain.toml`). Then:

```sh
git clone https://github.com/tnghia903/loomwatch.git
cd loomwatch
./loomwatch
```

`./loomwatch` builds the browser app and the program the first time and after every change to
them, starts the database and opens the app. See [the README](README.md#build-from-source) for the
details and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit.

## Before you open a pull request

Run the same checks CI runs ([docs/CI.md](docs/CI.md)):

```sh
cd ui && pnpm install --frozen-lockfile && pnpm run lint --deny-warnings && pnpm run build && pnpm test && cd ..
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
DATABASE_URL=postgres://… cargo test --workspace --locked
```

- Add a test that fails without your change.
- Keep user-facing text plain: short sentences, the words a person who has never used LoomWatch
  would use, and labels that match what the app shows.
- A change to how LoomWatch decides something (permissions, what an agent is given, where data
  goes) explains its reasons in the pull request description.

## License

By contributing, you agree that your contribution is licensed under the MIT License or the Apache
License 2.0, at the user's option, like the rest of LoomWatch, with no extra terms.

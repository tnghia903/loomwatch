FROM node:24-bookworm-slim AS ui-builder

WORKDIR /source/ui
RUN corepack enable
COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY ui/ ./
RUN pnpm run build

FROM rust:1.98-bookworm AS backend-builder

WORKDIR /source
COPY Cargo.toml Cargo.lock rust-toolchain.toml rustfmt.toml ./
COPY crates/ ./crates/
COPY migrations/ ./migrations/
COPY schemas/ ./schemas/
COPY --from=ui-builder /source/ui/dist ./ui/dist/
RUN cargo build --release --locked --bin loomwatchd

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=backend-builder /source/target/release/loomwatchd /usr/local/bin/loomwatchd

RUN mkdir -p /data/teams /workspaces /opt/loomwatch/capabilities \
    && chown -R node:node /data /workspaces /home/node

USER node
WORKDIR /workspaces
ENV HOME=/home/node
ENV PATH=/home/node/.local/bin:$PATH

EXPOSE 3000
ENTRYPOINT ["loomwatchd"]
CMD ["serve", "--teams-root", "/data/teams", "--listen", "0.0.0.0:3000", "--allow-container-listener"]

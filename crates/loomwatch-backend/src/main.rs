//! `LoomWatch` Phase-02 command-line backend.

#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use loomwatch_backend::archive::EventArchive;
use loomwatch_backend::runs::RunRegistry;

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Serve the embedded web UI.
    Serve {
        #[arg(long, default_value = "127.0.0.1:3000")]
        listen: SocketAddr,
        /// Required for non-loopback listeners. Browser login uses user `loomwatch` and this token.
        #[arg(long, env = "LOOMWATCH_SERVER_TOKEN", hide_env_values = true)]
        server_token: Option<String>,
        /// Enable local archive watching using this PostgreSQL database.
        #[arg(long, env = "DATABASE_URL")]
        database_url: Option<String>,
        /// Directory containing team YAML files accessible through the web UI.
        #[arg(long, default_value = ".")]
        teams_root: PathBuf,
        /// Additional hostname accepted by the HTTP API (repeatable).
        #[arg(long = "allow-host", value_name = "HOSTNAME")]
        allowed_hosts: Vec<String>,
        /// Trust a container runtime to publish this listener only on the host's loopback
        /// interface. Never use this with a publicly published port.
        #[arg(
            long,
            env = "LOOMWATCH_ALLOW_CONTAINER_LISTENER",
            default_value_t = false
        )]
        allow_container_listener: bool,
    },
    /// Run one turn through the configured entrypoint ACP harness.
    Run {
        #[arg(long)]
        team: PathBuf,
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
        #[arg(long)]
        prompt: String,
        #[arg(long, default_value_t = 10)]
        exit_timeout_seconds: u64,
    },
    /// Recover one archived session as ordered JSON lines.
    Show {
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
        #[arg(long)]
        session: String,
    },
    /// Expose this machine's native ACP harnesses to an authenticated `LoomWatch` container.
    HostRunner {
        #[arg(long, default_value = "0.0.0.0:3031")]
        listen: SocketAddr,
        #[arg(long, env = "LOOMWATCH_HOST_RUNNER_TOKEN", hide_env_values = true)]
        token: String,
        /// Translate one container working-directory root to its host bind-mount source.
        #[arg(long = "map", value_name = "CONTAINER=HOST", required = true)]
        mappings: Vec<String>,
    },
    /// Internal stdio proxy used by agents selected from a configured host runner.
    #[command(hide = true)]
    HarnessClient {
        #[arg(long)]
        harness: String,
    },
    /// Serve the `LoomWatch` Control tools over stdio, for an AI app connected from the
    /// Connections page. Reads its token from `LOOMWATCH_CONTROL_TOKEN`.
    Mcp {
        /// The daemon's tool server, e.g. `http://127.0.0.1:3000/api/control/mcp`.
        #[arg(long, default_value = "http://127.0.0.1:3000/api/control/mcp")]
        url: String,
    },
}

/// A durable registry when there is an archive to be durable in, with its cache already filled
/// from the `runs` table.
///
/// Without an archive the daemon has no evidence store either, so an in-memory registry is the
/// honest shape rather than a degraded one. A recovery that fails warns and continues: the daemon
/// starting is worth more than its history list being complete, and the failure must not be
/// silent.
async fn recovered_registry(archive: Option<&EventArchive>) -> RunRegistry {
    let registry = match archive {
        Some(archive) => RunRegistry::durable(archive.run_store()),
        None => RunRegistry::default(),
    };
    match registry.reload().await {
        Ok(0) => {}
        Ok(recovered) => println!("recovered {recovered} run records"),
        Err(error) => eprintln!("warning: could not recover run records: {error}"),
    }
    registry
}

#[tokio::main]
#[allow(clippy::too_many_lines)]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Commands::Serve {
            listen,
            server_token,
            teams_root,
            database_url,
            mut allowed_hosts,
            allow_container_listener,
        } => {
            let access = if listen.ip().is_loopback() {
                server_token
                    .as_deref()
                    .map(loomwatch_backend::server_security::Access::new)
                    .transpose()?
            } else {
                Some(loomwatch_backend::server_security::Access::new(
                    server_token.as_deref().context(
                        "non-loopback serving requires LOOMWATCH_SERVER_TOKEN or --server-token",
                    )?,
                )?)
            };
            allowed_hosts.extend([
                "localhost".to_owned(),
                "127.0.0.1".to_owned(),
                "::1".to_owned(),
                listen.ip().to_string(),
            ]);
            anyhow::ensure!(
                database_url.is_none() || listen.ip().is_loopback() || allow_container_listener,
                "archive watching exposes exact execution evidence and requires a loopback listener (or --allow-container-listener behind a loopback-only published port)"
            );
            let archive = match database_url {
                Some(url) => Some(EventArchive::connect(&url).await?),
                None => None,
            };
            // One canonical root for both the team editor and run control, so a team the
            // editor can open is exactly a team a run may start, and vice versa.
            let teams_root = std::fs::canonicalize(&teams_root).with_context(|| {
                format!("failed to resolve teams root {}", teams_root.display())
            })?;
            let listener = tokio::net::TcpListener::bind(listen).await?;
            let address = listener.local_addr()?;
            println!("loomwatchd listening on http://{address}");
            let registry = recovered_registry(archive.as_ref()).await;
            // The archive is handed to the REST router for exactly one reason: the capability
            // inventory's kept-note counts are rows, not files. Everything else it serves is disk.
            // The registry is the run-control router's own, so deleting a team sees every run.
            let api = loomwatch_backend::api::router_with_archive(
                teams_root.clone(),
                allowed_hosts,
                archive.clone(),
                registry.clone(),
            )?;
            let runs = loomwatch_backend::runs::router(
                archive.clone(),
                teams_root.clone(),
                registry.clone(),
            );
            // The Notebook's own router: loopback-only, and it reads the same canonical root.
            let notebook =
                loomwatch_backend::notebook_api::router(archive.clone(), teams_root.clone());
            // Routines fire through the same registry so the UI sees them as ordinary runs.
            let scheduler = loomwatch_backend::schedule::spawn(
                registry.clone(),
                archive.clone(),
                teams_root.clone(),
            )?;
            let routines = loomwatch_backend::schedule::router(
                scheduler,
                registry.clone(),
                archive.clone(),
                teams_root.clone(),
            );
            // Ask LoomWatch (ADR 0033): the tool server and the Ask panel's endpoints. It shares the
            // registry so a run it starts is an ordinary run, and the listener so its URL is the
            // daemon's own.
            let control = loomwatch_backend::control::Control::new(
                loomwatch_backend::control::ControlOptions {
                    archive: archive.clone(),
                    teams_root: teams_root.clone(),
                    registry: registry.clone(),
                    listen: address,
                    ask_command: std::env::var("LOOMWATCH_ASK_COMMAND")
                        .ok()
                        .map(|command| command.split_whitespace().map(str::to_owned).collect()),
                },
            );
            let mut app = loomwatch_backend::spa::router()
                .merge(control.router())
                .merge(api)
                .merge(loomwatch_backend::watch_api::router(archive))
                .merge(runs)
                .merge(notebook)
                .merge(routines);
            if listen.ip().is_loopback() || allow_container_listener {
                app = app.merge(loomwatch_backend::notion::router()?);
            }
            if let Some(access) = access {
                app = app.layer(axum::middleware::from_fn_with_state(
                    access,
                    loomwatch_backend::server_security::authenticate,
                ));
            }
            axum::serve(listener, app).await?;
        }
        Commands::Run {
            team,
            database_url,
            prompt,
            exit_timeout_seconds,
        } => {
            let outcome = loomwatch_backend::run_team_session(
                &team,
                &database_url,
                &prompt,
                Duration::from_secs(exit_timeout_seconds),
            )
            .await?;
            println!(
                "session={} events={} exit_code={}",
                outcome.session_id, outcome.event_count, outcome.exit_code
            );
        }
        Commands::Show {
            database_url,
            session,
        } => {
            let archive = EventArchive::connect(&database_url).await?;
            for event in archive.verify_session(&session).await? {
                println!("{}", serde_json::to_string(&event)?);
            }
        }
        Commands::HostRunner {
            listen,
            token,
            mappings,
        } => {
            let mappings = mappings
                .iter()
                .map(|value| loomwatch_backend::host_runner::PathMapping::parse(value))
                .collect::<Result<Vec<_>>>()?;
            loomwatch_backend::host_runner::serve(listen, token, mappings).await?;
        }
        Commands::HarnessClient { harness } => {
            let code = loomwatch_backend::host_runner::client(harness).await?;
            std::process::exit(code);
        }
        Commands::Mcp { url } => loomwatch_backend::control::bridge(&url).await?,
    }
    Ok(())
}

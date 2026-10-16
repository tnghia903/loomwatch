//! `LoomWatch` Phase-02 command-line backend.

#![forbid(unsafe_code)]

use std::future::IntoFuture;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use loomwatch_backend::archive::EventArchive;
use loomwatch_backend::runs::RunRegistry;

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

/// Where the run archive is: one SQLite file.
#[derive(Debug, Args)]
struct DatabaseArgs {
    /// The database file `LoomWatch` keeps its run history in. Defaults to `loomwatch.db` in the
    /// state folder.
    #[arg(long, env = "LOOMWATCH_DATABASE", value_name = "PATH")]
    database: Option<PathBuf>,
    /// Where `LoomWatch` keeps its own state, such as which team files you approved to run.
    /// Defaults to `~/Library/Application Support/LoomWatch` on macOS and
    /// `$XDG_STATE_HOME/loomwatch` (or `~/.local/state/loomwatch`) elsewhere.
    #[arg(long, env = "LOOMWATCH_STATE_DIR")]
    state_dir: Option<PathBuf>,
}

impl DatabaseArgs {
    fn state_dir(&self) -> Result<PathBuf> {
        self.state_dir.clone().or_else(default_state_dir).context(
            "set LOOMWATCH_STATE_DIR: there is no home folder to keep LoomWatch's state in",
        )
    }

    fn database(&self) -> Result<PathBuf> {
        match &self.database {
            Some(path) => Ok(path.clone()),
            None => Ok(loomwatch_backend::db::default_path(&self.state_dir()?)),
        }
    }
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Serve the embedded web UI.
    Serve {
        #[arg(long, default_value = "127.0.0.1:3000")]
        listen: SocketAddr,
        #[command(flatten)]
        database: DatabaseArgs,
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
        #[command(flatten)]
        database: DatabaseArgs,
        #[arg(long)]
        prompt: String,
        #[arg(long, default_value_t = 10)]
        exit_timeout_seconds: u64,
    },
    /// Recover one archived session as ordered JSON lines.
    Show {
        #[command(flatten)]
        database: DatabaseArgs,
        #[arg(long)]
        session: String,
    },
    /// Write a consistent copy of the run history to a new file. Safe while `LoomWatch` runs.
    Backup {
        #[command(flatten)]
        database: DatabaseArgs,
        /// The copy to write. It must not exist yet.
        dest: PathBuf,
    },
    /// Copy the run history an earlier `LoomWatch` kept in PostgreSQL into the database file.
    ///
    /// Safe to run again: rows already in the file are left as they are and counted as skipped.
    /// Nothing in PostgreSQL is changed.
    ImportPostgres {
        #[command(flatten)]
        database: DatabaseArgs,
        /// The PostgreSQL database, as `postgres://user:password@host:port/name`.
        #[arg(long, env = "LOOMWATCH_IMPORT_FROM", hide_env_values = true)]
        from: String,
    },
    /// Print the database file this `LoomWatch` uses.
    #[command(hide = true)]
    DatabasePath {
        #[command(flatten)]
        database: DatabaseArgs,
    },
    /// Print the newest table layout the database was brought up to, or nothing when there is no
    /// database yet. Changes nothing.
    #[command(hide = true)]
    DatabaseLayout {
        #[command(flatten)]
        database: DatabaseArgs,
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

/// A durable registry with its cache already filled from the `runs` table.
///
/// A recovery that fails warns and continues: the daemon starting is worth more than its history
/// list being complete, and the failure must not be silent.
async fn recovered_registry(archive: &EventArchive) -> RunRegistry {
    let registry = RunRegistry::durable(archive.run_store());
    match registry.reload().await {
        Ok(0) => {}
        Ok(recovered) => println!("recovered {recovered} run records"),
        Err(error) => eprintln!("warning: could not recover run records: {error}"),
    }
    registry
}

/// Started by `LoomWatch.app` (`LOOMWATCH_EXIT_WITH_PARENT=1`): stop when the app is gone, so a
/// force-quit app never leaves `LoomWatch` running where nobody can see or stop it. An orphaned
/// process is adopted by launchd (or init), whose pid is 1. As on a signal, the archive writes
/// what it holds first.
fn exit_with_parent(archive: EventArchive) {
    #[cfg(unix)]
    if std::env::var_os("LOOMWATCH_EXIT_WITH_PARENT").is_some_and(|value| value == "1") {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if std::os::unix::process::parent_id() == 1 {
                    eprintln!("LoomWatch.app is gone, so loomwatchd is stopping too");
                    let _ = tokio::time::timeout(Duration::from_secs(5), archive.flush()).await;
                    std::process::exit(0);
                }
            }
        });
    }
    #[cfg(not(unix))]
    let _ = archive;
}

/// `~/Library/Application Support/LoomWatch` on macOS, `$XDG_STATE_HOME/loomwatch` or
/// `~/.local/state/loomwatch` elsewhere.
fn default_state_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())?;
    if cfg!(target_os = "macos") {
        return Some(home.join("Library/Application Support/LoomWatch"));
    }
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|state| state.is_absolute())
        .unwrap_or_else(|| home.join(".local/state"));
    Some(state.join("loomwatch"))
}

/// Exit on Ctrl-C or a termination request, after the archive has written what it holds.
///
/// Without this the signal ends the process at once, as it always did; the difference now is that
/// run events are written in batches, so the last fraction of a second would be lost with it.
async fn flush_then_exit_on_signal(archive: EventArchive) {
    let code = stop_signal().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), archive.flush()).await;
    std::process::exit(code);
}

/// The exit status a shell reports for the signal that arrived: 128 plus its number.
#[cfg(unix)]
async fn stop_signal() -> i32 {
    use tokio::signal::unix::{SignalKind, signal};
    let Ok(mut terminate) = signal(SignalKind::terminate()) else {
        let _ = tokio::signal::ctrl_c().await;
        return 130;
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => 130,
        _ = terminate.recv() => 143,
    }
}

#[cfg(not(unix))]
async fn stop_signal() -> i32 {
    let _ = tokio::signal::ctrl_c().await;
    130
}

#[tokio::main]
#[allow(clippy::too_many_lines)]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Commands::Serve {
            listen,
            teams_root,
            database,
            mut allowed_hosts,
            allow_container_listener,
        } => {
            // Fixed now, so `/api/about` tells this start from the next one (ADR 0052).
            let _ = loomwatch_backend::updates::started_at();
            if !listen.ip().is_loopback() {
                eprintln!(
                    "warning: serving on non-loopback address {}; use --allow-host for each trusted hostname",
                    listen.ip()
                );
            }
            allowed_hosts.extend([
                "localhost".to_owned(),
                "127.0.0.1".to_owned(),
                "::1".to_owned(),
                listen.ip().to_string(),
            ]);
            anyhow::ensure!(
                listen.ip().is_loopback() || allow_container_listener,
                "the run archive exposes exact execution evidence and requires a loopback listener (or --allow-container-listener behind a loopback-only published port)"
            );
            let state_dir = database.state_dir()?;
            let database = database.database()?;
            // Held until the process ends: one LoomWatch per run history file.
            let _claim = loomwatch_backend::db::claim(&database)?;
            let opened = EventArchive::open(&database).await?;
            println!("run history: {}", database.display());
            // Every router takes an optional archive, which tests leave out. The daemon always
            // has one.
            let archive = Some(opened.clone());
            // One canonical root for both the team editor and run control, so a team the
            // editor can open is exactly a team a run may start, and vice versa.
            let teams_root = std::fs::canonicalize(&teams_root).with_context(|| {
                format!("failed to resolve teams root {}", teams_root.display())
            })?;
            // Which team files may run (ADR 0048), kept outside the teams folder. Opened before
            // anything can start a run, and the first time, it approves the teams already there.
            // Claude's and Codex's bridges, installed once and started directly instead of
            // through npx; installing the ones this computer's apps need starts now, in the
            // background.
            loomwatch_backend::connectors::init(&state_dir).prepare_detected();
            let approvals =
                loomwatch_backend::approvals::TeamApprovals::open(&state_dir, &teams_root)
                    .with_context(|| {
                        format!(
                            "failed to open LoomWatch's state in {}",
                            state_dir.display()
                        )
                    })?;
            let listener = tokio::net::TcpListener::bind(listen).await?;
            let address = listener.local_addr()?;
            println!("loomwatchd listening on http://{address}");
            let registry = recovered_registry(&opened).await;
            // Ctrl-C (and the launcher's stop) ends the daemon. The archive's writer may still
            // hold the last fraction of a second of events; they are written before it exits.
            tokio::spawn(flush_then_exit_on_signal(opened.clone()));
            exit_with_parent(opened.clone());
            registry.set_approvals(std::sync::Arc::new(approvals));
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
            // ADR 0051: each team's chat, on the same registry, so a message that starts work
            // starts an ordinary run.
            let chat = loomwatch_backend::chat::router(
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
            // ADR 0052: says when a newer LoomWatch is out and how to install it. The check runs
            // once a day in the background. Installing is the launcher's: in its terminal, or when
            // "Update and restart" has this daemon exit for it.
            let updates = loomwatch_backend::updates::Updates::from_env(&state_dir);
            updates.spawn_checks();
            let updates_api = loomwatch_backend::updates::router(
                updates.clone(),
                registry.clone(),
                archive.clone(),
            );
            let mut app = loomwatch_backend::spa::router()
                .merge(control.router())
                .merge(api)
                .merge(loomwatch_backend::watch_api::router(archive))
                .merge(runs)
                .merge(chat)
                .merge(notebook)
                .merge(routines)
                .merge(updates_api)
                .merge(loomwatch_backend::wardrobe::router(
                    loomwatch_backend::wardrobe::Wardrobe::open(&state_dir),
                ));
            if listen.ip().is_loopback() || allow_container_listener {
                app = app.merge(loomwatch_backend::notion::router(&state_dir)?);
            }
            // After "Update and restart": stop taking requests, give the open ones a moment (the
            // app's live streams never end by themselves), then exit with the status that has the
            // launcher install the release and start LoomWatch again.
            let stopping = updates.clone();
            let serving = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    stopping.restart_requested().await;
                })
                .into_future();
            let served = tokio::select! {
                outcome = serving => outcome,
                () = async {
                    updates.restart_requested().await;
                    tokio::time::sleep(loomwatch_backend::updates::STOP_GRACE).await;
                } => Ok(()),
            };
            opened.flush().await;
            served?;
            if updates.restarting() {
                std::process::exit(loomwatch_backend::updates::EXIT_TO_UPDATE);
            }
        }
        Commands::Run {
            team,
            database,
            prompt,
            exit_timeout_seconds,
        } => {
            let outcome = loomwatch_backend::run_team_session(
                &team,
                &database.database()?,
                &prompt,
                Duration::from_secs(exit_timeout_seconds),
            )
            .await?;
            println!(
                "session={} events={} exit_code={}",
                outcome.session_id, outcome.event_count, outcome.exit_code
            );
        }
        Commands::Show { database, session } => {
            let archive = EventArchive::open(&database.database()?).await?;
            for event in archive.load_verified_session(&session).await? {
                println!("{}", serde_json::to_string(&event)?);
            }
        }
        Commands::Backup { database, dest } => {
            let source = database.database()?;
            loomwatch_backend::db::backup(&source, &dest).await?;
            println!("Saved a copy of {} in {}", source.display(), dest.display());
        }
        Commands::ImportPostgres { database, from } => {
            let database = database.database()?;
            // The import writes the whole history in one transaction; a LoomWatch using the file
            // meanwhile would wait on it.
            let _claim = loomwatch_backend::db::claim(&database)?;
            let report = loomwatch_backend::import::import_postgres(&from, &database).await?;
            println!("{report}");
        }
        Commands::DatabasePath { database } => {
            println!("{}", database.database()?.display());
        }
        Commands::DatabaseLayout { database } => {
            if let Some(layout) = loomwatch_backend::db::layout(&database.database()?).await? {
                println!("{layout}");
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

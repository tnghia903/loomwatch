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
    /// A folder of `<id>.md` files, each in place of the fixed text agents are given under that
    /// id, for `serve` and `run` (`--dump-prompt-blocks` writes them all). For the quality bench:
    /// only a build with the `prompt-overrides` feature has this.
    #[cfg(feature = "prompt-overrides")]
    #[arg(
        long,
        env = "LOOMWATCH_PROMPT_OVERRIDES",
        global = true,
        value_name = "DIR"
    )]
    prompt_overrides: Option<PathBuf>,
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
    /// Defaults to `~/Library/Application Support/LoomWatch` on macOS,
    /// `%LOCALAPPDATA%\LoomWatch` on Windows, and `$XDG_STATE_HOME/loomwatch` (or
    /// `~/.local/state/loomwatch`) elsewhere.
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
    /// Run one turn of a team's entrypoint agent.
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
    /// Read one document or picture and print it as JSON. `LoomWatch` reads each file an agent
    /// opens this way, in a process of its own, so a damaged file costs nothing else.
    #[command(hide = true)]
    ReadDocument { path: PathBuf },
    /// Write every fixed text agents are given, as `--prompt-overrides` leaves it, to
    /// `<DIR>/<id>.md`, and list the ids with the placeholders each one fills. For the quality
    /// bench: only a build with the `prompt-overrides` feature has this.
    #[cfg(feature = "prompt-overrides")]
    #[command(long_flag = "dump-prompt-blocks")]
    DumpPromptBlocks { dir: PathBuf },
}

/// A durable registry with its cache already filled from the `runs` table, and every run the last
/// process left unfinished settled.
///
/// A recovery that fails warns and continues: the daemon starting is worth more than its history
/// list being complete, and the failure must not be silent.
async fn recovered_registry(archive: &EventArchive) -> RunRegistry {
    let registry = RunRegistry::durable(archive.run_store());
    match registry.recover(archive).await {
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
///
/// On Windows, which has neither, `LoomWatch.exe` holds the other end of this process's standard
/// input: it closes when the app quits (its way of asking this to stop, as a signal does on a Mac)
/// or ends any other way.
fn exit_with_parent(archive: EventArchive) {
    #[cfg(windows)]
    if std::env::var_os("LOOMWATCH_EXIT_WITH_PARENT").is_some_and(|value| value == "1") {
        let (gone, app_gone) = tokio::sync::oneshot::channel::<()>();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdin = std::io::stdin();
            let mut buffer = [0_u8; 256];
            while matches!(stdin.read(&mut buffer), Ok(read) if read > 0) {}
            let _ = gone.send(());
        });
        tokio::spawn(async move {
            if app_gone.await.is_ok() {
                eprintln!("LoomWatch quit, so loomwatchd is stopping too");
                let _ = tokio::time::timeout(Duration::from_secs(5), archive.flush()).await;
                std::process::exit(0);
            }
        });
        return;
    }
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
    drop(archive);
}

/// `~/Library/Application Support/LoomWatch` on macOS, `%LOCALAPPDATA%\LoomWatch` on Windows,
/// `$XDG_STATE_HOME/loomwatch` or `~/.local/state/loomwatch` elsewhere.
fn default_state_dir() -> Option<PathBuf> {
    if cfg!(windows)
        && let Some(local) = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|local| local.is_absolute())
    {
        return Some(local.join("LoomWatch"));
    }
    let home = loomwatch_backend::platform::home_dir().filter(|home| home.is_absolute())?;
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

/// Ctrl+C or Ctrl+Break, or the console window closing, or Windows signing out or shutting down.
/// After the last three Windows ends the process a few seconds later anyway, which is enough for
/// the archive's last batch.
#[cfg(windows)]
async fn stop_signal() -> i32 {
    use tokio::signal::windows::{ctrl_break, ctrl_close, ctrl_logoff, ctrl_shutdown};
    let (Ok(mut close), Ok(mut brk), Ok(mut logoff), Ok(mut shutdown)) =
        (ctrl_close(), ctrl_break(), ctrl_logoff(), ctrl_shutdown())
    else {
        let _ = tokio::signal::ctrl_c().await;
        return 130;
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => 130,
        _ = brk.recv() => 130,
        _ = close.recv() => 143,
        _ = logoff.recv() => 143,
        _ = shutdown.recv() => 143,
    }
}

#[cfg(not(any(unix, windows)))]
async fn stop_signal() -> i32 {
    let _ = tokio::signal::ctrl_c().await;
    130
}

#[tokio::main]
#[allow(clippy::too_many_lines)]
async fn main() -> Result<()> {
    // Files agents open are read by a copy of this program (`read-document`).
    if let Ok(program) = std::env::current_exe() {
        loomwatch_backend::documents::use_helper(program);
    }
    let cli = Cli::parse();
    // Before anything gives an agent a prompt. A folder that holds anything but known blocks stops
    // the start here.
    #[cfg(feature = "prompt-overrides")]
    if let Some(dir) = &cli.prompt_overrides
        && matches!(
            cli.command,
            Commands::Serve { .. } | Commands::Run { .. } | Commands::DumpPromptBlocks { .. }
        )
    {
        let replaced = loomwatch_backend::prompt_blocks::install(dir)?;
        eprintln!(
            "prompt overrides: {replaced} block(s) replaced from {}",
            dir.display()
        );
    }
    match cli.command {
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
            // Slides and Word documents the reader shows as their pages are kept here (ADR 0091).
            loomwatch_backend::office::install(&state_dir);
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
            let teams_root =
                loomwatch_backend::platform::canonicalize(&teams_root).with_context(|| {
                    format!("failed to resolve teams root {}", teams_root.display())
                })?;
            // The OpenRouter key and model list every run's agents use. Installed before anything
            // can start a run. Nothing is read or fetched here: the key is read when the first
            // agent starts, and the model list when it is first asked for.
            let ai = loomwatch_backend::ai::Ai::new(&state_dir);
            loomwatch_backend::ai::install(ai.clone());
            // What the person told their agents about themselves (ADR 0074), which every session
            // reads when it opens. Read once here; the About you page changes it in memory too.
            let you = loomwatch_backend::you::You::open(&state_dir);
            loomwatch_backend::you::install(you.clone());
            // The tools the operator connected (ADR 0069), which a run offers the agents given
            // one. Opening reads nothing; the Keychain is read when a tool is first used.
            let connected_tools = loomwatch_backend::connected_tools::Tools::open(&state_dir)?;
            loomwatch_backend::connected_tools::install(connected_tools.clone());
            // Where the page Notion answers go under is kept. Sending them, and reading the pages
            // agents are given, go through the Notion tool's sign-in (ADR 0070), so both are
            // installed before anything can start a run.
            loomwatch_backend::notion::install(&state_dir);
            // On a Mac, agents' commands find LoomWatch's own `osascript` first, signed so macOS
            // lets it reach other apps from inside the sandbox (ADR 0087). In the background: the
            // first start of each version signs a copy.
            tokio::task::spawn_blocking({
                let state_dir = state_dir.clone();
                move || loomwatch_backend::agent::use_own_programs(&state_dir)
            });
            // A Notion sign-in made in Connections before Notion was a tool becomes the Notion
            // tool's, once. It reads the old Keychain item only when its status says one is there.
            tokio::spawn(loomwatch_backend::notion::move_to_tools(
                state_dir.clone(),
                connected_tools.clone(),
            ));
            // Every agent lives in My agents (ADR 0094): before anything moves a team onto them,
            // a copy of every team file and agent file is kept in the state folder, once.
            if let Some(folder) = loomwatch_backend::my_agents::back_up_once(
                &state_dir,
                &teams_root,
            )
            .with_context(|| {
                format!(
                    "failed to keep a copy of your teams in {} before moving them onto My agents",
                    state_dir.display()
                )
            })? {
                println!(
                    "loomwatchd kept a copy of your teams and agents in {}",
                    folder.display()
                );
            }
            // Which team files may run (ADR 0048), kept outside the teams folder. Opened before
            // anything can start a run, and the first time, it approves the teams already there.
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
            // What agents learned from feedback (ADR 0078), on the same registry's database.
            // Tell all my agents adds to the same About you every session reads.
            let lessons = loomwatch_backend::lessons::router(
                teams_root.clone(),
                registry.clone(),
                you.clone(),
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
            // Ask LoomWatch (ADR 0033): the Ask panel's endpoints and the tools its agent calls. It
            // shares the registry so a run it starts is an ordinary run, and the listener so the
            // links it gives are the daemon's own.
            let control = loomwatch_backend::control::Control::new(
                loomwatch_backend::control::ControlOptions {
                    archive: archive.clone(),
                    teams_root: teams_root.clone(),
                    skills_folder: loomwatch_backend::capabilities::skills_folder(),
                    registry: registry.clone(),
                    listen: address,
                    ask_model: std::env::var("LOOMWATCH_ASK_MODEL").ok(),
                },
            );
            // ADR 0052: says when a newer LoomWatch is out and how to install it. The check runs
            // each time LoomWatch opens: just after this start, and whenever the app's page opens.
            // Installing is the launcher's: in its terminal, or when "Update and restart" has this
            // daemon exit for it.
            let updates = loomwatch_backend::updates::Updates::from_env(&state_dir);
            updates.spawn_start_check();
            let updates_api = loomwatch_backend::updates::router(
                updates.clone(),
                registry.clone(),
                archive.clone(),
            );
            let pinned = loomwatch_backend::pinned::Pinned::open(&state_dir, &teams_root);
            loomwatch_backend::pinned::install(pinned.clone());
            let team_requests_archive = archive.clone();
            let mut app = loomwatch_backend::spa::router()
                .merge(control.router())
                .merge(api)
                .merge(loomwatch_backend::watch_api::router(archive))
                .merge(runs)
                .merge(chat)
                .merge(lessons)
                .merge(notebook)
                .merge(routines)
                .merge(updates_api)
                .merge(loomwatch_backend::wardrobe::router(
                    loomwatch_backend::wardrobe::Wardrobe::open(&state_dir),
                ))
                // ADR 0083: the agent pinned to the notch, messaged from the island; it may ask the
                // person's teams, each started only when they press Start.
                .merge(loomwatch_backend::pinned::router(pinned))
                .merge(loomwatch_backend::team_requests::router(
                    team_requests_archive,
                    teams_root.clone(),
                    registry.clone(),
                ))
                .merge(loomwatch_backend::you::router(you));
            if listen.ip().is_loopback() || allow_container_listener {
                app = app.merge(loomwatch_backend::notion::router(
                    &state_dir,
                    connected_tools.clone(),
                )?);
                // The OpenRouter key and the model list. Like Notion's connection, only on this
                // computer's own address.
                app = app.merge(loomwatch_backend::ai::router(ai.clone()));
                // Connecting tools, and where their sites send a sign-in back.
                app = app.merge(loomwatch_backend::connected_tools::router(
                    connected_tools.clone(),
                ));
                // LoomWatch's skills folder, bringing skills in from apps on request, and installing
                // from GitHub, skills.sh and ClawHub. Building it scans and fetches nothing.
                app = app.merge(loomwatch_backend::skills_api::router(
                    state_dir.clone(),
                    loomwatch_backend::platform::home_dir().unwrap_or_default(),
                ));
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
            // As for `serve`, but before the one turn starts.
            let state_dir = database.state_dir()?;
            tokio::task::spawn_blocking(move || {
                loomwatch_backend::agent::use_own_programs(&state_dir);
            })
            .await?;
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
        Commands::DatabasePath { database } => {
            println!("{}", database.database()?.display());
        }
        Commands::DatabaseLayout { database } => {
            if let Some(layout) = loomwatch_backend::db::layout(&database.database()?).await? {
                println!("{layout}");
            }
        }
        Commands::ReadDocument { path } => {
            println!("{}", loomwatch_backend::documents::answer(&path));
        }
        #[cfg(feature = "prompt-overrides")]
        Commands::DumpPromptBlocks { dir } => {
            for line in loomwatch_backend::prompt_blocks::dump(&dir)? {
                println!("{line}");
            }
        }
    }
    Ok(())
}

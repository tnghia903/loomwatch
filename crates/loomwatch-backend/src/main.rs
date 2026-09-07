//! `LoomWatch` Phase-02 command-line backend.

#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use loomwatch_backend::archive::EventArchive;

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
        /// Directory containing team YAML files accessible through the web UI.
        #[arg(long, default_value = ".")]
        teams_root: PathBuf,
        /// Additional hostname accepted by the HTTP API (repeatable).
        #[arg(long = "allow-host", value_name = "HOSTNAME")]
        allowed_hosts: Vec<String>,
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
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Commands::Serve {
            listen,
            teams_root,
            mut allowed_hosts,
        } => {
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
            let listener = tokio::net::TcpListener::bind(listen).await?;
            let address = listener.local_addr()?;
            println!("loomwatchd listening on http://{address}");
            let api = loomwatch_backend::api::router(teams_root, allowed_hosts)?;
            let app = loomwatch_backend::spa::router().merge(api);
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
    }
    Ok(())
}

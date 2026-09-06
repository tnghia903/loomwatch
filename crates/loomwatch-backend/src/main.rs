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
        Commands::Serve { listen } => {
            let listener = tokio::net::TcpListener::bind(listen).await?;
            let address = listener.local_addr()?;
            println!("loomwatchd listening on http://{address}");
            let app = loomwatch_backend::spa::router().merge(loomwatch_backend::api::router());
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

//! `LoomWatch`'s own `osascript`, for agents' commands on a Mac (ADR 0087).
//!
//! macOS refuses every Apple Event sent from inside a sandbox unless the sending program's
//! signature carries an Apple Events entitlement, and `/usr/bin/osascript` carries none. So inside
//! `LoomWatch`'s command sandbox an agent could not work in Calendar, Mail, Notes or any other app.
//! The daemon signs a copy of this program with that entitlement and puts it first on the `PATH`
//! of sandboxed commands, under the name `osascript`. It reads the same command line and runs
//! scripts through the same macOS framework, so a skill written for `osascript` works unchanged.
//! macOS still asks the person once for each app (System Settings, Privacy & Security,
//! Automation), and the sandbox still keeps writes to the work folder.

mod args;
#[cfg(target_os = "macos")]
mod osa;

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut words = std::env::args_os();
    let program = words.next().map_or_else(
        || "osascript".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let invocation = match args::parse(&program, words) {
        Ok(invocation) => invocation,
        Err(args::Problem(problem)) => {
            eprintln!("{problem}\n{}", args::USAGE);
            return ExitCode::from(2);
        }
    };
    run(&invocation)
}

#[cfg(target_os = "macos")]
fn run(invocation: &args::Invocation) -> ExitCode {
    use std::io::{Read as _, Write as _};

    if invocation.interactive {
        eprintln!(
            "osascript: -i waits for someone typing, and nobody types to an agent's command; \
             give the script with -e or a file."
        );
        return ExitCode::from(2);
    }
    let language = match invocation.language.as_deref() {
        None => None,
        Some(name) => {
            let Some(language) = osa::language(name) else {
                eprintln!("osascript: no such component \"{name}\".");
                return ExitCode::FAILURE;
            };
            Some(language)
        }
    };
    let script = match &invocation.source {
        args::Source::Lines(lines) => osa::Script::Text(lines.clone()),
        args::Source::File(path) => match std::fs::read(path) {
            Ok(bytes) => osa::Script::from_file(bytes),
            Err(error) => {
                eprintln!("osascript: {}: {}", path.display(), reason(&error));
                return ExitCode::FAILURE;
            }
        },
        args::Source::Stdin => {
            let mut bytes = Vec::new();
            if let Err(error) = std::io::stdin().read_to_end(&mut bytes) {
                eprintln!("osascript: standard input: {}", reason(&error));
                return ExitCode::FAILURE;
            }
            osa::Script::Text(osa::text(&bytes))
        }
    };
    match osa::run(
        &script,
        language,
        &invocation.arguments,
        invocation.source_form,
    ) {
        Ok(result) => {
            if let Some(result) = result {
                let _ = writeln!(std::io::stdout(), "{result}");
            }
            ExitCode::SUCCESS
        }
        Err(failure) => {
            let mut said = failure.line;
            if let Some(hint) = osa::refusal_hint(failure.number) {
                said = format!("{said}\n{hint}");
            }
            if invocation.errors_to_stdout {
                let _ = writeln!(std::io::stdout(), "{said}");
            } else {
                let _ = writeln!(std::io::stderr(), "{said}");
            }
            ExitCode::FAILURE
        }
    }
}

/// An I/O error as `osascript` words it: the system's sentence, without Rust's `(os error 2)`.
#[cfg(target_os = "macos")]
fn reason(error: &std::io::Error) -> String {
    let text = error.to_string();
    match text.rfind(" (os error ") {
        Some(at) => text[..at].to_owned(),
        None => text,
    }
}

#[cfg(not(target_os = "macos"))]
fn run(_: &args::Invocation) -> ExitCode {
    eprintln!("osascript: AppleScript runs only on a Mac.");
    ExitCode::FAILURE
}

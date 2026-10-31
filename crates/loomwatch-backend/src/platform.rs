//! What differs between the systems `LoomWatch` runs on, kept in one place: where the home folder
//! is, how a resolved path is written, which names Windows refuses, how a program on `PATH` is
//! found, and how a command is ended together with everything it started.
//!
//! macOS and Linux behave exactly as they did before Windows was supported: every function here is
//! the plain standard-library behaviour there.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The operator's home folder: what `~` in a team file or a command means.
///
/// `HOME` on macOS and Linux. On Windows `USERPROFILE`, `C:\Users\<name>`; `HOME` there only when
/// `USERPROFILE` is missing, because Git's shell sets `HOME` to a folder of its own choosing.
#[must_use]
pub fn home_dir() -> Option<PathBuf> {
    pick_home(
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        cfg!(windows),
    )
}

fn pick_home(home: Option<OsString>, profile: Option<OsString>, windows: bool) -> Option<PathBuf> {
    let usable = |value: Option<OsString>| value.filter(|value| !value.is_empty());
    let (first, second) = if windows {
        (usable(profile), usable(home))
    } else {
        (usable(home), None)
    };
    first.or(second).map(PathBuf::from)
}

/// `path` with every link resolved, as [`std::fs::canonicalize`] gives it — except that on Windows
/// a path on a drive keeps its `C:\…` form instead of becoming `\\?\C:\…`. cmd.exe, which runs an
/// agent's commands, refuses that form as a working folder, and it never compares equal to a path
/// the operator typed or a team file holds.
///
/// # Errors
///
/// Returns the error `std::fs::canonicalize` returns, such as for a path that does not exist.
pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Whether Windows refuses `name` as a file or folder name, with or without an extension: the
/// device names `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` and `LPT1`–`LPT9`, in any case.
#[must_use]
pub fn is_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0')
}

/// The extensions a program file can have on Windows, in the order a terminal tries them: those in
/// `PATHEXT` that can be started directly (`.com`, `.exe`) or through cmd.exe (`.bat`, `.cmd`).
/// A `.js` or `.vbs` in `PATHEXT` is opened by another program, never started, so it is left out.
#[cfg(windows)]
fn program_extensions() -> Vec<String> {
    const STARTABLE: [&str; 4] = [".COM", ".EXE", ".BAT", ".CMD"];
    let listed = std::env::var("PATHEXT").unwrap_or_default();
    let mut extensions: Vec<String> = listed
        .split(';')
        .map(|extension| extension.trim().to_ascii_uppercase())
        .filter(|extension| STARTABLE.contains(&extension.as_str()))
        .collect();
    if extensions.is_empty() {
        extensions = STARTABLE
            .iter()
            .map(|&extension| extension.to_owned())
            .collect();
    }
    extensions
}

/// The files `path` can mean as a program: on Windows `path` itself when it already ends in a
/// program extension, then `path` with each one added (`pdftotext` → `pdftotext.exe`), as a
/// terminal tries them; elsewhere just `path`.
#[must_use]
pub fn program_candidates(path: &Path) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let extensions = program_extensions();
        let has_program_extension = path.extension().is_some_and(|extension| {
            let extension = format!(".{}", extension.to_string_lossy()).to_ascii_uppercase();
            extensions.contains(&extension)
        });
        let mut candidates = Vec::with_capacity(extensions.len() + 1);
        if has_program_extension {
            candidates.push(path.to_path_buf());
        }
        candidates.extend(extensions.iter().map(|extension| {
            let mut name = path.as_os_str().to_owned();
            name.push(extension.to_ascii_lowercase());
            PathBuf::from(name)
        }));
        candidates
    }
    #[cfg(not(windows))]
    {
        vec![path.to_path_buf()]
    }
}

/// What this computer is called in its own settings, such as `Nghia's MacBook Pro`: how another
/// computer lists it among its connected devices (ADR 0102).
#[must_use]
pub fn computer_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    let name = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned());
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(not(any(target_os = "macos", windows)))]
    let name = std::fs::read_to_string("/etc/hostname").ok();
    name.map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

/// Where Tailscale's command line is on this computer, if it is (ADR 0102): where its app and
/// installers put it, then on the search path. An app started at login has a short search path, so
/// the usual places are named.
#[must_use]
pub fn tailscale_program() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH")
        .map(|search| std::env::split_paths(&search).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|folder| folder.join("tailscale"));
    installed_tailscale_programs()
        .into_iter()
        .chain(on_path)
        .flat_map(|path| program_candidates(&path))
        .find(|path| path.is_file())
}

fn installed_tailscale_programs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect()
    }
    #[cfg(windows)]
    {
        ["ProgramFiles", "ProgramW6432"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(|folder| PathBuf::from(folder).join(r"Tailscale\tailscale.exe"))
            .collect()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        ["/usr/bin/tailscale", "/usr/local/bin/tailscale"]
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }
}

/// Everything one command started, ended together.
///
/// Windows has no process groups, and ending cmd.exe leaves whatever it started running with
/// nobody reading its output. So the command is put in a job of its own the moment it starts;
/// every process it starts joins that job, and dropping this closes the job, which ends them all.
/// Elsewhere it holds nothing: a command's process group is ended by its runner, and the child's
/// own `kill_on_drop` ends the process itself.
#[derive(Default)]
pub struct ProcessTree {
    /// Held, not read: closing it is what ends the tree.
    #[cfg(windows)]
    #[cfg_attr(not(test), allow(dead_code))]
    job: Option<win32job::Job>,
}

impl ProcessTree {
    /// Put `child`, and so every process it goes on to start, in a tree of its own. A child that
    /// has already exited, or a job Windows refuses, leaves it to `kill_on_drop` alone.
    #[must_use]
    pub fn adopt(child: &tokio::process::Child) -> Self {
        #[cfg(windows)]
        {
            Self::adopt_handle(child.raw_handle())
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Self {}
        }
    }

    /// [`Self::adopt`] for a child started with `std::process`.
    #[must_use]
    pub fn adopt_std(child: &std::process::Child) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            Self::adopt_handle(Some(child.as_raw_handle()))
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Self {}
        }
    }

    /// End every process in the tree now, rather than when it is dropped.
    pub fn end(self) {}

    #[cfg(windows)]
    fn adopt_handle(handle: Option<std::os::windows::io::RawHandle>) -> Self {
        let job = handle.and_then(|handle| {
            let mut limits = win32job::ExtendedLimitInfo::new();
            limits.limit_kill_on_job_close();
            let job = win32job::Job::create_with_limit_info(&limits).ok()?;
            job.assign_process(handle as isize).ok()?;
            Some(job)
        });
        Self { job }
    }

    /// The processes in this tree now, by id.
    #[cfg(all(test, windows))]
    pub(crate) fn process_ids(&self) -> Vec<usize> {
        self.job
            .as_ref()
            .and_then(|job| job.query_process_id_list().ok())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_device_names_are_reserved_with_any_extension_or_case() {
        for name in [
            "con", "CON", "nul.yaml", "Aux", "prn.txt", "com1", "LPT9.log", "con .",
        ] {
            assert!(is_reserved_name(name), "{name}");
        }
        for name in [
            "console", "com0", "com10", "lpt", "nullable", "team", "my-con", "",
        ] {
            assert!(!is_reserved_name(name), "{name}");
        }
    }

    #[test]
    fn the_home_folder_is_home_except_on_windows_where_it_is_the_user_profile() {
        let home = Some(OsString::from("/home/ana"));
        let profile = Some(OsString::from(r"C:\Users\ana"));
        assert_eq!(
            pick_home(home.clone(), profile.clone(), false),
            Some(PathBuf::from("/home/ana"))
        );
        assert_eq!(
            pick_home(None, profile.clone(), false),
            None,
            "USERPROFILE means nothing outside Windows"
        );
        assert_eq!(
            pick_home(home.clone(), profile, true),
            Some(PathBuf::from(r"C:\Users\ana")),
            "on Windows the user profile is home, whatever HOME says"
        );
        assert_eq!(
            pick_home(home, Some(OsString::new()), true),
            Some(PathBuf::from("/home/ana")),
            "an empty USERPROFILE falls back to HOME"
        );
        assert_eq!(pick_home(Some(OsString::new()), None, false), None);
    }

    #[test]
    fn a_resolved_path_compares_equal_to_the_path_as_written() {
        let directory = std::env::temp_dir().join(format!("lw-platform-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create folder");
        let resolved = canonicalize(&directory).expect("resolve");
        assert!(resolved.is_absolute());
        assert!(
            !resolved.to_string_lossy().starts_with(r"\\?\"),
            "{} keeps the \\\\?\\ prefix cmd.exe refuses",
            resolved.display()
        );
        assert_eq!(canonicalize(&resolved).expect("resolve again"), resolved);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[cfg(not(windows))]
    #[test]
    fn outside_windows_a_program_is_its_own_path() {
        assert_eq!(
            program_candidates(Path::new("/usr/bin/env")),
            vec![PathBuf::from("/usr/bin/env")]
        );
    }

    #[cfg(windows)]
    mod windows {
        use super::super::*;
        use std::fs;
        use std::time::Duration;

        struct Scratch(PathBuf);

        impl Scratch {
            fn new(name: &str) -> Self {
                let path = std::env::temp_dir().join(format!(
                    "lw-{name}-{}-{}",
                    std::process::id(),
                    uuid::Uuid::new_v4().simple()
                ));
                fs::create_dir_all(&path).expect("scratch folder");
                Self(canonicalize(&path).expect("resolve scratch folder"))
            }
        }

        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn a_program_is_found_with_the_extensions_windows_starts() {
            let scratch = Scratch::new("candidates");
            let bare = scratch.0.join("pdftotext");
            let candidates = program_candidates(&bare);
            assert!(candidates.contains(&scratch.0.join("pdftotext.exe")));
            assert!(candidates.contains(&scratch.0.join("pdftotext.cmd")));
            assert!(
                !candidates.contains(&bare),
                "Windows starts no extensionless file"
            );
            assert_eq!(
                program_candidates(&scratch.0.join("tool.exe"))[0],
                scratch.0.join("tool.exe")
            );
        }

        /// Dropping the tree ends the grandchild that cmd.exe started, which ending cmd.exe alone
        /// would leave running.
        #[tokio::test]
        async fn dropping_the_tree_ends_the_grandchildren_too() {
            let scratch = Scratch::new("tree");
            // cmd.exe starts ping, which then waits two minutes.
            let mut command = tokio::process::Command::new("cmd.exe");
            command
                .raw_arg("/d /s /c \"ping -n 120 127.0.0.1 >nul\"")
                .current_dir(&scratch.0)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .kill_on_drop(true);
            let child = command.spawn().expect("start cmd.exe");
            let tree = ProcessTree::adopt(&child);
            let mut started = Vec::new();
            for _ in 0..300 {
                started = tree.process_ids();
                if started.len() >= 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(
                started.len() >= 2,
                "cmd.exe and the ping it started are both in the tree: {started:?}"
            );
            let started: Vec<u32> = started
                .into_iter()
                .map(|pid| u32::try_from(pid).expect("a process id"))
                .collect();
            assert!(started.iter().all(|&pid| process_is_running(pid)));
            drop(tree);
            drop(child);
            for _ in 0..100 {
                if started.iter().all(|&pid| !process_is_running(pid)) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("processes {started:?} outlived the command that started them");
        }

        fn process_is_running(pid: u32) -> bool {
            std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .is_ok_and(|output| {
                    String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
                })
        }
    }
}

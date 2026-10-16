//! What differs between the systems `LoomWatch` runs on, kept in one place: where the home folder
//! is, how a resolved path is written, how a program a team file names is found, and how an app is
//! ended together with everything it started.
//!
//! macOS and Linux behave exactly as they did before Windows was supported: every function here is
//! the plain standard-library behaviour there.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// The operator's home folder, where the AI apps keep their settings (`.claude`, `.codex`,
/// `.config/opencode`, …).
///
/// `HOME` on macOS and Linux. On Windows `USERPROFILE`, which is where Claude, Codex and the other
/// apps look themselves; `HOME` there only when `USERPROFILE` is missing, because Git's shell sets
/// `HOME` to a folder of its own choosing.
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
/// a path on a drive keeps its `C:\…` form instead of becoming `\\?\C:\…`. cmd.exe, which runs
/// every app npm installs, refuses that form as a working folder, and it never compares equal to
/// a path the operator typed or a team file holds.
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
/// program extension, then `path` with each one added (`npx` → `npx.cmd`), as a terminal tries
/// them; elsewhere just `path`.
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

/// The program to start for `program` — a team file's `spawn.cmd`, or the app catalog's — when it
/// runs in `cwd` with `search_path` as its `PATH`.
///
/// Unchanged outside Windows: the system finds it there exactly as a terminal would. Windows
/// itself only ever looks for `<name>.exe`, so `npx`, `claude-agent-acp`, `codex-acp` and every
/// other app npm installs — all `.cmd` files — would never start. There a bare name is looked up
/// the way a terminal does, through `search_path` with each extension in `PATHEXT`, and a relative
/// path such as `bin\agent` against the agent's own folder. A program not found is returned as
/// written, so starting it fails with the system's own "not found".
#[must_use]
pub fn program_path(
    program: impl AsRef<OsStr>,
    cwd: &Path,
    search_path: Option<&OsStr>,
) -> PathBuf {
    let program = program.as_ref();
    #[cfg(windows)]
    {
        let path = Path::new(program);
        let found = if path.is_absolute() || path.components().count() > 1 {
            program_candidates(&cwd.join(path))
                .into_iter()
                .find(|candidate| candidate.is_file())
        } else {
            search_path
                .zip(program.to_str())
                .and_then(|(search_path, program)| find_program(search_path, program))
        };
        found.unwrap_or_else(|| PathBuf::from(program))
    }
    #[cfg(not(windows))]
    {
        let _ = (cwd, search_path);
        PathBuf::from(program)
    }
}

/// Where `command`, a bare program name, is on `search_path`, as [`program_path`] starts it.
///
/// That is [`crate::api::find_executable`], except for `python3` on Windows. Python installs no
/// `python3` there, and the `python3.exe` every Windows account has on its `PATH` is usually the
/// Microsoft Store's stand-in, which only says Python is not installed. So a team file written on
/// a Mac (`cmd: python3`, as the offline demo's is) runs the Python 3 this computer does have: a
/// real `python3`, else `python`, else the `py` launcher that the python.org installer adds, and
/// the Store's `python3` only when there is nothing else.
#[must_use]
pub fn find_program(search_path: &OsStr, command: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    if command.eq_ignore_ascii_case("python3") || command.eq_ignore_ascii_case("python3.exe") {
        let installed = |name: &str| {
            std::env::split_paths(search_path)
                .filter(|directory| !is_store_alias_folder(directory))
                .flat_map(|directory| program_candidates(&directory.join(name)))
                .find(|candidate| candidate.is_file())
        };
        return installed("python3")
            .or_else(|| installed("python"))
            .or_else(|| installed("py"))
            .or_else(|| crate::api::find_executable(search_path, command));
    }
    crate::api::find_executable(search_path, command)
}

/// `…\Microsoft\WindowsApps`, where Windows keeps its app shortcuts, among them the Store's
/// `python3.exe` stand-in.
#[cfg(windows)]
fn is_store_alias_folder(directory: &Path) -> bool {
    let mut components = directory.components().rev();
    let last = components.next();
    let parent = components.next();
    matches!(
        (parent, last),
        (Some(parent), Some(last))
            if parent.as_os_str().eq_ignore_ascii_case("Microsoft")
                && last.as_os_str().eq_ignore_ascii_case("WindowsApps")
    )
}

/// Everything one app started, ended together.
///
/// On Windows an app installed by npm is cmd.exe running node, and ending cmd.exe leaves node
/// running with nobody reading its output. So the app is put in a job of its own the moment it
/// starts; every process it starts joins that job, and dropping this closes the job, which ends
/// them all — when a run is cancelled, when an app hangs, and when `LoomWatch` itself exits.
/// Elsewhere it holds nothing: the child's own `kill_on_drop` ends the app, as it always has.
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

    /// End every process in the tree now, rather than when it is dropped.
    pub fn end(self) {}

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
    fn process_ids(&self) -> Vec<usize> {
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
            "Windows apps keep their settings under the user profile, whatever HOME says"
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
    fn outside_windows_a_program_is_started_exactly_as_written() {
        let cwd = Path::new("/tmp");
        assert_eq!(
            program_path("npx", cwd, Some(OsStr::new("/usr/bin"))),
            PathBuf::from("npx")
        );
        assert_eq!(
            program_path("./bin/agent", cwd, None),
            PathBuf::from("./bin/agent")
        );
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
        fn an_npm_style_cmd_file_is_found_by_its_bare_name() {
            let scratch = Scratch::new("cmd-lookup");
            let bin = scratch.0.join("npm");
            fs::create_dir_all(&bin).expect("bin");
            fs::write(bin.join("claude-agent-acp"), "#!/bin/sh\n").expect("sh shim");
            fs::write(bin.join("claude-agent-acp.cmd"), "@echo off\r\n").expect("cmd shim");
            fs::write(bin.join("claude-agent-acp.ps1"), "").expect("ps1 shim");
            let search_path = std::env::join_paths([&bin]).expect("path");
            assert_eq!(
                program_path("claude-agent-acp", &scratch.0, Some(&search_path)),
                bin.join("claude-agent-acp.cmd"),
                "the extensionless shell shim npm also writes cannot be started on Windows"
            );
            assert_eq!(
                program_path("claude-agent-acp.cmd", &scratch.0, Some(&search_path)),
                bin.join("claude-agent-acp.cmd"),
            );
            assert_eq!(
                program_path("not-installed", &scratch.0, Some(&search_path)),
                PathBuf::from("not-installed"),
            );
        }

        #[test]
        fn python3_is_the_python_this_computer_has_not_the_store_stand_in() {
            let scratch = Scratch::new("python3");
            let store = scratch.0.join("Microsoft").join("WindowsApps");
            let python = scratch.0.join("Python313");
            let launcher = scratch.0.join("Windows");
            for folder in [&store, &python, &launcher] {
                fs::create_dir_all(folder).expect("folder");
            }
            fs::write(store.join("python3.exe"), "").expect("store python3");
            fs::write(store.join("python.exe"), "").expect("store python");
            fs::write(launcher.join("py.exe"), "").expect("py");
            let path = |folders: &[&PathBuf]| std::env::join_paths(folders).expect("path");

            let only_store = path(&[&store]);
            assert_eq!(
                find_program(&only_store, "python3"),
                Some(store.join("python3.exe")),
                "with nothing else, the Store's own python3 still runs, and says what to install"
            );
            let launcher_too = path(&[&store, &launcher]);
            assert_eq!(
                find_program(&launcher_too, "python3"),
                Some(launcher.join("py.exe"))
            );
            fs::write(python.join("python.exe"), "").expect("python");
            let python_too = path(&[&store, &python, &launcher]);
            assert_eq!(
                find_program(&python_too, "python3"),
                Some(python.join("python.exe"))
            );
            assert_eq!(
                find_program(&python_too, "python"),
                Some(store.join("python.exe")),
                "only python3, which Windows never installs, is looked for elsewhere"
            );
        }

        #[test]
        fn a_relative_program_is_found_in_the_agents_own_folder() {
            let scratch = Scratch::new("relative");
            fs::create_dir_all(scratch.0.join("bin")).expect("bin");
            fs::write(scratch.0.join("bin").join("agent.bat"), "@echo off\r\n").expect("bat");
            assert_eq!(
                program_path(r"bin\agent", &scratch.0, None),
                scratch.0.join("bin").join("agent.bat")
            );
            assert_eq!(
                program_path("./bin/agent", &scratch.0, None),
                scratch.0.join("./bin/agent.bat")
            );
        }

        /// The reason `program_path` exists: a `.cmd` app, started by its bare name, receives its
        /// arguments intact and answers on standard output.
        #[tokio::test]
        async fn a_cmd_app_started_by_its_bare_name_receives_its_arguments() {
            let scratch = Scratch::new("cmd-run");
            fs::write(
                scratch.0.join("echo-args.cmd"),
                "@echo off\r\necho [%~1] [%~2]\r\n",
            )
            .expect("cmd");
            let search_path = std::env::join_paths([&scratch.0]).expect("path");
            let program = program_path("echo-args", &scratch.0, Some(&search_path));
            let output = tokio::process::Command::new(program)
                .args(["--model", "sonnet 4"])
                .current_dir(&scratch.0)
                .output()
                .await
                .expect("start the .cmd app");
            assert!(output.status.success(), "{output:?}");
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim(),
                "[--model] [sonnet 4]"
            );
        }

        /// Dropping the tree ends the grandchild that cmd.exe started, which ending cmd.exe alone
        /// would leave running.
        #[tokio::test]
        async fn dropping_the_tree_ends_the_apps_grandchildren_too() {
            let scratch = Scratch::new("tree");
            // cmd.exe starts ping, which then waits two minutes: an app's node behind its .cmd.
            fs::write(
                scratch.0.join("app.cmd"),
                "@echo off\r\nping -n 120 127.0.0.1 >nul\r\n",
            )
            .expect("cmd");
            let mut command = tokio::process::Command::new(scratch.0.join("app.cmd"));
            command
                .current_dir(&scratch.0)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .kill_on_drop(true);
            let child = command.spawn().expect("start app");
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
                "cmd.exe and the ping it started are both in the app's tree: {started:?}"
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
            panic!("processes {started:?} outlived the app that started them");
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

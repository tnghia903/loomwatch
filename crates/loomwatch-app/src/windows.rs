//! The Windows app: an icon in the notification area over a supervised `loomwatchd`.
//!
//! What `mac.rs` does for a Mac, for Windows: `LoomWatch.exe` starts `loomwatchd.exe` from its own
//! folder, opens `LoomWatch` in the browser, and stays beside the clock with Open, Start at sign-in,
//! Show log and Quit. Clicking the icon opens `LoomWatch`; right-clicking shows the menu, which
//! names what waits on you, who is working and what finished lately (`crate::progress`), as the
//! Mac menu does; hovering the icon says the first of them. No console window is ever shown.
//!
//! Where it differs from the Mac: Windows has no signals, so `loomwatchd` is told to stop by
//! closing its standard input, which also happens when this app ends any other way
//! (`LOOMWATCH_EXIT_WITH_PARENT`); Start at sign-in is the Run key in the registry; and opening
//! `LoomWatch.exe` again while it runs opens the browser instead of starting a second one.
//! `LoomWatch.exe --quit` asks the running one to quit as its menu would, and waits until it has:
//! what the installer runs before it replaces the files, and the uninstaller before it removes them.
//!
//! Update and restart in the app has `loomwatchd` stop for this app, which downloads the release's
//! `LoomWatch-windows-setup.exe` and runs it silently (`crate::update`). The installer quits this
//! app, replaces its files and opens the new one; or, when it could not, opens this one again with
//! `--update-failed`, for the app to say so.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::progress::{self, Progress, Row};
use crate::update;

/// The port a `LoomWatch` started from a terminal uses too, so the address people know keeps
/// working.
const FIRST_PORT: u16 = 3000;
const LAST_PORT: u16 = 3020;
/// How long `loomwatchd` gets to answer after it starts, before the menu says it didn't.
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// Three stops this close together mean something is wrong that restarting won't fix.
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const CRASHES_BEFORE_GIVING_UP: usize = 3;
/// The value under the Run key that starts `LoomWatch` at sign-in.
const RUN_VALUE: &str = "LoomWatch";
/// Starts a console program, `loomwatchd.exe`, without a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How often the menu reads what the teams are doing, as the Mac menu does.
const POLL: Duration = Duration::from_secs(2);

enum UserEvent {
    Menu(MenuEvent),
    /// `LoomWatch.exe --quit` asked.
    Quit,
    Tray(TrayIconEvent),
    /// `loomwatchd` answers on this port.
    Ready(u16),
    /// What the teams are doing changed.
    Progress(Progress),
    /// What the menu's status line should say now.
    Status(String),
}

/// Where everything is.
#[derive(Clone)]
struct Paths {
    /// This program, which Start at sign-in starts.
    program: PathBuf,
    daemon: PathBuf,
    teams: PathBuf,
    /// `%LOCALAPPDATA%\LoomWatch`, where `loomwatchd` keeps its run history by default.
    state: PathBuf,
    log: PathBuf,
    /// What `/api/about` reports as the commit, from `VERSION` beside this program.
    commit: Option<String>,
    home: PathBuf,
}

impl Paths {
    fn find() -> Result<Self> {
        let program = std::env::current_exe()?;
        let folder = program
            .parent()
            .context("no folder for this program")?
            .to_path_buf();
        // As installed, `bin\loomwatchd.exe`, the layout the `loomwatch` command uses too; beside
        // this program in a build folder.
        let daemon = [
            folder.join("bin").join("loomwatchd.exe"),
            folder.join("loomwatchd.exe"),
        ]
        .into_iter()
        .find(|daemon| daemon.is_file())
        .with_context(|| format!("loomwatchd.exe is missing from {}", folder.display()))?;
        let home = env_folder("USERPROFILE").context("no user profile folder")?;
        let state = std::env::var_os("LOOMWATCH_STATE_DIR")
            .map(PathBuf::from)
            .or_else(|| env_folder("LOCALAPPDATA").map(|local| local.join("LoomWatch")))
            .context("no local application data folder")?;
        let commit = std::fs::read_to_string(folder.join("VERSION"))
            .ok()
            .and_then(|version| version.split_whitespace().nth(1).map(str::to_owned));
        Ok(Self {
            program,
            daemon,
            teams: std::env::var_os("LOOMWATCH_TEAMS_ROOT")
                .map_or_else(|| home.join("LoomWatch").join("teams"), PathBuf::from),
            log: state.join("Logs").join("loomwatchd.log"),
            state,
            commit,
            home,
        })
    }

    /// Where `loomwatchd` names the release Update and restart installs.
    fn update_request(&self) -> PathBuf {
        self.state.join("app-update-request")
    }

    /// Where an update's installer is downloaded. Emptied first.
    fn update_work(&self) -> PathBuf {
        self.state.join("app-update")
    }

    /// Make the teams folder the first time. It starts empty: a newcomer opens on the first run,
    /// where their first agent asks what to make, not on a demo team.
    fn ensure_teams(&self) -> Result<()> {
        std::fs::create_dir_all(&self.teams)?;
        Ok(())
    }
}

/// An absolute folder named by environment variable `name`.
fn env_folder(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|folder| folder.is_absolute())
}

#[allow(clippy::too_many_lines)]
pub fn run() -> Result<()> {
    // Started at sign-in: stay beside the clock without opening the browser.
    let background = std::env::args().any(|arg| arg == "--background");
    let paths = Paths::find()?;
    if std::env::args().any(|arg| arg == "--quit") {
        quit_running(&paths.state);
        return Ok(());
    }
    // One LoomWatch.exe at a time. Opened again from the Start menu, it shows the one running.
    let Some(_only_one) = only_one(&paths.state) else {
        if !background && let Some(url) = running_loomwatch(FIRST_PORT..=LAST_PORT) {
            open(OsStr::new(&url));
        }
        return Ok(());
    };
    paths.ensure_teams()?;

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    {
        let proxy = proxy.clone();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = proxy.send_event(UserEvent::Menu(event));
        }));
    }
    {
        let proxy = proxy.clone();
        TrayIconEvent::set_event_handler(Some(move |event| {
            let _ = proxy.send_event(UserEvent::Tray(event));
        }));
    }
    {
        let proxy = proxy.clone();
        let asked = quit_request(&paths.state);
        let _ = std::fs::remove_file(&asked);
        std::thread::spawn(move || {
            while !asked.exists() {
                std::thread::sleep(Duration::from_millis(250));
            }
            let _ = std::fs::remove_file(&asked);
            let _ = proxy.send_event(UserEvent::Quit);
        });
    }

    let open_item = MenuItem::new("Open LoomWatch", true, None);
    let status = MenuItem::new("Starting…", false, None);
    let at_login = CheckMenuItem::new("Start at sign-in", true, login_item::enabled(), None);
    let log = MenuItem::new("Show log", true, None);
    let quit = MenuItem::new("Quit LoomWatch", true, None);
    let menu = Menu::new();
    menu.append_items(&[
        &open_item,
        &status,
        &PredefinedMenuItem::separator(),
        &at_login,
        &log,
        &PredefinedMenuItem::separator(),
        &quit,
    ])?;

    // Under "Open LoomWatch" and the status line.
    let mut work = WorkSection::new(menu.clone(), 2);
    let supervisor = Supervisor::start(paths.clone(), proxy.clone());
    let watched = Arc::new(AtomicU16::new(0));
    {
        let watched = Arc::clone(&watched);
        std::thread::spawn(move || watch_runs(&watched, &proxy));
    }
    let mut menu = Some(menu);
    let mut tray = None;
    let mut address: Option<String> = None;
    let mut open_when_ready = !background;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                if let Some(menu) = menu.take() {
                    // The notification area shows a 16-point icon: 16 pixels at 100 %, 32 at 200 %.
                    let scale = target
                        .primary_monitor()
                        .map_or(1.0, |monitor| monitor.scale_factor());
                    tray = TrayIconBuilder::new()
                        .with_menu(Box::new(menu))
                        .with_menu_on_left_click(false)
                        .with_icon(tray_icon(scale))
                        .with_tooltip("LoomWatch")
                        .build()
                        .map_err(|error| {
                            append_log(
                                &supervisor.paths.log,
                                &format!("LoomWatch.exe: no notification-area icon: {error}\n"),
                            );
                        })
                        .ok();
                }
            }
            Event::UserEvent(UserEvent::Tray(TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            })) => show(address.as_deref(), &mut open_when_ready),
            Event::UserEvent(UserEvent::Ready(port)) => {
                let url = format!("http://127.0.0.1:{port}");
                status.set_text("LoomWatch is running");
                watched.store(port, Ordering::SeqCst);
                if open_when_ready {
                    open(OsStr::new(&url));
                    open_when_ready = false;
                }
                address = Some(url);
            }
            Event::UserEvent(UserEvent::Status(text)) => status.set_text(text),
            Event::UserEvent(UserEvent::Progress(next)) => {
                work.show(&next.rows());
                if let Some(tray) = &tray {
                    let _ = tray.set_tooltip(Some(next.summary()));
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) => {
                if let Some(link) = work.link_for(&event.id) {
                    if let Some(url) = &address {
                        open(OsStr::new(&format!("{url}{link}")));
                    }
                } else if event.id == *open_item.id() {
                    show(address.as_deref(), &mut open_when_ready);
                } else if event.id == *at_login.id() {
                    let wanted = !login_item::enabled();
                    if let Err(error) = login_item::set(wanted, &supervisor.paths.program) {
                        append_log(
                            &supervisor.paths.log,
                            &format!("LoomWatch.exe: start at sign-in: {error:#}\n"),
                        );
                    }
                    at_login.set_checked(login_item::enabled());
                } else if event.id == *log.id() {
                    open(supervisor.paths.log.as_os_str());
                } else if event.id == *quit.id() {
                    status.set_text("Stopping…");
                    supervisor.stop();
                    tray.take();
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(UserEvent::Quit) => {
                supervisor.stop();
                tray.take();
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    })
}

/// The file `LoomWatch.exe --quit` makes to ask the running one to quit.
fn quit_request(state: &Path) -> PathBuf {
    state.join("LoomWatch.exe.quit")
}

/// Ask the `LoomWatch.exe` running for this account to quit, and wait up to 20 seconds for it to
/// have: its lock is free once it has stopped `loomwatchd` and ended.
fn quit_running(state: &Path) {
    // The lock is free: no LoomWatch.exe is running to ask.
    if only_one(state).is_some() {
        return;
    }
    let asked = quit_request(state);
    if std::fs::write(&asked, b"").is_err() {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if only_one(state).is_some() {
            break;
        }
    }
    let _ = std::fs::remove_file(&asked);
}

/// Open `LoomWatch` in the browser, or as soon as it answers.
fn show(address: Option<&str>, open_when_ready: &mut bool) {
    match address {
        Some(url) => open(OsStr::new(url)),
        None => *open_when_ready = true,
    }
}

/// Holds `<state>\LoomWatch.exe.lock` while this app runs, or `None` when another `LoomWatch.exe`
/// does. Windows releases the lock when the process ends, however it ends.
fn only_one(state: &Path) -> Option<std::fs::File> {
    std::fs::create_dir_all(state).ok()?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(state.join("LoomWatch.exe.lock"))
        .ok()?;
    // A lock Windows can't take at all is no reason not to start.
    (!matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock))).then_some(lock)
}

/// Open `target`, an address or a file, as double-clicking it would: the default browser for an
/// address, Notepad (or whatever opens `.log` files) for the log.
fn open(target: &OsStr) {
    let explorer = std::env::var_os("SystemRoot").map_or_else(
        || PathBuf::from("explorer.exe"),
        |root| PathBuf::from(root).join("explorer.exe"),
    );
    let _ = Command::new(explorer).arg(target).spawn();
}

/// The notification-area icon: `LoomWatch.exe`'s own icon (resource 1, from
/// packaging/windows/LoomWatch.ico) at the size Windows shows it.
fn tray_icon(scale: f64) -> Icon {
    // Small-icon sizes the .ico holds: the nearest is drawn for its own pixel grid.
    let off_by = |size: u32| (f64::from(size) - 16.0 * scale).abs();
    let size = [16_u32, 20, 24, 32, 40, 48]
        .into_iter()
        .min_by(|a, b| off_by(*a).total_cmp(&off_by(*b)))
        .unwrap_or(16);
    Icon::from_resource(1, Some((size, size))).unwrap_or_else(|_| fallback_icon())
}

/// A plain gold tile, for a build that has no icon resource.
fn fallback_icon() -> Icon {
    let rgba = [0xD8, 0xA9, 0x3C, 0xFF].repeat(16 * 16);
    Icon::from_rgba(rgba, 16, 16).expect("a 16 × 16 icon")
}

/// Keeps one `loomwatchd` running until [`Supervisor::stop`].
struct Supervisor {
    paths: Paths,
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
}

impl Supervisor {
    fn start(paths: Paths, proxy: EventLoopProxy<UserEvent>) -> Self {
        let child = Arc::new(Mutex::new(None::<Child>));
        let stopping = Arc::new(AtomicBool::new(false));
        let supervisor = Self {
            paths: paths.clone(),
            child: Arc::clone(&child),
            stopping: Arc::clone(&stopping),
        };
        std::thread::spawn(move || supervise(&paths, &proxy, &child, &stopping));
        supervisor
    }

    /// Ask `loomwatchd` to finish (it cancels its runs and writes what it holds), then make sure
    /// it has. Closing its standard input is the asking.
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(child) = child.as_mut() {
            drop(child.stdin.take());
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn supervise(
    paths: &Paths,
    proxy: &EventLoopProxy<UserEvent>,
    slot: &Mutex<Option<Child>>,
    stopping: &AtomicBool,
) {
    let say = |text: &str| {
        let _ = proxy.send_event(UserEvent::Status(text.to_owned()));
    };
    // Another LoomWatch already answers, started from a terminal, say: open that one, and don't
    // start a second that would run the same scheduled teams twice.
    if running_loomwatch(first_port()..=first_port()).is_some() {
        say("Running (started elsewhere)");
        let _ = proxy.send_event(UserEvent::Ready(first_port()));
        return;
    }
    let path = sign_in_path();
    let mut stops: Vec<Instant> = Vec::new();
    // Why the last Update and restart did not finish, for the next start to say: the installer
    // opens this app with `--update-failed` when it could not put the new version in place.
    let mut failed = std::env::args().any(|arg| arg == "--update-failed").then(|| {
        "LoomWatch-windows-setup.exe could not put the new version in place, so this one was opened again.".to_owned()
    });
    // The installer an update downloaded may still be finishing: what can't go now goes next time.
    let _ = std::fs::remove_dir_all(paths.update_work());
    loop {
        // One LoomWatch per run history: one started from a terminal on another port holds it.
        if history_in_use(&paths.state) {
            say("Already running in a terminal window: stop it there, then open LoomWatch again");
            return;
        }
        let Some(port) = free_port() else {
            say("Can’t start: ports 3000–3020 are all in use");
            return;
        };
        let request = paths.update_request();
        let _ = std::fs::remove_file(&request);
        // Update and restart is offered only when the installer can put the new version in place.
        let handoff = update::windows::installed_by_setup(&paths.program).map(|()| request);
        let started = start_daemon(paths, port, path.as_deref(), &handoff, failed.take());
        let child = match started {
            Ok(child) => child,
            Err(error) => {
                say("Can’t start LoomWatch: see Show log");
                append_log(&paths.log, &format!("LoomWatch.exe: {error:#}\n"));
                return;
            }
        };
        *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(child);
        if wait_until_healthy(port, slot) {
            let _ = proxy.send_event(UserEvent::Ready(port));
        } else if !stopping.load(Ordering::SeqCst) {
            say("Still starting… (see Show log)");
        }
        // Wait for it to stop, and see how it ended.
        let exit = loop {
            if stopping.load(Ordering::SeqCst) {
                return;
            }
            {
                let mut child = slot.lock().unwrap_or_else(PoisonError::into_inner);
                match child.as_mut().map(Child::try_wait) {
                    Some(Ok(None)) => {}
                    Some(Ok(Some(status))) => {
                        child.take();
                        break status.code();
                    }
                    None | Some(Err(_)) => {
                        child.take();
                        break None;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        };
        if stopping.load(Ordering::SeqCst) {
            return;
        }
        // Update and restart: loomwatchd stopped for this app to install the release it named.
        if exit == Some(update::EXIT_TO_UPDATE) {
            let log = |line: &str| append_log(&paths.log, &format!("LoomWatch.exe: {line}\n"));
            match update_app(paths, &say, &log) {
                // The installer quits this app and opens the new one.
                Ok(()) => {
                    let _ = proxy.send_event(UserEvent::Quit);
                    return;
                }
                Err(why) => {
                    log(&format!("the update did not finish: {why}"));
                    failed = Some(why);
                }
            }
            say("Restarting…");
            continue;
        }
        let now = Instant::now();
        stops.retain(|stop| now.duration_since(*stop) < CRASH_WINDOW);
        stops.push(now);
        if stops.len() >= CRASHES_BEFORE_GIVING_UP {
            say("LoomWatch keeps stopping: see Show log");
            return;
        }
        say("Restarting…");
    }
}

/// Reads what the teams are doing from the `loomwatchd` on `watched` (0 until one answers), and
/// tells the menu each time it changes. When `loomwatchd` doesn't answer, nothing is under way.
fn watch_runs(watched: &AtomicU16, proxy: &EventLoopProxy<UserEvent>) {
    let mut last: Option<Progress> = None;
    loop {
        let port = watched.load(Ordering::SeqCst);
        if port != 0 {
            let now = get(port, &progress::runs_path())
                .and_then(|body| serde_json::from_str::<Vec<progress::Record>>(&body).ok())
                .map(|runs| progress::progress(&runs, chrono::Utc::now()))
                .unwrap_or_default();
            if last.as_ref() != Some(&now) {
                if proxy.send_event(UserEvent::Progress(now.clone())).is_err() {
                    return;
                }
                last = Some(now);
            }
        }
        std::thread::sleep(POLL);
    }
}

/// The menu's rows about the teams' work, between the status line and the settings, as the Mac
/// menu has them.
struct WorkSection {
    menu: Menu,
    /// Where the section starts in the menu.
    at: usize,
    separator: PredefinedMenuItem,
    /// Each row's item and where it opens in the app.
    shown: Vec<(MenuItem, Option<String>)>,
}

impl WorkSection {
    fn new(menu: Menu, at: usize) -> Self {
        Self {
            menu,
            at,
            separator: PredefinedMenuItem::separator(),
            shown: Vec::new(),
        }
    }

    /// Show `rows`. Rows about the same runs as before only change their words, so a menu that is
    /// open as the minutes tick over does not jump; anything else builds the section again.
    fn show(&mut self, rows: &[Row]) {
        let same = self.shown.len() == rows.len()
            && self
                .shown
                .iter()
                .zip(rows)
                .all(|((_, link), row)| *link == row.link);
        if same {
            for ((item, _), row) in self.shown.iter().zip(rows) {
                if item.text() != row.text {
                    item.set_text(&row.text);
                }
            }
            return;
        }
        if !self.shown.is_empty() {
            let _ = self.menu.remove(&self.separator);
        }
        for (item, _) in self.shown.drain(..) {
            let _ = self.menu.remove(&item);
        }
        if rows.is_empty() {
            return;
        }
        let _ = self.menu.insert(&self.separator, self.at);
        for (offset, row) in rows.iter().enumerate() {
            // Headings are greyed out; a line about a run opens that run.
            let item = MenuItem::new(&row.text, row.link.is_some(), None);
            let _ = self.menu.insert(&item, self.at + 1 + offset);
            self.shown.push((item, row.link.clone()));
        }
    }

    /// Where a clicked row opens in the app.
    fn link_for(&self, id: &MenuId) -> Option<&str> {
        self.shown
            .iter()
            .find(|(item, _)| item.id() == id)
            .and_then(|(_, link)| link.as_deref())
    }
}

/// Whether another `loomwatchd` holds the run history this app's would use: the daemon's own
/// default (`<state folder>\loomwatch.db`) unless `LOOMWATCH_DATABASE` says otherwise, locked by
/// `<file>.lock` while a daemon uses it.
fn history_in_use(state: &Path) -> bool {
    let database = std::env::var_os("LOOMWATCH_DATABASE")
        .map_or_else(|| state.join("loomwatch.db"), PathBuf::from);
    let mut lock = database.into_os_string();
    lock.push(".lock");
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(PathBuf::from(lock))
        .is_ok_and(|file| matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)))
}

/// After `loomwatchd` stopped for Update and restart: downloads the installer of the release it
/// named, saves a copy of the run history, and starts the installer. Returns why nothing was
/// changed when a step fails.
fn update_app(
    paths: &Paths,
    say: &dyn Fn(&str),
    log: &dyn Fn(&str),
) -> std::result::Result<(), String> {
    let current = env!("CARGO_PKG_VERSION");
    let release = update::requested(&paths.update_request(), current)?;
    update::windows::installed_by_setup(&paths.program)?;
    let base = update::download_base(&release)?;
    log(&format!(
        "updating {current} to {} from {base}",
        release.version
    ));
    let work = paths.update_work();
    let _ = std::fs::remove_dir_all(&work);
    say(&format!("Downloading LoomWatch {}…", release.version));
    let setup = update::download(&base, "LoomWatch-windows-setup.exe", &work, log)?;
    say("Saving a copy of the run history…");
    let backups = update::backup_folder(&paths.home);
    if let Some(copy) = update::back_up(&paths.daemon, &backups, current, log)? {
        log(&format!(
            "saved a copy of the run history in {}",
            copy.display()
        ));
    }
    say(&format!("Installing LoomWatch {}…", release.version));
    update::windows::run_setup(&setup, current)?;
    log(&format!(
        "started {} to install {}",
        setup.display(),
        release.version
    ));
    Ok(())
}

fn start_daemon(
    paths: &Paths,
    port: u16,
    path: Option<&OsStr>,
    handoff: &std::result::Result<PathBuf, String>,
    failed: Option<String>,
) -> Result<Child> {
    if let Some(folder) = paths.log.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)
        .with_context(|| format!("can't write {}", paths.log.display()))?;
    let mut command = Command::new(&paths.daemon);
    command
        .arg("serve")
        .arg("--teams-root")
        .arg(&paths.teams)
        .arg("--listen")
        .arg(format!("127.0.0.1:{port}"))
        // Held open by this app until it quits: see `Supervisor::stop`.
        .stdin(Stdio::piped())
        .stdout(log.try_clone()?)
        .stderr(log)
        .creation_flags(CREATE_NO_WINDOW)
        // If this app ends, LoomWatch stops too instead of running on unseen.
        .env("LOOMWATCH_EXIT_WITH_PARENT", "1")
        // So the update notice says how this copy is updated: by this app, or a new installer.
        .env("LOOMWATCH_INSTALL", "app");
    match handoff {
        Ok(request) => command
            .env(update::SUPERVISED_ENV, "1")
            .env(update::REQUEST_ENV, request)
            .env_remove(update::BLOCKED_ENV),
        Err(why) => command
            .env_remove(update::SUPERVISED_ENV)
            .env_remove(update::REQUEST_ENV)
            .env(update::BLOCKED_ENV, why),
    };
    match failed {
        Some(why) => command.env(update::FAILED_ENV, why),
        None => command.env_remove(update::FAILED_ENV),
    };
    if let Some(path) = path {
        command.env("PATH", path);
    }
    if let Some(commit) = &paths.commit {
        command.env("LOOMWATCH_COMMIT", commit);
    }
    command
        .spawn()
        .with_context(|| format!("can't start {}", paths.daemon.display()))
}

/// The `PATH` a new sign-in would have: the system's and this user's, as the registry holds them
/// now. This app may have been started before a tool an agent runs was installed (Python, say, at
/// sign-in), and its own `PATH` would then miss the folder the installer added, so the tool would
/// look missing.
fn sign_in_path() -> Option<OsString> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let read = |root, key: &str| -> Option<String> {
        RegKey::predef(root)
            .open_subkey(key)
            .ok()?
            .get_value::<String, _>("Path")
            .ok()
    };
    let system = read(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    )?;
    let user = read(HKEY_CURRENT_USER, "Environment").unwrap_or_default();
    let mut entries: Vec<PathBuf> = Vec::new();
    for entry in format!("{system};{user}").split(';') {
        let entry = expand(entry.trim());
        if !entry.is_empty()
            && !entries
                .iter()
                .any(|known| known.as_os_str() == entry.as_str())
        {
            entries.push(PathBuf::from(entry));
        }
    }
    // Anything this app was started with that the registry doesn't hold (a folder a terminal
    // added, say) still counts, after the registry's.
    if let Some(current) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&current) {
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
    }
    std::env::join_paths(entries).ok()
}

/// `text` with each `%NAME%` replaced by that environment variable, as Windows expands a `PATH`
/// entry such as `%USERPROFILE%\.local\bin`. An unknown name stays as written.
fn expand(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        if let Some(value) = std::env::var(name).ok().filter(|_| !name.is_empty()) {
            out.push_str(&value);
        } else {
            out.push('%');
            out.push_str(name);
            out.push('%');
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The port to try first: `LOOMWATCH_PORT`, as the `loomwatch` command reads it, or 3000.
fn first_port() -> u16 {
    std::env::var("LOOMWATCH_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(FIRST_PORT)
}

fn free_port() -> Option<u16> {
    let first = first_port();
    (first..=first.max(LAST_PORT)).find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

/// The address of a `LoomWatch` already answering on one of `ports`.
fn running_loomwatch(ports: std::ops::RangeInclusive<u16>) -> Option<String> {
    ports.into_iter().find_map(|port| {
        let body = get(port, "/api/about")?;
        (body.contains("\"startedAt\"") && body.contains("\"version\""))
            .then(|| format!("http://127.0.0.1:{port}"))
    })
}

fn wait_until_healthy(port: u16, slot: &Mutex<Option<Child>>) -> bool {
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if get(port, "/api/health").is_some_and(|body| body.trim() == "ok") {
            return true;
        }
        let exited = slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
            .is_none_or(|child| !matches!(child.try_wait(), Ok(None)));
        if exited {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// The body of a successful `GET` to `127.0.0.1:port`, or `None`. Plain HTTP/1.1, so the app
/// needs no HTTP client of its own.
fn get(port: u16, path: &str) -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.1 200").then(|| body.to_owned())
}

fn append_log(log: &Path, line: &str) {
    if let Some(folder) = log.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// "Start at sign-in": `LoomWatch.exe --background` under this user's Run key, which Windows
/// starts at each sign-in (and lists in Settings › Apps › Startup, where it can be turned off too).
mod login_item {
    use std::path::Path;

    use anyhow::Result;
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};

    use super::RUN_VALUE;

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    pub fn enabled() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(RUN_KEY, KEY_READ)
            .and_then(|key| key.get_value::<String, _>(RUN_VALUE))
            .is_ok()
    }

    pub fn set(on: bool, program: &Path) -> Result<()> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY)?;
        if on {
            key.set_value(RUN_VALUE, &command_line(program))?;
        } else if enabled() {
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)?
                .delete_value(RUN_VALUE)?;
        }
        Ok(())
    }

    /// What the Run key holds: the program in quotes, as its folder may have a space in it.
    pub fn command_line(program: &Path) -> String {
        format!("\"{}\" --background", program.display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_entries_name_environment_variables_as_windows_writes_them() {
        let profile = std::env::var("USERPROFILE").unwrap_or_default();
        assert_eq!(
            expand(r"%USERPROFILE%\.local\bin"),
            format!(r"{profile}\.local\bin")
        );
        assert_eq!(expand(r"C:\Tools"), r"C:\Tools");
        assert_eq!(
            expand("%LOOMWATCH_NOT_SET_ANYWHERE%\\x"),
            "%LOOMWATCH_NOT_SET_ANYWHERE%\\x"
        );
        assert_eq!(expand("50%"), "50%");
        assert_eq!(expand("%%"), "%%");
    }

    #[test]
    fn start_at_sign_in_quotes_a_folder_with_a_space() {
        assert_eq!(
            login_item::command_line(Path::new(
                r"C:\Users\Ana Li\AppData\Local\Programs\LoomWatch\LoomWatch.exe"
            )),
            r#""C:\Users\Ana Li\AppData\Local\Programs\LoomWatch\LoomWatch.exe" --background"#
        );
    }

    #[test]
    fn a_second_app_finds_the_first_ones_lock_held() {
        let state = std::env::temp_dir().join(format!("loomwatch-app-{}", std::process::id()));
        let first = only_one(&state).expect("the first one runs");
        assert!(only_one(&state).is_none(), "a second must not");
        drop(first);
        assert!(only_one(&state).is_some(), "the lock goes with the first");
        let _ = std::fs::remove_dir_all(&state);
    }
}

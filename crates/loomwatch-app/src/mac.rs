//! The macOS app: a menu-bar item over a supervised `loomwatchd`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIconBuilder};

/// The port a `LoomWatch` started from Terminal uses too, so the address people know keeps working.
const FIRST_PORT: u16 = 3000;
const LAST_PORT: u16 = 3020;
/// How long `loomwatchd` gets to answer after it starts, before the menu says it didn't.
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// Three stops this close together mean something is wrong that restarting won't fix.
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const CRASHES_BEFORE_GIVING_UP: usize = 3;
const LOGIN_ITEM_LABEL: &str = "io.github.loomwatch";

enum UserEvent {
    Menu(MenuEvent),
    /// `loomwatchd` answers at this address.
    Ready(String),
    /// What the menu's status line should say now.
    Status(String),
}

/// Where everything is.
#[derive(Clone)]
struct Paths {
    /// `LoomWatch.app`, when this program runs from inside one.
    bundle: Option<PathBuf>,
    daemon: PathBuf,
    teams: PathBuf,
    /// The demo team copied into a new teams folder.
    examples: Option<PathBuf>,
    log: PathBuf,
    /// What `/api/about` reports as the commit, from the bundle's `VERSION`.
    commit: Option<String>,
}

impl Paths {
    fn find() -> Result<Self> {
        let exe = std::env::current_exe()?.canonicalize()?;
        let macos = exe.parent().context("no folder for this program")?;
        let daemon = macos.join("loomwatchd");
        anyhow::ensure!(
            daemon.is_file(),
            "loomwatchd is missing from {}",
            macos.display()
        );
        let contents = macos.parent();
        let bundle = contents
            .and_then(Path::parent)
            .filter(|bundle| bundle.extension().is_some_and(|ext| ext == "app"))
            .map(Path::to_path_buf);
        let resources = contents.map(|contents| contents.join("Resources"));
        let home = PathBuf::from(std::env::var_os("HOME").context("no home folder")?);
        let commit = resources
            .as_ref()
            .and_then(|resources| std::fs::read_to_string(resources.join("VERSION")).ok())
            .and_then(|version| version.split_whitespace().nth(1).map(str::to_owned));
        Ok(Self {
            bundle,
            daemon,
            teams: home.join("LoomWatch/teams"),
            examples: resources.map(|resources| resources.join("examples")),
            log: home.join("Library/Logs/LoomWatch/loomwatchd.log"),
            commit,
        })
    }

    /// Make the teams folder the first time, with the offline demo team in it.
    fn ensure_teams(&self) -> Result<()> {
        if self.teams.is_dir() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.teams)?;
        if let Some(examples) = &self.examples {
            for name in ["operator-stop.yaml", "operator-stop-harness.py"] {
                let from = examples.join(name);
                if from.is_file() {
                    std::fs::copy(&from, self.teams.join(name))?;
                }
            }
        }
        Ok(())
    }
}

pub fn run() -> Result<()> {
    // Started at login: stay in the menu bar without opening the browser.
    let background = std::env::args().any(|arg| arg == "--background");
    let paths = Paths::find()?;
    paths.ensure_teams()?;

    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    // A menu-bar app: no Dock icon, no app menu.
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    let proxy = event_loop.create_proxy();
    {
        let proxy = proxy.clone();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = proxy.send_event(UserEvent::Menu(event));
        }));
    }

    let open = MenuItem::new("Open LoomWatch", true, None);
    let status = MenuItem::new("Starting…", false, None);
    let at_login = CheckMenuItem::new(
        "Start at login",
        paths.bundle.is_some(),
        login_item::enabled(),
        None,
    );
    let log = MenuItem::new("Show log", true, None);
    let quit = MenuItem::new("Quit LoomWatch", true, None);
    let menu = Menu::new();
    menu.append_items(&[
        &open,
        &status,
        &PredefinedMenuItem::separator(),
        &at_login,
        &log,
        &PredefinedMenuItem::separator(),
        &quit,
    ])?;

    let supervisor = Supervisor::start(paths.clone(), proxy);
    let mut menu = Some(menu);
    let mut tray = None;
    let mut address: Option<String> = None;
    let mut open_when_ready = !background;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            // The menu-bar item can only be made once the app is running.
            Event::NewEvents(StartCause::Init) => {
                if let Some(menu) = menu.take() {
                    tray = TrayIconBuilder::new()
                        .with_menu(Box::new(menu))
                        .with_icon_templated(menu_bar_icon())
                        .with_tooltip("LoomWatch")
                        .build()
                        .map_err(|error| eprintln!("LoomWatch: no menu-bar item: {error}"))
                        .ok();
                }
            }
            // Opened again from Applications or Spotlight while running: show it.
            Event::Reopen { .. } => match &address {
                Some(url) => open_in_browser(url),
                None => open_when_ready = true,
            },
            Event::UserEvent(UserEvent::Ready(url)) => {
                status.set_text("Running");
                if open_when_ready {
                    open_in_browser(&url);
                    open_when_ready = false;
                }
                address = Some(url);
            }
            Event::UserEvent(UserEvent::Status(text)) => status.set_text(text),
            Event::UserEvent(UserEvent::Menu(event)) => {
                if event.id == *open.id() {
                    match &address {
                        Some(url) => open_in_browser(url),
                        None => open_when_ready = true,
                    }
                } else if event.id == *at_login.id() {
                    if let Some(bundle) = &paths.bundle {
                        let wanted = !login_item::enabled();
                        if let Err(error) = login_item::set(wanted, bundle) {
                            eprintln!("LoomWatch: start at login: {error:#}");
                        }
                    }
                    at_login.set_checked(login_item::enabled());
                } else if event.id == *log.id() {
                    let _ = Command::new("/usr/bin/open").arg(&paths.log).status();
                } else if event.id == *quit.id() {
                    supervisor.stop();
                    tray.take();
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    })
}

fn open_in_browser(url: &str) {
    let _ = Command::new("/usr/bin/open").arg(url).status();
}

/// Keeps one `loomwatchd` running until [`Supervisor::stop`].
struct Supervisor {
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
}

impl Supervisor {
    fn start(paths: Paths, proxy: EventLoopProxy<UserEvent>) -> Self {
        let child = Arc::new(Mutex::new(None::<Child>));
        let stopping = Arc::new(AtomicBool::new(false));
        let supervisor = Self {
            child: Arc::clone(&child),
            stopping: Arc::clone(&stopping),
        };
        std::thread::spawn(move || supervise(&paths, &proxy, &child, &stopping));
        supervisor
    }

    /// Ask `loomwatchd` to finish (it cancels its runs), then make sure it has.
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(child) = child.as_mut() {
            let _ = Command::new("/bin/kill")
                .args(["-TERM", &child.id().to_string()])
                .status();
            let deadline = Instant::now() + Duration::from_secs(5);
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
    // Another LoomWatch already answers, started from Terminal, say: open that one, and don't
    // start a second that would run the same scheduled teams twice.
    if let Some(url) = running_loomwatch() {
        say("Running (started elsewhere)");
        let _ = proxy.send_event(UserEvent::Ready(url));
        return;
    }
    let path = login_shell_path();
    let mut stops: Vec<Instant> = Vec::new();
    loop {
        // One LoomWatch per run history: one started from Terminal on another port holds it.
        if history_in_use() {
            say("Already running from Terminal: stop it there, then open LoomWatch again");
            return;
        }
        let Some(port) = free_port() else {
            say("Can’t start: ports 3000–3020 are all in use");
            return;
        };
        let child = match start_daemon(paths, port, path.as_deref()) {
            Ok(child) => child,
            Err(error) => {
                say("Can’t start LoomWatch: see Show log");
                append_log(&paths.log, &format!("LoomWatch.app: {error:#}\n"));
                return;
            }
        };
        *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(child);
        let url = format!("http://127.0.0.1:{port}");
        if wait_until_healthy(port, slot) {
            let _ = proxy.send_event(UserEvent::Ready(url));
        } else if !stopping.load(Ordering::SeqCst) {
            say("Still starting… (see Show log)");
        }
        // Wait for it to stop.
        loop {
            if stopping.load(Ordering::SeqCst) {
                return;
            }
            let exited = slot
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_mut()
                .is_none_or(|child| matches!(child.try_wait(), Ok(Some(_)) | Err(_)));
            if exited {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if stopping.load(Ordering::SeqCst) {
            return;
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

/// Whether another `loomwatchd` holds the run history this app's would use: the daemon's own
/// default (`<state folder>/loomwatch.db`) unless `LOOMWATCH_DATABASE` or `LOOMWATCH_STATE_DIR`
/// says otherwise, locked by `<file>.lock` while a daemon uses it.
fn history_in_use() -> bool {
    let database = std::env::var_os("LOOMWATCH_DATABASE")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("LOOMWATCH_STATE_DIR")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| {
                        PathBuf::from(home).join("Library/Application Support/LoomWatch")
                    })
                })
                .map(|state| state.join("loomwatch.db"))
        });
    let Some(database) = database else {
        return false;
    };
    let mut lock = database.into_os_string();
    lock.push(".lock");
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(PathBuf::from(lock))
        .is_ok_and(|file| matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)))
}

fn start_daemon(paths: &Paths, port: u16, path: Option<&str>) -> Result<Child> {
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
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        // If this app is force-quit, LoomWatch stops too instead of running on unseen.
        .env("LOOMWATCH_EXIT_WITH_PARENT", "1")
        // So the update notice says how this copy is updated: a new .dmg.
        .env("LOOMWATCH_INSTALL", "app");
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

/// The `PATH` a Terminal window would have. An app opened from Finder gets only
/// `/usr/bin:/bin:/usr/sbin:/sbin`, which misses Homebrew and every per-user install folder, so
/// the AI apps someone installed would look missing.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let mut child = Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            let mut out = String::new();
            child.stdout.take()?.read_to_string(&mut out).ok()?;
            return (status.success() && !out.trim().is_empty()).then(|| out.trim().to_owned());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    Some("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_owned())
}

/// The port to try first: `LOOMWATCH_PORT`, as the `./loomwatch` launcher reads it, or 3000.
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

/// The address of a `LoomWatch` already answering on its usual port.
fn running_loomwatch() -> Option<String> {
    let port = first_port();
    let body = get(port, "/api/about")?;
    (body.contains("\"startedAt\"") && body.contains("\"version\""))
        .then(|| format!("http://127.0.0.1:{port}"))
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
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500)).ok()?;
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

/// The menu-bar image's size in pixels: twice the menu bar's 22 pt, so it is sharp on a Retina
/// screen. `tray-icon` shows an image taller than 22 pt at 22 pt.
const MENU_BAR_WIDTH: u16 = 36;
const MENU_BAR_HEIGHT: u16 = 44;

/// The mark, drawn for the menu bar: the tile of `docs/assets/brand/mark-small.svg` in black, with
/// its face and its running stitch cut out of it so the menu bar shows through them. macOS tints a
/// template image to suit the menu bar, so the gold has no colour of its own here.
fn menu_bar_icon() -> Icon {
    Icon::from_rgba(
        menu_bar_pixels(),
        u32::from(MENU_BAR_WIDTH),
        u32::from(MENU_BAR_HEIGHT),
    )
    .expect("menu-bar icon pixels")
}

/// The mark's RGBA pixels. Its tile is 16 × 16 pt inside the 18 × 22 pt image, about the size Apple
/// suggests for a menu-bar item, with the rest left clear.
fn menu_bar_pixels() -> Vec<u8> {
    // The tile is 32 px square, 2 px from each side and 6 px from the top and the bottom.
    const TILE: f32 = 32.0;
    const LEFT: f32 = 2.0;
    const TOP: f32 = 6.0;
    // mark-small.svg is drawn on a 512 grid; `at` maps one of its points into the image.
    let scale = TILE / 512.0;
    let at = |(x, y): (f32, f32)| (x.mul_add(scale, LEFT), y.mul_add(scale, TOP));
    // Each eye is a 70-wide pill: a line between its two round ends.
    let eyes = [
        [at((187.0, 181.0)), at((187.0, 261.0))],
        [at((325.0, 181.0)), at((325.0, 261.0))],
    ];
    // The mouth is a quadratic curve; six straight pieces are smooth at this size.
    let mouth: Vec<(f32, f32)> = (0..=6_u8)
        .map(|step| {
            let t = f32::from(step) / 6.0;
            let u = 1.0 - t;
            let along = |from: f32, bend: f32, to: f32| {
                (u * u).mul_add(from, (2.0 * u * t).mul_add(bend, t * t * to))
            };
            at((along(222.0, 256.0, 290.0), along(354.0, 382.0, 354.0)))
        })
        .collect();
    let stitches: Vec<Vec<(f32, f32)>> = stitch_lines()
        .iter()
        .map(|line| line.iter().copied().map(at).collect())
        .collect();
    let cover = |distance: f32, width: f32| (width * scale / 2.0 + 0.5 - distance).clamp(0.0, 1.0);
    let on_line = |line: &[(f32, f32)], point: (f32, f32)| {
        line.windows(2)
            .map(|pair| segment_distance(pair[0], pair[1], point))
            .fold(f32::INFINITY, f32::min)
    };
    let mut rgba =
        Vec::with_capacity(usize::from(MENU_BAR_WIDTH) * usize::from(MENU_BAR_HEIGHT) * 4);
    for y in 0..MENU_BAR_HEIGHT {
        for x in 0..MENU_BAR_WIDTH {
            let point = (f32::from(x) + 0.5, f32::from(y) + 0.5);
            let tile = (0.5 - rounded_square_distance(point, (LEFT, TOP), TILE, 112.0 * scale))
                .clamp(0.0, 1.0);
            let cut = eyes
                .iter()
                .map(|eye| cover(on_line(eye, point), 70.0))
                .chain(std::iter::once(cover(on_line(&mouth, point), 40.0)))
                .chain(
                    stitches
                        .iter()
                        .map(|line| cover(on_line(line, point), 26.0)),
                )
                .fold(0.0_f32, f32::max);
            let alpha = tile * (1.0 - cut);
            // `alpha` is clamped to 0..=1, so this fits a byte.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let alpha = (alpha * 255.0).round() as u8;
            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }
    rgba
}

/// The running stitch of mark-small.svg, on its 512 grid: 16 stitches round the square inset by 40
/// with 88-unit corners, each half a step long and the first centred on the top edge, as the SVG's
/// dash pattern draws them. Each stitch is a short line of points, so the ones on corners bend.
fn stitch_lines() -> Vec<Vec<(f32, f32)>> {
    const STITCHES: u8 = 16;
    let step = stitch_outline().iter().sum::<f32>() / f32::from(STITCHES);
    (0..STITCHES)
        .map(|stitch| {
            let middle = f32::from(stitch) * step;
            (0..=4_u8)
                .map(|part| stitch_point((f32::from(part) / 4.0 - 0.5).mul_add(step / 2.0, middle)))
                .collect()
        })
        .collect()
}

const STITCH_INSET: f32 = 40.0;
const STITCH_RADIUS: f32 = 88.0;

/// The lengths of the stitch's outline in the order its SVG path draws it, clockwise from the top's
/// midpoint: half the top edge, then a corner and a side three times, a corner, and the other half.
fn stitch_outline() -> [f32; 9] {
    let side = 2.0f32.mul_add(-(STITCH_INSET + STITCH_RADIUS), 512.0);
    let corner = std::f32::consts::FRAC_PI_2 * STITCH_RADIUS;
    [
        side / 2.0,
        corner,
        side,
        corner,
        side,
        corner,
        side,
        corner,
        side / 2.0,
    ]
}

/// The point `distance` along the stitch's outline.
fn stitch_point(distance: f32) -> (f32, f32) {
    use std::f32::consts::{FRAC_PI_2, PI};
    let pieces = stitch_outline();
    let (near, far) = (STITCH_INSET, 512.0 - STITCH_INSET);
    let (start, end) = (near + STITCH_RADIUS, far - STITCH_RADIUS);
    let mut left = distance.rem_euclid(pieces.iter().sum());
    let mut piece = 0;
    while piece < pieces.len() - 1 && left > pieces[piece] {
        left -= pieces[piece];
        piece += 1;
    }
    let arc = |(cx, cy): (f32, f32), from: f32| {
        let angle = from + left / STITCH_RADIUS;
        (
            STITCH_RADIUS.mul_add(angle.cos(), cx),
            STITCH_RADIUS.mul_add(angle.sin(), cy),
        )
    };
    match piece {
        0 => (256.0 + left, near),
        1 => arc((end, start), -FRAC_PI_2),
        2 => (far, start + left),
        3 => arc((end, end), 0.0),
        4 => (end - left, far),
        5 => arc((start, end), FRAC_PI_2),
        6 => (near, end - left),
        7 => arc((start, start), PI),
        _ => (start + left, near),
    }
}

/// How far `point` lies outside a square with rounded corners (negative inside).
fn rounded_square_distance(point: (f32, f32), corner: (f32, f32), size: f32, radius: f32) -> f32 {
    let half = size / 2.0;
    let (qx, qy) = (
        (point.0 - corner.0 - half).abs() - (half - radius),
        (point.1 - corner.1 - half).abs() - (half - radius),
    );
    qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - radius
}

fn segment_distance(a: (f32, f32), b: (f32, f32), p: (f32, f32)) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let length = dx.mul_add(dx, dy * dy);
    let t = if length == 0.0 {
        0.0
    } else {
        ((p.0 - a.0).mul_add(dx, (p.1 - a.1) * dy) / length).clamp(0.0, 1.0)
    };
    let (cx, cy) = (t.mul_add(dx, a.0), t.mul_add(dy, a.1));
    (p.0 - cx).hypot(p.1 - cy)
}

/// "Start at login": a launch agent that opens the app in the background at login.
mod login_item {
    use super::{LOGIN_ITEM_LABEL, Path, PathBuf, Result};

    fn plist() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|home| {
            PathBuf::from(home).join(format!("Library/LaunchAgents/{LOGIN_ITEM_LABEL}.plist"))
        })
    }

    pub fn enabled() -> bool {
        plist().is_some_and(|plist| plist.is_file())
    }

    pub fn set(on: bool, bundle: &Path) -> Result<()> {
        let plist = plist().ok_or_else(|| anyhow::anyhow!("no home folder"))?;
        if !on {
            if plist.is_file() {
                std::fs::remove_file(&plist)?;
            }
            return Ok(());
        }
        if let Some(folder) = plist.parent() {
            std::fs::create_dir_all(folder)?;
        }
        let bundle = escape(&bundle.to_string_lossy());
        std::fs::write(
            &plist,
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LOGIN_ITEM_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string><string>-g</string><string>-a</string><string>{bundle}</string>
    <string>--args</string><string>--background</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
"#
            ),
        )?;
        Ok(())
    }

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_bar_mark_is_about_sixteen_points_and_leaves_room_around_it() {
        let pixels = menu_bar_pixels();
        let (width, height) = (usize::from(MENU_BAR_WIDTH), usize::from(MENU_BAR_HEIGHT));
        assert_eq!(pixels.len(), width * height * 4);
        let inked = |x: usize, y: usize| pixels[(y * width + x) * 4 + 3] > 0;
        let rows: Vec<usize> = (0..height)
            .filter(|&y| (0..width).any(|x| inked(x, y)))
            .collect();
        let columns: Vec<usize> = (0..width)
            .filter(|&x| (0..height).any(|y| inked(x, y)))
            .collect();
        // Two pixels a point: the ink is at most 16 pt each way, and clear of the image's edges.
        let span = |lines: &[usize]| lines.last().unwrap() - lines.first().unwrap() + 1;
        assert!(span(&rows) <= 32, "{} px tall", span(&rows));
        assert!(span(&columns) <= 32, "{} px wide", span(&columns));
        assert!(rows.first().unwrap() >= &6 && rows.last().unwrap() < &(height - 6));
        assert!(columns.first().unwrap() >= &1 && columns.last().unwrap() < &(width - 1));
    }

    #[test]
    fn the_menu_bar_mark_shows_its_face_and_stitch_as_holes_in_the_tile() {
        let pixels = menu_bar_pixels();
        let alpha = |x: usize, y: usize| pixels[(y * usize::from(MENU_BAR_WIDTH) + x) * 4 + 3];
        // The middle of each eye, of the mouth and of the stitch on the top edge are clear...
        assert_eq!(alpha(13, 19), 0, "left eye");
        assert_eq!(alpha(22, 19), 0, "right eye");
        assert_eq!(alpha(18, 29), 0, "mouth");
        assert_eq!(alpha(18, 8), 0, "the stitch in the middle of the top edge");
        // ...and the tile around them is solid.
        assert_eq!(alpha(18, 19), 255, "between the eyes");
        assert_eq!(alpha(18, 33), 255, "below the mouth");
    }
}

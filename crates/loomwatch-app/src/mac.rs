//! The macOS app: a menu-bar item over a supervised `loomwatchd`, which shows what the teams are
//! doing. While agents work its stitch sews round and the menu names who is working; when something
//! needs you its mouth opens and the menu bar counts what waits.
//!
//! The teams live at the notch instead (ADR 0083): an island around a screen's notch, that pops
//! out when something happens and tucks into the menu bar beside the camera, and on every screen a
//! box to message an agent, at ⌃⌥Space or Message in the menu (`crate::island`,
//! `crate::notch_panel`). Wherever a screen has no notch, and with Show at the notch unticked in
//! the menu, the face is in the menu bar.
//!
//! It also updates itself: Update and restart in the app has `loomwatchd` stop for it, and it puts
//! the new release's `LoomWatch.app` in its own place and opens that (`crate::update`).

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use objc2::MainThreadMarker;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tray_icon::menu::accelerator::{Accelerator, Code, Modifiers};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::island::{self, FromPage};
use crate::notch_panel::{IslandEvent, NotchPanels};
use crate::progress::{self, Ended, Mood, Progress, Row};
use crate::update;

/// The port a `LoomWatch` started from Terminal uses too, so the address people know keeps working.
const FIRST_PORT: u16 = 3000;
const LAST_PORT: u16 = 3020;
/// How long `loomwatchd` gets to answer after it starts, before the menu says it didn't.
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// Three stops this close together mean something is wrong that restarting won't fix.
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const CRASHES_BEFORE_GIVING_UP: usize = 3;
const LOGIN_ITEM_LABEL: &str = "io.github.loomwatch";
/// How often the menu reads what the teams are doing.
const POLL: Duration = Duration::from_secs(2);
/// At work the face shows a new picture every `FRAME`. The stitch moves one stitch along in
/// `SEWING_FRAMES` of them (a stitch a second), and the eyes blink once every `BLINK_EVERY` (2.5 s).
const FRAME: Duration = Duration::from_millis(125);
const SEWING_FRAMES: u8 = 8;
const BLINK_EVERY: u32 = 20;
/// How often the island hears whether the person is away and whether an app is full screen.
const ISLAND_CHECK: Duration = Duration::from_secs(2);
/// While the left button is held in another app, how often the island looks for something being
/// dragged toward it: macOS stops telling other apps of the pointer once a drag of a file begins.
const DRAG_CHECK: Duration = Duration::from_millis(50);

enum UserEvent {
    Menu(MenuEvent),
    /// `loomwatchd` answers on this port.
    Ready(u16),
    /// What the menu's status line should say now.
    Status(String),
    /// What the teams are doing now.
    Progress(Progress),
    /// The menu-bar item was clicked, which opens its menu.
    Opened,
    /// The new version is open, after Update and restart: this one goes.
    Quit,
    /// Something for the island at the notch.
    Island(IslandEvent),
}

/// Where everything is.
#[derive(Clone)]
struct Paths {
    /// `LoomWatch.app`, when this program runs from inside one.
    bundle: Option<PathBuf>,
    daemon: PathBuf,
    teams: PathBuf,
    log: PathBuf,
    /// What `/api/about` reports as the commit, from the bundle's `VERSION`.
    commit: Option<String>,
    home: PathBuf,
    /// `loomwatchd`'s state folder: `LOOMWATCH_STATE_DIR`, or its own default.
    state: PathBuf,
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
        let state_dir = std::env::var_os("LOOMWATCH_STATE_DIR")
            .map(PathBuf::from)
            .filter(|state| state.is_absolute());
        // A state folder of its own, as for a trial, keeps the log with it, as on Windows.
        let log = state_dir.as_ref().map_or_else(
            || home.join("Library/Logs/LoomWatch/loomwatchd.log"),
            |state| state.join("Logs/loomwatchd.log"),
        );
        Ok(Self {
            bundle,
            daemon,
            teams: std::env::var_os("LOOMWATCH_TEAMS_ROOT")
                .map(PathBuf::from)
                .filter(|teams| teams.is_absolute())
                .unwrap_or_else(|| home.join("LoomWatch/teams")),
            log,
            commit,
            state: state_dir.unwrap_or_else(|| home.join("Library/Application Support/LoomWatch")),
            home,
        })
    }

    /// Where `loomwatchd` names the release Update and restart installs.
    fn update_request(&self) -> PathBuf {
        self.state.join("app-update-request")
    }

    /// Where an update is downloaded and its disk image opened. Emptied before and after.
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

#[allow(clippy::too_many_lines)] // Every event the app answers, in one loop, as on Windows.
pub fn run() -> Result<()> {
    // Started at login: stay in the menu bar without opening the browser.
    let background = std::env::args().any(|arg| arg == "--background");
    let paths = Paths::find()?;
    paths.ensure_teams()?;

    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    // A menu-bar app: no Dock icon, no app menu.
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    let proxy = event_loop.create_proxy();
    forward_events(&proxy);
    let island_proxy = proxy.clone();

    let (items, menu) = Items::new(&paths)?;
    let mut bar = Bar::new(&menu);
    let supervisor = Supervisor::start(paths.clone(), proxy.clone());
    let watched = Arc::new(AtomicU16::new(0));
    {
        let watched = Arc::clone(&watched);
        std::thread::spawn(move || watch_runs(&watched, &proxy));
    }
    // The same menu, shown where the island is right-clicked.
    let island_menu = menu.clone();
    let mut menu = Some(menu);
    let mut island: Option<Island> = None;
    let mut address: Option<String> = None;
    let mut open_when_ready = !background;

    event_loop.run(move |event, _, control_flow| {
        match event {
            // The menu-bar item can only be made once the app is running.
            Event::NewEvents(StartCause::Init) => {
                if let Some(menu) = menu.take() {
                    bar.build(menu);
                }
                island = Island::start(&island_proxy, &paths.state);
                bar.set_visible(island.as_ref().is_none_or(Island::face_shows));
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                bar.tick();
                if let Some(island) = island.as_mut() {
                    island.tick();
                }
            }
            // Opened again from Applications or Spotlight while running: show it.
            Event::Reopen { .. } => match &address {
                Some(url) => open_in_browser(url),
                None => open_when_ready = true,
            },
            Event::UserEvent(UserEvent::Ready(port)) => {
                let url = format!("http://127.0.0.1:{port}");
                items.status.set_text("LoomWatch is running");
                watched.store(port, Ordering::SeqCst);
                if open_when_ready {
                    open_in_browser(&url);
                    open_when_ready = false;
                }
                if let Some(island) = island.as_mut() {
                    island.panel.load(&url);
                }
                address = Some(url);
            }
            Event::UserEvent(UserEvent::Island(event)) => {
                if let Some(island) = island.as_mut() {
                    let named = matches!(
                        event,
                        IslandEvent::Page {
                            message: FromPage::Agent { .. },
                            ..
                        }
                    );
                    island.on(event, address.as_deref(), &island_menu);
                    bar.set_visible(island.face_shows());
                    if named {
                        items.show_agent(island);
                    }
                }
            }
            Event::UserEvent(UserEvent::Status(text)) => items.status.set_text(text),
            Event::UserEvent(UserEvent::Progress(next)) => bar.show(next),
            Event::UserEvent(UserEvent::Opened) => bar.seen(),
            Event::UserEvent(UserEvent::Quit) => {
                supervisor.stop();
                bar.remove();
                *control_flow = ControlFlow::Exit;
                return;
            }
            Event::UserEvent(UserEvent::Menu(event)) => {
                if let Some(link) = bar.link_for(&event.id) {
                    if let Some(url) = &address {
                        open_in_browser(&format!("{url}{link}"));
                    }
                } else if event.id == *items.message.id() {
                    if let Some(island) = island.as_mut() {
                        island.compose();
                    }
                } else if event.id == *items.open.id() {
                    match &address {
                        Some(url) => open_in_browser(url),
                        None => open_when_ready = true,
                    }
                } else if event.id == *items.at_login.id() {
                    items.switch_start_at_login(&paths);
                } else if event.id == *items.notch.id() {
                    if let Some(island) = island.as_mut() {
                        island.switch();
                        items.notch.set_checked(island.panel.shown());
                        items.show_agent(island);
                        bar.set_visible(island.face_shows());
                    }
                } else if event.id == *items.log.id() {
                    let _ = Command::new("/usr/bin/open").arg(&paths.log).status();
                } else if event.id == *items.quit.id() {
                    supervisor.stop();
                    bar.remove();
                    *control_flow = ControlFlow::Exit;
                    return;
                }
            }
            _ => {}
        }
        // Sleep until something happens, the face next moves or the island next checks.
        *control_flow = [bar.wakes_at(), island.as_ref().and_then(Island::wakes_at)]
            .into_iter()
            .flatten()
            .min()
            .map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
    })
}

/// The island at the notch and the box on every screen (ADR 0083), and when they next check
/// whether the person is away and an app is full screen.
struct Island {
    panel: NotchPanels,
    /// The state folder, where Show at the notch is kept.
    state: PathBuf,
    next_check: Instant,
    /// The agent the box opens with, by name: with none there is nothing for ⌃⌥Space to open.
    agent: Option<String>,
    /// The left button is held in another app: a drag of something may be under way.
    pressing: bool,
}

impl Island {
    /// Made once the app runs, on its main thread: a panel on every screen while Show at the notch
    /// is ticked (kept in `state`), and the screens watched either way.
    fn start(proxy: &EventLoopProxy<UserEvent>, state: &Path) -> Option<Self> {
        let mtm = MainThreadMarker::new()?;
        let proxy = proxy.clone();
        let mut panel = NotchPanels::new(mtm, island::shown(state), move |event| {
            let _ = proxy.send_event(UserEvent::Island(event));
        });
        panel.place();
        Some(Self {
            panel,
            state: state.to_owned(),
            next_check: Instant::now(),
            agent: None,
            pressing: false,
        })
    }

    /// ⌃⌥Space, or Message in the menu: the box opens on the screen the pointer is on, with its
    /// agent; with no agent there is nothing to open.
    fn compose(&mut self) {
        if self.agent.is_some() {
            self.panel.compose();
        }
    }

    /// Show at the notch, ticked or unticked: the panels come, or they go; either way it stays so
    /// the next time.
    fn switch(&mut self) {
        let shown = !self.panel.shown();
        if let Err(error) = island::set_shown(&self.state, shown) {
            eprintln!("LoomWatch: show at the notch: {error}");
        }
        self.panel.set_shown(shown);
    }

    /// The menu bar face is wanted: wherever a screen has no notch, or with no island at all.
    fn face_shows(&self) -> bool {
        self.panel.face_shows()
    }

    fn tick(&mut self) {
        if self.pressing {
            self.pressing = self.panel.poll_drag();
        }
        if Instant::now() >= self.next_check {
            self.panel.tick();
            self.next_check = Instant::now() + ISLAND_CHECK;
        }
    }

    /// With no island there is nothing to check, until a drag begun before it went ends.
    fn wakes_at(&self) -> Option<Instant> {
        if self.pressing {
            Some(self.next_check.min(Instant::now() + DRAG_CHECK))
        } else {
            self.panel.any_island().then_some(self.next_check)
        }
    }

    /// What the island's page, the pointer and the screens ask of the app. `origin` is
    /// `loomwatchd`'s address, once it answers.
    fn on(&mut self, event: IslandEvent, origin: Option<&str>, menu: &Menu) {
        let panel = &mut self.panel;
        match event {
            IslandEvent::Page { from, message } => match message {
                FromPage::Ready => panel.page_ready(from),
                FromPage::Areas { rects } => panel.set_areas(from, rects),
                FromPage::Open { link } => {
                    if let Some(url) = origin.and_then(|origin| island::app_address(origin, &link))
                    {
                        open_in_browser(&url);
                    }
                }
                FromPage::Menu { .. } => panel.show_menu(from, menu),
                FromPage::Keyboard { on: true } => panel.take_keyboard(from),
                FromPage::Keyboard { on: false } => panel.give_back_keyboard(from),
                FromPage::Agent { name } => self.agent = name,
                FromPage::Copy { text, html } => NotchPanels::copy(&text, html.as_deref()),
                FromPage::Seen { runs } => panel.seen(from, &runs),
            },
            IslandEvent::PageGone { from } => panel.page_gone(from),
            IslandEvent::Shortcut => self.compose(),
            IslandEvent::PressStarted => {
                self.pressing = true;
                panel.press_started();
            }
            IslandEvent::PressEnded => {
                self.pressing = false;
                panel.press_ended();
            }
            IslandEvent::Pointer => panel.pointer(),
            IslandEvent::ClickOutside => panel.click_outside(),
            IslandEvent::Screens => panel.place(),
        }
    }
}

/// Clicks on the menu and on the menu-bar item, as events on the app's loop.
fn forward_events(proxy: &EventLoopProxy<UserEvent>) {
    let menu = proxy.clone();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu.send_event(UserEvent::Menu(event));
    }));
    let item = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |event| {
        if matches!(
            event,
            TrayIconEvent::Click {
                button_state: MouseButtonState::Down,
                ..
            }
        ) {
            let _ = item.send_event(UserEvent::Opened);
        }
    }));
}

/// The menu's own items, which are always there.
struct Items {
    /// Message <agent>…: the box, as ⌃⌥Space opens it.
    message: MenuItem,
    open: MenuItem,
    status: MenuItem,
    at_login: CheckMenuItem,
    /// Show at the notch: the island, or, unticked, the face in the menu bar.
    notch: CheckMenuItem,
    log: MenuItem,
    quit: MenuItem,
}

impl Items {
    fn new(paths: &Paths) -> Result<(Self, Menu)> {
        let items = Self {
            message: MenuItem::new(
                MESSAGE_NO_AGENT,
                false,
                Some(Accelerator::new(
                    Modifiers::CONTROL | Modifiers::ALT,
                    Code::Space,
                )),
            ),
            open: MenuItem::new("Open LoomWatch", true, None),
            status: MenuItem::new("Starting…", false, None),
            at_login: CheckMenuItem::new(
                "Start at login",
                paths.bundle.is_some(),
                login_item::enabled(),
                None,
            ),
            notch: CheckMenuItem::new("Show at the notch", true, island::shown(&paths.state), None),
            log: MenuItem::new("Show log", true, None),
            quit: MenuItem::new("Quit LoomWatch", true, None),
        };
        let menu = Menu::new();
        menu.append_items(&[
            &items.message,
            &items.open,
            &items.status,
            &PredefinedMenuItem::separator(),
            &items.at_login,
            &items.notch,
            &PredefinedMenuItem::separator(),
            &items.log,
            &PredefinedMenuItem::separator(),
            &items.quit,
        ])?;
        Ok((items, menu))
    }

    /// Start at login, switched the other way.
    fn switch_start_at_login(&self, paths: &Paths) {
        if let Some(bundle) = &paths.bundle {
            let wanted = !login_item::enabled();
            if let Err(error) = login_item::set(wanted, bundle) {
                eprintln!("LoomWatch: start at login: {error:#}");
            }
        }
        self.at_login.set_checked(login_item::enabled());
    }

    /// Message <agent>…, as the box would open now: greyed with no agent to message, and with
    /// Show at the notch unticked, when there is no box.
    fn show_agent(&self, island: &Island) {
        self.message.set_text(message_row(island.agent.as_deref()));
        self.message
            .set_enabled(island.agent.is_some() && island.panel.shown());
    }
}

/// The menu's first row before the box has an agent, or with none in My agents.
const MESSAGE_NO_AGENT: &str = "Message an agent…";

/// The menu's first row: whom ⌃⌥Space opens the box to.
fn message_row(agent: Option<&str>) -> String {
    agent.map_or_else(
        || MESSAGE_NO_AGENT.to_owned(),
        |name| format!("Message {name}…"),
    )
}

/// The menu-bar item, and what it shows of the teams' work: the face, the count of what waits on
/// you beside it, a tooltip, and the menu's rows under the status line.
struct Bar {
    tray: Option<TrayIcon>,
    /// Whether the face is wanted: wherever a screen has no notch, and with no island.
    visible: bool,
    faces: Faces,
    face: Face,
    shown: Progress,
    work: WorkSection,
}

impl Bar {
    fn new(menu: &Menu) -> Self {
        Self {
            tray: None,
            visible: true,
            faces: Faces::draw(),
            face: Face::default(),
            shown: Progress::default(),
            // Under Message, "Open LoomWatch" and the status line.
            work: WorkSection::new(menu.clone(), 3),
        }
    }

    fn build(&mut self, menu: Menu) {
        self.tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_icon_templated(self.faces.get(Picture::Asleep).clone())
            .with_tooltip("LoomWatch")
            .build()
            .map_err(|error| eprintln!("LoomWatch: no menu-bar item: {error}"))
            .ok();
        if let Some(tray) = &self.tray {
            let _ = tray.set_visible(self.visible);
        }
    }

    /// Show the face in the menu bar, or take it out while the island at the notch does its work.
    /// Asked after anything the island hears, so it changes only when it is told otherwise.
    fn set_visible(&mut self, visible: bool) {
        if visible == self.visible {
            return;
        }
        self.visible = visible;
        if let Some(tray) = &self.tray {
            let _ = tray.set_visible(visible);
        }
    }

    fn show(&mut self, next: Progress) {
        self.work.show(&next.rows());
        if let Some(tray) = &self.tray {
            // The menu bar counts what waits on you, as the browser tab's title does.
            let waiting = next.needs_you.len();
            tray.set_title((waiting > 0).then(|| waiting.to_string()));
            let _ = tray.set_tooltip(Some(next.summary()));
        }
        self.face.update(&self.shown, &next, Instant::now());
        self.show_face();
        self.shown = next;
    }

    fn tick(&mut self) {
        if self.face.tick(Instant::now()) {
            self.show_face();
        }
    }

    /// The menu is open: whatever finished has been seen.
    fn seen(&mut self) {
        if self.face.seen() {
            self.show_face();
        }
    }

    fn show_face(&self) {
        if let Some(tray) = &self.tray {
            let picture = self.face.picture();
            let icon = self.faces.get(picture).clone();
            // Asleep it is a template, in the menu bar's own ink; awake it shows its colour.
            let _ = if picture == Picture::Asleep {
                tray.set_icon_templated(Some(icon))
            } else {
                tray.set_icon(Some(icon))
            };
        }
    }

    fn wakes_at(&self) -> Option<Instant> {
        self.face.wakes_at()
    }

    fn link_for(&self, id: &MenuId) -> Option<&str> {
        self.work.link_for(id)
    }

    fn remove(&mut self) {
        self.tray.take();
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

/// The menu's rows about the teams' work, between the status line and the settings.
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

/// What the menu-bar face is doing, and when it next moves.
#[derive(Default)]
struct Face {
    mood: Mood,
    /// Runs that ended since the menu was last opened, and how. The face winks at a finished one,
    /// and shows one that failed in red, until you look. A cancelled run is not news.
    news: BTreeMap<String, Ended>,
    /// Pictures shown since the team started working; the stitch and the blink both follow it.
    frame: u32,
    next_frame: Option<Instant>,
    /// macOS's Reduce motion is on: at work the face keeps still, and its colour says it.
    still: bool,
}

impl Face {
    fn update(&mut self, before: &Progress, after: &Progress, now: Instant) {
        let mood = after.mood();
        if mood == Mood::Working && self.mood != Mood::Working {
            self.still = reduce_motion();
            // It wakes with a blink.
            self.frame = 0;
        }
        self.mood = mood;
        self.next_frame =
            (mood == Mood::Working && !self.still).then(|| self.next_frame.unwrap_or(now + FRAME));
        self.news.extend(
            after
                .ended_since(before)
                .filter(|(_, how)| how.is_news())
                .map(|(run, how)| (run.to_owned(), how)),
        );
        // News lasts as long as the menu lists the run, as it ended by now: a run that stopped is
        // no longer news once the schedule is trying it again.
        self.news.retain(
            |run, how| match after.how_ended(run).filter(|now| now.is_news()) {
                Some(now) => {
                    *how = now;
                    true
                }
                None => false,
            },
        );
    }

    /// The menu was opened. Returns whether there was news to put away.
    fn seen(&mut self) -> bool {
        let had = !self.news.is_empty();
        self.news.clear();
        had
    }

    /// Move on when it is time. Returns whether the picture changed.
    fn tick(&mut self, now: Instant) -> bool {
        if self.next_frame.is_some_and(|at| at <= now) {
            self.frame = self.frame.wrapping_add(1);
            self.next_frame = Some(now + FRAME);
            return true;
        }
        false
    }

    fn wakes_at(&self) -> Option<Instant> {
        self.next_frame
    }

    fn picture(&self) -> Picture {
        match self.mood {
            Mood::Asking => Picture::Asking,
            Mood::Working if self.still => Picture::Working {
                frame: 0,
                eyes: Eye::Open,
            },
            Mood::Working => Picture::Working {
                frame: u8::try_from(self.frame % u32::from(SEWING_FRAMES)).unwrap_or(0),
                eyes: blink(self.frame),
            },
            Mood::Idle if self.news.values().any(|how| *how == Ended::Failed) => Picture::Stopped,
            Mood::Idle if !self.news.is_empty() => Picture::Winking,
            Mood::Idle => Picture::Asleep,
        }
    }
}

/// Where the eyes are in their blink, `frame` pictures into the work: half shut, shut, half shut,
/// then open until the next one.
const fn blink(frame: u32) -> Eye {
    match frame % BLINK_EVERY {
        0 | 2 => Eye::Half,
        1 => Eye::Shut,
        _ => Eye::Open,
    }
}

/// Which of the [`Faces`] shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Picture {
    /// Nothing under way: eyes shut, in the menu bar's own ink.
    Asleep,
    /// A team at work, in blue: one picture of the stitch sewing round (of [`SEWING_FRAMES`]) and
    /// of the eyes' blink.
    Working { frame: u8, eyes: Eye },
    /// Something waits on you: gold, its mouth open.
    Asking,
    /// A run stopped with an error: red, crosses for eyes, until you open the menu.
    Stopped,
    /// A run finished: jade, winking, until you open the menu.
    Winking,
}

/// Whether Reduce motion is on in System Settings › Accessibility › Display.
fn reduce_motion() -> bool {
    Command::new("/usr/bin/defaults")
        .args(["read", "com.apple.universalaccess", "reduceMotion"])
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == "1")
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
    if let Some(port) = running_loomwatch() {
        let _ = proxy.send_event(UserEvent::Ready(port));
        say("LoomWatch is running (started elsewhere)");
        return;
    }
    let path = login_shell_path();
    let mut stops: Vec<Instant> = Vec::new();
    // Why the last Update and restart did not finish, for the next start to say.
    let mut failed: Option<String> = None;
    update::mac::clear(&paths.update_work());
    loop {
        // One LoomWatch per run history: one started from Terminal on another port holds it.
        if history_in_use(&paths.state) {
            say("Already running from Terminal: stop it there, then quit and reopen LoomWatch");
            return;
        }
        let Some(port) = free_port() else {
            say("Can’t start: ports 3000–3020 are all in use");
            return;
        };
        let request = paths.update_request();
        let _ = std::fs::remove_file(&request);
        // Update and restart is offered only when this app can put the new version in its place.
        let handoff = can_update(paths).map(|()| request);
        let started = start_daemon(paths, port, path.as_deref(), &handoff, failed.take());
        let child = match started {
            Ok(child) => child,
            Err(error) => {
                say("Can’t start LoomWatch: see Show log");
                append_log(&paths.log, &format!("LoomWatch.app: {error:#}\n"));
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
            let log = |line: &str| append_log(&paths.log, &format!("LoomWatch.app: {line}\n"));
            match update_app(paths, &say, &log) {
                Ok(bundle) => match update::mac::open_again(&bundle, &log) {
                    Ok(()) => {
                        let _ = proxy.send_event(UserEvent::Quit);
                        return;
                    }
                    // The new loomwatchd is in place: this app starts it instead.
                    Err(why) => log(&why),
                },
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

/// Whether another `loomwatchd` holds the run history this app's would use: the daemon's own
/// default (`<state folder>/loomwatch.db`) unless `LOOMWATCH_DATABASE` says otherwise, locked by
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

/// Whether this app can put a new version in its own place, or why not, which the updates dialog
/// shows beside the steps to do it by hand.
fn can_update(paths: &Paths) -> std::result::Result<(), String> {
    let bundle = paths.bundle.as_deref().ok_or_else(|| {
        "This LoomWatch isn’t running from LoomWatch.app, so it can’t replace itself.".to_owned()
    })?;
    update::mac::can_replace(bundle)
}

/// After `loomwatchd` stopped for Update and restart: downloads the release it named, saves a copy
/// of the run history, and puts the new `LoomWatch.app` in this one's place. Returns the app to
/// open, or why nothing was changed.
fn update_app(
    paths: &Paths,
    say: &dyn Fn(&str),
    log: &dyn Fn(&str),
) -> std::result::Result<PathBuf, String> {
    let current = env!("CARGO_PKG_VERSION");
    let release = update::requested(&paths.update_request(), current)?;
    can_update(paths)?;
    let bundle = paths.bundle.clone().unwrap_or_default();
    let base = update::download_base(&release)?;
    log(&format!(
        "updating {current} to {} from {base}",
        release.version
    ));
    let work = paths.update_work();
    update::mac::clear(&work);
    let installed = (|| {
        say(&format!("Downloading LoomWatch {}…", release.version));
        let dmg = update::download(&base, "LoomWatch-macos.dmg", &work, log)?;
        say("Saving a copy of the run history…");
        let backups = update::backup_folder(&paths.home);
        if let Some(copy) = update::back_up(&paths.daemon, &backups, current, log)? {
            log(&format!(
                "saved a copy of the run history in {}",
                copy.display()
            ));
        }
        say(&format!("Installing LoomWatch {}…", release.version));
        update::mac::put_in_place(&dmg, &bundle, &release.version, &work, log)
    })();
    update::mac::clear(&work);
    installed?;
    log(&format!(
        "LoomWatch {} is in place; {current} is kept beside it",
        release.version
    ));
    Ok(bundle)
}

fn start_daemon(
    paths: &Paths,
    port: u16,
    path: Option<&str>,
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
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        // If this app is force-quit, LoomWatch stops too instead of running on unseen.
        .env("LOOMWATCH_EXIT_WITH_PARENT", "1")
        // So the update notice says how this copy is updated: by this app, or a new .dmg.
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

/// The port of a `LoomWatch` already answering on its usual one.
fn running_loomwatch() -> Option<u16> {
    let port = first_port();
    let body = get(port, "/api/about")?;
    (body.contains("\"startedAt\"") && body.contains("\"version\"")).then_some(port)
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

/// The frame the face is sewn into, in the image's pixels: a 14.2 pt square in the middle of the
/// image, with rounded corners, drawn as a running stitch of 3 px stitches; with the stitches'
/// width it comes to 16 pt.
const FRAME_LEFT: f32 = 3.8;
const FRAME_TOP: f32 = 7.8;
const FRAME_SIZE: f32 = 28.4;
const FRAME_RADIUS: f32 = 6.9;
const STITCHES: u8 = 12;
const STITCH_WIDTH: f32 = 3.0;
/// How much of each stitch's step is thread; round ends make it look longer.
const STITCH_LENGTH: f32 = 0.4;

/// One picture of the face.
#[derive(Clone, Copy, Default)]
struct Pose {
    /// How far the stitch has sewn round, in stitches; a whole stitch looks as it started.
    sewn: f32,
    /// The left eye and the right one, as you look at it.
    eyes: [Eye; 2],
    mouth: Mouth,
    ink: Ink,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Eye {
    #[default]
    Open,
    Half,
    Shut,
    /// An X: the run failed.
    Cross,
}

/// The eyes through a blink, in the order of the working pictures drawn for each.
const BLINKS: [Eye; 3] = [Eye::Open, Eye::Half, Eye::Shut];

/// What the face is drawn in: the colours the crew's figures glow in the app
/// (`ui/src/styles/team-chat.css`), blue while one works, gold while one waits for you, jade when
/// it is done and red when it failed. Awake, macOS shows the colour as it is on a light menu bar
/// or a dark one, so each is the tone of the app's palette that reads on both (about 3:1): the
/// palette's own `blue-500` and `gold-500`, and jade and red halfway between their light-theme
/// and dark-theme tones. Colour is never the only sign: the eyes and the mouth say the same.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Ink {
    /// Black, for a template image that macOS tints to suit the menu bar.
    #[default]
    MenuBar,
    Live,
    Accent,
    Ok,
    Alert,
}

impl Ink {
    const fn rgb(self) -> [u8; 3] {
        match self {
            Self::MenuBar => [0, 0, 0],
            Self::Live => [0x2F, 0x7D, 0xD3],
            Self::Accent => [0xAD, 0x8A, 0x20],
            Self::Ok => [0x33, 0x9D, 0x6B],
            Self::Alert => [0xD9, 0x4B, 0x45],
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Mouth {
    /// The weft stitch, smiling.
    #[default]
    Smile,
    /// An "o": something needs you.
    Open,
}

/// Every picture the menu bar shows, drawn once.
struct Faces {
    asleep: Icon,
    asking: Icon,
    stopped: Icon,
    winking: Icon,
    /// Each sewing frame with the eyes open, half shut and shut.
    working: Vec<[Icon; 3]>,
}

impl Faces {
    fn get(&self, picture: Picture) -> &Icon {
        match picture {
            Picture::Asleep => &self.asleep,
            Picture::Asking => &self.asking,
            Picture::Stopped => &self.stopped,
            Picture::Winking => &self.winking,
            Picture::Working { frame, eyes } => {
                let blink = BLINKS.iter().position(|eye| *eye == eyes).unwrap_or(0);
                &self.working[usize::from(frame)][blink]
            }
        }
    }

    fn draw() -> Self {
        let awake = Pose::default();
        Self {
            asleep: icon(Pose {
                eyes: [Eye::Shut; 2],
                ..awake
            }),
            asking: icon(Pose {
                mouth: Mouth::Open,
                ink: Ink::Accent,
                ..awake
            }),
            stopped: icon(Pose {
                eyes: [Eye::Cross; 2],
                mouth: Mouth::Open,
                ink: Ink::Alert,
                ..awake
            }),
            winking: icon(Pose {
                eyes: [Eye::Open, Eye::Shut],
                ink: Ink::Ok,
                ..awake
            }),
            working: (0..SEWING_FRAMES)
                .map(|frame| {
                    BLINKS.map(|eye| {
                        icon(Pose {
                            sewn: f32::from(frame) / f32::from(SEWING_FRAMES),
                            eyes: [eye; 2],
                            ink: Ink::Live,
                            ..awake
                        })
                    })
                })
                .collect(),
        }
    }
}

fn icon(pose: Pose) -> Icon {
    Icon::from_rgba(
        menu_bar_pixels(pose),
        u32::from(MENU_BAR_WIDTH),
        u32::from(MENU_BAR_HEIGHT),
    )
    .expect("menu-bar icon pixels")
}

/// The mark drawn for the menu bar as a line drawing, the way macOS draws its own items: the face
/// of `docs/assets/brand/mark-small.svg` (two pill eyes and a smiling stitch) inside its running
/// stitch, without the dark tile, so it sits as lightly as its neighbours.
fn menu_bar_pixels(pose: Pose) -> Vec<u8> {
    let stitches = stitch_lines(pose.sewn);
    // Each eye is drawn in lines with round ends, each with its half-width: upright and open, as
    // wide but squashed half shut, flat when shut, and two crossing lines for an X.
    let eye = |x: f32, eye: Eye| match eye {
        Eye::Open => vec![([(x, 16.2), (x, 21.4)], 2.4)],
        Eye::Half => vec![([(x - 0.8, 19.6), (x + 0.8, 19.6)], 1.6)],
        Eye::Shut => vec![([(x - 2.4, 20.0), (x + 2.4, 20.0)], 1.1)],
        Eye::Cross => vec![
            ([(x - 2.1, 16.9), (x + 2.1, 21.1)], 1.1),
            ([(x - 2.1, 21.1), (x + 2.1, 16.9)], 1.1),
        ],
    };
    let eyes: Vec<([(f32, f32); 2], f32)> = eye(13.6, pose.eyes[0])
        .into_iter()
        .chain(eye(22.4, pose.eyes[1]))
        .collect();
    let [red, green, blue] = pose.ink.rgb();
    let smile = quadratic((14.4, 28.4), (18.0, 31.0), (21.6, 28.4));
    // How much of a pixel lies within `radius` of a shape `distance` from its middle.
    let cover = |distance: f32, radius: f32| (radius + 0.5 - distance).clamp(0.0, 1.0);
    let mut rgba =
        Vec::with_capacity(usize::from(MENU_BAR_WIDTH) * usize::from(MENU_BAR_HEIGHT) * 4);
    for y in 0..MENU_BAR_HEIGHT {
        for x in 0..MENU_BAR_WIDTH {
            let point = (f32::from(x) + 0.5, f32::from(y) + 0.5);
            let mouth = match pose.mouth {
                Mouth::Smile => cover(line_distance(&smile, point), 1.4),
                Mouth::Open => cover((point.0 - 18.0).hypot(point.1 - 29.4), 2.3),
            };
            let ink = stitches
                .iter()
                .map(|line| cover(line_distance(line, point), STITCH_WIDTH / 2.0))
                .chain(
                    eyes.iter()
                        .map(|([a, b], radius)| cover(segment_distance(*a, *b, point), *radius)),
                )
                .fold(mouth, f32::max);
            // `ink` is clamped to 0..=1, so this fits a byte.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let alpha = (ink * 255.0).round() as u8;
            rgba.extend_from_slice(&[red, green, blue, alpha]);
        }
    }
    rgba
}

/// A quadratic curve from `from` to `to`, bent towards `bend`, as points along it; six straight
/// pieces are smooth at this size.
fn quadratic(from: (f32, f32), bend: (f32, f32), to: (f32, f32)) -> Vec<(f32, f32)> {
    (0..=6_u8)
        .map(|step| {
            let t = f32::from(step) / 6.0;
            let u = 1.0 - t;
            let along = |from: f32, bend: f32, to: f32| {
                (u * u).mul_add(from, (2.0 * u * t).mul_add(bend, t * t * to))
            };
            (along(from.0, bend.0, to.0), along(from.1, bend.1, to.1))
        })
        .collect()
}

/// The frame's stitches, each a short line of points so the ones on corners bend: [`STITCHES`]
/// evenly round the outline, the first centred on the top edge, then moved `sewn` stitches on.
fn stitch_lines(sewn: f32) -> Vec<Vec<(f32, f32)>> {
    let step = outline_pieces().iter().sum::<f32>() / f32::from(STITCHES);
    (0..STITCHES)
        .map(|stitch| {
            let middle = (f32::from(stitch) + sewn) * step;
            (0..=4_u8)
                .map(|part| {
                    outline_point(
                        (f32::from(part) / 4.0 - 0.5).mul_add(step * STITCH_LENGTH, middle),
                    )
                })
                .collect()
        })
        .collect()
}

/// The lengths of the frame's outline, clockwise from the middle of its top edge: half the top
/// edge, then a corner and a side three times, a corner, and the other half.
fn outline_pieces() -> [f32; 9] {
    let side = 2.0f32.mul_add(-FRAME_RADIUS, FRAME_SIZE);
    let corner = std::f32::consts::FRAC_PI_2 * FRAME_RADIUS;
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

/// The point `distance` clockwise along the frame's outline from the middle of its top edge.
fn outline_point(distance: f32) -> (f32, f32) {
    use std::f32::consts::{FRAC_PI_2, PI};
    let pieces = outline_pieces();
    let (left, top) = (FRAME_LEFT, FRAME_TOP);
    let (right, bottom) = (FRAME_LEFT + FRAME_SIZE, FRAME_TOP + FRAME_SIZE);
    let radius = FRAME_RADIUS;
    let mut along = distance.rem_euclid(pieces.iter().sum());
    let mut piece = 0;
    while piece < pieces.len() - 1 && along > pieces[piece] {
        along -= pieces[piece];
        piece += 1;
    }
    let arc = |(cx, cy): (f32, f32), from: f32| {
        let angle = from + along / radius;
        (
            radius.mul_add(angle.cos(), cx),
            radius.mul_add(angle.sin(), cy),
        )
    };
    match piece {
        0 => (left + FRAME_SIZE / 2.0 + along, top),
        1 => arc((right - radius, top + radius), -FRAC_PI_2),
        2 => (right, top + radius + along),
        3 => arc((right - radius, bottom - radius), 0.0),
        4 => (right - radius - along, bottom),
        5 => arc((left + radius, bottom - radius), FRAC_PI_2),
        6 => (left, bottom - radius - along),
        7 => arc((left + radius, top + radius), PI),
        _ => (left + radius + along, top),
    }
}

/// How far `point` is from a line of straight pieces.
fn line_distance(line: &[(f32, f32)], point: (f32, f32)) -> f32 {
    line.windows(2)
        .map(|pair| segment_distance(pair[0], pair[1], point))
        .fold(f32::INFINITY, f32::min)
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

    const WIDTH: usize = MENU_BAR_WIDTH as usize;

    #[test]
    fn the_menus_first_row_names_the_agent_the_box_opens_with() {
        assert_eq!(message_row(Some("Maya")), "Message Maya…");
        assert_eq!(message_row(None), "Message an agent…");
    }

    fn alpha(pixels: &[u8], x: usize, y: usize) -> u8 {
        pixels[(y * WIDTH + x) * 4 + 3]
    }

    #[test]
    fn the_menu_bar_mark_is_about_sixteen_points_and_leaves_room_around_it() {
        let pixels = menu_bar_pixels(Pose::default());
        let (width, height) = (WIDTH, usize::from(MENU_BAR_HEIGHT));
        assert_eq!(pixels.len(), width * height * 4);
        let inked = |x: usize, y: usize| alpha(&pixels, x, y) > 0;
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
        assert!(rows.first().unwrap() >= &5 && rows.last().unwrap() < &(height - 5));
        assert!(columns.first().unwrap() >= &1 && columns.last().unwrap() < &(width - 1));
    }

    #[test]
    fn the_face_is_sewn_into_a_frame_of_stitches_with_no_tile_behind_it() {
        let pixels = menu_bar_pixels(Pose::default());
        let alpha = |x, y| alpha(&pixels, x, y);
        assert_eq!(alpha(13, 18), 255, "left eye");
        assert_eq!(alpha(22, 18), 255, "right eye");
        assert_eq!(alpha(15, 28), 255, "the smile");
        assert_eq!(
            alpha(18, 7),
            255,
            "the stitch in the middle of the top edge"
        );
        assert_eq!(alpha(22, 7), 0, "the gap before the next stitch");
        // Nothing fills the frame: the menu bar shows through between the eyes and round the face.
        assert_eq!(alpha(18, 18), 0, "between the eyes");
        assert_eq!(alpha(8, 22), 0, "beside the face");
    }

    #[test]
    fn its_eyes_open_half_shut_and_shut_and_its_mouth_opens_when_something_needs_you() {
        let awake = menu_bar_pixels(Pose::default());
        let asking = menu_bar_pixels(Pose {
            mouth: Mouth::Open,
            ..Pose::default()
        });
        assert_eq!(alpha(&asking, 14, 28), 0, "no smile");
        assert_eq!(alpha(&asking, 18, 29), 255, "an o");
        assert_eq!(alpha(&awake, 18, 26), 0);
        assert!(alpha(&asking, 18, 27) > 0, "taller than the smile");

        let half = menu_bar_pixels(Pose {
            eyes: [Eye::Half; 2],
            ..Pose::default()
        });
        let shut = menu_bar_pixels(Pose {
            eyes: [Eye::Shut; 2],
            ..Pose::default()
        });
        assert_eq!(alpha(&awake, 13, 15), 255, "an open eye is tall");
        assert_eq!(alpha(&half, 13, 15), 0, "half shut, it is shorter");
        assert_eq!(alpha(&half, 13, 19), 255);
        assert_eq!(alpha(&shut, 13, 17), 0, "shut, it is a line");
        assert_eq!(alpha(&shut, 11, 19), 255, "across");

        let winking = menu_bar_pixels(Pose {
            eyes: [Eye::Open, Eye::Shut],
            ..Pose::default()
        });
        assert_eq!(alpha(&winking, 13, 15), 255, "one eye open");
        assert_eq!(alpha(&winking, 22, 15), 0, "the other shut");
        assert_eq!(alpha(&winking, 21, 19), 255, "to a line");

        let crossed = menu_bar_pixels(Pose {
            eyes: [Eye::Cross; 2],
            ..Pose::default()
        });
        assert_eq!(alpha(&crossed, 13, 18), 255, "an X crosses in the middle");
        assert_eq!(alpha(&crossed, 11, 17), 255, "out to its corners");
        assert_eq!(alpha(&half, 11, 17), 0);
        assert_eq!(alpha(&crossed, 13, 15), 0, "no taller than it is wide");
    }

    #[test]
    fn awake_it_is_drawn_in_its_colour_and_asleep_in_the_menu_bar_s_ink() {
        let colour = |ink: Ink| {
            let pixels = menu_bar_pixels(Pose {
                ink,
                ..Pose::default()
            });
            // The middle of the left eye.
            let at = (18 * WIDTH + 13) * 4;
            assert_eq!(pixels[at + 3], 255);
            [pixels[at], pixels[at + 1], pixels[at + 2]]
        };
        assert_eq!(colour(Ink::MenuBar), [0, 0, 0]);
        assert_eq!(colour(Ink::Live), [0x2F, 0x7D, 0xD3]);
        assert_eq!(colour(Ink::Accent), [0xAD, 0x8A, 0x20]);
        assert_eq!(colour(Ink::Ok), [0x33, 0x9D, 0x6B]);
        assert_eq!(colour(Ink::Alert), [0xD9, 0x4B, 0x45]);
    }

    #[test]
    fn the_stitch_sews_round_and_comes_back_to_where_it_started() {
        let start = menu_bar_pixels(Pose::default());
        let halfway = menu_bar_pixels(Pose {
            sewn: 0.5,
            ..Pose::default()
        });
        let round = menu_bar_pixels(Pose {
            sewn: 1.0,
            ..Pose::default()
        });
        assert_eq!(alpha(&halfway, 18, 7), 0, "the top stitch has moved on");
        assert_eq!(alpha(&halfway, 22, 7), 255, "into the gap");
        // A whole stitch on, every stitch stands where the next one stood: the same picture.
        assert!(
            start.iter().zip(&round).all(|(a, b)| a.abs_diff(*b) <= 1),
            "the last picture leads back into the first"
        );
        // Only the stitch moves: the face is the same in every picture.
        let face = |pixels: &[u8]| -> Vec<u8> {
            (12..33)
                .flat_map(|y| (10..26).map(move |x| (x, y)))
                .map(|(x, y)| alpha(pixels, x, y))
                .collect()
        };
        assert_eq!(face(&start), face(&halfway));
    }

    fn progress_of(records: serde_json::Value) -> Progress {
        let runs: Vec<progress::Record> = serde_json::from_value(records).unwrap();
        progress::progress(&runs, chrono::Utc::now())
    }

    /// One run, `status`, with `working` agents at work.
    fn record(status: &str, working: &[&str]) -> serde_json::Value {
        let at = chrono::Utc::now().to_rfc3339();
        serde_json::json!([{"runId": "r", "teamPath": "t.yaml", "status": status,
            "createdAt": at, "finishedAt": at, "working": working}])
    }

    #[test]
    fn it_sleeps_blinks_while_a_team_works_and_winks_when_the_work_is_done() {
        let quiet = Progress::default();
        let now = Instant::now();
        let mut face = Face::default();
        face.update(&quiet, &quiet, now);
        assert_eq!(face.picture(), Picture::Asleep);
        assert_eq!(face.wakes_at(), None, "asleep it never wakes the app");
        assert!(!face.tick(now + Duration::from_secs(5)));

        let working = progress_of(record("running", &["a"]));
        face.update(&quiet, &working, now);
        if face.still {
            // Reduce motion is on here: blue and still, and it never wakes the app.
            assert_eq!(
                face.picture(),
                Picture::Working {
                    frame: 0,
                    eyes: Eye::Open
                }
            );
            assert_eq!(face.wakes_at(), None);
        } else {
            // It wakes with a blink, then keeps its eyes open while the stitch sews round, and
            // blinks again every BLINK_EVERY pictures.
            let mut seen = vec![face.picture()];
            for step in 1..=u32::from(SEWING_FRAMES) * 3 {
                let at = now + FRAME * step;
                assert_eq!(face.wakes_at(), Some(at));
                assert!(face.tick(at));
                seen.push(face.picture());
            }
            let eyes: Vec<Eye> = seen
                .iter()
                .map(|picture| match picture {
                    Picture::Working { eyes, .. } => *eyes,
                    other => panic!("{other:?} while working"),
                })
                .collect();
            assert_eq!(eyes[..4], [Eye::Half, Eye::Shut, Eye::Half, Eye::Open]);
            assert!(eyes[3..20].iter().all(|eye| *eye == Eye::Open));
            assert_eq!(eyes[20..23], [Eye::Half, Eye::Shut, Eye::Half]);
            assert_eq!(
                seen[9],
                Picture::Working {
                    frame: 1,
                    eyes: Eye::Open
                },
                "the stitch comes round every SEWING_FRAMES pictures"
            );
        }

        // Done: it winks in jade until the menu is opened, and then goes back to sleep.
        let done = progress_of(record("succeeded", &[]));
        face.update(&working, &done, now);
        assert_eq!(face.picture(), Picture::Winking);
        assert_eq!(face.wakes_at(), None);
        face.update(&done, &done, now);
        assert_eq!(face.picture(), Picture::Winking, "until you look");
        assert!(face.seen());
        assert_eq!(face.picture(), Picture::Asleep);
        assert!(!face.seen(), "nothing more to put away");
    }

    #[test]
    fn a_failed_run_shows_until_it_leaves_the_list_and_a_cancelled_one_is_not_news() {
        let working = progress_of(record("running", &["a"]));
        let now = Instant::now();

        let mut face = Face::default();
        let failed = progress_of(record("failed", &[]));
        face.update(&working, &failed, now);
        assert_eq!(face.picture(), Picture::Stopped);
        // The run leaves the menu's list (an hour on): the news goes with it.
        face.update(&failed, &Progress::default(), now);
        assert_eq!(face.picture(), Picture::Asleep);

        let mut face = Face::default();
        let cancelled = progress_of(record("cancelled", &[]));
        face.update(&working, &cancelled, now);
        assert_eq!(face.picture(), Picture::Asleep);
    }

    /// A routine's run that couldn't reach its AI is not shown in red while the schedule tries it
    /// again, even when the menu first read it a moment before the schedule said so.
    #[test]
    fn a_run_the_schedule_tries_again_is_not_shown_stopped() {
        let working = progress_of(record("running", &["a"]));
        let at = chrono::Utc::now().to_rfc3339();
        let retrying = progress_of(serde_json::json!([{"runId": "r", "teamPath": "t.yaml",
            "status": "failed", "trigger": "schedule", "createdAt": at, "finishedAt": at,
            "nextTryAt": at}]));
        let now = Instant::now();

        let mut face = Face::default();
        face.update(&working, &retrying, now);
        assert_eq!(face.picture(), Picture::Asleep);

        let mut face = Face::default();
        face.update(&working, &progress_of(record("failed", &[])), now);
        assert_eq!(face.picture(), Picture::Stopped);
        face.update(&progress_of(record("failed", &[])), &retrying, now);
        assert_eq!(
            face.picture(),
            Picture::Asleep,
            "it is being tried again: no longer news"
        );
    }
}

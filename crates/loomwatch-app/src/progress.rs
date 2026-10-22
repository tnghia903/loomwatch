//! What the menu bar says about the teams' work: which agents are working right now, what waits
//! on you, and what finished lately. Read from `GET /api/runs` (docs/WATCH.md), and kept apart
//! from the menu itself so it is the same wherever a menu shows it.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::Deserialize;

/// How far back the menu lists finished runs.
const FINISHED_WINDOW_SECONDS: u64 = 60 * 60;
/// At most this many lines in each part of the menu, so a busy day does not fill the screen. The
/// rest are still counted, and one more line opens the app's Home, which lists them all.
const LINES_SHOWN: usize = 5;

/// The daemon's address for what the menu shows: runs under way, and those that finished within
/// [`FINISHED_WINDOW_SECONDS`]. A `loomwatchd` too old to know `finishedWithin` sends every run,
/// which reads the same.
pub fn runs_path() -> String {
    format!("/api/runs?preview=true&finishedWithin={FINISHED_WINDOW_SECONDS}")
}

/// The parts of a run record the menu reads.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    run_id: String,
    team_path: String,
    #[serde(default)]
    team_name: Option<String>,
    status: String,
    created_at: String,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    finished_at: Option<String>,
    #[serde(default)]
    working: Vec<String>,
    #[serde(default)]
    agent_names: BTreeMap<String, String>,
    #[serde(default)]
    waiting_on: Option<WaitingOn>,
    #[serde(default)]
    permission_requests: Vec<PermissionRequest>,
    /// The run, or one of its agents, used what it may spend and waits for you to add more or
    /// finish.
    #[serde(default)]
    spend_stops: Vec<SpendStop>,
    /// `schedule` for a routine's run.
    #[serde(default)]
    trigger: String,
    /// The run this one tries again from the start.
    #[serde(default)]
    retry_of_run_id: Option<String>,
    /// When the schedule tries this run again, after it couldn't reach its AI source.
    #[serde(default)]
    next_try_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitingOn {
    /// The agent asking a question; for a review stop, the stop's own name ("You").
    #[serde(default)]
    name: String,
    /// `question`, or `review_stop`.
    #[serde(default)]
    kind: String,
    /// The agent whose work a review stop is reviewing.
    #[serde(default)]
    handover_from: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PermissionRequest {
    #[serde(default)]
    name: String,
    /// What the agent's app calls the action: "Web search", "Bash".
    #[serde(default)]
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpendStop {
    /// The agent whose own limit it is; absent for the team's.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    limit_usd: f64,
}

/// One line of the menu, about one run, which opens that run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub run_id: String,
    /// Where the line opens in the app: [`run_link`].
    pub link: String,
    pub text: String,
}

/// One row of the menu: a line that opens its run, or a heading (`link` is `None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub text: String,
    /// The app's address for the row's run, after its origin.
    pub link: Option<String>,
}

/// The app's address for a run, after its origin: the run's team, open on that run, which is
/// where a question or a review waits for its answer. The same address the app's own "Open run"
/// links use (`historyRunUrl` in ui/src/lib/runs/history.ts). Without `path` the app has no team
/// to open and shows Home.
pub fn run_link(team_path: &str, run_id: &str) -> String {
    let path = if team_path.is_empty() {
        String::new()
    } else {
        format!("path={}&", query_value(team_path))
    };
    format!("/?{path}run={}", query_value(run_id))
}

/// `value` with every byte but the unreserved ones percent-encoded, so a team in a folder
/// (`news/daily.yaml`) or with spaces in its name survives the address.
fn query_value(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// What the face in the menu bar does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mood {
    /// Nothing under way: it sleeps.
    #[default]
    Idle,
    /// A team is working: it blinks, and the stitch sews round.
    Working,
    /// Something waits on you: its mouth opens.
    Asking,
}

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    Finished,
    Failed,
    /// Stopped by someone, which needs nobody's attention.
    Cancelled,
    /// Couldn't reach its AI source, and the schedule tries it again soon: nobody needs to do
    /// anything yet.
    TryingAgain,
}

impl Ended {
    fn from_status(status: &str) -> Option<Self> {
        match status {
            "succeeded" => Some(Self::Finished),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    const fn words(self) -> &'static str {
        match self {
            Self::Finished => "finished",
            Self::Failed => "stopped with an error",
            Self::Cancelled => "stopped",
            Self::TryingAgain => "couldn't connect, trying again soon",
        }
    }

    /// Whether the face tells of it until you look: not a run stopped by someone, nor one the
    /// schedule tries again.
    pub const fn is_news(self) -> bool {
        matches!(self, Self::Finished | Self::Failed)
    }
}

/// Everything the menu shows about the work, at one moment.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Progress {
    pub needs_you: Vec<Line>,
    pub working: Vec<Line>,
    pub finished: Vec<Line>,
    /// The runs under way, to tell when one finishes.
    live: BTreeSet<String>,
    /// How each run that ended in the window ended.
    ended: BTreeMap<String, Ended>,
}

impl Progress {
    /// Something waiting on you outranks a team at work, as on the header's mark.
    pub fn mood(&self) -> Mood {
        if !self.needs_you.is_empty() {
            Mood::Asking
        } else if self.live.is_empty() {
            Mood::Idle
        } else {
            Mood::Working
        }
    }

    /// The runs under way in `before` that have ended by now, and how each ended.
    pub fn ended_since<'a>(&'a self, before: &'a Self) -> impl Iterator<Item = (&'a str, Ended)> {
        self.ended
            .iter()
            .filter(|(run, _)| before.live.contains(*run))
            .map(|(run, ended)| (run.as_str(), *ended))
    }

    /// How `run` ended, when it is one of the runs that ended within the window.
    pub fn how_ended(&self, run: &str) -> Option<Ended> {
        self.ended.get(run).copied()
    }

    /// The menu's rows: a heading over each part that has lines, or one line saying all is quiet.
    pub fn rows(&self) -> Vec<Row> {
        let parts = [
            ("Needs you", &self.needs_you),
            ("Working now", &self.working),
            ("Finished in the last hour", &self.finished),
        ];
        let mut rows = Vec::new();
        for (heading, lines) in parts {
            if lines.is_empty() {
                continue;
            }
            rows.push(Row {
                text: heading.to_owned(),
                link: None,
            });
            rows.extend(lines.iter().take(LINES_SHOWN).map(|line| Row {
                text: line.text.clone(),
                link: Some(line.link.clone()),
            }));
            if lines.len() > LINES_SHOWN {
                // LoomWatch's Home lists every one of them.
                rows.push(Row {
                    text: format!("{} more in LoomWatch", lines.len() - LINES_SHOWN),
                    link: Some("/".to_owned()),
                });
            }
        }
        if rows.is_empty() {
            rows.push(Row {
                text: "No team is working right now".to_owned(),
                link: None,
            });
        }
        rows
    }

    /// One sentence for the menu bar item's tooltip.
    pub fn summary(&self) -> String {
        let first = self.needs_you.first().or_else(|| self.working.first());
        match (first, self.needs_you.len() + self.working.len()) {
            (None, _) => "LoomWatch".to_owned(),
            (Some(line), 1) => line.text.clone(),
            (Some(line), count) => format!("{} (and {} more)", line.text, count - 1),
        }
    }
}

/// What `runs` (as `GET /api/runs` lists them, newest first) come to at `now`.
pub fn progress(runs: &[Record], now: DateTime<Utc>) -> Progress {
    let mut progress = Progress::default();
    let mut finished: Vec<(DateTime<Utc>, Line)> = Vec::new();
    // Runs the schedule tried again: the newer try says how that job went.
    let tried_again: BTreeSet<&str> = runs
        .iter()
        .filter(|run| run.trigger == "schedule")
        .filter_map(|run| run.retry_of_run_id.as_deref())
        .collect();
    for run in runs {
        let team = team_label(run);
        let line = |text: String| Line {
            run_id: run.run_id.clone(),
            link: run_link(&run.team_path, &run.run_id),
            text: format!("{team}: {text}"),
        };
        if let Some(how) = Ended::from_status(&run.status) {
            if tried_again.contains(run.run_id.as_str()) {
                continue;
            }
            let how = if how == Ended::Failed && run.next_try_at.is_some() {
                Ended::TryingAgain
            } else {
                how
            };
            progress.ended.insert(run.run_id.clone(), how);
            if let Some(at) = run.finished_at.as_deref().and_then(parse) {
                let words = how.words();
                finished.push((at, line(format!("{words} · {}", ago(now - at)))));
            }
            continue;
        }
        progress.live.insert(run.run_id.clone());
        let name = |id: &String| run.agent_names.get(id).unwrap_or(id).clone();
        for request in &run.permission_requests {
            progress.needs_you.push(line(format!(
                "{} asks to use {}",
                request.name, request.title
            )));
        }
        for stop in &run.spend_stops {
            let limit = format!("${:.2}", stop.limit_usd);
            progress.needs_you.push(line(match &stop.name {
                Some(name) => format!("{name} used its {limit}: add more, or stop it"),
                None => format!("used its {limit}: add more, or finish"),
            }));
        }
        if let Some(waiting) = run.waiting_on.as_ref().filter(|_| run.status == "running") {
            progress.needs_you.push(line(if waiting.kind == "question" {
                format!("{} has a question for you", waiting.name)
            } else if let Some(from) = &waiting.handover_from {
                format!("{}’s work is waiting for your review", name(from))
            } else {
                "waiting for your review".to_owned()
            }));
        }
        let asking = !run.permission_requests.is_empty()
            || !run.spend_stops.is_empty()
            || run.waiting_on.is_some();
        let since = run
            .started_at
            .as_deref()
            .and_then(parse)
            .or_else(|| parse(&run.created_at))
            .map(|start| format!(" · {}", elapsed(now - start)))
            .unwrap_or_default();
        let names: Vec<String> = run.working.iter().map(name).collect();
        let doing = match (names.as_slice(), run.status.as_str()) {
            ([], _) if asking => continue,
            ([], "queued") => "waiting to start".to_owned(),
            ([], "starting") => format!("starting{since}"),
            ([], _) => format!("working{since}"),
            ([one], _) => format!("{one} is working{since}"),
            (many, _) => format!("{} are working{since}", and_list(many)),
        };
        progress.working.push(line(doing));
    }
    finished.sort_by_key(|(ended, _)| std::cmp::Reverse(*ended));
    progress.finished = finished.into_iter().map(|(_, line)| line).collect();
    progress
}

/// The team's name, or its file's name without the folder and `.yaml`, as the app's own lists
/// fall back to it.
fn team_label(run: &Record) -> String {
    run.team_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map_or_else(
            || {
                let file = run.team_path.rsplit('/').next().unwrap_or(&run.team_path);
                file.trim_end_matches(".yaml")
                    .trim_end_matches(".yml")
                    .to_owned()
            },
            str::to_owned,
        )
}

/// "Researcher and Writer", "Researcher, Writer and Editor", "Researcher, Writer and 2 others".
fn and_list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [first, second] => format!("{first} and {second}"),
        [first, second, third] => format!("{first}, {second} and {third}"),
        [first, second, rest @ ..] => format!("{first}, {second} and {} others", rest.len()),
    }
}

fn parse(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// How long a run has been going: "under a minute", "4 min", "1 h 5 min".
fn elapsed(span: chrono::TimeDelta) -> String {
    match span.num_minutes() {
        ..=0 => "under a minute".to_owned(),
        minutes @ 1..=59 => format!("{minutes} min"),
        minutes if minutes % 60 == 0 => format!("{} h", minutes / 60),
        minutes => format!("{} h {} min", minutes / 60, minutes % 60),
    }
}

/// How long ago a run finished: "just now", "5 min ago", "1 h ago".
fn ago(span: chrono::TimeDelta) -> String {
    match span.num_minutes() {
        ..=0 => "just now".to_owned(),
        minutes @ 1..=59 => format!("{minutes} min ago"),
        minutes => format!("{} h ago", minutes / 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        parse("2026-10-17T10:00:00.000Z").unwrap()
    }

    fn runs(records: serde_json::Value) -> Vec<Record> {
        serde_json::from_value(records).unwrap()
    }

    fn texts(lines: &[Line]) -> Vec<&str> {
        lines.iter().map(|line| line.text.as_str()).collect()
    }

    /// The point of it: the menu names the agent at work right now, by the name the team gave it.
    #[test]
    fn it_names_the_agents_working_now() {
        let progress = progress(
            &runs(json!([
                {"runId": "r1", "teamPath": "research.yaml", "teamName": "Research team",
                 "status": "running", "createdAt": "2026-10-17T09:55:00.000Z",
                 "startedAt": "2026-10-17T09:56:00.000Z", "working": ["researcher"],
                 "agentNames": {"researcher": "Researcher", "writer": "Writer"}},
                {"runId": "r2", "teamPath": "news/daily.yaml", "status": "running",
                 "createdAt": "2026-10-17T08:50:00.000Z", "working": ["a", "b", "c", "d"],
                 "agentNames": {"a": "Ana", "b": "Bo"}},
                {"runId": "r3", "teamPath": "q.yaml", "status": "queued",
                 "createdAt": "2026-10-17T10:00:00.000Z"}
            ])),
            now(),
        );
        assert_eq!(
            texts(&progress.working),
            [
                "Research team: Researcher is working · 4 min",
                // No team name: the file's name. An agent the record has no name for: its id.
                "daily: Ana, Bo and 2 others are working · 1 h 10 min",
                "q: waiting to start",
            ]
        );
        assert_eq!(progress.working[0].run_id, "r1");
        assert_eq!(progress.mood(), Mood::Working);
        assert!(progress.needs_you.is_empty());
        assert_eq!(
            progress.summary(),
            "Research team: Researcher is working · 4 min (and 2 more)"
        );
    }

    #[test]
    fn what_waits_on_you_comes_first_and_opens_the_mouth() {
        let progress = progress(
            &runs(json!([
                {"runId": "r1", "teamPath": "t.yaml", "teamName": "Trip", "status": "running",
                 "createdAt": "2026-10-17T09:00:00.000Z",
                 "waitingOn": {"node": "check", "name": "You", "kind": "review_stop",
                              "handoverFrom": "e"}, "agentNames": {"e": "Editor"}},
                {"runId": "r2", "teamPath": "u.yaml", "teamName": "Docs", "status": "running",
                 "createdAt": "2026-10-17T09:00:00.000Z", "working": ["w"],
                 "agentNames": {"w": "Writer", "s": "Searcher"},
                 "permissionRequests": [{"name": "Searcher", "title": "Web search"}],
                 "waitingOn": {"name": "Writer", "kind": "question"}}
            ])),
            now(),
        );
        assert_eq!(
            texts(&progress.needs_you),
            [
                "Trip: Editor’s work is waiting for your review",
                "Docs: Searcher asks to use Web search",
                "Docs: Writer has a question for you",
            ]
        );
        // A run that only waits on you is not also "working"; one with an agent still at work is.
        assert_eq!(texts(&progress.working), ["Docs: Writer is working · 1 h"]);
        assert_eq!(progress.mood(), Mood::Asking);
        assert_eq!(
            progress.summary(),
            "Trip: Editor’s work is waiting for your review (and 3 more)"
        );
    }

    #[test]
    fn finished_runs_are_listed_newest_first_and_a_finish_is_noticed() {
        let before = progress(
            &runs(json!([
                {"runId": "r1", "teamPath": "t.yaml", "status": "running",
                 "createdAt": "2026-10-17T09:50:00.000Z", "working": ["a"]}
            ])),
            now(),
        );
        let after = progress(
            &runs(json!([
                {"runId": "r1", "teamPath": "t.yaml", "status": "succeeded",
                 "createdAt": "2026-10-17T09:50:00.000Z", "finishedAt": "2026-10-17T09:59:30.000Z"},
                {"runId": "r0", "teamPath": "u.yaml", "status": "failed",
                 "createdAt": "2026-10-17T09:00:00.000Z", "finishedAt": "2026-10-17T09:20:00.000Z"},
                {"runId": "rx", "teamPath": "v.yaml", "status": "cancelled",
                 "createdAt": "2026-10-17T08:00:00.000Z", "finishedAt": "2026-10-17T08:30:00.000Z"}
            ])),
            now(),
        );
        assert_eq!(
            texts(&after.finished),
            [
                "t: finished · just now",
                "u: stopped with an error · 40 min ago",
                "v: stopped · 1 h ago",
            ]
        );
        assert_eq!(after.mood(), Mood::Idle);
        assert_eq!(
            after.ended_since(&before).collect::<Vec<_>>(),
            [("r1", Ended::Finished)],
            "r1 was under way and is done; the others ended before anyone saw them"
        );
        assert_eq!(
            after.ended_since(&after).count(),
            0,
            "nothing ended between two reads"
        );
        assert_eq!(after.how_ended("rx"), Some(Ended::Cancelled));
        assert_eq!(before.how_ended("r1"), None);
        assert_eq!(after.summary(), "LoomWatch");
    }

    /// A routine's run that couldn't reach its AI waits for the schedule to try it again: it is
    /// not "stopped with an error". Once tried again, the newer try speaks for that job.
    #[test]
    fn a_routine_run_the_schedule_tries_again_is_not_an_error() {
        let waiting = progress(
            &runs(json!([
                {"runId": "t1", "teamPath": "brief.yaml", "teamName": "Weekday AI brief",
                 "status": "failed", "trigger": "schedule", "createdAt": "2026-10-17T09:58:00.000Z",
                 "finishedAt": "2026-10-17T09:58:07.000Z", "nextTryAt": "2026-10-17T09:59:07.000Z"}
            ])),
            now(),
        );
        assert_eq!(
            texts(&waiting.finished),
            ["Weekday AI brief: couldn't connect, trying again soon · 1 min ago"]
        );
        assert_eq!(waiting.how_ended("t1"), Some(Ended::TryingAgain));
        assert!(!Ended::TryingAgain.is_news());

        let answered = progress(
            &runs(json!([
                {"runId": "t2", "teamPath": "brief.yaml", "teamName": "Weekday AI brief",
                 "status": "succeeded", "trigger": "schedule", "retryOfRunId": "t1",
                 "createdAt": "2026-10-17T09:59:08.000Z", "finishedAt": "2026-10-17T09:59:40.000Z"},
                {"runId": "t1", "teamPath": "brief.yaml", "teamName": "Weekday AI brief",
                 "status": "failed", "trigger": "schedule", "createdAt": "2026-10-17T09:58:00.000Z",
                 "finishedAt": "2026-10-17T09:58:07.000Z"}
            ])),
            now(),
        );
        assert_eq!(
            texts(&answered.finished),
            ["Weekday AI brief: finished · just now"]
        );
        assert_eq!(answered.how_ended("t1"), None);

        // Your own Try again of it is yours: the run you tried again still stopped with an error.
        let yours = progress(
            &runs(json!([
                {"runId": "t2", "teamPath": "brief.yaml", "status": "running", "trigger": "manual",
                 "retryOfRunId": "t1", "createdAt": "2026-10-17T09:59:08.000Z", "working": ["a"]},
                {"runId": "t1", "teamPath": "brief.yaml", "status": "failed", "trigger": "schedule",
                 "createdAt": "2026-10-17T09:58:00.000Z", "finishedAt": "2026-10-17T09:58:07.000Z"}
            ])),
            now(),
        );
        assert_eq!(yours.how_ended("t1"), Some(Ended::Failed));

        // The last try, with none to come, is an error like any other.
        let gave_up = progress(
            &runs(json!([
                {"runId": "t1", "teamPath": "brief.yaml", "status": "failed", "trigger": "schedule",
                 "createdAt": "2026-10-17T09:58:00.000Z", "finishedAt": "2026-10-17T09:58:07.000Z"}
            ])),
            now(),
        );
        assert_eq!(gave_up.how_ended("t1"), Some(Ended::Failed));
    }

    #[test]
    fn the_menu_heads_each_part_and_says_when_all_is_quiet() {
        let quiet = Progress::default().rows();
        assert_eq!(quiet.len(), 1);
        assert_eq!(quiet[0].text, "No team is working right now");
        assert_eq!(quiet[0].link, None, "not a line that opens anything");

        let busy = progress(
            &runs(json!([
                {"runId": "r1", "teamPath": "t.yaml", "status": "running",
                 "createdAt": "2026-10-17T09:59:00.000Z", "working": ["a"],
                 "agentNames": {"a": "Researcher"}},
                {"runId": "r0", "teamPath": "u.yaml", "status": "succeeded",
                 "createdAt": "2026-10-17T09:00:00.000Z", "finishedAt": "2026-10-17T09:30:00.000Z"}
            ])),
            now(),
        )
        .rows();
        let shown: Vec<(&str, Option<&str>)> = busy
            .iter()
            .map(|row| (row.text.as_str(), row.link.as_deref()))
            .collect();
        assert_eq!(
            shown,
            [
                ("Working now", None),
                (
                    "t: Researcher is working · 1 min",
                    Some("/?path=t.yaml&run=r1")
                ),
                ("Finished in the last hour", None),
                ("u: finished · 30 min ago", Some("/?path=u.yaml&run=r0")),
            ]
        );
    }

    /// The row opens the run's team on that run, as the app's own run links do; with only the run
    /// the app has no team to open and shows Home.
    #[test]
    fn a_line_opens_its_team_on_its_run() {
        assert_eq!(
            run_link("trip-planner.yaml", "1ad90b5a-9469"),
            "/?path=trip-planner.yaml&run=1ad90b5a-9469"
        );
        assert_eq!(
            run_link("news/Daily digest.yaml", "r1"),
            "/?path=news%2FDaily%20digest.yaml&run=r1",
            "a folder and a space are encoded, as URLSearchParams reads them back"
        );
        assert_eq!(run_link("", "r1"), "/?run=r1");
        assert_eq!(
            run_link("caf\u{e9}.yaml", "r1"),
            "/?path=caf%C3%A9.yaml&run=r1"
        );
    }

    #[test]
    fn a_long_list_shows_five_lines_and_counts_the_rest() {
        let many: Vec<_> = (0..9)
            .map(|n| {
                json!({"runId": format!("r{n}"), "teamPath": "t.yaml", "status": "running",
                             "createdAt": "2026-10-17T09:59:00.000Z"})
            })
            .collect();
        let progress = progress(&runs(json!(many)), now());
        assert_eq!(progress.working.len(), 9, "every run is counted");
        let rows = progress.rows();
        let texts: Vec<&str> = rows.iter().map(|row| row.text.as_str()).collect();
        assert_eq!(texts.len(), 1 + LINES_SHOWN + 1);
        assert_eq!(texts[1], "t: working · 1 min");
        assert_eq!(texts[LINES_SHOWN + 1], "4 more in LoomWatch");
        assert_eq!(
            rows[LINES_SHOWN + 1].link.as_deref(),
            Some("/"),
            "which opens LoomWatch's Home, where every one is listed"
        );
    }

    /// The count beside the face: everything waiting on you, across every team, however many
    /// the menu has room to show.
    #[test]
    fn everything_waiting_on_you_is_counted() {
        let asking = |n: usize| {
            json!({"runId": format!("r{n}"), "teamPath": format!("team-{n}.yaml"),
                   "status": "running", "createdAt": "2026-10-17T09:00:00.000Z",
                   "permissionRequests": [{"name": "Scout", "title": "Web search"},
                                          {"name": "Coder", "title": "Bash"}],
                   "waitingOn": {"name": "Writer", "kind": "question"}})
        };
        let progress = progress(&runs(json!([asking(1), asking(2), asking(3)])), now());
        assert_eq!(progress.needs_you.len(), 9, "3 teams, each with 3 things");
        assert_eq!(progress.mood(), Mood::Asking);
        assert!(progress.summary().ends_with("(and 8 more)"));
        assert!(
            progress
                .rows()
                .iter()
                .any(|row| row.text == "4 more in LoomWatch")
        );
    }

    /// A run waiting at its spool (ADR 0068) waits on you, like a question: the face asks, and
    /// the line says what it is waiting for.
    #[test]
    fn a_run_at_its_spool_waits_on_you() {
        let progress = progress(
            &runs(
                json!([{"runId": "r1", "teamPath": "news.yaml", "status": "running",
                          "createdAt": "2026-10-17T09:59:00.000Z",
                          "spendStops": [{"limitUsd": 1.0},
                                         {"name": "Scout", "limitUsd": 0.3}]}]),
            ),
            now(),
        );
        assert_eq!(progress.mood(), Mood::Asking);
        let texts: Vec<&str> = progress
            .needs_you
            .iter()
            .map(|line| line.text.as_str())
            .collect();
        assert_eq!(
            texts,
            [
                "news: used its $1.00: add more, or finish",
                "news: Scout used its $0.30: add more, or stop it"
            ]
        );
        assert!(
            progress.working.is_empty(),
            "nobody is shown as working while it waits"
        );
    }
}

//! Deciding what to push: what is new on the phone's home screen since the last read, as each
//! phone's settings allow. The same rules the phone follows for its own notices (`Notifying`), so
//! a push says what the app would have said.
//!
//! Every change goes too, news or not: a wait answered on this computer, work that started or
//! ended. Then the phone's badge is set and its app woken ([`Push::Changed`]), and its Live
//! Activity follows its work by its own push ([`Push::Activity`]), so nothing on the phone waits
//! for the app to be opened.

use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::{Value, json};

use super::{About, ActivityTarget, Notice, Push, PushTarget};

/// What each phone has been told and shown, by its device id.
#[derive(Default)]
pub struct Watch {
    phones: HashMap<String, Phone>,
}

#[derive(Default)]
struct Phone {
    /// The news it was told, by target.
    told: HashSet<String>,
    /// What it was last brought in step with; `None` sends it again.
    shown: Option<Shown>,
    /// What its widgets were last told to read again for; `None` sends it again.
    widgets: Option<Shown>,
    /// Its Live Activity's token, and what it shows.
    activity: Option<(String, Live)>,
    /// Starting one from here, while it has none.
    starting: Starting,
}

/// Starting a Live Activity on a phone that has none.
#[derive(Default)]
enum Starting {
    #[default]
    Idle,
    /// For this run's wait, on the next read: its notice went first.
    Next(String),
    /// Started for this run, when the phone had these settings. None starts again until the
    /// phone gives that activity's token, or says it has none.
    Sent { run: String, to: PushTarget },
}

/// A phone's Live Activity.
enum Live {
    /// It shows the state it was last given; `None` when that isn't known, so the next one goes.
    Shows(Option<Value>),
    /// It was ended, and takes no more.
    Ended,
}

/// What the phone's badge, notices, widgets and Live Activity show: who waits, and which work is
/// under way.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Shown {
    waiting: BTreeSet<String>,
    working: BTreeSet<String>,
}

/// One thing on the home screen that could be news.
struct Item {
    notice: Notice,
    permission: bool,
}

impl Watch {
    /// What to send now from `home` (the phone's home screen), to which phone, at `now`.
    pub fn next(
        &mut self,
        home: &Value,
        phones: &[(String, PushTarget)],
        now: DateTime<Utc>,
    ) -> Vec<(String, PushTarget, Push)> {
        let items = items(home);
        let current: HashSet<String> = items
            .iter()
            .map(|item| item.notice.target.clone())
            .collect();
        let shown = Shown::of(home);
        let mut out = Vec::new();
        for (id, target) in phones {
            // A phone this watch hasn't read for yet, after this computer started or when it
            // first gave its token: what is there now was there before, and isn't news; it
            // already shows it.
            let phone = self.phones.entry(id.clone()).or_insert_with(|| Phone {
                told: current.clone(),
                shown: Some(shown.clone()),
                widgets: Some(shown.clone()),
                activity: None,
                starting: Starting::Idle,
            });
            let quiet = target.quiet.as_ref().is_some_and(|quiet| quiet.holds(now));
            let told_now = phone.tell(&items, target, quiet);
            phone.told.retain(|key| current.contains(key));
            let mut push = |push| out.push((id.clone(), target.clone(), push));
            for notice in &told_now {
                push(Push::Notice(notice.clone()));
            }

            // A notice sets the badge and wakes the app itself; anything else that changed takes
            // a silent push of its own.
            if phone.shown.as_ref() != Some(&shown) {
                if told_now.is_empty() {
                    push(Push::Changed {
                        waiting: shown.waiting.len(),
                    });
                }
                phone.shown = Some(shown.clone());
            }
            // The widgets read this computer again themselves, even with the app swiped away.
            if target.widget_token.is_some() && phone.widgets.as_ref() != Some(&shown) {
                push(Push::Widgets);
            }
            phone.widgets = Some(shown.clone());

            let next = if let Some(activity) = &target.activity {
                phone.starting = Starting::Idle;
                let told: Vec<&str> = told_now.iter().map(|n| n.target.as_str()).collect();
                phone.follow(activity, activity_state(home, &activity.run), &told)
            } else {
                phone.activity = None;
                phone.start(home, target, &told_now)
            };
            if let Some(next) = next {
                push(next);
            }
        }
        self.phones
            .retain(|id, _| phones.iter().any(|(phone, _)| phone == id));
        out
    }

    /// Takes back `push` to phone `id`, so the next read sends it again.
    pub fn undo(&mut self, id: &str, push: &Push) {
        let Some(phone) = self.phones.get_mut(id) else {
            return;
        };
        match push {
            Push::Notice(notice) => {
                phone.told.remove(&notice.target);
                phone.shown = None;
            }
            Push::Changed { .. } => phone.shown = None,
            Push::Activity { state, end, .. } => {
                if let Some((_, live)) = &mut phone.activity {
                    *live = Live::Shows(if *end { state.clone() } else { None });
                }
            }
            Push::Start { run, .. } => phone.starting = Starting::Next(run.clone()),
            Push::Widgets => phone.widgets = None,
            Push::Health => {}
        }
    }
}

impl Phone {
    /// The news on `items` this phone hasn't been told, as its settings and the hour allow. What
    /// it doesn't want counts as told; what waits for quiet hours to end doesn't.
    fn tell(&mut self, items: &[Item], target: &PushTarget, quiet: bool) -> Vec<Notice> {
        let mut out = Vec::new();
        for item in items {
            let key = &item.notice.target;
            if self.told.contains(key) {
                continue;
            }
            let wanted = match item.notice.about {
                About::Waiting { .. } => target.tell_needs_me,
                About::Finished => target.tell_done,
                // The person asked for it at this time (ADR 0108).
                About::Message => true,
            };
            // In quiet hours only a permission ask rings: it runs out, and would stop the team. A
            // message rings too: the person chose its time. The rest waits for morning.
            let rings = item.permission || item.notice.about == About::Message;
            if wanted && quiet && !rings {
                continue;
            }
            self.told.insert(key.clone());
            if wanted {
                out.push(item.notice.clone());
            }
        }
        out
    }

    /// A Live Activity to start on a phone that has none, if it is time: when someone in work
    /// starts waiting and its notice goes, on the next read, so the phone has read the words for
    /// it by then. Once, until the phone gives that activity's token or says it has none.
    fn start(&mut self, home: &Value, target: &PushTarget, told: &[Notice]) -> Option<Push> {
        if target.start_token.is_none() {
            self.starting = Starting::Idle;
            return None;
        }
        match std::mem::take(&mut self.starting) {
            Starting::Sent { run, to } if to == *target => {
                self.starting = Starting::Sent { run, to };
                None
            }
            Starting::Next(run) => {
                let state = activity_state(home, &run).filter(|state| {
                    state.get("state").and_then(Value::as_str) == Some("waiting")
                })?;
                let path = team_path(home, &run)?;
                self.starting = Starting::Sent {
                    run: run.clone(),
                    to: target.clone(),
                };
                Some(Push::Start { run, path, state })
            }
            Starting::Idle | Starting::Sent { .. } => {
                if let Some(run) = told
                    .iter()
                    .filter(|notice| matches!(notice.about, About::Waiting { .. }))
                    .find_map(|notice| notice.run.clone())
                {
                    self.starting = Starting::Next(run);
                }
                None
            }
        }
    }

    /// What brings the Live Activity in step with `state` (its work's now, or `None` once it is
    /// over), if anything. `told` is the news told this read.
    fn follow(
        &mut self,
        activity: &ActivityTarget,
        state: Option<Value>,
        told: &[&str],
    ) -> Option<Push> {
        // A Live Activity seen for the first time shows what the app gave it when it gave its
        // token.
        if self
            .activity
            .as_ref()
            .is_none_or(|(token, _)| *token != activity.token)
        {
            self.activity = Some((activity.token.clone(), Live::Shows(state.clone())));
        }
        let (_, live) = self.activity.as_mut()?;
        let Live::Shows(last) = live else {
            return None;
        };
        let Some(state) = state else {
            let end = Push::Activity {
                state: last.take(),
                end: true,
                urgent: false,
            };
            *live = Live::Ended;
            return Some(end);
        };
        if last.as_ref() == Some(&state) {
            return None;
        }
        let visit = |state: Option<&Value>| {
            state
                .and_then(|state| state.get("visit"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let waits = visit(Some(&state));
        // Someone new waits: the notice goes first, and the Live Activity on the next read, so
        // the phone has read the words for it by then.
        if waits.as_deref().is_some_and(|waits| told.contains(&waits)) {
            return None;
        }
        let urgent = waits.is_some() && waits != visit(last.as_ref());
        *last = Some(state.clone());
        Some(Push::Activity {
            state: Some(state),
            end: false,
            urgent,
        })
    }
}

impl Shown {
    fn of(home: &Value) -> Self {
        Self {
            waiting: list(home, "needsYou").map(target_of).collect(),
            working: list(home, "working")
                .map(|run| text(run, "runId").to_owned())
                .collect(),
        }
    }
}

/// What the Live Activity following `run` shows now, by ids, as the phone's
/// `WorkActivity.ContentState` reads it: the first thing in it that waits for the person, else
/// who works on it. `None` once the work is over. The words are the phone's: `line` is left empty,
/// and `kind` and `agent` say what to put there.
fn activity_state(home: &Value, run: &str) -> Option<Value> {
    let ours = |summary: &Value| text(summary, "runId") == run;
    let waiting = list(home, "needsYou").count();
    let need = list(home, "needsYou").find(|need| need.get("run").is_some_and(ours));
    let summary = need
        .and_then(|need| need.get("run"))
        .or_else(|| list(home, "working").find(|summary| ours(summary)))?;
    // `Date`'s own encoding, as `ActivityKit` decodes it: seconds since the start of 2001.
    let started = [text(summary, "startedAt"), text(summary, "createdAt")]
        .into_iter()
        .find_map(|at| DateTime::parse_from_rfc3339(at).ok())
        .map_or(0.0, |at| {
            #[allow(clippy::cast_precision_loss)]
            let since = (at.timestamp_millis() - 978_307_200_000) as f64;
            since / 1000.0
        });
    let first_working = || {
        summary
            .get("working")
            .and_then(Value::as_array)
            .and_then(|working| working.first())
            .and_then(Value::as_str)
    };
    let mut state = json!({ "line": "", "startedAt": started });
    let Some(need) = need else {
        state["state"] = json!("working");
        if let Some(agent) = first_working() {
            state["agent"] = json!(agent);
        }
        return Some(state);
    };
    let waiting_on = need.get("waitingOn").unwrap_or(&Value::Null);
    let review = text(waiting_on, "kind") == "review_stop";
    let (kind, agent) = match text(need, "kind") {
        "answer" if review => ("review", Some(text(waiting_on, "handoverFrom"))),
        "answer" => ("question", Some(text(waiting_on, "node"))),
        "permission" => ("permission", need.get("request").map(|r| text(r, "agent"))),
        "spend" => (
            "spend",
            need.get("stop")
                .map(|stop| text(stop, "agent"))
                .filter(|agent| !agent.is_empty())
                .or_else(first_working),
        ),
        other => (other, None),
    };
    state["state"] = json!("waiting");
    state["kind"] = json!(kind);
    state["visit"] = json!(target_of(need));
    state["waiting"] = json!(waiting);
    if let Some(agent) = agent.filter(|agent| !agent.is_empty()) {
        state["agent"] = json!(agent);
    }
    if review {
        // Approve on the card: who brought it is the phone's to name.
        state["approval"] = json!({ "run": run, "node": text(waiting_on, "node"), "who": "" });
    }
    Some(state)
}

/// The team file of run `run`, as the home screen gives it.
fn team_path(home: &Value, run: &str) -> Option<String> {
    list(home, "needsYou")
        .filter_map(|need| need.get("run"))
        .chain(list(home, "working"))
        .find(|summary| text(summary, "runId") == run)
        .map(|summary| text(summary, "teamPath").to_owned())
        .filter(|path| !path.is_empty())
}

/// What could be news on `home`: everything that needs the person, and runs that finished. A
/// cancelled run, or a failed one that tries again, isn't news, as on the Mac.
fn items(home: &Value) -> Vec<Item> {
    let waiting = list(home, "needsYou").count();
    let mut items = Vec::new();
    for need in list(home, "needsYou") {
        let kind = text(need, "kind");
        let run = need.get("run").map_or("", |run| text(run, "runId"));
        let waiting_on = need.get("waitingOn").unwrap_or(&Value::Null);
        let node = answer_node(need);
        let review = kind == "answer" && text(waiting_on, "kind") == "review_stop";
        let permission = kind == "permission";
        items.push(Item {
            notice: Notice {
                target: target_of(need),
                about: About::Waiting { permission, review },
                run: Some(run.to_owned()).filter(|run| !run.is_empty()),
                node: (kind == "answer" && !node.is_empty()).then(|| node.to_owned()),
                room: need
                    .get("run")
                    .map(|run| text(run, "teamPath").to_owned())
                    .filter(|path| !path.is_empty()),
                waiting,
            },
            permission,
        });
    }
    for run in list(home, "done") {
        let status = text(run, "status");
        let trying_again = run.get("nextTryAt").is_some_and(|at| !at.is_null());
        if status != "succeeded" && (status != "failed" || trying_again) {
            continue;
        }
        let id = text(run, "runId");
        // A message the person asked for at a time: its turn's reply is the message, or, when the
        // turn failed, the words that were set (ADR 0108).
        let message = run
            .get("messageAt")
            .is_some_and(|message| !message.is_null());
        items.push(Item {
            notice: Notice {
                target: format!("done-{id}"),
                about: if message {
                    About::Message
                } else {
                    About::Finished
                },
                run: Some(id.to_owned()),
                node: None,
                room: Some(text(run, "teamPath").to_owned()).filter(|path| !path.is_empty()),
                waiting,
            },
            permission: false,
        });
    }
    items
}

/// The key the phone's home screen gives what needs the person (`NeedsYou.target`), such as
/// `answer-<run>-<node>`.
fn target_of(need: &Value) -> String {
    let run = need.get("run").map_or("", |run| text(run, "runId"));
    match text(need, "kind") {
        "permission" => format!("permission-{run}-{}", id_of(need, "request")),
        "spend" => format!("spend-{run}-{}", id_of(need, "stop")),
        "answer" => format!("answer-{run}-{}", answer_node(need)),
        "teamRequest" => format!("teamRequest-{}", id_of(need, "teamRequest")),
        other => format!("{other}-{run}-{}", text(need, "since")),
    }
}

/// The stop or the asking agent an answer goes to.
fn answer_node(need: &Value) -> &str {
    let waiting_on = need.get("waitingOn").unwrap_or(&Value::Null);
    Some(text(waiting_on, "node"))
        .filter(|node| !node.is_empty())
        .unwrap_or_else(|| text(waiting_on, "agent"))
}

fn list<'a>(home: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    home.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn id_of(need: &Value, field: &str) -> String {
    need.get(field)
        .map_or_else(String::new, |value| match value.get("id") {
            Some(Value::String(id)) => id.clone(),
            Some(Value::Number(id)) => id.to_string(),
            _ => String::new(),
        })
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

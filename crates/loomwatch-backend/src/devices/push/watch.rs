//! Deciding what to push: what is new on the phone's home screen since the last read, as each
//! phone's settings allow. The same rules the phone follows for its own notices (`Notifying`), so
//! a push says what the app would have said.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{About, Notice, PushTarget};

/// What each phone has been told, by its device id.
#[derive(Default)]
pub struct Watch {
    told: HashMap<String, HashSet<String>>,
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
    ) -> Vec<(String, PushTarget, Notice)> {
        let items = items(home);
        let current: HashSet<String> = items
            .iter()
            .map(|item| item.notice.target.clone())
            .collect();
        let mut out = Vec::new();
        for (id, target) in phones {
            // A phone this watch hasn't read for yet, after this computer started or when it
            // first gave its token: what is there now was there before, and isn't news.
            let Some(told) = self.told.get_mut(id) else {
                self.told.insert(id.clone(), current.clone());
                continue;
            };
            let quiet = target.quiet.as_ref().is_some_and(|quiet| quiet.holds(now));
            for item in &items {
                let key = &item.notice.target;
                if told.contains(key) {
                    continue;
                }
                let wanted = match item.notice.about {
                    About::Waiting { .. } => target.tell_needs_me,
                    About::Finished => target.tell_done,
                };
                // In quiet hours only a permission ask rings: it runs out, and would stop the
                // team. The rest waits for morning.
                if wanted && quiet && !item.permission {
                    continue;
                }
                told.insert(key.clone());
                if wanted {
                    out.push((id.clone(), target.clone(), item.notice.clone()));
                }
            }
            told.retain(|key| current.contains(key));
        }
        self.told
            .retain(|id, _| phones.iter().any(|(phone, _)| phone == id));
        out
    }

    /// Takes back that `target` was told to phone `id`, so the next read sends it again.
    pub fn unsay(&mut self, id: &str, target: &str) {
        if let Some(told) = self.told.get_mut(id) {
            told.remove(target);
        }
    }
}

/// What could be news on `home`: everything that needs the person, and runs that finished. A
/// cancelled run, or a failed one that tries again, isn't news, as on the Mac.
fn items(home: &Value) -> Vec<Item> {
    let list = |key: &str| {
        home.get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
    };
    let waiting = list("needsYou").count();
    let mut items = Vec::new();
    for need in list("needsYou") {
        let kind = text(need, "kind");
        let run = need.get("run").map_or("", |run| text(run, "runId"));
        let waiting_on = need.get("waitingOn").unwrap_or(&Value::Null);
        let node = Some(text(waiting_on, "node"))
            .filter(|node| !node.is_empty())
            .unwrap_or_else(|| text(waiting_on, "agent"));
        let target = match kind {
            "permission" => format!("permission-{run}-{}", id_of(need, "request")),
            "spend" => format!("spend-{run}-{}", id_of(need, "stop")),
            "answer" => format!("answer-{run}-{node}"),
            "teamRequest" => format!("teamRequest-{}", id_of(need, "teamRequest")),
            other => format!("{other}-{run}-{}", text(need, "since")),
        };
        let review = kind == "answer" && text(waiting_on, "kind") == "review_stop";
        let permission = kind == "permission";
        items.push(Item {
            notice: Notice {
                target,
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
    for run in list("done") {
        let status = text(run, "status");
        let trying_again = run.get("nextTryAt").is_some_and(|at| !at.is_null());
        if status != "succeeded" && (status != "failed" || trying_again) {
            continue;
        }
        let id = text(run, "runId");
        items.push(Item {
            notice: Notice {
                target: format!("done-{id}"),
                about: About::Finished,
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

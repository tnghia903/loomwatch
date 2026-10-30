//! One team, from the phone: its settings and its workflow, and the few changes the phone may make
//! to them. The team file is read and written whole, against its revision, so a change saved on the
//! Mac in between is never overwritten.
//!
//! A team file someone wrote notes in (`#` comments) is left to the Mac, which keeps them: the
//! phone's YAML writer would drop them. A workflow with branches is too: the phone's list is one
//! line of steps.

use axum::http::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use serde_yaml::{Mapping, Value as Yaml};

use super::daemon::Daemon;

/// A change the phone may make to a team. Absent fields stay as they are.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamChange {
    pub path: String,
    /// The revision the phone read; a newer file answers 412.
    pub revision: String,
    pub name: Option<String>,
    /// The most one run may spend, in US dollars.
    pub per_run: Option<f64>,
    /// Commands that only read or download run without asking (`permissions.mode: auto`).
    pub auto_mode: Option<bool>,
    /// Whether the routine runs at its times.
    pub schedule_enabled: Option<bool>,
    /// The steps, by id, in the order work moves through them: the phone's list after a drag,
    /// a step added (an id not in the team yet, made by [`Step`]) or one taken off.
    pub order: Option<Vec<String>>,
    /// New steps named in `order`.
    #[serde(default)]
    pub add: Vec<Step>,
}

/// A step the phone adds: one of My agents, or a stop where you check.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub id: String,
    /// The agent in My agents it is; absent, it is a "You check" stop.
    pub my_agent: Option<String>,
}

/// Whether someone wrote notes in the file: a line that is only a comment.
fn has_notes(yaml: &str) -> bool {
    yaml.lines().any(|line| line.trim_start().starts_with('#'))
}

fn text(value: Option<&Yaml>) -> Option<&str> {
    value.and_then(Yaml::as_str)
}

fn key(name: &str) -> Yaml {
    Yaml::String(name.to_owned())
}

fn agents_of(team: &Yaml) -> Vec<&Mapping> {
    team.get("agents")
        .and_then(Yaml::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(Yaml::as_mapping)
        .collect()
}

/// The configured line of work, from the entrypoint along `sequence` edges, when the team is one
/// line: every agent once, no branch, no join. `None` for any other shape.
#[must_use]
pub fn line_of(team: &Yaml) -> Option<Vec<String>> {
    let ids: Vec<String> = agents_of(team)
        .iter()
        .filter_map(|agent| text(agent.get(key("id"))).map(str::to_owned))
        .collect();
    let edges: Vec<(String, String)> = team
        .get("edges")
        .and_then(Yaml::as_sequence)
        .into_iter()
        .flatten()
        .filter(|edge| {
            text(edge.get("layer")) == Some("configured")
                && text(edge.get("kind")) == Some("sequence")
        })
        .filter_map(|edge| {
            Some((
                text(edge.get("from"))?.to_owned(),
                text(edge.get("to"))?.to_owned(),
            ))
        })
        .collect();
    if ids.len() == 1 && edges.is_empty() {
        return Some(ids);
    }
    let first = text(team.get("entrypoint"))?.to_owned();
    let mut line = vec![first];
    while let Some(last) = line.last() {
        let next: Vec<&(String, String)> = edges.iter().filter(|(from, _)| from == last).collect();
        match next.as_slice() {
            [] => break,
            [(_, to)] if !line.contains(to) => line.push(to.clone()),
            _ => return None,
        }
    }
    (line.len() == ids.len() && edges.len() == ids.len() - 1).then_some(line)
}

/// `GET /phone/v0/team?path=…`: what the team's settings and workflow screens show.
///
/// # Errors
/// When `LoomWatch` can't be reached or the file isn't a team.
pub async fn team_view(daemon: &Daemon, path: &str) -> anyhow::Result<Value> {
    let file = daemon.get_json(&super::team_query(path)).await?;
    let yaml = file.get("yaml").and_then(Value::as_str).unwrap_or_default();
    let team: Yaml = serde_yaml::from_str(yaml)?;
    let line = line_of(&team);
    let agents: Vec<Value> = agents_of(&team)
        .iter()
        .map(|agent| {
            json!({
                "id": text(agent.get(key("id"))),
                "name": text(agent.get(key("name"))),
                "operator": text(agent.get(key("kind"))) == Some("operator"),
                "role": text(agent.get(key("role"))),
                "myAgent": agent.get(key("from")).and_then(|from| text(from.get("agent"))),
            })
        })
        .collect();
    let schedule = team.get("schedule");
    Ok(json!({
        "path": path,
        "revision": file.get("revision"),
        "name": text(team.get("name")),
        "perRun": team.get("spend").and_then(|spend| spend.get("perRun")).and_then(Yaml::as_f64),
        "autoMode": team.get("permissions").and_then(|permissions| text(permissions.get("mode"))) == Some("auto"),
        "schedule": schedule.map(|schedule| json!({
            "cron": text(schedule.get("cron")),
            "timezone": text(schedule.get("timezone")),
            "prompt": text(schedule.get("prompt")),
            "enabled": schedule.get("enabled").and_then(Yaml::as_bool).unwrap_or(true),
        })),
        "deliver": team.get("deliver").map(|_| "notion"),
        "agents": agents,
        "order": line,
        // Why the phone can't change it, when it can't.
        "readOnly": if has_notes(yaml) {
            Some("This team can only be changed on your Mac.")
        } else {
            None
        },
    }))
}

fn now() -> String {
    // Edges carry when they were drawn; the phone draws them now. Whole seconds are enough.
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let days = seconds / 86_400;
    let (year, month, day) = civil(days.try_into().unwrap_or(0));
    let rest = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Days since 1970-01-01 as a date (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let month = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// The team document with `change` made to it, or why it can't be.
///
/// # Errors
/// A workflow change on a team that isn't one line, or an order that names an agent it doesn't
/// have.
pub fn apply(team: &mut Yaml, change: &TeamChange, saved: &[Value]) -> Result<(), String> {
    let document = team.as_mapping_mut().ok_or("That file isn't a team.")?;
    if let Some(name) = change
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        document.insert(key("name"), key(name));
    }
    if let Some(per_run) = change.per_run {
        if !(per_run > 0.0 && per_run <= 1000.0) {
            return Err("What one run may spend must be more than $0 and at most $1,000.".into());
        }
        let spend = document
            .entry(key("spend"))
            .or_insert_with(|| Yaml::Mapping(Mapping::new()));
        if let Some(spend) = spend.as_mapping_mut() {
            spend.insert(key("perRun"), Yaml::from((per_run * 100.0).round() / 100.0));
        }
    }
    if let Some(auto) = change.auto_mode {
        if auto {
            let mut permissions = Mapping::new();
            permissions.insert(key("mode"), key("auto"));
            document.insert(key("permissions"), Yaml::Mapping(permissions));
        } else {
            document.remove("permissions");
        }
    }
    if let Some(enabled) = change.schedule_enabled {
        let schedule = document
            .get_mut("schedule")
            .and_then(Yaml::as_mapping_mut)
            .ok_or("This team has no routine.")?;
        if enabled {
            schedule.remove("enabled");
        } else {
            schedule.insert(key("enabled"), Yaml::Bool(false));
        }
    }
    if let Some(order) = &change.order {
        reorder(team, order, &change.add, saved)?;
    }
    Ok(())
}

fn reorder(team: &mut Yaml, order: &[String], add: &[Step], saved: &[Value]) -> Result<(), String> {
    if line_of(team).is_none() {
        return Err("This team's workflow has branches. Change it on your Mac.".into());
    }
    if order.is_empty() {
        return Err("A team needs at least one step.".into());
    }
    let document = team.as_mapping_mut().ok_or("That file isn't a team.")?;
    let agents = document
        .get_mut("agents")
        .and_then(Yaml::as_sequence_mut)
        .ok_or("That team has no agents.")?;
    for step in add {
        let taken = agents
            .iter()
            .any(|agent| text(agent.get("id")) == Some(&step.id));
        if taken
            || step.id.is_empty()
            || !step
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err(format!("“{}” can't be a new step's id.", step.id));
        }
        let mut entry = Mapping::new();
        entry.insert(key("id"), key(&step.id));
        if let Some(mine) = &step.my_agent {
            let name = saved
                .iter()
                .find(|job| job.get("id").and_then(Value::as_str) == Some(mine))
                .and_then(|job| job.get("name").and_then(Value::as_str))
                .ok_or_else(|| format!("“{mine}” isn't in My agents."))?;
            entry.insert(key("name"), key(name));
            let mut from = Mapping::new();
            from.insert(key("agent"), key(mine));
            entry.insert(key("from"), Yaml::Mapping(from));
        } else {
            entry.insert(key("kind"), key("operator"));
            entry.insert(key("name"), key("You"));
            entry.insert(key("role"), key("Approve the work, or say what to change."));
        }
        agents.push(Yaml::Mapping(entry));
    }
    let known: Vec<String> = agents
        .iter()
        .filter_map(|agent| text(agent.get("id")).map(str::to_owned))
        .collect();
    if let Some(stranger) = order.iter().find(|id| !known.contains(id)) {
        return Err(format!("This team has no step “{stranger}”."));
    }
    // A step left out of the order is taken off the team.
    agents.retain(|agent| {
        text(agent.get("id")).is_some_and(|id| order.iter().any(|kept| kept == id))
    });
    if agents
        .iter()
        .all(|agent| text(agent.get("kind")) == Some("operator"))
    {
        return Err("A team needs at least one agent, not only places where you check.".into());
    }
    let drawn = now();
    let mut edges: Vec<Yaml> = document
        .get("edges")
        .and_then(Yaml::as_sequence)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|edge| {
            !(text(edge.get("layer")) == Some("configured")
                && text(edge.get("kind")) == Some("sequence"))
        })
        .collect();
    for pair in order.windows(2) {
        let mut edge = Mapping::new();
        edge.insert(key("from"), key(&pair[0]));
        edge.insert(key("to"), key(&pair[1]));
        edge.insert(key("layer"), key("configured"));
        edge.insert(key("kind"), key("sequence"));
        edge.insert(key("ts"), key(&drawn));
        edges.push(Yaml::Mapping(edge));
    }
    document.insert(key("edges"), Yaml::Sequence(edges));
    document.insert(key("entrypoint"), key(&order[0]));
    Ok(())
}

/// `POST /phone/v0/team`: saves `change` on the team, against the revision the phone read.
///
/// # Errors
/// When `LoomWatch` can't be reached; a change the daemon refused comes back as its status.
pub async fn save_team(daemon: &Daemon, change: TeamChange) -> anyhow::Result<(StatusCode, Value)> {
    // Reached but refused (outside the teams folder, gone) is not the same as not running.
    let read = daemon
        .send(
            Method::GET,
            &super::team_query(&change.path),
            None,
            axum::body::Bytes::new(),
        )
        .await?;
    if !read.status().is_success() {
        return Ok((
            StatusCode::NOT_FOUND,
            json!({"error": "That team isn't on your Mac any more."}),
        ));
    }
    let file: Value = read.json().await?;
    let yaml = file.get("yaml").and_then(Value::as_str).unwrap_or_default();
    if file.get("revision").and_then(Value::as_str) != Some(change.revision.as_str()) {
        return Ok((
            StatusCode::PRECONDITION_FAILED,
            json!({"error": "This team was changed on your Mac since you opened it. Close it and open it again to see that change."}),
        ));
    }
    if has_notes(yaml) {
        return Ok((
            StatusCode::CONFLICT,
            json!({"error": "This team can only be changed on your Mac."}),
        ));
    }
    let mut team: Yaml = serde_yaml::from_str(yaml)?;
    let saved = daemon
        .get_json("/api/jobs")
        .await
        .ok()
        .and_then(|jobs| jobs.get("jobs").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    if let Err(why) = apply(&mut team, &change, &saved) {
        return Ok((StatusCode::UNPROCESSABLE_ENTITY, json!({"error": why})));
    }
    let reply = daemon
        .send_json(
            Method::PUT,
            "/api/team",
            &[("If-Match", format!("\"{}\"", change.revision))],
            &json!({"path": change.path, "yaml": serde_yaml::to_string(&team)?}),
        )
        .await?;
    let status = StatusCode::from_u16(reply.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    Ok((status, reply.json().await.unwrap_or(Value::Null)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKYO: &str = "schemaVersion: 1\nid: tokyo-trip\nname: Tokyo trip\nspend:\n  perRun: 1.0\nentrypoint: scout\nagents:\n- id: scout\n  name: Researcher\n  role: Find flights.\n  model: fake/offline\n- id: check\n  kind: operator\n  name: You\n- id: scribe\n  name: Writer\n  role: Write the plan.\n  model: fake/offline\nedges:\n- {from: scout, to: check, layer: configured, kind: sequence, ts: '2026-10-29T00:00:00Z'}\n- {from: check, to: scribe, layer: configured, kind: sequence, ts: '2026-10-29T00:00:00Z'}\n- {from: scribe, to: scout, layer: observed, kind: message, ts: '2026-10-29T00:00:00Z'}\n";

    fn tokyo() -> Yaml {
        serde_yaml::from_str(TOKYO).unwrap()
    }

    fn change(order: &[&str]) -> TeamChange {
        TeamChange {
            path: "tokyo.yaml".into(),
            revision: "r".into(),
            order: Some(order.iter().map(|id| (*id).to_owned()).collect()),
            ..TeamChange::default()
        }
    }

    #[test]
    fn a_line_of_steps_is_read_from_the_entrypoint() {
        assert_eq!(line_of(&tokyo()).unwrap(), ["scout", "check", "scribe"]);
        let mut branched = tokyo();
        let edges = branched
            .get_mut("edges")
            .unwrap()
            .as_sequence_mut()
            .unwrap();
        edges.push(
            serde_yaml::from_str("{from: scout, to: scribe, layer: configured, kind: sequence}")
                .unwrap(),
        );
        assert_eq!(line_of(&branched), None);
    }

    #[test]
    fn a_drag_rewrites_the_line_and_keeps_other_edges() {
        let mut team = tokyo();
        apply(&mut team, &change(&["scout", "scribe", "check"]), &[]).unwrap();
        assert_eq!(line_of(&team).unwrap(), ["scout", "scribe", "check"]);
        let observed = team["edges"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter(|edge| text(edge.get("layer")) == Some("observed"))
            .count();
        assert_eq!(observed, 1);
    }

    #[test]
    fn steps_are_added_and_taken_off() {
        let saved = vec![json!({"id": "maya", "name": "Maya"})];
        let mut team = tokyo();
        let mut add = change(&["scout", "maya-1", "check-2", "check", "scribe"]);
        add.add = vec![
            Step {
                id: "maya-1".into(),
                my_agent: Some("maya".into()),
            },
            Step {
                id: "check-2".into(),
                my_agent: None,
            },
        ];
        apply(&mut team, &add, &saved).unwrap();
        assert_eq!(
            line_of(&team).unwrap(),
            ["scout", "maya-1", "check-2", "check", "scribe"]
        );
        let maya = agents_of(&team)
            .into_iter()
            .find(|agent| text(agent.get("id")) == Some("maya-1"))
            .unwrap();
        assert_eq!(text(maya.get("name")), Some("Maya"));
        assert_eq!(
            maya.get("from").and_then(|from| text(from.get("agent"))),
            Some("maya")
        );
        assert!(
            maya.get("role").is_none(),
            "filled from My agents by the daemon"
        );

        let mut off = tokyo();
        apply(&mut off, &change(&["scribe", "scout"]), &[]).unwrap();
        assert_eq!(line_of(&off).unwrap(), ["scribe", "scout"]);
        assert_eq!(text(off.get("entrypoint")), Some("scribe"));
        assert_eq!(agents_of(&off).len(), 2);
    }

    #[test]
    fn what_cannot_be_is_refused_with_why() {
        assert!(
            apply(&mut tokyo(), &change(&["scout", "nobody"]), &[])
                .unwrap_err()
                .contains("nobody")
        );
        assert!(
            apply(&mut tokyo(), &change(&["check"]), &[])
                .unwrap_err()
                .contains("at least one agent")
        );
        let mut over = change(&["scout", "check", "scribe"]);
        over.per_run = Some(0.0);
        assert!(apply(&mut tokyo(), &over, &[]).is_err());
    }

    #[test]
    fn settings_are_written_where_the_mac_reads_them() {
        let mut team = tokyo();
        let settings = TeamChange {
            per_run: Some(2.5),
            auto_mode: Some(true),
            ..TeamChange::default()
        };
        apply(&mut team, &settings, &[]).unwrap();
        assert_eq!(team["spend"]["perRun"].as_f64(), Some(2.5));
        assert_eq!(text(team["permissions"].get("mode")), Some("auto"));
        let off = TeamChange {
            auto_mode: Some(false),
            ..TeamChange::default()
        };
        apply(&mut team, &off, &[]).unwrap();
        assert!(team.get("permissions").is_none());
        assert!(
            apply(
                &mut team,
                &TeamChange {
                    schedule_enabled: Some(false),
                    ..TeamChange::default()
                },
                &[]
            )
            .is_err()
        );
    }

    #[test]
    fn a_file_with_notes_is_left_to_the_mac() {
        assert!(has_notes("# A team\nname: x\n"));
        assert!(has_notes("agents:\n  # the first\n  - id: a\n"));
        assert!(!has_notes("name: 'Plan #2'\n"));
    }

    #[test]
    fn edges_are_dated_as_now() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(20_390), (2025, 10, 29));
        assert!(now().ends_with('Z') && now().len() == 20);
    }
}

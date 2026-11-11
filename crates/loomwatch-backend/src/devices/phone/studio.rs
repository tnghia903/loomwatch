//! The studio the phone draws: one floor per team, its agents at their desks in team order, each
//! wearing the figure it wears on the Mac.
//!
//! Projects (ADR 0097) will group teams into rooms once the daemon has them; until then each team
//! is a floor of its own.

use serde::Deserialize;
use serde_json::{Value, json};

/// `hashId` in `ui/src/lib/story/mark.ts`: FNV-1a over UTF-16 code units, as JavaScript's
/// `charCodeAt` reads a string.
#[must_use]
pub fn hash_id(text: &str) -> u32 {
    text.encode_utf16().fold(0x811c_9dc5_u32, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193)
    })
}

/// `figureFor`: the figure chosen for it when that is one the Mac can draw (under today's names,
/// `crate::figures`), else one its id picks, the same every time.
#[must_use]
pub fn figure_for(id: &str, chosen: Option<&Value>) -> (String, String) {
    use crate::figures::{is_build, is_color, migrate_figure, pick};
    if let Some(chosen) = chosen {
        let kind = chosen.get("kind").and_then(Value::as_str);
        let color = chosen.get("color").and_then(Value::as_str);
        if let (Some(kind), Some(color)) = (kind, color) {
            let (kind, color) = migrate_figure(kind, color);
            if is_build(&kind) && is_color(&color) {
                return (kind, color);
            }
        }
    }
    let (kind, color) = pick(hash_id(id));
    (kind.to_owned(), color.to_owned())
}

/// `signFor`: the sign on the figure of one of My agents, as `GET /api/jobs` lists it: its job's
/// icon, else what its name and instructions suggest, else a curl (`crate::figures::sign_for`).
/// Only for drawing: the phone never sends it back in a figure it saves.
#[must_use]
pub fn job_sign(job: &Value) -> &'static str {
    let text = |key: &str| job.get(key).and_then(Value::as_str);
    crate::figures::sign_for(
        text("icon"),
        text("name").unwrap_or(""),
        text("instructions").or_else(|| text("role")).unwrap_or(""),
    )
}

/// `jobFigure`: one of My agents' figure as the Mac draws it, with the sign its job puts on its
/// head.
#[must_use]
pub fn job_figure(id: &str, job: &Value) -> Value {
    let (kind, color) = figure_for(id, job.get("figure"));
    json!({"kind": kind, "color": color, "sign": job_sign(job)})
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TeamFile {
    name: Option<String>,
    entrypoint: Option<String>,
    agents: Vec<TeamAgent>,
    edges: Vec<Edge>,
}

#[derive(Deserialize)]
struct TeamAgent {
    id: String,
    name: Option<String>,
    kind: Option<String>,
    /// Its instructions, as a team file names them.
    role: Option<String>,
    from: Option<FromLink>,
}

#[derive(Deserialize)]
struct FromLink {
    agent: Option<String>,
}

#[derive(Deserialize)]
struct Edge {
    from: String,
    to: String,
}

/// One floor: the team at `path` (relative to the teams root, as `GET /api/teams` and a run's
/// `teamPath` name it), from its file's text and the saved agents of `GET /api/jobs`.
#[must_use]
pub fn floor(path: &str, listed_name: Option<&str>, yaml: &str, jobs: &Value) -> Value {
    let team: TeamFile = serde_yaml::from_str(yaml).unwrap_or_default();
    let saved = jobs.get("jobs").and_then(Value::as_array);
    let agents: Vec<Value> = order(&team)
        .into_iter()
        .map(|agent| {
            let operator = agent.kind.as_deref() == Some("operator");
            // `agentFigure`: an agent placed from My agents wears its saved agent's figure.
            let linked = agent.from.as_ref().and_then(|from| from.agent.as_deref());
            let job = linked.and_then(|linked| {
                saved?
                    .iter()
                    .find(|job| job.get("id").and_then(Value::as_str) == Some(linked))
            });
            let (kind, color) = figure_for(linked.unwrap_or(&agent.id), job.and_then(|job| job.get("figure")));
            // Its sign: its saved agent's, else what its own name and instructions suggest.
            let sign = job.map_or_else(
                || {
                    crate::figures::sign_for(
                        None,
                        agent.name.as_deref().unwrap_or(&agent.id),
                        agent.role.as_deref().unwrap_or(""),
                    )
                },
                job_sign,
            );
            // Its own name in the team, else its saved agent's, as the Mac shows it.
            let saved_name = job
                .and_then(|job| job.get("name"))
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty());
            let name = agent.name.clone().or_else(|| saved_name.map(str::to_owned));
            json!({
                "id": agent.id,
                "name": name.unwrap_or_else(|| if operator { "You".to_owned() } else { agent.id.clone() }),
                "operator": operator,
                "myAgent": linked,
                "figure": { "kind": kind, "color": color, "sign": sign },
            })
        })
        .collect();
    let name = team
        .name
        .clone()
        .or_else(|| listed_name.map(str::to_owned))
        .unwrap_or_else(|| path.to_owned());
    json!({
        "path": path,
        "name": name,
        "mark": figure_for(path, None).1,
        "agents": agents,
    })
}

/// Team order: along the drawn connections from the starting agent when there are any, else the
/// starting agent first and the rest as the file lists them. Agents no connection reaches come
/// last, so every agent has a desk.
fn order(team: &TeamFile) -> Vec<&TeamAgent> {
    let position = |id: &str| team.agents.iter().position(|agent| agent.id == id);
    let start = team.entrypoint.as_deref().and_then(position).unwrap_or(0);
    let mut placed: Vec<usize> = Vec::new();
    if team.agents.is_empty() {
        return Vec::new();
    }
    if team.edges.is_empty() {
        placed.push(start);
    } else {
        // Kahn's order, ties broken by the file's order.
        let mut waiting: Vec<usize> = team
            .agents
            .iter()
            .map(|agent| team.edges.iter().filter(|edge| edge.to == agent.id).count())
            .collect();
        let mut ready: Vec<usize> = (0..team.agents.len())
            .filter(|index| waiting[*index] == 0)
            .collect();
        ready.sort_by_key(|index| (*index != start, *index));
        while let Some(next) = ready.first().copied() {
            ready.remove(0);
            placed.push(next);
            for edge in team
                .edges
                .iter()
                .filter(|edge| edge.from == team.agents[next].id)
            {
                if let Some(to) = position(&edge.to) {
                    waiting[to] = waiting[to].saturating_sub(1);
                    if waiting[to] == 0 && !placed.contains(&to) && !ready.contains(&to) {
                        ready.push(to);
                        ready.sort_unstable();
                    }
                }
            }
        }
    }
    for index in 0..team.agents.len() {
        if !placed.contains(&index) {
            placed.push(index);
        }
    }
    placed
        .into_iter()
        .map(|index| &team.agents[index])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Answers from the Mac's own `figureFor` and `hashId`, run in Node on 2026-10-29, under
    /// today's names (`crate::figures::migrate_figure`): an agent nobody dressed keeps its look.
    #[test]
    fn picks_the_same_figure_as_the_mac() {
        for (id, hash, kind, color) in [
            ("reader", 653_517_270, "chubby", "clay"),
            ("writer", 2_228_000_106, "chubby", "lilac"),
            ("researcher", 1_844_902_523, "slim", "sky"),
            ("editor", 1_544_389_240, "egg", "sage"),
            ("checker", 856_779_548, "wide", "clay"),
            ("review", 576_156_385, "tall", "clay"),
            ("Cole", 1_769_126_556, "chubby", "orchid"),
            ("việt", 2_469_842_627, "slim", "rose"),
        ] {
            assert_eq!(hash_id(id), hash, "{id}");
            assert_eq!(
                figure_for(id, None),
                (kind.to_owned(), color.to_owned()),
                "{id}"
            );
        }
    }

    #[test]
    fn a_chosen_figure_wins_only_when_the_mac_can_draw_it() {
        let chosen = json!({"kind": "egg", "color": "sunset"});
        assert_eq!(
            figure_for("reader", Some(&chosen)),
            ("egg".to_owned(), "sunset".to_owned())
        );
        // A figure saved under an earlier name is that figure today.
        let old = json!({"kind": "bobbin", "color": "rose"});
        assert_eq!(
            figure_for("reader", Some(&old)),
            ("tall".to_owned(), "sunset".to_owned())
        );
        let unknown = json!({"kind": "robot", "color": "sage"});
        assert_eq!(
            figure_for("reader", Some(&unknown)),
            figure_for("reader", None)
        );
    }

    #[test]
    fn desks_follow_the_connections_from_the_starting_agent() {
        let yaml = "name: Review stop demo\nentrypoint: researcher\nagents:\n  - id: writer\n    name: Writer\n  - id: review\n    kind: operator\n  - id: researcher\n    name: Researcher\nedges:\n  - {from: researcher, to: review}\n  - {from: review, to: writer}\n";
        let floor = floor("demo.yaml", None, yaml, &json!({"jobs": []}));
        let ids: Vec<&str> = floor["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["researcher", "review", "writer"]);
        assert_eq!(floor["agents"][1]["operator"], true);
        assert_eq!(floor["agents"][1]["name"], "You");
        assert_eq!(floor["name"], "Review stop demo");
    }

    #[test]
    fn without_connections_the_starting_agent_comes_first() {
        let yaml = "entrypoint: lead\nagents:\n  - id: helper\n  - id: lead\n  - id: other\n";
        let floor = floor("team.yaml", Some("Listed name"), yaml, &json!({"jobs": []}));
        let ids: Vec<&str> = floor["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["lead", "helper", "other"]);
        assert_eq!(floor["name"], "Listed name");
        assert_eq!(floor["agents"][0]["name"], "lead");
    }

    #[test]
    fn an_agent_from_my_agents_is_called_by_its_saved_name() {
        let yaml = "agents:\n  - id: researcher\n    from: {agent: researcher-lw}\n  - id: writer\n    name: Writer\n    from: {agent: writer-lw}\n";
        let jobs = json!({"jobs": [
            {"id": "researcher-lw", "name": "Researcher · LoomWatch marketing", "figure": {"kind": "little", "color": "sky"}},
            {"id": "writer-lw", "name": "Saved writer"},
        ]});
        let floor = floor("team.yaml", None, yaml, &jobs);
        assert_eq!(
            floor["agents"][0]["name"],
            "Researcher · LoomWatch marketing"
        );
        assert_eq!(floor["agents"][0]["figure"]["kind"], "little");
        // A name the team gives it wins.
        assert_eq!(floor["agents"][1]["name"], "Writer");
    }

    #[test]
    fn an_agent_from_my_agents_wears_its_saved_figure() {
        let yaml = "agents:\n  - id: editor-2\n    from: {agent: editor, version: 3}\n  - id: reader-2\n    from: {agent: reader, version: 1}\n";
        let jobs = json!({"jobs": [
            {"id": "editor", "figure": {"kind": "little", "color": "lilac"}},
            {"id": "reader"}
        ]});
        let floor = floor("team.yaml", None, yaml, &jobs);
        assert_eq!(
            floor["agents"][0]["figure"],
            json!({"kind": "little", "color": "lilac", "sign": "curl"})
        );
        // A saved agent with no figure chosen wears the one its own id picks.
        let (kind, color) = figure_for("reader", None);
        assert_eq!(
            floor["agents"][1]["figure"],
            json!({"kind": kind, "color": color, "sign": "curl"})
        );
    }

    /// `agentFigure`'s sign: a saved agent's job icon, else what its saved name and instructions
    /// suggest; a team's own agent's, from its name (its id when it has none) and its role.
    #[test]
    fn each_figure_wears_its_jobs_sign() {
        let yaml = "agents:\n  - id: researcher\n    name: Researcher\n  - id: ada\n    name: Ada\n    role: Turn the sales data into charts.\n  - id: helper\n  - id: clip-2\n    from: {agent: clips}\n  - id: notes-2\n    name: Ada\n    from: {agent: notes}\n  - id: lost\n    name: Writer\n    from: {agent: gone}\n";
        let jobs = json!({"jobs": [
            {"id": "clips", "name": "Ada", "icon": "video", "instructions": "Write the brief."},
            {"id": "notes", "name": "Notes taker", "instructions": "Keep it short."},
        ]});
        let floor = floor("team.yaml", None, yaml, &jobs);
        let signs: Vec<&str> = floor["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["figure"]["sign"].as_str().unwrap())
            .collect();
        assert_eq!(
            signs,
            ["research", "chart", "curl", "video", "write", "write"]
        );
        // One of My agents, listed: the same sign.
        assert_eq!(job_figure("clips", &jobs["jobs"][0])["sign"], "video");
        assert_eq!(
            job_sign(&json!({"name": "Ada", "role": "Proofread it."})),
            "edit"
        );
    }
}

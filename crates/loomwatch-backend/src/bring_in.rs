//! Bringing in another of the person's agents from My agents (ADR 0092).
//!
//! In a team with no fixed order, the starting agent, or an agent working alone in its own chat,
//! may list the person's other agents with the Team Bus tool `my_agents` and start one with
//! `dispatch`, by the id the list gives: `mine+<id>`, which no team-file agent can have. That
//! agent, a guest of the run, works as it is saved in My agents: its own instructions, model,
//! skills, tools, reads and switches, filled in as a team's pointer to it is (ADR 0094). It reads
//! what the whole team is given, learns into its one list of lessons, and brings in no one.
//!
//! It is off until the bench shows it helps: `guards.myAgents` defaults to `0`.

use std::path::Path;

use serde::Serialize;

use crate::config::{AgentConfig, SpawnConfig, TeamConfig};

/// What a guest's id starts with. `+` is in no team-file agent id (`$defs.Identifier`).
pub(crate) const PREFIX: &str = "mine+";

/// The id agent `agent` of My agents works under when it is brought in.
pub(crate) fn guest_id(agent: &str) -> String {
    format!("{PREFIX}{agent}")
}

/// The agent in My agents a guest's id names, when `id` is one.
pub(crate) fn agent_of(id: &str) -> Option<&str> {
    id.strip_prefix(PREFIX)
        .filter(|agent| crate::jobs::is_job_id(agent))
}

/// Whether `agent` may bring in the person's other agents in a run of `team` with no fixed order:
/// the team lists some (`guards.myAgents`), the agent's own switch is on, and it is the agent the
/// work starts with, the only one in its own chat included. A helper and a guest are never it.
pub(crate) fn may_bring_in(team: &TeamConfig, agent: &AgentConfig) -> bool {
    team.guards.my_agents > 0
        && team.edges.is_empty()
        && agent.allow_my_agents
        && !agent.is_operator()
        && team.entrypoint == agent.id
        && crate::helpers::lead_of(&agent.id).is_none()
        && agent_of(&agent.id).is_none()
}

/// One agent `my_agents` lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Listed {
    /// The id `dispatch` takes: `mine+<id>`.
    pub(crate) agent: String,
    pub(crate) name: String,
    pub(crate) does: String,
    pub(crate) model: String,
}

/// What `my_agents` answers: the agents, and how many more there were past the limit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Listing {
    pub(crate) agents: Vec<Listed>,
    pub(crate) more: usize,
}

/// The person's agents `team` may bring in, most recently saved first, at most `limit`:
/// - every agent in My agents that isn't on the team: an agent the team points at already works
///   there, as the team's own;
/// - that `may_run` says may run here: its file reviewed (ADR 0048), and its model's source
///   connected, so a lead never picks one that can't start. The model is the one the agent names,
///   or `fallback`, the lead's, when it names none.
pub(crate) fn listing(
    teams_root: &Path,
    team: &TeamConfig,
    limit: u32,
    fallback: &str,
    may_run: impl Fn(&str, &str) -> bool,
) -> Listing {
    let Ok(list) = crate::jobs::list_jobs(teams_root) else {
        return Listing {
            agents: Vec::new(),
            more: 0,
        };
    };
    let mut open: Vec<_> = list
        .jobs
        .into_iter()
        .filter(|job| {
            !team
                .agents
                .iter()
                .any(|agent| agent.from_agent.as_deref() == Some(job.id.as_str()))
        })
        .filter(|job| may_run(&job.id, job.spec.model.as_deref().unwrap_or(fallback)))
        .collect();
    // Most recently saved first: what the person worked on last is what they most likely meant.
    open.sort_by(|a, b| {
        b.spec
            .saved_at
            .cmp(&a.spec.saved_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let more = open.len().saturating_sub(limit);
    let agents = open
        .into_iter()
        .take(limit)
        .map(|job| Listed {
            agent: guest_id(&job.id),
            does: if job.spec.does.trim().is_empty() {
                crate::orientation::role_summary(&job.spec.instructions)
            } else {
                job.spec.does.trim().to_owned()
            },
            model: job
                .spec
                .model
                .clone()
                .unwrap_or_else(|| fallback.to_owned()),
            name: job.spec.name,
        })
        .collect();
    Listing { agents, more }
}

/// Agent `agent` of My agents as a guest of a run, as it is saved now: its fields filled in the
/// way a team's pointer to it is (ADR 0094), on `fallback`, the lead's model, when it names none.
/// It works in a folder of its own in the team's workspace, brings in no helpers and no one else,
/// and keeps the run's spending limit as its only guard.
///
/// # Errors
///
/// When it isn't in My agents any more, or its file no longer reads as an agent.
pub(crate) fn guest(teams_root: &Path, agent: &str, fallback: &str) -> Result<AgentConfig, String> {
    if !crate::jobs::is_job_id(agent) || crate::jobs::read_job(teams_root, agent).is_none() {
        return Err(format!("{agent:?} isn't in My agents any more."));
    }
    let mut entry = serde_yaml::Mapping::new();
    entry.insert("id".into(), agent.into());
    entry.insert("model".into(), fallback.into());
    let mut from = serde_yaml::Mapping::new();
    from.insert("agent".into(), agent.into());
    entry.insert("from".into(), from.into());
    let mut document = serde_yaml::Mapping::new();
    document.insert("schemaVersion".into(), 1.into());
    document.insert("id".into(), "guest".into());
    document.insert("name".into(), "guest".into());
    document.insert("entrypoint".into(), agent.into());
    document.insert(
        "agents".into(),
        serde_yaml::Value::Sequence(vec![entry.into()]),
    );
    document.insert("edges".into(), serde_yaml::Value::Sequence(Vec::new()));
    let source = serde_yaml::to_string(&document).map_err(|error| error.to_string())?;
    let team = TeamConfig::parse_in(&source, teams_root).map_err(|error| format!("{error:#}"))?;
    let mut guest = team
        .agents
        .into_iter()
        .next()
        .ok_or_else(|| format!("{agent:?} reads as no agent."))?;
    guest.id = guest_id(agent);
    guest.spawn = SpawnConfig::default();
    guest.allow_recruiting = false;
    guest.allow_my_agents = false;
    guest.checks = None;
    guest.send_back = None;
    guest.spend = crate::spend::SpendConfig::default();
    Ok(guest)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Folder(std::path::PathBuf);

    impl Folder {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn teams_folder() -> Folder {
        let path =
            std::env::temp_dir().join(format!("loomwatch-bring-in-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(path.join(".jobs")).expect("My agents");
        Folder(crate::platform::canonicalize(&path).expect("a canonical teams folder"))
    }

    fn save(root: &Path, id: &str, text: &str) {
        std::fs::write(root.join(".jobs").join(format!("{id}.yaml")), text).expect("an agent");
    }

    fn team(text: &str, root: &Path) -> TeamConfig {
        TeamConfig::parse_in(text, root).expect("the team reads")
    }

    const LEAD: &str = "schemaVersion: 1\nentrypoint: lead\nguards:\n  myAgents: 2\nagents:\n  - id: lead\n    name: Lead\n    role: Lead the work.\n    model: fake/offline\n  - id: placed\n    from:\n      agent: writer\n";

    #[test]
    fn a_guest_id_names_an_agent_and_no_team_id_can_be_one() {
        assert_eq!(guest_id("researcher"), "mine+researcher");
        assert_eq!(agent_of("mine+researcher"), Some("researcher"));
        assert_eq!(agent_of("researcher"), None);
        assert_eq!(agent_of("mine+../x"), None);
        assert!(!crate::config::is_identifier("mine+researcher"));
    }

    #[test]
    fn only_the_starting_agent_of_a_team_with_no_fixed_order_may_bring_one_in() {
        let root = teams_folder();
        save(
            root.path(),
            "writer",
            "name: Writer\ninstructions: Write.\nmodel: fake/offline\n",
        );
        let mine = team(LEAD, root.path());
        let lead = &mine.agents[0];
        assert!(may_bring_in(&mine, lead));
        // Its teammate, a helper and a guest may not.
        assert!(!may_bring_in(&mine, &mine.agents[1]));
        let mut copy = lead.clone();
        copy.id = "lead~2".into();
        assert!(!may_bring_in(&mine, &copy));
        // Off for the team, off for the agent, or a fixed order: no.
        let mut off = mine.clone();
        off.guards.my_agents = 0;
        assert!(!may_bring_in(&off, lead));
        let mut alone = lead.clone();
        alone.allow_my_agents = false;
        assert!(!may_bring_in(&mine, &alone));
        let ordered = team(&LEAD.replace("    from:\n      agent: writer\n", "    from:\n      agent: writer\nedges:\n  - from: lead\n    to: placed\n    layer: configured\n    kind: sequence\n    ts: \"2026-10-25T00:00:00Z\"\n"), root.path());
        assert!(!may_bring_in(&ordered, &ordered.agents[0]));
    }

    #[test]
    fn the_list_leaves_out_the_teams_own_and_what_cant_run_and_keeps_to_its_limit() {
        let root = teams_folder();
        save(
            root.path(),
            "writer",
            "name: Writer\ninstructions: Write.\nmodel: fake/offline\nsavedAt: 2026-10-25T05:00:00Z\n",
        );
        save(
            root.path(),
            "coder",
            "name: Coder\ndoes: Writes the code\ninstructions: Code.\nmodel: anthropic/claude-opus-5.5\nsavedAt: 2026-10-25T04:00:00Z\n",
        );
        save(
            root.path(),
            "analyst",
            "name: Analyst\ninstructions: Compare the options. Then say which.\nsavedAt: 2026-10-25T03:00:00Z\n",
        );
        save(
            root.path(),
            "editor",
            "name: Editor\ninstructions: Tighten.\nmodel: fake/offline\nsavedAt: 2026-10-25T02:00:00Z\n",
        );
        save(
            root.path(),
            "unpaid",
            "name: Unpaid\ninstructions: Wait.\nmodel: openai/gpt-6.1\nsavedAt: 2026-10-25T06:00:00Z\n",
        );
        let mine = team(LEAD, root.path());
        let listing = listing(root.path(), &mine, 2, "fake/offline", |_, model| {
            !model.starts_with("openai/")
        });
        // Writer is on the team, Unpaid can't run here: Coder and Analyst, newest first, one more.
        assert_eq!(
            listing.agents,
            vec![
                Listed {
                    agent: "mine+coder".into(),
                    name: "Coder".into(),
                    does: "Writes the code".into(),
                    model: "anthropic/claude-opus-5.5".into()
                },
                Listed {
                    agent: "mine+analyst".into(),
                    name: "Analyst".into(),
                    does: "Compare the options. Then say which.".into(),
                    model: "fake/offline".into()
                },
            ]
        );
        assert_eq!(listing.more, 1);
    }

    #[test]
    fn a_guest_is_the_agent_as_saved_in_its_own_folder_bringing_in_no_one() {
        let root = teams_folder();
        save(
            root.path(),
            "researcher",
            "name: Researcher\ninstructions: Find facts.\nmodel: anthropic/claude-sonnet-5.5\nskills: [cite]\nreads:\n  - name: Notes\n    path: ~/notes\nallow:\n  web: true\nhelpers: false\n",
        );
        save(
            root.path(),
            "analyst",
            "name: Analyst\ninstructions: Compare.\n",
        );
        let guest = guest(root.path(), "researcher", "fake/offline").expect("a guest");
        assert_eq!(guest.id, "mine+researcher");
        assert_eq!(guest.name, "Researcher");
        assert_eq!(guest.role, "Find facts.");
        assert_eq!(guest.model, "anthropic/claude-sonnet-5.5");
        assert_eq!(guest.from_agent.as_deref(), Some("researcher"));
        assert!(guest.allow.web);
        assert!(!guest.allow_recruiting && !guest.allow_my_agents);
        assert_eq!(guest.spawn.cwd, std::path::PathBuf::from("."));
        let kinds: Vec<_> = guest
            .capabilities
            .iter()
            .map(|capability| (capability.kind.as_str(), capability.name.as_str()))
            .collect();
        assert_eq!(kinds, [("knowledge", "Notes"), ("skill", "cite")]);
        // One that names no model runs on the lead's; one whose own switches are on still brings in
        // no helpers and no one else here.
        let analyst = super::guest(root.path(), "analyst", "fake/offline").expect("a guest");
        assert_eq!(analyst.model, "fake/offline");
        assert!(!analyst.allow_recruiting && !analyst.allow_my_agents);
        // Gone from My agents: said plainly.
        assert!(super::guest(root.path(), "gone", "fake/offline").is_err());
    }
}

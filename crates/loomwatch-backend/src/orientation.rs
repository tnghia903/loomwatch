//! `## Your place in the team` — where an agent sits, written from the team's own topology.
//!
//! An agent used to learn who its teammates were only if it called the Team Bus `roster` tool,
//! and nothing told the agent whose reply became the team's answer that it was writing for the
//! operator. Those were canvas facts the operator could see and the agent could not. This section
//! states them in the opening prompt, so a team composed by someone who never writes a prompt
//! still hands every agent its place: who comes before it, who reads its work after it, and which
//! answer is final (ADR 0034).
//!
//! Every sentence here is read off the team file and the run's own order, never inferred: an
//! orientation that promised a teammate the agent cannot reach, or a reader who never sees the
//! text, would be worse than none. A team of one has no place to describe, so it gets no section
//! and its prompt is byte-for-byte what it was before.

use std::fmt::Write as _;

use crate::config::{AgentConfig, TeamConfig};
use crate::skill_routing::{self, BusMode};
use crate::workspace::Harness;

/// The heading the section is rendered under.
pub const HEADING: &str = "## Your place in the team";

/// Characters of a teammate's role shown beside its name: enough to say what it is for, short
/// enough that a team of eight does not spend the prompt on other agents' instructions.
const ROLE_SUMMARY_CHARS: usize = 140;

/// What the agent whose reply is the team's answer is told about writing it.
const FINAL_ANSWER: &str = "Your reply is the team's final answer: the operator reads it as you write it. Make it the finished result itself, not a report on how you produced it.";

/// The team-mode lead: the entrypoint, which receives the request and answers it.
#[must_use]
pub fn for_lead(team: &TeamConfig, agent: &AgentConfig) -> Option<String> {
    let teammates = team
        .agents
        .iter()
        .filter(|other| other.id != agent.id && !other.is_operator())
        .collect::<Vec<_>>();
    if teammates.is_empty() {
        return None;
    }
    let mut text = format!(
        "You are {}, the lead of {}. The operator's request comes to you first.\n{FINAL_ANSWER}",
        agent.name,
        team_label(team)
    );
    // A harness without HTTP MCP is offered no Team Bus tools at all, so naming teammates it
    // cannot reach would be an instruction it cannot follow.
    if skill_routing::bus_tools(Harness::of(agent), BusMode::Team, agent.allow_recruiting).delegate
    {
        text.push_str(
            "\n\nYour teammates, whom you can hand parts of the work to with your Team Bus tools:",
        );
        for teammate in teammates {
            let _ = write!(text, "\n{}", teammate_line(teammate));
        }
    }
    Some(text)
}

/// A pipeline stage at `index` in the run's `order`.
///
/// Predecessors and successors come from the configured edges rather than from `order`'s
/// neighbours, so a stage that joins two branches names both, and a stage after a review stop is
/// told the operator was there. A stage that has Team Bus tools is given each one's id as well:
/// it can `ask` a predecessor that is still open, and a stage told only "Before you: Technical
/// approach researcher" put that name in the call where the id belongs.
#[must_use]
pub fn for_stage(
    team: &TeamConfig,
    agent: &AgentConfig,
    order: &[String],
    index: usize,
    responder: &str,
) -> Option<String> {
    if order.len() < 2 {
        return None;
    }
    let mut text = format!(
        "You are {}, step {} of {} in {}.",
        agent.name,
        index + 1,
        order.len(),
        team_label(team)
    );
    let ids = skill_routing::bus_tools(
        Harness::of(agent),
        BusMode::Pipeline,
        agent.allow_recruiting,
    )
    .reachable();
    let before = neighbours(team, |edge| (edge.to == agent.id).then_some(&edge.from));
    if before.is_empty() {
        text.push_str("\nThe operator's request comes to you first.");
    } else {
        let _ = write!(
            text,
            "\nBefore you: {}. What came before you is in the sections above the task.",
            names(&before, ids)
        );
    }
    let after = neighbours(team, |edge| (edge.from == agent.id).then_some(&edge.to));
    if !after.is_empty() {
        let _ = write!(
            text,
            "\nAfter you: {}. When your work is done you will be asked for a handover, and that \
             handover is all they receive — they do not see this conversation.",
            names(&after, ids)
        );
    }
    if responder == agent.id {
        text.push('\n');
        text.push_str(FINAL_ANSWER);
    }
    Some(text)
}

/// An agent the operator wrote to directly with an @mention (ADR 0051).
///
/// It works alone this time, and it has to be told so: its usual orientation names a successor
/// that will not run and a final answer it is not writing. What it is asked for is a new version
/// of its own work — the brief the operator's message is the objective of — so the boundaries are
/// stated here: the whole result, and nothing changed that was not asked for.
#[must_use]
pub fn for_one_agent(team: &TeamConfig, agent: &AgentConfig) -> String {
    format!(
        "You are {}, on {}. The operator wrote to you directly, so this time you work alone: \
         nobody else on the team runs, and your reply goes straight back to the operator.\n\
         Reply with the complete new version of your work, not a description of what changed, \
         and keep everything the task does not ask you to change.",
        agent.name,
        team_label(team)
    )
}

/// A helper another agent brought in through the Team Bus.
///
/// Deliberately silent about where the reply goes: `ask` returns it to the caller, while
/// `dispatch` and `handoff` run in the background, and the helper cannot tell which it is.
#[must_use]
pub fn for_helper(team: &TeamConfig, agent: &AgentConfig, caller: Option<&str>) -> Option<String> {
    let caller = caller
        .and_then(|id| team.agents.iter().find(|other| other.id == id))
        .map_or("Another agent", |other| other.name.as_str());
    Some(format!(
        "You are {}, on {}. {caller} brought you in for the task below. It is one part of a \
         larger piece of work, so do what was asked, completely, and stay within it.",
        agent.name,
        team_label(team)
    ))
}

fn team_label(team: &TeamConfig) -> String {
    let name = if team.name.trim().is_empty() {
        team.id.trim()
    } else {
        team.name.trim()
    };
    if name.is_empty() {
        "this team".to_owned()
    } else if name.to_lowercase().ends_with("team") {
        // "Research team" is already a team; "the Research team team" is not a sentence.
        format!("the {name}")
    } else {
        format!("the {name} team")
    }
}

/// The agents an edge filter selects, in the order their edges are declared.
fn neighbours<'a>(
    team: &'a TeamConfig,
    select: impl Fn(&'a crate::config::EdgeConfig) -> Option<&'a String>,
) -> Vec<&'a AgentConfig> {
    team.edges
        .iter()
        .filter_map(select)
        .filter_map(|id| team.agents.iter().find(|agent| &agent.id == id))
        .collect()
}

/// The agents as a sentence list, each followed by its Team Bus id when `with_ids`.
fn names(agents: &[&AgentConfig], with_ids: bool) -> String {
    let named = agents
        .iter()
        .map(|agent| {
            if agent.is_operator() {
                "the operator, at a review stop".to_owned()
            } else if with_ids {
                format!("{} (`{}`)", agent.name, agent.id)
            } else {
                agent.name.clone()
            }
        })
        .collect::<Vec<_>>();
    match named.as_slice() {
        [] => String::new(),
        [only] => only.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn teammate_line(agent: &AgentConfig) -> String {
    let summary = role_summary(&agent.role);
    if summary.is_empty() {
        format!("- {} (`{}`)", agent.name, agent.id)
    } else {
        format!("- {} (`{}`): {summary}", agent.name, agent.id)
    }
}

/// The first line of a role, cut on a character boundary.
fn role_summary(role: &str) -> String {
    let line = role.lines().map(str::trim).find(|line| !line.is_empty());
    let Some(line) = line else {
        return String::new();
    };
    if line.chars().count() <= ROLE_SUMMARY_CHARS {
        return line.to_owned();
    }
    let cut = line.chars().take(ROLE_SUMMARY_CHARS).collect::<String>();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team(yaml: &str) -> TeamConfig {
        serde_yaml::from_str(yaml).expect("team parses")
    }

    const AGENT: &str = "spawn: { cmd: claude-agent-acp, cwd: . }\n    model: sonnet";

    fn edge(from: &str, to: &str) -> String {
        format!(
            "  - {{ from: {from}, to: {to}, layer: configured, kind: sequence, ts: \"2026-10-02T00:00:00Z\" }}\n"
        )
    }

    fn pipeline() -> TeamConfig {
        team(&format!(
            "schemaVersion: 1\nname: News desk\nentrypoint: research\nagents:\n  \
             - id: research\n    name: Researcher\n    role: Find sources.\n    {AGENT}\n  \
             - id: check\n    name: Fact-checker\n    role: Verify the research.\n    {AGENT}\n  \
             - id: write\n    name: Writer\n    role: Write the piece.\n    {AGENT}\n\
             edges:\n{}{}",
            edge("research", "check"),
            edge("check", "write"),
        ))
    }

    fn order() -> Vec<String> {
        ["research", "check", "write"].map(str::to_owned).to_vec()
    }

    #[test]
    fn a_middle_stage_is_told_who_hands_to_it_and_who_reads_its_handover() {
        let team = pipeline();
        let text = for_stage(&team, &team.agents[1], &order(), 1, "write").unwrap();
        assert!(text.starts_with("You are Fact-checker, step 2 of 3 in the News desk team."));
        assert!(
            text.contains("Before you: Researcher (`research`)."),
            "{text}"
        );
        assert!(text.contains("After you: Writer (`write`)."), "{text}");
        assert!(text.contains("they do not see this conversation"));
        assert!(
            !text.contains("final answer"),
            "only the responder writes the answer: {text}"
        );

        // A harness with no Team Bus tools has nothing to put an id into, so it hears names.
        let mut without_bus = team.clone();
        without_bus.agents[1].spawn.cmd = "some-unknown-acp".to_owned();
        let text = for_stage(&without_bus, &without_bus.agents[1], &order(), 1, "write").unwrap();
        assert!(text.contains("Before you: Researcher."), "{text}");
        assert!(text.contains("After you: Writer."), "{text}");
    }

    #[test]
    fn the_first_stage_receives_the_request_and_the_last_writes_the_answer() {
        let team = pipeline();
        let first = for_stage(&team, &team.agents[0], &order(), 0, "write").unwrap();
        assert!(first.contains("The operator's request comes to you first."));
        assert!(!first.contains("Before you"));
        let last = for_stage(&team, &team.agents[2], &order(), 2, "write").unwrap();
        assert!(last.contains(FINAL_ANSWER));
        assert!(
            !last.contains("After you"),
            "nothing reads the last stage's handover: {last}"
        );
    }

    #[test]
    fn a_join_names_every_branch_and_a_review_stop_is_the_operator() {
        let team = team(&format!(
            "schemaVersion: 1\nname: Desk\nentrypoint: a\nagents:\n  \
             - id: a\n    name: Alpha\n    role: One.\n    {AGENT}\n  \
             - id: b\n    name: Beta\n    role: Two.\n    {AGENT}\n  \
             - id: stop\n    kind: operator\n    name: Review\n    role: Approve?\n  \
             - id: c\n    name: Gamma\n    role: Three.\n    {AGENT}\n\
             edges:\n{}{}{}{}",
            edge("a", "b"),
            edge("a", "stop"),
            edge("b", "c"),
            edge("stop", "c"),
        ));
        let order = ["a", "b", "stop", "c"].map(str::to_owned).to_vec();
        let text = for_stage(&team, &team.agents[3], &order, 3, "c").unwrap();
        assert!(
            text.contains("Before you: Beta (`b`) and the operator, at a review stop."),
            "{text}"
        );
    }

    #[test]
    fn a_lead_hears_its_teammates_only_when_it_can_reach_them() {
        let with_bus = team(&format!(
            "schemaVersion: 1\nname: Desk\nentrypoint: lead\nagents:\n  \
             - id: lead\n    name: Lead\n    role: Run the desk.\n    {AGENT}\n  \
             - id: help\n    name: Helper\n    role: |\n      Look things up.\n      Second line.\n    {AGENT}\n"
        ));
        let text = for_lead(&with_bus, &with_bus.agents[0]).unwrap();
        assert!(text.contains(FINAL_ANSWER));
        assert!(
            text.contains("- Helper (`help`): Look things up."),
            "{text}"
        );
        assert!(
            !text.contains("Second line"),
            "a teammate is summarised by its first line"
        );

        // A harness with no HTTP MCP gets no Team Bus tools, so it is not told about teammates it
        // has no way to reach.
        let mut without_bus = with_bus.clone();
        without_bus.agents[0].spawn.cmd = "some-unknown-acp".to_owned();
        let text = for_lead(&without_bus, &without_bus.agents[0]).unwrap();
        assert!(text.contains(FINAL_ANSWER));
        assert!(!text.contains("teammates"), "{text}");
    }

    #[test]
    fn a_team_of_one_has_no_place_to_describe() {
        let solo = team(&format!(
            "schemaVersion: 1\nentrypoint: only\nagents:\n  \
             - id: only\n    name: Only\n    role: Everything.\n    {AGENT}\n"
        ));
        assert_eq!(for_lead(&solo, &solo.agents[0]), None);
        assert_eq!(
            for_stage(&solo, &solo.agents[0], &["only".to_owned()], 0, "only"),
            None
        );
    }

    #[test]
    fn a_helper_is_told_who_brought_it_in_without_a_claim_about_where_its_reply_goes() {
        let team = pipeline();
        let text = for_helper(&team, &team.agents[2], Some("check")).unwrap();
        assert!(text.contains("Fact-checker brought you in"), "{text}");
        assert!(!text.contains("final answer"));
        let unknown = for_helper(&team, &team.agents[2], None).unwrap();
        assert!(unknown.contains("Another agent brought you in"));
    }

    #[test]
    fn a_team_named_as_a_team_is_not_called_a_team_twice() {
        let mut team = pipeline();
        assert_eq!(team_label(&team), "the News desk team");
        team.name = "Research Team".to_owned();
        assert_eq!(team_label(&team), "the Research Team");
        team.name = String::new();
        team.id = String::new();
        assert_eq!(team_label(&team), "this team");
    }

    #[test]
    fn a_long_role_is_cut_on_a_character_boundary() {
        let role = "é".repeat(ROLE_SUMMARY_CHARS + 10);
        let summary = role_summary(&role);
        assert_eq!(summary.chars().count(), ROLE_SUMMARY_CHARS + 1);
        assert!(summary.ends_with('…'));
    }
}

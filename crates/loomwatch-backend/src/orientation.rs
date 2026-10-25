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
use crate::prompt_blocks::Block;
use crate::skill_routing::{self, BusMode};

/// The heading the section is rendered under.
pub const HEADING: &str = "## Your place in the team";

/// Characters of a teammate's role shown beside its name: enough to say what it is for, short
/// enough that a team of eight does not spend the prompt on other agents' instructions.
const ROLE_SUMMARY_CHARS: usize = 140;

/// What the agent whose reply is the team's answer is told about writing it.
pub(crate) const FINAL_ANSWER: Block = Block::new(
    "orientation.final_answer",
    "Your reply is the team's final answer: the operator reads it as you write it. Make it the \
     finished result itself, as long as the request needs and no longer, not a report on how you \
     produced it.",
);

/// The lead, first: who it is and that the request comes to it.
pub(crate) const LEAD: Block = Block::new(
    "orientation.lead",
    "You are {name}, the lead of {team}. The operator's request comes to you first.",
);

/// Above the lead's teammates, one line each.
pub(crate) const LEAD_TEAMMATES: Block = Block::new(
    "orientation.lead_teammates",
    "Your teammates, whom you can hand parts of the work to with your Team Bus tools:",
);

/// What a lead may not do and `{teammates}` may (`what_teammates_may_do_instead`). `{ability}` is
/// "search the web", "change files" or "run commands"; `{it_or_them}` is "it" for one teammate.
pub(crate) const TEAMMATES_CAN: Block = Block::new(
    "orientation.teammates_can",
    "You can't {ability} yourself, but {teammates} can: hand {it_or_them} the parts that need it.",
);

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
    let mut text = LEAD.fill(&[("name", &agent.name), ("team", &team_label(team))]);
    text.push('\n');
    text.push_str(FINAL_ANSWER.text());
    if skill_routing::bus_tools(BusMode::Team, agent.allow_recruiting).delegate {
        text.push_str("\n\n");
        text.push_str(LEAD_TEAMMATES.text());
        for teammate in &teammates {
            let _ = write!(text, "\n{}", teammate_line(teammate));
        }
        for line in what_teammates_may_do_instead(agent, &teammates) {
            text.push_str("\n\n");
            text.push_str(&line);
        }
        text.push_str("\n\n");
        text.push_str(DELEGATION.text());
    }
    Some(text)
}

/// How a lead uses its teammates, said once for every lead so an operator never has to write it.
///
/// Effort scaled to the request first, because a lead that brings in every teammate for a
/// one-line question pays a session per teammate for nothing: Anthropic's research system had to
/// write the same rule into its lead after it spawned many subagents for simple queries. Then the
/// brief, because the teammate sees only what it is sent (`for_helper`), and a vague brief is the
/// commonest way delegated work is duplicated or misread.
pub(crate) const DELEGATION: Block = Block::new(
    "orientation.delegation",
    "Do what you can do well yourself, and bring in a teammate only for a part that needs its \
     job: each one you start opens a session of its own, which costs time and tokens. A teammate \
     sees only what you send it, so give it the goal, what you already know, what to send back \
     and where to stop. Check what comes back before you use it.",
);

/// A pipeline stage, first: who it is and where it sits.
pub(crate) const STAGE: Block = Block::new(
    "orientation.stage",
    "You are {name}, step {step} of {steps} in {team}.",
);

/// The first stage.
pub(crate) const STAGE_FIRST: Block = Block::new(
    "orientation.stage_first",
    "The operator's request comes to you first.",
);

/// Any later stage: `{names}` are the stages connected into it.
pub(crate) const STAGE_BEFORE: Block = Block::new(
    "orientation.stage_before",
    "Before you: {names}. What came before you is in the sections above the task.",
);

/// A check step with stages after it, which are handed `{checked}`'s work instead of its reply.
pub(crate) const STAGE_AFTER_CHECK: Block = Block::new(
    "orientation.stage_after_check",
    "After you: {names}. They receive {checked}'s work, not your reply, with the items you mark \
     Not met or Not sure.",
);

/// A stage whose every successor is a check step on its work.
pub(crate) const STAGE_AFTER_CHECKER: Block = Block::new(
    "orientation.stage_after_checker",
    "After you: {names}, which checks your reply as you write it against what it must satisfy.",
);

/// A stage with a review stop after it.
pub(crate) const STAGE_AFTER_REVIEW: Block = Block::new(
    "orientation.stage_after_review",
    "After you: {names}. When your work is done you will be asked for a handover, and that \
     handover is all they receive — they do not see this conversation.",
);

/// A stage with other stages after it.
pub(crate) const STAGE_AFTER: Block = Block::new(
    "orientation.stage_after",
    "After you: {names}. They receive your reply as you write it, or, when it runs long, a \
     shorter handover you will be asked for. They do not see this conversation.",
);

/// A check step: whose work it checks, before [`CHECK_BLOCK`].
pub(crate) const CHECK: Block = Block::new(
    "orientation.check",
    "You check {checked}'s work: it is in the sections above the task, with what it was given and \
     what it must satisfy.",
);

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
    let mut text = STAGE.fill(&[
        ("name", &agent.name),
        ("step", &(index + 1).to_string()),
        ("steps", &order.len().to_string()),
        ("team", &team_label(team)),
    ]);
    let ids = skill_routing::bus_tools(BusMode::Pipeline, agent.allow_recruiting).reachable();
    let before = neighbours(team, |edge| (edge.to == agent.id).then_some(&edge.from));
    text.push('\n');
    if before.is_empty() {
        text.push_str(STAGE_FIRST.text());
    } else {
        text.push_str(&STAGE_BEFORE.fill(&[("names", &names(&before, ids))]));
    }
    let after = neighbours(team, |edge| (edge.from == agent.id).then_some(&edge.to));
    let checked = agent
        .checks
        .as_deref()
        .and_then(|id| team.agents.iter().find(|other| other.id == id));
    if let Some(checked) = checked.filter(|_| !after.is_empty()) {
        // ADR 0062: a check step hands on the work it checked, not its own reply (lib.rs
        // `checked_work_handover`), so it writes no handover either.
        text.push('\n');
        text.push_str(
            &STAGE_AFTER_CHECK.fill(&[("names", &names(&after, ids)), ("checked", &checked.name)]),
        );
    } else if !after.is_empty()
        && after
            .iter()
            .all(|next| next.checks.as_deref() == Some(agent.id.as_str()))
    {
        // ADR 0062: a check step is handed the work itself, so there is no handover to write.
        text.push('\n');
        text.push_str(&STAGE_AFTER_CHECKER.fill(&[("names", &names(&after, ids))]));
    } else if !after.is_empty() && after.iter().any(|next| next.is_operator()) {
        text.push('\n');
        text.push_str(&STAGE_AFTER_REVIEW.fill(&[("names", &names(&after, ids))]));
    } else if !after.is_empty() {
        // A short reply is handed on as written, and a long one is summarised in a handover first
        // (`reply_is_its_own_handover` in lib.rs).
        text.push('\n');
        text.push_str(&STAGE_AFTER.fill(&[("names", &names(&after, ids))]));
    }
    if let Some(checked) = checked {
        // ADR 0062: the verdict is read from this block whatever the role says, so a check step
        // whose instructions were written by hand or by Ask LoomWatch is told it here; without
        // it, every item reads Not sure and nothing can be sent back.
        text.push('\n');
        text.push_str(&CHECK.fill(&[("checked", &checked.name)]));
        text.push(' ');
        text.push_str(CHECK_BLOCK.text());
    }
    if responder == agent.id {
        text.push('\n');
        text.push_str(FINAL_ANSWER.text());
    }
    Some(text)
}

/// How a check step reports, wherever its instructions came from: the block the daemon reads its
/// verdict from (`read_checks`).
///
/// Numbered, because a line is matched to the item it answers; and every problem is a line,
/// because a problem written only above the block is never shown or sent back.
pub(crate) const CHECK_BLOCK: Block = Block::new(
    "orientation.check_block",
    "Do not rewrite the work. End your reply with this block, one line for each numbered item it \
     must satisfy, in order, starting with its number. Every problem you found must be one of \
     these lines, marked Not met:\n## Check\n1. Met | Not met | Not sure — the item — your \
     evidence",
);

/// The heading of the section that says how to read the request.
pub const READING_HEADING: &str = "## Reading the request";

/// `## Reading the request`: the role says who the agent is, and the task is what the operator
/// wants now, read for what it means.
///
/// Without it, an agent handed "hi", "why did you leave X out?" or "make it shorter" read its role
/// as the job and did that job again in full: the role is the most specific instruction it has,
/// and a short task looked like nothing to go on. A colleague would answer the greeting, answer
/// the question, or make the change. Fixed text, so it sits in the cached part of the prompt; the
/// lines about teammates and checks only for an agent that has them.
#[must_use]
pub fn reading(in_team: bool, checks: bool) -> String {
    let mut text = READING.text().to_owned();
    if in_team {
        text.push('\n');
        text.push_str(READING_TEAM.text());
    }
    if checks {
        text.push('\n');
        text.push_str(READING_CHECKS.text());
    }
    text
}

/// `## Reading the request`, for every agent.
pub(crate) const READING: Block = Block::new(
    "orientation.reading",
    "Your role above says who you are and how you work. It is not a job to do again on every \
     message. The task at the end is what the operator wants now: read it as a thoughtful \
     colleague would, with the conversation so far, and give them what they meant.\n\
     - Asked for work your role covers: do it fully.\n\
     - Asked a question: answer it, from the conversation, earlier work and what you were handed, \
     instead of producing your usual result. Look things up only when the answer needs it.\n\
     - Asked to change something already made: change that, and keep the rest.\n\
     - Greeted, thanked or chatted with: reply in a sentence or two, as a person would, and start \
     no work.\n\
     - Hold \"Done when\" to what was asked: an item about something the request doesn't call for \
     does not apply.\n\
     - When you can't tell what they want and a wrong guess would waste real work, ask. Otherwise \
     take the likeliest reading and say which one you took.",
);

/// Its line for an agent with teammates.
pub(crate) const READING_TEAM: Block = Block::new(
    "orientation.reading_team",
    "- Your teammates read the same request. When it needs nothing from your part, say so in a \
     line and pass on what you were handed as it is, rather than redoing your job. If your reply \
     is the team's answer, give the operator that answer itself.",
);

/// Its line for a check step.
pub(crate) const READING_CHECKS: Block = Block::new(
    "orientation.reading_checks",
    "- When you check a teammate's work, check it against what the operator asked, and always end \
     with your check block. When the request asked for no work, such as a greeting, mark each item \
     Met with \"Does not apply\" and why.",
);

/// An agent the operator wrote to directly with an @mention (ADR 0051).
///
/// It works alone this time, and it has to be told so: its usual orientation names a successor
/// that will not run and a final answer it is not writing. What it is asked for is a new version
/// of its own work — the brief the operator's message is the objective of — so the boundaries are
/// stated here: the whole result, and nothing changed that was not asked for.
///
/// Asked about a part of a file (ADR 0077), it still answers alone when the answer is its job,
/// and when it is a teammate's job it asks that teammate (`ask`, which the run's bus offers it,
/// `TeamBus::lets_ask_teammates`) and answers with what it says, so it is told who is on the team
/// and what each one is for.
#[must_use]
pub fn for_one_agent(team: &TeamConfig, agent: &AgentConfig, about_a_part: bool) -> String {
    let teammates = team
        .agents
        .iter()
        .filter(|other| about_a_part && other.id != agent.id && !other.is_operator())
        .collect::<Vec<_>>();
    let label = team_label(team);
    let who = [("name", agent.name.as_str()), ("team", label.as_str())];
    let mut text = if teammates.is_empty() {
        ONE_AGENT.fill(&who)
    } else {
        let mut text = ONE_AGENT_ABOUT_A_PART.fill(&who);
        for teammate in &teammates {
            let _ = write!(text, "\n{}", teammate_line(teammate));
        }
        text
    };
    text.push('\n');
    text.push_str(ONE_AGENT_CHANGES.text());
    text
}

/// An agent the operator wrote to directly.
pub(crate) const ONE_AGENT: Block = Block::new(
    "orientation.one_agent",
    "You are {name}, on {team}. The operator wrote to you directly, so this time you work alone: \
     nobody else on the team runs, and your reply goes straight back to the operator.",
);

/// An agent asked about a part of a file, with teammates to ask, listed after it.
pub(crate) const ONE_AGENT_ABOUT_A_PART: Block = Block::new(
    "orientation.one_agent_about_a_part",
    "You are {name}, on {team}. The operator asked you directly about a part of a file, and your \
     reply goes straight back to the operator.\n\
     Answer it yourself when the answer is within your job. When it needs a teammate's job, ask \
     that teammate with your Team Bus `ask` tool, sending the part, the question and what you need \
     back, then answer with what it says and name who you asked. Your teammates:",
);

/// Either way, last.
pub(crate) const ONE_AGENT_CHANGES: Block = Block::new(
    "orientation.one_agent_changes",
    "When the task asks you to change your work, reply with the complete new version of it, not a \
     description of what changed, and keep everything the task does not ask you to change. When it \
     asks something else, such as a question about your work, answer that.",
);

/// A helper another agent brought in through the Team Bus.
///
/// Deliberately silent about where the reply goes: `ask` returns it to the caller, while
/// `dispatch` and `handoff` run in the background, and the helper cannot tell which it is.
#[must_use]
pub fn for_helper(team: &TeamConfig, agent: &AgentConfig, caller: Option<&str>) -> Option<String> {
    let caller = caller
        .and_then(|id| team.agents.iter().find(|other| other.id == id))
        .map_or("Another agent", |other| other.name.as_str());
    let mut text = HELPER.fill(&[
        ("name", &agent.name),
        ("team", &team_label(team)),
        ("caller", caller),
    ]);
    // One of the person's agents brought in from My agents (ADR 0092): it isn't on the team.
    if crate::bring_in::agent_of(&agent.id).is_some() {
        text.push('\n');
        text.push_str(GUEST.text());
    }
    Some(text)
}

/// What a guest is told after [`HELPER`]: it came from My agents, for this part (ADR 0092).
pub(crate) const GUEST: Block = Block::new(
    "orientation.guest",
    "You are not on this team: you are one of the person's own agents, brought in from My agents \
     for this part alone.",
);

/// `place` with what the agent the work starts with is told when it may bring in the person's
/// other agents (ADR 0092), after where it sits and who its teammates are.
#[must_use]
pub fn with_my_agents(place: Option<String>) -> Option<String> {
    Some(match place {
        Some(place) => format!("{place}\n\n{}", MY_AGENTS.text()),
        None => MY_AGENTS.text().to_owned(),
    })
}

/// What the agent the work starts with is told when it may bring in the person's other agents.
pub(crate) const MY_AGENTS: Block = Block::new(
    "orientation.my_agents",
    "When part of the work needs a job no one here does, you may bring in one of the person's \
     other agents: `my_agents` lists them, and `dispatch` starts one by the id it gives. Hand work \
     to your own team first.",
);

/// A teammate another agent brought in. `{caller}` is that agent's name, or "Another agent".
///
/// The last two sentences are the return a caller can use (ADR 0062): a helper may read widely, but
/// what it sends back lands in the caller's context, so it is the result, condensed, and a part it
/// could not do is named rather than guessed at.
pub(crate) const HELPER: Block = Block::new(
    "orientation.helper",
    "You are {name}, on {team}. {caller} brought you in for the task below. It is one part of a \
     larger piece of work, so do what was asked, completely, and stay within it.\n\
     Reply with the result itself, condensed: what you found or made, and where (links, file \
     paths), not how you worked. If you cannot do part of it, say what is missing rather than \
     guessing.",
);

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
    let mut line = if summary.is_empty() {
        format!("- {} (`{}`)", agent.name, agent.id)
    } else {
        format!("- {} (`{}`): {summary}", agent.name, agent.id)
    };
    let may = switched_on(agent);
    if !may.is_empty() {
        let _ = write!(line, " May {}.", sentence_list(&may));
    }
    line
}

/// What an agent's switches let it do without asking (ADR 0037), in words.
fn switched_on(agent: &AgentConfig) -> Vec<&'static str> {
    [
        (agent.allow.web, "search the web"),
        (agent.allow.edits, "change files"),
        (agent.allow.commands, "run commands"),
    ]
    .into_iter()
    .filter_map(|(on, words)| on.then_some(words))
    .collect()
}

/// One `allow` switch: whether the lead has it, what it lets an agent do, and how to read it.
type Switch = (bool, &'static str, fn(&AgentConfig) -> bool);

/// The switches a lead lacks and a teammate has, said plainly (ADR 0062).
///
/// Measured on a Writer lead with a web-enabled Researcher: asked for a current fact, the lead
/// tried the web itself, was declined, and answered that it could not find out, without asking
/// the teammate that could. Told who may do what, it has somewhere to send that part.
fn what_teammates_may_do_instead(lead: &AgentConfig, teammates: &[&AgentConfig]) -> Vec<String> {
    let switches: [Switch; 3] = [
        (lead.allow.web, "search the web", |agent| agent.allow.web),
        (lead.allow.edits, "change files", |agent| agent.allow.edits),
        (lead.allow.commands, "run commands", |agent| {
            agent.allow.commands
        }),
    ];
    switches
        .into_iter()
        .filter(|(lead_may, _, _)| !lead_may)
        .filter_map(|(_, words, may)| {
            let able: Vec<String> = teammates
                .iter()
                .filter(|teammate| may(teammate))
                .map(|teammate| teammate.name.clone())
                .collect();
            (!able.is_empty()).then(|| {
                TEAMMATES_CAN.fill(&[
                    ("ability", words),
                    ("teammates", &sentence_list(&able)),
                    ("it_or_them", if able.len() == 1 { "it" } else { "them" }),
                ])
            })
        })
        .collect()
}

fn sentence_list<T: AsRef<str>>(items: &[T]) -> String {
    match items {
        [] => String::new(),
        [only] => only.as_ref().to_owned(),
        [rest @ .., last] => format!(
            "{} and {}",
            rest.iter()
                .map(AsRef::as_ref)
                .collect::<Vec<_>>()
                .join(", "),
            last.as_ref()
        ),
    }
}

/// The first line of a role, cut on a character boundary.
pub(crate) fn role_summary(role: &str) -> String {
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
    fn an_agent_asked_about_a_part_of_a_file_is_told_whom_to_ask_when_it_is_not_its_job() {
        let team = pipeline();
        let writer = &team.agents[2];
        let text = for_one_agent(&team, writer, true);
        assert!(
            text.starts_with(
                "You are Writer, on the News desk team. The operator asked you directly about a \
                 part of a file"
            ),
            "{text}"
        );
        assert!(
            text.contains("Answer it yourself when the answer is within your job."),
            "{text}"
        );
        assert!(
            text.contains("ask that teammate with your Team Bus `ask` tool"),
            "{text}"
        );
        assert!(
            text.contains("\n- Researcher (`research`): Find sources."),
            "{text}"
        );
        assert!(
            text.contains("\n- Fact-checker (`check`): Verify the research."),
            "{text}"
        );
        assert!(!text.contains("- Writer ("), "{text}");
        assert!(!text.contains("nobody else"), "{text}");
        // Written to with a message, it works alone, as it always did.
        let plain = for_one_agent(&team, writer, false);
        assert!(
            plain.contains("this time you work alone: nobody else on the team runs"),
            "{plain}"
        );
        assert!(!plain.contains("`ask`"), "{plain}");
        // With nobody else on the team, a part is answered alone too.
        let mut alone = pipeline();
        alone.agents.truncate(1);
        let text = for_one_agent(&alone, &alone.agents[0], true);
        assert!(text.contains("nobody else on the team runs"), "{text}");
    }

    #[test]
    fn a_check_step_is_told_the_block_its_verdict_is_read_from_whatever_its_role_says() {
        let mut team = pipeline();
        team.agents[1].checks = Some("research".to_owned());
        let text = for_stage(&team, &team.agents[1], &order(), 1, "write").unwrap();
        assert!(text.contains("You check Researcher's work"), "{text}");
        assert!(
            text.contains("Every problem you found must be one of these lines, marked Not met"),
            "{text}"
        );
        assert!(
            text.ends_with("## Check\n1. Met | Not met | Not sure — the item — your evidence"),
            "{text}"
        );
        // Its successor is handed the work it checked, so it is not asked for a handover.
        assert!(
            text.contains(
                "After you: Writer (`write`). They receive Researcher's work, not your reply"
            ),
            "{text}"
        );
        assert!(!text.contains("handover"), "{text}");
        // A stage that checks nothing is not told to.
        let plain = pipeline();
        let text = for_stage(&plain, &plain.agents[1], &order(), 1, "write").unwrap();
        assert!(!text.contains("## Check"), "{text}");
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
        assert!(
            text.contains(
                "They receive your reply as you write it, or, when it runs long, a \
                           shorter handover"
            ) && text.contains("They do not see this conversation."),
            "{text}"
        );
        assert!(
            !text.contains("final answer"),
            "only the responder writes the answer: {text}"
        );
    }

    #[test]
    fn the_first_stage_receives_the_request_and_the_last_writes_the_answer() {
        let team = pipeline();
        let first = for_stage(&team, &team.agents[0], &order(), 0, "write").unwrap();
        assert!(first.contains("The operator's request comes to you first."));
        assert!(!first.contains("Before you"));
        let last = for_stage(&team, &team.agents[2], &order(), 2, "write").unwrap();
        assert!(last.contains(FINAL_ANSWER.text()));
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
        assert!(text.contains(FINAL_ANSWER.text()));
        assert!(
            text.contains("- Helper (`help`): Look things up."),
            "{text}"
        );
        assert!(
            !text.contains("Second line"),
            "a teammate is summarised by its first line"
        );
        assert!(
            text.ends_with(DELEGATION.text()),
            "a lead that can reach its teammates is told when and how to use them: {text}"
        );

        // A teammate that may search the web is said to, and a lead that may not is told who can.
        let mut researching = with_bus.clone();
        researching.agents[1].allow.web = true;
        let text = for_lead(&researching, &researching.agents[0]).unwrap();
        assert!(
            text.contains("- Helper (`help`): Look things up. May search the web."),
            "{text}"
        );
        assert!(
            text.contains(
                "You can't search the web yourself, but Helper can: hand it the parts that need it."
            ),
            "{text}"
        );
        researching.agents[0].allow.web = true;
        let text = for_lead(&researching, &researching.agents[0]).unwrap();
        assert!(!text.contains("You can't"), "{text}");
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
        // What it sends back lands in the caller's context: the result, and what it could not do.
        assert!(
            text.contains("Reply with the result itself, condensed")
                && text.contains("say what is missing rather than guessing"),
            "{text}"
        );
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

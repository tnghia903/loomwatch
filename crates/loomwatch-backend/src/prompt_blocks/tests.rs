use std::fmt::Write as _;
use std::path::Path;

use crate::agent::prompt::{Abilities, system_prompt};
use crate::agent::tools::Builtin;
use crate::config::TeamConfig;
use crate::team_bus::{BusSeat, TeamBusMode, offered_tools};
use crate::you::AboutYou;

/// The prompts as `rendered.txt` holds them, rebuilt from this source.
const RENDERED: &str = "src/prompt_blocks/rendered.txt";

fn team(yaml: &str) -> TeamConfig {
    serde_yaml::from_str(yaml).expect("team parses")
}

const AGENT: &str = "spawn: { cmd: claude-agent-acp, cwd: . }\n    model: sonnet";

fn edge(from: &str, to: &str) -> String {
    format!(
        "  - {{ from: {from}, to: {to}, layer: configured, kind: sequence, ts: \"2026-10-02T00:00:00Z\" }}\n"
    )
}

/// Researcher, then Fact-checker, then Writer.
fn pipeline() -> TeamConfig {
    team(&format!(
        "schemaVersion: 1\nname: News desk\nentrypoint: research\nagents:\n  \
         - id: research\n    name: Researcher\n    role: Find sources.\n    {AGENT}\n  \
         - id: check\n    name: Fact-checker\n    role: Verify the research.\n    {AGENT}\n  \
         - id: write\n    name: Writer\n    role: Write the piece.\n    doneWhen:\n      - Cites the 2025 report\n      - Under 200 words\n    {AGENT}\n\
         edges:\n{}{}",
        edge("research", "check"),
        edge("check", "write"),
    ))
}

/// Alpha feeds Beta and a review stop; both feed Gamma.
fn with_a_stop() -> TeamConfig {
    team(&format!(
        "schemaVersion: 1\nname: Research Team\nentrypoint: a\nagents:\n  \
         - id: a\n    name: Alpha\n    role: One.\n    {AGENT}\n  \
         - id: b\n    name: Beta\n    role: Two.\n    {AGENT}\n  \
         - id: stop\n    kind: operator\n    name: Review\n    role: Approve?\n  \
         - id: c\n    name: Gamma\n    role: Three.\n    {AGENT}\n\
         edges:\n{}{}{}{}",
        edge("a", "b"),
        edge("a", "stop"),
        edge("b", "c"),
        edge("stop", "c"),
    ))
}

/// A lead and three teammates, one of whom may search the web and two of whom may change files.
fn led() -> TeamConfig {
    let mut team = team(&format!(
        "schemaVersion: 1\nname: Desk\nentrypoint: lead\nagents:\n  \
         - id: lead\n    name: Lead\n    role: Run the desk.\n    {AGENT}\n  \
         - id: find\n    name: Finder\n    role: |\n      Look things up.\n      Second line.\n    {AGENT}\n  \
         - id: edit\n    name: Editor\n    role: Edit drafts.\n    {AGENT}\n  \
         - id: file\n    name: Filer\n    role: ''\n    {AGENT}\n"
    ));
    team.agents[1].allow.web = true;
    team.agents[2].allow.edits = true;
    team.agents[3].allow.edits = true;
    team
}

fn section(out: &mut String, title: &str, text: &str) {
    let _ = write!(out, "===== {title}\n{text}\n");
}

fn system_prompts(out: &mut String) {
    let none = Abilities {
        files: false,
        commands: false,
        web: None,
        plan: false,
        ask_user: false,
    };
    section(
        out,
        "system: no tools, extra",
        &system_prompt(
            Path::new("/w"),
            none,
            None,
            &[],
            "",
            None,
            Some("You are Ask LoomWatch."),
        ),
    );
    let all = Abilities {
        files: true,
        commands: true,
        web: Some(6_000),
        plan: true,
        ask_user: true,
    };
    let mai = AboutYou {
        name: Some("Mai".into()),
        about: Some(
            "I teach English at a primary school in Da Nang.\n\n# Answer in Vietnamese.".into(),
        ),
        skipped: false,
    };
    section(
        out,
        "system: every tool, the person, a lesson, skills and notes",
        &system_prompt(
            Path::new("/w"),
            all,
            Some(&mai),
            &["When writing the digest, use three bullets.".to_owned()],
            "## Skills\nresearch\n",
            Some("Cite every source."),
            None,
        ),
    );
    let some = Abilities {
        files: true,
        commands: false,
        web: Some(800),
        plan: false,
        ask_user: false,
    };
    let named = AboutYou {
        name: Some("Mai".into()),
        ..AboutYou::default()
    };
    section(
        out,
        "system: files and a short web read, a name alone",
        &system_prompt(Path::new("/w"), some, Some(&named), &[], "", None, None),
    );
    let commands = Abilities {
        files: false,
        commands: true,
        web: None,
        plan: false,
        ask_user: true,
    };
    let unnamed = AboutYou {
        about: Some("Keep it short.".into()),
        ..AboutYou::default()
    };
    section(
        out,
        "system: commands alone, an about alone",
        &system_prompt(
            Path::new("/w"),
            commands,
            Some(&unnamed),
            &[],
            "",
            None,
            None,
        ),
    );
}

fn tool_specs(out: &mut String) {
    for tool in Builtin::ALL {
        let spec = tool.spec();
        // Its words differ by system (`RUN_COMMAND`), and this file is the same on every one.
        let description = if tool == Builtin::RunCommand {
            assert_eq!(spec.description, crate::agent::tools::RUN_COMMAND);
            "(RUN_COMMAND for this system)".to_owned()
        } else {
            spec.description
        };
        section(
            out,
            &format!("tool: {}", spec.name),
            &format!(
                "{description}\n{}",
                serde_json::to_string_pretty(&spec.parameters).expect("parameters")
            ),
        );
    }
}

fn bus_tools(out: &mut String) {
    let lead = BusSeat {
        mode: TeamBusMode::Team,
        teammates: 2,
        has_stage_before: false,
        answering: false,
        asks_teammates: false,
        notebook: true,
        operator: true,
        conversation: true,
        helpers: 0,
        front_desk: false,
    };
    let stage = BusSeat {
        mode: TeamBusMode::Pipeline,
        teammates: 2,
        has_stage_before: true,
        notebook: false,
        operator: false,
        conversation: false,
        ..lead
    };
    let alone = BusSeat {
        teammates: 0,
        helpers: 3,
        front_desk: true,
        notebook: false,
        conversation: false,
        ..lead
    };
    for (title, seat) in [
        ("a team's lead", lead),
        ("a pipeline stage", stage),
        ("an agent alone", alone),
    ] {
        section(
            out,
            &format!("bus: {title}"),
            &serde_json::to_string_pretty(&offered_tools(&seat)).expect("tools"),
        );
    }
}

fn orientations(out: &mut String) {
    use crate::orientation::{for_helper, for_lead, for_one_agent, for_stage, reading};
    let order = ["research", "check", "write"].map(str::to_owned).to_vec();
    let plain = pipeline();
    for index in 0..3 {
        section(
            out,
            &format!("stage {index}"),
            &for_stage(&plain, &plain.agents[index], &order, index, "write").expect("a stage"),
        );
    }
    let mut checked = pipeline();
    checked.agents[1].checks = Some("research".to_owned());
    for index in 0..2 {
        section(
            out,
            &format!("stage {index}, the second checking the first"),
            &for_stage(&checked, &checked.agents[index], &order, index, "write").expect("a stage"),
        );
    }
    let stop = with_a_stop();
    let order = ["a", "b", "stop", "c"].map(str::to_owned).to_vec();
    for index in [0, 3] {
        section(
            out,
            &format!("stage {index} around a review stop"),
            &for_stage(&stop, &stop.agents[index], &order, index, "c").expect("a stage"),
        );
    }
    let led = led();
    section(
        out,
        "lead",
        &for_lead(&led, &led.agents[0]).expect("a lead"),
    );
    section(
        out,
        "one agent, written to",
        &for_one_agent(&plain, &plain.agents[2], false),
    );
    section(
        out,
        "one agent, about a part",
        &for_one_agent(&plain, &plain.agents[2], true),
    );
    section(
        out,
        "helper, brought in by a teammate",
        &for_helper(&plain, &plain.agents[2], Some("check")).expect("a helper"),
    );
    section(
        out,
        "helper, brought in by nobody known",
        &for_helper(&plain, &plain.agents[2], None).expect("a helper"),
    );
    for (in_team, checks) in [(false, false), (true, false), (false, true), (true, true)] {
        section(
            out,
            &format!("reading, in a team {in_team}, checks {checks}"),
            &reading(in_team, checks),
        );
    }
    section(out, "helpers: lead", &crate::helpers::for_lead(3));
    section(
        out,
        "helpers: copy, with the request",
        &crate::helpers::for_copy("Writer", Some("Plan a trip\nto Hanoi")),
    );
    section(
        out,
        "helpers: copy, without",
        &crate::helpers::for_copy("Writer", None),
    );
}

fn check_items(out: &mut String) {
    let team = pipeline();
    for id in ["write", "research"] {
        section(
            out,
            &format!("check items: {id}"),
            &crate::check_items(&team, id).join("\n"),
        );
    }
}

/// Every fixed text as agents are given it, through the functions that put their prompts and
/// tools together.
fn rendered() -> String {
    let mut out = String::new();
    system_prompts(&mut out);
    tool_specs(&mut out);
    bus_tools(&mut out);
    orientations(&mut out);
    check_items(&mut out);
    out
}

/// The first line where `got` and `want` differ, with its number, or `None` when they are the same.
fn first_difference(got: &str, want: &str) -> Option<String> {
    if got == want {
        return None;
    }
    let mut got_lines = got.lines();
    let mut want_lines = want.lines();
    for number in 1.. {
        match (got_lines.next(), want_lines.next()) {
            (Some(got), Some(want)) if got == want => {}
            (got, want) => {
                return Some(format!("line {number}:\n  now: {got:?}\n  was: {want:?}"));
            }
        }
    }
    unreachable!()
}

/// Without overrides, every prompt and tool is byte for byte what `rendered.txt` holds, which was
/// written from the code before the fixed texts became blocks. A change to a fixed text on purpose
/// rewrites it: `WRITE_RENDERED_PROMPTS=1 cargo test -p loomwatch-backend prompt_blocks::tests`.
#[test]
fn without_overrides_every_prompt_is_what_it_was() {
    let now = rendered();
    if std::env::var_os("WRITE_RENDERED_PROMPTS").is_some() {
        std::fs::write(Path::new(env!("CARGO_MANIFEST_DIR")).join(RENDERED), &now)
            .expect("rendered.txt");
    }
    // A Windows checkout may end its lines with CR LF.
    let was = include_str!("rendered.txt").replace('\r', "");
    if let Some(difference) = first_difference(&now, &was) {
        panic!("a prompt changed from {RENDERED}: {difference}");
    }
}

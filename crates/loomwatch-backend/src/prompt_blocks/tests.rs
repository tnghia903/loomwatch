use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::Path;

use super::{ALL, fill, placeholders};
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
        let description = if spec.description == crate::agent::tools::RUN_COMMAND.default {
            assert_eq!(tool, Builtin::RunCommand);
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
    if let Some(difference) = first_difference(&now, &was()) {
        panic!("a prompt changed from {RENDERED}: {difference}");
    }
}

/// `rendered.txt`. A Windows checkout may end its lines with CR LF.
fn was() -> String {
    include_str!("rendered.txt").replace('\r', "")
}

/// Every id names a file on any system and belongs to one block, and no block's words start or end
/// with a space or line break: the code that uses a block puts in the breaks around it, so a file
/// read back without the line break an editor leaves at its end is the same text.
#[test]
fn every_block_has_an_id_of_its_own_and_no_space_at_either_end() {
    let shape = regex::Regex::new(r"^[a-z]+(\.[a-z][a-z_]*)+$").expect("pattern");
    let mut seen = BTreeSet::new();
    for block in ALL {
        assert!(shape.is_match(block.id), "{}", block.id);
        assert!(seen.insert(block.id), "{} names two blocks", block.id);
        assert!(!block.default.is_empty(), "{}", block.id);
        assert_eq!(block.default.trim(), block.default, "{}", block.id);
    }
}

/// A block written anywhere in the daemon is in [`ALL`], so the dump writes it and a file for it is
/// accepted.
#[test]
fn every_block_in_the_source_is_listed() {
    let made = regex::Regex::new(r#"Block::new\(\s*"([^"]+)""#).expect("pattern");
    let mut found = BTreeSet::new();
    let mut folders = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).expect("source folder") {
            let path = entry.expect("source entry").path();
            if path.is_dir() {
                folders.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let source = std::fs::read_to_string(&path).expect("source file");
                found.extend(made.captures_iter(&source).map(|made| made[1].to_owned()));
            }
        }
    }
    let listed: BTreeSet<String> = ALL.iter().map(|block| block.id.to_owned()).collect();
    assert_eq!(found, listed);
}

#[test]
fn a_placeholder_is_filled_once_and_other_braces_stay_as_written() {
    // A value is never read again, even when it looks like a placeholder.
    assert_eq!(
        fill(
            "You are {name}, on {team}.",
            &[("name", "{team}"), ("team", "the Desk team")]
        ),
        "You are {team}, on the Desk team."
    );
    assert_eq!(
        fill(
            "{lead} asked {lead}. {other} {\"json\": 1} {",
            &[("lead", "Ada")]
        ),
        "Ada asked Ada. {other} {\"json\": 1} {"
    );
    assert_eq!(fill("{{name}}", &[("name", "Mai")]), "{Mai}");
    assert_eq!(
        placeholders("For {lead}: {lead}'s {at_once}, not {Lead}, {x-y}, {} or {\"a\": 1}"),
        ["at_once", "lead"]
    );
}

/// Overrides, which only a build with the `prompt-overrides` feature has.
#[cfg(feature = "prompt-overrides")]
mod overriding {
    use std::path::PathBuf;

    use super::*;
    use crate::prompt_blocks::Block;
    use crate::prompt_blocks::overrides::{Overrides, dump, scoped};

    struct Folder(PathBuf);

    impl Folder {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-blocks-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("folder");
            Self(path)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The parts of a block's own words between its placeholders, long enough to be its alone.
    fn own_words(block: &Block) -> Vec<&'static str> {
        regex::Regex::new(r"\{[a-z_]+\}")
            .expect("pattern")
            .split(block.default)
            .filter(|words| words.len() > 30)
            .collect()
    }

    /// Each block replaced by a mark with its id and every placeholder it fills reaches what agents
    /// are given, filled in, and none of its own words are left there: no prompt or tool keeps a
    /// copy of a block's text beside it.
    #[test]
    fn every_block_s_file_replaces_it_wherever_agents_are_given_it() {
        let marked = Overrides::of(ALL.iter().map(|block| {
            let filled: Vec<String> = placeholders(block.default)
                .iter()
                .map(|name| format!("{{{name}}}"))
                .collect();
            (block.id, format!("[[{}]] {}", block.id, filled.join(" ")))
        }));
        let now = scoped(marked, rendered);
        for block in ALL {
            assert!(
                now.contains(&format!("[[{}]]", block.id)),
                "{} is not where agents read it",
                block.id
            );
            for words in own_words(block) {
                assert!(
                    !now.contains(words),
                    "{} is still given as written: {words:?}",
                    block.id
                );
            }
        }
        // Filled in from the file, as from the block's own words.
        assert!(
            now.contains("[[orientation.lead]] Lead the Desk team\n"),
            "{now}"
        );
        assert!(now.contains("[[system.web]] 6,000\n"), "{now}");
    }

    /// What `--dump-prompt-blocks` writes, read back as overrides, gives every prompt and tool
    /// exactly as without them: an improver starts from the words agents have now.
    #[test]
    fn the_dump_read_back_changes_nothing() {
        let folder = Folder::new();
        let listed = dump(&folder.0).expect("dump");
        assert_eq!(listed.len(), ALL.len());
        assert!(listed.contains(&"orientation.lead  {name} {team}".to_owned()));
        assert!(listed.contains(&"orientation.delegation".to_owned()));
        let read = Overrides::read(&folder.0).expect("the dump reads back");
        for block in ALL {
            assert_eq!(read.get(block.id), Some(block.default), "{}", block.id);
        }
        let now = scoped(read, rendered);
        assert_eq!(first_difference(&now, &was()), None);
    }

    /// The dump writes the words agents are given now, so an override is in it.
    #[test]
    fn the_dump_writes_what_overrides_left() {
        let folder = Folder::new();
        let changed = Overrides::of([("orientation.delegation", "Hand out the work.".to_owned())]);
        scoped(changed, || dump(&folder.0)).expect("dump");
        let written = |id: &str| std::fs::read_to_string(folder.0.join(format!("{id}.md")));
        assert_eq!(
            written("orientation.delegation").expect("delegation"),
            "Hand out the work.\n"
        );
        assert_eq!(
            written("check.contradiction").expect("contradiction"),
            "No claim contradicts its source or the request\n"
        );
    }

    /// A file for a block, with its editor's last line break; hidden files such as `.DS_Store` are
    /// passed over; anything else stops the start, named, so a misspelt id never runs quietly as the
    /// default.
    #[test]
    fn a_folder_holding_anything_but_known_blocks_is_refused() {
        let folder = Folder::new();
        std::fs::write(folder.0.join("system.intro.md"), "Hello, {the_person}.\n\n").expect("file");
        std::fs::write(folder.0.join(".DS_Store"), "").expect("hidden");
        let read = Overrides::read(&folder.0).expect("a known block");
        assert_eq!(read.get("system.intro"), Some("Hello, {the_person}."));
        assert_eq!(read.get("system.plan"), None);
        for (name, a_folder) in [
            ("sytem.intro.md", false),
            ("system.intro.txt", false),
            ("system.intro", false),
            ("drafts", true),
            ("system.plan.md", true),
        ] {
            let other = Folder::new();
            std::fs::write(other.0.join("system.intro.md"), "Hello.").expect("file");
            if a_folder {
                std::fs::create_dir(other.0.join(name)).expect("inner folder");
            } else {
                std::fs::write(other.0.join(name), "Hello.").expect("file");
            }
            let refused = format!("{:#}", Overrides::read(&other.0).expect_err(name));
            assert!(
                refused.contains(&format!("holds {name}, which is not a prompt block")),
                "{refused}"
            );
        }
        let missing = format!(
            "{:#}",
            Overrides::read(&folder.0.join("missing")).expect_err("no folder")
        );
        assert!(
            missing.contains("could not read the prompt overrides"),
            "{missing}"
        );
    }

    /// A `{placeholder}` its block doesn't fill would reach the agent as written, so it is refused.
    /// Leaving one out, and braces around anything else, are the improver's to choose.
    #[test]
    fn a_file_may_use_only_the_placeholders_its_block_fills() {
        let folder = Folder::new();
        let file = folder.0.join("orientation.lead.md");
        std::fs::write(&file, "You are {name}, for {person}.").expect("file");
        let refused = format!("{:#}", Overrides::read(&folder.0).expect_err("{person}"));
        assert!(
            refused.contains("orientation.lead.md uses {person}, which orientation.lead does not fill: it fills {name} {team}"),
            "{refused}"
        );
        std::fs::write(&file, "Lead {team}, replying as {\"answer\": \"…\"}.").expect("file");
        assert!(Overrides::read(&folder.0).is_ok());
        std::fs::remove_file(&file).expect("removed");
        std::fs::write(folder.0.join("system.plan.md"), "- Plan for {the_person}.").expect("file");
        let refused = format!("{:#}", Overrides::read(&folder.0).expect_err("none"));
        assert!(refused.ends_with("it fills none"), "{refused}");
    }
}

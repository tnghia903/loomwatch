//! The instructions every built-in agent starts with, under whatever role and task the team
//! gives it.
//!
//! They hold the habits that make an agent's work worth reviewing, the ones the best agent
//! harnesses (Claude Code, Codex, `LangChain`'s Deep Agents) build in: plan before a long task,
//! look before changing, say where facts come from, ask instead of guessing when a guess would
//! waste the work, and check the result against what was asked before replying. The team's own
//! words — role, task, "Done when" — come in the first user message, so this stays the same for
//! every turn of a session, and the provider's prompt cache keeps it. What the person told their
//! agents about themselves (ADR 0074) is here too: it is the same for every agent and every task.

use std::fmt::Write as _;
use std::path::Path;

use crate::you::AboutYou;

/// The project notes file an agent reads from its work folder: the team's Brief when it is
/// delivered as a file (`docs/TEAM_MEMORY.md`, channel 2), or what the person keeps there. The
/// name the Agent Skills apps share.
pub(crate) const PROJECT_NOTES: &str = "AGENTS.md";
/// More than any Brief `LoomWatch` writes; a longer file is cut, and the agent is told so.
const MAX_NOTES_CHARS: usize = 40_000;

/// The work folder's `AGENTS.md`, cut to [`MAX_NOTES_CHARS`], or `None` when there is none.
///
/// The Brief `LoomWatch` writes there itself is left out: the opening message already carries it,
/// under "What the team knows", so the agent would read it twice on every call.
/// [`loomwatch_brief`] reads it back for a summary that drops the opening message.
pub(crate) fn project_notes(cwd: &Path) -> Option<String> {
    let text = std::fs::read_to_string(cwd.join(PROJECT_NOTES)).ok()?;
    let text = text.trim();
    if text.is_empty() || text.starts_with(crate::memory::NATIVE_FILE_MARKER) {
        return None;
    }
    if text.chars().count() <= MAX_NOTES_CHARS {
        return Some(text.to_owned());
    }
    let mut cut: String = text.chars().take(MAX_NOTES_CHARS).collect();
    let _ = write!(
        cut,
        "\n\n[{PROJECT_NOTES} goes on; read the file for the rest.]"
    );
    Some(cut)
}

/// The Brief `LoomWatch` wrote as the work folder's `AGENTS.md`, without the line saying who wrote
/// it, or `None` when the file is the person's own or there is none.
pub(crate) fn loomwatch_brief(cwd: &Path) -> Option<String> {
    let text = std::fs::read_to_string(cwd.join(PROJECT_NOTES)).ok()?;
    let text = text.trim();
    if !text.starts_with(crate::memory::NATIVE_FILE_MARKER) {
        return None;
    }
    let brief = text.split_once("-->").map_or(text, |(_, rest)| rest).trim();
    (!brief.is_empty()).then(|| brief.to_owned())
}

/// What the agent can do in this session, so the instructions mention only tools it has.
#[derive(Debug, Clone, Copy)]
#[allow(clippy::struct_excessive_bools)]
pub(crate) struct Abilities {
    pub files: bool,
    pub commands: bool,
    /// Reading the web, with how many words of a page it reads.
    pub web: Option<u32>,
    pub plan: bool,
    /// The Team Bus's `ask_user` is among its tools.
    pub ask_user: bool,
}

/// The built-in instructions, then what the person told their agents about themselves (ADR 0074),
/// what this agent has learned from their feedback (ADR 0078), `skills` (the rendered `## Skills`
/// section, or nothing), the person's own project notes and `extra`. With nothing told and nothing
/// learned, the instructions are exactly what they were before ADR 0074.
pub(crate) fn system_prompt(
    cwd: &Path,
    abilities: Abilities,
    person: Option<&AboutYou>,
    lessons: &[String],
    skills: &str,
    notes: Option<&str>,
    extra: Option<&str>,
) -> String {
    let name = person.and_then(|person| person.name.as_deref());
    let mut prompt = String::from("You are an agent in LoomWatch, working on a task for ");
    if let Some(name) = name {
        let _ = write!(prompt, "{name}, ");
    }
    prompt.push_str(
        "the person who runs this team. The task, your role and what counts as done come in the \
         person's message.\n\n\
         ## How you work\n",
    );
    if abilities.plan {
        prompt.push_str(
            "- For work with several steps, start by writing a short plan with update_plan, and \
             keep it current as you go: mark a step in_progress when you start it and completed \
             when it is done. Send update_plan in the same message as the step's other tool \
             calls, not in a message of its own.\n",
        );
    }
    if abilities.files || abilities.commands || abilities.web.is_some() || abilities.plan {
        // Every message re-reads the whole conversation, so one message asking for five things
        // costs far less than five messages asking for one each.
        prompt.push_str(
            "- When you need several things that don't depend on each other, such as files to \
             read or searches to run, ask for all of them in one message instead of one at a \
             time.\n",
        );
    }
    if abilities.files {
        let _ = write!(
            prompt,
            "- Your work folder is {}. Paths are relative to it. Stay inside it unless the task \
             names another place.\n\
             - Look before you change anything: read a file before you edit it, and keep edits to \
             what the task needs.\n",
            cwd.display()
        );
    }
    if abilities.commands {
        prompt.push_str(
            "- run_command is for scripts and tools the task needs, such as the ones a skill \
             provides. The person may be asked first, so don't run commands you don't need.\n",
        );
    }
    if let Some(words) = abilities.web {
        let words = if words >= 1_000 {
            format!("{},{:03}", words / 1_000, words % 1_000)
        } else {
            words.to_string()
        };
        // A page read stays in the conversation and is paid for again on every later call, so
        // reading it twice pays for it twice from then on.
        let _ = writeln!(
            prompt,
            "- You can search the web and read web pages. Prefer primary sources, and check that a \
             source says what you cite it for. A page is read up to about {words} words. What you \
             read stays in this conversation, so check a claim against it there rather than \
             opening the page again."
        );
    }
    prompt.push_str(
        "- Say where facts come from: name the file, or the web page's address, for anything you \
         didn't work out yourself.\n",
    );
    if abilities.ask_user {
        prompt.push_str(
            "- When something is unclear and a wrong guess would waste the work, ask the person \
             with ask_user. Otherwise make a sensible choice and say what you chose.\n",
        );
    } else {
        prompt.push_str(
            "- When something is unclear, make a sensible choice and say what you chose, or say \
             exactly what you need.\n",
        );
    }
    prompt.push_str(
        "- If a tool says you were declined or answers you in the person's words, take that as \
         their decision and carry on without it.\n\
         - A long tool output may be set aside: you see its start and an id, and read_tool_output \
         gives you the rest.\n\
         - Before you finish, check your result against what the task asks for, and against \
         \"Done when\" if it was given. Fix what falls short.\n\
         - Then reply with the result itself, plainly. Don't describe the steps you took unless \
         the person asked.\n",
    );
    if let Some(about) = person.and_then(|person| person.about.as_deref()) {
        person_section(&mut prompt, name, about);
    }
    prompt.push_str(&crate::lessons::section(lessons, name));
    if !skills.is_empty() {
        prompt.push('\n');
        prompt.push_str(skills);
    }
    if let Some(notes) = notes {
        let _ = write!(
            prompt,
            "\n## Project notes\nFrom {PROJECT_NOTES} in your work folder:\n\n{notes}\n"
        );
    }
    if let Some(extra) = extra.map(str::trim).filter(|extra| !extra.is_empty()) {
        prompt.push('\n');
        prompt.push_str(extra);
        prompt.push('\n');
    }
    prompt
}

/// `## The person you work for`: what they wrote about themselves, quoted line by line so no line
/// of theirs can open a section of its own, and how to use it.
///
/// What they say about answers ("in Vietnamese", "keep it short") is direction, and who they are
/// is context. The task still wins where the two differ: a request for one piece of work is more
/// particular than a standing preference.
fn person_section(prompt: &mut String, name: Option<&str>, about: &str) {
    prompt.push_str(
        "\n## The person you work for\nThey wrote this for the agents they work with in \
         LoomWatch.\n\n",
    );
    if let Some(name) = name {
        let _ = writeln!(prompt, "Name: {name}");
    }
    prompt.push_str("About them, in their words:\n");
    for line in about.lines() {
        if line.is_empty() {
            prompt.push_str(">\n");
        } else {
            let _ = writeln!(prompt, "> {line}");
        }
    }
    prompt.push_str(
        "\nUse this so your work fits them: follow what they say about how they want answers \
         (language, length, tone, format), and pitch the content to who they are and what they \
         know. Where the task or their message asks for something else, that wins. Don't repeat \
         this back or mention it unless it matters to the task.\n",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_instructions_mention_only_what_the_agent_can_do() {
        let none = Abilities {
            files: false,
            commands: false,
            web: None,
            plan: false,
            ask_user: false,
        };
        let talking = system_prompt(
            Path::new("/w"),
            none,
            None,
            &[],
            "",
            None,
            Some("You are Ask LoomWatch."),
        );
        assert!(!talking.contains("update_plan") && !talking.contains("run_command"));
        assert!(talking.trim_end().ends_with("You are Ask LoomWatch."));
        let all = Abilities {
            files: true,
            commands: true,
            web: Some(6_000),
            plan: true,
            ask_user: true,
        };
        let working = system_prompt(
            Path::new("/w"),
            all,
            None,
            &[],
            "",
            Some("Cite every source."),
            None,
        );
        assert!(working.contains("update_plan") && working.contains("Your work folder is /w"));
        assert!(working.contains("in the same message as the step's other tool calls"));
        assert!(working.contains("ask for all of them in one message"));
        assert!(!talking.contains("in one message"));
        assert!(working.contains("ask_user"));
        assert!(working.contains("From AGENTS.md in your work folder:\n\nCite every source.\n"));
        // The page cut is said, and why a page isn't opened twice.
        assert!(working.contains("A page is read up to about 6,000 words."));
        assert!(working.contains("rather than opening the page again"));
        assert!(!talking.contains("web pages"));
    }

    fn working() -> Abilities {
        Abilities {
            files: true,
            commands: false,
            web: None,
            plan: true,
            ask_user: true,
        }
    }

    /// With nothing told, every agent's instructions are byte for byte what they were before ADR
    /// 0074, so a person who skips it changes nothing, cached or not.
    #[test]
    fn with_nothing_told_the_instructions_are_unchanged() {
        let before = system_prompt(
            Path::new("/w"),
            working(),
            None,
            &[],
            "## Skills\n",
            None,
            None,
        );
        assert!(before.starts_with(
            "You are an agent in LoomWatch, working on a task for the person who runs this team. \
             The task, your role and what counts as done come in the person's message.\n\n\
             ## How you work\n"
        ));
        let skipped = AboutYou {
            skipped: true,
            ..AboutYou::default()
        };
        assert_eq!(
            system_prompt(
                Path::new("/w"),
                working(),
                Some(&skipped),
                &[],
                "## Skills\n",
                None,
                None
            ),
            before
        );
        assert!(!before.contains("The person you work for"));
    }

    #[test]
    fn every_agent_is_told_who_it_works_for_and_how_to_use_it() {
        let mai = AboutYou {
            name: Some("Mai".into()),
            about: Some(
                "I teach English at a primary school in Da Nang.\n\n# Answer in Vietnamese.".into(),
            ),
            skipped: false,
        };
        let prompt = system_prompt(
            Path::new("/w"),
            working(),
            Some(&mai),
            &[],
            "## Skills\nresearch\n",
            Some("Cite every source."),
            None,
        );
        assert!(prompt.starts_with(
            "You are an agent in LoomWatch, working on a task for Mai, the person who runs this \
             team."
        ));
        let section = "\n## The person you work for\nThey wrote this for the agents they work \
                       with in LoomWatch.\n\nName: Mai\nAbout them, in their words:\n\
                       > I teach English at a primary school in Da Nang.\n>\n\
                       > # Answer in Vietnamese.\n\nUse this so your work fits them:";
        assert!(prompt.contains(section), "{prompt}");
        assert!(
            prompt.contains("Where the task or their message asks for something else, that wins.")
        );
        // Their line starting with `#` stays inside the quote: it is no heading of its own.
        assert!(!prompt.contains("\n# Answer in Vietnamese."));
        // After how the agent works, before its skills and the project's notes.
        let at = |text: &str| prompt.find(text).expect(text);
        assert!(at("## How you work") < at("## The person you work for"));
        assert!(at("## The person you work for") < at("## Skills"));
        assert!(at("## Skills") < at("## Project notes"));
    }

    /// ADR 0078: what the agent learned from the person's feedback, after who they are and before
    /// the skills, in their name; and nothing at all when it has learned nothing.
    #[test]
    fn what_the_agent_learned_comes_after_the_person_and_before_its_skills() {
        let mai = AboutYou {
            name: Some("Mai".into()),
            about: Some("I teach.".into()),
            skipped: false,
        };
        let prompt = system_prompt(
            Path::new("/w"),
            working(),
            Some(&mai),
            &["When writing the digest, use three bullets.".to_owned()],
            "## Skills\nresearch\n",
            None,
            None,
        );
        let at = |text: &str| prompt.find(text).expect(text);
        assert!(at("## The person you work for") < at("## What you have learned"));
        assert!(at("## What you have learned") < at("## Skills"));
        assert!(prompt.contains("From Mai's feedback on your earlier work."));
        assert!(prompt.contains("\n- When writing the digest, use three bullets.\n"));
        let unlearned = system_prompt(Path::new("/w"), working(), Some(&mai), &[], "", None, None);
        assert!(!unlearned.contains("What you have learned"));
    }

    #[test]
    fn a_name_alone_is_said_once_and_an_about_alone_needs_no_name() {
        let named = AboutYou {
            name: Some("Mai".into()),
            ..AboutYou::default()
        };
        let prompt = system_prompt(
            Path::new("/w"),
            working(),
            Some(&named),
            &[],
            "",
            None,
            None,
        );
        assert!(prompt.contains("working on a task for Mai, the person who runs this team."));
        assert!(!prompt.contains("The person you work for"));
        let unnamed = AboutYou {
            about: Some("Keep it short.".into()),
            ..AboutYou::default()
        };
        let prompt = system_prompt(
            Path::new("/w"),
            working(),
            Some(&unnamed),
            &[],
            "",
            None,
            None,
        );
        assert!(prompt.contains("working on a task for the person who runs this team."));
        assert!(prompt.contains("About them, in their words:\n> Keep it short.\n"));
        assert!(!prompt.contains("Name:"));
    }

    /// The Brief `LoomWatch` writes as `AGENTS.md` is in the opening message already, so the
    /// instructions don't carry it too; the person's own `AGENTS.md` still is read.
    #[test]
    fn loomwatchs_own_brief_file_is_not_read_twice() {
        let folder = std::env::temp_dir().join(format!("loomwatch-brief-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).expect("folder");
        let body = format!(
            "{}team t, agent a. Rebuilt on every run; edit the Brief files beside the team file \
             instead. -->\n\n# What the team knows\n\nWrite in French.\n",
            crate::memory::NATIVE_FILE_MARKER
        );
        std::fs::write(folder.join(PROJECT_NOTES), &body).expect("brief");
        assert_eq!(project_notes(&folder), None);
        let brief = loomwatch_brief(&folder).expect("the brief, for a summary");
        assert!(brief.starts_with("# What the team knows") && brief.ends_with("Write in French."));
        std::fs::write(folder.join(PROJECT_NOTES), "Use British spelling.").expect("own notes");
        assert_eq!(
            project_notes(&folder).as_deref(),
            Some("Use British spelling.")
        );
        assert_eq!(loomwatch_brief(&folder), None);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn the_project_notes_are_read_from_the_work_folder_and_cut_when_long() {
        let folder = std::env::temp_dir().join(format!("loomwatch-notes-{}", std::process::id()));
        std::fs::create_dir_all(&folder).expect("folder");
        assert_eq!(project_notes(&folder), None);
        std::fs::write(folder.join(PROJECT_NOTES), "  \n").expect("blank");
        assert_eq!(project_notes(&folder), None, "a blank file says nothing");
        std::fs::write(folder.join(PROJECT_NOTES), "# Brief\nWrite in French.\n").expect("notes");
        assert_eq!(
            project_notes(&folder).as_deref(),
            Some("# Brief\nWrite in French.")
        );
        std::fs::write(folder.join(PROJECT_NOTES), "x".repeat(MAX_NOTES_CHARS + 10)).expect("long");
        let long = project_notes(&folder).expect("long notes");
        assert!(long.ends_with("[AGENTS.md goes on; read the file for the rest.]"));
        let _ = std::fs::remove_dir_all(&folder);
    }
}

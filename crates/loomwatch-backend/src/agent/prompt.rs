//! The instructions every built-in agent starts with, under whatever role and task the team
//! gives it.
//!
//! They hold the habits that make an agent's work worth reviewing, the ones the best agent
//! harnesses (Claude Code, Codex, `LangChain`'s Deep Agents) build in: plan before a long task,
//! look before changing, say where facts come from, ask instead of guessing when a guess would
//! waste the work, and check the result against what was asked before replying. The team's own
//! words — role, task, "Done when" — come in the first user message, so this stays the same for
//! every turn and every agent, and the provider's prompt cache keeps it.

use std::fmt::Write as _;
use std::path::Path;

use super::skills::{SkillEntry, prompt_section};

/// What the agent can do in this session, so the instructions mention only tools it has.
#[derive(Debug, Clone, Copy)]
#[allow(clippy::struct_excessive_bools)]
pub(crate) struct Abilities {
    pub files: bool,
    pub commands: bool,
    pub web: bool,
    pub plan: bool,
    /// The Team Bus's `ask_user` is among its tools.
    pub ask_user: bool,
}

pub(crate) fn system_prompt(
    cwd: &Path,
    abilities: Abilities,
    skills: &[SkillEntry],
    extra: Option<&str>,
) -> String {
    let mut prompt = String::from(
        "You are an agent in LoomWatch, working on a task for the person who runs this team. The \
         task, your role and what counts as done come in the person's message.\n\n\
         ## How you work\n",
    );
    if abilities.plan {
        prompt.push_str(
            "- For work with several steps, start by writing a short plan with update_plan, and \
             keep it current as you go: mark a step in_progress when you start it and completed \
             when it is done.\n",
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
    if abilities.web {
        prompt.push_str(
            "- You can search the web and read web pages. Prefer primary sources, and check that \
             a source says what you cite it for.\n",
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
    let skills = prompt_section(skills);
    if !skills.is_empty() {
        prompt.push('\n');
        prompt.push_str(&skills);
    }
    if let Some(extra) = extra.map(str::trim).filter(|extra| !extra.is_empty()) {
        prompt.push('\n');
        prompt.push_str(extra);
        prompt.push('\n');
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_instructions_mention_only_what_the_agent_can_do() {
        let none = Abilities {
            files: false,
            commands: false,
            web: false,
            plan: false,
            ask_user: false,
        };
        let talking = system_prompt(Path::new("/w"), none, &[], Some("You are Ask LoomWatch."));
        assert!(!talking.contains("update_plan") && !talking.contains("run_command"));
        assert!(talking.trim_end().ends_with("You are Ask LoomWatch."));
        let all = Abilities {
            files: true,
            commands: true,
            web: true,
            plan: true,
            ask_user: true,
        };
        let working = system_prompt(Path::new("/w"), all, &[], None);
        assert!(working.contains("update_plan") && working.contains("Your work folder is /w"));
        assert!(working.contains("ask_user"));
    }
}

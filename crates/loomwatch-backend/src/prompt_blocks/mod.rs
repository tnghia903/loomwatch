//! The fixed texts every built-in agent is given, each under a stable id.
//!
//! The team file holds an agent's role, its "Done when" and its skills. Everything else an agent
//! reads is written here in Rust: the habits in its opening instructions, where it sits in its
//! team, how a check step reports, the helpers it may bring in, the tools' descriptions and the
//! items every check step checks. Each of those texts is a [`Block`]: an id, and the words, with a
//! `{placeholder}` wherever the code fills something in (a name, the work folder). The code that
//! uses a block keeps the headings, the line breaks between blocks and the conditions that decide
//! which blocks an agent gets.
//!
//! A developer build with the `prompt-overrides` feature can swap any block for a file, so the
//! quality bench can try a new wording and keep it only when judged runs say it helps
//! (`overrides`). No release, package or CI build turns the feature on, except one CI job that
//! tests it; without it, [`Block::text`] is the text written here and nothing else is read.

#[cfg(feature = "prompt-overrides")]
mod overrides;
#[cfg(test)]
mod tests;

#[cfg(feature = "prompt-overrides")]
pub use overrides::{dump, install};

/// One fixed text agents are given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Block {
    /// What the block is called: the name of its file in a folder of overrides. Never renamed, so
    /// an edit the bench kept still finds its block.
    id: &'static str,
    /// The words, with no space or line break at either end: the code that uses a block puts in
    /// the breaks around it.
    default: &'static str,
}

impl Block {
    pub(crate) const fn new(id: &'static str, default: &'static str) -> Self {
        Self { id, default }
    }

    /// The words as written here, whatever replaced them: what tests expect.
    #[cfg(test)]
    pub(crate) const fn default_text(self) -> &'static str {
        self.default
    }

    /// The words agents are given: these, or with the `prompt-overrides` feature, the file that
    /// replaced them at start-up.
    pub(crate) fn text(self) -> &'static str {
        #[cfg(feature = "prompt-overrides")]
        if let Some(text) = overrides::text(self.id) {
            return text;
        }
        self.default
    }

    /// [`Block::text`] with each `{name}` in `values` replaced by its value.
    pub(crate) fn fill(self, values: &[(&str, &str)]) -> String {
        debug_assert_eq!(
            placeholders(self.default),
            {
                let mut names: Vec<&str> = values.iter().map(|(name, _)| *name).collect();
                names.sort_unstable();
                names
            },
            "{} is filled with what its placeholders name",
            self.id
        );
        fill(self.text(), values)
    }
}

/// `text` with each `{name}` in `values` replaced by its value, in one pass: a value that holds
/// braces, such as an agent named `{team}`, is never read as a placeholder. Braces around anything
/// else stay as they are.
fn fill(text: &str, values: &[(&str, &str)]) -> String {
    let mut filled = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        filled.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let value = after.split_once('}').and_then(|(name, tail)| {
            values
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value, tail))
        });
        if let Some((value, tail)) = value {
            filled.push_str(value);
            rest = tail;
        } else {
            filled.push('{');
            rest = after;
        }
    }
    filled.push_str(rest);
    filled
}

/// The `{names}` in `text`, sorted, each once: lowercase words joined by underscores.
fn placeholders(text: &str) -> Vec<&str> {
    let mut names: Vec<&str> = text
        .split('{')
        .skip(1)
        .filter_map(|after| after.split_once('}').map(|(name, _)| name))
        .filter(|name| {
            name.starts_with(|first: char| first.is_ascii_lowercase())
                && name
                    .chars()
                    .all(|letter| letter.is_ascii_lowercase() || letter == '_')
        })
        .collect();
    names.sort_unstable();
    names.dedup();
    names
}

/// Every block, in the order agents meet them: the opening instructions, the agent's place, its
/// tools, then what a check step checks.
#[cfg(any(test, feature = "prompt-overrides"))]
const ALL: &[Block] = {
    use crate::agent::{prompt, tools};
    use crate::{helpers, orientation, team_bus};
    &[
        prompt::INTRO,
        prompt::PLAN,
        prompt::BATCH,
        prompt::FILES,
        prompt::COMMANDS,
        prompt::WEB,
        prompt::SOURCES,
        prompt::ASK_USER,
        prompt::UNCLEAR,
        prompt::FINISH,
        prompt::PERSON,
        prompt::PERSON_USE,
        orientation::LEAD,
        orientation::FINAL_ANSWER,
        orientation::LEAD_TEAMMATES,
        orientation::TEAMMATES_CAN,
        orientation::DELEGATION,
        orientation::STAGE,
        orientation::STAGE_FIRST,
        orientation::STAGE_BEFORE,
        orientation::STAGE_AFTER_CHECK,
        orientation::STAGE_AFTER_CHECKER,
        orientation::STAGE_AFTER_REVIEW,
        orientation::STAGE_AFTER,
        orientation::CHECK,
        orientation::CHECK_BLOCK,
        orientation::READING,
        orientation::READING_TEAM,
        orientation::READING_CHECKS,
        orientation::ONE_AGENT,
        orientation::ONE_AGENT_ABOUT_A_PART,
        orientation::ONE_AGENT_CHANGES,
        orientation::HELPER,
        helpers::LEAD,
        helpers::COPY,
        helpers::COPY_REQUEST,
        tools::LIST_FILES,
        tools::READ_FILE,
        tools::SEARCH_FILES,
        tools::WRITE_FILE,
        tools::EDIT_FILE,
        tools::RUN_COMMAND,
        tools::UPDATE_PLAN,
        tools::READ_TOOL_OUTPUT,
        helpers::START_HELPER,
        helpers::START_HELPER_TITLE,
        helpers::START_HELPER_TASK,
        helpers::START_HELPER_SEND_BACK,
        team_bus::ROSTER,
        team_bus::DISPATCH,
        team_bus::DISPATCH_TASK,
        team_bus::ASK,
        team_bus::ASK_IN_TEAM,
        team_bus::ASK_QUESTION,
        team_bus::HANDOFF,
        team_bus::HANDOFF_TASK,
        team_bus::ASK_USER,
        team_bus::MY_TEAMS,
        team_bus::ASK_TEAM,
        team_bus::ASK_TEAM_REQUEST,
        team_bus::MEMORY_SEARCH,
        team_bus::MEMORY_READ,
        team_bus::MEMORY_WRITE,
        team_bus::CHECKPOINT,
        team_bus::EARLIER_WORK,
        crate::CHECK_REQUEST,
        crate::CONTRADICTION_ITEM,
    ]
};

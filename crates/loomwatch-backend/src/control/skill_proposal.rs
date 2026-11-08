//! A skill, as Ask reads and proposes it (ADR 0121).
//!
//! When the person asks for a skill, or says how a kind of work should always be done by any of
//! their agents, Ask proposes the skill: a new one written whole, or a change to one of theirs as
//! edits to its numbered lines ([`super::line_edits`]), so every line Ask doesn't name stays as it
//! was. As with a team (ADR 0033) and an agent (ADR 0119), nothing here saves: the proposal opens
//! on the Skills page's own sheet (ADR 0118), and the person saves it there, against the
//! `SKILL.md` it was made from.
//!
//! Only skills in `LoomWatch`'s own folder can be changed: a project's skills travel with its
//! files, and the sheet changes neither.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::line_edits;
use super::mcp::{installed_skills, object, read_only, string, text};
use super::{Caller, Control, now};
use crate::skills_store::SkillsStore;
use crate::skills_store::written::{DESCRIPTION_CHARS, SkillWords, skill_name};

/// The longest instructions a proposal holds: a long guide, not a book. The skill writer asks
/// about no longer (`skill::MAX_INSTRUCTIONS_CHARS`).
const INSTRUCTIONS_CHARS: usize = 60_000;
/// A title is a few words; this is far past any.
const TITLE_CHARS: usize = 80;

/// One skill Ask proposed, new or changed. Never written here: the sheet saves it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillProposal {
    pub(super) id: String,
    /// The conversation it was proposed in.
    pub(super) source: String,
    /// `skill`, so the app tells it from a team's proposal, which has no kind.
    kind: &'static str,
    /// The folder name it is saved under: the one it has, or the one its title makes.
    pub(super) skill: String,
    /// A new skill's name in words. A change keeps its folder's name.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    is_new: bool,
    /// When to use it, whole, as it would be saved.
    description: String,
    /// What to do, whole, as it would be saved.
    instructions: String,
    /// The `SKILL.md` a change was made from: a save after the skill changed is refused.
    #[serde(skip_serializing_if = "Option::is_none")]
    base: Option<String>,
    summary: String,
    /// The agents in My agents given it as a skill, by name.
    given_to: Vec<String>,
    created_at: String,
}

/// A new skill, as Ask gives it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewSkill {
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    instructions: String,
}

/// A change to one, as Ask gives it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangedSkill {
    skill: String,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    edits: Vec<Value>,
    #[serde(default)]
    description: Option<String>,
    /// Refused: a change names the lines it changes.
    #[serde(default)]
    instructions: Option<Value>,
}

pub(super) fn definitions() -> [Value; 2] {
    [
        json!({
            "name": "read_skill",
            "title": "Read a skill",
            "description": "One of the person's skills in full: when to use it, its instructions one numbered line per line, the `base` a change names, its other files, and the agents in My agents given it. Read it before you propose a change to it.",
            "inputSchema": object(json!({"skill": string("Its name, from `list_skills`.")}), &["skill"]),
            "annotations": read_only(),
        }),
        json!({
            "name": "propose_skill",
            "title": "Propose a skill",
            "description": "Show the person one skill, new or changed, as a card. It is checked first. Nothing is saved until they open it and press Save skill.",
            "inputSchema": object(json!({
                "summary": string("One plain sentence saying what the proposal does, shown on the card."),
                "new": object(json!({
                    "title": string("What the skill is called, two to five words, such as Weekly client update."),
                    "description": string(&format!("When to use it: one or two sentences in the third person saying what the skill does and when to use it, with the words a request for this work would use. Agents see only this before they open a skill. At most {DESCRIPTION_CHARS} characters.")),
                    "instructions": string("What to do, in Markdown, for an agent that is able but knows nothing about this person or their work."),
                }), &["title", "description", "instructions"]),
                "change": object(json!({
                    "skill": string("Its name, from `list_skills`."),
                    "base": string("Its `base`, from `read_skill`."),
                    "edits": {"type": "array", "description": "Edits to its instructions, by the line numbers `read_skill` showed. Every line you don't name stays exactly as it is. Each is {n, replace} for a line's whole new text, {n, drop: true}, or {after, add} for new lines after line `after` (0 for the start).", "items": {"type": "object"}},
                    "description": string("Its whole new description, only when the change also changes what it does or when to use it."),
                }), &["skill", "base"]),
            }), &["summary"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        }),
    ]
}

/// `LoomWatch`'s skills folder, as the Skills page's store reads it.
fn store(control: &Control) -> Result<SkillsStore, String> {
    let folder = control.inner.skills_folder.as_deref().ok_or(
        "LoomWatch's skills folder isn't set up, so its skills can't be read or changed here.",
    )?;
    store_of(folder)
}

fn store_of(folder: &Path) -> Result<SkillsStore, String> {
    let state = folder
        .parent()
        .filter(|_| folder.file_name().is_some_and(|name| name == "skills"))
        .ok_or("LoomWatch's skills folder isn't where it keeps skills it can change.")?;
    Ok(SkillsStore::new(PathBuf::from(state)))
}

/// The folder in `LoomWatch`'s skills that `name` is, as `list_skills` names it: the folder's own
/// name, or the `name:` its `SKILL.md` gives, whatever their case.
fn folder_of(store: &SkillsStore, name: &str) -> Option<String> {
    let folders = store.names().ok()?;
    if folders.contains(name) {
        return Some(name.to_owned());
    }
    if let Some(same) = folders
        .iter()
        .find(|folder| folder.eq_ignore_ascii_case(name))
    {
        return Some(same.clone());
    }
    folders.into_iter().find(|folder| {
        std::fs::read_to_string(store.folder().join(folder).join("SKILL.md"))
            .ok()
            .and_then(|text| {
                let (frontmatter, _) = crate::skill_routing::split_frontmatter(&text);
                crate::skill_routing::frontmatter_field(frontmatter, "name")
            })
            .is_some_and(|given| given.trim().eq_ignore_ascii_case(name.trim()))
    })
}

/// The skill's words, or what to tell the assistant: one of `LoomWatch`'s skills can be changed,
/// a project's can't.
async fn words(control: &Control, name: &str) -> Result<SkillWords, String> {
    let store = store(control)?;
    let asked = name.to_owned();
    let read = tokio::task::spawn_blocking(move || {
        folder_of(&store, &asked).map(|folder| {
            store
                .words(&folder)
                .map_err(|error| error.message().to_owned())
        })
    })
    .await
    .map_err(|error| format!("Couldn't read the skill: {error}"))?;
    if let Some(words) = read {
        return words;
    }
    let listed = installed_skills(control).await?;
    Err(
        if listed
            .iter()
            .any(|skill| skill.name.eq_ignore_ascii_case(name))
        {
            format!(
                "{name} is kept with the project's own files, not in LoomWatch's skills, so it \
                 can't be changed here. Propose a new skill instead if they want one that works \
                 their way."
            )
        } else {
            format!("There is no skill called {name}. Use a name from `list_skills`.")
        },
    )
}

/// The agents in My agents given the skill in `folder`, by name. An agent names a skill as
/// `list_skills` does, which may be its title: "Weekly update" is the skill `weekly-update`.
fn given_to(teams_root: &Path, folder: &str) -> Vec<String> {
    let Ok(list) = crate::jobs::list_jobs(teams_root) else {
        return Vec::new();
    };
    list.jobs
        .iter()
        .filter(|job| {
            job.spec
                .skills
                .iter()
                .any(|skill| skill.eq_ignore_ascii_case(folder) || skill_name(skill) == folder)
        })
        .map(|job| job.spec.name.clone())
        .collect()
}

pub(super) async fn read_skill(control: &Control, arguments: &Value) -> Result<Value, String> {
    let name = text(arguments, "skill")?;
    let words = words(control, &name).await?;
    let root = control.inner.teams_root.clone();
    let folder = words.name.clone();
    let given_to = tokio::task::spawn_blocking(move || given_to(&root, &folder))
        .await
        .unwrap_or_default();
    Ok(json!({
        "skill": words.name,
        "description": words.description,
        "instructions": line_edits::numbered(&words.instructions),
        "base": words.base,
        "otherFiles": words.files,
        "givenTo": given_to,
    }))
}

/// A description as the store saves it: one line, single-spaced.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Instructions as the store saves them: no blank lines before, no space after.
fn tidy(text: &str) -> String {
    text.trim_start_matches(['\n', '\r']).trim_end().to_owned()
}

fn checked_description(description: &str) -> Result<String, String> {
    let description = one_line(description);
    if description.is_empty() {
        return Err("Give the skill its `description`: when to use it.".to_owned());
    }
    let length = description.chars().count();
    if length > DESCRIPTION_CHARS {
        return Err(format!(
            "The description is {length} characters: say what it does and when to use it in \
             {DESCRIPTION_CHARS} or fewer."
        ));
    }
    Ok(description)
}

fn checked_instructions(instructions: &str) -> Result<String, String> {
    let instructions = tidy(instructions);
    if instructions.is_empty() {
        return Err("Give the skill its `instructions`: what to do.".to_owned());
    }
    if instructions.chars().count() > INSTRUCTIONS_CHARS {
        return Err(format!(
            "The instructions are too long for a skill: keep them under {INSTRUCTIONS_CHARS} \
             characters."
        ));
    }
    Ok(instructions)
}

/// What a proposal saves, before it is recorded.
struct Drafted {
    skill: String,
    title: Option<String>,
    description: String,
    instructions: String,
    base: Option<String>,
}

async fn new_skill(control: &Control, new: &Value) -> Result<Drafted, String> {
    let new: NewSkill = serde_json::from_value(new.clone())
        .map_err(|error| format!("`new` has a problem: {error}"))?;
    let title = one_line(&new.title)
        .chars()
        .take(TITLE_CHARS)
        .collect::<String>();
    let skill = skill_name(&title);
    if skill.is_empty() {
        return Err("Give the skill a `title` with letters or numbers in it.".to_owned());
    }
    let description = checked_description(&new.description)?;
    let instructions = checked_instructions(&new.instructions)?;
    // The sheet saves a new skill under the folder its title makes, and refuses one that is taken.
    let listed = installed_skills(control).await?;
    let store = store(control)?;
    let wanted = skill.clone();
    let taken = tokio::task::spawn_blocking(move || folder_of(&store, &wanted))
        .await
        .map_err(|error| format!("Couldn't read the skills: {error}"))?
        .or_else(|| {
            listed
                .iter()
                .find(|other| other.name.eq_ignore_ascii_case(&skill))
                .map(|other| other.name.clone())
        });
    if let Some(taken) = taken {
        return Err(format!(
            "They already have a skill called {taken}. Change that one with `change` after \
             `read_skill`, or give this one another title."
        ));
    }
    Ok(Drafted {
        skill,
        title: Some(title),
        description,
        instructions,
        base: None,
    })
}

async fn changed_skill(control: &Control, change: &Value) -> Result<Drafted, String> {
    let change: ChangedSkill = serde_json::from_value(change.clone())
        .map_err(|error| format!("`change` has a problem: {error}"))?;
    if change.instructions.is_some() {
        return Err(
            "Change its instructions with `edits`, by the numbered lines `read_skill` showed, so \
             every line you don't name stays as it was."
                .to_owned(),
        );
    }
    let current = words(control, &change.skill).await?;
    if change.base.as_deref().map(str::trim) != Some(current.base.as_str()) {
        return Err(format!(
            "{} changed since you read it, or `base` is missing. Read it again with `read_skill` \
             and propose the change again.",
            current.name
        ));
    }
    let applied = line_edits::apply(&current.instructions, &change.edits);
    if !applied.missed.is_empty() {
        return Err(format!(
            "Some edits name no line its instructions have ({}). Read it again with `read_skill` \
             and propose the change again.",
            applied.missed.join("; ")
        ));
    }
    let instructions = checked_instructions(&applied.text)?;
    let description = match change.description.as_deref() {
        Some(text) if !text.trim().is_empty() => checked_description(text)?,
        _ => current.description.clone(),
    };
    if instructions == tidy(&current.instructions) && description == current.description {
        return Err(
            "That changes nothing in the skill. Say what to change in `edits` or `description`."
                .to_owned(),
        );
    }
    Ok(Drafted {
        skill: current.name,
        title: None,
        description,
        instructions,
        base: Some(current.base),
    })
}

pub(super) async fn propose_skill(
    control: &Control,
    caller: &Caller,
    arguments: &Value,
) -> Result<Value, String> {
    let summary = text(arguments, "summary").unwrap_or_else(|_| "A proposed skill.".to_owned());
    let given = |key: &str| arguments.get(key).filter(|value| !value.is_null());
    let drafted = match (given("new"), given("change")) {
        (Some(new), None) => new_skill(control, new).await?,
        (None, Some(change)) => changed_skill(control, change).await?,
        _ => {
            return Err(
                "Give `new` for a new skill, or `change` for one of theirs: one of them."
                    .to_owned(),
            );
        }
    };
    let root = control.inner.teams_root.clone();
    let folder = drafted.skill.clone();
    let given_to = if drafted.base.is_some() {
        tokio::task::spawn_blocking(move || given_to(&root, &folder))
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let id = format!("proposal-{}", uuid::Uuid::new_v4());
    let Caller::Conversation(source) = caller.clone();
    let proposal = SkillProposal {
        id: id.clone(),
        source,
        kind: "skill",
        skill: drafted.skill,
        title: drafted.title,
        is_new: drafted.base.is_none(),
        description: drafted.description,
        instructions: drafted.instructions,
        base: drafted.base,
        summary: summary.clone(),
        given_to,
        created_at: now(),
    };
    control
        .record(
            caller,
            "ask_skill_proposal",
            json!({
                "proposalId": id,
                "skill": proposal.skill,
                "title": proposal.title,
                "isNew": proposal.is_new,
                "summary": summary,
                "description": proposal.description,
                "instructions": proposal.instructions,
                "base": proposal.base,
                "givenTo": proposal.given_to,
            }),
        )
        .await;
    let message = if proposal.is_new {
        "Shown to the person as a card. Nothing is saved until they open it and press Save skill. \
         Once saved, every agent can use it."
    } else {
        "Shown to the person as a card. Nothing is saved until they open it and press Save skill. \
         Once saved, every agent that uses it has the new words from its next piece of work."
    };
    control
        .inner
        .skill_proposals
        .write()
        .await
        .insert(id.clone(), proposal);
    Ok(json!({
        "proposalId": id,
        "status": "waiting_for_the_person",
        "message": message,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_description_is_one_line_within_what_a_skill_allows() {
        assert_eq!(
            checked_description("Writes the weekly\n update.  Use it   when asked.").unwrap(),
            "Writes the weekly update. Use it when asked."
        );
        assert!(
            checked_description("  ")
                .unwrap_err()
                .contains("when to use it")
        );
        let long = "word ".repeat(DESCRIPTION_CHARS);
        assert!(
            checked_description(&long)
                .unwrap_err()
                .contains("1024 or fewer")
        );
    }

    #[test]
    fn instructions_are_tidied_as_the_store_saves_them() {
        assert_eq!(
            checked_instructions("\n\n  1. Read the notes.\n2. Write.  \n\n").unwrap(),
            "  1. Read the notes.\n2. Write.",
            "the first line's indent stays"
        );
        assert!(checked_instructions("\n \n").is_err());
        assert!(checked_instructions(&"x".repeat(INSTRUCTIONS_CHARS + 1)).is_err());
    }

    #[test]
    fn only_a_skills_folder_named_skills_is_one_it_can_read() {
        assert!(store_of(Path::new("/state/skills")).is_ok());
        assert!(store_of(Path::new("/elsewhere/my-skills")).is_err());
    }
}

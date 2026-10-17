//! The skills an agent can choose from, as its instructions list them.
//!
//! Only each skill's name and description go in the prompt; the agent reads the skill's
//! `SKILL.md` itself when a task calls for it. That keeps a long list of skills cheap: an agent
//! with a hundred skills pays for a hundred lines, not a hundred files.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use crate::skill_routing::{description, frontmatter_field, split_frontmatter};

/// More than this many skills and the rest are not indexed at all.
const MAX_SKILLS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 300;
/// The most skills the prompt names one by one; the rest are counted, and the agent is told where
/// to look for them. Every listed line is paid for on every model call of every agent.
const LISTED: usize = 120;
/// Past this many skills, each description is cut to its first [`SHORT_DESCRIPTION_CHARS`].
const LONG_LIST: usize = 30;
const SHORT_DESCRIPTION_CHARS: usize = 140;
/// A `SKILL.md` this large is not a skill's instructions.
const MAX_SKILL_BYTES: u64 = 1024 * 1024;

/// One skill an agent can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    /// The skill's `SKILL.md`.
    pub path: PathBuf,
}

/// The skills in `roots`, each `<root>/<skill>/SKILL.md`, without those named in `turned_off`.
///
/// A name found in two roots is the first root's: callers list the agent's own delivered skills
/// before `LoomWatch`'s folder.
#[must_use]
pub fn index_skills(roots: &[PathBuf], turned_off: &[String]) -> Vec<SkillEntry> {
    let off: HashSet<String> = turned_off.iter().map(|name| name.to_lowercase()).collect();
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for root in roots {
        let Ok(read) = fs::read_dir(root) else {
            continue;
        };
        let mut folders: Vec<PathBuf> = read
            .filter_map(Result::ok)
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        folders.sort();
        for folder in folders {
            let Some(skill) = read_skill(&folder) else {
                continue;
            };
            let key = skill.name.to_lowercase();
            if off.contains(&key) || !seen.insert(key) {
                continue;
            }
            skills.push(skill);
            if skills.len() >= MAX_SKILLS {
                return skills;
            }
        }
    }
    skills
}

fn read_skill(folder: &Path) -> Option<SkillEntry> {
    let path = folder.join("SKILL.md");
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SKILL_BYTES {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let (frontmatter, _) = split_frontmatter(&text);
    let name = frontmatter_field(frontmatter, "name")
        .filter(|name| !name.trim().is_empty())
        .or_else(|| Some(folder.file_name()?.to_string_lossy().into_owned()))?;
    let description = cut(
        &description(&text).unwrap_or_default(),
        MAX_DESCRIPTION_CHARS,
    );
    Some(SkillEntry {
        name: name.trim().to_owned(),
        description: description.trim().to_owned(),
        path,
    })
}

/// The prompt section that lists `skills`, or nothing when there are none.
///
/// Each folder of skills is named once, and each skill by its name and what it is for: a skill's
/// instructions are `<folder>/<its folder>/SKILL.md`, and its own folder is named only when it
/// differs from its name. A long list keeps descriptions short and names at most [`LISTED`]
/// skills, because the whole section is paid for on every model call.
pub(crate) fn prompt_section(skills: &[SkillEntry]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut section = String::from(
        "## Skills\n\
         Skills are instructions for particular kinds of work. When a task matches one, read its \
         SKILL.md with read_file before you start, and follow it: it is <folder>/<skill>/SKILL.md, \
         and the files it mentions are beside it. Don't read a skill the task doesn't need.\n",
    );
    let short = skills.len() > LONG_LIST;
    let mut folder: Option<&Path> = None;
    for skill in skills.iter().take(LISTED) {
        let skill_folder = skill.path.parent();
        let root = skill_folder.and_then(Path::parent);
        if root != folder {
            folder = root;
            if let Some(root) = root {
                let _ = writeln!(section, "In {}:", root.display());
            }
        }
        let description = if skill.description.is_empty() {
            "(no description)".to_owned()
        } else if short {
            cut(&skill.description, SHORT_DESCRIPTION_CHARS)
        } else {
            skill.description.clone()
        };
        let own = skill_folder
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy())
            .filter(|name| *name != skill.name)
            .map(|name| format!(" (folder {name})"))
            .unwrap_or_default();
        let _ = writeln!(section, "- {}{own}: {description}", skill.name);
    }
    if skills.len() > LISTED {
        let more = skills.len() - LISTED;
        let _ = writeln!(
            section,
            "…and {more} more skills in the same folders. When a task needs a kind of work none of \
             these covers, list_files the folders above to look for one."
        );
    }
    section
}

/// `text` cut to at most `limit` characters at a word, with an ellipsis when cut.
fn cut(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let head: String = text.chars().take(limit).collect();
    let head = head
        .rsplit_once(' ')
        .map_or(head.as_str(), |(head, _)| head);
    format!("{}…", head.trim_end_matches([',', ';', ':', '.']))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_are_listed_once_and_turned_off_ones_are_left_out() {
        let base =
            std::env::temp_dir().join(format!("loomwatch-agent-skills-{}", uuid::Uuid::new_v4()));
        let delivered = base.join("delivered");
        let library = base.join("library");
        for (root, name, text) in [
            (
                &delivered,
                "writer",
                "---\nname: writer\ndescription: Write plainly.\n---\nBody",
            ),
            (
                &library,
                "writer",
                "---\nname: writer\ndescription: The library's copy.\n---\nBody",
            ),
            (
                &library,
                "research",
                "---\nname: research\ndescription: Find sources.\n---\nBody",
            ),
            (
                &library,
                "noisy",
                "---\nname: noisy\ndescription: Off.\n---\nBody",
            ),
            (&library, ".removed", "---\nname: removed\n---\n"),
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("SKILL.md"), text).unwrap();
        }
        let skills = index_skills(&[delivered.clone(), library.clone()], &["Noisy".to_owned()]);
        let names: Vec<(&str, &str)> = skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.description.as_str()))
            .collect();
        assert_eq!(
            names,
            [("writer", "Write plainly."), ("research", "Find sources.")]
        );
        let section = prompt_section(&skills);
        assert!(section.starts_with("## Skills\n"));
        // Each folder is named once, and each skill by name and purpose under it.
        assert!(section.contains(&format!(
            "In {}:\n- writer: Write plainly.",
            delivered.display()
        )));
        assert!(section.contains(&format!(
            "In {}:\n- research: Find sources.",
            library.display()
        )));
        let _ = fs::remove_dir_all(&base);
    }

    fn entry(root: &str, folder: &str, name: &str, description: &str) -> SkillEntry {
        SkillEntry {
            name: name.to_owned(),
            description: description.to_owned(),
            path: PathBuf::from(root).join(folder).join("SKILL.md"),
        }
    }

    /// A long list is paid for on every model call: short descriptions, at most `LISTED` lines,
    /// and the rest counted with where to look for them.
    #[test]
    fn a_long_list_of_skills_stays_short() {
        let long =
            "Turns a messy folder of notes into a tidy outline with headings, links between \
                    related notes, a summary at the top and a list of open questions at the end."
                .to_owned();
        let skills: Vec<SkillEntry> = (0..LISTED + 5)
            .map(|index| entry("/skills", &format!("s{index}"), &format!("s{index}"), &long))
            .collect();
        let section = prompt_section(&skills);
        assert_eq!(
            section.matches("In /skills:").count(),
            1,
            "the folder is named once"
        );
        assert_eq!(
            section
                .lines()
                .filter(|line| line.starts_with("- "))
                .count(),
            LISTED
        );
        assert!(section.contains("…and 5 more skills in the same folders"));
        let line = section
            .lines()
            .find(|line| line.starts_with("- s0:"))
            .unwrap();
        assert!(
            line.ends_with('…') && line.chars().count() < SHORT_DESCRIPTION_CHARS + 10,
            "{line}"
        );
        // A few skills keep their whole description, and a folder named apart from its skill says so.
        let few = prompt_section(&[entry("/skills", "explain-like-im-5", "eli5", &long)]);
        assert!(
            few.contains(&format!("- eli5 (folder explain-like-im-5): {long}")),
            "{few}"
        );
        // Roughly what three hundred skills used to cost, against what they cost now.
        let three_hundred: Vec<SkillEntry> = (0..300)
            .map(|index| {
                entry(
                    "/Users/someone/Library/Application Support/LoomWatch/skills",
                    &format!("skill-{index}"),
                    &format!("skill-{index}"),
                    &long,
                )
            })
            .collect();
        assert!(
            prompt_section(&three_hundred).len() < 25_000,
            "{}",
            prompt_section(&three_hundred).len()
        );
    }
}

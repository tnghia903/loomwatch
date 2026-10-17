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

/// More than this many skills and the rest are left out of the prompt.
const MAX_SKILLS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 300;
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
    let description: String = description(&text)
        .unwrap_or_default()
        .chars()
        .take(MAX_DESCRIPTION_CHARS)
        .collect();
    Some(SkillEntry {
        name: name.trim().to_owned(),
        description: description.trim().to_owned(),
        path,
    })
}

/// The prompt section that lists `skills`, or nothing when there are none.
pub(crate) fn prompt_section(skills: &[SkillEntry]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut section = String::from(
        "## Skills\n\
         Skills are instructions for particular kinds of work. When a task matches one, read its \
         SKILL.md with read_file before you start, and follow it; the files it mentions are in \
         the same folder. Don't read a skill the task doesn't need.\n",
    );
    for skill in skills {
        let description = if skill.description.is_empty() {
            "(no description)"
        } else {
            &skill.description
        };
        let _ = writeln!(
            section,
            "- {}: {description} ({})",
            skill.name,
            skill.path.display()
        );
    }
    section
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
        assert!(section.contains("- research: Find sources. ("));
        let _ = fs::remove_dir_all(&base);
    }
}

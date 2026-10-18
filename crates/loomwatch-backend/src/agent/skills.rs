//! The skills an agent can choose from, as its instructions list them.
//!
//! Only each skill's name and description go in the prompt; the agent reads the skill's
//! `SKILL.md` itself when a task calls for it. Every listed line is paid for on every model call,
//! so not every skill is listed:
//! - the agent's own skills, the ones delivered to its folder, always are;
//! - `LoomWatch`'s library is listed whole while it is small ([`SMALL_LIBRARY`]);
//! - a larger library is listed by what the agent's work calls for ([`relevant`]): the skills that
//!   share the most rare words with its role and task, at most [`MATCHED`] of them, then one line
//!   saying where the rest are, so the agent can look for one the list leaves out.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use crate::skill_routing::{description, frontmatter_field, split_frontmatter};

/// More than this many skills and the rest are not indexed at all.
const MAX_SKILLS: usize = 1_000;
const MAX_DESCRIPTION_CHARS: usize = 300;
/// The most of the agent's own skills listed one by one. An agent is given a few.
const LISTED: usize = 120;
/// A library this small is listed whole: picking from it would save little and could hide the one
/// skill the work needed.
pub(crate) const SMALL_LIBRARY: usize = 20;
/// The most library skills listed for a larger library, the ones the work calls for most.
pub(crate) const MATCHED: usize = 15;
/// A skill is listed only when it scores at least this share of the best one's score: generous, so
/// a skill the work may need is not hidden, while one that shares a word in passing is not listed
/// beside one the work is plainly about.
const NEAR_THE_BEST: f64 = 0.25;
/// A word is rare when at most this share of the library uses it, and never fewer than two skills.
const RARE_SHARE: usize = 10;
/// Past this many listed skills, each description is cut to its first [`SHORT_DESCRIPTION_CHARS`].
const LONG_LIST: usize = 30;
const SHORT_DESCRIPTION_CHARS: usize = 140;
/// A `SKILL.md` this large is not a skill's instructions.
const MAX_SKILL_BYTES: u64 = 1024 * 1024;
/// A word a skill's name shares with the work counts this many times one its description shares.
const NAME_WEIGHT: f64 = 3.0;
/// Words that say nothing about what a piece of work is about: English's commonest, and the words
/// every request and every skill use ("task", "request", "result").
const COMMON_WORDS: &[&str] = &[
    "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any",
    "are", "as", "ask", "at", "be", "because", "been", "before", "being", "below", "between",
    "both", "but", "by", "can", "could", "did", "do", "does", "doing", "don", "down", "during",
    "each", "every", "few", "first", "for", "from", "further", "get", "give", "had", "has", "have",
    "having", "he", "help", "her", "here", "him", "his", "how", "if", "in", "into", "is", "it",
    "its", "just", "keep", "know", "last", "let", "like", "made", "make", "many", "may", "me",
    "might", "more", "most", "much", "must", "my", "need", "new", "next", "no", "nor", "not",
    "now", "of", "off", "on", "once", "one", "only", "or", "other", "our", "out", "over", "own",
    "person", "put", "reply", "request", "result", "same", "say", "see", "she", "should", "show",
    "so", "some", "step", "such", "take", "task", "team", "tell", "than", "that", "the", "their",
    "them", "then", "there", "these", "they", "thing", "this", "those", "three", "through", "to",
    "too", "two", "under", "until", "up", "use", "used", "user", "using", "very", "via", "want",
    "was", "way", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
    "will", "with", "work", "would", "you", "your",
];

/// One skill an agent can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    /// The skill's `SKILL.md`.
    pub path: PathBuf,
}

/// The skills an agent may be shown.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillIndex {
    /// Delivered to the agent's own folders: always listed.
    pub own: Vec<SkillEntry>,
    /// `LoomWatch`'s library, which every agent can read.
    pub library: Vec<SkillEntry>,
    /// Where the library is, for the line that points at the skills not listed.
    pub library_roots: Vec<PathBuf>,
}

impl SkillIndex {
    /// The skills in `own_roots` and `library_roots`, without those named in `turned_off`. A name
    /// found twice is the first one's, and the agent's own come first.
    #[must_use]
    pub fn read(own_roots: &[PathBuf], library_roots: &[PathBuf], turned_off: &[String]) -> Self {
        let roots: Vec<PathBuf> = own_roots.iter().chain(library_roots).cloned().collect();
        let (library, own) = index_skills(&roots, turned_off)
            .into_iter()
            .partition(|skill| {
                library_roots
                    .iter()
                    .any(|root| skill.path.starts_with(root))
            });
        Self {
            own,
            library,
            library_roots: library_roots.to_vec(),
        }
    }

    /// Whether which skills are listed depends on the work: a library too large to list whole.
    #[must_use]
    pub fn picks_by_work(&self) -> bool {
        self.library.len() > SMALL_LIBRARY
    }
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

/// The library skills `work` calls for most, best first, at most `limit`.
///
/// One rule for any library and any work. A skill scores for each rare word it shares with the
/// work (one at most a [`RARE_SHARE`]th of the library uses), weighted by how rare it is, and a
/// word of its name counts [`NAME_WEIGHT`] times. It is a match when it shares a rare word of its
/// name, or two rare words, and scores [`NEAR_THE_BEST`] of the best match or more. Ties keep the
/// library's order.
pub(crate) fn relevant<'a>(
    library: &'a [SkillEntry],
    work: &str,
    limit: usize,
) -> Vec<&'a SkillEntry> {
    let work: HashSet<String> = words(work).collect();
    if work.is_empty() || library.is_empty() {
        return Vec::new();
    }
    let skills: Vec<(HashSet<String>, HashSet<String>)> = library
        .iter()
        .map(|skill| {
            let mut name: HashSet<String> = words(&skill.name).collect();
            if let Some(folder) = skill.path.parent().and_then(Path::file_name) {
                name.extend(words(&folder.to_string_lossy()));
            }
            let all = name
                .iter()
                .cloned()
                .chain(words(&skill.description))
                .collect();
            (name, all)
        })
        .collect();
    let mut used: HashMap<&str, usize> = HashMap::new();
    for (_, all) in &skills {
        for word in all {
            *used.entry(word.as_str()).or_default() += 1;
        }
    }
    #[allow(clippy::cast_precision_loss)]
    let total = library.len() as f64;
    let rare = (library.len() / RARE_SHARE).max(2);
    let mut scored: Vec<(f64, usize)> = skills
        .iter()
        .enumerate()
        .filter_map(|(index, (name, all))| {
            let shared: Vec<&String> = all
                .iter()
                .filter(|word| work.contains(*word) && used[word.as_str()] <= rare)
                .collect();
            if shared.len() < 2 && !shared.iter().any(|word| name.contains(*word)) {
                return None;
            }
            let score = shared
                .iter()
                .map(|word| {
                    #[allow(clippy::cast_precision_loss)]
                    let rarity = ((total + 1.0) / (used[word.as_str()] as f64 + 0.5)).ln();
                    if name.contains(*word) {
                        rarity * NAME_WEIGHT
                    } else {
                        rarity
                    }
                })
                .sum::<f64>();
            Some((score, index))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    let best = scored.first().map_or(0.0, |(score, _)| *score);
    scored
        .into_iter()
        .take_while(|(score, _)| *score >= best * NEAR_THE_BEST)
        .take(limit)
        .map(|(_, index)| &library[index])
        .collect()
}

/// The words of `text` that can say what it is about: lowercased, common words left out, and the
/// commonest English endings taken off, so "researcher", "researching" and "research" meet.
fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|word| {
            word.chars().count() >= 2
                && !word.chars().all(|c| c.is_ascii_digit())
                && !COMMON_WORDS.contains(&word.as_str())
        })
        .map(|word| stem(&word))
}

/// A root keeps four letters at least, so "notes" and "note" meet and "news" stays news.
fn stem(word: &str) -> String {
    if !word.is_ascii() {
        return word.to_owned();
    }
    if let Some(root) = word.strip_suffix("ies").filter(|root| root.len() >= 3) {
        return format!("{root}y");
    }
    for ending in ["ing", "ers", "er", "ed", "es", "s", "e"] {
        if let Some(root) = word.strip_suffix(ending).filter(|root| root.len() >= 4) {
            return root.to_owned();
        }
    }
    word.to_owned()
}

/// The prompt section that lists the skills, or nothing when there are none.
///
/// Each folder of skills is named once, and each skill by its name and what it is for: a skill's
/// instructions are `<folder>/<its folder>/SKILL.md`, and its own folder is named only when it
/// differs from its name. `work` is what the agent was asked, for picking from a large library.
pub(crate) fn prompt_section(index: &SkillIndex, work: &str) -> String {
    let picked: Vec<&SkillEntry> = if index.picks_by_work() {
        relevant(&index.library, work, MATCHED)
    } else {
        index.library.iter().collect()
    };
    let listed: Vec<&SkillEntry> = index.own.iter().take(LISTED).chain(picked).collect();
    let more = index.library.len() + index.own.len() - listed.len();
    if listed.is_empty() && more == 0 {
        return String::new();
    }
    let mut section = String::from(
        "## Skills\n\
         Skills are instructions for particular kinds of work. When a task matches one, read its \
         SKILL.md with read_file before you start, and follow it: it is <folder>/<skill>/SKILL.md, \
         and the files it mentions are beside it. Don't read a skill the task doesn't need.\n",
    );
    let short = listed.len() > LONG_LIST;
    let mut folder: Option<&Path> = None;
    for skill in &listed {
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
    if more > 0 {
        let folders = if index.library_roots.is_empty() {
            "the same folders".to_owned()
        } else {
            index
                .library_roots
                .iter()
                .map(|root| root.display().to_string())
                .collect::<Vec<_>>()
                .join(" and ")
        };
        let lead = if listed.is_empty() {
            format!("There are {more} skills in {folders}.")
        } else {
            format!("…and {more} more skills in {folders}.")
        };
        let _ = writeln!(
            section,
            "{lead} The ones listed are those closest to this work: when it needs a kind of skill \
             none of them covers, list_files that folder and read the SKILL.md of the one that \
             fits."
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
        let index = SkillIndex::read(
            std::slice::from_ref(&delivered),
            std::slice::from_ref(&library),
            &["Noisy".to_owned()],
        );
        let names = |skills: &[SkillEntry]| -> Vec<(String, String)> {
            skills
                .iter()
                .map(|skill| (skill.name.clone(), skill.description.clone()))
                .collect()
        };
        assert_eq!(
            names(&index.own),
            [("writer".to_owned(), "Write plainly.".to_owned())]
        );
        assert_eq!(
            names(&index.library),
            [("research".to_owned(), "Find sources.".to_owned())]
        );
        let section = prompt_section(&index, "");
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

    const LIBRARY: &str = "/Users/someone/Library/Application Support/LoomWatch/skills";

    /// A library of `size` skills about nothing in particular, with `slides` among them when it
    /// has room: the one a deck needs.
    fn library(size: usize) -> SkillIndex {
        let filler = "Turns a messy folder of notes into a tidy outline with headings, links \
                      between related notes and a list of open questions at the end.";
        let mut skills: Vec<SkillEntry> = (0..size)
            .map(|index| {
                entry(
                    LIBRARY,
                    &format!("skill-{index:03}"),
                    &format!("skill-{index:03}"),
                    filler,
                )
            })
            .collect();
        if size > 0 {
            skills[size / 2] = entry(
                LIBRARY,
                "slides",
                "slides",
                "Build a presentation deck as HTML slides, with speaker notes.",
            );
        }
        SkillIndex {
            own: Vec::new(),
            library: skills,
            library_roots: vec![PathBuf::from(LIBRARY)],
        }
    }

    fn listed(section: &str) -> usize {
        section
            .lines()
            .filter(|line| line.starts_with("- "))
            .count()
    }

    /// Up to [`SMALL_LIBRARY`] skills are all listed, whatever the work; none, and there is no
    /// section at all.
    #[test]
    fn a_small_library_is_listed_whole() {
        assert_eq!(prompt_section(&library(0), "Make a deck"), "");
        for size in [1, 5, SMALL_LIBRARY] {
            let section = prompt_section(&library(size), "Something else entirely");
            assert_eq!(listed(&section), size, "{section}");
            assert!(!section.contains("more skills"), "{section}");
            assert_eq!(section.matches(&format!("In {LIBRARY}:")).count(), 1);
        }
    }

    /// A larger library lists only what the work calls for, and says where the rest are, with
    /// their number, so the agent can look for one the list leaves out.
    #[test]
    fn a_large_library_lists_what_the_work_calls_for() {
        for size in [SMALL_LIBRARY + 1, 120, 300] {
            let index = library(size);
            let section = prompt_section(
                &index,
                "## Your assigned role\nYou make decks.\n\n## Task\nPrepare the slides for Monday's presentation.",
            );
            assert_eq!(listed(&section), 1, "{size}: {section}");
            assert!(
                section.contains("- slides: Build a presentation deck"),
                "{section}"
            );
            assert!(
                section.contains(&format!("…and {} more skills in {LIBRARY}.", size - 1)),
                "{section}"
            );
            assert!(section.contains("list_files that folder"), "{section}");
            // Words every skill in the library uses say nothing about which one the work needs.
            assert_eq!(
                listed(&prompt_section(&index, "Tidy the outline of these notes.")),
                0,
                "{size}"
            );
            // Nothing the work is about: no skill listed, and the folder still named.
            let unrelated = prompt_section(&index, "Summarise this quarterly budget.");
            assert_eq!(listed(&unrelated), 0, "{unrelated}");
            assert!(unrelated.contains(&format!("There are {size} skills in {LIBRARY}.")));
            // Before the work is known, the same.
            assert_eq!(prompt_section(&index, ""), unrelated);
        }
        // Three hundred skills cost a few hundred characters, not the 13,700 of a full list.
        assert!(prompt_section(&library(300), "Prepare the slides").len() < 1_000);
    }

    /// The agent's own skills are always listed, and at most [`MATCHED`] from the library.
    #[test]
    fn its_own_skills_always_and_at_most_matched_from_the_library() {
        let mut index = library(300);
        index.own = vec![entry(
            "/work/.agents/skills",
            "house-style",
            "house-style",
            "How we write.",
        )];
        // Twenty skills about charts, in a library of three hundred: their words are still rare.
        for (position, skill) in index.library.iter_mut().enumerate().take(20) {
            *skill = entry(
                LIBRARY,
                &format!("chart-{position}"),
                &format!("chart-{position}"),
                "Draws a chart of quarterly figures.",
            );
        }
        let section = prompt_section(&index, "Make a chart of the quarterly figures.");
        assert!(
            section.contains("- house-style: How we write."),
            "{section}"
        );
        assert_eq!(listed(&section), 1 + MATCHED, "{section}");
        assert!(section.contains(&format!("…and {} more skills", 300 - MATCHED)));
        // In the library's order when they score the same.
        assert!(section.find("- chart-0:").unwrap() < section.find("- chart-14:").unwrap());
        assert!(!section.contains("- chart-15:"), "{section}");
    }

    /// One rule for any names: a word of the name counts most, endings and case don't matter,
    /// any language's letters are words, and a word half the library shares picks nothing.
    #[test]
    fn names_in_any_form_and_language_are_matched_by_rare_words() {
        let skills = vec![
            entry(
                LIBRARY,
                "pdf-viewer",
                "pdf-viewer",
                "Open and annotate documents.",
            ),
            entry(
                LIBRARY,
                "data_viz",
                "Data_Viz",
                "Charts and figures for documents.",
            ),
            entry(
                LIBRARY,
                "bao-cao",
                "Báo cáo tài chính",
                "Viết báo cáo cho công ty.",
            ),
            entry(
                LIBRARY,
                "researcher",
                "researcher",
                "Finds sources on the web for documents.",
            ),
            entry(LIBRARY, "writer", "writer", "Writes documents."),
            entry(LIBRARY, "editor", "editor", "Tightens documents."),
            entry(LIBRARY, "coder", "coder", "Changes code in documents."),
            entry(LIBRARY, "designer", "designer", "Designs documents."),
            entry(
                LIBRARY,
                "chart-maker",
                "chart-maker",
                "Draws diagrams for documents.",
            ),
            entry(
                LIBRARY,
                "viewer-notes",
                "viewer-notes",
                "Annotates a viewer's notes.",
            ),
        ];
        let names = |work: &str| -> Vec<String> {
            relevant(&skills, work, MATCHED)
                .into_iter()
                .map(|skill| skill.name.clone())
                .collect()
        };
        assert_eq!(names("Annotate this PDF"), ["pdf-viewer"]);
        assert_eq!(names("A DATA visualisation"), ["Data_Viz"]);
        assert_eq!(names("Lập báo cáo tài chính quý"), ["Báo cáo tài chính"]);
        assert_eq!(names("Researching the market"), ["researcher"]);
        // Every skill mentions documents: the word picks none of them.
        assert!(names("Tidy these documents").is_empty());
        // A word in the name outranks the same word in a description, wherever the skill is in
        // the library.
        assert_eq!(
            names("charts of quarterly figures"),
            ["chart-maker", "Data_Viz"]
        );
        // One rare word of a description is a word in passing, not a match.
        assert!(names("A figure of speech").is_empty());
    }

    /// Matching is generous, so a skill the work may need is listed, but one far behind the skill
    /// the work is plainly about is not listed beside it.
    #[test]
    fn a_skill_far_behind_the_best_is_left_out() {
        let mut skills = vec![
            entry(
                LIBRARY,
                "pdf-viewer-app",
                "pdf-viewer-app",
                "Open, annotate and sign documents.",
            ),
            entry(
                LIBRARY,
                "annotation-log",
                "annotation-log",
                "Annotates what a viewer saw.",
            ),
        ];
        skills.extend((0..6).map(|index| {
            entry(
                LIBRARY,
                &format!("tool-{index}"),
                &format!("tool-{index}"),
                "Tidies a folder.",
            )
        }));
        let names = |work: &str| -> Vec<String> {
            relevant(&skills, work, MATCHED)
                .into_iter()
                .map(|skill| skill.name.clone())
                .collect()
        };
        assert_eq!(
            names("Annotate it in the PDF viewer app"),
            ["pdf-viewer-app"]
        );
        // Nearer the best, the weaker one is listed too.
        assert_eq!(
            names("Annotate what a viewer saw"),
            ["pdf-viewer-app", "annotation-log"]
        );
    }
}

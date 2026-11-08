//! Skills written and changed in `LoomWatch` (ADR 0118).
//!
//! A skill's own words are two things: when to use it, its `description:`, which is all an agent
//! sees of a skill before it opens one, and what to do, the body of its `SKILL.md`. The Skills
//! page's sheet edits those two and nothing else: every other line of the frontmatter, and every
//! other file the skill holds, stays exactly as it was. A new skill is one `SKILL.md` in a folder
//! named by [`skill_name`].
//!
//! - A change names the `SKILL.md` it started from ([`SkillWords::base`]), so a skill changed
//!   meanwhile, in another window or by hand, is never written over.
//! - The `SKILL.md` a change replaces is kept in `skills/.removed/`, as a removed skill's folder
//!   is, and a new file is written beside the folder and moved into place whole.
//! - A `SKILL.md` that is a link is never written through: it could point anywhere.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::{
    MAX_SKILL_TEXT, Origin, OriginKind, SKILL_FILE, SkillRecord, SkillsError, SkillsStore,
    folder_names, hash_folder, hex, plain_permissions, read_folder, removed_place, usable_name,
};
use crate::skill_routing::{frontmatter_field, split_frontmatter};

/// The longest name a new skill gets, in characters, as the Agent Skills format allows.
pub const NAME_CHARS: usize = 64;
/// The longest a folder name may be in bytes ([`usable_name`]).
const NAME_BYTES: usize = 128;
/// The longest description, in characters, as the Agent Skills format allows.
pub const DESCRIPTION_CHARS: usize = 1024;
/// The longest agent name an origin records.
const AGENT_NAME_CHARS: usize = 80;

/// One skill's own words, as the sheet shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillWords {
    /// Its folder's name.
    pub name: String,
    /// When to use it: its `description:`, as one line.
    pub description: String,
    /// What to do: everything after its frontmatter.
    pub instructions: String,
    /// Its other files, by path inside its folder, which a change keeps as they are.
    pub files: Vec<String>,
    /// The hash of its `SKILL.md`, which a change names.
    pub base: String,
}

/// A skill's words to save: a new skill without `base`, a change to one with it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteSkill {
    pub name: String,
    pub description: String,
    pub instructions: String,
    /// The [`SkillWords::base`] the change started from. Absent for a new skill.
    #[serde(default)]
    pub base: Option<String>,
    /// For a new skill an agent suggested in the chat: that agent, by the name the chat showed.
    #[serde(default)]
    pub suggested_by: Option<String>,
}

/// What a save did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub skill: SkillRecord,
    /// The hash of the `SKILL.md` now in place, which the next change, or an Undo, names.
    pub base: String,
    /// The words it had before a change, for Undo. Absent for a new skill, and for a save that
    /// changed nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<SkillWords>,
}

/// The folder name a skill called `title` gets: its letters and numbers, lowercased, words joined
/// by hyphens, at most [`NAME_CHARS`] characters. Any script's letters stay, so "Báo cáo tuần" is
/// `báo-cáo-tuần`. Empty when the title has no letters or numbers.
///
/// The app names a new skill the same way (`ui/src/lib/library/skillName.ts`); both read the
/// cases in `schemas/skill-name.cases.json`.
#[must_use]
pub fn skill_name(title: &str) -> String {
    let mut name = String::new();
    let mut chars = 0usize;
    let mut gap = false;
    for c in title.nfc() {
        // "Mai's report" is `mais-report`, not `mai-s-report`.
        if matches!(c, '\'' | '’') {
            continue;
        }
        if !(c.is_alphanumeric() || unicode_normalization::char::is_combining_mark(c)) {
            gap = true;
            continue;
        }
        let mut piece = String::new();
        if gap && !name.is_empty() {
            piece.push('-');
        }
        piece.extend(c.to_lowercase());
        let more = piece.chars().count();
        if chars + more > NAME_CHARS || name.len() + piece.len() > NAME_BYTES {
            break;
        }
        name.push_str(&piece);
        chars += more;
        gap = false;
    }
    name
}

/// Whether `name` can be a new skill's folder name: it is already what [`skill_name`] makes.
#[must_use]
pub fn is_new_name(name: &str) -> bool {
    !name.is_empty() && usable_name(name) && skill_name(name) == name
}

impl SkillsStore {
    /// The words of the skill in folder `name`, which must be in `LoomWatch`'s folder.
    ///
    /// # Errors
    /// When there is no such skill, or its `SKILL.md` can't be changed here.
    pub fn words(&self, name: &str) -> Result<SkillWords, SkillsError> {
        let _gate = self.lock();
        let directory = self.skill_directory(name)?;
        let text = read_skill_file(name, &directory)?;
        Ok(words_of(
            name,
            &text,
            other_files(&directory, &self.limits)?,
        ))
    }

    /// Save a skill's words: a new skill when `write.base` is absent, otherwise a change to the
    /// skill whose `SKILL.md` it names.
    ///
    /// # Errors
    /// When the words are missing or too long, the name is taken or can't be a skill's, or the
    /// skill changed since `base` was read.
    pub fn write(&self, write: &WriteSkill) -> Result<Written, SkillsError> {
        let description = one_line(&write.description);
        let instructions = tidy(&write.instructions);
        check(&description, &instructions)?;
        let _gate = self.lock();
        match &write.base {
            None => {
                let mut origin = Origin::new(OriginKind::Written);
                origin.suggested_by = write
                    .suggested_by
                    .as_deref()
                    .map(one_line)
                    .filter(|agent| !agent.is_empty())
                    .map(|agent| agent.chars().take(AGENT_NAME_CHARS).collect());
                self.create(&write.name, &description, &instructions, origin)
            }
            Some(base) => self.change(&write.name, base, &description, &instructions),
        }
    }

    /// The folder of the skill named exactly `name`, holding a `SKILL.md` that is a plain file.
    fn skill_directory(&self, name: &str) -> Result<PathBuf, SkillsError> {
        let missing =
            || SkillsError::NotFound(format!("There’s no skill named “{name}” in LoomWatch."));
        let folder = self.folder();
        // Exactly: on a Mac `PDF` would open the folder `pdf`, and its record would not be found.
        if !usable_name(name) || !folder_names(&folder)?.iter().any(|found| found == name) {
            return Err(missing());
        }
        let directory = folder.join(name);
        match fs::symlink_metadata(directory.join(SKILL_FILE)) {
            Ok(metadata) if metadata.is_file() => Ok(directory),
            Ok(_) => Err(SkillsError::Refused(format!(
                "LoomWatch can’t change “{name}”: its file is kept somewhere else."
            ))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(missing()),
            Err(error) => Err(error.into()),
        }
    }

    fn create(
        &self,
        name: &str,
        description: &str,
        instructions: &str,
        origin: Origin,
    ) -> Result<Written, SkillsError> {
        if !is_new_name(name) {
            return Err(SkillsError::Invalid(
                "Give the skill a name with letters or numbers in it.".to_owned(),
            ));
        }
        let folder = self.folder();
        fs::create_dir_all(&folder)?;
        let wanted = name.to_lowercase();
        if folder_names(&folder)?
            .iter()
            .any(|found| found.to_lowercase() == wanted)
        {
            return Err(SkillsError::Conflict(format!(
                "You already have a skill named “{name}”. Give this one another name."
            )));
        }
        let text = compose("", name, Some(description), instructions);
        fits(&text)?;
        let staging = self.staging();
        fs::create_dir_all(&staging)?;
        let copy = staging.join(format!("new-{}", uuid::Uuid::new_v4().simple()));
        let result = self.place_new(name, &text, &copy, origin);
        if result.is_err() {
            let _ = fs::remove_dir_all(&copy);
        }
        result
    }

    fn place_new(
        &self,
        name: &str,
        text: &str,
        copy: &Path,
        origin: Origin,
    ) -> Result<Written, SkillsError> {
        fs::create_dir_all(copy)?;
        write_plain(&copy.join(SKILL_FILE), text)?;
        let facts = read_folder(copy, name, None, &self.limits)?;
        let sha256 = hash_folder(copy)?;
        fs::rename(copy, self.folder().join(name))?;
        let record = SkillRecord {
            name: name.to_owned(),
            description: facts.description,
            origin,
            license: facts.license,
            needs: facts.needs,
            runtimes: facts.runtimes,
            has_scripts: facts.has_scripts,
            size_bytes: facts.size_bytes,
            sha256,
            added_at: Utc::now(),
            batch_id: None,
            changed_at: None,
        };
        let mut manifest = self.load();
        manifest
            .skills
            .retain(|kept| kept.name.to_lowercase() != name.to_lowercase());
        manifest.skills.push(record.clone());
        self.save(&mut manifest)?;
        Ok(Written {
            skill: record,
            base: hash_text(text),
            previous: None,
        })
    }

    fn change(
        &self,
        name: &str,
        base: &str,
        description: &str,
        instructions: &str,
    ) -> Result<Written, SkillsError> {
        let directory = self.skill_directory(name)?;
        let current = read_skill_file(name, &directory)?;
        if hash_text(&current) != base {
            return Err(SkillsError::Conflict(format!(
                "“{name}” changed since you opened it. Close it and open it again to see the change."
            )));
        }
        let previous = words_of(name, &current, other_files(&directory, &self.limits)?);
        let same_description = previous.description == description;
        if same_description && previous.instructions == instructions {
            let skill = self.record_of(name, &directory)?;
            return Ok(Written {
                skill,
                base: previous.base,
                previous: None,
            });
        }
        let (frontmatter, _) = split_frontmatter(&current);
        // An unchanged description keeps its own lines, however they were written.
        let text = compose(
            frontmatter,
            name,
            (!same_description).then_some(description),
            instructions,
        );
        fits(&text)?;
        let kept = removed_place(&self.folder(), name)?;
        fs::create_dir_all(&kept)?;
        write_plain(&kept.join(SKILL_FILE), &current)?;
        self.replace_file(&directory.join(SKILL_FILE), &text)?;

        let facts = read_folder(&directory, name, None, &self.limits)?;
        let sha256 = hash_folder(&directory)?;
        let now = Utc::now();
        let mut manifest = self.load();
        let skill = if let Some(record) = manifest
            .skills
            .iter_mut()
            .find(|record| record.name == name)
        {
            record.description = facts.description;
            record.needs = facts.needs;
            record.runtimes = facts.runtimes;
            record.has_scripts = facts.has_scripts;
            record.size_bytes = facts.size_bytes;
            record.sha256 = sha256;
            record.changed_at = Some(now);
            record.clone()
        } else {
            // Put in the folder by hand: from now on `LoomWatch` keeps a record of it.
            let record = SkillRecord {
                name: name.to_owned(),
                description: facts.description,
                origin: Origin::new(OriginKind::Found),
                license: facts.license,
                needs: facts.needs,
                runtimes: facts.runtimes,
                has_scripts: facts.has_scripts,
                size_bytes: facts.size_bytes,
                sha256,
                added_at: added_at(&directory),
                batch_id: None,
                changed_at: Some(now),
            };
            manifest.skills.push(record.clone());
            record
        };
        self.save(&mut manifest)?;
        Ok(Written {
            skill,
            base: hash_text(&text),
            previous: Some(previous),
        })
    }

    /// Its record, or what the list says of a skill put in the folder by hand.
    fn record_of(&self, name: &str, directory: &Path) -> Result<SkillRecord, SkillsError> {
        if let Some(record) = self
            .load()
            .skills
            .into_iter()
            .find(|record| record.name == name)
        {
            return Ok(record);
        }
        let facts = read_folder(directory, name, None, &self.limits)?;
        Ok(SkillRecord {
            name: name.to_owned(),
            description: facts.description,
            origin: Origin::new(OriginKind::Found),
            license: facts.license,
            needs: facts.needs,
            runtimes: facts.runtimes,
            has_scripts: facts.has_scripts,
            size_bytes: facts.size_bytes,
            sha256: String::new(),
            added_at: added_at(directory),
            batch_id: None,
            changed_at: None,
        })
    }

    /// Write `text` beside the folder and move it over `target` whole, so a reader never sees half
    /// of it.
    fn replace_file(&self, target: &Path, text: &str) -> Result<(), SkillsError> {
        let staging = self.staging();
        fs::create_dir_all(&staging)?;
        let temporary = staging.join(format!("change-{}.md", uuid::Uuid::new_v4().simple()));
        let written = write_plain(&temporary, text).and_then(|()| fs::rename(&temporary, target));
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        Ok(written?)
    }
}

fn added_at(directory: &Path) -> chrono::DateTime<Utc> {
    fs::metadata(directory)
        .and_then(|metadata| metadata.modified())
        .map_or_else(|_| Utc::now(), chrono::DateTime::<Utc>::from)
}

fn write_plain(path: &Path, text: &str) -> io::Result<()> {
    fs::write(path, text)?;
    plain_permissions(path)
}

/// A skill's `SKILL.md`, read whole: one too long to be instructions, or not text, isn't changed
/// here.
fn read_skill_file(name: &str, directory: &Path) -> Result<String, SkillsError> {
    let path = directory.join(SKILL_FILE);
    if fs::metadata(&path)?.len() > MAX_SKILL_TEXT {
        return Err(SkillsError::Refused(format!(
            "“{name}” is too long to change in LoomWatch."
        )));
    }
    let text = String::from_utf8(fs::read(&path)?).map_err(|_| {
        SkillsError::Refused(format!(
            "LoomWatch can’t change “{name}”: its file isn’t plain text."
        ))
    })?;
    Ok(text
        .strip_prefix('\u{feff}')
        .map_or(text.clone(), str::to_owned))
}

fn words_of(name: &str, text: &str, files: Vec<String>) -> SkillWords {
    let (frontmatter, body) = split_frontmatter(text);
    SkillWords {
        name: name.to_owned(),
        description: frontmatter_field(frontmatter, "description").unwrap_or_default(),
        instructions: tidy(body),
        files,
        base: hash_text(text),
    }
}

fn other_files(directory: &Path, limits: &super::Limits) -> io::Result<Vec<String>> {
    Ok(read_folder(directory, "", None, limits)?
        .files
        .into_iter()
        .filter(|file| file != SKILL_FILE)
        .collect())
}

fn hash_text(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// Words on one line, single-spaced: a description is one paragraph.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Instructions without blank lines before them or space after them.
fn tidy(text: &str) -> String {
    text.trim_start_matches(['\n', '\r']).trim_end().to_owned()
}

fn check(description: &str, instructions: &str) -> Result<(), SkillsError> {
    if description.is_empty() {
        return Err(SkillsError::Invalid(
            "Say when your agents should use it.".to_owned(),
        ));
    }
    if description.chars().count() > DESCRIPTION_CHARS {
        return Err(SkillsError::Invalid(format!(
            "Say when to use it in {DESCRIPTION_CHARS} characters or fewer."
        )));
    }
    if instructions.is_empty() {
        return Err(SkillsError::Invalid(
            "Say what your agents should do.".to_owned(),
        ));
    }
    Ok(())
}

fn fits(text: &str) -> Result<(), SkillsError> {
    if text.len() as u64 > MAX_SKILL_TEXT {
        return Err(SkillsError::Invalid(
            "What to do is too long for one skill.".to_owned(),
        ));
    }
    Ok(())
}

/// A `SKILL.md` with these words. `frontmatter` is the one it had (empty for a new skill): every
/// key in it is kept line for line, except `description:` when there is a new one. A `name:` is
/// added when it has none. The description is written as a folded block, which holds any words
/// without quoting and which `frontmatter_field` reads back as one line.
pub(crate) fn compose(
    frontmatter: &str,
    name: &str,
    description: Option<&str>,
    instructions: &str,
) -> String {
    let mut rest = String::new();
    let mut named = false;
    let mut described = description.is_none();
    for block in blocks(frontmatter) {
        match key_of(&block) {
            Some("description") if description.is_some() => {
                if !described {
                    rest.push_str(&description_block(description.unwrap_or_default()));
                    described = true;
                }
            }
            Some("name") => {
                named = true;
                rest.push_str(&block);
            }
            _ => rest.push_str(&block),
        }
    }
    let mut text = String::from("---\n");
    if !named {
        text.push_str(&name_line(name));
    }
    if !described {
        text.push_str(&description_block(description.unwrap_or_default()));
    }
    text.push_str(&rest);
    text.push_str("---\n\n");
    text.push_str(instructions.trim_end());
    text.push('\n');
    text
}

/// Frontmatter as its top-level keys, each with the lines under it, every one ending its line.
fn blocks(frontmatter: &str) -> Vec<String> {
    let mut blocks: Vec<String> = Vec::new();
    for line in frontmatter.split_inclusive('\n') {
        let starts = !line.trim().is_empty() && !line.starts_with([' ', '\t']);
        match blocks.last_mut() {
            Some(block) if !starts => block.push_str(line),
            _ => blocks.push(line.to_owned()),
        }
    }
    for block in &mut blocks {
        if !block.ends_with('\n') {
            block.push('\n');
        }
    }
    blocks
}

/// The key a block's first line names, as `frontmatter_field` reads it.
fn key_of(block: &str) -> Option<&str> {
    let first = block.lines().next()?;
    if first.starts_with([' ', '\t']) {
        return None;
    }
    first.split_once(':').map(|(key, _)| key.trim())
}

fn description_block(description: &str) -> String {
    format!("description: >-\n  {description}\n")
}

/// `name: weekly-update`, quoted where YAML would read the bare word as something else.
fn name_line(name: &str) -> String {
    const NOT_WORDS: [&str; 11] = [
        "true", "false", "yes", "no", "on", "off", "null", "y", "n", "~", "",
    ];
    let bare = skill_name(name) == name
        && !NOT_WORDS.contains(&name)
        && !name.chars().all(|c| c.is_ascii_digit() || c == '-');
    if bare {
        format!("name: {name}\n")
    } else {
        format!(
            "name: {}\n",
            serde_json::to_string(name).unwrap_or_else(|_| format!("\"{name}\""))
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{Scratch, skill, write};
    use super::*;

    fn store() -> (Scratch, SkillsStore) {
        let scratch = Scratch::new("written");
        let store = SkillsStore::new(scratch.path());
        (scratch, store)
    }

    fn new_skill(name: &str, description: &str, instructions: &str) -> WriteSkill {
        WriteSkill {
            name: name.to_owned(),
            description: description.to_owned(),
            instructions: instructions.to_owned(),
            base: None,
            suggested_by: None,
        }
    }

    /// The cases the app's `skillName` reads too.
    #[test]
    fn a_new_skill_is_named_as_the_app_names_it() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../../schemas/skill-name.cases.json"))
                .expect("the cases are JSON");
        let cases = cases["cases"].as_array().expect("a list of cases");
        assert!(cases.len() >= 10, "{cases:?}");
        for case in cases {
            let title = case["title"].as_str().expect("a title");
            let name = case["name"].as_str().expect("a name");
            assert_eq!(skill_name(title), name, "{title:?}");
            if !name.is_empty() {
                assert!(is_new_name(name), "{name:?} is a name a new skill can have");
            }
        }
        assert!(!is_new_name("Weekly update"), "a title is not a name");
        assert!(!is_new_name("-weekly"));
        assert!(!is_new_name(""));
    }

    #[test]
    fn a_written_skill_reads_back_as_written_and_lists_as_yours() {
        let (_scratch, store) = store();
        let written = store
            .write(&new_skill(
                "weekly-client-update",
                "  Writes the weekly update for a client:\n three bullets, # not a comment  ",
                "\n\n1. Read this week's notes.\n2. Write three bullets.\n\n",
            ))
            .expect("written");
        assert_eq!(written.skill.origin.kind, OriginKind::Written);
        assert!(written.previous.is_none());
        let text = fs::read_to_string(store.folder().join("weekly-client-update/SKILL.md"))
            .expect("its SKILL.md");
        assert_eq!(
            text,
            "---\nname: weekly-client-update\ndescription: >-\n  Writes the weekly update for a \
             client: three bullets, # not a comment\n---\n\n1. Read this week's notes.\n2. Write \
             three bullets.\n"
        );
        // What agents are shown of it: its description, read back as one line, colon and all.
        assert_eq!(
            crate::skill_routing::description(&text).as_deref(),
            Some("Writes the weekly update for a client: three bullets, # not a comment")
        );
        let words = store.words("weekly-client-update").expect("its words");
        assert_eq!(words.base, written.base);
        assert_eq!(
            words.instructions,
            "1. Read this week's notes.\n2. Write three bullets."
        );
        let listed = store.list().expect("the list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].origin.kind, OriginKind::Written);
        assert_eq!(
            listed[0].description,
            "Writes the weekly update for a client: three bullets, # not a comment"
        );
        assert!(!store.staging().exists() || fs::read_dir(store.staging()).unwrap().count() == 0);
    }

    #[test]
    fn a_new_skill_needs_its_words_and_a_name_of_its_own() {
        let (_scratch, store) = store();
        skill(&store.folder().join("Weekly"), "Weekly", "");
        for (write, kind, says) in [
            (
                new_skill("weekly", "Writes it.", "Do it."),
                "conflict",
                "already have",
            ),
            (
                new_skill("Weekly Update", "Writes it.", "Do it."),
                "invalid",
                "a name",
            ),
            (
                new_skill("weekly-update", "  \n ", "Do it."),
                "invalid",
                "when",
            ),
            (
                new_skill("weekly-update", "Writes it.", " \n "),
                "invalid",
                "what",
            ),
            (
                new_skill("weekly-update", &"word ".repeat(300), "Do it."),
                "invalid",
                "1024",
            ),
        ] {
            let error = store.write(&write).expect_err("refused");
            let found = match &error {
                SkillsError::Conflict(_) => "conflict",
                SkillsError::Invalid(_) => "invalid",
                _ => "other",
            };
            assert_eq!(found, kind, "{error:?}");
            assert!(error.message().contains(says), "{error:?}");
        }
        assert!(!store.folder().join("weekly-update").exists());
    }

    #[test]
    fn a_change_keeps_every_other_line_and_file_and_the_old_words() {
        let (_scratch, store) = store();
        let folder = store.folder().join("pdf");
        write(
            &folder.join(SKILL_FILE),
            "---\nname: pdf\ndescription: >-\n  Fills in PDF forms.\n  Use for any PDF.\nlicense: MIT\nmetadata:\n  version: \"2\"\n---\n\n# PDF\n\nRun scripts/fill.py.\n",
        );
        write(&folder.join("scripts/fill.py"), "print('fill')\n");
        let words = store.words("pdf").expect("its words");
        assert_eq!(words.description, "Fills in PDF forms. Use for any PDF.");
        assert_eq!(words.instructions, "# PDF\n\nRun scripts/fill.py.");
        assert_eq!(words.files, vec!["scripts/fill.py".to_owned()]);

        let written = store
            .write(&WriteSkill {
                name: "pdf".to_owned(),
                description: "Fills in PDF forms and checks them.".to_owned(),
                instructions: "# PDF\n\nRun scripts/fill.py, then check every field.".to_owned(),
                base: Some(words.base.clone()),
                suggested_by: None,
            })
            .expect("changed");
        let text = fs::read_to_string(folder.join(SKILL_FILE)).expect("its SKILL.md");
        assert_eq!(
            text,
            "---\nname: pdf\ndescription: >-\n  Fills in PDF forms and checks them.\nlicense: MIT\nmetadata:\n  version: \"2\"\n---\n\n# PDF\n\nRun scripts/fill.py, then check every field.\n"
        );
        assert_eq!(
            fs::read_to_string(folder.join("scripts/fill.py")).expect("kept"),
            "print('fill')\n"
        );
        let previous = written.previous.expect("the old words, for Undo");
        assert_eq!(previous.description, words.description);
        assert_eq!(previous.instructions, words.instructions);
        assert!(written.skill.changed_at.is_some());
        assert_eq!(written.skill.origin.kind, OriginKind::Found);
        assert_eq!(written.skill.license.id.as_deref(), Some("MIT"));

        // The old SKILL.md is kept, not deleted.
        let removed = fs::read_dir(store.folder().join(".removed"))
            .expect("the removed folder")
            .map(|entry| entry.expect("an entry").path())
            .collect::<Vec<_>>();
        assert_eq!(removed.len(), 1);
        assert!(
            fs::read_to_string(removed[0].join(SKILL_FILE))
                .expect("the old SKILL.md")
                .contains("Use for any PDF.")
        );

        // Undo is the same save with the old words, from the new base.
        let undone = store
            .write(&WriteSkill {
                name: "pdf".to_owned(),
                description: previous.description,
                instructions: previous.instructions,
                base: Some(written.base),
                suggested_by: None,
            })
            .expect("undone");
        let back = store.words("pdf").expect("its words");
        assert_eq!(back.description, "Fills in PDF forms. Use for any PDF.");
        assert_eq!(back.instructions, "# PDF\n\nRun scripts/fill.py.");
        assert_eq!(undone.base, back.base);
    }

    #[test]
    fn an_unchanged_description_keeps_its_own_lines() {
        let (_scratch, store) = store();
        let folder = store.folder().join("notes");
        write(
            &folder.join(SKILL_FILE),
            "---\ndescription: \"Use when: notes\"\n---\nOld body\n",
        );
        let words = store.words("notes").expect("its words");
        assert_eq!(words.description, "Use when: notes");
        store
            .write(&WriteSkill {
                name: "notes".to_owned(),
                description: words.description,
                instructions: "New body".to_owned(),
                base: Some(words.base),
                suggested_by: None,
            })
            .expect("changed");
        assert_eq!(
            fs::read_to_string(folder.join(SKILL_FILE)).expect("its SKILL.md"),
            "---\nname: notes\ndescription: \"Use when: notes\"\n---\n\nNew body\n"
        );
    }

    #[test]
    fn a_change_from_an_old_copy_or_through_a_link_is_refused() {
        let (_scratch, store) = store();
        let folder = store.folder().join("pdf");
        skill(&folder, "pdf", "");
        let words = store.words("pdf").expect("its words");
        // Changed by hand after the sheet read it.
        skill(&folder, "pdf", "license: MIT\n");
        let error = store
            .write(&WriteSkill {
                name: "pdf".to_owned(),
                description: "Mine.".to_owned(),
                instructions: "Mine.".to_owned(),
                base: Some(words.base),
                suggested_by: None,
            })
            .expect_err("refused");
        assert!(matches!(error, SkillsError::Conflict(_)), "{error:?}");
        assert!(
            fs::read_to_string(folder.join(SKILL_FILE))
                .expect("its SKILL.md")
                .contains("license: MIT"),
            "the change by hand stays"
        );
        // Another spelling of its name isn't it.
        assert!(matches!(store.words("PDF"), Err(SkillsError::NotFound(_))));

        #[cfg(unix)]
        {
            let outside = Scratch::new("outside");
            write(
                &outside.path().join("target.md"),
                "---\nname: x\n---\nkeep\n",
            );
            let linked = store.folder().join("linked");
            fs::create_dir_all(&linked).expect("folder");
            std::os::unix::fs::symlink(outside.path().join("target.md"), linked.join(SKILL_FILE))
                .expect("link");
            let error = store.words("linked").expect_err("refused");
            assert!(matches!(error, SkillsError::Refused(_)), "{error:?}");
            assert_eq!(
                fs::read_to_string(outside.path().join("target.md")).expect("untouched"),
                "---\nname: x\n---\nkeep\n"
            );
        }
    }

    #[test]
    fn a_suggested_skill_says_which_agent_suggested_it() {
        let (_scratch, store) = store();
        let mut write = new_skill("tidy-notes", "Tidies meeting notes.", "Tidy them.");
        write.suggested_by = Some("  Mai \n".to_owned());
        let written = store.write(&write).expect("written");
        assert_eq!(written.skill.origin.suggested_by.as_deref(), Some("Mai"));
        assert_eq!(
            store.list().expect("the list")[0]
                .origin
                .suggested_by
                .as_deref(),
            Some("Mai")
        );
    }

    #[test]
    fn a_name_yaml_would_misread_is_quoted() {
        assert_eq!(name_line("weekly"), "name: weekly\n");
        assert_eq!(name_line("2026"), "name: \"2026\"\n");
        assert_eq!(name_line("yes"), "name: \"yes\"\n");
        assert_eq!(name_line("My notes"), "name: \"My notes\"\n");
        let text = compose("", "2026", Some("A year."), "Body");
        let (frontmatter, _) = split_frontmatter(&text);
        assert_eq!(
            frontmatter_field(frontmatter, "name").as_deref(),
            Some("2026")
        );
    }
}

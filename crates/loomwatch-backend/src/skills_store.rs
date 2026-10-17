//! `LoomWatch`'s own skills folder, and bringing skills in from the apps on this computer.
//!
//! `LoomWatch` keeps the skills its agents can use in one folder of its own,
//! `<state dir>/skills/<name>/`, and records where each one came from in `<state dir>/skills.json`:
//! brought in from an app, installed from GitHub, skills.sh or `ClawHub` (`marketplace.rs`), or put
//! in the folder by hand. Removing a skill moves its folder to `skills/.removed/`, so nothing is
//! deleted outright.
//!
//! "Bring in skills from your apps" looks through the skill folders the agent apps on this
//! computer keep (`~/.claude/skills`, `~/.codex/skills`, …) and copies the ones the person ticks.
//! It reads skill folders only: never an app's settings, sign-in, sessions or Keychain items.
//! Nothing a skill contains is ever run, and nothing here happens at startup: every function
//! answers a request.
//!
//! A skill whose license says "All rights reserved" or "proprietary" is restricted: it is never
//! copied in, whichever way it arrives.

use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MANIFEST_FILE: &str = "skills.json";
const SKILLS_FOLDER: &str = "skills";
const REMOVED_FOLDER: &str = ".removed";
/// Downloads are unpacked, and copies made, here before they move into place.
pub(crate) const STAGING_FOLDER: &str = ".staging";
pub(crate) const SKILL_FILE: &str = "SKILL.md";
/// How much of a `SKILL.md` is read for its name, description, license and needs.
const MAX_SKILL_TEXT: u64 = 1024 * 1024;
const MAX_LICENSE_TEXT: u64 = 64 * 1024;
const MB: u64 = 1024 * 1024;

/// Folders a search for skills never enters. Copied from `capabilities.rs`: a dependency tree or a
/// build output is not where skills are kept, and the dot folders are other tools' trash and
/// half-finished copies.
pub(crate) const SKIP_DIRECTORIES: [&str; 7] = [
    "node_modules",
    ".git",
    "dist",
    "target",
    ".trash",
    ".staging",
    ".tmp",
];

/// Folders never copied along with a skill: a repository's history and installed packages are
/// not part of it, and they are often bigger than the skill itself.
pub(crate) const LEFT_BEHIND: [&str; 2] = [".git", "node_modules"];

/// How big a skill, and a download, may be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The most one skill may hold, in bytes.
    pub skill_bytes: u64,
    /// The most files one skill may hold.
    pub skill_files: usize,
    /// The largest download `marketplace.rs` accepts.
    pub download_bytes: u64,
    /// The most a download may unpack to on disk. Its compressed stream is read up to five times
    /// this, so an archive that inflates without end is stopped.
    pub unpacked_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            skill_bytes: 20 * MB,
            skill_files: 2_000,
            download_bytes: 50 * MB,
            unpacked_bytes: 200 * MB,
        }
    }
}

impl Limits {
    /// Why a skill of this size can't come in, in words for the person.
    pub(crate) fn too_big(&self) -> String {
        format!(
            "It’s bigger than LoomWatch takes for one skill ({} or {} files).",
            describe_size(self.skill_bytes),
            self.skill_files
        )
    }
}

/// `20 MB`, or the bytes when it is less than one.
pub(crate) fn describe_size(bytes: u64) -> String {
    if bytes >= MB {
        format!("{} MB", bytes / MB)
    } else {
        format!("{bytes} bytes")
    }
}

/// Why a skill request failed, in words for the person using the Skills page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillsError {
    /// What the request named isn't there.
    NotFound(String),
    /// A skill with that name is already in `LoomWatch`.
    Conflict(String),
    /// The request can't be used as sent: a link, a name, an expired preview.
    Invalid(String),
    /// `LoomWatch` won't take this skill: its license, its size, or a download that isn't safe.
    Refused(String),
    /// GitHub, skills.sh or `ClawHub` couldn't be reached, or answered something unusable.
    Upstream(String),
    /// Reading or writing `LoomWatch`'s own folder failed.
    Io(String),
}

impl SkillsError {
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::NotFound(message)
            | Self::Conflict(message)
            | Self::Invalid(message)
            | Self::Refused(message)
            | Self::Upstream(message)
            | Self::Io(message) => message,
        }
    }
}

impl fmt::Display for SkillsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for SkillsError {}

impl From<io::Error> for SkillsError {
    fn from(error: io::Error) -> Self {
        Self::Io(format!(
            "LoomWatch couldn’t update its skills folder: {error}"
        ))
    }
}

/// How a skill reached `LoomWatch`'s folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginKind {
    /// Copied from an app's skill folder by "Bring in skills from your apps".
    BroughtIn,
    /// Installed from GitHub, skills.sh or `ClawHub`.
    Installed,
    /// Put in the folder by hand: `LoomWatch` has no record of it.
    Found,
}

/// Where one skill came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub kind: OriginKind,
    /// The app whose folder it was brought in from, as people know it ("Claude Code").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// The folder it was copied from: on this computer when brought in, inside the repository or
    /// download when installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// `github`, `skills.sh` or `clawhub`, for an installed skill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// What was asked for: `owner/repo[/path]@ref`, a skills.sh id or a `ClawHub` `owner/slug`.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// The commit the files came from, when the source said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// A page about it the person can open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Origin {
    #[must_use]
    pub fn new(kind: OriginKind) -> Self {
        Self {
            kind,
            app: None,
            source_path: None,
            source: None,
            reference: None,
            commit: None,
            url: None,
        }
    }
}

/// What a skill's license says, as far as `LoomWatch` can tell.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    /// A short name: `MIT`, `Apache-2.0`, `All rights reserved`. Absent when none is given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The license says "All rights reserved" or "proprietary", so the skill is never copied.
    pub restricted: bool,
}

/// One skill in `LoomWatch`'s folder, as `skills.json` records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    /// Its folder's name under `skills/`.
    pub name: String,
    pub description: String,
    pub origin: Origin,
    pub license: LicenseInfo,
    /// What its instructions assume (`skill_routing::analyse`), in the Library's words.
    pub needs: Vec<String>,
    /// `node` and `python`, when it bundles scripts for them.
    pub runtimes: Vec<String>,
    pub has_scripts: bool,
    pub size_bytes: u64,
    /// Over every file's path and contents, so a changed copy can be told apart.
    pub sha256: String,
    pub added_at: DateTime<Utc>,
    /// The bring-in it arrived with, which Undo takes back as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    skills: Vec<SkillRecord>,
}

/// Whether `name` can be a skill's folder name. Copied from `workspace.rs` `copy_skill`, plus the
/// characters Windows refuses in a file name and anything that isn't printable.
#[must_use]
pub fn usable_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.trim() == name
        && !name.contains(['/', '\\', '\0', '<', '>', ':', '"', '|', '?', '*'])
        && !name.chars().any(char::is_control)
        && name.len() <= 128
}

/// A skill to copy into the folder.
#[derive(Debug, Clone)]
pub(crate) struct NewSkill<'a> {
    /// The skill's folder, the one holding its `SKILL.md`.
    pub source: &'a Path,
    pub name: &'a str,
    pub origin: Origin,
    pub batch_id: Option<String>,
    /// Put it in place of a skill with the same name, which moves to `.removed/`.
    pub replace: bool,
    /// Where to look for a license when the skill has none of its own: the plugin or repository
    /// it came in.
    pub inherit_license: Option<&'a Path>,
}

/// `LoomWatch`'s skills folder and its manifest.
#[derive(Debug)]
pub struct SkillsStore {
    state_dir: PathBuf,
    limits: Limits,
    /// One change to the folder and manifest at a time.
    gate: Mutex<()>,
}

impl SkillsStore {
    #[must_use]
    pub fn new(state_dir: impl Into<PathBuf>) -> Self {
        Self::with_limits(state_dir, Limits::default())
    }

    #[must_use]
    pub fn with_limits(state_dir: impl Into<PathBuf>, limits: Limits) -> Self {
        Self {
            state_dir: state_dir.into(),
            limits,
            gate: Mutex::new(()),
        }
    }

    /// `<state dir>/skills`, where every skill's folder is.
    #[must_use]
    pub fn folder(&self) -> PathBuf {
        self.state_dir.join(SKILLS_FOLDER)
    }

    #[must_use]
    pub fn limits(&self) -> Limits {
        self.limits
    }

    pub(crate) fn staging(&self) -> PathBuf {
        self.folder().join(STAGING_FOLDER)
    }

    fn manifest_path(&self) -> PathBuf {
        self.state_dir.join(MANIFEST_FILE)
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.gate.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every skill in the folder, by name: the ones `skills.json` records, then any folder with a
    /// `SKILL.md` put there by hand. A record whose folder is gone is left out.
    ///
    /// # Errors
    /// When the folder can't be read.
    pub fn list(&self) -> Result<Vec<SkillRecord>, SkillsError> {
        let _gate = self.lock();
        let manifest = self.load();
        let folder = self.folder();
        let mut recorded = BTreeSet::new();
        let mut skills = Vec::new();
        for record in manifest.skills {
            if is_skill_folder(&folder.join(&record.name)) {
                recorded.insert(record.name.to_lowercase());
                skills.push(record);
            }
        }
        for name in folder_names(&folder)? {
            if recorded.contains(&name.to_lowercase()) {
                continue;
            }
            let directory = folder.join(&name);
            if !is_skill_folder(&directory) {
                continue;
            }
            let facts = read_folder(&directory, &name, None, &self.limits)?;
            let added_at = fs::metadata(&directory)
                .and_then(|metadata| metadata.modified())
                .map_or_else(|_| Utc::now(), DateTime::<Utc>::from);
            skills.push(SkillRecord {
                name,
                description: facts.description,
                origin: Origin::new(OriginKind::Found),
                license: facts.license,
                needs: facts.needs,
                runtimes: facts.runtimes,
                has_scripts: facts.has_scripts,
                size_bytes: facts.size_bytes,
                sha256: String::new(),
                added_at,
                batch_id: None,
            });
        }
        skills.sort_by_key(|record| record.name.to_lowercase());
        Ok(skills)
    }

    /// The names already in the folder, lowercased: two names that differ only in case are one
    /// folder on a Mac.
    ///
    /// # Errors
    /// When the folder can't be read.
    pub fn names(&self) -> Result<BTreeSet<String>, SkillsError> {
        let _gate = self.lock();
        Ok(folder_names(&self.folder())?
            .into_iter()
            .map(|name| name.to_lowercase())
            .collect())
    }

    /// Copy one skill into the folder and record it.
    ///
    /// The copy is made beside the folder first and moved into place whole, so a copy that fails
    /// halfway leaves nothing behind. Links inside the skill are not copied.
    pub(crate) fn add(&self, new: &NewSkill<'_>) -> Result<SkillRecord, SkillsError> {
        if !usable_name(new.name) {
            return Err(SkillsError::Invalid(format!(
                "“{}” can’t be used as a skill’s folder name.",
                new.name
            )));
        }
        if !new.source.join(SKILL_FILE).is_file() {
            return Err(SkillsError::Invalid(format!(
                "{} has no SKILL.md, so it isn’t a skill.",
                new.source.display()
            )));
        }
        let _gate = self.lock();
        let folder = self.folder();
        fs::create_dir_all(&folder)?;
        // Two names that differ only in case are one folder on a Mac.
        let wanted = new.name.to_lowercase();
        let existing = folder_names(&folder)?
            .into_iter()
            .find(|name| name.to_lowercase() == wanted);
        if existing.is_some() && !new.replace {
            return Err(SkillsError::Conflict(format!(
                "A skill named “{}” is already in LoomWatch.",
                new.name
            )));
        }
        let staging = folder.join(STAGING_FOLDER);
        fs::create_dir_all(&staging)?;
        let copy = staging.join(format!("copy-{}", uuid::Uuid::new_v4().simple()));
        let result = self.place(new, &folder, &copy, existing.as_deref());
        if result.is_err() {
            let _ = fs::remove_dir_all(&copy);
        }
        result
    }

    fn place(
        &self,
        new: &NewSkill<'_>,
        folder: &Path,
        copy: &Path,
        existing: Option<&str>,
    ) -> Result<SkillRecord, SkillsError> {
        copy_limited(new.source, copy, &self.limits)?;
        let facts = read_folder(copy, new.name, new.inherit_license, &self.limits)?;
        if facts.license.restricted {
            return Err(SkillsError::Refused(restricted_reason(new.name)));
        }
        if facts.too_big {
            return Err(SkillsError::Refused(self.limits.too_big()));
        }
        let sha256 = hash_folder(copy)?;
        let mut manifest = self.load();
        if let Some(existing) = existing {
            move_to_removed(folder, existing)?;
            manifest
                .skills
                .retain(|record| record.name.to_lowercase() != existing.to_lowercase());
        }
        fs::rename(copy, folder.join(new.name))?;
        let record = SkillRecord {
            name: new.name.to_owned(),
            description: facts.description,
            origin: new.origin.clone(),
            license: facts.license,
            needs: facts.needs,
            runtimes: facts.runtimes,
            has_scripts: facts.has_scripts,
            size_bytes: facts.size_bytes,
            sha256,
            added_at: Utc::now(),
            batch_id: new.batch_id.clone(),
        };
        manifest.skills.retain(|kept| kept.name != record.name);
        manifest.skills.push(record.clone());
        self.save(&mut manifest)?;
        Ok(record)
    }

    /// Move one skill to `skills/.removed/` and drop its record.
    ///
    /// # Errors
    /// When there is no skill by that name, or it can't be moved.
    pub fn remove(&self, name: &str) -> Result<String, SkillsError> {
        let missing =
            || SkillsError::NotFound(format!("There’s no skill named “{name}” in LoomWatch."));
        if !usable_name(name) {
            return Err(missing());
        }
        let _gate = self.lock();
        let folder = self.folder();
        let real_folder =
            fs::symlink_metadata(folder.join(name)).is_ok_and(|metadata| metadata.is_dir());
        if !real_folder {
            return Err(missing());
        }
        move_to_removed(&folder, name)?;
        let mut manifest = self.load();
        let before = manifest.skills.len();
        manifest.skills.retain(|record| record.name != name);
        if manifest.skills.len() != before {
            self.save(&mut manifest)?;
        }
        Ok(name.to_owned())
    }

    /// Take back one bring-in: every skill it brought moves to `skills/.removed/`.
    ///
    /// # Errors
    /// When nothing came in with that batch, or a folder can't be moved.
    pub fn undo(&self, batch_id: &str) -> Result<Vec<String>, SkillsError> {
        let nothing = || {
            SkillsError::NotFound(
                "There’s nothing to undo: those skills were already removed.".to_owned(),
            )
        };
        let plain = !batch_id.is_empty()
            && batch_id.len() <= 64
            && batch_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !plain {
            return Err(nothing());
        }
        let _gate = self.lock();
        let folder = self.folder();
        let mut manifest = self.load();
        let names = manifest
            .skills
            .iter()
            .filter(|record| record.batch_id.as_deref() == Some(batch_id))
            .map(|record| record.name.clone())
            .collect::<Vec<_>>();
        if names.is_empty() {
            return Err(nothing());
        }
        for name in &names {
            if fs::symlink_metadata(folder.join(name)).is_ok_and(|metadata| metadata.is_dir()) {
                move_to_removed(&folder, name)?;
            }
        }
        manifest
            .skills
            .retain(|record| record.batch_id.as_deref() != Some(batch_id));
        self.save(&mut manifest)?;
        Ok(names)
    }

    /// The manifest, or an empty one. A manifest that can't be read is moved aside rather than
    /// written over, and its skills' folders, which are still there, list as found.
    fn load(&self) -> Manifest {
        let path = self.manifest_path();
        let Ok(bytes) = fs::read(&path) else {
            return Manifest::default();
        };
        serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            let aside = path.with_extension(format!("json.unreadable-{}", stamp()));
            eprintln!(
                "warning: {} can’t be read ({error}); moved it to {}",
                path.display(),
                aside.display()
            );
            let _ = fs::rename(&path, &aside);
            Manifest::default()
        })
    }

    /// Written the way approved teams are: owner-only, to a `.partial` file first, then renamed.
    fn save(&self, manifest: &mut Manifest) -> Result<(), SkillsError> {
        manifest.version = 1;
        manifest
            .skills
            .sort_by_key(|record| record.name.to_lowercase());
        let text = serde_json::to_vec_pretty(manifest).map_err(|error| {
            SkillsError::Io(format!("LoomWatch couldn’t save skills.json: {error}"))
        })?;
        crate::approvals::write_private(&self.manifest_path(), &text)?;
        Ok(())
    }
}

fn is_skill_folder(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
        && path.join(SKILL_FILE).is_file()
}

/// The plain folders in `folder`, without the dot folders `LoomWatch` keeps there itself.
fn folder_names(folder: &Path) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str()
            && !name.starts_with('.')
        {
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

/// `20261017T084512.123Z`: a time that sorts, and is a valid file name everywhere.
fn stamp() -> String {
    Utc::now().format("%Y%m%dT%H%M%S%.3fZ").to_string()
}

/// Move `folder/name` to `folder/.removed/<name>-<time>/`.
fn move_to_removed(folder: &Path, name: &str) -> io::Result<()> {
    let removed = folder.join(REMOVED_FOLDER);
    fs::create_dir_all(&removed)?;
    let base = format!("{name}-{}", stamp());
    let mut target = removed.join(&base);
    let mut extra = 1;
    while target.exists() {
        extra += 1;
        target = removed.join(format!("{base}-{extra}"));
    }
    fs::rename(folder.join(name), target)
}

/// Copy a skill's folder, leaving out links, `.git` and `node_modules`, and stop once it is
/// bigger than `limits` allows.
pub(crate) fn copy_limited(from: &Path, to: &Path, limits: &Limits) -> Result<(), SkillsError> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    copy_into(from, to, limits, &mut files, &mut bytes)
}

fn copy_into(
    from: &Path,
    to: &Path,
    limits: &Limits,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<(), SkillsError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        // `file_type` doesn't follow links, so a link is neither a folder nor a file here: it is
        // skipped, because following it would copy whatever it points at, from anywhere.
        let kind = entry.file_type()?;
        let name = entry.file_name();
        let target = to.join(&name);
        if kind.is_dir() {
            if LEFT_BEHIND.iter().any(|skip| name == *skip) {
                continue;
            }
            copy_into(&entry.path(), &target, limits, files, bytes)?;
        } else if kind.is_file() {
            *files += 1;
            *bytes += entry.metadata()?.len();
            if *files > limits.skill_files || *bytes > limits.skill_bytes {
                return Err(SkillsError::Refused(limits.too_big()));
            }
            fs::copy(entry.path(), &target)?;
            plain_permissions(&target)?;
        }
    }
    Ok(())
}

/// Read and write for the owner, and executable when it was: never setuid, never writable by
/// others.
#[cfg(unix)]
pub(crate) fn plain_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)?.permissions().mode();
    let plain = if mode & 0o111 == 0 { 0o644 } else { 0o755 };
    fs::set_permissions(path, fs::Permissions::from_mode(plain))
}

#[cfg(not(unix))]
pub(crate) fn plain_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// A hash over every file's path and contents, in path order, so the same skill always hashes
/// the same wherever it is copied.
fn hash_folder(folder: &Path) -> io::Result<String> {
    let mut files = Vec::new();
    list_files(folder, "", &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for relative in files {
        let mut file = fs::File::open(folder.join(&relative))?;
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(file.metadata()?.len().to_le_bytes());
        io::copy(&mut file, &mut hasher)?;
    }
    Ok(hex(&hasher.finalize()))
}

fn list_files(folder: &Path, prefix: &str, files: &mut Vec<String>) -> io::Result<()> {
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if kind.is_dir() {
            list_files(&entry.path(), &relative, files)?;
        } else if kind.is_file() {
            files.push(relative);
        }
    }
    Ok(())
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

pub(crate) fn restricted_reason(name: &str) -> String {
    format!("“{name}”’s license says “All rights reserved”, so it can’t be copied into LoomWatch.")
}

/// What a skill's `SKILL.md` says about it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SkillText {
    pub name: Option<String>,
    pub description: String,
    pub license: Option<String>,
    pub needs: Vec<String>,
}

pub(crate) fn read_skill_text(text: &str) -> SkillText {
    let (frontmatter, _) = crate::skill_routing::split_frontmatter(text);
    let field = |key| crate::skill_routing::frontmatter_field(frontmatter, key);
    SkillText {
        name: field("name"),
        description: field("description").unwrap_or_default(),
        license: field("license"),
        needs: crate::skill_routing::analyse(text)
            .needs
            .into_iter()
            .map(|need| need.label().to_owned())
            .collect(),
    }
}

/// The folder name a skill gets: its own `name:` when that can be a folder name, otherwise the
/// name of the folder it came in.
pub(crate) fn choose_name(declared: Option<&str>, fallback: &str) -> String {
    declared
        .map(str::trim)
        .filter(|name| usable_name(name))
        .unwrap_or(fallback)
        .to_owned()
}

/// Everything the Skills page shows about one skill folder before it comes in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillFacts {
    pub name: String,
    pub description: String,
    pub license: LicenseInfo,
    pub needs: Vec<String>,
    pub runtimes: Vec<String>,
    pub has_scripts: bool,
    pub size_bytes: u64,
    pub file_count: usize,
    /// Its files, by path inside the folder; cut short once it is too big.
    pub files: Vec<String>,
    pub too_big: bool,
}

impl SkillFacts {
    /// Why this skill can't come into `LoomWatch`, in words for the person; `None` when it can.
    pub fn refusal(&self, limits: &Limits) -> Option<String> {
        if self.license.restricted {
            Some(restricted_reason(&self.name))
        } else if self.too_big {
            Some(limits.too_big())
        } else if !usable_name(&self.name) {
            Some(format!(
                "“{}” can’t be used as a folder name, so LoomWatch can’t keep this skill.",
                self.name
            ))
        } else {
            None
        }
    }
}

/// Read one skill folder: its `SKILL.md`, its license, its files and whether any are scripts.
/// Links are not followed, `.git` and `node_modules` are not counted, and nothing is run.
pub(crate) fn read_folder(
    folder: &Path,
    fallback: &str,
    inherit_license: Option<&Path>,
    limits: &Limits,
) -> io::Result<SkillFacts> {
    let text = read_capped(&folder.join(SKILL_FILE), MAX_SKILL_TEXT).unwrap_or_default();
    let skill = read_skill_text(&text);
    let mut walk = Walk::default();
    walk_folder(folder, "", limits, &mut walk)?;
    let license = license_of(folder, skill.license.as_deref(), inherit_license);
    Ok(SkillFacts {
        name: choose_name(skill.name.as_deref(), fallback),
        description: skill.description,
        license,
        needs: skill.needs,
        runtimes: walk
            .runtimes
            .iter()
            .map(|runtime| (*runtime).to_owned())
            .collect(),
        has_scripts: walk.scripts,
        size_bytes: walk.bytes,
        file_count: walk.count,
        files: walk.files,
        too_big: walk.too_big,
    })
}

#[derive(Debug, Default)]
struct Walk {
    files: Vec<String>,
    bytes: u64,
    count: usize,
    too_big: bool,
    scripts: bool,
    /// `node`, `python`: sorted, so they read the same every time.
    runtimes: BTreeSet<&'static str>,
}

/// Script files a skill bundles, by extension, and the runtime each needs when it isn't the
/// shell every computer has.
const SCRIPT_EXTENSIONS: [(&str, Option<&str>); 15] = [
    ("py", Some("python")),
    ("js", Some("node")),
    ("mjs", Some("node")),
    ("cjs", Some("node")),
    ("ts", Some("node")),
    ("mts", Some("node")),
    ("cts", Some("node")),
    ("sh", None),
    ("bash", None),
    ("zsh", None),
    ("rb", None),
    ("pl", None),
    ("ps1", None),
    ("bat", None),
    ("cmd", None),
];

fn walk_folder(folder: &Path, prefix: &str, limits: &Limits, walk: &mut Walk) -> io::Result<()> {
    let mut entries = fs::read_dir(folder)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        if walk.too_big {
            return Ok(());
        }
        let kind = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if kind.is_dir() {
            if !LEFT_BEHIND.contains(&name.as_str()) {
                walk_folder(&entry.path(), &relative, limits, walk)?;
            }
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        walk.count += 1;
        walk.bytes += entry.metadata()?.len();
        if walk.count > limits.skill_files || walk.bytes > limits.skill_bytes {
            walk.too_big = true;
            return Ok(());
        }
        note_script(&entry.path(), &name, walk);
        walk.files.push(relative);
    }
    Ok(())
}

fn note_script(path: &Path, name: &str, walk: &mut Walk) {
    let extension = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if let Some((_, runtime)) = SCRIPT_EXTENSIONS
        .iter()
        .find(|(known, _)| extension.as_deref() == Some(*known))
    {
        walk.scripts = true;
        walk.runtimes.extend(*runtime);
        return;
    }
    // A script without an extension says what runs it on its first line.
    let mut head = [0u8; 128];
    let read = fs::File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .unwrap_or(0);
    if head[..read].starts_with(b"#!") {
        walk.scripts = true;
        let line = String::from_utf8_lossy(&head[..read]);
        let line = line.lines().next().unwrap_or_default();
        if line.contains("python") {
            walk.runtimes.insert("python");
        } else if line.contains("node") || line.contains("deno") || line.contains("bun") {
            walk.runtimes.insert("node");
        }
    }
}

fn read_capped(path: &Path, limit: u64) -> io::Result<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(limit).read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Words that make a license restricted.
const RESTRICTING: [(&str, &str); 2] = [
    ("all rights reserved", "All rights reserved"),
    ("proprietary", "Proprietary"),
];

/// Words that only a license granting use carries, by the name it is known as. A BSD license
/// says "All rights reserved" too, before it grants every right that matters.
const OPEN_LICENSES: [(&str, &str); 12] = [
    ("gnu affero general public license", "AGPL"),
    ("gnu lesser general public license", "LGPL"),
    ("gnu general public license", "GPL"),
    ("apache license", "Apache-2.0"),
    ("mozilla public license", "MPL-2.0"),
    ("mit license", "MIT"),
    ("permission is hereby granted, free of charge", "MIT"),
    ("redistribution and use in source and binary forms", "BSD"),
    ("isc license", "ISC"),
    ("this is free and unencumbered software", "Unlicense"),
    ("boost software license", "BSL-1.0"),
    ("creative commons", "Creative Commons"),
];

/// A skill's license, from its `license:` line and the license file beside it. Either one saying
/// "All rights reserved" or "proprietary" restricts it, unless the file is an open license that
/// happens to use the words. With neither, the license of the plugin or repository it came in
/// counts.
pub(crate) fn license_of(
    folder: &Path,
    field: Option<&str>,
    inherit: Option<&Path>,
) -> LicenseInfo {
    let declared = field.map(judge_license_field);
    let file = license_file(folder).map(|text| judge_license_text(&text));
    let (declared, file) = if declared.is_none() && file.is_none() {
        (
            None,
            inherit
                .and_then(license_file)
                .map(|text| judge_license_text(&text)),
        )
    } else {
        (declared, file)
    };
    let restricted = declared.as_ref().is_some_and(|info| info.restricted)
        || file.as_ref().is_some_and(|info| info.restricted);
    let restricting_id = [&declared, &file]
        .into_iter()
        .flatten()
        .find(|info| info.restricted)
        .and_then(|info| info.id.clone());
    // "Complete terms in LICENSE.txt" names no license: the file it points to does.
    let points_to_file = declared
        .as_ref()
        .and_then(|info| info.id.as_deref())
        .is_some_and(|id| id.to_lowercase().contains("licen"));
    let declared_id = declared.and_then(|info| info.id);
    let file_id = file.and_then(|info| info.id);
    let id = if restricted {
        restricting_id
    } else if points_to_file {
        file_id.or(declared_id)
    } else {
        declared_id.or(file_id)
    };
    LicenseInfo { id, restricted }
}

fn license_file(folder: &Path) -> Option<String> {
    let mut names = fs::read_dir(folder)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            lower.starts_with("license")
                || lower.starts_with("licence")
                || lower.starts_with("copying")
        })
        .collect::<Vec<_>>();
    names.sort();
    names
        .first()
        .and_then(|name| read_capped(&folder.join(name), MAX_LICENSE_TEXT).ok())
}

pub(crate) fn judge_license_field(field: &str) -> LicenseInfo {
    let lower = field.to_lowercase();
    if let Some((_, id)) = RESTRICTING.iter().find(|(words, _)| lower.contains(words)) {
        return LicenseInfo {
            id: Some((*id).to_owned()),
            restricted: true,
        };
    }
    let line = field.lines().next().unwrap_or_default().trim();
    let id = if line.chars().count() > 60 {
        format!("{}…", line.chars().take(59).collect::<String>())
    } else {
        line.to_owned()
    };
    LicenseInfo {
        id: (!id.is_empty()).then_some(id),
        restricted: false,
    }
}

pub(crate) fn judge_license_text(text: &str) -> LicenseInfo {
    let lower = text.to_lowercase();
    let spdx = text.lines().find_map(|line| {
        line.split_once("SPDX-License-Identifier:")
            .map(|(_, id)| id.trim().to_owned())
            .filter(|id| !id.is_empty() && id.len() <= 60)
    });
    if let Some((_, name)) = OPEN_LICENSES
        .iter()
        .find(|(words, _)| lower.contains(words))
    {
        return LicenseInfo {
            id: spdx.or_else(|| Some((*name).to_owned())),
            restricted: false,
        };
    }
    if let Some((_, id)) = RESTRICTING.iter().find(|(words, _)| lower.contains(words)) {
        return LicenseInfo {
            id: Some((*id).to_owned()),
            restricted: true,
        };
    }
    LicenseInfo {
        id: spdx,
        restricted: false,
    }
}

// --- Bring in skills from your apps ------------------------------------------------------------

/// How an app lays out the skills in one of its folders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    /// `<folder>/…/<skill>/SKILL.md`: skills installed directly.
    Skills,
    /// `<folder>/…/<plugin>[/<version>]/skills/<skill>/SKILL.md`: skills a plugin brought.
    Plugins,
}

/// One app folder skills are brought in from.
#[derive(Debug, Clone)]
struct AppFolder {
    path: PathBuf,
    app: &'static str,
    layout: Layout,
    /// Folder names skipped directly below `path`.
    exclude: &'static [&'static str],
}

impl AppFolder {
    fn new(path: PathBuf, app: &'static str, layout: Layout) -> Self {
        Self {
            path,
            app,
            layout,
            exclude: &[],
        }
    }

    fn depth(&self) -> usize {
        if self.layout == Layout::Plugins {
            10
        } else {
            5
        }
    }
}

/// Every app skill folder, in the order a copy is preferred when two apps hold a skill of the
/// same name. Skill folders only, mirroring `capabilities.rs` `home_skill_roots`: no app's
/// settings, sign-in or session files are among them.
fn app_folders(home: &Path) -> Vec<AppFolder> {
    use Layout::{Plugins, Skills};
    let mut folders = vec![
        AppFolder::new(home.join(".claude/skills"), "Claude Code", Skills),
        AppFolder::new(home.join(".codex/skills"), "Codex", Skills),
        AppFolder::new(home.join(".agents/skills"), "Shared skills folder", Skills),
        // OpenCode documents `skill/`; `skills/` is what most installers write.
        AppFolder::new(home.join(".config/opencode/skills"), "OpenCode", Skills),
        AppFolder::new(home.join(".config/opencode/skill"), "OpenCode", Skills),
        AppFolder::new(home.join(".gemini/skills"), "Gemini", Skills),
        // Hermes files skills by category and keeps a set per profile.
        AppFolder::new(home.join(".hermes/skills"), "Hermes", Skills),
    ];
    for profile in subfolders(&home.join(".hermes/profiles")) {
        folders.push(AppFolder::new(profile.join("skills"), "Hermes", Skills));
    }
    for relative in [
        ".openclaw/skills",
        ".openclaw/workspace/skills",
        ".openclaw/plugin-skills",
    ] {
        folders.push(AppFolder::new(home.join(relative), "OpenClaw", Skills));
    }
    folders.push(AppFolder::new(home.join(".pi/agent/skills"), "pi", Skills));
    // Plugins last. Claude Code's `marketplaces/` is the catalog of every plugin a marketplace
    // offers, installed or not, so its skills aren't the person's.
    folders.push(AppFolder::new(
        home.join(".codex/plugins/cache"),
        "Codex",
        Plugins,
    ));
    let mut claude_plugins = AppFolder::new(home.join(".claude/plugins"), "Claude Code", Plugins);
    claude_plugins.exclude = &["marketplaces"];
    folders.push(claude_plugins);
    folders.push(AppFolder::new(
        home.join(".gemini/extensions"),
        "Gemini",
        Plugins,
    ));
    folders
}

fn subfolders(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };
    let mut folders = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    folders.sort();
    folders
}

/// Every `SKILL.md` under `root`, following links, since apps install skills by linking them in.
/// Copied from `capabilities.rs` `find_skill_files`: canonical paths end a link that points back up
/// its own tree, and `exclude` names folders skipped directly below `root` only.
pub(crate) fn find_skill_files(root: &Path, max_depth: usize, exclude: &[&str]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut seen = BTreeSet::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        if depth > max_depth {
            continue;
        }
        let canonical = fs::canonicalize(&directory).unwrap_or_else(|_| directory.clone());
        if !seen.insert(canonical) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            let resolved = if file_type.is_symlink() {
                fs::metadata(&path).ok().map(|metadata| metadata.is_dir())
            } else {
                Some(file_type.is_dir())
            };
            let Some(is_directory) = resolved else {
                continue;
            };
            if is_directory {
                let name = entry.file_name();
                if SKIP_DIRECTORIES.iter().any(|skip| name == *skip)
                    || (depth == 0 && exclude.iter().any(|skip| name == *skip))
                {
                    continue;
                }
                pending.push((path, depth + 1));
            } else if entry.file_name() == SKILL_FILE {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// The plugin a skill came with. Copied from `capabilities.rs` `plugin_name`.
fn plugin_name(skill_directory: &Path) -> Option<String> {
    let skills = skill_directory.parent()?;
    if skills.file_name()? != "skills" {
        return None;
    }
    let owner = skills.parent()?;
    let name = owner.file_name()?.to_str()?;
    if looks_like_a_version(name) {
        return owner
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .map(|name| without_generation(name).to_owned());
    }
    Some(without_generation(name).to_owned())
}

/// `engineering~g3` → `engineering`: Claude Code's synced plugins carry a generation suffix that
/// changes on every update. Copied from `capabilities.rs`.
fn without_generation(name: &str) -> &str {
    match name.rsplit_once("~g") {
        Some((plugin, generation))
            if !plugin.is_empty()
                && !generation.is_empty()
                && generation.chars().all(|c| c.is_ascii_digit()) =>
        {
            plugin
        }
        _ => name,
    }
}

fn looks_like_a_version(name: &str) -> bool {
    name.starts_with(|first: char| first.is_ascii_digit()) && name.contains('.')
}

/// One skill an app has that could be brought in.
#[allow(clippy::struct_excessive_bools)] // The Skills page's shape: each is a separate fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BringInCandidate {
    /// What the import names it by; stable while the skill stays where it is.
    pub key: String,
    pub name: String,
    pub description: String,
    /// The app whose folder holds it.
    pub app: String,
    /// The plugin it came with, when it came with one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    pub path: String,
    pub license: LicenseInfo,
    /// Its license says "All rights reserved": it can never be brought in.
    pub restricted: bool,
    /// Why it can't be brought in, when it can't.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub needs: Vec<String>,
    pub runtimes: Vec<String>,
    pub has_scripts: bool,
    pub size_bytes: u64,
    pub file_count: usize,
    /// A skill with this name is already in `LoomWatch`'s folder.
    pub already_in_loom_watch: bool,
    /// Ticked to start with: it can come in, isn't there yet, and no app earlier in the list has
    /// one by the same name.
    pub default_selected: bool,
}

/// Every skill the apps on this computer have, best copy first. Reads skill folders only.
///
/// # Errors
/// When `LoomWatch`'s own folder can't be read.
pub fn preview(home: &Path, store: &SkillsStore) -> Result<Vec<BringInCandidate>, SkillsError> {
    // Without a home folder there are no apps' folders: a relative path would read wherever the
    // daemon happens to run.
    if !home.is_absolute() {
        return Ok(Vec::new());
    }
    let present = store.names()?;
    let limits = store.limits();
    let mut seen = BTreeSet::new();
    let mut claimed = BTreeSet::new();
    let mut candidates = Vec::new();
    for folder in app_folders(home) {
        for skill_file in find_skill_files(&folder.path, folder.depth(), folder.exclude) {
            let Some(directory) = skill_file.parent() else {
                continue;
            };
            // The same skill linked into two apps' folders is one skill.
            let canonical = fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
            if !seen.insert(canonical.clone()) {
                continue;
            }
            let fallback = directory
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("skill");
            let plugin = if folder.layout == Layout::Plugins {
                plugin_name(directory)
            } else {
                None
            };
            // A plugin's license covers the skills it brings: `<plugin>/skills/<skill>`.
            let plugin_root = plugin.as_ref().and_then(|_| directory.parent()?.parent());
            let Ok(facts) = read_folder(directory, fallback, plugin_root, &limits) else {
                continue;
            };
            let reason = facts.refusal(&limits);
            let lower = facts.name.to_lowercase();
            let already_in_loom_watch = present.contains(&lower);
            let default_selected =
                reason.is_none() && !already_in_loom_watch && claimed.insert(lower);
            candidates.push(BringInCandidate {
                key: hex(&Sha256::digest(canonical.to_string_lossy().as_bytes()))[..16].to_owned(),
                name: facts.name,
                description: facts.description,
                app: folder.app.to_owned(),
                plugin,
                path: directory.to_string_lossy().into_owned(),
                license: facts.license.clone(),
                restricted: facts.license.restricted,
                reason,
                needs: facts.needs,
                runtimes: facts.runtimes,
                has_scripts: facts.has_scripts,
                size_bytes: facts.size_bytes,
                file_count: facts.file_count,
                already_in_loom_watch,
                default_selected,
            });
        }
    }
    Ok(candidates)
}

/// One skill a bring-in left out, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

/// What one bring-in did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BringInOutcome {
    /// Undo takes back everything this bring-in imported.
    pub batch_id: String,
    pub imported: Vec<SkillRecord>,
    pub skipped: Vec<Skipped>,
}

/// Copy the skills `keys` name, from a fresh look at the apps' folders, into `LoomWatch`'s.
/// A restricted skill, one that is too big, or one whose name is taken is skipped and said so.
///
/// # Errors
/// When `LoomWatch`'s own folder can't be read.
pub fn bring_in(
    home: &Path,
    store: &SkillsStore,
    keys: &[String],
) -> Result<BringInOutcome, SkillsError> {
    let candidates = preview(home, store)?;
    let batch_id = uuid::Uuid::new_v4().simple().to_string();
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut done = BTreeSet::new();
    for key in keys {
        if !done.insert(key.as_str()) {
            continue;
        }
        let Some(candidate) = candidates.iter().find(|candidate| &candidate.key == key) else {
            skipped.push(Skipped {
                name: key.clone(),
                reason: "This skill isn’t in your apps’ folders any more.".to_owned(),
            });
            continue;
        };
        let skip = |reason: String| Skipped {
            name: candidate.name.clone(),
            reason,
        };
        if let Some(reason) = &candidate.reason {
            skipped.push(skip(reason.clone()));
            continue;
        }
        if candidate.already_in_loom_watch {
            skipped.push(skip("It’s already in LoomWatch.".to_owned()));
            continue;
        }
        let source = PathBuf::from(&candidate.path);
        let plugin_root = candidate
            .plugin
            .as_ref()
            .and_then(|_| source.parent()?.parent());
        let mut origin = Origin::new(OriginKind::BroughtIn);
        origin.app = Some(candidate.app.clone());
        origin.source_path = Some(candidate.path.clone());
        match store.add(&NewSkill {
            source: &source,
            name: &candidate.name,
            origin,
            batch_id: Some(batch_id.clone()),
            replace: false,
            inherit_license: plugin_root,
        }) {
            Ok(record) => imported.push(record),
            Err(error) => skipped.push(skip(error.message().to_owned())),
        }
    }
    Ok(BringInOutcome {
        batch_id,
        imported,
        skipped,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A folder under the system's temporary folder, removed when dropped.
    pub(crate) struct Scratch(pub PathBuf);

    impl Scratch {
        pub(crate) fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "loomwatch-skills-{label}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).expect("scratch folder");
            Self(path)
        }

        pub(crate) fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().expect("a parent")).expect("parent folder");
        fs::write(path, text).expect("write");
    }

    pub(crate) fn skill(folder: &Path, name: &str, extra: &str) {
        write(
            &folder.join(SKILL_FILE),
            &format!(
                "---\nname: {name}\ndescription: Does {name} things.\n{extra}---\n\n# {name}\n"
            ),
        );
    }

    pub(crate) fn small_limits() -> Limits {
        Limits {
            skill_bytes: 4_096,
            skill_files: 6,
            download_bytes: 64 * 1024,
            unpacked_bytes: 256 * 1024,
        }
    }

    const MIT: &str = "MIT License\n\nCopyright (c) 2026 Someone\n\nPermission is hereby granted, free of charge, to any person…";
    const BSD: &str = "Copyright (c) 2026, Someone\nAll rights reserved.\n\nRedistribution and use in source and binary forms, with or without modification, are permitted…";

    /// A home folder with what apps really leave there: a linked-in skill, a plugin with a
    /// generation suffix, a catalog of plugins nobody installed, a link that points back up its
    /// own tree, a skill too big to take and one whose license reserves every right.
    fn home_with_skills(home: &Path) {
        let claude = home.join(".claude/skills");
        skill(&claude.join("writer"), "writer", "license: MIT\n");
        write(
            &claude.join("writer/scripts/outline.py"),
            "print('outline')\n",
        );
        write(&claude.join("writer/LICENSE"), MIT);
        skill(
            &claude.join("secret"),
            "secret",
            "license: Proprietary. LICENSE.txt has complete terms\n",
        );
        skill(&claude.join("bsd-tool"), "bsd-tool", "");
        write(&claude.join("bsd-tool/LICENSE.txt"), BSD);
        // Apps' own settings and sign-in sit beside their skills and must never be read.
        write(
            &home.join(".claude/.credentials.json"),
            "{\"token\":\"never-read\"}",
        );
        write(&home.join(".claude/settings.json"), "{}");

        let plugin = home.join(".claude/plugins/cache/acme-market/engineering~g2");
        skill(&plugin.join("skills/review"), "review", "");
        write(&plugin.join("LICENSE"), MIT);
        skill(
            &home.join(".claude/plugins/marketplaces/acme-market/plugins/catalog/skills/catalog"),
            "catalog",
            "",
        );

        let codex = home.join(".codex/skills");
        skill(&codex.join("huge"), "huge", "");
        for index in 0..10 {
            write(&codex.join(format!("huge/part-{index}.md")), "padding\n");
        }
        // The same writer, linked into a second app: one skill, not two.
        #[cfg(unix)]
        std::os::unix::fs::symlink(claude.join("writer"), codex.join("writer-link")).expect("link");

        let shared = home.join(".agents/skills");
        skill(&shared.join("notes"), "notes", "");
        write(&shared.join("notes/tool.js"), "console.log('hi')\n");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&shared, shared.join("loop")).expect("loop link");
            std::os::unix::fs::symlink("/etc/hosts", shared.join("notes/hosts")).expect("link");
        }
    }

    fn named<'a>(candidates: &'a [BringInCandidate], name: &str) -> &'a BringInCandidate {
        candidates
            .iter()
            .find(|candidate| candidate.name == name)
            .unwrap_or_else(|| panic!("{name} in {candidates:#?}"))
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn skills_bring_in_previews_imports_and_undoes() {
        let home = Scratch::new("home");
        let state = Scratch::new("state");
        home_with_skills(home.path());
        let store = SkillsStore::with_limits(state.path(), small_limits());

        let candidates = preview(home.path(), &store).expect("preview");
        let mut names = candidates
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();
        assert_eq!(
            names,
            ["bsd-tool", "huge", "notes", "review", "secret", "writer"],
            "one writer though it is linked twice; no catalog skill; the loop ends"
        );

        let writer = named(&candidates, "writer");
        assert_eq!(writer.app, "Claude Code");
        assert_eq!(writer.license.id.as_deref(), Some("MIT"));
        assert_eq!(writer.runtimes, ["python"]);
        assert!(writer.has_scripts && writer.default_selected && !writer.restricted);

        let secret = named(&candidates, "secret");
        assert!(secret.restricted && !secret.default_selected);
        assert!(
            secret
                .reason
                .as_deref()
                .unwrap()
                .contains("All rights reserved")
        );

        let bsd = named(&candidates, "bsd-tool");
        assert!(
            !bsd.restricted,
            "a BSD license says All rights reserved and grants use"
        );
        assert_eq!(bsd.license.id.as_deref(), Some("BSD"));

        let review = named(&candidates, "review");
        assert_eq!(
            review.plugin.as_deref(),
            Some("engineering"),
            "~g2 is not part of its name"
        );
        assert_eq!(
            review.license.id.as_deref(),
            Some("MIT"),
            "the plugin's license covers it"
        );
        assert!(review.default_selected);

        let huge = named(&candidates, "huge");
        assert!(!huge.restricted && !huge.default_selected);
        assert!(
            huge.reason
                .as_deref()
                .unwrap()
                .contains("bigger than LoomWatch takes")
        );

        let notes = named(&candidates, "notes");
        assert_eq!(notes.app, "Shared skills folder");
        assert_eq!(notes.runtimes, ["node"]);

        let mut keys = candidates
            .iter()
            .filter(|candidate| candidate.default_selected)
            .map(|candidate| candidate.key.clone())
            .collect::<Vec<_>>();
        keys.push(secret.key.clone());
        keys.push(huge.key.clone());
        let outcome = bring_in(home.path(), &store, &keys).expect("bring in");
        let mut imported = outcome
            .imported
            .iter()
            .map(|record| record.name.as_str())
            .collect::<Vec<_>>();
        imported.sort_unstable();
        assert_eq!(imported, ["bsd-tool", "notes", "review", "writer"]);
        let skipped = outcome
            .skipped
            .iter()
            .map(|skip| skip.name.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(skipped, BTreeSet::from(["huge", "secret"]));

        let folder = store.folder();
        assert!(folder.join("writer/scripts/outline.py").is_file());
        assert!(folder.join("notes/tool.js").is_file());
        assert!(
            fs::symlink_metadata(folder.join("notes/hosts")).is_err(),
            "a link inside a skill is not copied"
        );
        let listed = store.list().expect("list");
        let writer = listed
            .iter()
            .find(|record| record.name == "writer")
            .unwrap();
        assert_eq!(writer.origin.kind, OriginKind::BroughtIn);
        assert_eq!(writer.origin.app.as_deref(), Some("Claude Code"));
        assert!(
            writer
                .origin
                .source_path
                .as_deref()
                .unwrap()
                .ends_with(".claude/skills/writer")
        );
        assert_eq!(writer.batch_id.as_deref(), Some(outcome.batch_id.as_str()));
        assert_eq!(writer.sha256.len(), 64);

        let again = preview(home.path(), &store).expect("preview again");
        let writer = named(&again, "writer");
        assert!(writer.already_in_loom_watch && !writer.default_selected);

        let undone = store.undo(&outcome.batch_id).expect("undo");
        assert_eq!(undone.len(), 4);
        assert!(store.list().expect("list").is_empty());
        let removed = fs::read_dir(folder.join(REMOVED_FOLDER))
            .expect("removed folder")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(removed.len(), 4);
        assert!(removed.iter().any(|name| name.starts_with("writer-")));
        assert!(matches!(
            store.undo(&outcome.batch_id),
            Err(SkillsError::NotFound(_))
        ));
    }

    #[test]
    fn skills_bring_in_reads_only_skill_folders_under_a_real_home() {
        let home = Scratch::new("home");
        let state = Scratch::new("state");
        home_with_skills(home.path());
        for folder in app_folders(home.path()) {
            let last = folder
                .path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            assert!(
                [
                    "skills",
                    "skill",
                    "plugin-skills",
                    "cache",
                    "plugins",
                    "extensions"
                ]
                .contains(&last.as_str()),
                "{} is not a skill folder",
                folder.path.display()
            );
        }
        let store = SkillsStore::new(state.path());
        assert!(!preview(home.path(), &store).expect("preview").is_empty());
        assert!(
            preview(Path::new(""), &store).expect("no home").is_empty(),
            "no home folder, nothing read"
        );
    }

    #[cfg(unix)]
    #[test]
    fn skills_manifest_is_written_privately() {
        use std::os::unix::fs::PermissionsExt;
        let source = Scratch::new("source");
        let state = Scratch::new("state");
        skill(source.path(), "pdf", "license: MIT\n");
        let store = SkillsStore::new(state.path());
        store
            .add(&NewSkill {
                source: source.path(),
                name: "pdf",
                origin: Origin::new(OriginKind::Installed),
                batch_id: None,
                replace: false,
                inherit_license: None,
            })
            .expect("add");
        let manifest = state.path().join(MANIFEST_FILE);
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&manifest), 0o600);
        assert_eq!(mode(state.path()), 0o700);
        let leftovers = fs::read_dir(state.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".partial"))
            .count();
        assert_eq!(leftovers, 0);
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        assert_eq!(saved["version"], 1);
        assert_eq!(saved["skills"][0]["name"], "pdf");
        assert_eq!(saved["skills"][0]["origin"]["kind"], "installed");
        assert_eq!(saved["skills"][0]["license"]["id"], "MIT");
        assert!(
            fs::read_dir(store.staging()).unwrap().next().is_none(),
            "no copy is left half-made"
        );
    }

    #[test]
    fn skills_folder_replaces_only_when_asked_and_lists_folders_put_there_by_hand() {
        let source = Scratch::new("source");
        let state = Scratch::new("state");
        skill(source.path(), "pdf", "");
        let store = SkillsStore::new(state.path());
        let add = |replace| {
            store.add(&NewSkill {
                source: source.path(),
                name: "pdf",
                origin: Origin::new(OriginKind::Installed),
                batch_id: None,
                replace,
                inherit_license: None,
            })
        };
        add(false).expect("first");
        assert!(matches!(add(false), Err(SkillsError::Conflict(_))));
        add(true).expect("replace");
        assert_eq!(
            fs::read_dir(store.folder().join(REMOVED_FOLDER))
                .unwrap()
                .count(),
            1,
            "the replaced copy is kept in .removed"
        );

        skill(&store.folder().join("by-hand"), "by-hand", "");
        let listed = store.list().expect("list");
        assert_eq!(
            listed
                .iter()
                .map(|record| record.name.as_str())
                .collect::<Vec<_>>(),
            ["by-hand", "pdf"]
        );
        assert_eq!(listed[0].origin.kind, OriginKind::Found);

        assert_eq!(store.remove("by-hand").expect("remove"), "by-hand");
        assert_eq!(store.list().expect("list").len(), 1);
        assert!(matches!(
            store.remove("by-hand"),
            Err(SkillsError::NotFound(_))
        ));
        assert!(matches!(
            store.remove("../state"),
            Err(SkillsError::NotFound(_))
        ));
    }

    #[test]
    fn skills_restricted_never_come_in_by_any_way() {
        let source = Scratch::new("source");
        let state = Scratch::new("state");
        skill(source.path(), "locked", "");
        write(
            &source.path().join("LICENSE"),
            "© 2026 Acme. All rights reserved.",
        );
        let store = SkillsStore::new(state.path());
        let added = store.add(&NewSkill {
            source: source.path(),
            name: "locked",
            origin: Origin::new(OriginKind::Installed),
            batch_id: None,
            replace: false,
            inherit_license: None,
        });
        assert!(matches!(added, Err(SkillsError::Refused(_))));
        assert!(!store.folder().join("locked").exists());
    }

    #[test]
    fn skills_names_must_be_plain_folder_names() {
        for name in ["pdf", "PDF Tools", "my_skill-2"] {
            assert!(usable_name(name), "{name}");
        }
        let long = "a".repeat(129);
        for name in [
            "",
            ".hidden",
            "..",
            "a/b",
            "a\\b",
            "nul\0",
            " pad",
            "a:b",
            long.as_str(),
        ] {
            assert!(!usable_name(name), "{name:?}");
        }
        assert_eq!(choose_name(Some("../escape"), "folder"), "folder");
        assert_eq!(choose_name(Some(" pdf "), "folder"), "pdf");
    }

    #[test]
    fn skills_licenses_are_read_by_what_they_grant() {
        assert!(judge_license_field("Proprietary. LICENSE.txt has complete terms").restricted);
        assert!(judge_license_field("All Rights Reserved").restricted);
        assert_eq!(judge_license_field("MIT").id.as_deref(), Some("MIT"));
        assert!(!judge_license_text(BSD).restricted);
        assert!(judge_license_text("Copyright Acme. All rights reserved.").restricted);
        assert!(judge_license_text("This software is proprietary to Acme.").restricted);
        assert_eq!(
            judge_license_text("SPDX-License-Identifier: Apache-2.0\nApache License")
                .id
                .as_deref(),
            Some("Apache-2.0")
        );
        assert_eq!(judge_license_text("Do what you like.").id, None);

        let folder = Scratch::new("license");
        write(
            &folder.path().join("LICENSE.txt"),
            "Apache License\nVersion 2.0, January 2004",
        );
        let pointed = license_of(folder.path(), Some("Complete terms in LICENSE.txt"), None);
        assert_eq!(
            pointed.id.as_deref(),
            Some("Apache-2.0"),
            "the file names the license"
        );
        assert!(!pointed.restricted);
        let named = license_of(folder.path(), Some("MIT"), None);
        assert_eq!(named.id.as_deref(), Some("MIT"), "a named license stands");
    }
}

//! Finding the folders and files a person names, so Ask can connect them (ADR 0096).
//!
//! "Use my Market research folder" needs that folder's full path in the team file, and Ask has no
//! file tools. `find_files` looks for folders and files by the words the person used: first among
//! what their teams and My agents already read, then in their home folder and, on a Mac, in
//! iCloud Drive and the cloud folders apps such as `OneDrive`, Google Drive and Dropbox keep in
//! `Library/CloudStorage`, a few folders deep. It reads names only, never what is in a file, and
//! lists a found folder's first few names so the person can tell it is the one. It skips hidden
//! folders, app data and bundles, and stops after a bounded number of folders or a few seconds,
//! whichever comes first, so a search never holds up the conversation. A folder near the top that
//! the computer didn't let it open, such as Documents before macOS is told `LoomWatch` may, is
//! named in the answer, so Ask can say so rather than "not found".

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How many folders below the home folder a search goes: `~/Documents/Clients/Acme/2026`.
const MAX_DEPTH: usize = 5;
/// The most folders one search opens.
const MAX_FOLDERS: usize = 40_000;
/// The longest one search takes.
const MAX_TIME: Duration = Duration::from_secs(3);
/// The most matches a search answers with.
const MAX_FOUND: usize = 12;
/// The names of a found folder shown with it.
const SHOWN_INSIDE: usize = 8;
/// The longest query: a name or a path, not a paragraph.
pub(super) const MAX_QUERY_CHARS: usize = 300;

/// Folders a person doesn't keep their work in, or that hold an app's own files.
const SKIPPED: &[&str] = &[
    "Library",
    "AppData",
    "Applications",
    "node_modules",
    "target",
    "__pycache__",
    "venv",
    "site-packages",
    "Pods",
    "DerivedData",
];
/// Folders that are one thing to the person: an app, a photo or music library, a bundle.
const BUNDLES: &[&str] = &[
    "app",
    "photoslibrary",
    "musiclibrary",
    "tvlibrary",
    "bundle",
    "framework",
    "xcodeproj",
    "xcworkspace",
    "pkg",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Kind {
    Folder,
    File,
}

/// One folder or file that matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Found {
    pub(super) path: String,
    pub(super) name: String,
    pub(super) kind: Kind,
    /// A folder's first names, so the person can tell it is the one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) holds: Vec<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub(super) more_inside: usize,
    /// The teams and agents that already read it: "Market brief · Researcher".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) used_by: Vec<String>,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero(count: &usize) -> bool {
    *count == 0
}

/// A folder or file one of the person's teams or agents already reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InUse {
    pub(super) path: PathBuf,
    /// Its label there.
    pub(super) name: String,
    pub(super) by: String,
}

/// What a search found, and how far it looked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Search {
    pub(super) found: Vec<Found>,
    /// It stopped at its limit before it had looked everywhere it looks.
    pub(super) stopped_early: bool,
    /// Folders near the top it wasn't allowed to open, by name: "Documents".
    pub(super) not_allowed: Vec<String>,
}

/// The query as words to find in a name: lowercase letters and digits, everything else a space,
/// so "market-research" and "Market Research 2026" both hold "market research".
fn words(text: &str) -> Vec<String> {
    text.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_lowercase().next().unwrap_or(c)
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// How well `name` matches `query`: `None` when a word is missing, `0` for the same words, `1` for
/// its stem's (a file's name without its extension), `2` when it holds them all.
fn rank(name: &str, query: &[String]) -> Option<u8> {
    let have = words(name);
    let joined = have.join(" ");
    if !query.iter().all(|word| joined.contains(word.as_str())) {
        return None;
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|stem| words(&stem.to_string_lossy()))
        .unwrap_or_default();
    if have == query {
        Some(0)
    } else if stem == query {
        Some(1)
    } else {
        Some(2)
    }
}

fn kind_of(path: &Path) -> Option<Kind> {
    let metadata = fs::metadata(path).ok()?;
    Some(if metadata.is_dir() {
        Kind::Folder
    } else {
        Kind::File
    })
}

/// What a found folder holds, hidden names left out: its first names in order, and how many more.
fn inside(folder: &Path) -> (Vec<String>, usize) {
    let Ok(entries) = fs::read_dir(folder) else {
        return (Vec::new(), 0);
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    let more = names.len().saturating_sub(SHOWN_INSIDE);
    names.truncate(SHOWN_INSIDE);
    (names, more)
}

fn found(path: &Path, kind: Kind, used_by: Vec<String>) -> Found {
    let (holds, more_inside) = if kind == Kind::Folder {
        inside(path)
    } else {
        (Vec::new(), 0)
    };
    Found {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map_or_else(
            || path.to_string_lossy().into_owned(),
            |name| name.to_string_lossy().into_owned(),
        ),
        kind,
        holds,
        more_inside,
        used_by,
    }
}

/// A query that is a path rather than a name: absolute, or from the home folder.
fn as_path(query: &str, home: Option<&Path>) -> Option<PathBuf> {
    let query = query.trim();
    if let Some(rest) = query
        .strip_prefix("~/")
        .or_else(|| query.strip_prefix("~\\"))
    {
        return home.map(|home| home.join(rest));
    }
    let path = Path::new(query);
    path.is_absolute().then(|| path.to_path_buf())
}

fn skipped(name: &str) -> bool {
    name.starts_with('.')
        || SKIPPED.contains(&name)
        || Path::new(name)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                BUNDLES
                    .iter()
                    .any(|bundle| extension.eq_ignore_ascii_case(bundle))
            })
}

/// The folders and files whose names hold the words of `query`, or the one it names when it is a
/// path: what the person's teams and agents already read first, then the home folder, nearest and
/// closest names first.
pub(super) fn find(query: &str, home: Option<&Path>, in_use: &[InUse]) -> Search {
    if let Some(path) = as_path(query, home) {
        let found = kind_of(&path)
            .map(|kind| {
                let path = crate::platform::canonicalize(&path).unwrap_or(path);
                let by = used_by(&path, in_use);
                vec![found(&path, kind, by)]
            })
            .unwrap_or_default();
        return Search {
            found,
            stopped_early: false,
            not_allowed: Vec::new(),
        };
    }
    let query = words(query);
    if query.is_empty() {
        return Search {
            found: Vec::new(),
            stopped_early: false,
            not_allowed: Vec::new(),
        };
    }
    // Already read somewhere: by its label there or its own name.
    let mut known: BTreeMap<PathBuf, u8> = BTreeMap::new();
    for entry in in_use {
        let own = entry
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Some(best) = [rank(&entry.name, &query), rank(&own, &query)]
            .into_iter()
            .flatten()
            .min()
        else {
            continue;
        };
        // As the computer spells it, so a team's `notes/q3` on Windows reads `notes\q3`, and one
        // folder reached two ways is listed once.
        let Ok(path) = crate::platform::canonicalize(&entry.path) else {
            continue;
        };
        let slot = known.entry(path).or_insert(best);
        *slot = (*slot).min(best);
    }
    let mut results: Vec<(u8, usize, Found)> = known
        .into_iter()
        .filter_map(|(path, rank)| {
            let kind = kind_of(&path)?;
            Some((rank, 0, found(&path, kind, used_by(&path, in_use))))
        })
        .collect();
    let mut stopped_early = false;
    let mut not_allowed = Vec::new();
    if let Some(home) = home {
        let walked = walk(&roots(home), &query, MAX_FOUND * 4);
        stopped_early = walked.stopped;
        not_allowed = walked.not_allowed;
        for (rank, depth, path, kind) in walked.matches {
            if results
                .iter()
                .any(|(_, _, already)| Path::new(&already.path) == path)
            {
                continue;
            }
            let by = used_by(&path, in_use);
            results.push((rank, depth + 1, found(&path, kind, by)));
        }
    }
    // What is already read comes first, then the closest names, then the nearest.
    results.sort_by(|a, b| {
        (a.2.used_by.is_empty(), a.0, a.1, a.2.path.len()).cmp(&(
            b.2.used_by.is_empty(),
            b.0,
            b.1,
            b.2.path.len(),
        ))
    });
    results.truncate(MAX_FOUND);
    Search {
        found: results.into_iter().map(|(_, _, found)| found).collect(),
        stopped_early,
        not_allowed,
    }
}

/// Where a search looks: the home folder, and on a Mac the cloud folders kept in its `Library`,
/// which the search otherwise skips: iCloud Drive, and each folder in `Library/CloudStorage`
/// (`OneDrive`, Google Drive, Dropbox, Box), each with the name a person knows it by.
fn roots(home: &Path) -> Vec<(PathBuf, String)> {
    let mut roots = vec![(home.to_path_buf(), String::new())];
    if !cfg!(target_os = "macos") {
        return roots;
    }
    let library = home.join("Library");
    let icloud = library.join("Mobile Documents").join("com~apple~CloudDocs");
    if icloud.is_dir() {
        roots.push((icloud, "iCloud Drive".to_owned()));
    }
    if let Ok(entries) = fs::read_dir(library.join("CloudStorage")) {
        let mut clouds: Vec<(PathBuf, String)> = entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| {
                (
                    entry.path(),
                    entry.file_name().to_string_lossy().into_owned(),
                )
            })
            .collect();
        clouds.sort();
        roots.extend(clouds);
    }
    roots
}

/// What [`walk`] found.
struct Walked {
    /// Each match with its rank, its depth below its root, its path and what it is.
    matches: Vec<(u8, usize, PathBuf, Kind)>,
    stopped: bool,
    not_allowed: Vec<String>,
}

fn used_by(path: &Path, in_use: &[InUse]) -> Vec<String> {
    let mut by = Vec::new();
    let same = |entry: &&InUse| {
        entry.path == path
            || crate::platform::canonicalize(&entry.path).is_ok_and(|canonical| canonical == path)
    };
    for entry in in_use.iter().filter(same) {
        if !by.contains(&entry.by) {
            by.push(entry.by.clone());
        }
    }
    by
}

/// A breadth-first look below each of `roots` for names that hold `query`, up to [`MAX_DEPTH`]
/// folders deep, within [`MAX_FOLDERS`] and [`MAX_TIME`] for them all. Symbolic links are matched
/// but never followed, so a loop of them can't hold it. A root or a folder just inside one that it
/// isn't allowed to open is named in `not_allowed`: a root by the name it was given, a folder by
/// its own.
fn walk(roots: &[(PathBuf, String)], query: &[String], enough: usize) -> Walked {
    let started = Instant::now();
    let mut walked = Walked {
        matches: Vec::new(),
        stopped: false,
        not_allowed: Vec::new(),
    };
    let mut queue: VecDeque<(PathBuf, usize)> =
        roots.iter().map(|(root, _)| (root.clone(), 0)).collect();
    let mut opened = 0;
    while let Some((folder, depth)) = queue.pop_front() {
        if opened >= MAX_FOLDERS || started.elapsed() >= MAX_TIME {
            walked.stopped = true;
            return walked;
        }
        opened += 1;
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && depth <= 1 => {
                let name = roots
                    .iter()
                    .find(|(root, _)| *root == folder)
                    .map(|(_, name)| name.clone())
                    .filter(|name| !name.is_empty())
                    .or_else(|| {
                        folder
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                    })
                    .unwrap_or_default();
                if !name.is_empty() && !walked.not_allowed.contains(&name) {
                    walked.not_allowed.push(name);
                }
                continue;
            }
            Err(_) => continue,
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let is_folder = if file_type.is_symlink() {
                fs::metadata(&path).is_ok_and(|metadata| metadata.is_dir())
            } else {
                file_type.is_dir()
            };
            if let Some(rank) = rank(&name, query) {
                let kind = if is_folder { Kind::Folder } else { Kind::File };
                walked.matches.push((rank, depth, path.clone(), kind));
                if walked.matches.len() >= enough {
                    walked.stopped = true;
                    return walked;
                }
            }
            if is_folder && !file_type.is_symlink() && depth < MAX_DEPTH && !skipped(&name) {
                queue.push_back((path, depth + 1));
            }
        }
    }
    walked
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Home(PathBuf);

    impl Home {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-find-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("home");
            Self(crate::platform::canonicalize(&path).expect("canonical home"))
        }

        /// `relative`, written with `/`, below the home folder, as this computer spells it.
        fn at(&self, relative: &str) -> PathBuf {
            relative
                .split('/')
                .fold(self.0.clone(), |path, part| path.join(part))
        }

        fn folder(&self, relative: &str) -> PathBuf {
            let path = self.at(relative);
            fs::create_dir_all(&path).expect("folder");
            path
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.at(relative);
            fs::create_dir_all(path.parent().expect("a parent")).expect("parent");
            fs::write(&path, "text").expect("file");
            path
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn paths(search: &Search) -> Vec<&str> {
        search
            .found
            .iter()
            .map(|found| found.path.as_str())
            .collect()
    }

    #[test]
    fn a_name_finds_folders_and_files_by_its_words_nearest_and_closest_first() {
        let home = Home::new();
        let deep = home.folder("Documents/Clients/2026/Market research");
        let near = home.folder("Documents/market-research");
        let longer = home.folder("Desktop/Market research notes");
        home.file("Documents/market-research/prices.csv");
        let file = home.file("Downloads/Market Research.pdf");
        home.folder("Documents/Marketing");
        home.folder(".hidden/Market research");
        home.folder("Library/Market research");
        home.folder("Documents/Photos.photoslibrary/Market research");
        home.folder("Documents/a/b/c/d/e/f/Market research");

        let search = find("Market research", Some(&home.0), &[]);
        assert!(!search.stopped_early);
        assert_eq!(
            paths(&search),
            [
                near.to_string_lossy().as_ref(),
                deep.to_string_lossy().as_ref(),
                file.to_string_lossy().as_ref(),
                longer.to_string_lossy().as_ref(),
            ],
            "the same words first, then the file named so, then a name that holds them, never \
             hidden, app or bundle folders or deeper than five"
        );
        assert_eq!(search.found[0].kind, Kind::Folder);
        assert_eq!(search.found[0].holds, ["prices.csv"]);
        assert_eq!(search.found[2].kind, Kind::File);
        assert!(find("nothing like it", Some(&home.0), &[]).found.is_empty());
        assert!(find("  -- ", Some(&home.0), &[]).found.is_empty());
    }

    #[test]
    fn what_a_team_already_reads_comes_first_and_says_who_reads_it() {
        let home = Home::new();
        let elsewhere = Home::new();
        let read = elsewhere.folder("shared/Q3");
        home.folder("Documents/Q3 notes");
        let in_use = [
            InUse {
                path: read.clone(),
                name: "Q3 notes".to_owned(),
                by: "Market brief · Researcher".to_owned(),
            },
            // The same folder, spelled another way: still one folder, read by both.
            InUse {
                path: read.join("..").join("Q3"),
                name: "Q3 notes".to_owned(),
                by: "Writer".to_owned(),
            },
            InUse {
                path: elsewhere.at("gone"),
                name: "Q3 notes".to_owned(),
                by: "Old team".to_owned(),
            },
        ];
        let search = find("q3 notes", Some(&home.0), &in_use);
        assert_eq!(search.found.len(), 2, "{search:?}");
        assert_eq!(search.found[0].path, read.to_string_lossy());
        assert_eq!(
            search.found[0].used_by,
            ["Market brief · Researcher", "Writer"]
        );
        assert!(search.found[1].used_by.is_empty());
    }

    #[test]
    fn a_path_is_looked_up_as_it_is() {
        let home = Home::new();
        let site = home.folder("Projects/site");
        let search = find("~/Projects/site", Some(&home.0), &[]);
        assert_eq!(paths(&search), [site.to_string_lossy().as_ref()]);
        let search = find(&site.to_string_lossy(), Some(&home.0), &[]);
        assert_eq!(paths(&search), [site.to_string_lossy().as_ref()]);
        assert!(
            find(&home.at("nope").to_string_lossy(), Some(&home.0), &[])
                .found
                .is_empty()
        );
    }

    /// On a Mac, iCloud Drive and the cloud folders in `Library/CloudStorage` are searched too,
    /// though the rest of `Library` is not.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_mac_s_cloud_folders_are_searched() {
        let home = Home::new();
        let icloud = home.folder("Library/Mobile Documents/com~apple~CloudDocs/Work/Client notes");
        let drive = home.folder("Library/CloudStorage/GoogleDrive-me/My Drive/Client notes");
        home.folder("Library/Application Support/Client notes");
        let search = find("Client notes", Some(&home.0), &[]);
        let mut found = paths(&search);
        found.sort_unstable();
        let mut expected = [
            icloud.to_string_lossy().into_owned(),
            drive.to_string_lossy().into_owned(),
        ];
        expected.sort();
        assert_eq!(found, expected);
    }

    /// A folder near the top that the computer doesn't let it open is named, so Ask can say why it
    /// found nothing there; one further down is passed over.
    #[cfg(unix)]
    #[test]
    fn a_folder_it_may_not_open_is_named() {
        use std::os::unix::fs::PermissionsExt;
        let home = Home::new();
        let documents = home.folder("Documents");
        let deeper = home.folder("Desktop/Work/Private");
        home.folder("Downloads/Client notes");
        let shut = |path: &Path, mode| {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("permissions");
        };
        shut(&documents, 0o000);
        shut(&deeper, 0o000);
        // Run as an administrator, nothing is refused, and there is nothing to show.
        let refused = fs::read_dir(&documents).is_err();
        let search = find("Client notes", Some(&home.0), &[]);
        shut(&documents, 0o755);
        shut(&deeper, 0o755);
        assert_eq!(search.found.len(), 1);
        if refused {
            assert_eq!(search.not_allowed, ["Documents"]);
        }
    }

    #[test]
    fn a_search_stops_once_it_has_enough() {
        let home = Home::new();
        for n in 0..(MAX_FOUND * 4 + 3) {
            home.folder(&format!("Documents/report {n:02}"));
        }
        let search = find("report", Some(&home.0), &[]);
        assert!(search.stopped_early);
        assert_eq!(search.found.len(), MAX_FOUND);
    }
}

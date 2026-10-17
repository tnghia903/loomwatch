//! Reading, searching and changing files. Each call was allowed by the permission policy for the
//! exact path it names before it reaches here.

use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use regex::RegexBuilder;
use serde_json::Value;

use super::{Builtin, Output, resolve, shown};

/// Folders nobody wants listed or searched: dependencies, version control, and `LoomWatch`'s own
/// workspaces.
const SKIPPED: [&str; 7] = [
    ".git",
    "node_modules",
    ".loomwatch",
    "target",
    "dist",
    ".venv",
    "__pycache__",
];
/// The most a file read takes in; a larger file is read in parts.
const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_LINES: usize = 2000;
/// Longest line shown; minified files would otherwise flood the context.
const MAX_LINE_CHARS: usize = 2000;
const MAX_LISTED: usize = 1000;
const MAX_MATCHES: usize = 200;
/// Files larger than this are skipped by a search.
const MAX_SEARCHED_BYTES: u64 = 2 * 1024 * 1024;

pub(super) fn run(tool: Builtin, input: &Value, cwd: &Path) -> Output {
    let path = |key: &str| resolve(cwd, input.get(key).and_then(Value::as_str).unwrap_or("."));
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default();
    match tool {
        Builtin::ListFiles => list(
            cwd,
            &path("path"),
            input.get("recursive").and_then(Value::as_bool) == Some(true),
        ),
        Builtin::ReadFile => read(
            cwd,
            &path("path"),
            number(input, "offset").unwrap_or(1).max(1),
            number(input, "limit").unwrap_or(DEFAULT_LINES).max(1),
        ),
        Builtin::SearchFiles => search(
            cwd,
            &path("path"),
            text("pattern"),
            input.get("glob").and_then(Value::as_str),
            input.get("ignore_case").and_then(Value::as_bool) == Some(true),
        ),
        Builtin::WriteFile => write(cwd, &path("path"), text("content")),
        Builtin::EditFile => edit(
            cwd,
            &path("path"),
            text("old_text"),
            text("new_text"),
            input.get("replace_all").and_then(Value::as_bool) == Some(true),
        ),
        Builtin::RunCommand | Builtin::UpdatePlan | Builtin::ReadToolOutput => {
            Output::failed("Not a file tool.")
        }
    }
}

fn number(input: &Value, key: &str) -> Option<usize> {
    input
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn list(cwd: &Path, folder: &Path, recursive: bool) -> Output {
    if !folder.is_dir() {
        return Output::failed(format!("{} is not a folder.", shown(cwd, folder)));
    }
    let mut entries = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    let mut truncated = false;
    while let Some(current) = pending.pop() {
        let Ok(read) = fs::read_dir(&current) else {
            continue;
        };
        let mut children: Vec<_> = read.filter_map(Result::ok).collect();
        children.sort_by_key(fs::DirEntry::file_name);
        for child in children {
            if entries.len() >= MAX_LISTED {
                truncated = true;
                break;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            let path = child.path();
            let relative = path
                .strip_prefix(folder)
                .unwrap_or(&path)
                .display()
                .to_string();
            // Symlinks are listed but not followed, so a loop can't run the listing forever.
            let kind = child.file_type();
            let is_dir = kind.as_ref().is_ok_and(fs::FileType::is_dir);
            if is_dir {
                entries.push(format!("{relative}/"));
                if recursive && !SKIPPED.contains(&name.as_str()) {
                    pending.push(path);
                }
            } else {
                entries.push(relative);
            }
        }
        if truncated {
            break;
        }
    }
    if entries.is_empty() {
        return Output::ok(format!("{} is empty.", shown(cwd, folder)));
    }
    entries.sort();
    let mut text = entries.join("\n");
    if truncated {
        let _ = write!(text, "\n… only the first {MAX_LISTED} entries are shown.");
    }
    Output::ok(text)
}

fn read(cwd: &Path, file: &Path, offset: usize, limit: usize) -> Output {
    let shown_path = shown(cwd, file);
    let Ok(metadata) = fs::metadata(file) else {
        return Output::failed(format!("{shown_path} doesn't exist."));
    };
    if metadata.is_dir() {
        return Output::failed(format!("{shown_path} is a folder; use list_files."));
    }
    let mut bytes = Vec::new();
    let read = fs::File::open(file).and_then(|handle| {
        handle
            .take(MAX_READ_BYTES)
            .read_to_end(&mut bytes)
            .map(|_| ())
    });
    if let Err(error) = read {
        return Output::failed(format!("{shown_path} couldn't be read: {error}"));
    }
    if looks_binary(&bytes) {
        return Output::failed(format!(
            "{shown_path} is not a text file ({} bytes); read_file shows text only.",
            metadata.len()
        ));
    }
    let text = String::from_utf8_lossy(&bytes);
    let total = text.lines().count();
    if total == 0 {
        return Output::ok(format!("{shown_path} is empty."));
    }
    if offset > total {
        return Output::failed(format!(
            "{shown_path} has {total} lines; offset {offset} is past the end."
        ));
    }
    let mut out = String::new();
    for (number, line) in text.lines().enumerate().skip(offset - 1).take(limit) {
        let line: String = line.chars().take(MAX_LINE_CHARS).collect();
        let _ = writeln!(out, "{:>6}\t{line}", number + 1);
    }
    let last = (offset - 1 + limit).min(total);
    if last < total {
        let _ = writeln!(
            out,
            "… lines {offset}–{last} of {total}. Read on with offset {}.",
            last + 1
        );
    }
    if metadata.len() > MAX_READ_BYTES {
        out.push_str("… only the first 10 MB of this file can be read.\n");
    }
    Output::ok(out)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&byte| byte == 0)
}

fn search(cwd: &Path, root: &Path, pattern: &str, glob: Option<&str>, ignore_case: bool) -> Output {
    let regex = match RegexBuilder::new(pattern)
        .case_insensitive(ignore_case)
        .size_limit(1 << 20)
        .build()
    {
        Ok(regex) => regex,
        Err(error) => {
            return Output::failed(format!(
                "That pattern isn't a valid regular expression: {error}"
            ));
        }
    };
    let mut files = Vec::new();
    collect_files(root, glob, &mut files);
    let mut matches = Vec::new();
    'files: for file in files {
        let Ok(text) = fs::read(&file) else {
            continue;
        };
        if looks_binary(&text) {
            continue;
        }
        let text = String::from_utf8_lossy(&text);
        for (number, line) in text.lines().enumerate() {
            if regex.is_match(line) {
                let line: String = line.trim().chars().take(300).collect();
                matches.push(format!("{}:{}: {line}", shown(cwd, &file), number + 1));
                if matches.len() >= MAX_MATCHES {
                    matches.push(format!("… only the first {MAX_MATCHES} matches are shown."));
                    break 'files;
                }
            }
        }
    }
    if matches.is_empty() {
        Output::ok(format!("No matches for {pattern}."))
    } else {
        Output::ok(matches.join("\n"))
    }
}

fn collect_files(root: &Path, glob: Option<&str>, files: &mut Vec<PathBuf>) {
    if root.is_file() {
        files.push(root.to_path_buf());
        return;
    }
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let Ok(read) = fs::read_dir(&folder) else {
            continue;
        };
        for child in read.filter_map(Result::ok) {
            let Ok(kind) = child.file_type() else {
                continue;
            };
            let name = child.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if !SKIPPED.contains(&name.as_str()) {
                    pending.push(child.path());
                }
            } else if kind.is_file()
                && glob.is_none_or(|glob| name_matches(&name, glob))
                && child
                    .metadata()
                    .is_ok_and(|meta| meta.len() <= MAX_SEARCHED_BYTES)
            {
                files.push(child.path());
            }
        }
        if files.len() > 50_000 {
            break;
        }
    }
    files.sort();
}

/// A small glob: `*` matches anything, everything else matches itself.
fn name_matches(name: &str, glob: &str) -> bool {
    let parts: Vec<&str> = glob.split('*').collect();
    if parts.len() == 1 {
        return name == glob;
    }
    let mut rest = name;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if index == 0 {
            let Some(after) = rest.strip_prefix(part) else {
                return false;
            };
            rest = after;
        } else if index == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            let Some(found) = rest.find(part) else {
                return false;
            };
            rest = &rest[found + part.len()..];
        }
    }
    true
}

fn write(cwd: &Path, file: &Path, content: &str) -> Output {
    let shown_path = shown(cwd, file);
    if file.is_dir() {
        return Output::failed(format!("{shown_path} is a folder."));
    }
    if let Some(parent) = file.parent()
        && let Err(error) = fs::create_dir_all(parent)
    {
        return Output::failed(format!(
            "The folder for {shown_path} couldn't be made: {error}"
        ));
    }
    let existed = file.exists();
    match fs::write(file, content) {
        Ok(()) => Output::ok(format!(
            "{} {shown_path} ({} bytes).",
            if existed { "Replaced" } else { "Created" },
            content.len()
        )),
        Err(error) => Output::failed(format!("{shown_path} couldn't be written: {error}")),
    }
}

fn edit(cwd: &Path, file: &Path, old: &str, new: &str, all: bool) -> Output {
    let shown_path = shown(cwd, file);
    if old.is_empty() {
        return Output::failed("old_text is empty; to write a whole file, use write_file.");
    }
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) => return Output::failed(format!("{shown_path} couldn't be read: {error}")),
    };
    let count = text.matches(old).count();
    if count == 0 {
        return Output::failed(format!(
            "old_text doesn't appear in {shown_path}. Read the file again and copy the text exactly."
        ));
    }
    if count > 1 && !all {
        return Output::failed(format!(
            "old_text appears {count} times in {shown_path}. Include more of the surrounding text, \
             or set replace_all."
        ));
    }
    let changed = if all {
        text.replace(old, new)
    } else {
        text.replacen(old, new, 1)
    };
    match fs::write(file, changed) {
        Ok(()) => Output::ok(format!(
            "Edited {shown_path}: replaced {} occurrence{}.",
            if all { count } else { 1 },
            if all && count > 1 { "s" } else { "" }
        )),
        Err(error) => Output::failed(format!("{shown_path} couldn't be written: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Folder(PathBuf);

    impl Folder {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("loomwatch-agent-files-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn write_read_edit_and_search_a_file() {
        let folder = Folder::new();
        let cwd = &folder.0;
        let wrote = run(
            Builtin::WriteFile,
            &json!({"path": "notes/plan.md", "content": "one\ntwo\ntwo\n"}),
            cwd,
        );
        assert!(!wrote.failed, "{}", wrote.text);
        let read = run(
            Builtin::ReadFile,
            &json!({"path": "notes/plan.md", "offset": 2, "limit": 1}),
            cwd,
        );
        assert_eq!(
            read.text,
            "     2\ttwo\n… lines 2–2 of 3. Read on with offset 3.\n"
        );

        let twice = run(
            Builtin::EditFile,
            &json!({"path": "notes/plan.md", "old_text": "two", "new_text": "2"}),
            cwd,
        );
        assert!(twice.failed && twice.text.contains("appears 2 times"));
        let all = run(
            Builtin::EditFile,
            &json!({"path": "notes/plan.md", "old_text": "two", "new_text": "2", "replace_all": true}),
            cwd,
        );
        assert!(!all.failed);
        assert_eq!(
            fs::read_to_string(cwd.join("notes/plan.md")).unwrap(),
            "one\n2\n2\n"
        );

        let found = run(
            Builtin::SearchFiles,
            &json!({"pattern": "^2$", "glob": "*.md"}),
            cwd,
        );
        assert_eq!(found.text, "notes/plan.md:2: 2\nnotes/plan.md:3: 2");
        let listed = run(Builtin::ListFiles, &json!({"recursive": true}), cwd);
        assert_eq!(listed.text, "notes/\nnotes/plan.md");
    }

    #[test]
    fn binary_files_and_missing_files_are_said_plainly() {
        let folder = Folder::new();
        fs::write(folder.0.join("image.png"), [0x89, b'P', 0, 0]).unwrap();
        let binary = run(Builtin::ReadFile, &json!({"path": "image.png"}), &folder.0);
        assert!(binary.failed && binary.text.contains("not a text file"));
        let missing = run(Builtin::ReadFile, &json!({"path": "nope.md"}), &folder.0);
        assert!(missing.failed && missing.text.contains("doesn't exist"));
    }

    #[test]
    fn globs_match_names() {
        assert!(name_matches("report.md", "*.md"));
        assert!(name_matches("report-final.md", "report*.md"));
        assert!(!name_matches("report.txt", "*.md"));
        assert!(name_matches("Makefile", "Makefile"));
    }
}

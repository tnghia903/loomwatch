//! Swapping the fixed texts for files: the `prompt-overrides` feature, for the quality bench only.
//!
//! `loomwatchd --dump-prompt-blocks <dir>` writes each block as `<dir>/<id>.md`. An improver edits
//! some of them, and `LOOMWATCH_PROMPT_OVERRIDES=<dir>` starts `LoomWatch` with each `<id>.md`
//! there in place of its block, for every agent the process runs. A block with no file keeps its
//! own words. Anything else in the folder stops the start, so a misspelt id never runs quietly as
//! the default.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

use anyhow::{Context, Result, bail};

use super::{ALL, Block, placeholders};

/// The overrides this process runs with, set once at start-up.
static INSTALLED: OnceLock<Overrides> = OnceLock::new();

/// Block texts read from a folder, by block id.
#[derive(Debug, Default)]
pub(crate) struct Overrides(BTreeMap<&'static str, String>);

impl Overrides {
    /// `<id>.md` for each block that has one in `dir`, with the line break an editor leaves at its
    /// end taken off.
    ///
    /// Refused: any other file or folder, apart from hidden ones such as `.DS_Store`; and a
    /// `{placeholder}` the block doesn't fill, which would reach the agent as written.
    pub(crate) fn read(dir: &Path) -> Result<Self> {
        let entries = std::fs::read_dir(dir)
            .with_context(|| format!("could not read the prompt overrides in {}", dir.display()))?;
        let mut texts = BTreeMap::new();
        let mut unknown = Vec::new();
        for entry in entries {
            let entry = entry.with_context(|| format!("could not read {}", dir.display()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let block = name
                .strip_suffix(".md")
                .and_then(|id| ALL.iter().find(|block| block.id == id));
            let Some(block) = block.filter(|_| entry.path().is_file()) else {
                unknown.push(name);
                continue;
            };
            let text = std::fs::read_to_string(entry.path())
                .with_context(|| format!("could not read {}", entry.path().display()))?;
            let text = text.trim_end().to_owned();
            let unfilled: Vec<&str> = placeholders(&text)
                .into_iter()
                .filter(|name| !placeholders(block.default).contains(name))
                .collect();
            if !unfilled.is_empty() {
                let fills = match shown_placeholders(*block) {
                    none if none.is_empty() => "it fills none".to_owned(),
                    some => format!("it fills {some}"),
                };
                bail!(
                    "{name} uses {{{}}}, which {} does not fill: {fills}",
                    unfilled.join("}, {"),
                    block.id,
                );
            }
            texts.insert(block.id, text);
        }
        if !unknown.is_empty() {
            unknown.sort();
            bail!(
                "{} holds {}, which {} not a prompt block. Each file must be <id>.md for an id \
                 that `loomwatchd --dump-prompt-blocks` writes.",
                dir.display(),
                unknown.join(", "),
                if unknown.len() == 1 { "is" } else { "are" }
            );
        }
        Ok(Self(texts))
    }

    pub(crate) fn get(&self, id: &str) -> Option<&str> {
        self.0.get(id).map(String::as_str)
    }
}

/// Every block's text replaced by its file in `dir`, for the rest of this process. Called once, at
/// start-up, before any agent is given a prompt. Answers how many blocks were replaced.
///
/// # Errors
///
/// When `dir` can't be read, holds anything but `<id>.md` files for known ids, or a file uses a
/// placeholder its block doesn't fill; or when overrides were already installed.
pub fn install(dir: &Path) -> Result<usize> {
    let overrides = Overrides::read(dir)?;
    let replaced = overrides.0.len();
    INSTALLED
        .set(overrides)
        .map_err(|_| anyhow::anyhow!("prompt overrides were already installed"))?;
    Ok(replaced)
}

/// The override for block `id`, if one was installed.
pub(super) fn text(id: &str) -> Option<&'static str> {
    #[cfg(test)]
    if let Some(scoped) = SCOPED.with(std::cell::Cell::get) {
        return scoped.get(id);
    }
    INSTALLED.get()?.get(id)
}

/// Writes every block's text as it stands, overrides included, to `<dir>/<id>.md`, creating `dir`
/// as needed, and answers one line per block: its id and its placeholders.
///
/// # Errors
///
/// When `dir` can't be made or a file can't be written.
pub fn dump(dir: &Path) -> Result<Vec<String>> {
    std::fs::create_dir_all(dir).with_context(|| format!("could not make {}", dir.display()))?;
    let mut lines = Vec::new();
    for block in ALL {
        let path = dir.join(format!("{}.md", block.id));
        std::fs::write(&path, format!("{}\n", block.text()))
            .with_context(|| format!("could not write {}", path.display()))?;
        lines.push(
            format!("{}  {}", block.id, shown_placeholders(*block))
                .trim_end()
                .to_owned(),
        );
    }
    Ok(lines)
}

/// A block's placeholders as an override may use them: `{name} {team}`.
fn shown_placeholders(block: Block) -> String {
    placeholders(block.default)
        .iter()
        .map(|name| format!("{{{name}}}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
thread_local! {
    /// What a test runs with instead of [`INSTALLED`], on its own thread only, so a test that
    /// overrides a block never changes another test's prompts.
    static SCOPED: std::cell::Cell<Option<&'static Overrides>> = const {
        std::cell::Cell::new(None)
    };
}

/// Runs `run` with `overrides` in place of the installed ones, on this thread.
#[cfg(test)]
pub(crate) fn scoped<R>(overrides: Overrides, run: impl FnOnce() -> R) -> R {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            SCOPED.with(|scoped| scoped.set(None));
        }
    }
    let leaked: &'static Overrides = Box::leak(Box::new(overrides));
    SCOPED.with(|scoped| scoped.set(Some(leaked)));
    let _reset = Reset;
    run()
}

#[cfg(test)]
impl Overrides {
    /// Overrides from `(id, text)` pairs, for a test.
    pub(crate) fn of(texts: impl IntoIterator<Item = (&'static str, String)>) -> Self {
        Self(texts.into_iter().collect())
    }
}

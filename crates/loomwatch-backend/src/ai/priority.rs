//! What the person leans to when `LoomWatch` chooses agents' models: Saving, Balance or Highest
//! quality (ADR 0112). One setting, kept in the state folder and said in `GET /api/ai`, so Ask,
//! the jobs it starts agents from, `LoomWatch`'s own check of an answer and the app's model
//! suggestions all choose from the same column of `schemas/model-tiers.json`.
//!
//! - `PUT /api/ai/priority` changes it: `{"priority": "saving" | "balance" | "quality"}`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{MODEL_TIERS, Priority};

const FILE: &str = "model-priority.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    priority: Option<Priority>,
}

/// Where the priority is kept.
#[derive(Debug)]
pub(super) struct PriorityFile {
    path: PathBuf,
    /// One change at a time, so two never undo each other.
    writing: std::sync::Mutex<()>,
}

impl PriorityFile {
    pub(super) fn new(state_dir: &Path) -> Self {
        Self {
            path: state_dir.join(FILE),
            writing: std::sync::Mutex::new(()),
        }
    }

    /// The priority chosen, else the table's default. A file that can't be read is the default:
    /// choosing models never fails over it.
    pub(super) fn read(&self) -> Priority {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
            .and_then(|saved| saved.priority)
            .unwrap_or(MODEL_TIERS.default_priority)
    }

    pub(super) fn write(&self, priority: Priority) -> std::io::Result<()> {
        let _writing = self
            .writing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let text = serde_json::to_vec_pretty(&Saved {
            priority: Some(priority),
        })
        .map_err(std::io::Error::other)?;
        crate::approvals::write_private(&self.path, &text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A new install starts on the table's default, and a choice is kept across restarts.
    #[test]
    fn the_priority_starts_on_the_default_and_is_kept() {
        let folder =
            std::env::temp_dir().join(format!("loomwatch-priority-{}", uuid::Uuid::new_v4()));
        let file = PriorityFile::new(&folder);
        assert_eq!(file.read(), MODEL_TIERS.default_priority);
        file.write(Priority::Saving).unwrap();
        assert_eq!(PriorityFile::new(&folder).read(), Priority::Saving);
        std::fs::write(folder.join(FILE), b"{\"priority\": \"cheapest\"}").unwrap();
        assert_eq!(file.read(), MODEL_TIERS.default_priority);
        let _ = std::fs::remove_dir_all(&folder);
    }
}

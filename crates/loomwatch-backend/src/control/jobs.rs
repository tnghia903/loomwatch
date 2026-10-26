//! `LoomWatch`'s built-in jobs, as Ask builds teams from them (ADR 0096).
//!
//! `schemas/built-in-jobs.json` is the one list: the app places the same jobs from its palette,
//! templates and agent builder (`ui/src/lib/library/roles.ts`), so an agent Ask starts from a job
//! begins with the instructions, Done when and switches a person placing it would get, and runs
//! on the model and effort `schemas/model-tiers.json` gives that job.

use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Value, json};

/// One built-in job. The file's `icon` and `$comment`s are the app's and its readers'.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuiltInJob {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) does: String,
    /// The switches the job cannot be done without, as a team file's `allow:` writes them.
    #[serde(default)]
    pub(super) allow: Option<Value>,
    pub(super) done_when: Vec<String>,
    /// Its instructions, line by line.
    pub(super) role: Vec<String>,
}

impl BuiltInJob {
    pub(super) fn role(&self) -> String {
        self.role.join("\n")
    }

    /// The model and thinking effort an agent doing this job starts on, as the app's templates and
    /// palette place it.
    pub(super) fn model(&self) -> (String, String) {
        let tiers = &*crate::ai::MODEL_TIERS;
        let needs = tiers.jobs.get(&self.id).unwrap_or(&tiers.new_agent);
        let (_, effort) = tiers.choose(needs);
        (super::tier_model(&needs.tier), effort.to_owned())
    }

    /// The job as `list_jobs` lists it: enough to choose one.
    pub(super) fn listed(&self) -> Value {
        let (model, effort) = self.model();
        json!({
            "job": self.id,
            "name": self.label,
            "does": self.does,
            "model": model,
            "thinkingEffort": effort,
            "allow": self.allow,
        })
    }

    /// The job as `read_job` gives it: all an agent written from it needs.
    pub(super) fn read(&self) -> Value {
        let mut value = self.listed();
        value["role"] = json!(self.role());
        value["doneWhen"] = json!(self.done_when);
        value
    }
}

#[derive(Deserialize)]
struct JobsFile {
    jobs: Vec<BuiltInJob>,
}

/// Every built-in job, in the palette's order.
pub(super) static BUILT_IN_JOBS: LazyLock<Vec<BuiltInJob>> = LazyLock::new(|| {
    serde_json::from_str::<JobsFile>(include_str!("../../../../schemas/built-in-jobs.json"))
        .expect("schemas/built-in-jobs.json is the list of built-in jobs")
        .jobs
});

/// The built-in job called `id`, ignoring case.
pub(super) fn named(id: &str) -> Option<&'static BuiltInJob> {
    BUILT_IN_JOBS
        .iter()
        .find(|job| job.id.eq_ignore_ascii_case(id.trim()))
}

#[cfg(test)]
mod tests {
    use super::{BUILT_IN_JOBS, named};

    /// Every job the app places is one the daemon reads, with the shape every built-in role keeps
    /// and its own row in the model table, so Ask never starts an agent the app would place
    /// differently.
    #[test]
    fn every_built_in_job_reads_with_its_shape_and_its_models() {
        let tiers = &*crate::ai::MODEL_TIERS;
        assert_eq!(BUILT_IN_JOBS.len(), 15);
        for job in BUILT_IN_JOBS.iter() {
            assert!(tiers.jobs.contains_key(&job.id), "{} has no tiers", job.id);
            let role = job.role();
            assert!(
                role.contains("Before you reply") && role.contains("Reply"),
                "{}: {role}",
                job.id
            );
            assert!((2..=5).contains(&job.done_when.len()), "{}", job.id);
            assert!(!job.does.is_empty() && !job.label.is_empty(), "{}", job.id);
        }
        let researcher = named("Researcher").expect("the researcher job");
        assert_eq!(researcher.allow, Some(serde_json::json!({"web": true})));
        assert_eq!(
            researcher.read()["thinkingEffort"],
            tiers.efforts[&tiers.jobs["researcher"].effort]
        );
        assert!(
            named("checker")
                .expect("the checker job")
                .role()
                .contains("## Check")
        );
        assert!(named("nobody").is_none());
    }
}

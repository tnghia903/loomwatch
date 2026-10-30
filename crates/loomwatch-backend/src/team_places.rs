//! One team in several projects (ADR 0103).
//!
//! A team set up once can work in several projects. Each project has the team's own place there:
//! a team file of its own, so its chat, run history, approval, files it made, schedule and Brief
//! are that project's. Every place of one team names the same `shares:` id, and everything in the
//! file but a place's own keys ([`PLACE_KEYS`]) is the team's setup, the same in every place:
//! saving one place writes its setup into the others ([`spread`]), as a change to one of My agents
//! reaches every team it is in (ADR 0094).

use std::path::Path;

use serde_yaml::{Mapping, Value};

/// The top-level keys that are a place's own. Its `id` files its chat, notes and approval; its
/// `project` is where it works; its `schedule`, `deliver` and `memory` (the Brief beside its file)
/// are that project's. `shares` is the same in every place, and kept as the place has it.
pub const PLACE_KEYS: [&str; 6] = ["id", "project", "schedule", "deliver", "memory", "shares"];

fn is_place_key(key: &Value) -> bool {
    key.as_str().is_some_and(|key| PLACE_KEYS.contains(&key))
}

fn mapping(text: &str) -> Result<Mapping, String> {
    match serde_yaml::from_str::<Value>(text) {
        Ok(Value::Mapping(mapping)) => Ok(mapping),
        Ok(_) => Err("it isn't a team".to_owned()),
        Err(error) => Err(error.to_string()),
    }
}

/// The `shares:` id in a team file's text, when it has one.
#[must_use]
pub fn shares_of(text: &str) -> Option<String> {
    serde_yaml::from_str::<Value>(text)
        .ok()?
        .get("shares")?
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// The places of the team `shares` names: each team file under `teams_root` (relative, in the
/// folder's order) whose `shares:` is that id.
#[must_use]
pub fn places(teams_root: &Path, shares: &str) -> Vec<String> {
    crate::api::discover_team_files(teams_root)
        .unwrap_or_default()
        .into_iter()
        .filter(|file| {
            std::fs::read_to_string(teams_root.join(file))
                .ok()
                .and_then(|text| shares_of(&text))
                .as_deref()
                == Some(shares)
        })
        .collect()
}

/// `place` with `setup`'s setup: every top-level key of `setup` but the [`PLACE_KEYS`], which keep
/// the place's own values, or stay absent when the place has none. `None` when the place has that
/// setup already, so there is nothing to write.
///
/// # Errors
///
/// When either text isn't a team: a YAML mapping.
pub fn with_setup(setup: &str, place: &str) -> Result<Option<String>, String> {
    let setup = mapping(setup)?;
    let own = mapping(place)?;
    let mut next = Mapping::new();
    for (key, value) in &setup {
        if !is_place_key(key) {
            next.insert(key.clone(), value.clone());
        } else if let Some(kept) = own.get(key) {
            next.insert(key.clone(), kept.clone());
        }
    }
    for key in PLACE_KEYS {
        let key = Value::String(key.to_owned());
        if !next.contains_key(&key)
            && let Some(kept) = own.get(&key)
        {
            next.insert(key, kept.clone());
        }
    }
    if next == own {
        return Ok(None);
    }
    serde_yaml::to_string(&Value::Mapping(next))
        .map(Some)
        .map_err(|error| error.to_string())
}

/// One other place a save changes: its path (relative to the teams root), its text before, after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spread {
    pub path: String,
    pub before: String,
    pub after: String,
}

/// What saving `saved_yaml` at `saved` (relative to `teams_root`) changes in the team's other
/// places: the setup written into each one that hasn't it. Empty for a team in one place.
///
/// # Errors
///
/// Names a place that can't be read as a team, before anything is written: the save waits until
/// it is put right (or taken out), so no place is left with an older setup unawares.
pub fn spread(teams_root: &Path, saved: &str, saved_yaml: &str) -> Result<Vec<Spread>, String> {
    let Some(shares) = shares_of(saved_yaml) else {
        return Ok(Vec::new());
    };
    let mut changes = Vec::new();
    for path in places(teams_root, &shares) {
        if path == saved {
            continue;
        }
        let before = std::fs::read_to_string(teams_root.join(&path))
            .map_err(|error| format!("{path}: {error}"))?;
        if let Some(after) =
            with_setup(saved_yaml, &before).map_err(|error| format!("{path}: {error}"))?
        {
            changes.push(Spread {
                path,
                before,
                after,
            });
        }
    }
    Ok(changes)
}

/// An id for a new `shares:` from `base` (the first place's own id) that no team file under
/// `teams_root` uses as its `shares:` yet.
#[must_use]
pub fn free_shares(teams_root: &Path, base: &str) -> String {
    let taken: Vec<String> = crate::api::discover_team_files(teams_root)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| {
            std::fs::read_to_string(teams_root.join(file))
                .ok()
                .and_then(|text| shares_of(&text))
        })
        .collect();
    let mut id = base.to_owned();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

/// `text` naming `shares` as the team it shares its setup with: a `shares:` line after its top-level
/// `id:` line (or first, when it has none). Nothing else in the file changes, comments included.
/// `None` when it names one already.
#[must_use]
pub fn with_shares(text: &str, shares: &str) -> Option<String> {
    if shares_of(text).is_some() {
        return None;
    }
    let line = format!("shares: {shares}\n");
    let mut out = String::with_capacity(text.len() + line.len());
    let mut set = false;
    for part in text.split_inclusive('\n') {
        out.push_str(part);
        if !set && part.starts_with("id:") {
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&line);
            set = true;
        }
    }
    if !set {
        out = format!("{line}{out}");
    }
    (shares_of(&out).as_deref() == Some(shares)).then_some(out)
}

/// The team's new place in `project`: `source`'s setup under its own `id`, with no schedule and no
/// delivery of its own yet (those are the project's to set), and the same `shares:`.
///
/// # Errors
///
/// When `source` isn't a team.
pub fn new_place(source: &str, id: &str, project: &str, shares: &str) -> Result<String, String> {
    let source = mapping(source)?;
    let mut next = Mapping::new();
    let text = |value: &str| Value::String(value.to_owned());
    for (key, value) in &source {
        match key.as_str() {
            Some("schedule" | "deliver" | "project" | "shares") => {}
            Some("id") => {
                next.insert(key.clone(), text(id));
                next.insert(text("shares"), text(shares));
                next.insert(text("project"), text(project));
            }
            _ => {
                next.insert(key.clone(), value.clone());
            }
        }
    }
    if !next.contains_key(text("id")) {
        next.insert(text("id"), text(id));
        next.insert(text("shares"), text(shares));
        next.insert(text("project"), text(project));
    }
    serde_yaml::to_string(&Value::Mapping(next)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct Folder(PathBuf);

    impl Folder {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tempdir() -> Folder {
        let path = std::env::temp_dir().join(format!("loomwatch-places-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("a folder");
        Folder(crate::platform::canonicalize(&path).expect("a canonical folder"))
    }

    const COFFEE: &str = "schemaVersion: 1\nid: market-research\nshares: market-research\nname: Market research\nproject: coffee\n# who looks first\nentrypoint: researcher\nagents:\n  - id: researcher\n    from:\n      agent: researcher\nedges: []\nschedule:\n  cron: \"0 8 * * 1\"\n  prompt: Weekly prices\nspend:\n  perRun: 1\n";
    const BIKES: &str = "schemaVersion: 1\nid: market-research-bikes\nshares: market-research\nname: Market research\nproject: bikes\nentrypoint: researcher\nagents:\n  - id: researcher\n    from:\n      agent: researcher\nedges: []\nspend:\n  perRun: 1\nmemory:\n  enabled: true\n";

    fn value(text: &str) -> Value {
        serde_yaml::from_str(text).unwrap()
    }

    #[test]
    fn a_place_takes_the_setup_and_keeps_its_own() {
        let setup = COFFEE
            .replace("perRun: 1", "perRun: 2")
            .replace("name: Market research", "name: Prices");
        let after = with_setup(&setup, BIKES)
            .unwrap()
            .expect("the setup changed");
        let after = value(&after);
        // The setup: from the saved place.
        assert_eq!(after["name"], value("Prices"));
        assert_eq!(after["spend"]["perRun"], value("2"));
        // Its own: id, project, Brief; and no schedule, as it had none.
        assert_eq!(after["id"], value("market-research-bikes"));
        assert_eq!(after["project"], value("bikes"));
        assert_eq!(after["memory"]["enabled"], value("true"));
        assert!(after.get("schedule").is_none());
        // The other way, the place's schedule stays and the saved one's Brief doesn't arrive.
        let back = value(
            &with_setup(&BIKES.replace("perRun: 1", "perRun: 5"), COFFEE)
                .unwrap()
                .unwrap(),
        );
        assert_eq!(back["spend"]["perRun"], value("5"));
        assert_eq!(back["schedule"]["prompt"], value("Weekly prices"));
        assert!(back.get("memory").is_none());
        assert_eq!(back["project"], value("coffee"));
    }

    #[test]
    fn a_place_with_the_setup_already_is_left_alone() {
        assert_eq!(with_setup(COFFEE, BIKES).unwrap(), None);
        assert_eq!(with_setup(BIKES, COFFEE).unwrap(), None);
        assert!(with_setup("- a list", BIKES).is_err());
    }

    #[test]
    fn a_save_reaches_every_other_place_and_only_those() {
        let root = tempdir();
        std::fs::write(root.path().join("coffee.yaml"), COFFEE).unwrap();
        std::fs::write(root.path().join("bikes.yaml"), BIKES).unwrap();
        let other = BIKES
            .replace("shares: market-research", "shares: other")
            .replace("id: market-research-bikes", "id: other");
        std::fs::write(root.path().join("other.yaml"), &other).unwrap();
        assert_eq!(
            places(root.path(), "market-research"),
            ["bikes.yaml", "coffee.yaml"]
        );
        let saved = COFFEE.replace("perRun: 1", "perRun: 3");
        let changes = spread(root.path(), "coffee.yaml", &saved).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "bikes.yaml");
        assert_eq!(changes[0].before, BIKES);
        assert_eq!(value(&changes[0].after)["spend"]["perRun"], value("3"));
        // A team in one place, or with nothing new, changes nothing else.
        assert!(
            spread(root.path(), "other.yaml", &other)
                .unwrap()
                .is_empty()
        );
        assert!(
            spread(root.path(), "coffee.yaml", COFFEE)
                .unwrap()
                .is_empty()
        );
        // A file that isn't YAML can't be known as a place: it is left as it is.
        std::fs::write(
            root.path().join("bikes.yaml"),
            "shares: market-research\nagents: [unclosed\n",
        )
        .unwrap();
        assert!(
            spread(root.path(), "coffee.yaml", &saved)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_new_place_is_the_setup_in_another_project_with_nothing_of_the_old_ones() {
        let place =
            value(&new_place(COFFEE, "market-research-bikes", "bikes", "market-research").unwrap());
        assert_eq!(place["id"], value("market-research-bikes"));
        assert_eq!(place["project"], value("bikes"));
        assert_eq!(place["shares"], value("market-research"));
        assert_eq!(place["name"], value("Market research"));
        assert!(place.get("schedule").is_none());
        assert_eq!(place["agents"][0]["from"]["agent"], value("researcher"));
        assert_eq!(place["entrypoint"], value("researcher"));
    }

    #[test]
    fn the_first_place_gets_its_shares_line_and_keeps_the_rest_as_written() {
        let alone = COFFEE.replace("shares: market-research\n", "");
        let shared = with_shares(&alone, "market-research").unwrap();
        assert_eq!(shared, COFFEE);
        assert_eq!(with_shares(COFFEE, "market-research"), None);
        let root = tempdir();
        std::fs::write(root.path().join("coffee.yaml"), COFFEE).unwrap();
        assert_eq!(
            free_shares(root.path(), "market-research"),
            "market-research-2"
        );
        assert_eq!(free_shares(root.path(), "trip"), "trip");
    }
}

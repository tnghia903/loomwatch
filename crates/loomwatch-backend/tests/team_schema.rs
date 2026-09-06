use std::fs;
use std::path::{Path, PathBuf};

use loomwatch_backend::config::TeamConfig;
use serde_json::{Value, json};

fn read_yaml(path: &Path) -> Value {
    let source = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_yaml::from_str(&source)
        .unwrap_or_else(|error| panic!("failed to parse {} as YAML: {error}", path.display()))
}

fn example_paths() -> Vec<PathBuf> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let examples_dir = workspace.join("examples");
    let mut examples: Vec<PathBuf> = fs::read_dir(&examples_dir)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", examples_dir.display()))
        .map(|entry| {
            entry
                .unwrap_or_else(|error| panic!("failed to read examples entry: {error}"))
                .path()
        })
        .filter(|path| {
            matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("yaml" | "yml")
            )
        })
        .collect();
    examples.sort();
    examples
}

#[test]
fn all_examples_load_and_validate_via_team_config() {
    let examples = example_paths();
    assert!(!examples.is_empty(), "no YAML examples found");
    for path in examples {
        TeamConfig::load(&path)
            .unwrap_or_else(|error| panic!("{} failed to load: {error:#}", path.display()));
    }
}

#[test]
fn schema_and_all_examples_are_valid() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let schema_path = workspace.join("schemas/team.schema.yaml");
    let schema = read_yaml(&schema_path);

    jsonschema::draft202012::meta::validate(&schema).unwrap_or_else(|error| {
        panic!(
            "{} is not a valid Draft 2020-12 schema: {error}",
            schema_path.display()
        );
    });
    let validator = jsonschema::draft202012::new(&schema).unwrap_or_else(|error| {
        panic!("failed to compile {}: {error}", schema_path.display());
    });

    let examples = example_paths();
    assert!(!examples.is_empty(), "no YAML examples found");

    for path in examples {
        let example = read_yaml(&path);
        let errors: Vec<String> = validator
            .iter_errors(&example)
            .map(|error| error.to_string())
            .collect();
        assert!(
            errors.is_empty(),
            "{} does not match {}:\n{}",
            path.display(),
            schema_path.display(),
            errors.join("\n")
        );
    }
}

#[test]
fn review_regressions_are_covered() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let schema = read_yaml(&workspace.join("schemas/team.schema.yaml"));
    let team_validator = jsonschema::draft202012::new(&schema)
        .unwrap_or_else(|error| panic!("failed to compile team schema: {error}"));

    let mut invalid_team = read_yaml(&workspace.join("examples/research-team.yaml"));
    invalid_team["edges"][0]["ts"] = json!("banana");
    assert!(
        !team_validator.is_valid(&invalid_team),
        "edge timestamps must reject non-RFC-3339-shaped strings"
    );
    invalid_team = read_yaml(&workspace.join("examples/research-team.yaml"));
    invalid_team["agents"][0]["spawn"]["cmd"] = json!("./bin/agent");
    assert!(
        !team_validator.is_valid(&invalid_team),
        "relative commands containing a separator must be rejected"
    );

    let event_schema = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": schema["$defs"].clone(),
        "$ref": "#/$defs/RunEvent"
    });
    let event_validator = jsonschema::draft202012::new(&event_schema)
        .unwrap_or_else(|error| panic!("failed to compile run-event schema: {error}"));
    let tool_call = json!({
        "id": "_event:1",
        "sessionId": "sess/2",
        "agentId": "researcher",
        "seq": 1,
        "ts": "2026-09-05T00:00:00Z",
        "kind": "tool_call",
        "payload": {
            "callId": "_call1",
            "title": "dispatch",
            "name": null,
            "status": "pending"
        },
        "raw": {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {}
        }
    });
    assert!(
        event_validator.is_valid(&tool_call),
        "upstream-generated event, session, and tool-call IDs must be opaque"
    );
    let result = json!({
        "id": "event/2",
        "sessionId": "sess/2",
        "agentId": "researcher",
        "seq": 2,
        "ts": "2026-09-05T00:00:01+00:00",
        "kind": "tool_update",
        "payload": {
            "callId": "call:1",
            "status": "completed",
            "rawOutput": null
        },
        "raw": {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {}
        }
    });
    assert!(
        event_validator.is_valid(&result),
        "upstream-generated tool update call IDs must be opaque"
    );

    let mut invalid_event = tool_call.clone();
    invalid_event["ts"] = json!("banana");
    assert!(
        !event_validator.is_valid(&invalid_event),
        "run-event timestamps must reject non-RFC-3339-shaped strings"
    );

    for accepted in [
        "2026-09-05T00:00:00Z",
        "2026-09-05t00:00:00z",
        "2026-09-05T00:00:00.123456+00:00",
        "2026-09-05T00:00:60Z",
    ] {
        let mut event = tool_call.clone();
        event["ts"] = json!(accepted);
        assert!(
            event_validator.is_valid(&event),
            "{accepted} is RFC 3339 and must be accepted from an upstream harness"
        );
    }
    for rejected in [
        "2026-09-05T00:00:00",
        "2026-09-05 00:00:00Z",
        "2026-09-05",
        "",
    ] {
        let mut event = tool_call.clone();
        event["ts"] = json!(rejected);
        assert!(
            !event_validator.is_valid(&event),
            "{rejected:?} is not RFC 3339 and must be rejected"
        );
    }
}

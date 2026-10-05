use std::fs;
use std::path::{Path, PathBuf};

use loomwatch_backend::config::TeamConfig;
use loomwatch_backend::memory::{PacketSectionKind, TeamMemory};
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

/// The shipped memory example must actually load its Brief off disk, not merely validate.
///
/// A schema-valid `memory:` block whose paths are wrong is the easiest way for this feature to
/// ship broken, and `TeamConfig::load` never opens a Brief file — so nothing else here would
/// notice. This also pins the `appliesTo` behaviour an operator reads the example to learn:
/// `tone.md` reaches the writer and is recorded as excluded for the researcher.
#[test]
fn the_memory_example_loads_its_brief_and_scopes_it_as_documented() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let team_path = workspace.join("examples/team-memory.yaml");
    let team = TeamConfig::load(&team_path).expect("the memory example loads");
    let memory = TeamMemory::load(
        &loomwatch_backend::memory::MemoryRoots::for_team(&team_path, None),
        &team_path,
        team.memory.as_ref(),
    )
    .unwrap_or_else(|error| panic!("the memory example's Brief must load from disk: {error}"));

    assert_eq!(
        memory
            .brief
            .iter()
            .map(|entry| entry.title.as_str())
            .collect::<Vec<_>>(),
        ["House constraints", "Audience and tone"]
    );

    let agent = |id: &str| {
        team.agents
            .iter()
            .find(|agent| agent.id == id)
            .unwrap_or_else(|| panic!("the example has an agent {id}"))
    };
    let writer = memory.packet_for(agent("writer")).expect("writer packet");
    assert!(writer.text.contains("British spelling"), "{writer:?}");
    assert!(writer.text.contains("Audience and tone"), "{writer:?}");

    let researcher = memory
        .packet_for(agent("researcher"))
        .expect("researcher packet");
    assert!(
        researcher.text.contains("British spelling"),
        "{researcher:?}"
    );
    assert!(
        !researcher.text.contains("Audience and tone"),
        "an appliesTo entry must not reach an agent outside its scope: {researcher:?}"
    );
    assert!(
        researcher.sections.iter().any(|section| {
            section.kind == PacketSectionKind::Excluded && section.rationale.contains("writer")
        }),
        "the researcher's packet must record why the scoped entry was left out: {researcher:?}"
    );
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
fn responder_is_an_optional_identifier() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let schema = read_yaml(&workspace.join("schemas/team.schema.yaml"));
    let validator = jsonschema::draft202012::new(&schema)
        .unwrap_or_else(|error| panic!("failed to compile team schema: {error}"));
    let mut team = read_yaml(&workspace.join("examples/research-team.yaml"));

    team["responder"] = json!("researcher");
    assert!(validator.is_valid(&team));

    team["responder"] = json!("");
    assert!(!validator.is_valid(&team));
}

/// ADR 0050: knowledge reads a Notion page instead of a path, never both, and only knowledge
/// may name one. The UI validates against this schema, so the rule cannot live in the loader alone.
#[test]
fn a_notion_page_is_knowledge_instead_of_a_path() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let schema = read_yaml(&workspace.join("schemas/team.schema.yaml"));
    let validator = jsonschema::draft202012::new(&schema)
        .unwrap_or_else(|error| panic!("failed to compile team schema: {error}"));
    let with_capability = |capability: Value| {
        let mut team = read_yaml(&workspace.join("examples/research-team.yaml"));
        team["agents"][0]["capabilities"] = json!([capability]);
        team
    };
    let page = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    assert!(validator.is_valid(&with_capability(
        json!({"kind": "knowledge", "name": "Roadmap", "notion": {"page": page}})
    )));
    assert!(
        validator.is_valid(&with_capability(
            json!({"kind": "knowledge", "name": "Roadmap", "notion": {"page": page.replace('-', "")}})
        )),
        "Notion writes ids without dashes in its addresses"
    );
    for (capability, why) in [
        (
            json!({"kind": "skill", "name": "Roadmap", "notion": {"page": page}}),
            "only knowledge reads Notion",
        ),
        (
            json!({"kind": "knowledge", "name": "Roadmap", "path": "notes.md", "notion": {"page": page}}),
            "a path or a page, not both",
        ),
        (
            json!({"kind": "knowledge", "name": "Roadmap", "notion": {"page": "roadmap"}}),
            "a page id",
        ),
        (
            json!({"kind": "knowledge", "name": "Roadmap", "notion": {"page": page, "teamspace": page}}),
            "no other key yet",
        ),
    ] {
        assert!(!validator.is_valid(&with_capability(capability)), "{why}");
    }
}

/// `memory.inherits` entries name exactly one of `team` and `pack`, and the schema says so rather
/// than leaving the loader as the only thing that knows.
///
/// Asserted here because no shipped example inherits anything, so the `oneOf` would otherwise be
/// a rule nothing exercises. The loader refuses both combinations too — see
/// `memory::tests` and `docs/TEAM_CONFIG.md`.
#[test]
fn an_inherits_entry_names_exactly_one_source() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let schema = read_yaml(&workspace.join("schemas/team.schema.yaml"));
    let validator = jsonschema::draft202012::new(&schema)
        .unwrap_or_else(|error| panic!("failed to compile team schema: {error}"));

    let with_inherits = |entry: Value| {
        let mut team = read_yaml(&workspace.join("examples/team-memory.yaml"));
        team["memory"]["inherits"] = json!([entry]);
        team
    };
    assert!(
        validator.is_valid(&with_inherits(
            json!({"team": "research-team", "include": ["brief", "kept"], "appliesTo": ["writer"]})
        )),
        "a team reference with a scope and an include list is valid"
    );
    assert!(
        validator.is_valid(&with_inherits(json!({"pack": "onboarding-pack.memory"}))),
        "a pack reference is valid"
    );
    assert!(
        !validator.is_valid(&with_inherits(
            json!({"team": "research-team", "pack": "p.memory"})
        )),
        "naming both a team and a pack must be rejected"
    );
    assert!(
        !validator.is_valid(&with_inherits(json!({"include": ["brief"]}))),
        "naming neither must be rejected"
    );
    assert!(
        !validator.is_valid(&with_inherits(
            json!({"team": "research-team", "include": ["everything"]})
        )),
        "include is brief | kept | both"
    );
    // And the notebook block is closed the same way every other block is.
    let mut team = read_yaml(&workspace.join("examples/team-memory.yaml"));
    team["memory"]["notebook"] = json!({"enabled": true, "keep": "auto"});
    assert!(
        !validator.is_valid(&team),
        "`auto` is deliberately absent from keep, so the schema must reject it"
    );
    team["memory"]["notebook"] = json!({"enabled": false, "keep": "never"});
    assert!(
        validator.is_valid(&team),
        "review and never are the two policies"
    );
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

/// `$defs/Agent`'s two branches, which no shipped example can exercise from both sides at once.
///
/// An operator node is not "an agent with optional fields": the `oneOf` **refuses** `spawn`,
/// `model` and `thinkingEffort` on it, because an operator node starts nothing and selects no
/// model, and a file that declared one would be saying something the daemon does not do. A
/// harness node still requires spawn and model, which is the half that would silently rot if the
/// requirement were merely moved into a branch nothing tests.
///
/// `budget` was retired by ADR 0027: it is accepted on either kind and ignored, so a team file
/// written before then stays valid.
#[test]
fn the_schema_takes_an_operator_node_without_spawn_or_model_and_refuses_a_harness_without_them() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let schema = read_yaml(&workspace.join("schemas/team.schema.yaml"));
    let validator = jsonschema::draft202012::new(&schema)
        .unwrap_or_else(|error| panic!("failed to compile team schema: {error}"));

    let with_agent = |agent: Value| {
        let mut team = read_yaml(&workspace.join("examples/operator-stop.yaml"));
        team["agents"] = json!([team["agents"][0].clone(), agent, team["agents"][2].clone()]);
        team
    };

    let stop = with_agent(json!({
        "id": "review",
        "kind": "operator",
        "name": "You",
        "role": "Approve the findings, or say what to change."
    }));
    let errors: Vec<String> = validator
        .iter_errors(&stop)
        .map(|error| error.to_string())
        .collect();
    assert!(
        errors.is_empty(),
        "an operator node needs no spawn or model:\n{}",
        errors.join("\n")
    );
    assert!(
        validator.is_valid(&with_agent(json!({
            "id": "review",
            "kind": "operator",
            "role": "Approve the findings, or say what to change."
        }))),
        "`name` defaults to You, so an operator node may omit it"
    );
    assert!(
        validator.is_valid(&with_agent(json!({
            "id": "review",
            "kind": "operator",
            "role": "Approve the findings.",
            "budget": {"limitUsd": 0}
        }))),
        "a retired `budget` on an operator node is accepted and ignored"
    );
    let mut legacy = with_agent(json!({
        "id": "review",
        "kind": "operator",
        "role": "Approve the findings."
    }));
    legacy["budget"] = json!({"limitUsd": 12.5});
    legacy["agents"][0]["budget"] = json!({"limitUsd": 3, "warnAtPercent": 70});
    assert!(
        validator.is_valid(&legacy),
        "a retired `budget` at team level or on a harness node is accepted and ignored"
    );
    for refused in ["spawn", "model", "thinkingEffort"] {
        let mut agent = json!({
            "id": "review",
            "kind": "operator",
            "name": "You",
            "role": "Approve the findings."
        });
        agent[refused] = match refused {
            "spawn" => json!({"cmd": "/bin/sh", "cwd": "."}),
            _ => json!("something"),
        };
        assert!(
            !validator.is_valid(&with_agent(agent)),
            "an operator node must not be allowed to declare {refused}"
        );
    }
    assert!(
        !validator.is_valid(&with_agent(json!({
            "id": "review",
            "name": "Review",
            "role": "Approve the findings."
        }))),
        "a harness node (no `kind`, so the default) still requires spawn and model"
    );
}

/// The loader's own rules, which the schema deliberately does not express: a document can be
/// schema-valid and still place a stop where it cannot work.
#[test]
fn the_loader_refuses_an_operator_entrypoint_and_an_operator_node_in_team_mode() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = fs::read_to_string(workspace.join("examples/operator-stop.yaml"))
        .expect("the operator-stop example is readable");
    TeamConfig::parse(&source).expect("the shipped example loads");

    // The Prompt node is already the operator at the head of a run.
    let as_entrypoint = source.replace("entrypoint: researcher", "entrypoint: review");
    let error = format!(
        "{:#}",
        TeamConfig::parse(&as_entrypoint).expect_err("an operator entrypoint is refused")
    );
    assert!(error.contains("is an operator node"), "{error}");

    // Team mode has no configured order for a stop to sit in.
    let team_mode = source
        .split("edges:")
        .next()
        .expect("the example has an edges block")
        .to_owned()
        + "edges: []\n";
    let error = format!(
        "{:#}",
        TeamConfig::parse(&team_mode).expect_err("team mode cannot hold a stop")
    );
    assert!(error.contains("team mode"), "{error}");

    // And the per-kind rules the `try_from` enforces, which produce a parse error naming the node.
    let with_model = source.replace(
        "    role: Researcher is done. Approve the findings, or say what to change.",
        "    role: Researcher is done. Approve the findings, or say what to change.\n    model: claude/sonnet",
    );
    let error = format!(
        "{:#}",
        TeamConfig::parse(&with_model).expect_err("an operator node has no model")
    );
    assert!(error.contains("kind: operator"), "{error}");
}

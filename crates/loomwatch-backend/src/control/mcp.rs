//! The `LoomWatch` Control tools (ADR 0033), as Ask's agent calls them: directly, in the daemon.
//!
//! The tools read and propose; none writes a team file or answers a review stop.

use std::path::Path;
use std::sync::OnceLock;

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::{Caller, Control, Proposal, RunRequest, lock, now};
use crate::agent::{BoxFuture, HostTools, ToolSpec};
use crate::config::{AgentKind, TeamConfig};

const MAX_REQUEST_CHARS: usize = 4_000;
const MAX_REPLY_CHARS: usize = 4_000;

/// The Control tools, for one conversation's agent.
pub(super) struct ControlTools {
    control: Control,
    caller: Caller,
    specs: Vec<ToolSpec>,
}

impl ControlTools {
    pub(super) fn new(control: Control, caller: Caller) -> Self {
        let specs = definitions()
            .iter()
            .filter_map(crate::engine::tool_spec)
            .collect();
        Self {
            control,
            caller,
            specs,
        }
    }
}

impl HostTools for ControlTools {
    fn specs(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }

    fn call<'a>(&'a self, name: &'a str, input: Value) -> BoxFuture<'a, (String, bool)> {
        Box::pin(async move {
            match call(&self.control, &self.caller, name, &input).await {
                Ok(value) => (serde_json::to_string(&value).unwrap_or_default(), false),
                Err(message) => (message, true),
            }
        })
    }
}

/// What the assistant is told once, at the top of its first turn.
pub(super) const INSTRUCTIONS: &str = r#"You are Ask LoomWatch, the assistant built into LoomWatch. LoomWatch runs teams of AI agents on this person's computer: each agent runs on an AI model through OpenRouter, and the agents work through a pipeline, handing work from one to the next. A "You" step is a review stop where the team waits for the person.

You help by reading their teams and runs and by proposing changes, using your tools. Rules:
- You cannot save files or start runs yourself. `propose_team` shows the person a proposal on the canvas; nothing is saved until they press Apply. `start_run` asks them to start the run, unless they have allowed you to start runs directly; its result tells you which. Never say something was saved, applied or started unless a tool result says so.
- Review stops belong to the person. You may explain what a team is waiting for and use `draft_review_note` to suggest a note; only they approve or send work back.
- Give each agent a model from `list_models`: its recommended models, or another OpenRouter model id the person names. Never invent a model id.
- Reply in plain words, in one to three short sentences. Don't paste team files into the chat: the proposal card shows the changes. Don't use tables.

Set agents up the way that works best, every time, without being asked; the person won't know to ask:
- Use the fewest agents that do the job. One agent is right for most requests. Add one only for work that needs a different job, a different model, or the person's review in between: each agent opens a session of its own, which costs time and money, and each handover loses detail. More than four is rarely worth it.
- Write each `role` in three parts: what the agent does and what it leaves to others; how to work, as a few short bullets ending with how it checks its work before it replies; and exactly what it replies with. A later stage receives the earlier stage's reply, so say what to hand on. The last stage's reply is the team's answer, so it delivers the finished piece, not a review of it.
- Make every line specific to this request (its audience, sources, length, format), and give the reason for a rule that isn't obvious. Leave out advice any AI app already follows, such as "be accurate", and don't use capitals for emphasis: AI apps over-apply a shouted rule.
- An agent that must search the web gets `allow: {web: true}`; leave `edits` and `commands` off unless the work is changing files or running commands.
- Give each agent a `doneWhen`: two or three short, checkable things its finished result must have, such as "Every story links to its source". It checks them before it replies and says which it could not meet. Never more than five.
- When the result must be right (facts, figures, code), end with a check step: an agent that checks the work it is handed against the other agent's `doneWhen` without rewriting it, connected after that agent and set to `checks: <its id>`; its findings show on the answer. Add `sendBackOnce: true` only if the person wants missed checks fixed before they see the answer. A check step is a whole extra session, so leave it out of quick or low-stakes teams.
- Give each agent the `model` and `thinkingEffort` that `list_models`' `choosing` gives its kind of work, the same table LoomWatch's own templates use: `jobs` lists the usual kinds, `tiers` says which model each kind of agent runs on, and `efforts` how hard it thinks. Use another recommended model only when the person asks for one. Set `thinkingEffort` only for a model `list_models` marks as reasoning, and never `xhigh` or `max`: thinking is paid for like writing, and the top settings mostly overthink. A free model is limited per day and its maker may learn from what it's sent, so use one only if the person asks.

A team file is YAML. A complete pipeline with a review stop:

schemaVersion: 1
id: morning-brief            # lowercase letters, digits and dashes; usually the file name without .yaml
name: Morning brief
entrypoint: researcher       # the first stage
agents:
  - id: researcher
    name: Researcher
    role: |
      You find today's AI news for the brief. Don't write the brief; the Writer does.
      How to work:
      - Use primary sources (company posts, papers, filings) from the last 24 hours.
      - Before you reply, check each claim against the page you read it on. What you read stays in your conversation, so don't open a page twice.
      Reply with up to eight stories: a one-line headline, two sentences on why it matters, and its link.
    model: anthropic/claude-opus-5.5                 # the model `choosing` gives this kind of work
    thinkingEffort: medium
    doneWhen: ["Every story links to a source you opened", "No story is older than 24 hours"]
    allow: {web: true}
  - id: review
    kind: operator           # a review stop: no model
    name: You
    role: Researcher is done. Approve the findings, or say what to change.
  - id: writer
    name: Writer
    role: |
      You write the morning brief from the stories the person approved. Add no stories or facts of your own.
      How to work:
      - Keep the five that matter most to someone building AI products.
      - Before you reply, check every claim and link against the approved stories.
      Reply with the brief only: five bullets, each one sentence with its link, and no preamble.
    model: anthropic/claude-opus-5.5
    thinkingEffort: medium
    doneWhen: ["Exactly five bullets, each with its link", "Uses only the approved stories"]
edges:                       # the order work is handed along
  - {from: researcher, to: review, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}
  - {from: review, to: writer, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}

To run it on a schedule, add a top-level block:
schedule: {cron: "0 8 * * 1-5", timezone: "Asia/Singapore", prompt: "Prepare today's brief."}
and, to send each scheduled answer to Notion, `deliver: {notion: {title: "Brief {{date}}"}}` inside `schedule`.
To send every answer to Notion, whoever starts the run, add a top-level `deliver: {notion: {}}` (title placeholders: {{team}}, {{date}}, {{time}}, {{weekday}}). Pages go under the destination the person chose in Connections.

When you change an existing team, call `read_team` first and propose the whole edited file, keeping everything you were not asked to change. A review stop can't be the first stage. If `propose_team` reports a problem, fix the file and propose it again before you answer."#;

fn definitions() -> Vec<Value> {
    let string = |description: &str| json!({"type": "string", "description": description});
    let object = |properties: Value, required: &[&str]| json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false});
    let read_only = json!({"readOnlyHint": true, "openWorldHint": false});
    vec![
        json!({
            "name": "list_teams",
            "title": "List teams",
            "description": "The person's teams: file, name and number of steps.",
            "inputSchema": object(json!({}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "read_team",
            "title": "Read a team",
            "description": "One team file's YAML and revision. Read before proposing a change to it.",
            "inputSchema": object(json!({"file": string("The team file, relative to the teams folder, e.g. morning-brief.yaml.")}), &["file"]),
            "annotations": read_only,
        }),
        json!({
            "name": "list_models",
            "title": "List models",
            "description": "The default model and the recommended models agents can run on, with what each costs per million tokens and whether it takes a thinking effort.",
            "inputSchema": object(json!({}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "propose_team",
            "title": "Propose a team",
            "description": "Show the person a complete team file as a proposal on the canvas. It is checked first; nothing is saved until they press Apply.",
            "inputSchema": object(json!({
                "file": string("Where the team lives, relative to the teams folder, ending in .yaml. An existing file to change it, a new name to create a team."),
                "yaml": string("The complete team file."),
                "summary": string("One plain sentence saying what the proposal does, shown on the card."),
            }), &["file", "yaml", "summary"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        }),
        json!({
            "name": "start_run",
            "title": "Start a run",
            "description": "Ask to run a team with a request. Usually the person confirms in LoomWatch first; the result says whether it started.",
            "inputSchema": object(json!({
                "file": string("The team file to run."),
                "request": string("What the team should do, in the person's words."),
            }), &["file", "request"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
        }),
        json!({
            "name": "get_run",
            "title": "Read a run",
            "description": "A run's status, what it is waiting for, and its answer. Without runId, the run started from this conversation most recently.",
            "inputSchema": object(json!({"runId": string("The run id. Optional.")}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "draft_review_note",
            "title": "Draft a review note",
            "description": "Suggest a note for a run waiting at a review stop. The person decides whether to use it and whether to approve; you can't answer the stop.",
            "inputSchema": object(json!({
                "runId": string("The waiting run. Optional: defaults to this conversation's latest run."),
                "text": string("The suggested note, written as the person would write it."),
            }), &["text"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        }),
    ]
}

async fn call(
    control: &Control,
    caller: &Caller,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    match name {
        "list_teams" => list_teams(control).await,
        "read_team" => read_team(control, arguments),
        "list_models" => list_models().await,
        "propose_team" => propose_team(control, caller, arguments).await,
        "start_run" => start_run(control, caller, arguments).await,
        "get_run" => get_run(control, caller, arguments).await,
        "draft_review_note" => draft_review_note(control, caller, arguments).await,
        other => Err(format!("LoomWatch has no tool called {other}.")),
    }
}

fn text(arguments: &Value, name: &str) -> Result<String, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Give `{name}` as a non-empty string."))
}

async fn list_teams(control: &Control) -> Result<Value, String> {
    let root = control.inner.teams_root.clone();
    let teams = tokio::task::spawn_blocking(move || {
        crate::api::discover_team_files(&root).map(|files| {
            files
                .iter()
                .map(|file| crate::api::summarize_team_file(&root, file))
                .collect::<Vec<_>>()
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("couldn't read the teams folder: {error}"))?;
    Ok(json!({
        "teams": teams.iter().map(|team| json!({
            "file": team.path,
            "name": team.name,
            "steps": team.agent_count,
            "problem": team.problem,
        })).collect::<Vec<_>>()
    }))
}

fn read_team(control: &Control, arguments: &Value) -> Result<Value, String> {
    let file = text(arguments, "file")?;
    let path = crate::api::resolve_existing_team_path(&control.inner.teams_root, Path::new(&file))
        .map_err(|error| error.message)?;
    let yaml =
        std::fs::read_to_string(&path).map_err(|error| format!("couldn't read {file}: {error}"))?;
    Ok(json!({"file": file, "yaml": yaml, "revision": crate::api::revision(yaml.as_bytes())}))
}

/// The default model and the recommended ones, with their prices and whether they reason. Not the
/// whole catalog: hundreds of models would crowd out the conversation, and any `OpenRouter` id the
/// person names still works.
async fn list_models() -> Result<Value, String> {
    let ai = crate::ai::installed()
        .ok_or("The model list isn't available in this copy of LoomWatch.")?;
    let catalog = ai
        .models()
        .catalog()
        .await
        .map_err(|error| format!("The model list isn't available right now: {error:#}"))?;
    Ok(json!({
        "defaultModel": catalog.default_model,
        "choosing": choosing(),
        "recommended": catalog.recommended.iter().map(|model| json!({
            "id": model.id,
            "name": model.name,
            "why": model.note,
            "free": model.free,
            "reasoning": model.reasoning,
            "dollarsPerMillionInput": model.input_price,
            "dollarsPerMillionOutput": model.output_price,
        })).collect::<Vec<_>>(),
        "otherModels": "Any other OpenRouter model id that can use tools works too, if the person names one.",
    }))
}

/// The model table (`schemas/model-tiers.json`) as Ask chooses from it: what each tier runs on and
/// is for, what each effort tier is for, and the model and effort of each usual kind of agent.
pub(super) fn choosing() -> Value {
    let tiers = &*crate::ai::MODEL_TIERS;
    let pick = |needs: &crate::ai::JobNeeds| {
        let (model, effort) = tiers.choose(needs);
        json!({"model": model, "thinkingEffort": effort})
    };
    json!({
        "tiers": tiers.models.iter().map(|(tier, model)| json!({
            "tier": tier,
            "model": model,
            "for": tiers.tiers.get(tier),
        })).collect::<Vec<_>>(),
        "efforts": tiers.efforts.iter().map(|(tier, effort)| json!({
            "thinkingEffort": effort,
            "for": tiers.effort_for.get(tier),
        })).collect::<Vec<_>>(),
        "jobs": tiers.jobs.iter().map(|(job, needs)| {
            let mut choice = pick(needs);
            choice["job"] = json!(job);
            choice
        }).collect::<Vec<_>>(),
        "anyOtherAgent": pick(&tiers.new_agent),
    })
}

/// The models a team's agents run on, for the "Start this run?" card.
fn models_used(team: &TeamConfig) -> Vec<String> {
    let mut models = Vec::new();
    for agent in team
        .agents
        .iter()
        .filter(|agent| agent.kind != AgentKind::Operator)
    {
        let model = crate::ai::openrouter_id(&agent.model);
        if !models.contains(&model) {
            models.push(model);
        }
    }
    models
}

/// The relative path a proposal may use: a `.yaml` or `.yml` file below the teams root, never in
/// a hidden folder, and in a folder that already exists.
fn proposal_path(control: &Control, file: &str) -> Result<std::path::PathBuf, String> {
    let relative = Path::new(file);
    let well_formed = relative.is_relative()
        && relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(name) if !name.to_string_lossy().starts_with('.')))
        && relative
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("yaml") || extension.eq_ignore_ascii_case("yml"));
    if !well_formed {
        return Err(format!(
            "`{file}` isn't a place for a team. Use a name like morning-brief.yaml, relative to the \
             teams folder."
        ));
    }
    crate::api::resolve_writable_team_path(&control.inner.teams_root, relative)
        .map_err(|error| error.message)
}

/// What the team schema says is wrong with a team file — the check the editor makes before it
/// saves, so a proposal that passes here is one the person can apply. At most five, with where.
fn schema_problems(yaml: &str) -> Vec<String> {
    static VALIDATOR: OnceLock<Option<jsonschema::Validator>> = OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        let schema: Value = serde_yaml::from_str(crate::api::TEAM_SCHEMA).ok()?;
        jsonschema::draft202012::new(&schema).ok()
    });
    let (Some(validator), Ok(document)) = (validator, serde_yaml::from_str::<Value>(yaml)) else {
        return Vec::new();
    };
    validator
        .iter_errors(&document)
        .take(5)
        .map(|error| {
            let at = error.instance_path().to_string();
            if at.is_empty() {
                error.to_string()
            } else {
                format!("{error} (at {at})")
            }
        })
        .collect()
}

async fn propose_team(
    control: &Control,
    caller: &Caller,
    arguments: &Value,
) -> Result<Value, String> {
    let mut file = text(arguments, "file")?;
    // The canvas names team files with `/`, and an app on Windows may write `sub\a.yaml`.
    if cfg!(windows) {
        file = file.replace('\\', "/");
    }
    let yaml = arguments
        .get("yaml")
        .and_then(Value::as_str)
        .filter(|yaml| !yaml.trim().is_empty())
        .ok_or("Give the complete team file as `yaml`.")?
        .to_owned();
    let summary = text(arguments, "summary").unwrap_or_else(|_| "A proposed team.".to_owned());
    let path = proposal_path(control, &file)?;
    let team = TeamConfig::parse(&yaml).map_err(|error| {
        format!("The team file has a problem: {error:#}. Fix it and propose again.")
    })?;
    let problems = schema_problems(&yaml);
    if !problems.is_empty() {
        return Err(format!(
            "The team file has a problem: {}. Fix it and propose again.",
            problems.join("; ")
        ));
    }
    let existing = std::fs::read(&path).ok();
    let id = format!("proposal-{}", uuid::Uuid::new_v4());
    let Caller::Conversation(source) = caller.clone();
    let proposal = Proposal {
        id: id.clone(),
        source,
        file: file.clone(),
        name: if team.name.is_empty() {
            file.clone()
        } else {
            team.name.clone()
        },
        is_new: existing.is_none(),
        yaml: yaml.clone(),
        base_revision: existing.as_deref().map(crate::api::revision),
        summary: summary.clone(),
        created_at: now(),
    };
    control
        .record(
            caller,
            "ask_proposal",
            json!({
                "proposalId": id,
                "file": file,
                "name": proposal.name,
                "isNew": proposal.is_new,
                "summary": summary,
                "baseRevision": proposal.base_revision,
                "yaml": yaml,
            }),
        )
        .await;
    control
        .inner
        .proposals
        .write()
        .await
        .insert(id.clone(), proposal.clone());
    // Said to the assistant, which says it to the person: where to look, and that nothing changed.
    let message =
        "Shown to the person as a proposal on the canvas. Nothing is saved until they press Apply.";
    Ok(json!({
        "proposalId": id,
        "file": file,
        "isNew": proposal.is_new,
        "status": "waiting_for_the_person",
        "message": message,
    }))
}

async fn start_run(control: &Control, caller: &Caller, arguments: &Value) -> Result<Value, String> {
    let file = text(arguments, "file")?;
    let request = text(arguments, "request")?;
    if request.chars().count() > MAX_REQUEST_CHARS {
        return Err(format!(
            "Keep the request under {MAX_REQUEST_CHARS} characters."
        ));
    }
    let path = crate::api::resolve_existing_team_path(&control.inner.teams_root, Path::new(&file))
        .map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                format!(
                    "There is no team file {file} yet. If you just proposed it, the person has to \
                     press Apply before it can run."
                )
            } else {
                error.message
            }
        })?;
    let yaml = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let team = TeamConfig::parse(&yaml).map_err(|error| format!("{file} can't run: {error:#}"))?;
    let Caller::Conversation(id) = caller;
    let ask_first = control
        .conversation(id)
        .await
        .is_none_or(|conversation| lock(&conversation.status).ask_before_run);
    if ask_first {
        let request_id = format!("run-request-{}", uuid::Uuid::new_v4());
        if let Some(conversation) = control.conversation(id).await {
            lock(&conversation.status).run_requests.insert(
                request_id.clone(),
                RunRequest {
                    file: file.clone(),
                    request: request.clone(),
                },
            );
        }
        control
            .record(
                caller,
                "ask_run_request",
                json!({
                    "requestId": request_id,
                    "file": file,
                    "name": if team.name.is_empty() { file.clone() } else { team.name.clone() },
                    "request": request,
                    "models": models_used(&team),
                    "steps": team.agents.len(),
                }),
            )
            .await;
        return Ok(json!({
            "status": "waiting_for_the_person",
            "requestId": request_id,
            "message": "The person was asked to start this run. It starts only when they press Start run.",
        }));
    }
    let record = crate::runs::launch(
        &control.inner.registry,
        control.inner.archive.clone(),
        &control.inner.teams_root,
        Path::new(&file),
        &request,
        crate::runs::RunTrigger::Manual,
    )
    .map_err(|error| error.message)?;
    control.inner.registry.persist_quietly(&record.run_id).await;
    if let Some(conversation) = control.conversation(id).await {
        lock(&conversation.status).last_run = Some(record.run_id.clone());
    }
    control
        .record(
            caller,
            "ask_run_started",
            json!({"runId": record.run_id, "file": record.team_path, "request": request}),
        )
        .await;
    Ok(json!({
        "status": "started",
        "runId": record.run_id,
        "url": control.run_url(&record.team_path, &record.run_id),
    }))
}

async fn resolve_run(
    control: &Control,
    caller: &Caller,
    arguments: &Value,
) -> Result<crate::runs::RunRecord, String> {
    let requested = arguments
        .get("runId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let run_id = if let Some(id) = requested {
        id
    } else {
        let Caller::Conversation(id) = caller;
        let latest = control
            .conversation(id)
            .await
            .and_then(|conversation| lock(&conversation.status).last_run.clone());
        latest.ok_or("No run was started from here yet. Give a runId.")?
    };
    control
        .inner
        .registry
        .get(&run_id)
        .ok_or_else(|| format!("LoomWatch has no run {run_id}."))
}

async fn get_run(control: &Control, caller: &Caller, arguments: &Value) -> Result<Value, String> {
    let record = resolve_run(control, caller, arguments).await?;
    let reply = record.reply.as_deref().map(|reply| {
        let mut text = reply.chars().take(MAX_REPLY_CHARS).collect::<String>();
        if reply.chars().count() > MAX_REPLY_CHARS {
            text.push_str(" …(cut short; the full answer is in LoomWatch)");
        }
        text
    });
    Ok(json!({
        "runId": record.run_id,
        "file": record.team_path,
        "status": record.status,
        "request": record.prompt,
        "waitingOn": record.waiting_on.as_ref().map(|waiting| json!({
            "node": waiting.get("node"),
            "name": waiting.get("name"),
            "question": waiting.get("question"),
            "sendBackAvailable": waiting.get("sendBackAvailable"),
        })),
        "reply": reply,
        "error": record.error,
        "url": control.run_url(&record.team_path, &record.run_id),
    }))
}

async fn draft_review_note(
    control: &Control,
    caller: &Caller,
    arguments: &Value,
) -> Result<Value, String> {
    let note = text(arguments, "text")?;
    let record = resolve_run(control, caller, arguments).await?;
    let Some(waiting) = record.waiting_on.clone() else {
        return Err(format!(
            "Run {} isn't waiting for the person, so there is nothing to answer.",
            record.run_id
        ));
    };
    control
        .record(
            caller,
            "ask_review_note",
            json!({
                "runId": record.run_id,
                "file": record.team_path,
                "node": waiting.get("node"),
                "name": waiting.get("name"),
                "question": waiting.get("question"),
                "text": note,
            }),
        )
        .await;
    Ok(json!({
        "status": "shown_to_the_person",
        "message": "The person sees your note in LoomWatch's Ask panel, with a button that puts it in \
                    the review box. Only they can send it, approve, or send the work back.",
    }))
}

#[cfg(test)]
mod tests {
    use super::{INSTRUCTIONS, TeamConfig, schema_problems};

    /// The example team is what the app copies when it writes one, so it has to be a team the
    /// daemon runs: a role in the three parts the instructions ask for, and a file `propose_team`
    /// accepts as it stands.
    #[test]
    fn the_example_team_in_the_instructions_is_one_propose_team_accepts() {
        let start = INSTRUCTIONS
            .find("schemaVersion: 1")
            .expect("the instructions show a team file");
        let end = INSTRUCTIONS[start..]
            .find("\n\n")
            .map_or(INSTRUCTIONS.len(), |offset| start + offset);
        let yaml = &INSTRUCTIONS[start..end];
        let team = TeamConfig::parse(yaml).expect("the example parses");
        assert!(
            schema_problems(yaml).is_empty(),
            "{:?}",
            schema_problems(yaml)
        );
        for agent in team.agents.iter().filter(|agent| !agent.is_operator()) {
            assert!(
                agent.role.contains("How to work:")
                    && agent.role.contains("Before you reply")
                    && agent.role.contains("Reply with"),
                "{} shows the shape it asks for: {}",
                agent.id,
                agent.role
            );
            assert!(
                (2..=3).contains(&agent.done_when.len())
                    && agent.thinking_effort.as_deref() == Some("medium"),
                "{} shows a done-when and a job's effort",
                agent.id
            );
        }
    }
}

//! The `LoomWatch` Control tools (ADR 0033), as Ask's agent calls them: directly, in the daemon.
//!
//! The tools read and propose; none writes a team file or answers a review stop.

use std::path::Path;
use std::sync::OnceLock;

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::{Caller, Control, Proposal, RunRequest, lock, now};
use crate::agent::{BoxFuture, HostTools, ToolSpec};
use crate::config::{AgentKind, CapabilityKind, TeamConfig};

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
pub(super) const INSTRUCTIONS: &str = r#"You are Ask LoomWatch, the assistant built into LoomWatch. LoomWatch runs teams of AI agents on this person's computer: each agent runs on an AI model, paid through the person's ChatGPT plan, their Claude API credit or OpenRouter, and the agents work through a pipeline, handing work from one to the next. A "You" step is a review step where the team waits for the person.

You help by reading their teams and runs and by proposing changes, using your tools. Rules:
- You cannot save files or start runs yourself. `propose_team` shows the person a proposal on the canvas; nothing is saved until they press Apply. `start_run` asks them to start the run, unless they have allowed you to start runs directly; its result tells you which. Never say something was saved, applied or started unless a tool result says so.
- Review stops belong to the person. You may explain what a team is waiting for and use `draft_review_note` to suggest a note; only they approve or send work back.
- Give each agent a model from `list_models`: its tiers, which are on the ways of paying the person has connected, its recommended models, or another model id the person names. Never invent a model id.
- Reply in plain words, in one to three short sentences. Don't paste team files into the chat: the proposal card shows the changes. Don't use tables. Within them, say what the person gets when the team runs (a deck the team makes shows on its answer, and Read opens it); where the team will choose something they may want to choose themselves, such as which competitors, say so and that they can name their own when they start the run; and where an agent will ask before it runs programs or changes files, as the makers do, say it will ask, so they know to allow it.

Build from what the person already has. Before you propose a new team or a new agent, look once in the conversation at what fits it: `list_my_agents` for their own agents, `list_jobs` for LoomWatch's jobs, `list_skills`, `list_tools`, and `find_files` for any folder or file they mention. In your reply, say in a few words what you reused and what you connected, as the person knows them (your Researcher, a Writer, your Client notes folder), never by an id or a path, and without the word "job".

Choose the team's shape from the work, not from how the request is worded:
- One agent, for most requests. An agent working alone brings in copies of itself for the parts of a big task that can be done at once, so one agent is right for large work too.
- A pipeline, when the work needs different jobs one after another, such as research, then writing, then slides. Each stage hands its reply to the next along `edges`, one stage at a time. Several stages can feed one stage that brings their work together; they still work in turn.
- A lead with teammates, when parts can be worked on at the same time or the next step depends on what is found, such as research with several questions: `edges: []`, the lead as `entrypoint`, started from the `lead` job. It hands parts to its teammates with `dispatch`, which run at once, asks them with `ask`, and its reply is the team's answer. Name each teammate and what it does in the lead's `role`.
- A review step (`kind: operator`) where the work should wait for the person: before anything is sent, posted or acted on, or after a plan they should agree to first.
- A check step when the result must be right (below).
Use the fewest agents that do the job. Add one only for work that needs a different job, model, folder or tool, or the person's review in between: each agent opens a session of its own, which costs time and money, and each handover loses detail. More than four is rarely worth it.

Make each agent from the best start:
- One of My agents that already does this part: point at it with `from: {agent: <its id from list_my_agents>}` and write none of its own fields (no `name`, `role`, `doneWhen` or `allow`). It works as it is saved in My agents, with its own skills, tools and reads, in every team that uses it. The entry holds only what is this team's: `spawn`, more `capabilities`, `checks`, `sendBack`, and a `model` (with its `thinkingEffort`) only when `list_my_agents` shows it has none. Never write a copy of one of their agents.
- Otherwise LoomWatch's job for the work, from `read_job`: keep its `role` as it is, with its way of checking and the shape it replies in, and add a short paragraph after its first line with what this request needs (audience, sources, length, format). Keep its `doneWhen` and add the request's own items to it (below); keep its `allow`, `model` and `thinkingEffort`. Use the makers (`deck`, `document`, `sheet`, `chart`, `dashboard`, `video`) for slides, Word documents and PDFs, spreadsheets, charts, dashboards and videos: they make the real file, which the person opens and asks about in LoomWatch. Use the `checker` job for a check step.
- Otherwise write the `role` in three parts: what the agent does and what it leaves to others; how to work, as a few short bullets ending with how it checks its work before it replies; and exactly what it replies with. A later stage receives the earlier stage's reply, so say what to hand on. The last stage's reply is the team's answer, so it delivers the finished piece, not a review of it.
- Make every line you write specific to this request (its audience, sources, length, format), and give the reason for a rule that isn't obvious. Leave out advice any AI app already follows, such as "be accurate", and don't use capitals for emphasis: AI apps over-apply a shouted rule.

Give each agent what its part needs, and nothing it doesn't: what an agent is given is read on every call it makes, and a source given to the wrong agent pulls it off its job.
- A folder or file the work rests on (notes, data, a brief, past reports): find it with `find_files`, using the person's words, and give it as knowledge to each agent that reads it: `capabilities: [{kind: knowledge, name: Market research, path: '/Users/me/Documents/Market research'}]`. The agent gets a folder's listing and README, or a file's text, and may read anything in it without asking. Write the path exactly as `find_files` gives it, in single quotes. Never guess a path, and never ask the person for one: they may not know what a path is. If more than one could be it, ask which, by what each holds. If none, ask which folder it is in, such as Documents, Desktop or iCloud Drive, and look again with `find_files` and what they say (`~/Documents/Clients` for "the Clients folder in Documents"); or tell them they can add it themselves once the team is on the canvas: select the agent, then Folder under Given. If `find_files` says LoomWatch wasn't allowed to look somewhere, tell them how to allow it.
- A folder the work happens in, such as a project whose files the agent changes or runs: `spawn: {cwd: '<its path from find_files>'}` on that agent, with `allow: {edits: true, commands: true}` only when changing files or running commands is its job.
- When the person asks for a skill, give it to the agent as a skill, by name from `list_skills`: `capabilities: [{kind: skill, name: report-design}]`. It shows on the canvas as a card connected to the agent, and the agent reads all of it before it starts, so don't copy what the skill says into the `role`. If no skill in `list_skills` is the one they mean, say so: they add skills on the Skills page. Give a skill unasked only to the agent whose work it plainly is for: every agent already sees each skill's name and description, and reads one when its task calls for it.
- A tool the work acts through, such as Linear, Gmail or a calendar: `{kind: tool, name: <its name from list_tools>}` on the agent that uses it. Each of its actions asks the person before it runs; add `alwaysAllow` only for actions they say may run without asking. If the tool they mean isn't in `list_tools`, say they connect it in Connections, under Tools, then ask you again.
- A Notion page to read is chosen in LoomWatch: tell the person to apply the team, then drag Notion from Connections, in the panel beside the canvas, onto the agent, and pick the page.
- An agent that must search the web gets `allow: {web: true}`; leave `edits` and `commands` off unless the work is changing files or running commands.

Hold each agent to its result:
- Give each agent a `doneWhen`: two or three short, checkable things its finished result must have, such as "Every story links to its source". It checks them before it replies and says which it could not meet. Never more than five. Put in it each thing the person asked of that agent's result (their length, their style, every part they named, a whole test suite passing rather than some tests), before the job's own general items: what isn't in `doneWhen` isn't checked.
- When the result must be right (facts, figures, code), end with a check step: an agent that checks the work it is handed against the other agent's `doneWhen` without rewriting it, connected after that agent and set to `checks: <its id>`; its findings show on the answer. Check the work the person will see, and make sure the agent it checks can fix whatever the check finds: give that agent the folders and files the check uses (the spreadsheet the figures come from, not only the figures it was handed) and the web when a fix may need a new source. Give the check step what it needs to judge each item: the same folders, files and skills as the agent it checks. Where a judgement call matters (which competitors, whether a changed test was wrong), put it in that agent's `doneWhen` as something the check can confirm, such as "Says why each competitor was chosen". Add `sendBack: {rounds: 2, whenStillNotMet: ask}`, so what the check finds goes back to be fixed before the person sees the answer, and the run stops to ask them if it still isn't met; write `whenStillNotMet: answer` if they would rather see the answer with the problems marked, and leave `sendBack` off only if they want a report of the problems instead. A check step is a whole extra session, so leave it out of quick or low-stakes teams.
- Give each agent the `model` and `thinkingEffort` that `list_models`' `choosing` gives its kind of work, the same table LoomWatch's own templates use: `jobs` lists the usual kinds, `tiers` says which model each kind of agent runs on, and `efforts` how hard it thinks. Use another recommended model only when the person asks for one. Set `thinkingEffort` only for a model `list_models` marks as reasoning, and never `xhigh` or `max`: thinking is paid for like writing, and the top settings mostly overthink. A free model is limited per day and its maker may learn from what it's sent, so use one only if the person asks.
- A new team can spend at most $1.00 a run unless it sets `spend: {perRun: <dollars>}`; set one only when the person names a figure. A run that reaches it stops and asks them whether to carry on, but a scheduled run has nobody to ask, so it stops without an answer. For a team of three or more agents, or one with a check step that runs on a schedule, add to your reply that each run can spend up to $1.00 and that they can tell you if it needs more.

A team file is YAML. A complete pipeline with a review step:

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
    kind: operator           # a review step: no model
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

A lead with teammates, two of them from My agents, each given only what its part needs:

schemaVersion: 1
id: client-review
name: Client review
entrypoint: lead
agents:
  - id: lead
    from: {agent: research-lead}      # one of My agents, as it is saved
  - id: analyst
    from: {agent: analyst}
    capabilities:                     # this team's sales sheet, for the analyst alone
      - {kind: knowledge, name: Sales 2026, path: '/Users/me/Documents/Sales 2026.xlsx'}
  - id: writer
    name: Writer
    role: |
      You are the team's writer. Turn the lead's findings into the client review.
      How to work:
      - Write for the client's managers: lead with what changed this quarter and why it matters.
      - Before you reply, check every figure against the findings you were handed.
      Reply with the review only, under one page, with no preamble.
    model: anthropic/claude-opus-5.5
    thinkingEffort: medium
    doneWhen: ["Every figure matches the findings", "Fits on one page"]
    capabilities:
      - {kind: knowledge, name: Client notes, path: '/Users/me/Documents/Client notes'}
      - {kind: skill, name: client-letters}
edges: []                             # no fixed order: the lead hands out the parts

To run a team on a schedule, add a top-level block:
schedule: {cron: "0 8 * * 1-5", timezone: "Asia/Singapore", prompt: "Prepare today's brief."}
and, to send each scheduled answer to Notion, `deliver: {notion: {title: "Brief {{date}}"}}` inside `schedule`.
To send every answer to Notion, whoever starts the run, add a top-level `deliver: {notion: {}}` (title placeholders: {{team}}, {{date}}, {{time}}, {{weekday}}). Pages go under the destination the person chose in Connections.
For a team that should build on what its earlier runs found, add `memory: {notebook: {enabled: true, keep: review}}`: its agents keep notes, and the person chooses which to keep. To let it read what another of their teams knows, add `memory: {inherits: [{team: <that team's id>}]}`.

When you change an existing team, call `read_team` first and propose the whole edited file, keeping everything you were not asked to change. A review step can't be the first stage. If `propose_team` reports a problem, fix the file and propose it again before you answer."#;

fn string(description: &str) -> Value {
    json!({"type": "string", "description": description})
}

fn object(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({"type": "object", "required": required, "additionalProperties": false});
    schema["properties"] = properties;
    schema
}

fn read_only() -> Value {
    json!({"readOnlyHint": true, "openWorldHint": false})
}

fn definitions() -> Vec<Value> {
    let read_only = read_only();
    let mut tools = vec![
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
            "name": "list_skills",
            "title": "List skills",
            "description": "The skills an agent can be given: each one's name, what it is for, and where it is kept.",
            "inputSchema": object(json!({}), &[]),
            "annotations": read_only,
        }),
    ];
    tools.extend(building_definitions());
    tools.extend([
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
            "description": "Suggest a note for a run waiting at a review step. The person decides whether to use it and whether to approve; you can't answer the step.",
            "inputSchema": object(json!({
                "runId": string("The waiting run. Optional: defaults to this conversation's latest run."),
                "text": string("The suggested note, written as the person would write it."),
            }), &["text"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        }),
    ]);
    tools
}

/// The tools Ask builds from what the person has with (ADR 0096): `LoomWatch`'s jobs, My agents,
/// the connected tools, and the person's folders and files.
fn building_definitions() -> [Value; 5] {
    let read_only = read_only();
    [
        json!({
            "name": "list_jobs",
            "title": "List LoomWatch's jobs",
            "description": "LoomWatch's built-in jobs (Researcher, Writer, Checker, Research lead, the makers of slides, documents, spreadsheets, charts, dashboards and videos, …): what each does, the model and thinking effort it runs on, and what it may do without asking. Read one with `read_job` to start an agent from it.",
            "inputSchema": object(json!({}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "read_job",
            "title": "Read a job",
            "description": "One built-in job in full: its role, its doneWhen, its allow, its model and thinking effort, as LoomWatch places it.",
            "inputSchema": object(json!({"job": string("The job's id from `list_jobs`, e.g. researcher.")}), &["job"]),
            "annotations": read_only,
        }),
        json!({
            "name": "list_my_agents",
            "title": "List My agents",
            "description": "The agents the person keeps in My agents: each one's id, name, what it does, the start of its instructions, its model, skills, tools and what it reads, and the teams it is in. A team uses one with `from: {agent: <id>}`.",
            "inputSchema": object(json!({}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "list_tools",
            "title": "List connected tools",
            "description": "The tools the person connected in LoomWatch (Linear, Gmail, Notion, …), with what each can read and what it can change. An agent is given one with `{kind: tool, name: <its name>}`.",
            "inputSchema": object(json!({}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "find_files",
            "title": "Find folders and files",
            "description": "The folders and files on this computer whose names hold the words given, or the one a full path names: those the person's teams and agents already read first, then their home folder, a few folders deep. Each comes with its full path and, for a folder, the first names inside it. Names only; nothing is opened.",
            "inputSchema": object(json!({"name": string("The words the person used for it, e.g. Market research or invoice 2026.pdf, or a full path.")}), &["name"]),
            "annotations": read_only,
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
        "list_skills" => list_skills(control).await,
        "list_jobs" => Ok(list_jobs()),
        "read_job" => read_job(arguments),
        "list_my_agents" => list_my_agents(control).await,
        "list_tools" => Ok(list_tools().await),
        "find_files" => find_files(control, arguments).await,
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

/// The skills the Library lists, the same ones a run can deliver: `LoomWatch`'s skills folder and
/// the project's. Names and descriptions only; the assistant never needs a skill's text to wire it.
async fn list_skills(control: &Control) -> Result<Value, String> {
    let skills = installed_skills(control).await?;
    Ok(json!({
        "skills": skills.iter().map(|skill| json!({
            "name": skill.name,
            "for": skill.detail,
            "from": skill.source,
        })).collect::<Vec<_>>(),
    }))
}

async fn installed_skills(
    control: &Control,
) -> Result<Vec<crate::capabilities::DetectedCapability>, String> {
    let skills = control.inner.skills_folder.clone();
    let root = control.inner.teams_root.clone();
    tokio::task::spawn_blocking(move || {
        crate::capabilities::detect_capabilities(skills.as_deref(), &root).skills
    })
    .await
    .map_err(|error| format!("couldn't list the skills: {error}"))
}

/// The built-in jobs, short: enough to choose one, and `read_job` to read it.
fn list_jobs() -> Value {
    json!({
        "jobs": super::jobs::BUILT_IN_JOBS.iter().map(super::jobs::BuiltInJob::listed).collect::<Vec<_>>(),
    })
}

fn read_job(arguments: &Value) -> Result<Value, String> {
    let id = text(arguments, "job")?;
    super::jobs::named(&id)
        .map(super::jobs::BuiltInJob::read)
        .ok_or_else(|| format!("LoomWatch has no job called {id}."))
}

/// How much of an agent's instructions `list_my_agents` shows: enough to tell what it is for.
const INSTRUCTIONS_SHOWN: usize = 400;

/// My agents (ADR 0094), as a team points at them: what each is, what it brings with it, and the
/// teams already using it. A file that doesn't read as an agent is left out, as the app's list
/// leaves it out.
async fn list_my_agents(control: &Control) -> Result<Value, String> {
    let root = control.inner.teams_root.clone();
    tokio::task::spawn_blocking(move || {
        let list = crate::jobs::list_jobs(&root).map_err(|_| {
            "Couldn't read My agents. Open My agents in LoomWatch to see why.".to_owned()
        })?;
        let agents = list
            .jobs
            .iter()
            .map(|agent| {
                let spec = &agent.spec;
                let mut start: String =
                    spec.instructions.chars().take(INSTRUCTIONS_SHOWN).collect();
                if spec.instructions.chars().count() > INSTRUCTIONS_SHOWN {
                    start.push('…');
                }
                let reads = spec
                    .reads
                    .iter()
                    .map(|read| match (&read.path, &read.notion) {
                        (Some(path), _) => json!({"name": read.name, "path": path}),
                        (None, Some(page)) => json!({"name": read.name, "notionPage": page.page}),
                        (None, None) => json!({"name": read.name}),
                    })
                    .collect::<Vec<_>>();
                json!({
                    "id": agent.id,
                    "name": spec.name,
                    "does": spec.does,
                    "instructions": start,
                    "model": spec.model,
                    "thinkingEffort": spec.thinking_effort,
                    "skills": spec.skills,
                    "tools": spec.tools,
                    "reads": reads,
                    "doneWhen": spec.done_when,
                    "allow": spec.allow,
                    "inTeams": crate::my_agents::teams_using(&root, &agent.id),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"agents": agents}))
    })
    .await
    .map_err(|error| format!("Couldn't read My agents: {error}"))?
}

/// The most of one tool's actions `list_tools` names.
const ACTIONS_SHOWN: usize = 30;

/// The tools connected in `LoomWatch` (ADR 0069), by what each can read and what it can change, as
/// its server describes them. One still connecting is left out: a run couldn't use it yet.
async fn list_tools() -> Value {
    let Some(tools) = crate::connected_tools::installed() else {
        return json!({"tools": []});
    };
    let listed = tools.list().await;
    let tools = listed
        .iter()
        .filter(|tool| !tool.pending)
        .map(|tool| {
            let labels = |read_only: bool| {
                tool.calls
                    .iter()
                    .filter(|call| call.read_only == read_only)
                    .take(ACTIONS_SHOWN)
                    .map(crate::connected_tools::ToolCall::label)
                    .collect::<Vec<_>>()
            };
            json!({
                "name": tool.name,
                "reads": labels(true),
                "changes": labels(false),
                "problem": tool.problem,
            })
        })
        .collect::<Vec<_>>();
    json!({"tools": tools})
}

/// The names of the tools a run can give an agent now.
pub(super) async fn connected_tool_names() -> Vec<String> {
    let Some(tools) = crate::connected_tools::installed() else {
        return Vec::new();
    };
    tools
        .list()
        .await
        .into_iter()
        .filter(|tool| !tool.pending)
        .map(|tool| tool.name)
        .collect()
}

async fn find_files(control: &Control, arguments: &Value) -> Result<Value, String> {
    let query = text(arguments, "name")?;
    if query.chars().count() > super::find::MAX_QUERY_CHARS {
        return Err("That is too long for a folder or file's name.".to_owned());
    }
    let root = control.inner.teams_root.clone();
    let home = control.inner.home.clone();
    let search = tokio::task::spawn_blocking(move || {
        let in_use = sources_in_use(&root);
        super::find::find(&query, home.as_deref(), &in_use)
    })
    .await
    .map_err(|error| format!("Couldn't look for it: {error}"))?;
    // Said to the assistant: what to tell a person who can't be asked for a path.
    let ask = "Say you couldn't find it, and ask which folder it is in, such as Documents, \
               Desktop or iCloud Drive; never ask for a path. Or tell them they can add it \
               themselves once the team is on the canvas: select the agent, then Folder under \
               Given.";
    let mut answer = json!({"found": search.found});
    if search.found.is_empty() {
        answer["message"] = json!(format!(
            "Nothing by that name in the person's teams, their agents or their folders. {ask}"
        ));
    } else if search.stopped_early {
        answer["message"] = json!(format!(
            "The search stopped at its limit, so there may be more. If none of these is the one: \
             {ask}"
        ));
    }
    if !search.not_allowed.is_empty() {
        let settings = if cfg!(target_os = "macos") {
            " On a Mac they allow it in System Settings, Privacy & Security, Files and Folders, \
             LoomWatch."
        } else {
            ""
        };
        answer["notAllowed"] = json!(search.not_allowed);
        answer["allowing"] = json!(format!(
            "LoomWatch wasn't allowed to look in {}, so it may be there. Tell the person.{settings}",
            crate::my_agents::listed(&search.not_allowed)
        ));
    }
    Ok(answer)
}

/// Every folder and file the person's teams and My agents read, and every folder a team agent
/// works in, with who: "Market brief · Researcher".
fn sources_in_use(teams_root: &Path) -> Vec<super::find::InUse> {
    use super::find::InUse;
    let mut in_use = Vec::new();
    for file in crate::api::discover_team_files(teams_root).unwrap_or_default() {
        let path = teams_root.join(&file);
        let Some(team) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|yaml| serde_yaml::from_str::<serde_yaml::Value>(&yaml).ok())
        else {
            continue;
        };
        let team_dir = path.parent().unwrap_or(teams_root);
        let team_name = team
            .get("name")
            .and_then(serde_yaml::Value::as_str)
            .unwrap_or(&file)
            .to_owned();
        let agents = team
            .get("agents")
            .and_then(serde_yaml::Value::as_sequence)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for agent in agents {
            let name = agent
                .get("name")
                .or_else(|| agent.get("id"))
                .and_then(serde_yaml::Value::as_str)
                .unwrap_or_default();
            let by = format!("{team_name} · {name}");
            for (label, read) in raw_knowledge(agent) {
                in_use.push(InUse {
                    path: crate::chosen_knowledge::resolve(team_dir, Path::new(&read)),
                    name: label,
                    by: by.clone(),
                });
            }
            if let Some(cwd) = raw_cwd(agent) {
                let path = crate::chosen_knowledge::resolve(team_dir, Path::new(&cwd));
                // The team's own folder is where every agent works by default, not a folder chosen.
                if path != team_dir && path.file_name().is_some() {
                    in_use.push(InUse {
                        name: path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        path,
                        by: format!("{by} (works there)"),
                    });
                }
            }
        }
    }
    if let Ok(list) = crate::jobs::list_jobs(teams_root) {
        for agent in &list.jobs {
            for read in &agent.spec.reads {
                if let Some(path) = &read.path {
                    in_use.push(InUse {
                        path: crate::chosen_knowledge::resolve(teams_root, Path::new(path)),
                        name: read.name.clone(),
                        by: agent.spec.name.clone(),
                    });
                }
            }
        }
    }
    in_use
}

/// The `{kind: knowledge, path}` entries a team file's agent entry writes, as (label, path).
fn raw_knowledge(agent: &serde_yaml::Value) -> Vec<(String, String)> {
    agent
        .get("capabilities")
        .and_then(serde_yaml::Value::as_sequence)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|capability| {
            capability.get("kind").and_then(serde_yaml::Value::as_str) == Some("knowledge")
        })
        .filter_map(|capability| {
            let path = capability.get("path")?.as_str()?.trim();
            (!path.is_empty()).then(|| {
                let name = capability
                    .get("name")
                    .and_then(serde_yaml::Value::as_str)
                    .unwrap_or(path);
                (name.to_owned(), path.to_owned())
            })
        })
        .collect()
}

/// The `spawn.cwd` a team file's agent entry writes.
fn raw_cwd(agent: &serde_yaml::Value) -> Option<String> {
    let cwd = agent.get("spawn")?.get("cwd")?.as_str()?.trim();
    (!cwd.is_empty()).then(|| cwd.to_owned())
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
        "otherModels": "Any other OpenRouter model id that can use tools works too, if the person names one. A model on the person's ChatGPT plan is written chatgpt:<slug>, and one on their Claude API credit anthropic:<id>; use those only when that way of paying is connected, as the tiers above are.",
        "connected": crate::ai::installed().map(crate::ai::Ai::connected_sources).unwrap_or_default(),
    }))
}

/// The model table (`schemas/model-tiers.json`) as Ask chooses from it: what each tier runs on and
/// is for, what each effort tier is for, and the model and effort of each usual kind of agent.
pub(super) fn choosing() -> Value {
    let tiers = &*crate::ai::MODEL_TIERS;
    // Each tier's model, paid by a connected plan that offers it, else OpenRouter (ADR 0073).
    let pick = |needs: &crate::ai::JobNeeds| {
        let (_, effort) = tiers.choose(needs);
        json!({"model": super::tier_model(&needs.tier), "thinkingEffort": effort})
    };
    json!({
        "tiers": tiers.models.keys().map(|tier| json!({
            "tier": tier,
            "model": super::tier_model(tier),
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
        let model = crate::ai::ModelRef::parse(&agent.model).selector();
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
    // An agent that points at one of My agents is filled in from it first, as a run reads it.
    let team = TeamConfig::parse_in(&yaml, &control.inner.teams_root).map_err(|error| {
        format!(
            "The team file has a problem: {error:#}. Fix it and propose again; an agent that \
             points at one of My agents uses an id from `list_my_agents`."
        )
    })?;
    let problems = schema_problems(&yaml);
    if !problems.is_empty() {
        return Err(format!(
            "The team file has a problem: {}. Fix it and propose again.",
            problems.join("; ")
        ));
    }
    let existing = std::fs::read(&path).ok();
    names_only_what_is_there(control, &team, &yaml, existing.as_deref(), &path).await?;
    // A check step sends a missed check back unless the proposal says otherwise (ADR 0062), as one
    // made from a template or on the canvas does.
    let yaml = with_send_back(&yaml, &team);
    // And a new team has the spending limit every new team starts with (ADR 0068), unless it says.
    let yaml = if existing.is_none() {
        with_spend_limit(&yaml)
    } else {
        yaml
    };
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
        agent_names: team
            .agents
            .iter()
            .filter(|agent| !agent.is_operator() && !agent.name.trim().is_empty())
            .map(|agent| (agent.id.clone(), agent.name.clone()))
            .collect(),
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
                "agentNames": proposal.agent_names,
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

/// Refuse a proposal that names what a run couldn't find, before it reaches the canvas: a skill
/// that isn't installed, a tool that isn't connected, or a folder or file that isn't on this
/// computer. `existing` is the saved team file, whose names are let through.
async fn names_only_what_is_there(
    control: &Control,
    team: &TeamConfig,
    yaml: &str,
    existing: Option<&[u8]>,
    path: &Path,
) -> Result<(), String> {
    let missing = missing_skills(control, team, existing).await?;
    if !missing.is_empty() {
        return Err(format!(
            "{} {} one of your skills. Add it on the Skills page.",
            crate::my_agents::listed(&missing),
            if missing.len() == 1 {
                "isn't"
            } else {
                "aren't"
            }
        ));
    }
    let saved = existing
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|yaml| serde_yaml::from_str::<serde_yaml::Value>(yaml).ok());
    let missing = missing_tools(yaml, saved.as_ref(), &connected_tool_names().await);
    if !missing.is_empty() {
        return Err(format!(
            "{} {} connected yet. Connect it in Connections, under Tools.",
            crate::my_agents::listed(&missing),
            if missing.len() == 1 {
                "isn't"
            } else {
                "aren't"
            }
        ));
    }
    let team_dir = path.parent().unwrap_or(&control.inner.teams_root);
    let missing = missing_places(yaml, saved.as_ref(), team_dir);
    if !missing.is_empty() {
        return Err(format!(
            "There is no folder or file at {} on this computer.",
            missing.join(" or ")
        ));
    }
    Ok(())
}

/// The skills `team` wires that the Library doesn't list, as a run would find them: by name,
/// whatever its case. A skill the saved file already wires is let through, so a proposal that
/// keeps it, as it must, isn't refused for a skill removed since.
async fn missing_skills(
    control: &Control,
    team: &TeamConfig,
    existing: Option<&[u8]>,
) -> Result<Vec<String>, String> {
    let wired = |team: &TeamConfig| {
        team.agents
            .iter()
            .flat_map(|agent| &agent.capabilities)
            .filter(|capability| capability.kind == CapabilityKind::Skill)
            .map(|capability| capability.name.clone())
            .collect::<Vec<_>>()
    };
    let mut asked = wired(team);
    if asked.is_empty() {
        return Ok(asked);
    }
    let kept = existing
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|yaml| TeamConfig::parse_in(yaml, &control.inner.teams_root).ok())
        .map(|saved| wired(&saved))
        .unwrap_or_default();
    let installed = installed_skills(control).await?;
    asked.retain(|name| {
        let known = |other: &String| other.eq_ignore_ascii_case(name);
        !kept.iter().any(known) && !installed.iter().any(|skill| known(&skill.name))
    });
    asked.sort_by_key(|name| name.to_lowercase());
    asked.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    Ok(asked)
}

/// Every agent entry of a team document, as written.
fn raw_agents(document: &serde_yaml::Value) -> &[serde_yaml::Value] {
    document
        .get("agents")
        .and_then(serde_yaml::Value::as_sequence)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// The tools `yaml` gives its agents that aren't connected, ignoring case, as a run would look
/// them up. A tool the saved file already gives is let through, as a skill is.
fn missing_tools(
    yaml: &str,
    saved: Option<&serde_yaml::Value>,
    connected: &[String],
) -> Vec<String> {
    let given = |document: &serde_yaml::Value| {
        raw_agents(document)
            .iter()
            .filter_map(|agent| agent.get("capabilities")?.as_sequence())
            .flatten()
            .filter(|capability| {
                capability.get("kind").and_then(serde_yaml::Value::as_str) == Some("tool")
            })
            .filter_map(|capability| capability.get("name")?.as_str())
            .map(|name| name.trim().to_owned())
            .collect::<Vec<_>>()
    };
    let Ok(document) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return Vec::new();
    };
    let kept = saved.map(given).unwrap_or_default();
    let mut missing = given(&document);
    missing.retain(|name| {
        let known = |other: &String| other.eq_ignore_ascii_case(name);
        !kept.iter().any(known) && !connected.iter().any(known)
    });
    missing.sort_by_key(|name| name.to_lowercase());
    missing.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    missing
}

/// The folders and files `yaml` connects as knowledge, and the folders its agents work in, that
/// aren't on this computer, resolved as a run resolves them: from the team file's folder, `~/`
/// from the home folder. One the saved file already names is let through: the person may have
/// moved it, and a proposal must keep what it wasn't asked to change.
fn missing_places(yaml: &str, saved: Option<&serde_yaml::Value>, team_dir: &Path) -> Vec<String> {
    let named = |document: &serde_yaml::Value| {
        let mut places = Vec::new();
        for agent in raw_agents(document) {
            for (_, path) in raw_knowledge(agent) {
                places.push((path, false));
            }
            if let Some(cwd) = raw_cwd(agent) {
                places.push((cwd, true));
            }
        }
        places
    };
    let Ok(document) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return Vec::new();
    };
    let kept = saved.map(named).unwrap_or_default();
    let mut missing = Vec::new();
    for (place, folder) in named(&document) {
        if kept.iter().any(|(saved, _)| *saved == place) {
            continue;
        }
        let resolved = crate::chosen_knowledge::resolve(team_dir, Path::new(&place));
        let there = if folder {
            resolved.is_dir()
        } else {
            resolved.exists()
        };
        if !there && !missing.contains(&place) {
            missing.push(place);
        }
    }
    missing
}

/// `yaml` with the spending limit a new team starts with ([`crate::spend::DEFAULT_PER_RUN_USD`]),
/// written as a top-level block after its `name:` line, when it sets no `spend` of its own. A file
/// this can't add to without changing what else it says is left as it is.
fn with_spend_limit(yaml: &str) -> String {
    let Ok(raw) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return yaml.to_owned();
    };
    if !raw.is_mapping() || raw.get("spend").is_some() {
        return yaml.to_owned();
    }
    let block = format!(
        "spend:\n  perRun: {:.2}\n",
        crate::spend::DEFAULT_PER_RUN_USD
    );
    let mut out = String::with_capacity(yaml.len() + block.len());
    let mut added = false;
    for line in yaml.split_inclusive('\n') {
        out.push_str(line);
        if !added && line.starts_with("name:") {
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&block);
            added = true;
        }
    }
    if !added {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&block);
    }
    // Only if the file still says everything it said, and now the limit too.
    let Ok(mut with) = serde_yaml::from_str::<serde_yaml::Value>(&out) else {
        return yaml.to_owned();
    };
    let limit = with
        .as_mapping_mut()
        .and_then(|mapping| mapping.remove("spend"));
    let expected = serde_yaml::from_str::<serde_yaml::Value>(&block)
        .ok()
        .and_then(|block| block.get("spend").cloned());
    if with == raw && limit.is_some() && limit == expected {
        out
    } else {
        yaml.to_owned()
    }
}

/// `yaml` with a new check step's `sendBack` ([`crate::config::SendBack::NEW`]) under every check
/// step that does not say how it sends work back, written beside its `checks:` line so the rest of
/// the file stays as it was written. A step that says (`sendBack`, or the older `sendBackOnce`
/// either way), or whose `checks:` is not on a line of its own (flow style), is left as it is.
fn with_send_back(yaml: &str, team: &TeamConfig) -> String {
    use std::fmt::Write as _;
    let Ok(raw) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return yaml.to_owned();
    };
    let sets_it = |id: &str| {
        raw.get("agents")
            .and_then(serde_yaml::Value::as_sequence)
            .and_then(|agents| {
                agents
                    .iter()
                    .find(|agent| agent.get("id").and_then(serde_yaml::Value::as_str) == Some(id))
            })
            .is_some_and(|agent| {
                agent.get("sendBack").is_some() || agent.get("sendBackOnce").is_some()
            })
    };
    let mut pending: Vec<(&str, &str)> = team
        .agents
        .iter()
        .filter_map(|agent| Some((agent.id.as_str(), agent.checks.as_deref()?)))
        .filter(|(id, _)| !sets_it(id))
        .collect();
    if pending.is_empty() {
        return yaml.to_owned();
    }
    let mut out = String::with_capacity(yaml.len() + 32 * pending.len());
    let mut agent: Option<&str> = None;
    for line in yaml.split_inclusive('\n') {
        out.push_str(line);
        let trimmed = line.trim_start();
        let body = trimmed.strip_prefix("- ").unwrap_or(trimmed);
        if let Some(id) = body.strip_prefix("id:") {
            let id = id.trim().trim_matches(['"', '\'']);
            agent = pending
                .iter()
                .map(|(agent, _)| *agent)
                .find(|agent| *agent == id);
        }
        let Some(current) = agent else { continue };
        if !body.starts_with("checks:") {
            continue;
        }
        let indent = &line[..line.len() - trimmed.len()];
        let indent = if trimmed.starts_with("- ") {
            format!("{indent}  ")
        } else {
            indent.to_owned()
        };
        if !out.ends_with('\n') {
            out.push('\n');
        }
        let crate::config::SendBack {
            rounds,
            when_still_not_met,
        } = crate::config::SendBack::NEW;
        let exit = match when_still_not_met {
            crate::config::WhenStillNotMet::Answer => "answer",
            crate::config::WhenStillNotMet::Ask => "ask",
        };
        let _ = write!(
            out,
            "{indent}sendBack:\n{indent}  rounds: {rounds}\n{indent}  whenStillNotMet: {exit}\n"
        );
        pending.retain(|(id, _)| *id != current);
        agent = None;
    }
    out
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
    let team = TeamConfig::parse_in(&yaml, &control.inner.teams_root)
        .map_err(|error| format!("{file} can't run: {error:#}"))?;
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
        crate::runs::Tries::default(),
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

    /// The YAML examples in the instructions, in order: each runs from `schemaVersion: 1` to the
    /// first blank line.
    fn examples() -> Vec<&'static str> {
        INSTRUCTIONS
            .match_indices("schemaVersion: 1")
            .map(|(start, _)| {
                let end = INSTRUCTIONS[start..]
                    .find("\n\n")
                    .map_or(INSTRUCTIONS.len(), |offset| start + offset);
                &INSTRUCTIONS[start..end]
            })
            .collect()
    }

    /// The second example is a lead with teammates, two of them from My agents, each given only
    /// what its part needs: a file the team schema accepts, and one a run reads once those agents
    /// are in My agents, in team mode.
    #[test]
    fn the_lead_example_points_at_my_agents_and_gives_each_its_own_sources() {
        let examples = examples();
        assert_eq!(examples.len(), 2, "{examples:?}");
        let yaml = examples[1];
        assert!(
            schema_problems(yaml).is_empty(),
            "{:?}",
            schema_problems(yaml)
        );
        let root =
            std::env::temp_dir().join(format!("loomwatch-ask-lead-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".jobs")).expect("My agents");
        for (id, name) in [("research-lead", "Research lead"), ("analyst", "Analyst")] {
            std::fs::write(
                root.join(format!(".jobs/{id}.yaml")),
                format!("name: {name}\ninstructions: Do the {name} part.\nmodel: anthropic/claude-opus-5.5\n"),
            )
            .expect("an agent");
        }
        let team = TeamConfig::parse_in(yaml, &root);
        let _ = std::fs::remove_dir_all(&root);
        let team = team.expect("the example reads with its agents in My agents");
        assert!(team.edges.is_empty(), "team mode");
        assert_eq!(team.entrypoint, "lead");
        let lead = &team.agents[0];
        assert_eq!(lead.role, "Do the Research lead part.");
        let given = |id: &str| {
            team.agents
                .iter()
                .find(|agent| agent.id == id)
                .map(|agent| {
                    agent
                        .capabilities
                        .iter()
                        .map(|c| c.name.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        assert!(given("lead").is_empty());
        assert_eq!(given("analyst"), ["Sales 2026"]);
        assert_eq!(given("writer"), ["Client notes", "client-letters"]);
    }

    /// A new team Ask proposes starts with the spending limit every new team starts with (ADR
    /// 0068), written after its name; a team that sets its own keeps it, and a file this can't add
    /// to without changing it is left as written.
    #[test]
    fn a_new_team_starts_with_the_new_team_spending_limit() {
        let team = "schemaVersion: 1\nid: t\nname: T\nentrypoint: a\nagents:\n  - id: a\n    name: A\n    role: |\n      Do it.\n    model: fake/offline\nedges: []\n";
        let limited = super::with_spend_limit(team);
        assert!(
            limited.contains("name: T\nspend:\n  perRun: 1.00\nentrypoint: a\n"),
            "{limited}"
        );
        let parsed = TeamConfig::parse(&limited).expect("still a team");
        assert_eq!(
            parsed.spend.per_run,
            Some(crate::spend::DEFAULT_PER_RUN_USD)
        );
        assert_eq!(parsed.agents[0].role, "Do it.\n");
        // No `name:` line: added at the end, after a block that ends the file.
        let nameless = team
            .replace("name: T\n", "")
            .replace("edges: []\n", "edges: []");
        let limited = super::with_spend_limit(&nameless);
        assert!(
            limited.ends_with("edges: []\nspend:\n  perRun: 1.00\n"),
            "{limited}"
        );
        for kept in [
            team.replace("name: T\n", "name: T\nspend: {perRun: 3}\n"),
            "{schemaVersion: 1, id: t, name: T, entrypoint: a, agents: [], edges: []}".to_owned(),
            "not: [yaml".to_owned(),
        ] {
            assert_eq!(super::with_spend_limit(&kept), kept);
        }
    }

    /// A proposal may give an agent only a tool that is connected, by its name in any case, or one
    /// the saved team already gives.
    #[test]
    fn a_proposal_gives_only_connected_tools() {
        let team = |tools: &[&str]| {
            let given = tools.iter().fold(String::new(), |given, name| {
                given + &format!("      - {{kind: tool, name: {name}}}\n")
            });
            format!(
                "agents:\n  - id: a\n    capabilities:\n{given}      - {{kind: skill, name: Linear}}\n"
            )
        };
        let connected = ["Linear".to_owned(), "Gmail".to_owned()];
        assert!(super::missing_tools(&team(&["linear", "GMAIL"]), None, &connected).is_empty());
        assert_eq!(
            super::missing_tools(
                &team(&["Jira", "jira", "Linear", "Asana"]),
                None,
                &connected
            ),
            ["Asana", "Jira"]
        );
        let saved: serde_yaml::Value = serde_yaml::from_str(&team(&["Jira"])).unwrap();
        assert_eq!(
            super::missing_tools(&team(&["Jira", "Asana"]), Some(&saved), &connected),
            ["Asana"]
        );
    }

    /// A proposal connects only folders and files that are there, and puts an agent to work only
    /// in a folder that is there, resolved as a run resolves them.
    #[test]
    fn a_proposal_names_only_places_that_are_there() {
        let dir =
            std::env::temp_dir().join(format!("loomwatch-ask-places-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("notes")).expect("a folder");
        std::fs::write(dir.join("brief.md"), "the brief").expect("a file");
        let team = |knowledge: &str, cwd: &str| {
            format!(
                "agents:\n  - id: a\n    spawn: {{cwd: '{cwd}'}}\n    capabilities:\n      - {{kind: knowledge, name: K, path: '{knowledge}'}}\n      - {{kind: knowledge, name: Page, notion: {{page: abc}}}}\n"
            )
        };
        let absolute = dir.join("brief.md").to_string_lossy().into_owned();
        assert!(super::missing_places(&team("notes", "."), None, &dir).is_empty());
        assert!(super::missing_places(&team(&absolute, "notes"), None, &dir).is_empty());
        assert_eq!(
            super::missing_places(&team("gone", "brief.md"), None, &dir),
            ["gone", "brief.md"],
            "a file is no folder to work in"
        );
        let saved: serde_yaml::Value = serde_yaml::from_str(&team("gone", ".")).unwrap();
        assert!(super::missing_places(&team("gone", "."), Some(&saved), &dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The example team is what the app copies when it writes one, so it has to be a team the
    /// daemon runs: a role in the three parts the instructions ask for, and a file `propose_team`
    /// accepts as it stands.
    #[test]
    fn the_example_team_in_the_instructions_is_one_propose_team_accepts() {
        let yaml = examples()[0];
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

    /// What the blind grade of Ask's teams found (ADR 0096): a check step looks at what the person
    /// will see and sends its findings to an agent that can fix them, everything the person asked
    /// for is in a Done when the check can confirm, and the reply names things as the person
    /// knows them, not as the app's jobs.
    #[test]
    fn ask_checks_what_the_person_sees_and_names_things_as_they_know_them() {
        let rule = |words: &str| {
            INSTRUCTIONS
                .lines()
                .find(|line| line.contains(words))
                .unwrap_or_else(|| panic!("no rule saying {words:?}"))
        };
        let check = rule("end with a check step");
        assert!(
            check.contains("Check the work the person will see")
                && check.contains("can fix whatever the check finds")
                && check.contains("the web when a fix may need a new source"),
            "{check}"
        );
        assert!(
            rule("Give each agent a `doneWhen`").contains("what isn't in `doneWhen` isn't checked")
        );
        let reply = rule("In your reply, say");
        assert!(
            reply.contains("(your Researcher, a Writer, your Client notes folder)")
                && !reply.contains("Writer job"),
            "{reply}"
        );
        let plain = rule("Reply in plain words");
        assert!(
            plain.contains("say what the person gets when the team runs")
                && plain.contains("they can name their own")
                && plain.contains("say it will ask, so they know to allow it"),
            "{plain}"
        );
    }

    /// A check step Ask writes sends a missed check back by default (ADR 0062): without it, the
    /// check costs about half a run and changes nothing in the answer. And it thinks only as hard
    /// as the work it checks needs.
    #[test]
    fn ask_sets_check_steps_up_to_send_work_back_at_the_work_s_effort() {
        let rule = INSTRUCTIONS
            .lines()
            .find(|line| line.contains("end with a check step"))
            .expect("the instructions say when to add a check step");
        assert!(
            rule.contains("Add `sendBack: {rounds: 2, whenStillNotMet: ask}`, so"),
            "{rule}"
        );
        assert!(!rule.contains("only if the person wants"), "{rule}");
    }

    /// And a check step Ask proposes without saying sends a miss back too, written into the file
    /// beside its `checks:` line; one that says, either way, keeps what it says.
    #[test]
    fn a_proposed_check_step_sends_a_miss_back_unless_it_says_not_to() {
        let file = |checker: &str| {
            format!(
                "schemaVersion: 1\nid: checked\nname: Checked\nentrypoint: writer\nagents:\n  - id: writer\n    \
                 name: Writer\n    role: Write it.\n    model: anthropic/claude-sonnet-5.5\n  - id: \
                 checker\n    name: Checker\n    role: Check it.\n    model: openai/gpt-6.1-sol\n{checker}\
                 edges:\n  - {{ from: writer, to: checker, layer: configured, kind: sequence, ts: \
                 \"2026-10-18T00:00:00Z\" }}\n"
            )
        };
        let proposed = file("    checks: writer  # the writer's piece\n");
        let written = super::with_send_back(&proposed, &TeamConfig::parse(&proposed).unwrap());
        assert!(
            written.contains(
                "    checks: writer  # the writer's piece\n    sendBack:\n      rounds: 2\n      \
                 whenStillNotMet: ask\n"
            ),
            "{written}"
        );
        let team = TeamConfig::parse(&written).unwrap();
        assert_eq!(team.agents[1].send_back, Some(crate::config::SendBack::NEW));
        assert!(
            schema_problems(&written).is_empty(),
            "{:?}",
            schema_problems(&written)
        );
        // Said either way, it stands; and a team with no check step is left as written.
        for says in [
            "    checks: writer\n    sendBackOnce: false\n",
            "    checks: writer\n    sendBack: {rounds: 1}\n",
        ] {
            let kept = file(says);
            assert_eq!(
                super::with_send_back(&kept, &TeamConfig::parse(&kept).unwrap()),
                kept
            );
        }
        let plain = file("");
        let plain = plain.replace("edges:\n  - { from: writer, to: checker, layer: configured, kind: sequence, ts: \"2026-10-18T00:00:00Z\" }\n", "edges: []\n");
        assert_eq!(
            super::with_send_back(&plain, &TeamConfig::parse(&plain).unwrap()),
            plain
        );
    }
}

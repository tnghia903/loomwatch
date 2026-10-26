//! Ask `LoomWatch` end to end, on `LoomWatch`'s own agent with a scripted stand-in for the model:
//! no model provider is ever contacted (ADR 0033).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};

use super::{Caller, Control, ControlOptions, mcp::ControlTools};
use crate::agent::{Completion, Demo, HostTools, Message, ToolCall};
use crate::archive::EventArchive;
use crate::runs::RunRegistry;

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new(label: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("loomwatch-ask-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("temporary directory");
        Self(crate::platform::canonicalize(&path).expect("canonical temporary directory"))
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The team the stand-in proposes: four steps with a review stop, every agent on the offline demo
/// model, so a run of it needs no key.
const TEAM: &str = r#"schemaVersion: 1
id: morning-chip-brief
name: Morning chip brief
entrypoint: collector
agents:
  - id: collector
    name: Collector
    role: Collect today's AI and chip news, with a link for every story.
    model: fake/offline
  - id: checker
    name: Fact-checker
    role: Check every claim against its source and list any you cannot confirm.
    model: fake/offline
  - id: review
    kind: operator
    name: You
    role: Fact-checker is done. Approve the brief, or say what to change.
  - id: writer
    name: Writer
    role: Write a five-bullet brief from the checked stories.
    model: fake/offline
edges:
  - {from: collector, to: checker, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}
  - {from: checker, to: review, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}
  - {from: review, to: writer, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}
"#;

/// What the tools answered since the person's newest message, oldest first.
fn answers(messages: &[Message]) -> Vec<&str> {
    let start = messages
        .iter()
        .rposition(|message| matches!(message, Message::User { .. }))
        .map_or(0, |at| at + 1);
    messages[start..]
        .iter()
        .filter_map(|message| match message {
            Message::Tool { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect()
}

fn calling(step: usize, text: &str, tool: &str, arguments: &Value) -> Completion {
    Completion::calls(
        text,
        vec![ToolCall {
            id: format!("call-{step}-{tool}"),
            name: tool.to_owned(),
            arguments: arguments.to_string(),
        }],
    )
}

/// Stands in for the model behind Ask: reads the person's message and the tools' answers, and
/// calls the Control tools the way a model would.
///
/// - "folder": builds from what the person has ([`build_from_what_they_have`]).
/// - "team" or "brief": proposes a broken team file first (to exercise the validation loop), then
///   the valid four-step team with a review stop.
/// - "run": asks to start a run of it.
/// - "note": drafts a note for an open review stop.
/// - anything else: lists the teams.
///
/// An instructions rewrite (ADR 0059) is answered without tools and with edits only: a numbered
/// sentence that says "from the <name> page" loses those words, every other sentence naming what
/// was removed is dropped, and the edits come back as JSON in a code fence, as a real model tends
/// to send them. Something removed whose name says "unreadable" gets an answer with no JSON in it.
fn assistant() -> Demo {
    Demo::responder(|request| {
        let prompt = request.prompt();
        if prompt.contains("## The agents' instructions") {
            return Some(Completion::text(&rewrite(prompt)));
        }
        let message = prompt
            .rsplit("## The person's message")
            .next()
            .unwrap_or(prompt)
            .to_lowercase();
        let answers = answers(&request.messages);
        let step = answers.len();
        let reply = if message.contains("folder") {
            build_from_what_they_have(step, &answers)
        } else if message.contains("note") {
            match step {
                0 => calling(step, "", "get_run", &json!({})),
                1 => calling(
                    step,
                    "",
                    "draft_review_note",
                    &json!({"text": "Approved. Keep the brief to five bullets."}),
                ),
                _ => {
                    let run: Value = serde_json::from_str(answers[0]).unwrap_or_default();
                    let question = run
                        .pointer("/waitingOn/question")
                        .and_then(Value::as_str)
                        .unwrap_or("the open question");
                    Completion::text(&format!(
                        "The team is waiting for you on: {question} I drafted a note you can put \
                         in the review box."
                    ))
                }
            }
        } else if message.contains("run") {
            if step == 0 {
                calling(
                    step,
                    "",
                    "start_run",
                    &json!({"file": "morning-chip-brief.yaml", "request": "Prepare today's brief."}),
                )
            } else {
                Completion::text(&match serde_json::from_str::<Value>(answers[0]) {
                    Ok(outcome) if outcome["status"] == "started" => {
                        "Started the run. I'll keep an eye on it here.".to_owned()
                    }
                    Ok(_) => "Press Start run in the card when you're ready. Nothing runs until \
                              you do."
                        .to_owned(),
                    Err(_) => format!("I couldn't start it: {}", answers[0]),
                })
            }
        } else if message.contains("team") || message.contains("brief") {
            let propose = |yaml: &str, summary: &str| json!({"file": "morning-chip-brief.yaml", "yaml": yaml, "summary": summary});
            match step {
                0 => calling(
                    step,
                    "",
                    "propose_team",
                    &propose(
                        &TEAM.replace("entrypoint: collector", "entrypoint: nobody"),
                        "A first draft",
                    ),
                ),
                1 => calling(
                    step,
                    "My first draft named a starting agent that doesn't exist, so I fixed it. ",
                    "propose_team",
                    &propose(
                        TEAM,
                        "A weekday brief: Collector gathers, Fact-checker checks, you approve, \
                         Writer writes.",
                    ),
                ),
                _ => Completion::text(
                    "Here is a team for that. Fact-checker checks every claim, and the team stops \
                     for you before the Writer starts. Apply it on the canvas, or tell me what to \
                     change.",
                ),
            }
        } else if step == 0 {
            calling(step, "", "list_teams", &json!({}))
        } else {
            let listed: Value = serde_json::from_str(answers[0]).unwrap_or_default();
            let names = listed["teams"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|team| team["name"].as_str().or_else(|| team["file"].as_str()))
                .collect::<Vec<_>>()
                .join(", ");
            Completion::text(&format!(
                "Your teams: {}.",
                if names.is_empty() { "none yet" } else { &names }
            ))
        };
        Some(reply)
    })
}

/// "…from my Client notes folder, with my researcher": the stand-in looks at what the person has
/// first, as Ask is told to, then proposes a pipeline that points at their Researcher, starts the
/// Writer from `LoomWatch`'s job, and gives the Writer alone the folder `find_files` found.
fn build_from_what_they_have(step: usize, answers: &[&str]) -> Completion {
    let answer = |at: usize| serde_json::from_str::<Value>(answers[at]).unwrap_or_default();
    match step {
        0 => calling(step, "", "list_my_agents", &json!({})),
        1 => calling(step, "", "read_job", &json!({"job": "writer"})),
        2 => calling(step, "", "find_files", &json!({"name": "Client notes"})),
        3 => {
            let agent = answer(0)["agents"][0]["id"]
                .as_str()
                .unwrap_or("nobody")
                .to_owned();
            let writer = answer(1);
            let folder = answer(2)["found"][0]["path"]
                .as_str()
                .unwrap_or("nowhere")
                .to_owned();
            let role = writer["role"].as_str().unwrap_or_default().replacen(
                '\n',
                "\nThe review is for the client's managers: one page, what changed this quarter.\n",
                1,
            );
            let indented = role.lines().fold(String::new(), |indented, line| {
                indented + "      " + line + "\n"
            });
            let yaml = format!(
                "schemaVersion: 1\nid: client-review\nname: Client review\nentrypoint: researcher\n\
                 agents:\n  - id: researcher\n    from: {{agent: {agent}}}\n  - id: writer\n    \
                 name: Writer\n    role: |\n{indented}    model: {}\n    thinkingEffort: {}\n    \
                 doneWhen: {}\n    capabilities:\n      - {{kind: knowledge, name: Client notes, \
                 path: '{folder}'}}\nedges:\n  - {{from: researcher, to: writer, layer: configured, \
                 kind: sequence, ts: \"2026-10-26T00:00:00Z\"}}\n",
                writer["model"].as_str().unwrap_or_default(),
                writer["thinkingEffort"].as_str().unwrap_or_default(),
                writer["doneWhen"],
            );
            calling(
                step,
                "",
                "propose_team",
                &json!({"file": "client-review.yaml", "yaml": yaml, "summary": "Your Researcher finds, the Writer writes from your Client notes."}),
            )
        }
        _ => Completion::text(
            "I used your Researcher as it is, started the Writer from LoomWatch's Writer, and gave \
             the Writer your Client notes folder. Apply it on the canvas, or tell me what to change.",
        ),
    }
}

fn rewrite(prompt: &str) -> String {
    let removed = prompt
        .split("removed the ")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .unwrap_or_default();
    if removed.contains("unreadable") {
        return "I removed it from their instructions.".to_owned();
    }
    let lead = removed.split(" — ").next().unwrap_or(removed);
    let mut edits = Vec::new();
    let mut agent = "";
    let listing = prompt
        .split("## The agents' instructions")
        .nth(1)
        .unwrap_or_default();
    for line in listing.lines() {
        if let Some(heading) = line.strip_prefix("### ") {
            agent = heading.split_whitespace().next().unwrap_or_default();
        } else if let Some(rest) = line.strip_prefix('[')
            && let Some((n, sentence)) = rest.split_once("] ")
            && let Ok(n) = n.parse::<u64>()
            && sentence.contains(lead)
        {
            let kept = sentence.replace(&format!(" from the {lead} page"), "");
            edits.push(if kept == sentence {
                json!({"agent": agent, "n": n, "drop": true})
            } else {
                json!({"agent": agent, "n": n, "replace": kept})
            });
        }
    }
    format!("Here they are:\n```json\n{}\n```", json!({"edits": edits}))
}

/// A served [`Control`] over a scratch teams folder, skills folder and home folder.
struct Fixture {
    root: TempDirectory,
    skills: TempDirectory,
    home: TempDirectory,
    base: String,
    control: Control,
    registry: RunRegistry,
    client: reqwest::Client,
}

impl Fixture {
    /// With `ask_model`, every conversation runs on it whatever the person chose, as
    /// `LOOMWATCH_ASK_MODEL` makes them.
    async fn start(archive: Option<EventArchive>, ask_model: Option<String>) -> Self {
        let root = TempDirectory::new("teams");
        let skills = TempDirectory::new("skills");
        let home = TempDirectory::new("home");
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let registry = RunRegistry::default();
        let control = Control::new(ControlOptions {
            archive,
            teams_root: root.0.clone(),
            skills_folder: Some(skills.0.clone()),
            registry: registry.clone(),
            listen: address,
            ask_model,
            home: Some(home.0.clone()),
        });
        let router = control.router();
        tokio::spawn(async move { axum::serve(listener, router).await });
        Self {
            root,
            skills,
            home,
            base: format!("http://{address}"),
            control,
            registry,
            client: reqwest::Client::new(),
        }
    }

    async fn post(&self, path: &str, body: &Value) -> (u16, Value) {
        let response = self
            .client
            .post(format!("{}{path}", self.base))
            .json(body)
            .send()
            .await
            .expect("post");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .expect("get");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    /// Send a message and wait for the assistant to finish its turn.
    async fn say(&self, conversation: &str, text: &str) {
        let (status, body) = self
            .post(
                &format!("/api/ask/conversations/{conversation}/messages"),
                &json!({"text": text, "context": {"view": "home"}}),
            )
            .await;
        assert_eq!(status, 202, "message accepted: {body}");
        for _ in 0..300 {
            let (_, status) = self
                .get(&format!("/api/ask/conversations/{conversation}"))
                .await;
            match status["state"].as_str() {
                Some("ready") => return,
                Some("failed") => panic!("conversation failed: {status}"),
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
        panic!("the assistant never finished its turn");
    }

    async fn events(&self, conversation: &str) -> Vec<crate::RunEvent> {
        self.control
            .inner
            .archive
            .as_ref()
            .expect("archive")
            .load_session(conversation)
            .await
            .expect("events")
    }

    async fn end(&self, conversation: &str) -> u16 {
        self.client
            .delete(format!(
                "{}/api/ask/conversations/{conversation}",
                self.base
            ))
            .send()
            .await
            .expect("delete")
            .status()
            .as_u16()
    }
}

fn phases<'a>(events: &'a [crate::RunEvent], phase: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event.payload["phase"] == phase)
        .map(|event| &event.payload)
        .collect()
}

/// Every event in one line each, for a failure message that explains itself.
fn dump(events: &[crate::RunEvent]) -> String {
    events
        .iter()
        .map(|event| {
            let detail = [
                event.payload.get("phase"),
                event.payload.get("title"),
                event.payload.get("status"),
                event.payload.pointer("/content/text"),
                event.payload.get("message"),
                event.payload.get("error"),
            ]
            .into_iter()
            .flatten()
            .map(|value| value.to_string().chars().take(160).collect::<String>())
            .collect::<Vec<_>>()
            .join(" ");
            format!("{:?} {detail}", event.kind)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn said(events: &[crate::RunEvent]) -> String {
    events
        .iter()
        .filter(|event| event.kind == crate::EventKind::Message && event.payload["role"] == "agent")
        .filter_map(|event| {
            event
                .payload
                .pointer("/content/text")
                .and_then(Value::as_str)
        })
        .collect()
}

#[allow(clippy::too_many_lines)]
#[tokio::test]
async fn a_conversation_proposes_asks_before_running_and_drafts_a_review_note() {
    let pool = crate::db::Db::temp().await;
    let demo = assistant();
    let fixture = Fixture::start(
        Some(EventArchive::new(pool)),
        Some(crate::engine::demo_model(demo.clone())),
    )
    .await;
    let (status, started) = fixture.post("/api/ask/conversations", &json!({})).await;
    assert_eq!(status, 201, "{started}");
    assert_eq!(started["appName"], "Ask LoomWatch");
    let id = started["id"].as_str().expect("id").to_owned();

    // A proposal: the broken draft is refused by the same rules as a save, the fixed one is
    // archived for the panel, and nothing is written to disk.
    fixture.say(&id, "Build me a morning brief team").await;
    let events = fixture.events(&id).await;
    let proposals = phases(&events, "ask_proposal");
    assert_eq!(
        proposals.len(),
        1,
        "only the valid draft becomes a proposal: {}",
        dump(&events)
    );
    let proposal = proposals[0];
    assert_eq!(proposal["file"], "morning-chip-brief.yaml");
    assert_eq!(proposal["isNew"], true);
    assert_eq!(proposal["baseRevision"], Value::Null);
    let yaml = proposal["yaml"].as_str().expect("yaml").to_owned();
    assert!(crate::config::TeamConfig::parse(&yaml).is_ok());
    assert!(
        !fixture.root.0.join("morning-chip-brief.yaml").exists(),
        "a proposal never writes the team file"
    );
    let refused = events
        .iter()
        .filter(|event| {
            event.kind == crate::EventKind::ToolUpdate && event.payload["status"] == "failed"
        })
        .count();
    assert_eq!(
        refused,
        1,
        "the broken draft came back as a tool error: {}",
        dump(&events)
    );
    assert!(
        said(&events).contains("fixed it"),
        "the assistant saw the error and fixed it"
    );
    assert_eq!(
        phases(&events, "ask_message")[0]["text"],
        "Build me a morning brief team"
    );
    let (status, stored) = fixture
        .get(&format!(
            "/api/ask/proposals/{}",
            proposal["proposalId"].as_str().expect("id")
        ))
        .await;
    assert_eq!(status, 200);
    assert_eq!(stored["yaml"], yaml.as_str());

    // Its only tools are the Control tools: no files, no commands, no web. `read_tool_output`
    // reads only a long answer of these tools that was set aside, and is offered from the start so
    // the tool list never changes.
    let offered = &demo.requests()[0].tools;
    assert_eq!(
        offered,
        &[
            "list_teams",
            "read_team",
            "list_models",
            "list_skills",
            "list_jobs",
            "read_job",
            "list_my_agents",
            "list_tools",
            "find_files",
            "propose_team",
            "start_run",
            "get_run",
            "draft_review_note",
            "read_tool_output"
        ],
        "no tool answers a review stop, saves a file, or deletes anything"
    );

    // A run of a team that was only proposed is refused with the reason.
    fixture.say(&id, "run it").await;
    let events = fixture.events(&id).await;
    assert!(
        said(&events).contains("There is no team file morning-chip-brief.yaml yet")
            && said(&events).contains("press Apply before it can run"),
        "{}",
        said(&events)
    );
    assert!(phases(&events, "ask_run_request").is_empty());

    // Applied (the panel saves with the editor's own PUT): now the assistant may only ask.
    std::fs::write(fixture.root.0.join("morning-chip-brief.yaml"), &yaml).expect("apply");
    fixture.say(&id, "run it").await;
    let events = fixture.events(&id).await;
    let requests = phases(&events, "ask_run_request");
    assert_eq!(requests.len(), 1, "{}", dump(&events));
    assert_eq!(requests[0]["name"], "Morning chip brief");
    assert_eq!(requests[0]["request"], "Prepare today's brief.");
    assert_eq!(requests[0]["models"], json!(["fake/offline"]));
    assert!(fixture.registry.list().is_empty(), "asking starts nothing");
    let request = requests[0]["requestId"]
        .as_str()
        .expect("request")
        .to_owned();
    let (status, _) = fixture
        .post(
            &format!("/api/ask/conversations/{id}/run-requests/{request}"),
            &json!({"decision": "declined"}),
        )
        .await;
    assert_eq!(status, 204);
    assert_eq!(
        phases(&fixture.events(&id).await, "ask_run_declined").len(),
        1
    );

    // With direct runs allowed, the same tool starts a real run.
    let (status, _) = fixture
        .post(
            &format!("/api/ask/conversations/{id}/settings"),
            &json!({"askBeforeRun": false}),
        )
        .await;
    assert_eq!(status, 200);
    fixture.say(&id, "run it").await;
    let events = fixture.events(&id).await;
    let started = phases(&events, "ask_run_started");
    assert_eq!(started.len(), 1, "{}", dump(&events));
    let run_id = started[0]["runId"].as_str().expect("run").to_owned();
    assert!(fixture.registry.get(&run_id).is_some());

    // The run reaches its review stop; the assistant can draft a note but not answer it.
    let mut waiting = false;
    for _ in 0..300 {
        if fixture
            .registry
            .get(&run_id)
            .is_some_and(|record| record.waiting_on.is_some())
        {
            waiting = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        waiting,
        "the run reached its review stop: {:?}",
        fixture.registry.get(&run_id)
    );
    fixture.say(&id, "draft a note").await;
    let events = fixture.events(&id).await;
    let notes = phases(&events, "ask_review_note");
    assert_eq!(notes.len(), 1, "{}", dump(&events));
    assert_eq!(notes[0]["runId"], run_id.as_str());
    assert_eq!(notes[0]["node"], "review");
    assert_eq!(
        notes[0]["text"],
        "Approved. Keep the brief to five bullets."
    );
    let record = fixture.registry.get(&run_id).expect("run");
    assert!(
        record.waiting_on.is_some(),
        "a drafted note answers nothing"
    );

    assert_eq!(fixture.end(&id).await, 204);
    let mut ended = Value::Null;
    for _ in 0..100 {
        (_, ended) = fixture.get(&format!("/api/ask/conversations/{id}")).await;
        if ended["state"] == "ended" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(ended["state"], "ended", "{ended}");
    let _ = fixture.registry.cancel(&run_id);
}

#[tokio::test]
async fn the_person_chooses_the_model_a_conversation_uses() {
    let pool = crate::db::Db::temp().await;
    let fixture = Fixture::start(Some(EventArchive::new(pool)), None).await;
    let demo = assistant();
    let chosen = crate::engine::demo_model(demo.clone());

    let (status, refused) = fixture
        .post("/api/ask/conversations", &json!({"model": "a\nb"}))
        .await;
    assert_eq!(
        status, 422,
        "a model with a line break is not an id: {refused}"
    );

    let (status, started) = fixture
        .post(
            "/api/ask/conversations",
            &json!({"model": format!("  {chosen}  ")}),
        )
        .await;
    assert_eq!(status, 201, "{started}");
    assert_eq!(started["app"], "loomwatch");
    assert_eq!(started["model"], chosen.as_str());
    let id = started["id"].as_str().expect("id").to_owned();
    let (_, status) = fixture.get(&format!("/api/ask/conversations/{id}")).await;
    assert_eq!(status["model"], chosen.as_str());

    // Every turn is asked of that model, and the transcript says which.
    fixture.say(&id, "What do I have here?").await;
    let events = fixture.events(&id).await;
    assert!(
        demo.requests()
            .iter()
            .all(|request| request.model == chosen),
        "{:?}",
        demo.requests()
    );
    assert!(
        said(&events).starts_with("Your teams: none yet."),
        "{}",
        said(&events)
    );
    let recorded = phases(&events, "ask_status");
    assert!(
        recorded
            .iter()
            .all(|status| status["app"]["model"] == chosen.as_str()),
        "{}",
        dump(&events)
    );

    // No model means LoomWatch's default.
    let (status, default) = fixture
        .post("/api/ask/conversations", &json!({"model": ""}))
        .await;
    assert_eq!(status, 201, "{default}");
    assert_eq!(default["model"], crate::ai::DEFAULT_MODEL);
    for conversation in [id, default["id"].as_str().expect("id").to_owned()] {
        fixture.end(&conversation).await;
    }
}

/// ADR 0074: Ask `LoomWatch` knows who it is talking to, as every agent does. The rewrite of an
/// agent's instructions is not told: it writes `LoomWatch`'s text, which "answer in Vietnamese"
/// must not translate.
#[tokio::test]
async fn ask_is_told_who_the_person_is_and_a_rewrite_is_not() {
    let pool = crate::db::Db::temp().await;
    // One model answers both; the rewrite's own instructions tell its requests apart.
    let demo = assistant();
    let fixture = Fixture::start(
        Some(EventArchive::new(pool)),
        Some(crate::engine::demo_model(demo.clone())),
    )
    .await;
    let _told = crate::you::testing::tell_agents_under(
        &fixture.root.0,
        crate::you::AboutYou {
            name: Some("Mai".into()),
            about: Some("Answer in Vietnamese.".into()),
            skipped: false,
        },
    );
    let instructions = |rewrite: bool| {
        demo.requests()
            .iter()
            .filter_map(|request| match request.messages.first() {
                Some(Message::System { content }) => Some(content.clone()),
                _ => None,
            })
            .filter(|content| content.contains("You edit the instructions of agents") == rewrite)
            .collect::<Vec<_>>()
    };

    let (status, started) = fixture.post("/api/ask/conversations", &json!({})).await;
    assert_eq!(status, 201, "{started}");
    let id = started["id"].as_str().expect("id").to_owned();
    fixture.say(&id, "What do I have here?").await;
    let asked = instructions(false);
    assert!(!asked.is_empty());
    for content in &asked {
        assert!(content.contains("working on a task for Mai,"), "{content}");
        assert!(content.contains("> Answer in Vietnamese.\n"), "{content}");
    }
    fixture.end(&id).await;

    let (status, answer) = fixture
        .post(
            "/api/ask/instructions",
            &json!({
                "removed": {"name": "EKIS", "kind": "Notion page"},
                "agents": [{"id": "plan", "name": "Plan writer", "role": "Keep the plan on the EKIS page."}],
            }),
        )
        .await;
    assert_eq!(status, 200, "{answer}");
    let rewritten = instructions(true);
    assert!(!rewritten.is_empty());
    for content in &rewritten {
        assert!(
            !content.contains("Mai") && !content.contains("The person you work for"),
            "{content}"
        );
    }
}

/// ADR 0059: one turn of the assistant, with no tools, answers with edits to numbered sentences,
/// and the daemon returns each changed agent's instructions with them made: every sentence the
/// assistant didn't name, and the spacing between, stays as it was. Nothing is written and no
/// conversation is left open.
#[tokio::test]
async fn removing_a_source_rewrites_the_instructions_that_named_it() {
    let pool = crate::db::Db::temp().await;
    let demo = assistant();
    let fixture = Fixture::start(
        Some(EventArchive::new(pool)),
        Some(crate::engine::demo_model(demo.clone())),
    )
    .await;
    let removed = |name: &str| json!({"name": name, "kind": "Notion page"});
    let agents = json!([
        {"id": "scope", "name": "Project scope", "role": "Establish the project's problem from the EKIS page. Locate the EKIS page through the connected Notion tools.\n\nReply with a brief.  Keep it short.\n"},
        {"id": "plan", "name": "Plan writer", "role": "Maintain the plan on the canonical EKIS page."},
        {"id": "writer", "name": "Writer", "role": "Write the report. Cite sources."},
    ]);

    let (status, answer) = fixture
        .post(
            "/api/ask/instructions",
            &json!({"removed": removed("EKIS — SUTD Final Project Hub"), "agents": agents}),
        )
        .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["appName"], "Ask LoomWatch");
    assert_eq!(
        answer["agents"],
        json!([{"id": "scope", "role": "Establish the project's problem.\n\nReply with a brief.  Keep it short.\n"}]),
        "an agent left with no instructions is not rewritten to nothing, one with no edits is not \
         returned, and the rest of scope's instructions are byte for byte what they were"
    );
    assert!(
        demo.requests()
            .iter()
            .all(|request| request.tools.is_empty()),
        "the rewrite is given no tools"
    );
    assert!(
        fixture.control.inner.conversations.read().await.is_empty(),
        "a rewrite is not an Ask conversation"
    );
    assert!(
        std::fs::read_dir(&fixture.root.0)
            .expect("teams folder")
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".yaml")),
        "nothing is written"
    );

    let (status, refused) = fixture
        .post(
            "/api/ask/instructions",
            &json!({"removed": removed("an unreadable page"), "agents": agents}),
        )
        .await;
    assert_eq!(status, 502, "{refused}");
    assert_eq!(
        refused["error"],
        "Ask LoomWatch replied without the rewritten instructions. Try again."
    );

    let (status, refused) = fixture
        .post(
            "/api/ask/instructions",
            &json!({"removed": removed("EKIS"), "agents": []}),
        )
        .await;
    assert_eq!(status, 422, "{refused}");
}

/// A proposal has to be one the editor can save: the editor checks the team schema before every
/// save, so a file `TeamConfig::parse` accepts but the schema refuses would land on the canvas and
/// then refuse to apply. Paths a proposal may not use are refused before anything is parsed.
#[tokio::test]
async fn a_proposal_must_pass_the_editors_schema_and_name_a_plain_team_file() {
    let fixture = Fixture::start(None, None).await;
    let tools = ControlTools::new(
        fixture.control.clone(),
        Caller::Conversation("ask-test".to_owned()),
    );
    let propose =
        |file: &str, yaml: &str| json!({"file": file, "yaml": yaml, "summary": "A brief."});
    for file in [
        "../outside.yaml",
        "/etc/team.yaml",
        ".hidden/team.yaml",
        "team.txt",
        "missing/team.yaml",
    ] {
        let (_, failed) = tools
            .call("propose_team", propose(file, "schemaVersion: 1"))
            .await;
        assert!(failed, "{file}");
    }

    let team = |extra: &str| {
        format!(
            "schemaVersion: 1\nid: brief\nname: Brief\nentrypoint: a\nagents:\n  - id: a\n    \
             name: Collector\n    role: Collect\n    model: anthropic/claude-sonnet-5.5\n{extra}edges: []\n"
        )
    };
    let (message, failed) = tools
        .call(
            "propose_team",
            propose("brief.yaml", &team("    colour: blue\n")),
        )
        .await;
    assert!(failed, "{message}");
    assert!(
        message.starts_with("The team file has a problem:") && message.contains("colour"),
        "{message}"
    );
    let (answer, failed) = tools
        .call("propose_team", propose("brief.yaml", &team("")))
        .await;
    assert!(!failed, "an agent needs only a name and a model: {answer}");
    let answer: Value = serde_json::from_str(&answer).expect("json");
    assert!(
        answer["message"]
            .as_str()
            .is_some_and(|text| text.contains("Nothing is saved until they press Apply")),
        "{answer}"
    );
}

/// A check step Ask proposes without saying whether it sends a miss back is shown, and saved on
/// Apply, sending it back (ADR 0062), as one made from a template or on the canvas does.
#[tokio::test]
async fn a_proposed_check_step_is_saved_sending_a_miss_back() {
    let fixture = Fixture::start(None, None).await;
    let tools = ControlTools::new(
        fixture.control.clone(),
        Caller::Conversation("ask-test".to_owned()),
    );
    let yaml = "schemaVersion: 1\nid: checked\nname: Checked\nentrypoint: writer\nagents:\n  - id: writer\n    \
                name: Writer\n    role: Write it.\n    model: anthropic/claude-sonnet-5.5\n  - id: checker\n    \
                name: Checker\n    role: Check it.\n    model: openai/gpt-6.1-sol\n    checks: writer\nedges:\n  \
                - { from: writer, to: checker, layer: configured, kind: sequence, ts: \"2026-10-18T00:00:00Z\" }\n";
    let (answer, failed) = tools
        .call(
            "propose_team",
            json!({"file": "checked.yaml", "yaml": yaml, "summary": "A checked team."}),
        )
        .await;
    assert!(!failed, "{answer}");
    let answer: Value = serde_json::from_str(&answer).expect("json");
    let id = answer["proposalId"].as_str().expect("a proposal id");
    let proposals = fixture.control.inner.proposals.read().await;
    let proposed = &proposals.get(id).expect("the proposal is kept").yaml;
    assert!(
        proposed.contains(
            "    checks: writer\n    sendBack:\n      rounds: 2\n      whenStillNotMet: ask\n"
        ),
        "{proposed}"
    );
}

/// Without the daemon's model list (no state folder set up), `list_models` says so rather than
/// inventing models.
#[tokio::test]
async fn list_models_never_invents_a_model() {
    let fixture = Fixture::start(None, None).await;
    let tools = ControlTools::new(
        fixture.control.clone(),
        Caller::Conversation("ask-test".to_owned()),
    );
    let (answer, failed) = tools.call("list_models", json!({})).await;
    if crate::ai::installed().is_none() {
        assert!(failed, "{answer}");
        assert!(answer.contains("model list isn't available"), "{answer}");
    }
}

/// Ask chooses each agent's model and effort from the same table as the app's templates and new
/// agents, so a researcher it writes runs on the model the template's does, and nothing tells
/// an agent to open its sources a second time.
#[test]
fn ask_chooses_models_from_the_shared_table() {
    let choosing = super::mcp::choosing();
    let job = |id: &str| {
        choosing["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|job| job["job"] == id)
            .cloned()
            .unwrap_or_else(|| panic!("no job {id}: {choosing}"))
    };
    let tiers = &*crate::ai::MODEL_TIERS;
    assert_eq!(
        job("researcher")["model"],
        tiers.models[&tiers.jobs["researcher"].tier]
    );
    assert_eq!(
        job("researcher")["model"],
        tiers.models["strong"],
        "quality first"
    );
    assert_eq!(job("researcher")["thinkingEffort"], "medium");
    assert_eq!(job("checker")["model"], tiers.models["check"]);
    assert_eq!(job("editor")["thinkingEffort"], "low");
    assert_eq!(
        choosing["anyOtherAgent"],
        json!({"model": tiers.models["strong"], "thinkingEffort": "medium"})
    );
    assert_eq!(choosing["jobs"].as_array().unwrap().len(), tiers.jobs.len());
    assert!(
        choosing["tiers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tier| tier["for"].is_string())
    );
    let instructions = super::mcp::INSTRUCTIONS;
    assert!(instructions.contains("`list_models`' `choosing`"));
    assert!(!instructions.contains("open each link again"));
    assert!(!instructions.contains("the default for hard work"));
}

/// Ask gives an agent a skill the way the canvas does, as a wired skill by its name, so it shows as
/// a card and the run delivers it: `list_skills` lists what a run can deliver, and a proposal that
/// wires a skill no run could find is refused before it reaches the canvas.
#[tokio::test]
async fn ask_wires_a_skill_by_a_name_a_run_can_deliver() {
    let fixture = Fixture::start(None, None).await;
    let skill = fixture.skills.0.join("explain-like-im-5");
    std::fs::create_dir_all(&skill).expect("skill folder");
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: explain-like-im-5\ndescription: Explain any topic in words a five-year-old could follow.\n---\n\nStart from what they know.\n",
    )
    .expect("skill file");
    let tools = ControlTools::new(
        fixture.control.clone(),
        Caller::Conversation("ask-test".to_owned()),
    );
    assert!(
        tools.specs().iter().any(|spec| spec.name == "list_skills"),
        "Ask can see the skills"
    );
    let (answer, failed) = tools.call("list_skills", json!({})).await;
    assert!(!failed, "{answer}");
    let answer: Value = serde_json::from_str(&answer).expect("json");
    assert_eq!(
        answer["skills"],
        json!([{
            "name": "explain-like-im-5",
            "for": "Explain any topic in words a five-year-old could follow.",
            "from": "LoomWatch",
        }])
    );

    let team = |skills: &[&str]| {
        let wired = skills.iter().fold(String::new(), |wired, name| {
            wired + &format!("      - {{kind: skill, name: {name}}}\n")
        });
        format!(
            "schemaVersion: 1\nid: tutor\nname: Tutor\nentrypoint: tutor\nagents:\n  - id: tutor\n    \
             name: Tutor\n    role: Teach it.\n    model: anthropic/claude-sonnet-5.5\n    \
             capabilities:\n{wired}edges: []\n"
        )
    };
    let propose = |yaml: String| json!({"file": "tutor.yaml", "yaml": yaml, "summary": "A tutor."});
    let (answer, failed) = tools
        .call("propose_team", propose(team(&["Explain-Like-Im-5"])))
        .await;
    assert!(!failed, "a run finds a skill whatever its case: {answer}");

    let (message, failed) = tools
        .call(
            "propose_team",
            propose(team(&["explain-like-im-5", "eli5", "ELI5"])),
        )
        .await;
    assert!(failed, "{message}");
    assert!(
        message == "eli5 isn't one of your skills. Add it on the Skills page.",
        "{message}"
    );

    // A skill the saved team already wires is kept, as a proposal must keep it, even once it is
    // no longer installed: the person removed it, not Ask.
    std::fs::write(fixture.root.0.join("tutor.yaml"), team(&["old-skill"])).expect("team");
    let (answer, failed) = tools
        .call(
            "propose_team",
            propose(team(&["old-skill", "explain-like-im-5"])),
        )
        .await;
    assert!(!failed, "{answer}");
}

/// Ask is told how a skill is given to an agent, and not to copy one into its instructions.
#[test]
fn ask_is_told_to_give_a_skill_as_a_skill() {
    let instructions = super::mcp::INSTRUCTIONS;
    assert!(instructions.contains("`capabilities: [{kind: skill, name: "));
    assert!(instructions.contains("by name from `list_skills`"));
    assert!(instructions.contains("don't copy what the skill says into the `role`"));
}

/// One of My agents, written as the app saves it.
fn save_agent(root: &std::path::Path, id: &str, yaml: &str) {
    std::fs::create_dir_all(root.join(".jobs")).expect("My agents");
    std::fs::write(root.join(format!(".jobs/{id}.yaml")), yaml).expect("an agent");
}

/// ADR 0096: Ask builds from what the person has. Told to use their own agent and a folder they
/// name, it looks at My agents, `LoomWatch`'s Writer and the folder first, then proposes a team that
/// points at their agent as it is saved, starts the Writer from the job, and gives the folder to
/// the Writer alone; and it is told what the person has before its first answer.
#[tokio::test]
async fn ask_builds_a_team_from_the_persons_own_agent_a_job_and_a_folder() {
    let pool = crate::db::Db::temp().await;
    let demo = assistant();
    let fixture = Fixture::start(
        Some(EventArchive::new(pool)),
        Some(crate::engine::demo_model(demo.clone())),
    )
    .await;
    save_agent(
        &fixture.root.0,
        "researcher",
        "name: Researcher\ndoes: Finds and checks sources\ninstructions: Find the facts, with a source for each.\nmodel: fake/offline\n",
    );
    let notes = fixture.home.0.join("Documents").join("Client notes");
    std::fs::create_dir_all(&notes).expect("the folder");
    std::fs::write(notes.join("acme.md"), "Acme renewed.").expect("a note");

    let (status, started) = fixture.post("/api/ask/conversations", &json!({})).await;
    assert_eq!(status, 201, "{started}");
    let id = started["id"].as_str().expect("id").to_owned();
    fixture
        .say(
            &id,
            "Build a team that writes a client review from my Client notes folder, with my researcher.",
        )
        .await;
    let events = fixture.events(&id).await;

    let first = demo
        .requests()
        .first()
        .map(|request| request.prompt().to_owned())
        .expect("the assistant was asked");
    assert!(
        first.contains("## What the person has\n")
            && first.contains("- My agents: Researcher (`researcher`).\n")
            && first.contains("- Connected tools: none yet.")
            && first.contains("- This computer: "),
        "{first}"
    );
    let proposals = phases(&events, "ask_proposal");
    assert_eq!(proposals.len(), 1, "{}", dump(&events));
    let yaml = proposals[0]["yaml"].as_str().expect("the proposed file");
    let team =
        crate::config::TeamConfig::parse_in(yaml, &fixture.root.0).expect("a team a run reads");
    let researcher = &team.agents[0];
    assert_eq!(
        researcher.role, "Find the facts, with a source for each.",
        "as it is saved"
    );
    assert!(researcher.capabilities.is_empty());
    let writer = &team.agents[1];
    let job = super::jobs::named("writer").expect("the writer job");
    assert!(writer.role.starts_with(&job.role[0]), "{}", writer.role);
    assert!(
        writer
            .role
            .contains(job.role.last().expect("its reply line")),
        "{}",
        writer.role
    );
    assert_eq!(writer.done_when, job.done_when);
    assert_eq!(writer.capabilities.len(), 1);
    assert_eq!(
        writer.capabilities[0].path.as_deref(),
        Some(notes.as_path())
    );
    assert_eq!(team.spend.per_run, Some(crate::spend::DEFAULT_PER_RUN_USD));
    assert_eq!(
        proposals[0]["agentNames"],
        json!({"researcher": "Researcher", "writer": "Writer"}),
        "the card names the agent from My agents, which has no name in the file"
    );
    assert!(
        said(&events).contains("Researcher as it is"),
        "{}",
        dump(&events)
    );
}

/// What Ask sees of `LoomWatch`'s jobs, My agents and the person's files (ADR 0096): the jobs with
/// the models the app places them on, each agent with what it brings and the teams it is in, and
/// a folder by its name with what is inside, one a team already reads first.
#[tokio::test]
async fn ask_sees_the_jobs_the_persons_agents_and_their_folders() {
    let fixture = Fixture::start(None, None).await;
    let tools = ControlTools::new(
        fixture.control.clone(),
        Caller::Conversation("ask-test".to_owned()),
    );
    let call = |name: &'static str, arguments: Value| {
        let tools = &tools;
        async move {
            let (answer, failed) = tools.call(name, arguments).await;
            (
                serde_json::from_str::<Value>(&answer).unwrap_or(Value::String(answer)),
                failed,
            )
        }
    };

    let (jobs, failed) = call("list_jobs", json!({})).await;
    assert!(!failed, "{jobs}");
    let listed = jobs["jobs"].as_array().expect("jobs");
    assert_eq!(listed.len(), super::jobs::BUILT_IN_JOBS.len());
    let deck = listed
        .iter()
        .find(|job| job["job"] == "deck")
        .expect("the deck maker");
    assert_eq!(deck["name"], "Presentation maker");
    assert!(deck.get("role").is_none(), "listed short");
    let (job, failed) = call("read_job", json!({"job": "Checker"})).await;
    assert!(!failed, "{job}");
    assert!(
        job["role"]
            .as_str()
            .is_some_and(|role| role.contains("## Check")),
        "{job}"
    );
    assert_eq!(job["model"], super::tier_model("check"));
    let (missing, failed) = call("read_job", json!({"job": "astronaut"})).await;
    assert!(
        failed && missing == json!("LoomWatch has no job called astronaut."),
        "{missing}"
    );

    save_agent(
        &fixture.root.0,
        "researcher",
        "name: Researcher\ndoes: Finds and checks sources\ninstructions: Find the facts.\nskills: [cite]\nreads:\n  - {name: Notes, path: ~/notes}\n",
    );
    std::fs::write(
        fixture.root.0.join("brief.yaml"),
        "schemaVersion: 1\nid: brief\nname: Market brief\nentrypoint: researcher\nagents:\n  - id: researcher\n    from: {agent: researcher}\nedges: []\n",
    )
    .expect("a team");
    let (agents, failed) = call("list_my_agents", json!({})).await;
    assert!(!failed, "{agents}");
    assert_eq!(
        agents["agents"],
        json!([{
            "id": "researcher", "name": "Researcher", "does": "Finds and checks sources",
            "instructions": "Find the facts.", "model": null, "thinkingEffort": null,
            "skills": ["cite"], "tools": [], "reads": [{"name": "Notes", "path": "~/notes"}],
            "doneWhen": [], "allow": {}, "inTeams": ["Market brief"],
        }])
    );

    let mine = fixture.home.0.join("Documents").join("Market research");
    std::fs::create_dir_all(&mine).expect("a folder");
    std::fs::write(mine.join("prices.csv"), "a,b").expect("a file");
    let shared = fixture.root.0.join("shared").join("market research");
    std::fs::create_dir_all(&shared).expect("a folder a team reads");
    std::fs::write(
        fixture.root.0.join("scan.yaml"),
        "schemaVersion: 1\nid: scan\nname: Scan\nentrypoint: a\nagents:\n  - id: a\n    name: Scout\n    role: Scan.\n    model: fake/offline\n    capabilities:\n      - {kind: knowledge, name: Research, path: shared/market research}\nedges: []\n",
    )
    .expect("a team");
    let (found, failed) = call("find_files", json!({"name": "market research"})).await;
    assert!(!failed, "{found}");
    let found = found["found"].as_array().expect("found");
    assert_eq!(found.len(), 2, "{found:?}");
    assert_eq!(found[0]["path"], shared.to_string_lossy().as_ref());
    assert_eq!(found[0]["usedBy"], json!(["Scan · Scout"]));
    assert_eq!(found[1]["path"], mine.to_string_lossy().as_ref());
    assert_eq!(found[1]["holds"], json!(["prices.csv"]));
    let (none, failed) = call("find_files", json!({"name": "tax returns"})).await;
    assert!(!failed);
    assert!(
        none["message"].as_str().is_some_and(
            |m| m.contains("ask which folder it is in") && m.contains("never ask for a path")
        ),
        "a newcomer is never asked for a path: {none}"
    );

    let (tools_listed, failed) = call("list_tools", json!({})).await;
    assert!(!failed);
    assert_eq!(
        tools_listed,
        json!({"tools": []}),
        "none connected in a test"
    );
}

/// A proposal names only what is there (ADR 0096): one of My agents by an id it has, a folder or
/// file on this computer, a folder to work in, and a connected tool; what the saved team already
/// names is kept. A new team starts with the new-team spending limit; a change to a team doesn't
/// add one.
#[tokio::test]
async fn a_proposal_names_only_agents_places_and_tools_that_are_there() {
    let fixture = Fixture::start(None, None).await;
    let tools = ControlTools::new(
        fixture.control.clone(),
        Caller::Conversation("ask-test".to_owned()),
    );
    save_agent(
        &fixture.root.0,
        "researcher",
        "name: Researcher\ninstructions: Find the facts.\nmodel: anthropic/claude-sonnet-5.5\n",
    );
    // One that names no model runs on the one the team gives it, and can't run without.
    save_agent(
        &fixture.root.0,
        "editor",
        "name: Editor\ninstructions: Tidy it.\n",
    );
    let pointer = |model: &str| {
        format!(
            "schemaVersion: 1\nid: tidy\nname: Tidy\nentrypoint: e\nagents:\n  - id: e\n    \
             from: {{agent: editor}}\n{model}edges: []\n"
        )
    };
    let tidy = |yaml: String| json!({"file": "tidy.yaml", "yaml": yaml, "summary": "Tidy."});
    let (message, failed) = tools.call("propose_team", tidy(pointer(""))).await;
    assert!(failed && message.contains("missing `model`"), "{message}");
    let (answer, failed) = tools
        .call(
            "propose_team",
            tidy(pointer("    model: anthropic/claude-sonnet-5.5\n")),
        )
        .await;
    assert!(!failed, "{answer}");
    let notes = fixture.home.0.join("notes");
    std::fs::create_dir_all(&notes).expect("a folder");
    let team = |extra: &str| {
        format!(
            "schemaVersion: 1\nid: brief\nname: Brief\nentrypoint: a\nagents:\n  - id: a\n    \
             name: Collector\n    role: Collect\n    model: anthropic/claude-sonnet-5.5\n{extra}  \
             - id: r\n    from: {{agent: researcher}}\nedges: []\n"
        )
    };
    let propose = |yaml: String| json!({"file": "brief.yaml", "yaml": yaml, "summary": "A brief."});
    let refused = |extra: &'static str, says: &'static str| {
        let tools = &tools;
        let yaml = team(extra);
        async move {
            let (message, failed) = tools.call("propose_team", propose(yaml)).await;
            assert!(failed && message.contains(says), "{extra}: {message}");
        }
    };
    let (message, failed) = tools
        .call(
            "propose_team",
            propose(team("").replace("agent: researcher", "agent: nobody")),
        )
        .await;
    assert!(failed && message.contains("`list_my_agents`"), "{message}");
    refused(
        "    capabilities:\n      - {kind: knowledge, name: Gone, path: /no/such/folder}\n",
        "There is no folder or file at /no/such/folder on this computer.",
    )
    .await;
    refused(
        "    spawn: {cwd: no-such-folder}\n",
        "There is no folder or file at no-such-folder",
    )
    .await;
    refused(
        "    capabilities:\n      - {kind: tool, name: Linear}\n",
        "Linear isn't connected yet. Connect it in Connections, under Tools.",
    )
    .await;

    let found = format!(
        "    capabilities:\n      - {{kind: knowledge, name: Notes, path: '{}'}}\n",
        notes.display()
    );
    let (answer, failed) = tools.call("propose_team", propose(team(&found))).await;
    assert!(!failed, "{answer}");
    let answer: Value = serde_json::from_str(&answer).expect("json");
    let proposals = fixture.control.inner.proposals.read().await;
    let proposed = &proposals[answer["proposalId"].as_str().expect("an id")].yaml;
    assert!(
        proposed.contains("name: Brief\nspend:\n  perRun: 1.00\n"),
        "{proposed}"
    );
    drop(proposals);

    // Once the team is saved with Linear and a folder since moved, a change keeps both, and adds
    // no limit the person didn't set.
    let saved = team(
        "    capabilities:\n      - {kind: tool, name: Linear}\n      - {kind: knowledge, name: Old, path: /moved/away}\n",
    );
    std::fs::write(fixture.root.0.join("brief.yaml"), &saved).expect("the saved team");
    let changed = saved.replace("role: Collect", "role: Collect more");
    let (answer, failed) = tools.call("propose_team", propose(changed)).await;
    assert!(!failed, "{answer}");
    let answer: Value = serde_json::from_str(&answer).expect("json");
    let proposals = fixture.control.inner.proposals.read().await;
    let proposed = &proposals[answer["proposalId"].as_str().expect("an id")].yaml;
    assert!(!proposed.contains("spend:"), "{proposed}");
}

/// Ask is told whether this computer sandboxes an agent's commands, which decides whether a maker
/// may run its programs without asking (the owner's ruling, ADR 0096).
#[test]
fn ask_is_told_whether_commands_here_are_sandboxed() {
    let mac = super::this_computer(true);
    assert!(mac.contains("a Mac") && mac.contains("sandbox"), "{mac}");
    let other = super::this_computer(false);
    assert!(
        other.contains("not a Mac") && !other.contains("sandbox"),
        "{other}"
    );
}

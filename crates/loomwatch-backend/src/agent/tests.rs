//! Whole turns, on the scripted demo and on a stand-in for `OpenRouter`.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use serde_json::{Value, json};

use super::*;
use crate::ai::Source;

/// Keeps every update, for a test to read.
#[derive(Default)]
struct Recorded(Mutex<Vec<Value>>);

impl Recorded {
    fn kinds(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|update| {
                update["sessionUpdate"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    }

    fn all(&self) -> Vec<Value> {
        self.0.lock().unwrap().clone()
    }
}

impl EventSink for Recorded {
    fn update(&self, update: Value) -> BoxFuture<'_, anyhow::Result<()>> {
        self.0.lock().unwrap().push(update);
        Box::pin(async { Ok(()) })
    }
}

/// Answers each permission request with the next scripted decision, and keeps the requests.
struct Answers {
    decisions: Mutex<VecDeque<Decision>>,
    asked: Mutex<Vec<PermissionRequest>>,
}

impl Answers {
    fn new(decisions: Vec<Decision>) -> Arc<Self> {
        Arc::new(Self {
            decisions: Mutex::new(decisions.into()),
            asked: Mutex::default(),
        })
    }
}

impl Permissions for Answers {
    fn request<'a>(&'a self, request: &'a PermissionRequest) -> BoxFuture<'a, Decision> {
        self.asked.lock().unwrap().push(request.clone());
        let decision = self
            .decisions
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Decision::Allow);
        Box::pin(async move { decision })
    }
}

struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("loomwatch-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(crate::platform::canonicalize(&path).unwrap())
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn call(id: &str, name: &str, arguments: &Value) -> ToolCall {
    ToolCall {
        id: id.to_owned(),
        name: name.to_owned(),
        arguments: arguments.to_string(),
    }
}

fn session(
    folder: &Folder,
    provider: Provider,
    sink: Arc<Recorded>,
    permissions: Arc<dyn Permissions>,
) -> Session {
    session_on(
        folder,
        provider,
        sink,
        permissions,
        "anthropic/claude-haiku-5.5",
    )
}

fn session_on(
    folder: &Folder,
    provider: Provider,
    sink: Arc<Recorded>,
    permissions: Arc<dyn Permissions>,
    model: &str,
) -> Session {
    let config = SessionConfig::new("session-1", "writer", folder.0.clone(), model);
    Session::open(config, provider, sink, permissions, Arc::new(NoHostTools))
}

#[tokio::test]
async fn a_turn_writes_a_file_and_replies() {
    let folder = Folder::new();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "I'll write it.",
            vec![call(
                "c1",
                "write_file",
                &json!({"path": "out/report.md", "content": "# Report\n"}),
            )],
        ),
        Completion::text("Done: out/report.md is written."),
    ]);
    let sink = Arc::new(Recorded::default());
    let answers = Answers::new(vec![]);
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        sink.clone(),
        answers.clone(),
    );
    let end = session.prompt("Write the report.").await.unwrap();

    assert_eq!(end.stop_reason, StopReason::EndTurn);
    assert_eq!(end.reply, "Done: out/report.md is written.");
    assert_eq!(
        std::fs::read_to_string(folder.0.join("out/report.md")).unwrap(),
        "# Report\n"
    );
    assert_eq!(
        sink.kinds(),
        [
            "agent_message_chunk",
            "agent_message_phase",
            "tool_call",
            "tool_call_update",
            "agent_message_chunk"
        ]
    );
    let started = &sink.all()[2];
    assert_eq!(started["kind"], "edit");
    assert_eq!(started["title"], "Write out/report.md");
    assert_eq!(
        started["locations"][0]["path"],
        folder
            .0
            .join("out")
            .join("report.md")
            .to_string_lossy()
            .as_ref()
    );

    // The policy was asked with the exact file, in the shape the daemon's policy reads.
    let asked = answers.asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    let message = asked[0].as_message();
    assert_eq!(message["params"]["toolCall"]["kind"], "edit");
    assert_eq!(message["params"]["options"][0]["kind"], "allow_once");

    // The second request carried the tool's result back to the model.
    let requests = demo.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].tools.contains(&"write_file".to_owned()));
    assert!(matches!(
        requests[1].messages.last(),
        Some(Message::Tool { tool_call_id, content, .. }) if tool_call_id == "c1" && content.starts_with("Created")
    ));
}

/// What the agent writes alongside tool calls is said on the way: the record marks its message
/// once the message is whole, before its calls run, and the reply is what it wrote after. When it
/// wrote nothing after, the reply is what it said on the way rather than nothing.
#[tokio::test]
async fn words_said_on_the_way_to_a_tool_are_not_the_reply() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("prices.md"), "Basic: 139,000 VND").unwrap();
    let read = || call("r", "read_file", &json!({"path": "prices.md"}));
    for (said, last, reply) in [
        (
            "Paths are probably absolute.",
            "The Basic plan costs 139,000 VND.",
            "The Basic plan costs 139,000 VND.",
        ),
        (
            "Paths are probably absolute.",
            "",
            "Paths are probably absolute.",
        ),
        ("", "139,000 VND.", "139,000 VND."),
    ] {
        let demo = Demo::scripted(vec![
            Completion::calls(said, vec![read()]),
            Completion::text(last),
        ]);
        let sink = Arc::new(Recorded::default());
        let mut session = session(
            &folder,
            Provider::Demo(demo),
            sink.clone(),
            Arc::new(AllowAll),
        );
        let end = session.prompt("What does Basic cost?").await.unwrap();
        assert_eq!(end.reply, reply);

        let updates = sink.all();
        let marks: Vec<usize> = (0..updates.len())
            .filter(|at| updates[*at]["sessionUpdate"] == "agent_message_phase")
            .collect();
        if said.is_empty() {
            assert!(
                marks.is_empty(),
                "a call with no words says nothing on the way"
            );
            continue;
        }
        let [mark] = marks[..] else {
            panic!("one message asked for a tool: {updates:#?}");
        };
        assert_eq!(updates[mark]["phase"], "commentary");
        assert_eq!(updates[0]["sessionUpdate"], "agent_message_chunk");
        assert_eq!(updates[mark]["messageId"], updates[0]["messageId"]);
        assert_eq!(updates[mark + 1]["sessionUpdate"], "tool_call");
    }
}

/// A folder the operator connected is read by the names its listing shows inside it, though the
/// agent works in a folder of its own, and the operator's policy is asked about that file.
#[tokio::test]
async fn a_connected_folder_is_read_by_the_names_it_shows() {
    let folder = Folder::new();
    let (work, notes) = (folder.0.join("work"), folder.0.join("notes"));
    std::fs::create_dir_all(&work).unwrap();
    std::fs::create_dir_all(notes.join("drafts")).unwrap();
    std::fs::write(notes.join("drafts/prices.md"), "Basic: 139,000 VND").unwrap();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![call("r", "read_file", &json!({"path": "drafts/prices.md"}))],
        ),
        Completion::text("139,000 VND."),
    ]);
    let mut config = SessionConfig::new("s", "writer", work, "m");
    config.knowledge = vec![notes.clone()];
    let answers = Answers::new(vec![]);
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        answers.clone(),
        Arc::new(NoHostTools),
    );
    session.prompt("What does Basic cost?").await.unwrap();

    assert_eq!(
        answers.asked.lock().unwrap()[0].locations,
        [notes.join("drafts/prices.md")]
    );
    let answered = demo.requests()[1].messages.last().cloned();
    assert!(
        matches!(&answered, Some(Message::Tool { content, .. }) if content.contains("139,000")),
        "{answered:?}"
    );
}

#[tokio::test]
async fn declined_answered_and_edited_requests_each_reach_the_model() {
    let folder = Folder::new();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![
                call("a", "write_file", &json!({"path": "a.md", "content": "x"})),
                call("b", "run_command", &json!({"command": "rm -rf /"})),
                call("c", "run_command", &json!({"command": "echo wrong"})),
            ],
        ),
        Completion::text("OK."),
    ]);
    let answers = Answers::new(vec![
        Decision::Deny,
        Decision::Answer("Don't delete anything; summarise instead.".to_owned()),
        Decision::AllowEdited(json!({"command": "echo right"})),
    ]);
    let sink = Arc::new(Recorded::default());
    let mut session = session(&folder, Provider::Demo(demo.clone()), sink, answers);
    session.prompt("Go.").await.unwrap();

    let results: Vec<String> = demo.requests()[1]
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::Tool { content, .. } => Some(content.clone()),
            _ => None,
        })
        .collect();
    assert!(results[0].starts_with("The person declined this."));
    assert!(!folder.0.join("a.md").exists());
    assert_eq!(
        results[1],
        "The person answered instead of letting this run: Don't delete anything; summarise instead."
    );
    if cfg!(unix) {
        assert_eq!(results[2].trim(), "right");
    }
}

#[tokio::test]
async fn a_long_output_is_set_aside_and_read_back_in_parts() {
    let folder = Folder::new();
    let long = (0..2_000).fold(String::new(), |mut text, line| {
        let _ = writeln!(text, "line {line} of the long file");
        text
    });
    std::fs::write(folder.0.join("big.txt"), &long).unwrap();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![call("big", "read_file", &json!({"path": "big.txt"}))],
        ),
        Completion::calls(
            "",
            vec![call(
                "more",
                "read_tool_output",
                &json!({"id": "big", "offset": 6000, "limit": 10}),
            )],
        ),
        Completion::text("Read it."),
    ]);
    let sink = Arc::new(Recorded::default());
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        sink,
        Arc::new(AllowAll),
    );
    session.prompt("Read big.txt").await.unwrap();

    let requests = demo.requests();
    let Some(Message::Tool { content, .. }) = requests[1].messages.last() else {
        panic!("the read's result should be last");
    };
    assert!(content.contains("the rest was set aside") && content.contains("id big"));
    assert!(content.chars().count() < 7_000);
    let Some(Message::Tool { content, .. }) = requests[2].messages.last() else {
        panic!("the second read's result should be last");
    };
    assert_eq!(content.chars().take(10).count(), 10);
    assert!(content.contains("… characters 6000–6010 of "), "{content}");
}

#[tokio::test]
async fn the_plan_tool_records_the_whole_list() {
    let folder = Folder::new();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![call(
                "p",
                "update_plan",
                &json!({"steps": [{"step": "Find sources", "status": "completed"}, {"step": "Write", "status": "in_progress"}]}),
            )],
        ),
        Completion::text("Writing now."),
    ]);
    let sink = Arc::new(Recorded::default());
    let answers = Answers::new(vec![]);
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        sink.clone(),
        answers.clone(),
    );
    session.prompt("Plan it.").await.unwrap();
    let plan = sink
        .all()
        .into_iter()
        .find(|update| update["sessionUpdate"] == "plan")
        .unwrap();
    assert_eq!(
        plan["entries"][1],
        json!({"content": "Write", "status": "in_progress", "priority": "medium"})
    );
    // Keeping a plan needs nobody's permission.
    assert!(answers.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_parked_session_resumes_with_its_whole_history() {
    let folder = Folder::new();
    let demo = Demo::scripted(vec![
        Completion::text("First answer."),
        Completion::text("Second answer."),
    ]);
    let sink = Arc::new(Recorded::default());
    let mut first = session(
        &folder,
        Provider::Demo(demo.clone()),
        sink.clone(),
        Arc::new(AllowAll),
    );
    first.prompt("One").await.unwrap();
    let parked: Snapshot =
        serde_json::from_str(&serde_json::to_string(&first.snapshot()).unwrap()).unwrap();
    drop(first);

    let config = SessionConfig::new("session-1", "writer", folder.0.clone(), "some/other-model");
    let mut resumed = Session::resume(
        parked,
        config,
        Provider::Demo(demo.clone()),
        sink,
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    let end = resumed.prompt("Two").await.unwrap();
    assert_eq!(end.reply, "Second answer.");
    let second = &demo.requests()[1];
    // The model it was opened with is kept.
    assert_eq!(second.model, "anthropic/claude-haiku-5.5");
    let said: Vec<&str> = second
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::User { content, .. } | Message::Assistant { content, .. } => {
                Some(session::without_date(content))
            }
            _ => None,
        })
        .collect();
    assert_eq!(said, ["One", "First answer.", "Two"]);
    // Each turn was dated when it started, the resumed one too.
    let dated = second
        .messages
        .iter()
        .filter(|message| matches!(message, Message::User { content, .. } if content.contains("\n\nToday is ")))
        .count();
    assert_eq!(dated, 2);
}

#[tokio::test]
async fn a_full_context_is_summarised_and_the_task_kept() {
    let folder = Folder::new();
    let mut busy = Completion::calls("", vec![call("l", "list_files", &json!({}))]);
    busy.usage = Usage {
        input_tokens: 900,
        ..Usage::default()
    };
    let demo = Demo::scripted(vec![
        busy,
        Completion::text("Summary: listed the folder."),
        Completion::text("Finished."),
    ]);
    let sink = Arc::new(Recorded::default());
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.context_window = Some(1000);
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        sink,
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    let end = session.prompt("The task.").await.unwrap();
    assert_eq!(end.reply, "Finished.");
    let requests = demo.requests();
    // The summary was asked for with the work's own tools, so the provider read the conversation
    // from its cache, then the work carried on from it.
    assert!(!requests[1].tools.is_empty());
    assert_eq!(requests[1].tools, requests[0].tools);
    assert_eq!(requests[1].messages.len(), requests[0].messages.len() + 3);
    let after = &requests[2].messages;
    assert_eq!(after.len(), 2);
    let Message::User { content, .. } = &after[1] else {
        panic!("the summary should stand in for the conversation");
    };
    assert!(content.contains("Summary: listed the folder.") && content.contains("The task."));
}

/// A model that calls a tool instead of writing its summary is asked once more with no tools, and
/// the conversation is replaced only by a summary that says something.
#[tokio::test]
async fn a_summary_written_as_a_tool_call_is_asked_for_again_without_tools() {
    let folder = Folder::new();
    let mut busy = Completion::calls("", vec![call("l", "list_files", &json!({}))]);
    busy.usage = Usage {
        input_tokens: 900,
        ..Usage::default()
    };
    let demo = Demo::scripted(vec![
        busy,
        Completion::calls("", vec![call("again", "list_files", &json!({}))]),
        Completion::text("Summary: listed the folder."),
        Completion::text("Finished."),
    ]);
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.context_window = Some(1000);
    config.tools = ToolSet::all(true);
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    assert_eq!(
        session.prompt("The task.").await.unwrap().reply,
        "Finished."
    );
    let requests = demo.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[1].tools, requests[0].tools);
    assert_eq!(requests[1].server_tools, requests[0].server_tools);
    assert!(requests[0].server_tools.web_search);
    assert!(requests[2].tools.is_empty() && !requests[2].server_tools.web_search);
    let Message::User { content, .. } = &requests[3].messages[1] else {
        panic!("the summary should stand in for the conversation");
    };
    assert!(content.contains("Summary: listed the folder."));
}

/// A model with a million-token context is summarised at the same size as a 200k one, not left
/// to fill its whole context with every call reading all of it again.
#[tokio::test]
async fn a_huge_context_is_summarised_at_the_cap_not_at_its_end() {
    let folder = Folder::new();
    let mut busy = Completion::calls("", vec![call("l", "list_files", &json!({}))]);
    busy.usage = Usage {
        cached_read_tokens: 165_000,
        ..Usage::default()
    };
    let demo = Demo::scripted(vec![
        busy,
        Completion::text("Summary: listed the folder."),
        Completion::text("Finished."),
    ]);
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.context_window = Some(1_000_000);
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    assert_eq!(
        session.prompt("The task.").await.unwrap().reply,
        "Finished."
    );
    let requests = demo.requests();
    assert!(
        requests[1].prompt().contains("Write a summary"),
        "{}",
        requests[1].prompt()
    );
    assert_eq!(requests[2].messages.len(), 2);
}

/// The tool list leads the prompt the provider caches, so it is the same on every call, even once
/// a long output was set aside and `read_tool_output` has something to read.
#[tokio::test]
async fn the_tools_offered_never_change_within_a_session() {
    let folder = Folder::new();
    let long = "a line of the long file\n".repeat(2_000);
    std::fs::write(folder.0.join("big.txt"), &long).unwrap();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![call("big", "read_file", &json!({"path": "big.txt"}))],
        ),
        Completion::calls(
            "",
            vec![call("more", "read_tool_output", &json!({"id": "big"}))],
        ),
        Completion::text("Read it."),
    ]);
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    session.prompt("Read big.txt").await.unwrap();
    let requests = demo.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].tools.contains(&"read_tool_output".to_owned()));
    assert!(
        requests
            .iter()
            .all(|request| request.tools == requests[0].tools)
    );
    let Some(Message::Tool { content, .. }) = requests[2].messages.last() else {
        panic!("the second read's result should be last");
    };
    assert!(!content.contains("No set-aside output"), "{content}");
}

fn cut_off(content: &str) -> Completion {
    Completion {
        finish: Finish::Length,
        ..Completion::text(content)
    }
}

/// A reply the length limit cut off is carried on, and the parts join as the model wrote them,
/// rather than the next stage being handed half a sentence.
#[tokio::test]
async fn a_reply_cut_off_at_the_length_limit_is_carried_on() {
    let folder = Folder::new();
    let demo = Demo::scripted(vec![
        cut_off("The quick bro"),
        Completion::text("wn fox jumps."),
    ]);
    let mut writer = session(
        &folder,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    let end = writer.prompt("Write a sentence.").await.unwrap();
    assert_eq!(end.stop_reason, StopReason::EndTurn);
    assert_eq!(end.reply, "The quick brown fox jumps.");
    assert!(
        demo.requests()[1]
            .prompt()
            .contains("Carry on from exactly where it stopped")
    );

    // Cut off again and again, the turn ends there instead of paying for more.
    let demo = Demo::scripted(vec![
        cut_off("One. "),
        cut_off("Two. "),
        cut_off("Three. "),
        Completion::text("Never asked for."),
    ]);
    let mut counter = session(
        &folder,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    let end = counter.prompt("Count.").await.unwrap();
    assert_eq!(end.stop_reason, StopReason::MaxTokens);
    assert_eq!(end.reply, "One. Two. Three.");
    assert_eq!(demo.requests().len(), 3);
}

/// A tool call the length limit cut off doesn't run, and the model is told why, so it makes the
/// call smaller instead of the same call again.
#[tokio::test]
async fn a_tool_call_cut_off_at_the_length_limit_is_sent_back_with_the_reason() {
    let folder = Folder::new();
    let mut cut = Completion::calls(
        "",
        vec![
            call("list", "list_files", &json!({})),
            ToolCall {
                id: "write".into(),
                name: "write_file".into(),
                arguments: "{\"path\":\"a.md\",\"content\":\"a very long docu".into(),
            },
        ],
    );
    cut.finish = Finish::Length;
    let demo = Demo::scripted(vec![cut, Completion::text("Done.")]);
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    assert_eq!(session.prompt("Write a.md").await.unwrap().reply, "Done.");
    let results: Vec<String> = demo.requests()[1]
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::Tool { content, .. } => Some(content.clone()),
            _ => None,
        })
        .collect();
    // The finished call ran; the cut one says why it didn't.
    assert!(!results[0].contains("Not run"), "{}", results[0]);
    assert!(results[1].contains("length limit"), "{}", results[1]);
    assert!(!folder.0.join("a.md").exists());
}

#[tokio::test]
async fn the_offline_demo_answers_the_demo_team_without_a_model() {
    let folder = Folder::new();
    let sink = Arc::new(Recorded::default());
    let mut config = SessionConfig::new("s", "researcher", folder.0.clone(), OFFLINE_MODEL);
    config.tools = ToolSet::NONE;
    let mut session = Session::open(
        config,
        Provider::Demo(Demo::offline()),
        sink.clone(),
        Arc::new(DenyAll),
        Arc::new(NoHostTools),
    );
    let end = session
        .prompt("## Task\nCompare the guides.")
        .await
        .unwrap();
    assert!(end.reply.starts_with("Offline demo findings"));
    assert_eq!(end.usage, Usage::default());
    // No usage events for a demo that cost nothing.
    assert_eq!(sink.kinds(), ["agent_message_chunk"]);
}

// ---------------------------------------------------------------------------------------------
// A stand-in for OpenRouter
// ---------------------------------------------------------------------------------------------

struct Reply {
    status: StatusCode,
    body: String,
    delay: Duration,
}

#[derive(Clone, Default)]
struct Stand {
    replies: Arc<Mutex<VecDeque<Reply>>>,
    bodies: Arc<Mutex<Vec<Value>>>,
    auth: Arc<Mutex<Vec<String>>>,
    /// Where each request was posted.
    paths: Arc<Mutex<Vec<String>>>,
}

async fn chat(State(stand): State<Stand>, uri: Uri, headers: HeaderMap, body: String) -> Response {
    stand.paths.lock().unwrap().push(uri.path().to_owned());
    stand
        .bodies
        .lock()
        .unwrap()
        .push(serde_json::from_str(&body).unwrap_or(Value::Null));
    stand.auth.lock().unwrap().push(
        headers
            .get(header::AUTHORIZATION)
            .or_else(|| headers.get("x-api-key"))
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned(),
    );
    let reply = stand.replies.lock().unwrap().pop_front().unwrap_or(Reply {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        body: "{\"error\":{\"message\":\"no reply scripted\"}}".to_owned(),
        delay: Duration::ZERO,
    });
    tokio::time::sleep(reply.delay).await;
    let content_type = if reply.status.is_success() {
        "text/event-stream"
    } else {
        "application/json"
    };
    (
        reply.status,
        [(header::CONTENT_TYPE, content_type)],
        reply.body,
    )
        .into_response()
}

async fn stand(replies: Vec<Reply>) -> (Stand, String) {
    let stand = Stand {
        replies: Arc::new(Mutex::new(replies.into())),
        ..Stand::default()
    };
    let app = Router::new()
        .route("/api/v1/chat/completions", post(chat))
        .route("/api/v1/messages", post(chat))
        .route("/v1/messages", post(chat))
        .route("/v1/responses", post(chat))
        .with_state(stand.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (stand, format!("http://{address}/api/v1"))
}

fn sse(chunks: &[Value]) -> String {
    let mut body = String::from(": OPENROUTER PROCESSING\n\n");
    for chunk in chunks {
        let _ = write!(body, "data: {chunk}\n\n");
    }
    body.push_str("data: [DONE]\n\n");
    body
}

fn ok(chunks: &[Value]) -> Reply {
    Reply {
        status: StatusCode::OK,
        body: sse(chunks),
        delay: Duration::ZERO,
    }
}

const KEY: &str = "sk-or-v1-test-0123456789abcdef";

fn openrouter(base: &str) -> Provider {
    Provider::OpenRouter(Arc::new(
        OpenRouter::with_base(ApiKey::new(KEY).unwrap(), base)
            .unwrap()
            .with_backoff(Duration::from_millis(5)),
    ))
}

/// A Claude older than 4.6, which `OpenRouter` still serves through chat completions.
const CHAT_CLAUDE: &str = "anthropic/claude-sonnet-4.5";

/// A session on the stand-in for `OpenRouter`'s chat completions.
fn on_chat(
    folder: &Folder,
    base: &str,
    sink: Arc<Recorded>,
    permissions: Arc<dyn Permissions>,
) -> Session {
    session_on(folder, openrouter(base), sink, permissions, CHAT_CLAUDE)
}

#[tokio::test]
async fn openrouter_streams_tool_calls_reasoning_and_the_exact_cost() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("notes.md"), "hello").unwrap();
    let (stand, base) = stand(vec![
        ok(&[
            json!({"choices": [{"index": 0, "delta": {"role": "assistant", "reasoning": "Let me look.", "reasoning_details": [{"type": "reasoning.text", "index": 0, "text": "Let me look."}]}}]}),
            json!({"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "read_file", "arguments": "{\"pa"}}]}}]}),
            json!({"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": "th\":\"notes.md\"}"}}], "reasoning_details": [{"type": "reasoning.text", "index": 0, "signature": "sig-1"}]}}]}),
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 120, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 100}, "cost": 0.002}}),
        ]),
        ok(&[
            json!({"choices": [{"index": 0, "delta": {"content": "It says "}}]}),
            json!({"choices": [{"index": 0, "delta": {"content": "hello."}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 160, "completion_tokens": 5, "cost": 0.001}}),
        ]),
    ])
    .await;
    let sink = Arc::new(Recorded::default());
    let mut session = on_chat(&folder, &base, sink.clone(), Arc::new(AllowAll));
    let end = session.prompt("What does notes.md say?").await.unwrap();

    assert_eq!(end.reply, "It says hello.");
    assert_eq!(end.usage.cached_read_tokens, 100);
    assert_eq!(end.usage.input_tokens, 20 + 160);
    assert!((end.usage.cost_usd - 0.003).abs() < 1e-9);
    let result = end.as_result();
    assert_eq!(result["stopReason"], "end_turn");
    assert_eq!(result["usage"]["totalTokens"], 120 + 30 + 160 + 5);

    let bodies = stand.bodies.lock().unwrap().clone();
    // The reasoning came back exactly, signature and all, with the tool call it led to.
    let assistant = &bodies[1]["messages"][2];
    assert_eq!(
        assistant["reasoning_details"][0],
        json!({"type": "reasoning.text", "index": 0, "text": "Let me look.", "signature": "sig-1"})
    );
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        "{\"path\":\"notes.md\"}"
    );
    assert_eq!(bodies[1]["messages"][3]["content"], "     1\thello\n");
    assert_eq!(bodies[0]["cache_control"], json!({"type": "ephemeral"}));
    // What the provider caches is the same from call to call: the tools, the instructions, and
    // the session that keeps the calls on one route.
    assert_eq!(bodies[0]["tools"], bodies[1]["tools"]);
    assert_eq!(bodies[0]["messages"][0], bodies[1]["messages"][0]);
    assert_eq!(bodies[0]["session_id"], bodies[1]["session_id"]);
    assert_eq!(
        bodies[0]["tools"].as_array().unwrap().last().unwrap()["function"]["name"],
        "read_tool_output"
    );
    assert!(
        stand
            .auth
            .lock()
            .unwrap()
            .iter()
            .all(|auth| auth == &format!("Bearer {KEY}"))
    );

    // The key appears in no event.
    let events = serde_json::to_string(&sink.all()).unwrap();
    assert!(!events.contains("0123456789abcdef"));
    let kinds = sink.kinds();
    assert!(kinds.contains(&"agent_thought_chunk".to_owned()));
    assert_eq!(
        kinds.iter().filter(|kind| *kind == "usage_update").count(),
        2
    );
    let last_usage = sink
        .all()
        .into_iter()
        .rev()
        .find(|update| update["sessionUpdate"] == "usage_update")
        .unwrap();
    assert!((last_usage["cost"]["amount"].as_f64().unwrap() - 0.003).abs() < 1e-9);
}

#[tokio::test]
async fn openrouter_refusals_read_plainly_and_busy_answers_are_retried() {
    let folder = Folder::new();
    let error = |status: StatusCode, message: &str| Reply {
        status,
        body: json!({"error": {"code": status.as_u16(), "message": message}}).to_string(),
        delay: Duration::ZERO,
    };
    let (_, base) = stand(vec![error(
        StatusCode::UNAUTHORIZED,
        "No auth credentials found",
    )])
    .await;
    let mut refused = on_chat(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    let said = refused.prompt("Hi").await.unwrap_err();
    assert!(matches!(said, AgentError::KeyRefused(Source::OpenRouter)));
    assert_eq!(
        said.problem().map(|problem| problem.kind),
        Some(super::error::ProblemKind::KeyRefused)
    );
    assert!(said.to_string().contains("Connections page"));

    let (_, base) = stand(vec![error(
        StatusCode::PAYMENT_REQUIRED,
        "Insufficient credits",
    )])
    .await;
    let mut broke = on_chat(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    assert!(matches!(
        broke.prompt("Hi").await.unwrap_err(),
        AgentError::OutOfCredits(Source::OpenRouter)
    ));

    let (stand, base) = stand(vec![
        error(StatusCode::TOO_MANY_REQUESTS, "slow down"),
        error(StatusCode::BAD_GATEWAY, "upstream"),
        ok(&[json!({"choices": [{"index": 0, "delta": {"content": "Hello."}, "finish_reason": "stop"}]})]),
    ])
    .await;
    let mut busy = on_chat(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    assert_eq!(busy.prompt("Hi").await.unwrap().reply, "Hello.");
    assert_eq!(stand.bodies.lock().unwrap().len(), 3);
}

/// `OpenRouter` reports a busy model inside a stream it already answered `200` for. Before the
/// model's first word that is tried again like any busy answer; after it, a retry would write the
/// words twice, so it is not.
#[tokio::test]
async fn openrouter_retries_a_busy_model_reported_before_its_first_word() {
    let folder = Folder::new();
    let overloaded = || {
        ok(&[
            json!({"error": {"code": 503, "message": "Upstream error from Nvidia: Service temporarily overloaded"}}),
        ])
    };
    let (first, base) = stand(vec![
        overloaded(),
        ok(&[json!({"choices": [{"index": 0, "delta": {"content": "Hello."}, "finish_reason": "stop"}]})]),
    ])
    .await;
    let mut busy = on_chat(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    assert_eq!(busy.prompt("Hi").await.unwrap().reply, "Hello.");
    assert_eq!(first.bodies.lock().unwrap().len(), 2);

    // Busy on every try: it gives up after the same four tries as any busy answer.
    let (always, base) = stand((0..6).map(|_| overloaded()).collect()).await;
    let mut gone = on_chat(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    let said = gone.prompt("Hi").await.unwrap_err();
    assert!(said.to_string().contains("overloaded"), "{said}");
    assert_eq!(always.bodies.lock().unwrap().len(), 4);

    // Part way through the reply, the error ends the call.
    let (late, base) = stand(vec![
        ok(&[
            json!({"choices": [{"index": 0, "delta": {"content": "Hel"}}]}),
            json!({"error": {"code": 503, "message": "Service temporarily overloaded"}}),
        ]),
        ok(&[json!({"choices": [{"index": 0, "delta": {"content": "Hello."}, "finish_reason": "stop"}]})]),
    ])
    .await;
    let mut midway = on_chat(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    assert!(midway.prompt("Hi").await.is_err());
    assert_eq!(late.bodies.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_cancelled_turn_stops_waiting_and_says_so() {
    let folder = Folder::new();
    let (_, base) = stand(vec![Reply {
        status: StatusCode::OK,
        body: sse(&[json!({"choices": [{"index": 0, "delta": {"content": "late"}, "finish_reason": "stop"}]})]),
        delay: Duration::from_secs(10),
    }])
    .await;
    let mut session = on_chat(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    let cancel = session.cancel_handle();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel();
    });
    let started = std::time::Instant::now();
    let end = session.prompt("Take your time.").await.unwrap();
    assert_eq!(end.stop_reason, StopReason::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// A connected tool (ADR 0069), standing in for one: it asks before each call and keeps the calls
/// that went through.
#[derive(Default)]
struct AskingTool {
    made: Mutex<Vec<Value>>,
}

impl HostTools for AskingTool {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "linear__create_issue".to_owned(),
            description: "From Linear: Create an issue.".to_owned(),
            parameters: json!({"type": "object"}),
        }]
    }

    fn asks(&self, name: &str) -> Option<HostAsk> {
        (name == "linear__create_issue").then(|| HostAsk {
            title: "Linear: Create issue".to_owned(),
            server: "Linear".to_owned(),
            call: "create_issue".to_owned(),
        })
    }

    fn call<'a>(&'a self, _name: &'a str, input: Value) -> BoxFuture<'a, (String, bool)> {
        self.made.lock().unwrap().push(input);
        Box::pin(async { ("Created ENG-1".to_owned(), false) })
    }
}

#[tokio::test]
async fn a_connected_tools_call_asks_first_and_runs_only_when_allowed() {
    let folder = Folder::new();
    let issue = json!({"title": "Fix login"});
    let demo = Demo::scripted(vec![
        Completion::calls("", vec![call("c1", "linear__create_issue", &issue)]),
        Completion::calls("", vec![call("c2", "linear__create_issue", &issue)]),
        Completion::calls("", vec![call("c3", "linear__create_issue", &issue)]),
        Completion::text("Done."),
    ]);
    let sink = Arc::new(Recorded::default());
    let answers = Answers::new(vec![
        Decision::Deny,
        Decision::Answer("It's ENG-9 already.".to_owned()),
        Decision::Allow,
    ]);
    let tool = Arc::new(AskingTool::default());
    let config = SessionConfig::new(
        "session-1",
        "writer",
        folder.0.clone(),
        "anthropic/claude-haiku-5.5",
    );
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        sink.clone(),
        answers.clone(),
        tool.clone(),
    );
    session.prompt("File the bug.").await.unwrap();

    // Asked three times, each with the tool, the call and what it would send.
    let asked = answers.asked.lock().unwrap();
    assert_eq!(asked.len(), 3);
    let message = asked[0].as_message();
    assert_eq!(
        message["params"]["toolCall"]["title"],
        "Linear: Create issue"
    );
    assert_eq!(message["params"]["toolCall"]["kind"], "other");
    assert_eq!(
        message["params"]["toolCall"]["rawInput"],
        json!({"server": "Linear", "tool": "create_issue", "arguments": issue})
    );
    // Only the allowed call reached the tool.
    assert_eq!(*tool.made.lock().unwrap(), std::slice::from_ref(&issue));
    // The record names it in words, and each answer reached the model.
    let started: Vec<Value> = sink
        .all()
        .into_iter()
        .filter(|update| update["sessionUpdate"] == "tool_call")
        .collect();
    assert!(
        started
            .iter()
            .all(|update| update["title"] == "Linear: Create issue")
    );
    let replies: Vec<String> = demo
        .requests()
        .iter()
        .skip(1)
        .filter_map(|request| match request.messages.last() {
            Some(Message::Tool { content, .. }) => Some(content.clone()),
            _ => None,
        })
        .collect();
    assert!(
        replies[0].starts_with("The person declined this."),
        "{replies:?}"
    );
    assert_eq!(
        replies[1],
        "The person answered instead of letting this run: It's ENG-9 already."
    );
    assert_eq!(replies[2], "Created ENG-1");
}

// ---------------------------------------------------------------------------------------------
// Several calls in one message
// ---------------------------------------------------------------------------------------------

/// The tool results the model was sent, by call id, in the conversation's order.
fn tool_results(messages: &[Message]) -> Vec<(String, String)> {
    messages
        .iter()
        .filter_map(|message| match message {
            Message::Tool {
                tool_call_id,
                content,
                ..
            } => Some((tool_call_id.clone(), content.clone())),
            _ => None,
        })
        .collect()
}

/// The tool events recorded, as (kind, call id), in the order they came.
fn tool_events(sink: &Recorded) -> Vec<(String, String)> {
    sink.all()
        .iter()
        .filter(|update| {
            matches!(
                update["sessionUpdate"].as_str(),
                Some("tool_call" | "tool_call_update")
            )
        })
        .map(|update| {
            (
                update["sessionUpdate"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                update["toolCallId"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

fn event(kind: &str, id: &str) -> (String, String) {
    (kind.to_owned(), id.to_owned())
}

/// A file a read can't finish until the test fills it: a named pipe, which a reader opens only
/// once something opens it to write. The first receiver says a read has it open; the read ends
/// when the sender fills it (or is dropped).
#[cfg(unix)]
fn pipe(
    path: &std::path::Path,
    content: &'static str,
) -> (
    tokio::sync::oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    use std::io::Write as _;
    let made = std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .unwrap();
    assert!(made.success(), "mkfifo {}", path.display());
    let (opened, open) = tokio::sync::oneshot::channel();
    let (fill, filled) = std::sync::mpsc::channel::<()>();
    let path = path.to_owned();
    std::thread::spawn(move || {
        // Waits here until a read opens the pipe.
        let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        let _ = opened.send(());
        let _ = filled.recv();
        writer.write_all(content.as_bytes()).unwrap();
    });
    (open, fill)
}

/// Waits until `done` says so, for up to ten seconds.
#[cfg(unix)]
async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "never: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The reads of one message run at the same time: the second has its file open while the first
/// is still waiting for its own. They finish in the other order, and their results still go back
/// in the order the model asked for them, each one's record naming its call.
#[cfg(unix)]
#[tokio::test]
async fn reads_in_one_message_run_at_the_same_time_and_answer_in_order() {
    let folder = Folder::new();
    let (a_open, fill_a) = pipe(&folder.0.join("a.txt"), "from a\n");
    let (b_open, fill_b) = pipe(&folder.0.join("b.txt"), "from b\n");
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![
                call("a", "read_file", &json!({"path": "a.txt"})),
                call("b", "read_file", &json!({"path": "b.txt"})),
            ],
        ),
        Completion::text("Read both."),
    ]);
    let sink = Arc::new(Recorded::default());
    let answers = Answers::new(vec![]);
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        sink.clone(),
        answers.clone(),
    );
    let turn = tokio::spawn(async move { session.prompt("Read a.txt and b.txt.").await });

    // Neither read can finish yet, so both being open means both are under way at once.
    let both_open = tokio::time::timeout(Duration::from_secs(10), async {
        let _ = a_open.await;
        let _ = b_open.await;
    })
    .await
    .is_ok();
    if !both_open {
        // Let the reads finish one after the other, so the turn ends before the test does.
        let _ = fill_a.send(());
        let _ = fill_b.send(());
        let _ = turn.await;
        panic!("b.txt was never opened while a.txt was being read: the reads ran one at a time");
    }
    fill_b.send(()).unwrap();
    until("b's read is recorded as finished", || {
        tool_events(&sink).contains(&event("tool_call_update", "b"))
    })
    .await;
    fill_a.send(()).unwrap();
    let end = turn.await.unwrap().unwrap();

    assert_eq!(end.stop_reason, StopReason::EndTurn);
    let results = tool_results(&demo.requests()[1].messages);
    assert_eq!(
        results
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"],
        "the results follow the calls, not the order they finished in"
    );
    assert!(results[0].1.contains("from a"), "{results:?}");
    assert!(results[1].1.contains("from b"), "{results:?}");
    // Each read was asked about in turn, before either ran.
    let asked: Vec<String> = answers
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|request| request.tool_call_id.clone())
        .collect();
    assert_eq!(asked, ["a", "b"]);
    assert_eq!(
        tool_events(&sink),
        [
            event("tool_call", "a"),
            event("tool_call", "b"),
            event("tool_call_update", "b"),
            event("tool_call_update", "a"),
        ]
    );
}

/// A write between reads waits for the reads before it, and the reads after it wait for it: the
/// first read sees the file as it was, the last sees what was written, and every call is asked
/// about in the model's order.
#[tokio::test]
async fn a_write_between_reads_runs_in_its_place() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("notes.md"), "old notes\n").unwrap();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![
                call("before", "read_file", &json!({"path": "notes.md"})),
                call(
                    "write",
                    "write_file",
                    &json!({"path": "notes.md", "content": "new notes\n"}),
                ),
                call("after", "read_file", &json!({"path": "notes.md"})),
                call("list", "list_files", &json!({})),
            ],
        ),
        Completion::text("Updated."),
    ]);
    let sink = Arc::new(Recorded::default());
    let answers = Answers::new(vec![]);
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        sink.clone(),
        answers.clone(),
    );
    session.prompt("Update the notes.").await.unwrap();

    let results = tool_results(&demo.requests()[1].messages);
    let ids: Vec<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, ["before", "write", "after", "list"]);
    assert!(results[0].1.contains("old notes"), "{results:?}");
    assert!(results[1].1.starts_with("Replaced notes.md"), "{results:?}");
    assert!(results[2].1.contains("new notes"), "{results:?}");
    assert!(results[3].1.contains("notes.md"), "{results:?}");
    let asked: Vec<String> = answers
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|request| request.tool_call_id.clone())
        .collect();
    assert_eq!(asked, ["before", "write", "after", "list"]);
    // The read before the write ended before the write began, and the write ended before the
    // reads after it began.
    let events = tool_events(&sink);
    let place = |kind: &str, id: &str| {
        events
            .iter()
            .position(|recorded| *recorded == event(kind, id))
            .unwrap()
    };
    assert!(place("tool_call_update", "before") < place("tool_call", "write"));
    assert!(place("tool_call_update", "write") < place("tool_call", "after"));
    assert!(place("tool_call_update", "write") < place("tool_call", "list"));
}

/// Records every update, and cancels the turn when the call it watches finishes.
struct CancelsAfter {
    recorded: Recorded,
    id: &'static str,
    cancel: Mutex<Option<CancelHandle>>,
}

impl EventSink for CancelsAfter {
    fn update(&self, update: Value) -> BoxFuture<'_, anyhow::Result<()>> {
        if update["sessionUpdate"] == "tool_call_update"
            && update["toolCallId"] == self.id
            && let Some(cancel) = self.cancel.lock().unwrap().as_ref()
        {
            cancel.cancel();
        }
        self.recorded.update(update)
    }
}

/// A cancel that comes while a message's reads run stops every call after them: the reads under
/// way finish, and the write and the read after them are answered without running.
#[tokio::test]
async fn a_cancel_while_reads_run_stops_the_calls_after_them() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("a.md"), "first\n").unwrap();
    std::fs::write(folder.0.join("b.md"), "second\n").unwrap();
    let demo = Demo::scripted(vec![Completion::calls(
        "",
        vec![
            call("a", "read_file", &json!({"path": "a.md"})),
            call("b", "read_file", &json!({"path": "b.md"})),
            call(
                "c",
                "write_file",
                &json!({"path": "c.md", "content": "never\n"}),
            ),
            call("d", "read_file", &json!({"path": "a.md"})),
        ],
    )]);
    let sink = Arc::new(CancelsAfter {
        recorded: Recorded::default(),
        id: "a",
        cancel: Mutex::default(),
    });
    let answers = Answers::new(vec![]);
    let config = SessionConfig::new(
        "session-1",
        "writer",
        folder.0.clone(),
        "anthropic/claude-haiku-5.5",
    );
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        sink.clone(),
        answers.clone(),
        Arc::new(NoHostTools),
    );
    *sink.cancel.lock().unwrap() = Some(session.cancel_handle());
    let end = tokio::time::timeout(Duration::from_secs(10), session.prompt("Go."))
        .await
        .expect("the turn ends")
        .unwrap();

    assert_eq!(end.stop_reason, StopReason::Cancelled);
    assert_eq!(demo.requests().len(), 1, "no model call after the cancel");
    assert!(!folder.0.join("c.md").exists());
    let results = tool_results(&session.snapshot().history);
    let ids: Vec<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, ["a", "b", "c", "d"]);
    assert!(results[0].1.contains("first"), "{results:?}");
    assert!(results[1].1.contains("second"), "{results:?}");
    assert_eq!(results[2].1, "Not run: the turn was cancelled.");
    assert_eq!(results[3].1, "Not run: the turn was cancelled.");
    let asked: Vec<String> = answers
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|request| request.tool_call_id.clone())
        .collect();
    assert_eq!(asked, ["a", "b"]);
}

/// Reads run together count against the turn's tool-call cap one by one, as calls run on their
/// own do.
#[tokio::test]
async fn reads_run_together_count_against_the_tool_call_cap() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("a.md"), "a\n").unwrap();
    let demo = Demo::scripted(vec![Completion::calls(
        "",
        vec![
            call("one", "read_file", &json!({"path": "a.md"})),
            call("two", "list_files", &json!({})),
            call("three", "read_file", &json!({"path": "a.md"})),
        ],
    )]);
    let mut config = SessionConfig::new(
        "session-1",
        "writer",
        folder.0.clone(),
        "anthropic/claude-haiku-5.5",
    );
    config.max_tool_calls = 2;
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    let end = session.prompt("Read.").await.unwrap();

    assert_eq!(end.stop_reason, StopReason::MaxTurnRequests);
    let results = tool_results(&session.snapshot().history);
    assert_eq!(results.len(), 3);
    assert!(results[0].1.contains("\ta"), "{results:?}");
    assert!(results[1].1.contains("a.md"), "{results:?}");
    assert_eq!(
        results[2].1,
        "Not run: this turn reached its limit of tool calls."
    );
}

/// A long result is set aside as it always was, and a `read_tool_output` of it in the same
/// message waits for it to be set aside instead of running beside it.
#[tokio::test]
async fn a_set_aside_read_in_the_same_message_waits_for_the_read_it_names() {
    let folder = Folder::new();
    let long = (0..2_000).fold(String::new(), |mut text, line| {
        let _ = writeln!(text, "line {line} of the long file");
        text
    });
    std::fs::write(folder.0.join("big.txt"), &long).unwrap();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![
                call("big", "read_file", &json!({"path": "big.txt"})),
                call(
                    "more",
                    "read_tool_output",
                    &json!({"id": "big", "offset": 6000, "limit": 10}),
                ),
            ],
        ),
        Completion::text("Read it."),
    ]);
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    session.prompt("Read big.txt").await.unwrap();

    let results = tool_results(&demo.requests()[1].messages);
    assert!(results[0].1.contains("the rest was set aside"));
    assert!(
        results[1].1.contains("… characters 6000–6010 of "),
        "{:?}",
        results[1]
    );
}

// ---------------------------------------------------------------------------------------------
// What each call costs and is told
// ---------------------------------------------------------------------------------------------

fn at(time: &str) -> chrono::DateTime<chrono::Utc> {
    time.parse().unwrap()
}

/// The date is worked out where the team works, on both sides of midnight, and falls back to this
/// computer's own zone for a name that isn't one.
#[test]
fn the_date_line_is_in_the_teams_time_zone() {
    let late = at("2026-10-18T23:30:00Z");
    assert_eq!(
        session::today_line(Some("Asia/Singapore"), late),
        "Today is Monday 19 October 2026 (Asia/Singapore)."
    );
    assert_eq!(
        session::today_line(Some("America/Los_Angeles"), late),
        "Today is Sunday 18 October 2026 (America/Los_Angeles)."
    );
    let local = session::today_line(None, late);
    assert!(
        local.starts_with("Today is ") && local.contains(" 2026 (UTC"),
        "{local}"
    );
    assert_eq!(session::today_line(Some("Nowhere/Land"), late), local);
    assert_eq!(session::today_line(Some("  "), late), local);
    assert_eq!(
        session::without_date(&format!("Do it.\n\n{local}")),
        "Do it."
    );
    assert_eq!(
        session::without_date("Today is a word here."),
        "Today is a word here."
    );
}

/// Every turn's message ends with the date as it is when the turn starts; the instructions, which
/// lead the cached prompt, never carry it. A session parked overnight is a day on when resumed.
#[tokio::test]
async fn each_turn_is_dated_when_it_starts() {
    let folder = Folder::new();
    let demo = Demo::scripted(vec![Completion::text("One."), Completion::text("Two.")]);
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.time_zone = Some("Asia/Ho_Chi_Minh".to_owned());
    config.now = Some(at("2026-10-18T10:00:00Z"));
    let mut first = Session::open(
        config.clone(),
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    first.prompt("Find this week's news.").await.unwrap();
    let parked = first.snapshot();
    config.now = Some(at("2026-10-19T10:00:00Z"));
    let mut resumed = Session::resume(
        parked,
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    resumed.prompt("And today's?").await.unwrap();
    let requests = demo.requests();
    let Message::System { content: system } = &requests[1].messages[0] else {
        panic!("instructions first");
    };
    assert!(!system.contains("Today is"));
    let users: Vec<&str> = requests[1]
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::User { content, .. } => Some(content.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        users,
        [
            "Find this week's news.\n\nToday is Sunday 18 October 2026 (Asia/Ho_Chi_Minh).",
            "And today's?\n\nToday is Monday 19 October 2026 (Asia/Ho_Chi_Minh).",
        ]
    );
    // The model sees the prompt the operator gave, with the date after it.
    assert_eq!(requests[1].prompt(), "And today's?");
}

fn busy_call() -> Completion {
    let mut busy = Completion::calls("", vec![call("l", "list_files", &json!({}))]);
    busy.usage = Usage {
        input_tokens: 900,
        ..Usage::default()
    };
    busy
}

fn cut_summary(text: &str) -> Completion {
    Completion {
        finish: Finish::Length,
        ..Completion::text(text)
    }
}

/// A summary keeps the sources, figures and set-aside ids the work goes on from; one the length
/// limit cut off is asked for once more, shorter, never used half-written; and the Brief that came
/// in an earlier turn's opening message is put back.
#[tokio::test]
async fn a_cut_summary_is_asked_for_again_and_the_brief_is_kept() {
    let folder = Folder::new();
    std::fs::write(
        folder.0.join("AGENTS.md"),
        format!(
            "{}team t, agent writer. Rebuilt on every run. -->\n\n# What the team knows\n\nWrite in French.\n",
            crate::memory::NATIVE_FILE_MARKER
        ),
    )
    .unwrap();
    let demo = Demo::scripted(vec![
        busy_call(),
        cut_summary("Summary: found https://example.com/a and"),
        Completion::text("Summary: https://example.com/a (2026-10-01) says 42%."),
        Completion::text("Finished."),
    ]);
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.context_window = Some(1000);
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    let end = session.prompt("Carry on with the brief.").await.unwrap();
    assert_eq!(end.reply, "Finished.");
    let requests = demo.requests();
    let Message::System { content: system } = &requests[0].messages[0] else {
        panic!("instructions first");
    };
    assert!(
        !system.contains("Write in French"),
        "the Brief isn't read twice"
    );
    let asked = |index: usize| requests[index].prompt().to_owned();
    assert!(asked(1).contains("address (URL)") && asked(1).contains("set-aside output"));
    assert!(!asked(1).contains("shorter"));
    assert!(asked(2).contains("make this one shorter"), "{}", asked(2));
    let after = &requests[3].messages;
    assert_eq!(after.len(), 2);
    let Message::User { content, .. } = &after[1] else {
        panic!("the summary should stand in for the conversation");
    };
    assert!(content.contains("says 42%") && !content.contains("found https://example.com/a and"));
    assert!(content.contains(
        "## Standing notes from the operator\n# What the team knows\n\nWrite in French."
    ));
    assert!(content.contains("Carry on with the brief.") && content.contains("\n\nToday is "));

    // Cut twice: the conversation stays as it was rather than carry on from half a summary.
    let demo = Demo::scripted(vec![
        busy_call(),
        cut_summary("Summary: half"),
        cut_summary("Summary: half again"),
        Completion::text("Finished."),
    ]);
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.context_window = Some(1000);
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    session.prompt("The task.").await.unwrap();
    let requests = demo.requests();
    assert_eq!(requests[3].messages.len(), requests[0].messages.len() + 2);
}

/// How many bytes of text a request sends besides the instructions: what a stand-in for a model
/// with a small context counts.
fn sent(request: &SeenRequest) -> usize {
    request
        .messages
        .iter()
        .map(|message| match message {
            Message::System { .. } => 0,
            Message::User { content, .. } | Message::Tool { content, .. } => content.len(),
            Message::Assistant {
                content,
                tool_calls,
                ..
            } => content.len() + tool_calls.iter().map(|c| c.arguments.len()).sum::<usize>(),
        })
        .sum()
}

/// Writes a 500-line file whose every line names it, about 20,000 characters as `read_file` gives
/// it: under the length that is set aside, so its result goes into the conversation whole.
fn twenty_k_file(folder: &Folder, name: &str) {
    let text = (0..500).fold(String::new(), |mut text, line| {
        let _ = writeln!(text, "{name} line {line:03}: the quick brown fox");
        text
    });
    std::fs::write(folder.0.join(name), text).unwrap();
}

/// A model reply reading each of `names` at once, one call apiece, each call's id the file's name.
fn reads(names: &[&str]) -> Completion {
    Completion::calls(
        "",
        names
            .iter()
            .map(|name| call(name, "read_file", &json!({"path": name})))
            .collect(),
    )
}

/// The result of the tool call `id` in a request.
fn result_of<'a>(request: &'a SeenRequest, id: &str) -> &'a str {
    request
        .messages
        .iter()
        .find_map(|message| match message {
            Message::Tool {
                tool_call_id,
                content,
                ..
            } if tool_call_id == id => Some(content.as_str()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no result for {id}"))
}

fn is_whole_read(result: &str, name: &str) -> bool {
    result.contains(&format!("{name} line 499:")) && !result.contains("set aside")
}

/// Field audit (2026-10-19): one step that read several long files at once carried the next call
/// past the model's limit, and the provider's refusal ended the run, while its words claimed a
/// summary had been tried. Now the newest results are set aside, the older ones cut down oldest
/// first until the summary request fits, the conversation is summarised, and the turn carries on;
/// every cut result can still be read whole.
#[tokio::test]
async fn a_conversation_refused_as_too_long_is_cut_down_summarised_and_carried_on() {
    // What the model takes besides its instructions, in bytes.
    const LIMIT: usize = 100_000;
    let folder = Folder::new();
    let older = ["old1", "old2", "old3", "old4"];
    let newest = ["a", "b", "c", "d"];
    for name in older.iter().chain(&newest) {
        twenty_k_file(&folder, name);
    }
    let demo = Demo::limited(
        vec![
            reads(&older),
            reads(&newest),
            Completion::text("Summary: read eight files; a is under id a, old1 under id old1."),
            Completion::calls(
                "",
                vec![
                    call(
                        "again-a",
                        "read_tool_output",
                        &json!({"id": "a", "limit": 30_000}),
                    ),
                    call(
                        "again-old1",
                        "read_tool_output",
                        &json!({"id": "old1", "limit": 30_000}),
                    ),
                ],
            ),
            Completion::text("Finished."),
        ],
        |request| sent(request) > LIMIT,
    );
    let sink = Arc::new(Recorded::default());
    let mut session = session(
        &folder,
        Provider::Demo(demo.clone()),
        sink.clone(),
        Arc::new(AllowAll),
    );
    let end = session.prompt("Read all eight files.").await.unwrap();
    assert_eq!(end.stop_reason, StopReason::EndTurn);
    assert_eq!(end.reply, "Finished.");

    let requests = demo.requests();
    assert_eq!(
        requests.len(),
        6,
        "work, work, refused, summary, work, work"
    );
    // The call after the second step was refused, with every result whole.
    let refused = &requests[2];
    assert!(sent(refused) > LIMIT && requests[..2].iter().all(|r| sent(r) <= LIMIT));
    assert!(is_whole_read(result_of(refused, "a"), "a"));
    // The summary was asked for in a conversation cut down to fit: the newest results set aside
    // to the preview a long output gets, the oldest read cut shorter, the latest older one whole.
    let summary = &requests[3];
    assert!(summary.prompt().contains("Write a summary"));
    assert!(sent(summary) <= LIMIT, "{}", sent(summary));
    for name in newest {
        let result = result_of(summary, name);
        assert!(
            result.contains(&format!(
                "read_tool_output, id {name}, starting at offset 6000"
            )),
            "{result}"
        );
    }
    assert!(result_of(summary, "old1").contains("id old1, starting at offset 1500"));
    assert!(is_whole_read(result_of(summary, "old4"), "old4"));
    // The work carried on from the summary, and read both cut results whole.
    assert_eq!(requests[4].messages.len(), 2);
    let read_back = &requests[5];
    assert!(is_whole_read(result_of(read_back, "again-a"), "a"));
    assert!(is_whole_read(result_of(read_back, "again-old1"), "old1"));
    assert!(sink.all().iter().any(|update| {
        update["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("conversation was summarised"))
    }));
}

/// Room is made once a turn. When the conversation still doesn't fit, after the summary or in it,
/// the turn ends with the error, whose words are then true, and makes no more calls.
#[tokio::test]
async fn a_second_refusal_in_a_turn_ends_it_with_the_error() {
    // The summary fits, but what it says is too long for the model by itself.
    const LIMIT: usize = 50_000;
    let folder = Folder::new();
    let newest = ["a", "b", "c", "d"];
    for name in newest {
        twenty_k_file(&folder, name);
    }
    let demo = Demo::limited(
        vec![
            reads(&newest),
            Completion::text(&"Summary: everything, word for word. ".repeat(2_000)),
            Completion::text("Never reached."),
        ],
        |request| sent(request) > LIMIT,
    );
    let mut agent = session(
        &folder,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    let error = agent.prompt("Read all four.").await.unwrap_err();
    assert!(matches!(error, AgentError::ContextTooLong), "{error}");
    assert!(error.to_string().contains("even after summarising it"));
    let requests = demo.requests();
    assert_eq!(requests.len(), 4, "work, refused, summary, refused");
    assert!(requests[2].prompt().contains("Write a summary") && sent(&requests[2]) <= LIMIT);
    assert_eq!(requests[3].messages.len(), 2);
    assert!(sent(&requests[3]) > LIMIT);

    // The summary itself is refused: no second try.
    let demo = Demo::limited(vec![reads(&newest)], |request| request.messages.len() > 2);
    let mut agent = session(
        &folder,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    let error = agent.prompt("Read all four.").await.unwrap_err();
    assert!(matches!(error, AgentError::ContextTooLong), "{error}");
    let requests = demo.requests();
    assert_eq!(requests.len(), 3, "work, refused, refused summary");
    assert!(requests[2].prompt().contains("Write a summary"));
}

/// The size of the next call is estimated before it is sent: what the provider counted for the
/// last call, plus the results added since. A step that adds more than the model has room for is
/// summarised first, with its newest results cut down so the summary fits, and nothing is refused.
#[tokio::test]
async fn a_step_that_adds_too_much_is_summarised_before_the_call_is_refused() {
    let folder = Folder::new();
    let names = ["a", "b", "c", "d", "e", "f"];
    for name in names {
        twenty_k_file(&folder, name);
    }
    // A model of 30,000 tokens, 1,000 kept for the reply, that refuses more than `limit` bytes
    // besides its instructions.
    let read_six = async |limit: usize| {
        let mut first = reads(&names);
        // The instructions and the prompt, as the provider counted them.
        first.usage.input_tokens = 3_000;
        let demo = Demo::limited(
            vec![
                first,
                Completion::text("Summary: read six files."),
                Completion::text("Finished."),
            ],
            move |request| sent(request) > limit,
        );
        let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
        config.context_window = Some(30_000);
        config.max_tokens = 1_000;
        let mut session = Session::open(
            config,
            Provider::Demo(demo.clone()),
            Arc::new(Recorded::default()),
            Arc::new(AllowAll),
            Arc::new(NoHostTools),
        );
        let end = session.prompt("Read all six.").await.unwrap();
        assert_eq!(end.reply, "Finished.");
        demo.requests()
    };

    // 29,000 tokens less the 3,000 counted: about 104,000 bytes.
    let limit = 104_000;
    let requests = read_six(limit).await;
    assert_eq!(requests.len(), 3, "work, summary, work");
    assert!(requests.iter().all(|request| sent(request) <= limit));
    let summary = &requests[1];
    assert!(summary.prompt().contains("Write a summary"));
    assert!(result_of(summary, "a").contains("id a, starting at offset 6000"));
    assert!(is_whole_read(result_of(summary, "f"), "f"));
    assert_eq!(requests[2].messages.len(), 2);

    // The estimate came out low and the summary is refused all the same: room is made, as for
    // the work's own call, and the summary asked for again.
    let limit = 80_000;
    let requests = read_six(limit).await;
    assert_eq!(requests.len(), 4, "work, refused summary, summary, work");
    assert!(requests[1].prompt().contains("Write a summary") && sent(&requests[1]) > limit);
    assert!(requests[2].prompt().contains("Write a summary") && sent(&requests[2]) <= limit);
    assert!(result_of(&requests[2], "f").contains("id f, starting at offset"));
    assert_eq!(requests[3].messages.len(), 2);
}

fn calls_recorded(sink: &Recorded) -> Vec<Value> {
    sink.all()
        .into_iter()
        .filter(|update| update["sessionUpdate"] == "usage_update")
        .map(|update| update["_meta"]["loomwatch"]["call"].clone())
        .collect()
}

/// One record per model call, saying what it was for (the work, the rest of a cut-off reply, a
/// summary; a handover turn), with its tokens by kind, its cost and its web use. A provider that
/// leaves a figure out gets a zero.
#[tokio::test]
async fn every_call_is_recorded_with_what_it_was_for_and_used() {
    let folder = Folder::new();
    let (_, base) = stand(vec![
        ok(&[
            json!({"choices": [{"index": 0, "delta": {"content": "Part one, "}, "finish_reason": "length"}],
                   "usage": {"prompt_tokens": 1000, "completion_tokens": 200,
                             "prompt_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 300},
                             "completion_tokens_details": {"reasoning_tokens": 50},
                             "cost": 0.01, "server_tool_use": {"web_search_requests": 1}}}),
        ]),
        ok(&[
            json!({"choices": [{"index": 0, "delta": {"content": "part two."}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 1300, "completion_tokens": 10, "cost": 0.002}}),
        ]),
        ok(&[
            json!({"choices": [{"index": 0, "delta": {"content": "Handed over."}, "finish_reason": "stop"}],
                   "usage": {"prompt_tokens": 1400, "completion_tokens": 5}}),
        ]),
    ])
    .await;
    let sink = Arc::new(Recorded::default());
    let mut session = on_chat(&folder, &base, sink.clone(), Arc::new(AllowAll));
    assert_eq!(
        session.prompt("Write it.").await.unwrap().reply,
        "Part one, part two."
    );
    session.set_purpose("handover");
    session.prompt("Hand over.").await.unwrap();
    session.end_purpose();
    let calls = calls_recorded(&sink);
    assert_eq!(
        calls[0],
        json!({"kind": "work", "turn": "work", "model": CHAT_CLAUDE,
               "inputTokens": 100, "cachedReadTokens": 600, "cachedWriteTokens": 300,
               "outputTokens": 200, "reasoningTokens": 50, "costUsd": 0.01,
               "webSearches": 1, "webFetches": 0})
    );
    assert_eq!(calls[1]["kind"], "carry_on");
    assert_eq!(
        (
            calls[1]["cachedReadTokens"].as_u64(),
            calls[1]["reasoningTokens"].as_u64()
        ),
        (Some(0), Some(0))
    );
    assert_eq!(
        (calls[2]["kind"].as_str(), calls[2]["turn"].as_str()),
        (Some("work"), Some("handover"))
    );
    assert_eq!(calls[2]["costUsd"], 0.0);

    // A session opened for a check step says so on every call; a summary is its own kind.
    let mut summary = Completion::text("Summary.");
    summary.usage.output_tokens = 20;
    let demo = Demo::scripted(vec![busy_call(), summary, Completion::text("Checked.")]);
    let sink = Arc::new(Recorded::default());
    let mut config = SessionConfig::new("s", "checker", folder.0.clone(), "m");
    config.context_window = Some(1000);
    "check".clone_into(&mut config.purpose);
    let mut checking = Session::open(
        config,
        Provider::Demo(demo),
        sink.clone(),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    checking.prompt("Check it.").await.unwrap();
    let calls = calls_recorded(&sink);
    assert_eq!(
        calls.len(),
        2,
        "the demo's free calls aren't recorded: {calls:?}"
    );
    assert_eq!(
        (calls[0]["kind"].as_str(), calls[0]["turn"].as_str()),
        (Some("work"), Some("check"))
    );
    assert_eq!(
        (calls[1]["kind"].as_str(), calls[1]["turn"].as_str()),
        (Some("summary"), Some("check"))
    );
}

/// A Chat Completions stream from `OpenRouter` for a researcher on Claude that searched with
/// Anthropic's own engine. Its shape is the one `OpenRouter` sends: keep-alive comments, reasoning
/// in pieces closed by a signature, the reply, its sources as `url_citation` annotations (one per
/// cited passage, not per search), the finish, and a last chunk that repeats it with the usage.
/// The searches are counted only in `server_tool_use_details`; no tool call or reasoning entry
/// names them.
const CLAUDE_SEARCHED: &str = r#": OPENROUTER PROCESSING

data: {"id":"gen-1792335100-r","object":"chat.completion.chunk","created":1792335100,"model":"anthropic/claude-haiku-5.5","provider":"Anthropic","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"Search for this week's releases.","reasoning_details":[{"type":"reasoning.text","text":"Search for this week's releases.","format":"anthropic-claude-v1","index":0}]},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-1792335100-r","object":"chat.completion.chunk","created":1792335100,"model":"anthropic/claude-haiku-5.5","provider":"Anthropic","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_details":[{"type":"reasoning.text","signature":"EqQBCkYIBxgCKkA","format":"anthropic-claude-v1","index":0}]},"finish_reason":null,"native_finish_reason":null}]}

: OPENROUTER PROCESSING

: OPENROUTER PROCESSING

data: {"id":"gen-1792335100-r","object":"chat.completion.chunk","created":1792335100,"model":"anthropic/claude-haiku-5.5","provider":"Anthropic","choices":[{"index":0,"delta":{"role":"assistant","content":"Two releases landed this week"},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-1792335100-r","object":"chat.completion.chunk","created":1792335100,"model":"anthropic/claude-haiku-5.5","provider":"Anthropic","choices":[{"index":0,"delta":{"role":"assistant","content":" (page ages shown in search results)."},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-1792335100-r","object":"chat.completion.chunk","created":1792335100,"model":"anthropic/claude-haiku-5.5","provider":"Anthropic","choices":[{"index":0,"delta":{"role":"assistant","content":"","annotations":[{"type":"url_citation","url_citation":{"url":"https://example.com/releases","title":"Releases","content":"Version 4.2 shipped on Tuesday.","start_index":0,"end_index":29}},{"type":"url_citation","url_citation":{"url":"https://example.org/changelog","title":"Changelog","start_index":0,"end_index":29}}]},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-1792335100-r","object":"chat.completion.chunk","created":1792335100,"model":"anthropic/claude-haiku-5.5","provider":"Anthropic","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop","native_finish_reason":"end_turn"}]}

data: {"id":"gen-1792335100-r","object":"chat.completion.chunk","created":1792335100,"model":"anthropic/claude-haiku-5.5","provider":"Anthropic","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop","native_finish_reason":"end_turn"}],"usage":{"prompt_tokens":24310,"completion_tokens":412,"total_tokens":24722,"cost":0.0291,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":22258,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.0291,"upstream_inference_prompt_cost":0.0255,"upstream_inference_completions_cost":0.0036},"completion_tokens_details":{"reasoning_tokens":31,"image_tokens":0,"audio_tokens":0},"server_tool_use_details":{"web_search_requests":3}}}

data: [DONE]

"#;

/// The same for a model without a search or fetch engine of its own, so `OpenRouter` ran both.
/// Only its searches have a count; the pages it read are the rest of the calls it ran.
const OPENROUTER_FETCHED: &str = r#": OPENROUTER PROCESSING

data: {"id":"gen-1792335200-g","object":"chat.completion.chunk","created":1792335200,"model":"z-ai/glm-5.3","provider":"Z.AI","choices":[{"index":0,"delta":{"role":"assistant","content":"The changelog lists three fixes."},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-1792335200-g","object":"chat.completion.chunk","created":1792335200,"model":"z-ai/glm-5.3","provider":"Z.AI","choices":[{"index":0,"delta":{"role":"assistant","content":"","annotations":[{"type":"url_citation","url_citation":{"url":"https://example.org/changelog","title":"Changelog","content":"Fixed: three crashes. [...] Released Tuesday.","start_index":0,"end_index":32}}]},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-1792335200-g","object":"chat.completion.chunk","created":1792335200,"model":"z-ai/glm-5.3","provider":"Z.AI","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{"prompt_tokens":9120,"completion_tokens":96,"total_tokens":9216,"cost":0.0071,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"completion_tokens_details":{"reasoning_tokens":0},"server_tool_use_details":{"tool_calls_requested":3,"tool_calls_executed":3,"web_search_requests":1}}}

data: [DONE]

"#;

/// What a researcher's call searched and read reaches its usage record, as `OpenRouter` streams
/// it: from the model's own engine (Claude's) or from `OpenRouter`'s.
#[tokio::test]
async fn a_researchers_web_use_reaches_its_usage_record() {
    let folder = Folder::new();
    let streamed = |body: &str| Reply {
        status: StatusCode::OK,
        body: body.to_owned(),
        delay: Duration::ZERO,
    };
    let (_, base) = stand(vec![
        streamed(CLAUDE_SEARCHED),
        streamed(OPENROUTER_FETCHED),
    ])
    .await;
    let mut calls = Vec::new();
    for (model, reply) in [
        (
            CHAT_CLAUDE,
            "Two releases landed this week (page ages shown in search results).",
        ),
        ("z-ai/glm-5.3", "The changelog lists three fixes."),
    ] {
        let sink = Arc::new(Recorded::default());
        let mut config = SessionConfig::new("s", "researcher", folder.0.clone(), model);
        config.tools = ToolSet::all(true);
        let mut session = Session::open(
            config,
            openrouter(&base),
            sink.clone(),
            Arc::new(AllowAll),
            Arc::new(NoHostTools),
        );
        assert_eq!(session.prompt("What's new?").await.unwrap().reply, reply);
        calls.extend(calls_recorded(&sink));
    }
    assert_eq!(
        calls[0],
        json!({"kind": "work", "turn": "work", "model": CHAT_CLAUDE,
               "inputTokens": 2052, "cachedReadTokens": 0, "cachedWriteTokens": 22258,
               "outputTokens": 412, "reasoningTokens": 31, "costUsd": 0.0291,
               "webSearches": 3, "webFetches": 0})
    );
    assert_eq!(
        (
            calls[1]["webSearches"].as_u64(),
            calls[1]["webFetches"].as_u64()
        ),
        (Some(1), Some(2))
    );
}

/// The team file's web limits reach `OpenRouter` for an agent allowed the web. A provider that
/// refuses them is asked again without them, and the model isn't sent them again.
#[tokio::test]
async fn web_limits_reach_openrouter_and_a_refusal_falls_back_without_them() {
    let folder = Folder::new();
    let refused = Reply {
        status: StatusCode::BAD_REQUEST,
        body: json!({"error": {"code": 400, "message": "max_tool_calls is not supported by this provider"}}).to_string(),
        delay: Duration::ZERO,
    };
    let answer = |text: &str| {
        ok(&[
            json!({"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": "stop"}]}),
        ])
    };
    let (stand, base) = stand(vec![refused, answer("Found it."), answer("Again.")]).await;
    let provider = openrouter(&base);
    let open = |provider: Provider| {
        let mut config = SessionConfig::new("s", "researcher", folder.0.clone(), "z-ai/glm-5.3");
        config.tools = ToolSet::all(true);
        config.web = WebLimits {
            page_tokens: 4_000,
            pages: Some(3),
            searches: Some(2),
            steps: Some(4),
        };
        Session::open(
            config,
            provider,
            Arc::new(Recorded::default()),
            Arc::new(AllowAll),
            Arc::new(NoHostTools),
        )
    };
    assert_eq!(
        open(provider.clone())
            .prompt("Look it up.")
            .await
            .unwrap()
            .reply,
        "Found it."
    );
    assert_eq!(
        open(provider).prompt("Again.").await.unwrap().reply,
        "Again."
    );
    let bodies = stand.bodies.lock().unwrap().clone();
    let server = |body: &Value| -> Vec<Value> {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| {
                tool["type"]
                    .as_str()
                    .is_some_and(|kind| kind.starts_with("openrouter:"))
            })
            .cloned()
            .collect()
    };
    assert_eq!(bodies[0]["max_tool_calls"], 4);
    assert_eq!(
        server(&bodies[0])[1],
        json!({"type": "openrouter:web_fetch", "parameters": {"max_uses": 3, "max_content_tokens": 4_000}})
    );
    for later in &bodies[1..] {
        assert!(later.get("max_tool_calls").is_none());
        assert_eq!(
            server(later),
            [
                json!({"type": "openrouter:web_search"}),
                json!({"type": "openrouter:web_fetch"})
            ]
        );
    }
    let system = bodies[0]["messages"][0]["content"].as_str().unwrap();
    assert!(
        system.contains("A page is read up to about 3,000 words."),
        "{system}"
    );
}

/// With a library too large to list, the instructions list the agent's own skills and the
/// library's that its first message calls for, and keep them for the session, resumed too.
#[tokio::test]
async fn the_skills_listed_are_the_ones_its_first_message_calls_for() {
    let folder = Folder::new();
    let library = folder.0.join("library");
    let own = folder.0.join(".agents").join("skills");
    let mut skills: Vec<(PathBuf, String, String)> = (0..24)
        .map(|index| {
            (
                library.clone(),
                format!("skill-{index:02}"),
                "Tidies a folder of notes into an outline.".to_owned(),
            )
        })
        .collect();
    skills.push((
        library.clone(),
        "slides".to_owned(),
        "Builds a presentation deck as HTML slides.".to_owned(),
    ));
    skills.push((
        own.clone(),
        "house-style".to_owned(),
        "How this team writes.".to_owned(),
    ));
    for (root, name, description) in &skills {
        std::fs::create_dir_all(root.join(name)).unwrap();
        std::fs::write(
            root.join(name).join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\nBody"),
        )
        .unwrap();
    }
    let demo = Demo::scripted(vec![Completion::text("One."), Completion::text("Two.")]);
    let mut config = SessionConfig::new("s", "designer", folder.0.clone(), "m");
    config.skill_roots = vec![own];
    config.skill_library = vec![library.clone()];
    let mut session = Session::open(
        config.clone(),
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    session
        .prompt("## Task\nPrepare the slides for Monday.")
        .await
        .unwrap();
    let mut resumed = Session::resume(
        session.snapshot(),
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    resumed.prompt("Now the speaker notes.").await.unwrap();
    let requests = demo.requests();
    let Message::System { content: system } = &requests[0].messages[0] else {
        panic!("instructions first");
    };
    assert!(
        system.contains("- slides: Builds a presentation deck"),
        "{system}"
    );
    assert!(
        system.contains("- house-style: How this team writes."),
        "{system}"
    );
    assert!(!system.contains("- skill-00"), "{system}");
    assert!(system.contains(&format!("…and 24 more skills in {}.", library.display())));
    assert_eq!(
        requests[1].messages[0], requests[0].messages[0],
        "kept for the session"
    );

    // The engine says what the agent is for and was asked, and that picks them, not the rest of
    // its first message.
    let demo = Demo::scripted(vec![Completion::text("One.")]);
    let mut config = SessionConfig::new("s", "designer", folder.0.clone(), "m");
    config.skill_library = vec![library.clone()];
    config.skill_focus = Some("You make decks.\nPrepare the slides for Monday.".to_owned());
    let mut focused = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    focused
        .prompt("## Task\nDo the work you were handed.")
        .await
        .unwrap();
    let Message::System { content: system } = &demo.requests()[0].messages[0] else {
        panic!("instructions first");
    };
    assert!(
        system.contains("- slides: Builds a presentation deck"),
        "{system}"
    );
}

// ---------------------------------------------------------------------------------------------
// A stand-in for Anthropic (ADR 0073)
// ---------------------------------------------------------------------------------------------

const CLAUDE_KEY: &str = "sk-ant-api03-test-0123456789abcdef";

fn claude(base: &str) -> Provider {
    let opus = crate::ai::ClaudeModel {
        id: "claude-opus-5-5".into(),
        name: "Claude Opus 5.5".into(),
        context_length: 1_000_000,
        max_output: 128_000,
        adaptive_thinking: true,
        sees_pictures: true,
        efforts: vec!["low".into(), "medium".into(), "high".into()],
    };
    let anthropic = base.strip_suffix("/api/v1").unwrap_or(base);
    Provider::Anthropic(Arc::new(
        Anthropic::new(
            ApiKey::new(CLAUDE_KEY).unwrap(),
            anthropic,
            vec![opus],
            std::collections::HashMap::new(),
        )
        .unwrap()
        .with_backoff(Duration::from_millis(5)),
    ))
}

/// Anthropic's stream: each event as a `data:` line, the way it sends them.
fn events(events: &[Value]) -> Reply {
    let mut body = String::new();
    for event in events {
        let kind = event["type"].as_str().unwrap_or("message");
        let _ = write!(body, "event: {kind}\ndata: {event}\n\n");
    }
    Reply {
        status: StatusCode::OK,
        body,
        delay: Duration::ZERO,
    }
}

fn message_start(input: u64, cached: u64) -> Value {
    json!({"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [],
           "usage": {"input_tokens": input, "cache_read_input_tokens": cached, "cache_creation_input_tokens": 0, "output_tokens": 1}}})
}

fn text_block(index: u64, text: &str) -> [Value; 3] {
    [
        json!({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}}),
        json!({"type": "content_block_stop", "index": index}),
    ]
}

fn ended(stop: &str, output: u64) -> [Value; 2] {
    [
        json!({"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": output}}),
        json!({"type": "message_stop"}),
    ]
}

/// A turn on Claude: thinking and a tool call put back together from the stream, the signed
/// message sent back exactly as Anthropic wrote it, the cost worked out from list prices and marked
/// so, and the key in no event.
#[tokio::test]
async fn claude_streams_signed_thinking_and_tool_calls_and_sends_them_back_unchanged() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("notes.md"), "hello").unwrap();
    let first: Vec<Value> = [
        vec![
            message_start(50, 1_000),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Let me look."}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-1"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "ping"}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {}}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"pa"}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "th\":\"notes.md\"}"}}),
            json!({"type": "content_block_stop", "index": 1}),
        ],
        ended("tool_use", 30).to_vec(),
    ]
    .concat();
    let second: Vec<Value> = [
        vec![message_start(70, 1_050)],
        text_block(0, "It says hello.").to_vec(),
        ended("end_turn", 5).to_vec(),
    ]
    .concat();
    let (stand, base) = stand(vec![events(&first), events(&second)]).await;
    let sink = Arc::new(Recorded::default());
    let mut session = session_on(
        &folder,
        claude(&base),
        sink.clone(),
        Arc::new(AllowAll),
        "anthropic:claude-opus-5-5",
    );
    let end = session.prompt("What does notes.md say?").await.unwrap();

    assert_eq!(end.reply, "It says hello.");
    assert_eq!(end.usage.paid_by, Some(Source::Anthropic));
    assert!(end.usage.cost_estimated);
    assert_eq!(end.usage.cached_read_tokens, 2_050);
    // Opus 5.5 at $4 / $20, cache reads at $0.20, per million tokens.
    let expected = (120.0 * 4.0 + 2_050.0 * 0.2 + 35.0 * 20.0) / 1_000_000.0;
    assert!(
        (end.usage.cost_usd - expected).abs() < 1e-12,
        "{}",
        end.usage.cost_usd
    );
    assert_eq!(end.as_result()["_meta"]["loomwatch"]["paidBy"], "anthropic");

    let bodies = stand.bodies.lock().unwrap().clone();
    assert_eq!(bodies[0]["model"], "claude-opus-5-5");
    assert!(
        bodies[0]["system"]
            .as_str()
            .is_some_and(|system| !system.is_empty())
    );
    let sent_back = &bodies[1]["messages"][1];
    assert_eq!(sent_back["role"], "assistant");
    assert_eq!(
        sent_back["content"],
        json!([
            {"type": "thinking", "thinking": "Let me look.", "signature": "sig-1"},
            {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "notes.md"}},
        ])
    );
    let results = &bodies[1]["messages"][2];
    assert_eq!(results["role"], "user");
    assert_eq!(results["content"][0]["type"], "tool_result");
    assert_eq!(results["content"][0]["tool_use_id"], "toolu_1");
    // The first request is the second's prefix: the cache and the signature both hold.
    assert_eq!(bodies[0]["system"], bodies[1]["system"]);
    assert_eq!(bodies[0]["tools"], bodies[1]["tools"]);
    assert_eq!(bodies[0]["messages"][0], bodies[1]["messages"][0]);

    assert!(
        stand
            .auth
            .lock()
            .unwrap()
            .iter()
            .all(|key| key == CLAUDE_KEY)
    );
    let recorded = serde_json::to_string(&*sink.0.lock().unwrap()).unwrap();
    assert!(!recorded.contains(CLAUDE_KEY));
}

/// A Claude reply the length limit cut off: a whole `list_files` call with no input, then the
/// `write_file` call it opens, its input streamed as far as `partial` before the limit, and its
/// block `closed` or left open as the stream ends.
fn cut_claude_reply(partial: &str, closed: bool) -> Vec<Value> {
    let mut reply = vec![
        message_start(50, 0),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_list", "name": "list_files", "input": {}}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": ""}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_cut", "name": "write_file", "input": {}}}),
    ];
    if !partial.is_empty() {
        reply.push(json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": partial}}));
    }
    if closed {
        reply.push(json!({"type": "content_block_stop", "index": 1}));
    }
    reply.extend(ended("max_tokens", 16_000));
    reply
}

/// A tool call Claude's length limit cut off part way doesn't run with nothing in it: the model is
/// told its reply reached the limit, so it can write the file in parts. Run 948bd594's tutor heard
/// "`path` is required" instead, from a lesson file cut off at 16,000 tokens. The call goes back to
/// Anthropic with an empty input, the only kind it takes, and the whole call before it still runs.
#[tokio::test]
async fn a_claude_tool_call_cut_off_at_the_length_limit_is_sent_back_with_the_reason() {
    let partial = "{\"path\":\"lesson.html\",\"content\":\"<!doctype html><p>A very long les";
    for (partial, closed) in [
        (partial, true),
        // Cut off before any of its input was written.
        ("", true),
        // The stream ended without closing the call's block.
        (partial, false),
    ] {
        let folder = Folder::new();
        let done: Vec<Value> = [
            vec![message_start(80, 0)],
            text_block(0, "Done.").to_vec(),
            ended("end_turn", 3).to_vec(),
        ]
        .concat();
        let (stand, base) = stand(vec![
            events(&cut_claude_reply(partial, closed)),
            events(&done),
        ])
        .await;
        let sink = Arc::new(Recorded::default());
        let mut session = session_on(
            &folder,
            claude(&base),
            sink.clone(),
            Arc::new(AllowAll),
            "anthropic:claude-opus-5-5",
        );
        let end = session.prompt("Write lesson.html").await.unwrap();
        assert_eq!(end.reply, "Done.", "{partial:?}");

        let bodies = stand.bodies.lock().unwrap().clone();
        assert_eq!(
            bodies[1]["messages"][1]["content"][1],
            json!({"type": "tool_use", "id": "toolu_cut", "name": "write_file", "input": {}}),
            "{partial:?}"
        );
        let results = &bodies[1]["messages"][2]["content"];
        assert_eq!(results[0]["tool_use_id"], "toolu_list");
        assert!(
            !results[0]["content"].to_string().contains("Not run"),
            "{partial:?}: {}",
            results[0]
        );
        assert_eq!(results[1]["tool_use_id"], "toolu_cut");
        assert!(
            results[1]["content"]
                .to_string()
                .contains("reached the length limit of one reply"),
            "{partial:?}: {}",
            results[1]
        );
        let recorded = serde_json::to_string(&*sink.0.lock().unwrap()).unwrap();
        assert!(
            recorded.contains("reached the length limit of one reply"),
            "{partial:?}"
        );
        assert!(!recorded.contains("is required"), "{partial:?}");
        assert!(!folder.0.join("lesson.html").exists());
    }
}

/// A reply `pause_turn` stopped is carried on in the same call, and Claude is told what it wrote.
#[tokio::test]
async fn a_paused_claude_reply_is_carried_on() {
    let folder = Folder::new();
    let paused: Vec<Value> = [
        vec![message_start(10, 0)],
        text_block(0, "Searching… ").to_vec(),
        ended("pause_turn", 4).to_vec(),
    ]
    .concat();
    let finished: Vec<Value> = [
        vec![message_start(20, 0)],
        text_block(0, "found it.").to_vec(),
        ended("end_turn", 3).to_vec(),
    ]
    .concat();
    let (stand, base) = stand(vec![events(&paused), events(&finished)]).await;
    let mut session = session_on(
        &folder,
        claude(&base),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        "anthropic:claude-opus-5-5",
    );
    let end = session.prompt("Look it up.").await.unwrap();
    assert_eq!(end.reply, "Searching… found it.");
    assert_eq!(end.usage.output_tokens, 7);
    let bodies = stand.bodies.lock().unwrap().clone();
    let carried = bodies[1]["messages"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(carried["role"], "assistant");
    assert_eq!(carried["content"][0]["text"], "Searching… ");
}

/// One of the replies Anthropic paused in the run of 2026-10-23: a search it ran, and its result.
fn paused_search(id: &str) -> Reply {
    events(
        &[
            vec![message_start(10, 1_000)],
            server_tool_block(0, id, "web_search", &json!({"query": "inverted index"})).to_vec(),
            result_block(
                1,
                "web_search_tool_result",
                id,
                &json!([{"type": "web_search_result", "title": "IR book", "url": "https://nlp.stanford.edu/IR-book/"}]),
            )
            .to_vec(),
            ended("pause_turn", 5).to_vec(),
        ]
        .concat(),
    )
}

/// The assistant message a request sent back, and the user message after it.
fn sent_back(body: &Value) -> (Vec<Value>, Vec<Value>) {
    let messages = body["messages"].as_array().unwrap();
    let at = messages
        .iter()
        .rposition(|message| message["role"] == "assistant")
        .unwrap();
    let content = |message: &Value| message["content"].as_array().cloned().unwrap_or_default();
    (content(&messages[at]), content(&messages[at + 1]))
}

/// The run of 2026-10-23 that stopped with "`code_execution` tool use … was found without a
/// corresponding `code_execution_tool_result` block": the tutor's reply was still paused after it
/// was carried on five times, its last block code Anthropic hadn't run yet, beside a plan update.
/// Sent back as it was, Anthropic refused the next call. Now the code that never ran is left out,
/// the plan update runs, the tutor is told its reply was paused, and the next call is one Anthropic
/// takes. How full the context is comes from the last request, not the six added up, so no summary
/// is made for nothing.
#[tokio::test]
async fn a_claude_reply_still_paused_leaves_out_the_step_that_never_ran() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("notes.md"), "hello").unwrap();
    let mut replies: Vec<Reply> = (1..=5)
        .map(|n| paused_search(&format!("srvtoolu_{n}")))
        .collect();
    replies.push(events(
        &[
            vec![message_start(10, 1_000)],
            vec![
                json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_read", "name": "read_file", "input": {}}}),
                json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"notes.md\"}"}}),
                json!({"type": "content_block_stop", "index": 0}),
            ],
            server_tool_block(1, "srvtoolu_unrun", "code_execution", &json!({"code": "print(1)"}))
                .to_vec(),
            ended("pause_turn", 5).to_vec(),
        ]
        .concat(),
    ));
    replies.push(events(
        &[
            vec![message_start(10, 1_200)],
            text_block(0, "Done.").to_vec(),
            ended("end_turn", 3).to_vec(),
        ]
        .concat(),
    ));
    let (stand, base) = stand(replies).await;
    let sink = Arc::new(Recorded::default());
    let mut session = session_on(
        &folder,
        claude(&base),
        sink.clone(),
        Arc::new(AllowAll),
        "anthropic:claude-opus-5-5",
    );
    let end = session.prompt("Teach indexing.").await.unwrap();
    assert_eq!(end.reply, "Done.");

    let bodies = stand.bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 7);
    let (reply, after) = sent_back(&bodies[6]);
    let ids: Vec<&str> = reply
        .iter()
        .filter_map(|block| block.get("id").or_else(|| block.get("tool_use_id")))
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(
        ids,
        [
            "srvtoolu_1",
            "srvtoolu_1",
            "srvtoolu_2",
            "srvtoolu_2",
            "srvtoolu_3",
            "srvtoolu_3",
            "srvtoolu_4",
            "srvtoolu_4",
            "srvtoolu_5",
            "srvtoolu_5",
            "toolu_read"
        ]
    );
    assert_eq!(after.len(), 2, "{after:?}");
    assert_eq!(after[0]["type"], "tool_result");
    assert_eq!(after[0]["tool_use_id"], "toolu_read");
    assert_eq!(after[1]["type"], "text");
    assert!(
        after[1]["text"]
            .as_str()
            .is_some_and(|text| text.contains("paused") && text.contains("didn't run")),
        "{after:?}"
    );

    let updates = sink.all();
    assert!(
        !updates
            .iter()
            .any(|update| update["toolCallId"] == "srvtoolu_unrun"),
        "a step that never ran is not recorded as run"
    );
    let used: Vec<u64> = updates
        .iter()
        .filter(|update| update["sessionUpdate"] == "usage_update")
        .filter_map(|update| update["used"].as_u64())
        .collect();
    // The sixth request read 1,010 tokens and wrote 5; the six together read 6,060.
    assert_eq!(used, [1_015, 1_213]);
}

/// A reply still paused with no call of the agent's is carried on too: what it said on the way is
/// not the answer, the code that never ran and the search that code made both come out, and the
/// next call tells it why it is carrying on.
#[tokio::test]
async fn a_claude_reply_still_paused_with_no_call_is_carried_on() {
    let folder = Folder::new();
    let mut replies: Vec<Reply> = (1..=5)
        .map(|n| paused_search(&format!("srvtoolu_{n}")))
        .collect();
    let made_by_code = json!({"type": "code_execution_20260120", "tool_id": "srvtoolu_unrun"});
    replies.push(events(
        &[
            vec![message_start(10, 1_000)],
            text_block(0, "Checking one more source.").to_vec(),
            server_tool_block(1, "srvtoolu_unrun", "code_execution", &json!({"code": "await web_search()"}))
                .to_vec(),
            vec![
                json!({"type": "content_block_start", "index": 2, "content_block": {"type": "server_tool_use", "id": "srvtoolu_inner", "name": "web_search", "input": {"query": "RRF"}, "caller": made_by_code}}),
                json!({"type": "content_block_stop", "index": 2}),
            ],
            result_block(
                3,
                "web_search_tool_result",
                "srvtoolu_inner",
                &json!([{"type": "web_search_result", "title": "RRF", "url": "https://example.com/rrf"}]),
            )
            .to_vec(),
            ended("pause_turn", 5).to_vec(),
        ]
        .concat(),
    ));
    replies.push(events(
        &[
            vec![message_start(10, 1_200)],
            text_block(0, "The answer.").to_vec(),
            ended("end_turn", 3).to_vec(),
        ]
        .concat(),
    ));
    let (stand, base) = stand(replies).await;
    let mut session = session_on(
        &folder,
        claude(&base),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        "anthropic:claude-opus-5-5",
    );
    let end = session.prompt("Look it up.").await.unwrap();
    assert_eq!(end.reply, "The answer.");

    let bodies = stand.bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 7);
    let (reply, after) = sent_back(&bodies[6]);
    let sent = serde_json::to_string(&reply).unwrap();
    assert!(!sent.contains("srvtoolu_unrun"), "{sent}");
    assert!(!sent.contains("srvtoolu_inner"), "{sent}");
    assert!(sent.contains("Checking one more source."), "{sent}");
    assert_eq!(after.len(), 1);
    assert!(
        after[0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("paused")),
        "{after:?}"
    );
}

/// A busy Anthropic, before any word, is tried again; a used-up credit is said plainly with where
/// to see it, and never retried.
#[tokio::test]
async fn claude_retries_when_busy_and_says_when_the_credit_is_used_up() {
    let folder = Folder::new();
    let overloaded = events(&[
        message_start(5, 0),
        json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
    ]);
    let fine: Vec<Value> = [
        vec![message_start(5, 0)],
        text_block(0, "Hi.").to_vec(),
        ended("end_turn", 2).to_vec(),
    ]
    .concat();
    let (busy, base) = stand(vec![overloaded, events(&fine)]).await;
    let mut session = session_on(
        &folder,
        claude(&base),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        "anthropic:claude-opus-5-5",
    );
    assert_eq!(session.prompt("Hi").await.unwrap().reply, "Hi.");
    assert_eq!(busy.bodies.lock().unwrap().len(), 2);

    let (refusing, base) = stand(vec![Reply {
        status: StatusCode::BAD_REQUEST,
        body: json!({"type": "error", "error": {"type": "invalid_request_error",
            "message": "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}})
        .to_string(),
        delay: Duration::ZERO,
    }])
    .await;
    let mut broke = session_on(
        &folder,
        claude(&base),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        "anthropic:claude-opus-5-5",
    );
    let said = broke.prompt("Hi").await.unwrap_err();
    assert!(matches!(said, AgentError::OutOfCredits(Source::Anthropic)));
    let problem = said.problem().unwrap();
    assert_eq!(
        problem.url,
        Some("https://platform.claude.com/settings/billing")
    );
    assert!(said.to_string().contains("Claude API credit"));
    assert_eq!(refusing.bodies.lock().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------------------------
// A stand-in for the Responses API, as a ChatGPT plan answers it (ADR 0073)
// ---------------------------------------------------------------------------------------------

/// Hands out a fixed token, and counts how often it was asked for a new one.
#[derive(Debug, Default)]
struct FixedToken {
    renewed: std::sync::atomic::AtomicUsize,
}

impl PlanAccess for FixedToken {
    fn token(&self, renew: bool) -> BoxFuture<'_, Result<String, AgentError>> {
        if renew {
            self.renewed
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Box::pin(async { Ok("at_plan".to_owned()) })
    }
}

fn plan(base: &str, access: Arc<FixedToken>) -> Provider {
    let openai = base.strip_suffix("/api/v1").unwrap_or(base);
    Provider::ChatGpt(Arc::new(
        ChatGptPlan::new(access, openai, Vec::new())
            .unwrap()
            .with_backoff(Duration::from_millis(5)),
    ))
}

fn item_done(item: &Value) -> Value {
    json!({"type": "response.output_item.done", "item": item})
}

fn completed(input: u64, cached: u64, output: u64) -> Value {
    json!({"type": "response.completed", "response": {"output": [], "usage": {
        "input_tokens": input, "input_tokens_details": {"cached_tokens": cached, "cache_write_tokens": 0},
        "output_tokens": output, "output_tokens_details": {"reasoning_tokens": 2}, "total_tokens": input + output}}})
}

/// A turn on the plan: the items put together from `output_item.done` (the completed event carries
/// none), the plan's own items sent back as they came with the tool's output, the cost the plan's
/// and never dollars, and no system message anywhere.
#[tokio::test]
async fn a_chatgpt_plan_turn_sends_its_own_items_back_and_costs_no_dollars() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("notes.md"), "hello").unwrap();
    let reasoning =
        json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "enc-1", "summary": []});
    let call = json!({"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file",
                      "namespace": "loomwatch", "arguments": "{\"path\":\"notes.md\"}", "status": "completed"});
    let first = events(&[
        json!({"type": "response.created", "response": {"id": "resp_1"}}),
        json!({"type": "response.output_item.added", "item": {"type": "reasoning"}}),
        item_done(&reasoning),
        json!({"type": "response.function_call_arguments.delta", "delta": "{\"path\""}),
        item_done(&call),
        completed(100, 80, 14),
    ]);
    let answer = json!({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": "It says hello.", "annotations": []}]});
    let second = events(&[
        json!({"type": "response.output_item.added", "item": {"type": "message"}}),
        json!({"type": "response.output_text.delta", "delta": "It says hello."}),
        item_done(&answer),
        completed(140, 100, 5),
    ]);
    let (stand, base) = stand(vec![first, second]).await;
    let sink = Arc::new(Recorded::default());
    let mut session = session_on(
        &folder,
        plan(&base, Arc::new(FixedToken::default())),
        sink,
        Arc::new(AllowAll),
        "chatgpt:gpt-6.1-sol",
    );
    let end = session.prompt("What does notes.md say?").await.unwrap();
    assert_eq!(end.reply, "It says hello.");
    assert_eq!(end.usage.paid_by, Some(Source::ChatGpt));
    assert!(end.usage.cost_usd.abs() < 1e-12);
    assert_eq!(end.usage.cached_read_tokens, 180);
    assert_eq!(end.usage.input_tokens, 20 + 40);
    assert_eq!(end.as_result()["_meta"]["loomwatch"]["paidBy"], "chatgpt");

    let bodies = stand.bodies.lock().unwrap().clone();
    assert_eq!(bodies[0]["model"], "gpt-6.1-sol");
    assert_eq!(bodies[0]["store"], false);
    assert!(
        bodies[0]["instructions"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
    );
    for body in &bodies {
        assert!(
            body["input"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["role"] != "system")
        );
    }
    let input = bodies[1]["input"].as_array().unwrap();
    assert_eq!(input[1], reasoning);
    assert_eq!(input[2], call);
    assert_eq!(input[3]["type"], "function_call_output");
    assert_eq!(input[3]["call_id"], "call_1");
    assert!(
        stand
            .auth
            .lock()
            .unwrap()
            .iter()
            .all(|auth| auth == "Bearer at_plan")
    );
}

/// A plan's limit stops the turn with where to manage it, even after the model began, and is
/// never tried again; a refused token is renewed once and the call made again.
#[tokio::test]
async fn a_plans_limit_stops_the_turn_and_a_refused_token_is_renewed() {
    let folder = Folder::new();
    let limit = events(&[
        json!({"type": "response.output_item.added", "item": {"type": "message"}}),
        json!({"type": "response.output_text.delta", "delta": "Start"}),
        json!({"type": "response.failed", "response": {"error": {
            "code": "subscription_sharing_usage_limit_exceeded", "message": "Usage limit reached"}}}),
    ]);
    let (limited, base) = stand(vec![limit]).await;
    let mut session = session_on(
        &folder,
        plan(&base, Arc::new(FixedToken::default())),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        "chatgpt:gpt-6.1-sol",
    );
    let said = session.prompt("Hi").await.unwrap_err();
    assert!(matches!(said, AgentError::PlanLimit));
    assert_eq!(
        said.problem().unwrap().url,
        Some(crate::agent::CHATGPT_USAGE_URL)
    );
    assert_eq!(limited.bodies.lock().unwrap().len(), 1);

    let fine = events(&[
        json!({"type": "response.output_text.delta", "delta": "Hi."}),
        item_done(
            &json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hi."}]}),
        ),
        completed(5, 0, 2),
    ]);
    let (renewing, base) = stand(vec![
        Reply {
            status: StatusCode::UNAUTHORIZED,
            body: json!({"error": {"code": "token_expired", "message": "expired"}}).to_string(),
            delay: Duration::ZERO,
        },
        fine,
    ])
    .await;
    let access = Arc::new(FixedToken::default());
    let mut session = session_on(
        &folder,
        plan(&base, access.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        "chatgpt:gpt-6.1-sol",
    );
    assert_eq!(session.prompt("Hi").await.unwrap().reply, "Hi.");
    assert_eq!(access.renewed.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert_eq!(renewing.bodies.lock().unwrap().len(), 2);
}

/// The tool results the second call carried: each one's words and pictures.
async fn reads_of_two_pictures(
    sees_pictures: bool,
    max_pictures: usize,
    max_picture_bytes: usize,
) -> Vec<(String, usize)> {
    let folder = Folder::new();
    std::fs::write(
        folder.0.join("shot.png"),
        crate::test_support::png(40, 20, false),
    )
    .unwrap();
    std::fs::write(
        folder.0.join("chart.png"),
        crate::test_support::png(30, 30, false),
    )
    .unwrap();
    let demo = Demo::scripted(vec![
        Completion::calls(
            "",
            vec![
                call("a", "read_file", &json!({"path": "shot.png"})),
                call("b", "read_file", &json!({"path": "chart.png"})),
            ],
        ),
        Completion::text("Seen."),
    ]);
    let mut config = SessionConfig::new(
        "session-1",
        "writer",
        folder.0.clone(),
        "anthropic/claude-haiku-5.5",
    );
    config.sees_pictures = sees_pictures;
    config.max_pictures = max_pictures;
    config.max_picture_bytes = max_picture_bytes;
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    session.prompt("Look at both.").await.unwrap();
    demo.requests()[1]
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::Tool {
                content, pictures, ..
            } => Some((content.clone(), pictures.len())),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_picture_reaches_a_model_that_sees_pictures_in_the_tools_result() {
    let reads = reads_of_two_pictures(true, MAX_PICTURES, MAX_PICTURE_BYTES).await;
    assert_eq!(
        reads,
        [
            ("shot.png: a picture, 40×20 pixels.".to_owned(), 1),
            ("chart.png: a picture, 30×30 pixels.".to_owned(), 1),
        ]
    );
}

#[tokio::test]
async fn a_model_that_cant_see_pictures_is_told_so_and_sent_none() {
    let reads = reads_of_two_pictures(false, MAX_PICTURES, MAX_PICTURE_BYTES).await;
    assert!(reads.iter().all(|(content, pictures)| {
        *pictures == 0 && content.contains("The model you run on can't see pictures")
    }));
}

#[tokio::test]
async fn a_conversation_holds_no_more_pictures_than_its_limit() {
    let reads = reads_of_two_pictures(true, 1, MAX_PICTURE_BYTES).await;
    assert_eq!(reads[0].1, 1);
    assert_eq!(reads[1].1, 0);
    assert!(
        reads[1].0.contains("already holds as many pictures"),
        "{}",
        reads[1].0
    );
}

/// Every call sends the whole conversation, so the pictures it holds are kept under what a
/// provider takes in one request.
#[tokio::test]
async fn a_conversation_holds_no_more_picture_data_than_its_limit() {
    // Room for either picture alone, not for both: the second fits only while the first isn't
    // counted.
    let size = |picture: Vec<u8>| {
        base64::engine::general_purpose::STANDARD
            .encode(picture)
            .len()
    };
    let both = size(crate::test_support::png(40, 20, false))
        + size(crate::test_support::png(30, 30, false));
    let reads = reads_of_two_pictures(true, MAX_PICTURES, both - 1).await;
    assert_eq!(reads[0].1, 1);
    assert_eq!(reads[1].1, 0);
    assert!(
        reads[1].0.contains("leave no room for one this large"),
        "{}",
        reads[1].0
    );
}

/// The pictures the first call's message carried when two were sent with the prompt.
async fn sent_with_the_prompt(sees_pictures: bool, max_pictures: usize) -> Vec<String> {
    let folder = Folder::new();
    let shot = folder.0.join("shot.png");
    let chart = folder.0.join("chart.png");
    std::fs::write(&shot, crate::test_support::png(40, 20, false)).unwrap();
    std::fs::write(&chart, crate::test_support::png(30, 30, false)).unwrap();
    let demo = Demo::scripted(vec![Completion::text("Seen.")]);
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.sees_pictures = sees_pictures;
    config.max_pictures = max_pictures;
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    // One that can't be read is left out; the words still name it.
    let gone = folder.0.join("gone.png");
    session
        .prompt_showing("What is wrong here?", &[shot, gone, chart])
        .await
        .unwrap();
    demo.requests()[0]
        .messages
        .iter()
        .find_map(|message| match message {
            Message::User { content, pictures } if content.starts_with("What is wrong here?") => {
                Some(
                    pictures
                        .iter()
                        .map(|picture| picture.name.clone())
                        .collect(),
                )
            }
            _ => None,
        })
        .unwrap()
}

/// Pictures sent with the words count against the conversation's room as an opened one does: a
/// second turn past the limit is shown none (ADR 0082).
#[tokio::test]
async fn pictures_sent_earlier_count_against_the_room() {
    let folder = Folder::new();
    let named = |name: &str, width| {
        let path = folder.0.join(name);
        std::fs::write(&path, crate::test_support::png(width, 20, false)).unwrap();
        path
    };
    let (shot, chart, third) = (
        named("shot.png", 40),
        named("chart.png", 30),
        named("third.png", 20),
    );
    let demo = Demo::scripted(vec![
        Completion::text("Seen."),
        Completion::text("Seen again."),
    ]);
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.sees_pictures = true;
    config.max_pictures = 2;
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    session
        .prompt_showing("Look.", &[shot, chart])
        .await
        .unwrap();
    session
        .prompt_showing("And this one.", &[third])
        .await
        .unwrap();
    let last = demo.requests().pop().unwrap();
    let carried = last
        .messages
        .iter()
        .find_map(|message| match message {
            Message::User { content, pictures } if content.starts_with("And this one.") => {
                Some(pictures.len())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(carried, 0);
}

/// ADR 0082: pictures the operator sends go with the words to a model that sees pictures, as
/// many as the conversation has room for, and to no other.
#[tokio::test]
async fn pictures_sent_with_a_prompt_go_with_its_words() {
    assert_eq!(
        sent_with_the_prompt(true, MAX_PICTURES).await,
        ["shot.png", "chart.png"]
    );
    assert!(sent_with_the_prompt(false, MAX_PICTURES).await.is_empty());
    assert_eq!(sent_with_the_prompt(true, 1).await, ["shot.png"]);
}

/// A session kept before tool results could hold pictures reads back the same, and one without
/// pictures is written as it always was.
#[test]
fn a_tool_result_without_pictures_is_stored_as_before() {
    let before = json!({"role": "tool", "tool_call_id": "a", "content": "x"});
    let message: Message = serde_json::from_value(before.clone()).unwrap();
    assert!(matches!(&message, Message::Tool { pictures, .. } if pictures.is_empty()));
    assert_eq!(serde_json::to_value(&message).unwrap(), before);
}

/// The pictures among a message's reads: the reads beside them still run together, the results go
/// back in the order the model asked, and the pictures count against the conversation's room in
/// that order, though none of them is in the conversation until every call of the message is done.
#[tokio::test]
async fn pictures_among_reads_keep_their_place_and_their_limit() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("a.md"), "Notes A").unwrap();
    std::fs::write(folder.0.join("b.md"), "Notes B").unwrap();
    std::fs::write(
        folder.0.join("shot.png"),
        crate::test_support::png(40, 20, false),
    )
    .unwrap();
    std::fs::write(
        folder.0.join("chart.png"),
        crate::test_support::png(30, 30, false),
    )
    .unwrap();
    let demo = Demo::scripted(vec![
        reads(&["a.md", "shot.png", "b.md", "chart.png"]),
        Completion::text("Seen."),
    ]);
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.sees_pictures = true;
    config.max_pictures = 1;
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    session.prompt("Look at everything.").await.unwrap();
    let results: Vec<(String, String, usize)> = demo.requests()[1]
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::Tool {
                tool_call_id,
                content,
                pictures,
            } => Some((tool_call_id.clone(), content.clone(), pictures.len())),
            _ => None,
        })
        .collect();
    let ids: Vec<&str> = results.iter().map(|(id, ..)| id.as_str()).collect();
    assert_eq!(ids, ["a.md", "shot.png", "b.md", "chart.png"]);
    assert!(results[0].1.contains("Notes A") && results[2].1.contains("Notes B"));
    assert_eq!(results[1].2, 1, "{}", results[1].1);
    assert_eq!(results[3].2, 0);
    assert!(
        results[3].1.contains("already holds as many pictures"),
        "{}",
        results[3].1
    );
}

/// A conversation refused as too long gives up the pictures in the results it cuts down: they are
/// the largest part of it, and can be opened again.
#[tokio::test]
async fn a_conversation_refused_as_too_long_takes_its_pictures_out() {
    const LIMIT: usize = 60_000;
    let folder = Folder::new();
    std::fs::write(
        folder.0.join("shot.png"),
        crate::test_support::png(40, 20, false),
    )
    .unwrap();
    let texts = ["a", "b", "c", "d"];
    for name in texts {
        twenty_k_file(&folder, name);
    }
    let demo = Demo::limited(
        vec![
            reads(&["shot.png", "a", "b", "c", "d"]),
            Completion::text("Summary: looked at shot.png and read four files."),
            Completion::text("Finished."),
        ],
        |request| sent(request) > LIMIT,
    );
    let mut config = SessionConfig::new("s", "writer", folder.0.clone(), "m");
    config.sees_pictures = true;
    let mut session = Session::open(
        config,
        Provider::Demo(demo.clone()),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    let end = session
        .prompt("Look at the shot and read the files.")
        .await
        .unwrap();
    assert_eq!(end.reply, "Finished.");

    let requests = demo.requests();
    assert_eq!(requests.len(), 4, "work, refused, summary, work");
    let pictures = |request: &SeenRequest| {
        request
            .messages
            .iter()
            .map(|message| match message {
                Message::Tool { pictures, .. } => pictures.len(),
                _ => 0,
            })
            .sum::<usize>()
    };
    assert_eq!(
        pictures(&requests[1]),
        1,
        "the refused call held the picture"
    );
    let summary = &requests[2];
    assert!(summary.prompt().contains("Write a summary"));
    assert_eq!(pictures(summary), 0);
    let shot = result_of(summary, "shot.png");
    assert!(
        shot.contains("Taken out to make room") && shot.contains("Open it again with read_file"),
        "{shot}"
    );
    assert_eq!(requests[3].messages.len(), 2);
}

// ---------------------------------------------------------------------------------------------
// Words around a search the provider ran itself
// ---------------------------------------------------------------------------------------------

/// What the run's record makes of a turn, through the recorder the engine uses.
struct OnRecord {
    /// Each archived message chunk: its message's id and its words.
    messages: Vec<(String, String)>,
    /// The messages marked as said on the way, in order.
    marked: Vec<String>,
    /// Everything said.
    said: String,
    reply: String,
}

async fn as_recorded(sink: &Recorded) -> OnRecord {
    let archive = crate::archive::EventArchive::new(crate::db::Db::temp().await);
    let mut recorder = crate::engine::Recorder::with_log(
        crate::engine::EventLog::new(archive.clone(), "session-1".to_owned()),
        "session-1".to_owned(),
        "writer",
    );
    for update in sink.all() {
        let frame = json!({"jsonrpc": "2.0", "method": "session/update",
                           "params": {"sessionId": "session-1", "update": update}});
        recorder.record_frame(&frame).await.unwrap();
    }
    let events = archive.load_session("session-1").await.unwrap();
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    OnRecord {
        messages: events
            .iter()
            .filter(|event| event.kind == crate::EventKind::Message)
            .map(|event| {
                (
                    text(&event.payload["messageId"]),
                    text(&event.payload["content"]["text"]),
                )
            })
            .collect(),
        marked: events
            .iter()
            .filter_map(|event| crate::engine::commentary(&event.payload))
            .map(str::to_owned)
            .collect(),
        said: recorder.reply.said().to_owned(),
        reply: recorder.reply.reply(),
    }
}

/// The model's newest message in the conversation, as the next call sends it.
fn last_written(session: &Session) -> String {
    match session.snapshot().history.last() {
        Some(Message::Assistant { content, .. }) => content.clone(),
        other => panic!("the model's message should be last: {other:?}"),
    }
}

/// A model that searches the web part way through a message writes on both sides of the search,
/// and the provider sends it all as one message. What it wrote after the search is the reply.
/// What it wrote before was said on the way: the record keeps it as a message of its own, a
/// paragraph apart, marked so. A search with nothing said before it, or nothing after, splits
/// nothing.
#[tokio::test]
async fn words_before_a_search_the_provider_ran_are_said_on_the_way() {
    let folder = Folder::new();
    let answer = "Basic costs 139,000 VND.";
    for (parts, marked) in [
        (["Let me check the prices.", answer], 1),
        ([answer, ""], 0),
        (["", answer], 0),
    ] {
        let demo = Demo::scripted(vec![Completion::searched(&parts)]);
        let sink = Arc::new(Recorded::default());
        let mut session = session(
            &folder,
            Provider::Demo(demo),
            sink.clone(),
            Arc::new(AllowAll),
        );
        let end = session.prompt("What does Basic cost?").await.unwrap();
        assert_eq!(end.reply, answer, "{parts:?}");

        let said = parts
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("\n\n");
        let record = as_recorded(&sink).await;
        assert_eq!(record.reply, answer, "{parts:?}");
        assert_eq!(record.said, said);
        assert_eq!(record.marked.len(), marked, "{parts:?}");
        assert_eq!(last_written(&session), said);
    }
}

/// A turn that searched and then called a tool, and searched again as it answered: the reply is
/// only what it wrote after all of them, and the record keeps every part a paragraph apart. A
/// message that asked for a tool is marked whole: its last part, after its search, too.
#[tokio::test]
async fn a_reply_after_a_tool_and_a_search_is_what_follows_both() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("prices.md"), "Basic: 139,000 VND").unwrap();
    let demo = Demo::scripted(vec![
        Completion {
            tool_calls: vec![call("r", "read_file", &json!({"path": "prices.md"}))],
            finish: Finish::ToolCalls,
            ..Completion::searched(&["Let me look this up.", "I'll read the notes first."])
        },
        Completion::searched(&[
            "Let me check that price is current.",
            "Basic costs 139,000 VND.",
        ]),
    ]);
    let sink = Arc::new(Recorded::default());
    let mut session = session(
        &folder,
        Provider::Demo(demo),
        sink.clone(),
        Arc::new(AllowAll),
    );
    let end = session.prompt("What does Basic cost?").await.unwrap();
    assert_eq!(end.reply, "Basic costs 139,000 VND.");

    let record = as_recorded(&sink).await;
    assert_eq!(record.reply, "Basic costs 139,000 VND.");
    assert_eq!(
        record.said,
        "Let me look this up.\n\nI'll read the notes first.\n\nLet me check that price is \
         current.\n\nBasic costs 139,000 VND."
    );
    assert_eq!(
        record.marked,
        ["session-1-1", "session-1-1.1", "session-1-2"]
    );
}

/// A reply the length limit cut off is carried on, but a search in the rest starts a paragraph of
/// its own: the words before the search are set aside, and the session's reply agrees with the
/// record's.
#[tokio::test]
async fn a_search_in_a_carried_on_reply_starts_its_own_paragraph() {
    let folder = Folder::new();
    let demo = Demo::scripted(vec![
        cut_off("The quick bro"),
        Completion::searched(&["wn fox, let me check.", "It jumps over the lazy dog."]),
    ]);
    let sink = Arc::new(Recorded::default());
    let mut session = session(
        &folder,
        Provider::Demo(demo),
        sink.clone(),
        Arc::new(AllowAll),
    );
    let end = session.prompt("Write the sentence.").await.unwrap();
    let reply = "The quick bro\n\nIt jumps over the lazy dog.";
    assert_eq!(end.reply, reply);
    assert_eq!(as_recorded(&sink).await.reply, reply);
}

fn server_tool_block(index: u64, id: &str, name: &str, input: &Value) -> [Value; 3] {
    [
        json!({"type": "content_block_start", "index": index,
               "content_block": {"type": "server_tool_use", "id": id, "name": name, "input": {}}}),
        json!({"type": "content_block_delta", "index": index,
               "delta": {"type": "input_json_delta", "partial_json": input.to_string()}}),
        json!({"type": "content_block_stop", "index": index}),
    ]
}

fn result_block(index: u64, kind: &str, id: &str, content: &Value) -> [Value; 2] {
    [
        json!({"type": "content_block_start", "index": index,
               "content_block": {"type": kind, "tool_use_id": id, "content": content}}),
        json!({"type": "content_block_stop", "index": index}),
    ]
}

/// The live run of 2026-10-20 on Claude: a search and a page read part way through one message,
/// the answer after them in blocks its citations split. Before, the three ran together with no
/// space ("…sources I plan to cite.Let me verify…"). Now each side of a search is a message of its
/// own, the ones before a search are marked as said on the way as the next begins, the reply is the
/// answer, and the conversation keeps every word a paragraph apart.
#[tokio::test]
async fn claude_words_around_its_own_searches_are_said_on_the_way() {
    let folder = Folder::new();
    let first = "The arXiv skill works. Now let me verify the primary sources I plan to cite.";
    let second = "Let me verify the permissions-freshness claim before citing it.";
    let answer = "# Enterprise RAG for Engineering Leads — Technical Brief\n\nPermissions are \
                  checked at query time.";
    let page = "https://example.com/fresh";
    let stream: Vec<Value> = [
        vec![message_start(50, 0)],
        text_block(0, first).to_vec(),
        server_tool_block(
            1,
            "srvtoolu_1",
            "web_search",
            &json!({"query": "RAG freshness"}),
        )
        .to_vec(),
        result_block(
            2,
            "web_search_tool_result",
            "srvtoolu_1",
            &json!([{"type": "web_search_result", "title": "Fresh", "url": page}]),
        )
        .to_vec(),
        text_block(3, second).to_vec(),
        server_tool_block(4, "srvtoolu_2", "web_fetch", &json!({"url": page})).to_vec(),
        result_block(
            5,
            "web_fetch_tool_result",
            "srvtoolu_2",
            &json!({"type": "web_fetch_result", "url": page}),
        )
        .to_vec(),
        text_block(
            6,
            "# Enterprise RAG for Engineering Leads — Technical Brief\n\n",
        )
        .to_vec(),
        text_block(7, "Permissions are checked at query time").to_vec(),
        text_block(8, ".").to_vec(),
        ended("end_turn", 300).to_vec(),
    ]
    .concat();
    let (_, base) = stand(vec![events(&stream)]).await;
    let sink = Arc::new(Recorded::default());
    let mut session = session_on(
        &folder,
        claude(&base),
        sink.clone(),
        Arc::new(AllowAll),
        "anthropic:claude-opus-5-5",
    );
    let end = session.prompt("Write the brief.").await.unwrap();
    assert_eq!(end.reply, answer);

    let said = format!("{first}\n\n{second}\n\n{answer}");
    let record = as_recorded(&sink).await;
    assert_eq!(record.reply, answer);
    assert_eq!(record.said, said);
    assert_eq!(record.marked, ["session-1-1", "session-1-1.1"]);
    let ids: Vec<&str> = record.messages.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "session-1-1",
            "session-1-1.1",
            "session-1-1.2",
            "session-1-1.2",
            "session-1-1.2"
        ]
    );
    assert_eq!(last_written(&session), said);
    let searches: Vec<String> = sink
        .all()
        .iter()
        .filter(|update| update["sessionUpdate"] == "tool_call")
        .map(|update| update["title"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        searches,
        [
            "Search the web: RAG freshness",
            "Read https://example.com/fresh"
        ]
    );
}

/// The run of 2026-10-21 on Claude Opus 5.5: its web tools ran code, and the pages and searches
/// that code started came with no input. Before, the code was recorded as "Search the web: the
/// web" with nothing it printed, a page it read as "Read a page", and a call whose input came whole
/// in its first event lost it. Now code is code with its output, and each page and search is named
/// by its input, or else by the page its result says it read.
#[tokio::test]
async fn claude_code_pages_and_searches_from_its_web_tools_are_named_by_what_they_were() {
    let folder = Folder::new();
    let (_, base) = stand(vec![events(&claude_web_tools_stream())]).await;
    let sink = Arc::new(Recorded::default());
    let mut session = session_on(
        &folder,
        claude(&base),
        sink.clone(),
        Arc::new(AllowAll),
        "anthropic:claude-opus-5-5",
    );
    session
        .prompt("Explain transformers in recommenders.")
        .await
        .unwrap();
    check_claude_web_tools_record(&sink.all());
}

/// Claude's stream for that run: code it ran, a page read whose input came whole in its first
/// event, one with no input, a search with no input, and what the code printed.
fn claude_web_tools_stream() -> Vec<Value> {
    let code = "import json\nr = await web_fetch({\"url\": \"https://arxiv.org/abs/1706.03762\"})";
    let whole = |index: u64, id: &str, name: &str, input: &Value| {
        [
            json!({"type": "content_block_start", "index": index,
                   "content_block": {"type": "server_tool_use", "id": id, "name": name, "input": input,
                                     "caller": {"type": "code_execution_20260120", "tool_id": "srvtoolu_code"}}}),
            json!({"type": "content_block_stop", "index": index}),
        ]
    };
    [
        vec![message_start(50, 0)],
        server_tool_block(0, "srvtoolu_code", "code_execution", &json!({"code": code})).to_vec(),
        whole(1, "srvtoolu_given", "web_fetch", &json!({"url": "https://arxiv.org/abs/1808.09781"})).to_vec(),
        result_block(
            2,
            "web_fetch_tool_result",
            "srvtoolu_given",
            &json!({"type": "web_fetch_result", "url": "https://arxiv.org/abs/1808.09781"}),
        )
        .to_vec(),
        whole(3, "srvtoolu_bare", "web_fetch", &json!({})).to_vec(),
        result_block(
            4,
            "web_fetch_tool_result",
            "srvtoolu_bare",
            &json!({"type": "web_fetch_result", "url": "https://arxiv.org/abs/1706.03762"}),
        )
        .to_vec(),
        whole(5, "srvtoolu_search", "web_search", &json!({})).to_vec(),
        result_block(
            6,
            "web_search_tool_result",
            "srvtoolu_search",
            &json!([{"type": "web_search_result", "title": "BERT4Rec", "url": "https://arxiv.org/abs/1904.06690"}]),
        )
        .to_vec(),
        result_block(
            7,
            "code_execution_tool_result",
            "srvtoolu_code",
            &json!({"type": "code_execution_result", "stdout": "Attention Is All You Need\n",
                    "stderr": "", "return_code": 0}),
        )
        .to_vec(),
        text_block(8, "Transformers read a history as a sequence.").to_vec(),
        ended("end_turn", 300).to_vec(),
    ]
    .concat()
}

/// What the record of that stream must say: each call named by what it was, the input that came
/// whole kept, and what the code printed.
fn check_claude_web_tools_record(updates: &[Value]) {
    let calls: Vec<(String, String)> = updates
        .iter()
        .filter(|update| update["sessionUpdate"] == "tool_call")
        .map(|update| {
            let text = |key: &str| update[key].as_str().unwrap_or_default().to_owned();
            (text("title"), text("kind"))
        })
        .collect();
    let call = |title: &str, kind: &str| (title.to_owned(), kind.to_owned());
    assert_eq!(
        calls,
        [
            call("Run code: import json", "other"),
            call("Read https://arxiv.org/abs/1808.09781", "fetch"),
            call("Read https://arxiv.org/abs/1706.03762", "fetch"),
            call("Search the web", "fetch"),
        ]
    );
    let output = |id: &str| {
        updates
            .iter()
            .find(|update| {
                update["sessionUpdate"] == "tool_call_update" && update["toolCallId"] == id
            })
            .and_then(|update| update.pointer("/content/0/content/text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    // The page given whole keeps its own input, not only a title its result happens to match.
    let given = updates
        .iter()
        .find(|update| {
            update["sessionUpdate"] == "tool_call" && update["toolCallId"] == "srvtoolu_given"
        })
        .map(|update| update["rawInput"].clone());
    assert_eq!(
        given,
        Some(json!({"url": "https://arxiv.org/abs/1808.09781"}))
    );
    assert_eq!(output("srvtoolu_code"), "Attention Is All You Need");
    assert_eq!(
        output("srvtoolu_search"),
        "BERT4Rec https://arxiv.org/abs/1904.06690"
    );
}

/// The same on a `ChatGPT` plan, whose search is an output item between two messages.
#[tokio::test]
async fn a_chatgpt_plan_search_between_messages_leaves_the_first_out_of_the_reply() {
    let folder = Folder::new();
    let message = |id: &str, text: &str| {
        json!({"type": "message", "id": id, "role": "assistant", "status": "completed",
               "content": [{"type": "output_text", "text": text, "annotations": []}]})
    };
    let search = json!({"type": "web_search_call", "id": "ws_1", "status": "completed",
                        "action": {"type": "search", "query": "Basic plan price"}});
    let stream = events(&[
        json!({"type": "response.output_item.added", "item": {"type": "message"}}),
        json!({"type": "response.output_text.delta", "delta": "Let me check the prices."}),
        item_done(&message("msg_1", "Let me check the prices.")),
        json!({"type": "response.output_item.added", "item": {"type": "web_search_call"}}),
        item_done(&search),
        json!({"type": "response.output_item.added", "item": {"type": "message"}}),
        json!({"type": "response.output_text.delta", "delta": "Basic costs "}),
        json!({"type": "response.output_text.delta", "delta": "139,000 VND."}),
        item_done(&message("msg_2", "Basic costs 139,000 VND.")),
        completed(100, 0, 20),
    ]);
    let (_, base) = stand(vec![stream]).await;
    let sink = Arc::new(Recorded::default());
    let mut session = session_on(
        &folder,
        plan(&base, Arc::new(FixedToken::default())),
        sink.clone(),
        Arc::new(AllowAll),
        "chatgpt:gpt-6.1-sol",
    );
    let end = session.prompt("What does Basic cost?").await.unwrap();
    assert_eq!(end.reply, "Basic costs 139,000 VND.");

    let said = "Let me check the prices.\n\nBasic costs 139,000 VND.";
    let record = as_recorded(&sink).await;
    assert_eq!(record.reply, "Basic costs 139,000 VND.");
    assert_eq!(record.said, said);
    assert_eq!(record.marked, ["session-1-1"]);
    assert_eq!(last_written(&session), said);
}

/// A plan's web search shows what it found only inside the response that ran it, and the Responses
/// API ignores the results in an item sent back. So the search found nothing on the model's next
/// call, after another tool or a later message: a morning brief came back empty. The results go
/// back in after the step's own items, as the output of a `web_results` call, without `OpenAI`'s
/// private citation marks; and the record says what the search found instead of nothing.
#[tokio::test]
async fn a_chatgpt_plan_search_is_still_seen_after_another_tool_call() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("notes.md"), "hello").unwrap();
    let search = json!({"type": "web_search_call", "id": "ws_1", "status": "completed",
        "action": {"type": "search", "query": "OpenAI news", "queries": ["OpenAI news"]},
        "results": [{"type": "text_result", "title": "OpenAI models are coming to Google Cloud",
            "url": "https://openai.com/news/google-cloud/",
            "snippet": "\u{e200}cite\u{e202}turn0news1\u{e201} [wordlim: 100] Published Oct 21, 2026. \u{e200}cite\u{e202}3\u{2020}Read more\u{2020}openai.com\u{e201}"}]});
    let call = json!({"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file",
                      "namespace": "loomwatch", "arguments": "{\"path\":\"notes.md\"}", "status": "completed"});
    let first = events(&[
        json!({"type": "response.output_item.added", "item": {"type": "web_search_call"}}),
        item_done(&search),
        item_done(&call),
        completed(100, 0, 14),
    ]);
    let answer = json!({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": "Google Cloud.", "annotations": []}]});
    let second = events(&[
        json!({"type": "response.output_item.added", "item": {"type": "message"}}),
        json!({"type": "response.output_text.delta", "delta": "Google Cloud."}),
        item_done(&answer),
        completed(140, 100, 5),
    ]);
    let (stand, base) = stand(vec![first, second]).await;
    let sink = Arc::new(Recorded::default());
    let mut config = SessionConfig::new(
        "session-1",
        "writer",
        folder.0.clone(),
        "chatgpt:gpt-6.1-sol",
    );
    config.tools = ToolSet::all(true);
    let mut session = Session::open(
        config,
        plan(&base, Arc::new(FixedToken::default())),
        sink.clone(),
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    );
    let end = session.prompt("What's new at OpenAI?").await.unwrap();
    assert_eq!(end.reply, "Google Cloud.");

    let bodies = stand.bodies.lock().unwrap().clone();
    assert_eq!(
        bodies[0]["include"],
        json!(["reasoning.encrypted_content", "web_search_call.results"])
    );
    let input = bodies[1]["input"].as_array().unwrap();
    assert_eq!(input[1], search);
    assert_eq!(input[2], call);
    let call_id = input[3]["call_id"].clone();
    assert_eq!(
        input[3],
        json!({"type": "function_call", "call_id": call_id, "name": "web_results",
               "namespace": "loomwatch", "arguments": "{}"})
    );
    assert_eq!(
        input[4],
        json!({"type": "function_call_output", "call_id": call_id, "output":
            "What your web searches above found:\n\n\
             Searched the web for: OpenAI news\n\n\
             OpenAI models are coming to Google Cloud\n\
             https://openai.com/news/google-cloud/\n\
             [wordlim: 100] Published Oct 21, 2026. Read more"})
    );
    assert_eq!(input[5]["type"], "function_call_output");
    assert_eq!(input[5]["call_id"], "call_1");

    let found = sink
        .all()
        .iter()
        .find(|update| {
            update["sessionUpdate"] == "tool_call_update" && update["toolCallId"] == "ws_1"
        })
        .and_then(|update| update.pointer("/content/0/content/text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    assert!(
        found.contains("OpenAI models are coming to Google Cloud"),
        "{found}"
    );
}

/// The same on `OpenRouter`'s chat completions, were its own search to arrive as a reasoning entry
/// between the words, the shape its docs give. Not seen live: on 2026-10-20 neither its own search
/// (for GLM) nor Claude's sent any entry there, so nothing splits on that route yet. More of a
/// search already begun is not another search.
#[tokio::test]
async fn openrouter_words_before_its_own_search_are_left_out_of_the_reply() {
    let folder = Folder::new();
    let searching =
        |piece: Value| json!({"choices": [{"index": 0, "delta": {"reasoning_details": [piece]}}]});
    let (_, base) = stand(vec![ok(&[
        json!({"choices": [{"index": 0, "delta": {"role": "assistant", "content": "Let me check the prices."}}]}),
        searching(json!({"type": "reasoning.server_tool_call", "index": 1,
                         "tool_name": "openrouter:web_search", "tool_call_id": "ws_1",
                         "arguments": "{\"query\":\"Basic plan price\"}"})),
        json!({"choices": [{"index": 0, "delta": {"content": "Basic costs "}}]}),
        searching(json!({"type": "reasoning.server_tool_call", "index": 1,
                         "result": "Basic: 139,000 VND"})),
        json!({"choices": [{"index": 0, "delta": {"content": "139,000 VND."}, "finish_reason": "stop"}],
               "usage": {"prompt_tokens": 100, "completion_tokens": 20, "cost": 0.001}}),
    ])])
    .await;
    let sink = Arc::new(Recorded::default());
    let mut session = session_on(
        &folder,
        openrouter(&base),
        sink.clone(),
        Arc::new(AllowAll),
        "z-ai/glm-5.3",
    );
    let end = session.prompt("What does Basic cost?").await.unwrap();
    assert_eq!(end.reply, "Basic costs 139,000 VND.");

    let said = "Let me check the prices.\n\nBasic costs 139,000 VND.";
    let record = as_recorded(&sink).await;
    assert_eq!(record.reply, "Basic costs 139,000 VND.");
    assert_eq!(record.said, said);
    assert_eq!(record.marked, ["session-1-1"]);
    assert_eq!(last_written(&session), said);
}

// ---------------------------------------------------------------------------------------------
// A Claude through `OpenRouter`'s `/messages`
// ---------------------------------------------------------------------------------------------

/// `OpenRouter`'s Anthropic-shaped stream, which ends with chat completions' `[DONE]`.
fn openrouter_events(stream: &[Value]) -> Reply {
    let mut reply = events(stream);
    reply.body.push_str("data: [DONE]\n\n");
    reply
}

fn text_pieces(index: u64, pieces: &[&str]) -> Vec<Value> {
    let mut stream = vec![json!({"type": "content_block_start", "index": index,
                                 "content_block": {"type": "text", "text": "", "citations": []}})];
    stream.extend(pieces.iter().map(|piece| {
        json!({"type": "content_block_delta", "index": index,
               "delta": {"type": "text_delta", "text": piece}})
    }));
    stream.push(json!({"type": "content_block_stop", "index": index}));
    stream
}

/// A session on the stand-in for `OpenRouter`, allowed the web, on `model`.
fn on_openrouter_web(folder: &Folder, base: &str, sink: Arc<Recorded>, model: &str) -> Session {
    let mut config = SessionConfig::new("session-1", "writer", folder.0.clone(), model);
    config.tools = ToolSet::all(true);
    Session::open(
        config,
        openrouter(base),
        sink,
        Arc::new(AllowAll),
        Arc::new(NoHostTools),
    )
}

/// The live run of 2026-10-20 on Claude Haiku 5.5 through `OpenRouter`, where chat completions ran
/// "…the latest stable Rust release.The latest stable…" together. A Claude now goes to
/// `OpenRouter`'s `/messages`, whose stream puts Claude's own search in a block of its own (this is
/// that stream, two of its nine results kept and the signature cut). The words before the search are
/// said on the way and the reply is the answer, its citation part way through left in one piece.
/// The call carries `OpenRouter`'s key, its web tools and its session; the cost is `OpenRouter`'s own
/// figure, not worked out from list prices.
#[tokio::test]
async fn a_claude_on_openrouter_goes_through_messages_and_its_aside_is_left_out_of_the_reply() {
    let folder = Folder::new();
    let id = "srvtoolu_016BQzmDxqo4BKeidQi1s1qk";
    let found = |title: &str, url: &str| {
        json!({"type": "web_search_result", "title": title, "url": url,
               "encrypted_content": "EvcICioIFRgCIiQ0YzBm", "page_age": null})
    };
    let mut stream: Vec<Value> = [
        vec![
            json!({"type": "message_start", "message": {"id": "msg_011CgD1NYAToHGk3NR6Qi41x", "type": "message",
                   "role": "assistant", "content": [], "model": "anthropic/claude-haiku-5.5", "stop_reason": null,
                   "usage": {"input_tokens": 2877, "output_tokens": 2, "cache_creation_input_tokens": 0,
                             "cache_read_input_tokens": 0, "server_tool_use": null},
                   "provider": "Claude Platform on AWS"}}),
        ],
        text_pieces(0, &["I will", " look up the latest st", "able Rust release."]),
        vec![
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "server_tool_use", "id": id, "name": "web_search", "input": {}}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"query\": \"lat"}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "est stable Rust release\"}"}}),
            json!({"type": "content_block_stop", "index": 1}),
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "web_search_tool_result", "tool_use_id": id,
                   "content": [found("Releases · rust-lang/rust · GitHub", "https://github.com/rust-lang/rust/releases"),
                               found("Rust 1.99.1 Released: Three Regressions Fixed", "https://pbxscience.com/rust-1-99-1-released-three-regressions-fixed")],
                   "caller": {"type": "direct"}}}),
            json!({"type": "content_block_stop", "index": 2}),
            json!({"type": "content_block_start", "index": 3, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            json!({"type": "content_block_delta", "index": 3, "delta": {"type": "signature_delta", "signature": "CAQSrAcKEAgTGAI4AUIIdGhp"}}),
            json!({"type": "content_block_stop", "index": 3}),
        ],
        text_pieces(4, &["The latest", " stable Rust release is ", "1.99.1, a point", " release that "]),
    ]
    .concat();
    // The citation and the rest of the answer come in the same block.
    stream.pop();
    stream.extend([
        json!({"type": "content_block_delta", "index": 4, "delta": {"type": "citations_delta", "citation": {
               "type": "web_search_result_location", "url": "https://pbxscience.com/rust-1-99-1-released-three-regressions-fixed",
               "title": "Rust 1.99.1 Released: Three Regressions Fixed",
               "cited_text": "The Rust Release Team published Rust 1.99.1 on October 15, 2026.",
               "encrypted_index": "Eo8BCioIFRgCIiQ0YzBm"}}}),
        json!({"type": "content_block_delta", "index": 4, "delta": {"type": "text_delta", "text": "the Rust Release Team published on October 15, 2026."}}),
        json!({"type": "content_block_stop", "index": 4}),
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null},
               "usage": {"input_tokens": 14543, "output_tokens": 303, "output_tokens_details": {"thinking_tokens": 158},
                         "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                         "server_tool_use": {"web_search_requests": 1, "web_fetch_requests": 0},
                         "cost": 0.011_605_8, "is_byok": false}}),
        json!({"type": "message_stop"}),
    ]);
    let (stand, base) = stand(vec![openrouter_events(&stream)]).await;
    let sink = Arc::new(Recorded::default());
    let mut session = on_openrouter_web(&folder, &base, sink.clone(), "anthropic/claude-haiku-5.5");
    let end = session
        .prompt("What is the latest stable release of Rust?")
        .await
        .unwrap();
    let aside = "I will look up the latest stable Rust release.";
    let answer = "The latest stable Rust release is 1.99.1, a point release that the Rust Release \
                  Team published on October 15, 2026.";
    assert_eq!(end.reply, answer);

    let said = format!("{aside}\n\n{answer}");
    let record = as_recorded(&sink).await;
    assert_eq!(record.reply, answer);
    assert_eq!(record.said, said);
    assert_eq!(record.marked, ["session-1-1"]);
    assert_eq!(last_written(&session), said);
    let searches: Vec<Value> = sink
        .all()
        .into_iter()
        .filter(|update| update["sessionUpdate"] == "tool_call")
        .map(|update| update["title"].clone())
        .collect();
    assert_eq!(searches, ["Search the web: latest stable Rust release"]);

    assert_eq!(*stand.paths.lock().unwrap(), ["/api/v1/messages"]);
    assert_eq!(*stand.auth.lock().unwrap(), [format!("Bearer {KEY}")]);
    let body = stand.bodies.lock().unwrap()[0].clone();
    assert_eq!(body["model"], "anthropic/claude-haiku-5.5");
    assert_eq!(body["session_id"], "session-1");
    assert_eq!(body["cache_control"], json!({"type": "ephemeral"}));
    assert_eq!(body["thinking"]["type"], "adaptive");
    let tools = body["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool| tool["input_schema"].is_object()));
    assert_eq!(
        tools[tools.len() - 2..],
        [
            json!({"type": "openrouter:web_search"}),
            json!({"type": "openrouter:web_fetch", "parameters": {"max_content_tokens": WebLimits::PAGE_TOKENS}}),
        ]
    );
    assert!(body.get("max_tool_calls").is_none());

    assert!((end.usage.cost_usd - 0.011_605_8).abs() < 1e-12);
    assert_eq!(end.usage.paid_by, None);
    assert!(!end.usage.cost_estimated);
    assert_eq!(
        calls_recorded(&sink)[0],
        json!({"kind": "work", "turn": "work", "model": "anthropic/claude-haiku-5.5",
               "inputTokens": 14543, "cachedReadTokens": 0, "cachedWriteTokens": 0,
               "outputTokens": 303, "reasoningTokens": 0, "costUsd": 0.011_605_8,
               "webSearches": 1, "webFetches": 0})
    );
}

/// A Claude's message on `OpenRouter`'s `/messages` goes back exactly as it was written: its
/// signed thinking, a search `OpenRouter` ran itself (which has no result block, its results
/// coming as citations on the words before it after they ended) and its tool call. A summary keeps
/// the tools, as the signed conversation needs.
#[tokio::test]
async fn a_claude_message_on_openrouter_goes_back_as_it_was_written() {
    let folder = Folder::new();
    std::fs::write(folder.0.join("notes.md"), "hello").unwrap();
    let citation = json!({"type": "web_search_result_location", "url": "https://example.com/notes",
                          "title": "Notes", "cited_text": "Notes say hello.", "encrypted_index": "Eo8B"});
    let first: Vec<Value> = [
        vec![
            message_start(40, 0),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Search, then read."}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-1"}}),
            json!({"type": "content_block_stop", "index": 0}),
        ],
        text_pieces(1, &["Let me look that up."]),
        server_tool_block(
            2,
            "call-f873dceb",
            "openrouter:web_search",
            &json!({"query": "notes"}),
        )
        .to_vec(),
        vec![
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "citations_delta", "citation": citation}}),
        ],
        text_pieces(3, &["I'll read the notes too."]),
        vec![
            json!({"type": "content_block_start", "index": 4, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {}}}),
            json!({"type": "content_block_delta", "index": 4, "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"notes.md\"}"}}),
            json!({"type": "content_block_stop", "index": 4}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"},
                   "usage": {"output_tokens": 30, "server_tool_use": {"web_search_requests": 1, "tool_calls_requested": 1, "tool_calls_executed": 1},
                             "cost": 0.002}}),
            json!({"type": "message_stop"}),
        ],
    ]
    .concat();
    let second: Vec<Value> = [
        vec![message_start(60, 40)],
        text_pieces(0, &["It says hello."]),
        vec![
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 5, "cost": 0.001}}),
            json!({"type": "message_stop"}),
        ],
    ]
    .concat();
    let (stand, base) = stand(vec![openrouter_events(&first), openrouter_events(&second)]).await;
    let sink = Arc::new(Recorded::default());
    let mut session = on_openrouter_web(&folder, &base, sink.clone(), "anthropic/claude-opus-5.5");
    let end = session.prompt("What do my notes say?").await.unwrap();
    assert_eq!(end.reply, "It says hello.");
    assert!((end.usage.cost_usd - 0.003).abs() < 1e-12);

    let bodies = stand.bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 2);
    assert_eq!(
        bodies[1]["messages"][1],
        json!({"role": "assistant", "content": [
            {"type": "thinking", "thinking": "Search, then read.", "signature": "sig-1"},
            {"type": "text", "text": "Let me look that up.", "citations": [citation]},
            {"type": "server_tool_use", "id": "call-f873dceb", "name": "openrouter:web_search", "input": {"query": "notes"}},
            {"type": "text", "text": "I'll read the notes too.", "citations": []},
            {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "notes.md"}},
        ]})
    );
    assert_eq!(
        bodies[1]["messages"][2]["content"][0]["tool_use_id"],
        "toolu_1"
    );
    let record = as_recorded(&sink).await;
    assert_eq!(record.reply, "It says hello.");
    assert_eq!(record.marked, ["session-1-1", "session-1-1.1"]);

    assert!(openrouter(&base).keeps_tools_for_summaries("anthropic/claude-opus-5.5"));
    assert!(!openrouter(&base).keeps_tools_for_summaries(CHAT_CLAUDE));
    assert!(!openrouter(&base).keeps_tools_for_summaries("z-ai/glm-5.3"));
}

/// On `/messages` too, the team's web limits reach `OpenRouter`, and a provider that refuses them
/// is asked again without them, and not sent them again.
#[tokio::test]
async fn web_limits_reach_openrouter_messages_and_a_refusal_falls_back_without_them() {
    let folder = Folder::new();
    let refused = Reply {
        status: StatusCode::BAD_REQUEST,
        body: json!({"error": {"code": 400, "message": "max_tool_calls is not supported by this provider"}}).to_string(),
        delay: Duration::ZERO,
    };
    let answer = |text: &str| {
        openrouter_events(
            &[
                vec![message_start(10, 0)],
                text_pieces(0, &[text]),
                ended("end_turn", 3).to_vec(),
            ]
            .concat(),
        )
    };
    let (stand, base) = stand(vec![refused, answer("Found it."), answer("Again.")]).await;
    let provider = openrouter(&base);
    let open = |provider: Provider| {
        let mut config = SessionConfig::new(
            "s",
            "researcher",
            folder.0.clone(),
            "anthropic/claude-sonnet-5.5",
        );
        config.tools = ToolSet::all(true);
        config.web = WebLimits {
            page_tokens: 4_000,
            pages: Some(3),
            searches: Some(2),
            steps: Some(4),
        };
        Session::open(
            config,
            provider,
            Arc::new(Recorded::default()),
            Arc::new(AllowAll),
            Arc::new(NoHostTools),
        )
    };
    assert_eq!(
        open(provider.clone())
            .prompt("Look it up.")
            .await
            .unwrap()
            .reply,
        "Found it."
    );
    assert_eq!(
        open(provider).prompt("Again.").await.unwrap().reply,
        "Again."
    );
    let bodies = stand.bodies.lock().unwrap().clone();
    let web = |body: &Value| -> Vec<Value> {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| {
                tool["type"]
                    .as_str()
                    .is_some_and(|kind| kind.starts_with("openrouter:"))
            })
            .cloned()
            .collect()
    };
    assert_eq!(
        web(&bodies[0]),
        [
            json!({"type": "openrouter:web_search", "parameters": {"max_uses": 2}}),
            json!({"type": "openrouter:web_fetch", "parameters": {"max_uses": 3, "max_content_tokens": 4_000}}),
        ]
    );
    assert_eq!(bodies[0]["max_tool_calls"], 4);
    for body in &bodies[1..] {
        assert_eq!(
            web(body),
            [
                json!({"type": "openrouter:web_search"}),
                json!({"type": "openrouter:web_fetch"})
            ]
        );
        assert!(body.get("max_tool_calls").is_none());
    }
    assert_eq!(*stand.paths.lock().unwrap(), ["/api/v1/messages"; 3]);
}

/// A refusal on `/messages` reads in `OpenRouter`'s terms, the key and credit being `OpenRouter`'s, and
/// a busy model reported in the stream before its first word is tried again.
#[tokio::test]
async fn a_claude_on_openrouter_is_refused_in_openrouters_terms() {
    let folder = Folder::new();
    let error = |status: StatusCode, message: &str| Reply {
        status,
        body: json!({"error": {"code": status.as_u16(), "message": message}}).to_string(),
        delay: Duration::ZERO,
    };
    let busy =
        openrouter_events(&[json!({"error": {"code": 502, "message": "Provider returned error"}})]);
    let answer = openrouter_events(
        &[
            vec![message_start(10, 0)],
            text_pieces(0, &["Hello."]),
            ended("end_turn", 2).to_vec(),
        ]
        .concat(),
    );
    let (stand, base) = stand(vec![
        error(StatusCode::PAYMENT_REQUIRED, "Insufficient credits"),
        busy,
        answer,
    ])
    .await;
    let said = on_openrouter_web(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        "anthropic/claude-haiku-5.5",
    )
    .prompt("Hi")
    .await
    .unwrap_err();
    assert!(
        matches!(said, AgentError::OutOfCredits(Source::OpenRouter)),
        "{said:?}"
    );
    let end = on_openrouter_web(
        &folder,
        &base,
        Arc::new(Recorded::default()),
        "anthropic/claude-haiku-5.5",
    )
    .prompt("Hi")
    .await
    .unwrap();
    assert_eq!(end.reply, "Hello.");
    assert_eq!(*stand.paths.lock().unwrap(), ["/api/v1/messages"; 3]);
}

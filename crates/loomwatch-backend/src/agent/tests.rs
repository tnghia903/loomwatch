//! Whole turns, on the scripted demo and on a stand-in for `OpenRouter`.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Value, json};

use super::*;

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
    let config = SessionConfig::new(
        "session-1",
        "writer",
        folder.0.clone(),
        "anthropic/claude-haiku-5.5",
    );
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
    assert_eq!(
        end.reply,
        "I'll write it.\n\nDone: out/report.md is written."
    );
    assert_eq!(
        std::fs::read_to_string(folder.0.join("out/report.md")).unwrap(),
        "# Report\n"
    );
    assert_eq!(
        sink.kinds(),
        [
            "agent_message_chunk",
            "tool_call",
            "tool_call_update",
            "agent_message_chunk"
        ]
    );
    let started = &sink.all()[1];
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
        Some(Message::Tool { tool_call_id, content }) if tool_call_id == "c1" && content.starts_with("Created")
    ));
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
            Message::User { content } | Message::Assistant { content, .. } => {
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
        .filter(|message| matches!(message, Message::User { content } if content.contains("\n\nToday is ")))
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
    let Message::User { content } = &after[1] else {
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
    let Message::User { content } = &requests[3].messages[1] else {
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
}

async fn chat(State(stand): State<Stand>, headers: HeaderMap, body: String) -> Response {
    stand
        .bodies
        .lock()
        .unwrap()
        .push(serde_json::from_str(&body).unwrap_or(Value::Null));
    stand.auth.lock().unwrap().push(
        headers
            .get(header::AUTHORIZATION)
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
    let mut session = session(&folder, openrouter(&base), sink.clone(), Arc::new(AllowAll));
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
    let mut refused = session(
        &folder,
        openrouter(&base),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    let said = refused.prompt("Hi").await.unwrap_err();
    assert!(matches!(said, AgentError::KeyRefused));
    assert!(said.to_string().contains("Connections page"));

    let (_, base) = stand(vec![error(
        StatusCode::PAYMENT_REQUIRED,
        "Insufficient credits",
    )])
    .await;
    let mut broke = session(
        &folder,
        openrouter(&base),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    assert!(matches!(
        broke.prompt("Hi").await.unwrap_err(),
        AgentError::OutOfCredits
    ));

    let (stand, base) = stand(vec![
        error(StatusCode::TOO_MANY_REQUESTS, "slow down"),
        error(StatusCode::BAD_GATEWAY, "upstream"),
        ok(&[json!({"choices": [{"index": 0, "delta": {"content": "Hello."}, "finish_reason": "stop"}]})]),
    ])
    .await;
    let mut busy = session(
        &folder,
        openrouter(&base),
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
    let mut busy = session(
        &folder,
        openrouter(&base),
        Arc::new(Recorded::default()),
        Arc::new(AllowAll),
    );
    assert_eq!(busy.prompt("Hi").await.unwrap().reply, "Hello.");
    assert_eq!(first.bodies.lock().unwrap().len(), 2);

    // Busy on every try: it gives up after the same four tries as any busy answer.
    let (always, base) = stand((0..6).map(|_| overloaded()).collect()).await;
    let mut gone = session(
        &folder,
        openrouter(&base),
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
    let mut midway = session(
        &folder,
        openrouter(&base),
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
    let mut session = session(
        &folder,
        openrouter(&base),
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
            Message::User { content } => Some(content.as_str()),
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
    let Message::User { content } = &after[1] else {
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
    let mut session = session(&folder, openrouter(&base), sink.clone(), Arc::new(AllowAll));
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
        json!({"kind": "work", "turn": "work", "model": "anthropic/claude-haiku-5.5",
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

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
        Self(path.canonicalize().unwrap())
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
        folder.0.join("out/report.md").to_string_lossy().as_ref()
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
                Some(content.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(said, ["One", "First answer.", "Two"]);
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
    // The summary was asked for without tools, then the work carried on from it.
    assert!(requests[1].tools.is_empty());
    let after = &requests[2].messages;
    assert_eq!(after.len(), 2);
    let Message::User { content } = &after[1] else {
        panic!("the summary should stand in for the conversation");
    };
    assert!(content.contains("Summary: listed the folder.") && content.contains("The task."));
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

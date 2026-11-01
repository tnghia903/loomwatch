//! Messages the person asks an agent for at a time (ADR 0108): reading the time, keeping and
//! cancelling them, the agent's tools in its own chat and nowhere else, and its turn when the
//! time comes.

use axum::body::Body;
use axum::http::{Request, header};
use chrono::FixedOffset;
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;
use crate::agent::{Completion, Demo, Message, ToolCall};
use crate::runs::tests::TeamsDir;
use crate::runs::{RunRecord, RunStatus, RunStore};

/// Sunday 1 November 2026, 16:55 in Ho Chi Minh City (UTC+7).
fn five_to_five() -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339("2026-11-01T16:55:00+07:00").unwrap()
}

fn utc(at: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(at)
        .unwrap()
        .with_timezone(&Utc)
}

#[test]
fn a_time_is_read_in_this_computers_zone_and_the_next_one_that_comes() {
    let now = five_to_five();
    let at = |at: &str| when(Some(at), None, &now);
    assert_eq!(at("17:20"), Ok(utc("2026-11-01T10:20:00Z")), "later today");
    assert_eq!(
        at("16:00"),
        Ok(utc("2026-11-02T09:00:00Z")),
        "a time already gone by today is tomorrow's"
    );
    assert_eq!(at("2026-11-02 08:00"), Ok(utc("2026-11-02T01:00:00Z")));
    assert_eq!(
        at("2026-11-02T08:00:00+09:00"),
        Ok(utc("2026-11-01T23:00:00Z")),
        "a time with its own offset is that time"
    );
    assert_eq!(when(None, Some(25), &now), Ok(utc("2026-11-01T10:20:00Z")));

    let refused = |result: Result<DateTime<Utc>, String>| result.unwrap_err();
    assert!(refused(at("2026-11-01 16:00")).contains("gone by"));
    assert!(refused(at("5pm")).contains("isn't a time"));
    assert!(refused(when(Some("17:20"), Some(5), &now)).contains("either"));
    assert!(refused(when(None, None, &now)).contains("either"));
    assert!(refused(when(None, Some(0), &now)).contains("at least 1"));
    assert!(refused(at("2027-12-25 08:00")).contains("400 days"));
}

#[test]
fn a_time_is_said_as_the_person_reads_it() {
    let now = five_to_five();
    let from = now.with_timezone(&Utc);
    assert_eq!(
        in_words(utc("2026-11-01T10:20:00Z"), &now),
        "today at 17:20 (UTC+07:00)"
    );
    assert_eq!(
        in_words(utc("2026-11-02T01:00:00Z"), &now),
        "tomorrow at 08:00 (UTC+07:00)"
    );
    assert_eq!(
        in_words(utc("2026-11-03T01:00:00Z"), &now),
        "Tuesday 3 November 2026 at 08:00 (UTC+07:00)"
    );
    let after = |minutes: i64| how_long(from, from + chrono::Duration::minutes(minutes));
    assert_eq!(after(25), "in 25 minutes");
    assert_eq!(after(60), "in 1 hour");
    assert_eq!(after(61), "in 1 hour 1 minute");
    assert_eq!(after(2 * 24 * 60 + 3 * 60 + 5), "in 2 days 3 hours");
    assert_eq!(
        how_long(from, from + chrono::Duration::seconds(30)),
        "in 1 minute"
    );
}

#[test]
fn a_message_that_comes_late_says_so() {
    let now = Utc::now();
    let message = |at: DateTime<Utc>| Waiting {
        id: "m1".to_owned(),
        chat_path: ".jobs/.bench/maya.yaml".to_owned(),
        agent: "maya".to_owned(),
        at: deadline::stamp(at),
        text: "stand up".to_owned(),
        set_at: deadline::stamp(at - chrono::Duration::minutes(30)),
    };
    let on_time = task(&message(now), now);
    assert!(
        on_time.starts_with("stand up\n\n(From LoomWatch"),
        "{on_time}"
    );
    assert!(!on_time.contains("It was due"), "{on_time}");
    let late = task(&message(now - chrono::Duration::minutes(40)), now);
    assert!(late.contains("It was due"), "{late}");
}

#[tokio::test]
async fn messages_are_kept_listed_by_chat_and_cancelled_once() {
    let store = Store::new(Db::temp().await);
    let soon = Utc::now() + chrono::Duration::hours(1);
    let maya = ".jobs/.bench/maya.yaml";
    let coby = ".jobs/.bench/coby.yaml";
    let first = store
        .set(maya, "maya", soon, "stand up", None)
        .await
        .unwrap();
    store
        .set(
            maya,
            "maya",
            soon - chrono::Duration::minutes(5),
            "drink water",
            None,
        )
        .await
        .unwrap();
    let other = store
        .set(coby, "coby", soon, "call mum", None)
        .await
        .unwrap();

    let texts = |list: Vec<Waiting>| list.into_iter().map(|m| m.text).collect::<Vec<_>>();
    assert_eq!(
        texts(store.waiting(Some(maya)).await.unwrap()),
        ["drink water", "stand up"],
        "soonest first, this chat's alone"
    );
    assert_eq!(store.waiting(None).await.unwrap().len(), 3);
    assert_eq!(
        store.cancel(&other.id, Some(maya)).await,
        Ok(false),
        "an agent can't cancel another chat's message"
    );
    assert_eq!(store.cancel(&first.id, Some(maya)).await, Ok(true));
    assert_eq!(store.cancel(&first.id, Some(maya)).await, Ok(false));
    assert_eq!(
        texts(store.waiting(None).await.unwrap()),
        ["drink water", "call mum"]
    );
}

#[tokio::test]
async fn a_chat_may_keep_only_so_many_waiting() {
    let store = Store::new(Db::temp().await);
    let soon = Utc::now() + chrono::Duration::hours(1);
    for _ in 0..MAX_WAITING_PER_CHAT {
        store
            .set(".jobs/.bench/maya.yaml", "maya", soon, "again", None)
            .await
            .unwrap();
    }
    let refused = store
        .set(".jobs/.bench/maya.yaml", "maya", soon, "once more", None)
        .await
        .unwrap_err();
    assert!(refused.contains("cancel one first"), "{refused}");
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "localhost")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn the_route_lists_whats_waiting_and_cancels_one() {
    let pool = Db::temp().await;
    let archive = EventArchive::new(pool.clone());
    let store = Store::new(pool);
    let set = store
        .set(
            ".jobs/.bench/maya.yaml",
            "maya",
            Utc::now() + chrono::Duration::hours(1),
            "stand up",
            Some("run-1"),
        )
        .await
        .unwrap();
    let app = router(Some(archive));

    let (status, listed) = call(&app, "GET", "/api/messages-at", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed[0]["id"], json!(set.id));
    assert_eq!(listed[0]["chatPath"], ".jobs/.bench/maya.yaml");
    assert_eq!(listed[0]["agent"], "maya");
    assert_eq!(listed[0]["text"], "stand up");

    let uri = format!("/api/messages-at/{}", set.id);
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", "/api/messages-at", None).await.1,
        json!([])
    );
}

/// What the agent says: asked by the person, it sets a message for `at` (when the tool is
/// offered, or always when `pushy`, as a harness that cached an older list of tools might); after
/// the tool answers it repeats what the tool said; and when the time comes it writes the message.
fn agent(at: fn() -> String, pushy: bool) -> String {
    crate::engine::demo_model(Demo::responder(move |request| {
        if request
            .prompt()
            .contains("You set a message for the person for this time")
        {
            return Some(Completion::text("Time to stand up!"));
        }
        if let Some(Message::Tool { content, .. }) = request.messages.last() {
            return Some(Completion::text(&format!("The tool said: {content}")));
        }
        if !pushy && !request.tools.iter().any(|tool| tool == "message_me_at") {
            return Some(Completion::text("NO MESSAGE_ME_AT"));
        }
        Some(Completion::calls(
            "",
            vec![ToolCall {
                id: "set-1".to_owned(),
                name: "message_me_at".to_owned(),
                arguments: json!({"text": "stand up", "at": at()}).to_string(),
            }],
        ))
    }))
}

/// Two seconds from now, with its offset.
fn in_two_seconds() -> String {
    (Utc::now() + chrono::Duration::seconds(2)).to_rfc3339()
}

struct Rig {
    dir: TeamsDir,
    archive: EventArchive,
    chat: Router,
    registry: RunRegistry,
}

/// A teams folder with Maya's own chat and a team of one, Notes, both on `model`, and another,
/// Pushy, on an agent that calls `message_me_at` whether it is offered or not.
async fn rig(model: &str) -> Rig {
    let pool = Db::temp().await;
    let archive = EventArchive::new(pool.clone());
    let registry = RunRegistry::durable(RunStore::new(pool));
    let dir = TeamsDir::new();
    let jobs = dir.0.join(".jobs");
    std::fs::create_dir_all(jobs.join(".bench")).unwrap();
    std::fs::write(
        jobs.join("maya.yaml"),
        "name: Maya\ninstructions: Help me with my day.\n",
    )
    .unwrap();
    std::fs::write(
        jobs.join(".bench").join("maya.yaml"),
        format!(
            "schemaVersion: 1\nid: bench-maya\nname: Maya · chat\nentrypoint: maya\nagents:\n  - id: maya\n    name: Maya\n    role: Help me with my day.\n    model: {model}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        dir.0.join("notes.yaml"),
        format!(
            "schemaVersion: 1\nid: notes\nname: Notes\nentrypoint: maya\nagents:\n  - id: maya\n    name: Maya\n    role: Keep notes.\n    model: {model}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        dir.0.join("pushy.yaml"),
        format!(
            "schemaVersion: 1\nid: pushy\nname: Pushy\nentrypoint: maya\nagents:\n  - id: maya\n    name: Maya\n    role: Keep notes.\n    model: {}\n",
            agent(in_two_seconds, true)
        ),
    )
    .unwrap();
    Rig {
        chat: crate::chat::router(Some(archive.clone()), dir.0.clone(), registry.clone()),
        archive,
        registry,
        dir,
    }
}

async fn wait_for(registry: &RunRegistry, done: impl Fn(&[RunRecord]) -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !done(&registry.list()) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never got there: {:#?}", registry.list()));
}

/// The person writes to Maya in `team_path`'s chat; her turn ends.
async fn ask_maya(rig: &Rig, team_path: &str) -> RunRecord {
    let (status, sent) = call(
        &rig.chat,
        "POST",
        "/api/chat/messages",
        Some(json!({"teamPath": team_path, "text": "Message me in a moment to stand up", "to": {"kind": "agent", "agent": "maya"}, "work": true})),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{sent}");
    let run_id = sent["run"]["runId"].as_str().unwrap().to_owned();
    wait_for(&rig.registry, |runs| {
        runs.iter()
            .any(|run| run.run_id == run_id && run.status.is_terminal())
    })
    .await;
    rig.registry.get(&run_id).unwrap()
}

#[tokio::test]
async fn an_agent_in_its_own_chat_sets_a_message_and_writes_it_in_the_chat_when_its_time_comes() {
    let rig = rig(&agent(in_two_seconds, false)).await;
    spawn(rig.archive.clone(), rig.dir.0.clone(), rig.registry.clone());

    let set = ask_maya(&rig, ".jobs/.bench/maya.yaml").await;
    assert_eq!(set.status, RunStatus::Succeeded, "{set:?}");
    let said = set.reply.clone().unwrap_or_default();
    assert!(said.contains("\"set\":true"), "{said}");
    assert!(
        said.contains("today at") || said.contains("tomorrow at"),
        "{said}"
    );
    assert!(
        set.message_at.is_none(),
        "the person's own message is not one"
    );

    // At the time, Maya takes a turn of her own in her chat and writes it: a run that starts with
    // the words she set, and keeps the message it is for.
    let for_it = |run: &RunRecord| run.prompt.starts_with("stand up\n\n(From LoomWatch");
    wait_for(&rig.registry, |runs| {
        runs.iter()
            .any(|run| for_it(run) && run.status.is_terminal())
    })
    .await;
    let wrote = rig
        .registry
        .list()
        .into_iter()
        .find(|run| for_it(run))
        .unwrap();
    assert!(wrote.message_at.is_some(), "{wrote:?}");
    assert_eq!(wrote.status, RunStatus::Succeeded, "{wrote:?}");
    assert_eq!(wrote.reply.as_deref(), Some("Time to stand up!"));
    assert_eq!(wrote.only_agent.as_deref(), Some("maya"));
    assert_eq!(wrote.team_path, ".jobs/.bench/maya.yaml");
    let message = wrote.message_at.clone().unwrap();
    assert_eq!(message.text, "stand up");

    // It is sent, once, and kept with its run, which the chat and a restart read back.
    let store = Store::new(rig.archive.db().clone());
    assert_eq!(store.waiting(None).await.unwrap(), []);
    let run_id: Option<String> =
        sqlx::query_scalar("SELECT run_id FROM messages_at WHERE id = $1 AND status = 'sent'")
            .bind(&message.id)
            .fetch_one(rig.archive.db().reader())
            .await
            .unwrap();
    assert_eq!(run_id.as_deref(), Some(wrote.run_id.as_str()));
    let stored = RunStore::new(rig.archive.db().clone())
        .recent()
        .await
        .unwrap()
        .into_iter()
        .find(|stored| stored.record.run_id == wrote.run_id)
        .unwrap();
    assert_eq!(stored.record.message_at, Some(message.clone()));

    // A second start for the same message starts nothing new.
    let again = crate::chat::send_message_at(
        &rig.registry,
        Some(rig.archive.clone()),
        &rig.dir.0,
        ".jobs/.bench/maya.yaml",
        "maya",
        "It is later now.",
        message,
    )
    .await;
    assert_eq!(
        again,
        crate::chat::MessageAtSent::Started(wrote.run_id.clone())
    );
    assert_eq!(
        rig.registry
            .list()
            .iter()
            .filter(|run| run.message_at.is_some())
            .count(),
        1
    );
}

#[tokio::test]
async fn a_message_waits_while_its_agent_is_at_work_in_that_chat() {
    let rig = rig(&agent(in_two_seconds, false)).await;
    let finished = ask_maya(&rig, ".jobs/.bench/maya.yaml").await;
    let mut working = finished.clone();
    working.run_id = Uuid::new_v4().to_string();
    working.status = RunStatus::Running;
    rig.registry.insert(working);
    let sent = crate::chat::send_message_at(
        &rig.registry,
        Some(rig.archive.clone()),
        &rig.dir.0,
        ".jobs/.bench/maya.yaml",
        "maya",
        "It is time.",
        MessageAt {
            id: "m1".to_owned(),
            at: deadline::stamp(Utc::now()),
            text: "stand up".to_owned(),
        },
    )
    .await;
    assert_eq!(sent, crate::chat::MessageAtSent::Busy);
}

#[tokio::test]
async fn only_an_agent_in_its_own_chat_is_offered_the_tools_or_may_call_them() {
    let rig = rig(&agent(in_two_seconds, false)).await;
    let offered = ask_maya(&rig, "notes.yaml").await;
    assert_eq!(offered.reply.as_deref(), Some("NO MESSAGE_ME_AT"));

    // Called anyway: the agent loop refuses a tool it didn't offer before the bus sees it (the
    // bus's own refusal, for a harness that cached an older list, is `team_bus`'s test), and
    // nothing is set.
    let refused = ask_maya(&rig, "pushy.yaml").await;
    let said = refused.reply.unwrap_or_default();
    assert!(
        said.contains("There's no tool called message_me_at"),
        "{said}"
    );
    assert_eq!(
        Store::new(rig.archive.db().clone())
            .waiting(None)
            .await
            .unwrap(),
        []
    );
}

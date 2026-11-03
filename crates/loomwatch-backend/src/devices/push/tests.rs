//! Pushing to a phone: its token and settings at the door, what is news and for whom, and what
//! goes to Apple, against a stand-in for Apple's push service.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{TimeZone as _, Utc};
use p256::ecdsa::SigningKey;
use p256::pkcs8::{EncodePrivateKey as _, LineEnding};
use serde_json::{Value, json};

use super::apns::Apns;
use super::key::{KeyPlace, PushKey};
use super::watch::Watch;
use super::{About, ActivityTarget, Environment, Notice, Push, PushTarget, Quiet, Sender, Sent};
use crate::devices::{Devices, Kind, door_router};

const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn push_key() -> PushKey {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).unwrap();
    let signer = SigningKey::from_bytes(&bytes.into()).unwrap();
    let p8 = signer.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    PushKey::new("ABC123DEFG", "SR7RDMR5Z5", None, &p8).unwrap()
}

fn target() -> PushTarget {
    PushTarget {
        token: TOKEN.to_owned(),
        environment: Environment::Sandbox,
        tell_needs_me: true,
        tell_done: true,
        quiet: None,
        activity: None,
    }
}

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

/// A home screen as `phone::home::home_view` gives it.
fn home(needs: &[Value], done: &[Value]) -> Value {
    json!({ "needsYou": needs, "working": [], "done": done })
}

fn review(run: &str) -> Value {
    json!({
        "kind": "answer",
        "run": { "runId": run, "teamPath": "teams/research.yaml", "teamName": "Research" },
        "waitingOn": { "node": "review", "kind": "review_stop", "question": "Approve?" },
    })
}

fn permission(run: &str, id: &str) -> Value {
    json!({
        "kind": "permission",
        "run": { "runId": run },
        "request": { "id": id, "name": "Writer", "title": "Run ls" },
    })
}

fn finished(run: &str, status: &str) -> Value {
    json!({ "runId": run, "status": status, "teamPath": "teams/research.yaml" })
}

/// The notices among what was sent.
fn notices(sent: &[(String, PushTarget, Push)]) -> Vec<&Notice> {
    sent.iter()
        .filter_map(|(_, _, push)| match push {
            Push::Notice(notice) => Some(notice),
            _ => None,
        })
        .collect()
}

fn targets(sent: &[(String, PushTarget, Push)]) -> Vec<&str> {
    notices(sent)
        .into_iter()
        .map(|notice| notice.target.as_str())
        .collect()
}

#[test]
fn what_was_there_before_isnt_news_and_what_comes_after_is_sent_once() {
    let mut watch = Watch::default();
    let phones = [("phone".to_owned(), target())];
    let now = Utc::now();
    assert!(
        watch
            .next(&home(&[review("r0")], &[]), &phones, now)
            .is_empty()
    );

    let sent = watch.next(
        &home(
            &[review("r0"), review("r1")],
            &[finished("r2", "succeeded")],
        ),
        &phones,
        now,
    );
    assert_eq!(targets(&sent), ["answer-r1-review", "done-r2"]);
    let notice = notices(&sent)[0];
    assert_eq!(
        notice.about,
        About::Waiting {
            permission: false,
            review: true
        }
    );
    assert_eq!(notice.node.as_deref(), Some("review"));
    assert_eq!(notice.room.as_deref(), Some("teams/research.yaml"));
    assert_eq!(notice.waiting, 2);

    assert!(
        watch
            .next(
                &home(
                    &[review("r0"), review("r1")],
                    &[finished("r2", "succeeded")]
                ),
                &phones,
                now
            )
            .is_empty(),
        "said once"
    );
}

#[test]
fn a_cancelled_run_or_one_that_tries_again_isnt_news() {
    let mut watch = Watch::default();
    let phones = [("phone".to_owned(), target())];
    let now = Utc::now();
    watch.next(&home(&[], &[]), &phones, now);
    let mut again = finished("r2", "failed");
    again["nextTryAt"] = json!("2026-11-01T05:00:00Z");
    let sent = watch.next(
        &home(
            &[],
            &[finished("r1", "cancelled"), again, finished("r3", "failed")],
        ),
        &phones,
        now,
    );
    assert_eq!(targets(&sent), ["done-r3"]);
}

#[test]
fn quiet_hours_let_only_a_permission_ring_and_the_rest_comes_after() {
    let mut watch = Watch::default();
    let mut quiet = target();
    // 23:00 to 07:00 in Ho Chi Minh City (UTC+7): 17:00 UTC is midnight there.
    quiet.quiet = Some(Quiet {
        from: 23 * 60,
        to: 7 * 60,
        time_zone: "Asia/Ho_Chi_Minh".to_owned(),
    });
    let phones = [("phone".to_owned(), quiet)];
    let night = Utc.with_ymd_and_hms(2026, 11, 1, 17, 0, 0).unwrap();
    let morning = Utc.with_ymd_and_hms(2026, 11, 2, 1, 0, 0).unwrap();
    watch.next(&home(&[], &[]), &phones, night);

    let now = home(
        &[review("r1"), permission("r2", "p1")],
        &[finished("r3", "succeeded")],
    );
    assert_eq!(
        targets(&watch.next(&now, &phones, night)),
        ["permission-r2-p1"]
    );
    assert_eq!(
        targets(&watch.next(&now, &phones, morning)),
        ["answer-r1-review", "done-r3"]
    );
}

#[test]
fn a_phone_that_wants_no_finished_runs_hears_only_who_waits() {
    let mut watch = Watch::default();
    let mut quiet_about_done = target();
    quiet_about_done.tell_done = false;
    let phones = [("phone".to_owned(), quiet_about_done)];
    watch.next(&home(&[], &[]), &phones, Utc::now());
    let sent = watch.next(
        &home(&[permission("r1", "p1")], &[finished("r2", "succeeded")]),
        &phones,
        Utc::now(),
    );
    assert_eq!(targets(&sent), ["permission-r1-p1"]);
}

/// A message the person asked an agent for at a time (ADR 0108): its run, finished or failed.
fn message_run(run: &str, status: &str) -> Value {
    json!({
        "runId": run,
        "status": status,
        "teamPath": ".jobs/.bench/coby.yaml",
        "messageAt": { "id": "m1", "at": "2026-11-01T10:20:00.000Z", "text": "stand up" },
    })
}

#[test]
fn a_message_the_person_asked_for_rings_in_quiet_hours_and_with_finished_runs_turned_off() {
    let mut watch = Watch::default();
    let mut phone = target();
    phone.tell_done = false;
    // 23:00 to 07:00 in Ho Chi Minh City (UTC+7): 17:00 UTC is midnight there.
    phone.quiet = Some(Quiet {
        from: 23 * 60,
        to: 7 * 60,
        time_zone: "Asia/Ho_Chi_Minh".to_owned(),
    });
    let phones = [("phone".to_owned(), phone)];
    let night = Utc.with_ymd_and_hms(2026, 11, 1, 17, 0, 0).unwrap();
    watch.next(&home(&[], &[]), &phones, night);

    let sent = watch.next(
        &home(
            &[],
            &[
                finished("r1", "succeeded"),
                message_run("r2", "succeeded"),
                message_run("r3", "failed"),
            ],
        ),
        &phones,
        night,
    );
    assert_eq!(targets(&sent), ["done-r2", "done-r3"]);
    assert!(
        notices(&sent)
            .iter()
            .all(|notice| notice.about == About::Message),
        "{sent:?}"
    );
    assert_eq!(
        notices(&sent)[0].payload(),
        json!({
            "aps": {
                "alert": { "title": "LoomWatch", "body": "Your reminder" },
                "mutable-content": 1,
                "content-available": 1,
                "thread-id": "message",
                "badge": 0,
                "sound": "default",
            },
            "target": "done-r2",
            "run": "r2",
            "room": ".jobs/.bench/coby.yaml",
        }),
        "it rings, and carries ids only"
    );
}

#[test]
fn a_phone_that_gives_its_token_later_isnt_told_what_was_already_there() {
    let mut watch = Watch::default();
    let now = Utc::now();
    let first = [("first".to_owned(), target())];
    watch.next(&home(&[], &[]), &first, now);
    let both = [
        ("first".to_owned(), target()),
        ("second".to_owned(), target()),
    ];
    let sent = watch.next(&home(&[review("r1")], &[]), &both, now);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "first");

    watch.undo("first", &sent[0].2);
    let again = watch.next(&home(&[review("r1")], &[]), &both, now);
    assert_eq!(
        targets(&again),
        ["answer-r1-review"],
        "a push that didn't go goes again"
    );
    assert_eq!(again[0].0, "first");
}

#[test]
fn a_push_carries_ids_only_and_falls_back_to_plain_words() {
    let notice = Notice {
        target: "permission-r1-p1".to_owned(),
        about: About::Waiting {
            permission: true,
            review: false,
        },
        run: Some("r1".to_owned()),
        node: None,
        room: None,
        waiting: 3,
    };
    assert_eq!(
        notice.payload(),
        json!({
            "aps": {
                "alert": { "title": "LoomWatch", "body": "Something needs you" },
                "mutable-content": 1,
                "content-available": 1,
                "thread-id": "desk",
                "badge": 3,
                "category": "ask",
                "sound": "default",
            },
            "target": "permission-r1-p1",
            "run": "r1",
        })
    );
    let long = Notice {
        target: "x".repeat(100),
        ..notice
    };
    assert_eq!(long.collapse_id().len(), 64);
}

/// A Live Activity's own token, as `ActivityKit` gives it.
const ACTIVITY: &str =
    "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a59687";

/// Run `run` at work, as the home screen sums it up: `writer` has it.
fn at_work(run: &str) -> Value {
    json!({
        "runId": run, "teamPath": "teams/research.yaml", "teamName": "Research", "status": "running",
        "working": ["writer"], "startedAt": "2026-11-03T10:00:00Z",
    })
}

fn question(run: &str) -> Value {
    json!({
        "kind": "answer",
        "run": at_work(run),
        "waitingOn": { "node": "writer", "agent": "writer", "kind": "question", "question": "Which city?" },
    })
}

fn review_of(run: &str) -> Value {
    json!({
        "kind": "answer",
        "run": at_work(run),
        "waitingOn": { "node": "check", "kind": "review_stop", "handoverFrom": "writer", "question": "Approve?" },
    })
}

fn asks(run: &str, id: &str) -> Value {
    json!({
        "kind": "permission",
        "run": at_work(run),
        "request": { "id": id, "agent": "writer", "name": "Writer", "title": "Run ls" },
    })
}

/// The team reached its spending limit (`spendStops`, answered at `POST /api/runs/{id}/spend`).
fn spend(run: &str, id: &str) -> Value {
    json!({
        "kind": "spend",
        "run": at_work(run),
        "stop": { "id": id, "limitUsd": 1.0, "spentUsd": 1.02, "addUsd": 1.0, "since": "2026-11-03T10:05:00Z" },
    })
}

fn team_request(id: &str) -> Value {
    json!({ "kind": "teamRequest", "teamRequest": { "id": id, "status": "waiting" } })
}

fn home_at(needs: &[Value], working: &[Value], done: &[Value]) -> Value {
    json!({ "needsYou": needs, "working": working, "done": done })
}

fn pushes(sent: &[(String, PushTarget, Push)]) -> Vec<Push> {
    sent.iter().map(|(_, _, push)| push.clone()).collect()
}

#[test]
fn every_kind_of_wait_wakes_the_phone_when_it_starts_and_when_it_is_answered() {
    let now = Utc::now();
    let waits = [
        ("question", question("r1"), "answer-r1-writer"),
        ("review", review_of("r1"), "answer-r1-check"),
        ("permission", asks("r1", "p1"), "permission-r1-p1"),
        ("spend", spend("r1", "s1"), "spend-r1-s1"),
        ("team request", team_request("t1"), "teamRequest-t1"),
    ];
    for (kind, wait, key) in waits {
        let mut watch = Watch::default();
        let phones = [("phone".to_owned(), target())];
        watch.next(&home_at(&[], &[at_work("r1")], &[]), &phones, now);

        let started = watch.next(&home_at(&[wait], &[at_work("r1")], &[]), &phones, now);
        assert_eq!(targets(&started), [key], "{kind}: {started:?}");
        assert_eq!(
            started.len(),
            1,
            "{kind}: the notice says it all: {started:?}"
        );
        let payload = started[0].2.payload(now);
        assert_eq!(
            payload["aps"]["content-available"], 1,
            "{kind}: the notice wakes the app, which brings its widgets and Live Activity in step"
        );
        assert_eq!(payload["aps"]["badge"], 1, "{kind}");

        // Answered on this computer: nothing new to tell, but the phone still shows it.
        let answered = watch.next(&home_at(&[], &[at_work("r1")], &[]), &phones, now);
        assert_eq!(
            pushes(&answered),
            [Push::Changed { waiting: 0 }],
            "{kind}: an answer anywhere reaches the phone"
        );
        assert_eq!(
            answered[0].2.payload(now),
            json!({ "aps": { "badge": 0, "content-available": 1 } }),
            "{kind}: the badge is set at once and the app woken, with no words and no sound"
        );
        assert!(
            watch
                .next(&home_at(&[], &[at_work("r1")], &[]), &phones, now)
                .is_empty(),
            "{kind}: once"
        );
    }
}

#[test]
fn work_that_starts_or_ends_with_no_notice_still_reaches_the_phone() {
    let mut watch = Watch::default();
    let mut phone = target();
    phone.tell_done = false;
    let phones = [("phone".to_owned(), phone)];
    let now = Utc::now();
    watch.next(&home_at(&[], &[], &[]), &phones, now);
    assert_eq!(
        pushes(&watch.next(&home_at(&[], &[at_work("r1")], &[]), &phones, now)),
        [Push::Changed { waiting: 0 }],
        "work started on this computer"
    );
    assert_eq!(
        pushes(&watch.next(
            &home_at(&[], &[], &[finished("r1", "succeeded")]),
            &phones,
            now
        )),
        [Push::Changed { waiting: 0 }],
        "it finished, and the phone wants no notice for that"
    );
}

#[test]
fn a_wait_that_rings_later_or_never_still_brings_the_phone_in_step_now() {
    let night = Utc.with_ymd_and_hms(2026, 11, 1, 17, 0, 0).unwrap();
    let mut quiet = target();
    quiet.quiet = Some(Quiet {
        from: 23 * 60,
        to: 7 * 60,
        time_zone: "Asia/Ho_Chi_Minh".to_owned(),
    });
    let mut untold = target();
    untold.tell_needs_me = false;
    for (why, phone) in [("quiet hours", quiet), ("Tell me off", untold)] {
        let mut watch = Watch::default();
        let phones = [("phone".to_owned(), phone)];
        watch.next(&home_at(&[], &[at_work("r1")], &[]), &phones, night);
        let waiting = home_at(&[spend("r1", "s1")], &[at_work("r1")], &[]);
        assert_eq!(
            pushes(&watch.next(&waiting, &phones, night)),
            [Push::Changed { waiting: 1 }],
            "{why}: silent, but the badge and the app show it"
        );
        assert!(watch.next(&waiting, &phones, night).is_empty(), "{why}");
    }
}

#[test]
fn the_live_activity_follows_its_work_through_every_kind_of_wait_while_the_app_is_closed() {
    let mut watch = Watch::default();
    let mut phone = target();
    phone.activity = Some(ActivityTarget {
        token: ACTIVITY.to_owned(),
        run: "r1".to_owned(),
    });
    let phones = [("phone".to_owned(), phone)];
    let now = Utc::now();
    let working = home_at(&[], &[at_work("r1")], &[]);
    assert!(
        watch.next(&working, &phones, now).is_empty(),
        "the app gave it what it shows when it gave its token"
    );

    let waits = [
        ("question", question("r1"), "answer-r1-writer"),
        ("review", review_of("r1"), "answer-r1-check"),
        ("permission", asks("r1", "p1"), "permission-r1-p1"),
        ("spend", spend("r1", "s1"), "spend-r1-s1"),
    ];
    for (kind, wait, key) in waits {
        let waiting = home_at(&[wait], &[at_work("r1")], &[]);
        assert_eq!(
            targets(&watch.next(&waiting, &phones, now)),
            [key],
            "{kind}: the notice first, so the phone reads its words"
        );
        let sent = watch.next(&waiting, &phones, now);
        let [(_, _, push)] = sent.as_slice() else {
            panic!("{kind}: {sent:?}");
        };
        let Push::Activity {
            state: Some(state),
            end: false,
            urgent: true,
        } = push
        else {
            panic!("{kind}: {push:?}");
        };
        assert_eq!(push.kind(), "liveactivity");
        assert_eq!(push.priority(), 10, "{kind}: shown at once");
        let mut expected = json!({
            "line": "", "state": "waiting", "kind": kind, "agent": "writer", "visit": key,
            "waiting": 1, "startedAt": 815_392_800.0,
        });
        if kind == "review" {
            expected["approval"] = json!({ "run": "r1", "node": "check", "who": "" });
        }
        assert_eq!(
            *state, expected,
            "{kind}: ids only; the phone says it in its own words"
        );
        assert!(
            watch.next(&waiting, &phones, now).is_empty(),
            "{kind}: once"
        );

        let answered = watch.next(&working, &phones, now);
        assert_eq!(
            pushes(&answered),
            [
                Push::Changed { waiting: 0 },
                Push::Activity {
                    state: Some(json!({
                        "line": "", "state": "working", "agent": "writer", "startedAt": 815_392_800.0,
                    })),
                    end: false,
                    urgent: false,
                },
            ],
            "{kind}: answered on this computer, it works again"
        );
        assert_eq!(answered[1].2.priority(), 5, "{kind}: no hurry");
    }

    let over = watch.next(
        &home_at(&[], &[], &[finished("r1", "succeeded")]),
        &phones,
        now,
    );
    assert_eq!(targets(&over), ["done-r1"]);
    let [_, (_, _, end)] = over.as_slice() else {
        panic!("{over:?}");
    };
    let payload = end.payload(now);
    assert_eq!(payload["aps"]["event"], "end", "{payload}");
    assert_eq!(payload["aps"]["timestamp"], now.timestamp());
    assert_eq!(
        payload["aps"]["dismissal-date"],
        now.timestamp(),
        "gone from the Lock Screen at once"
    );
    assert_eq!(payload["aps"]["content-state"]["state"], "working");
    assert!(
        watch
            .next(
                &home_at(&[], &[], &[finished("r1", "succeeded")]),
                &phones,
                now
            )
            .is_empty(),
        "ended once"
    );
}

#[test]
fn a_live_activity_whose_work_is_already_over_ends_at_once() {
    let mut watch = Watch::default();
    let mut phone = target();
    phone.activity = Some(ActivityTarget {
        token: ACTIVITY.to_owned(),
        run: "r1".to_owned(),
    });
    let phones = [("phone".to_owned(), phone)];
    let sent = watch.next(
        &home_at(&[], &[], &[finished("r1", "succeeded")]),
        &phones,
        Utc::now(),
    );
    assert_eq!(
        pushes(&sent),
        [Push::Activity {
            state: None,
            end: true,
            urgent: false
        }]
    );
    watch.undo("phone", &sent[0].2);
    assert_eq!(
        watch
            .next(
                &home_at(&[], &[], &[finished("r1", "succeeded")]),
                &phones,
                Utc::now()
            )
            .len(),
        1,
        "an end that didn't go goes again"
    );
}

#[tokio::test]
async fn a_live_activitys_push_goes_to_its_own_token_and_a_change_to_the_apps() {
    let seen: Seen = Arc::default();
    let apns = Apns::at(push_key(), &apple(seen.clone()).await);
    let mut phone = target();
    phone.activity = Some(ActivityTarget {
        token: ACTIVITY.to_owned(),
        run: "r1".to_owned(),
    });
    let update = Push::Activity {
        state: Some(json!({ "line": "", "state": "working", "startedAt": 0.0 })),
        end: false,
        urgent: false,
    };
    assert_eq!(apns.send(&phone, &update).await, Sent::Done);
    assert_eq!(
        apns.send(&phone, &Push::Changed { waiting: 2 }).await,
        Sent::Done
    );
    assert!(
        matches!(apns.send(&target(), &update).await, Sent::Failed(_)),
        "no Live Activity, no push"
    );

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0]["token"], ACTIVITY);
    assert_eq!(seen[0]["topic"], "loomwatch.phone.push-type.liveactivity");
    assert_eq!(seen[0]["type"], "liveactivity");
    assert_eq!(seen[0]["priority"], "5");
    assert_eq!(seen[0]["collapse"], Value::Null);
    assert_eq!(seen[0]["body"]["aps"]["event"], "update");
    assert_eq!(seen[0]["body"]["aps"]["content-state"]["state"], "working");
    assert_eq!(seen[1]["token"], TOKEN);
    assert_eq!(seen[1]["topic"], "loomwatch.phone");
    assert_eq!(seen[1]["type"], "alert");
    assert_eq!(seen[1]["priority"], "10");
    assert_eq!(seen[1]["collapse"], "changed");
    assert_eq!(
        seen[1]["body"],
        json!({ "aps": { "badge": 2, "content-available": 1 } })
    );
}

#[test]
fn a_phones_live_activity_is_kept_with_it_until_it_ends() {
    let devices = Devices::memory();
    let phone = devices.connect_for_test(Kind::Phone, "phone-key");
    let mut push = target();
    push.activity = Some(ActivityTarget {
        token: ACTIVITY.to_owned(),
        run: "r1".to_owned(),
    });
    assert!(devices.set_push(&phone.id, Some(push.clone())));
    devices.forget_activity(&phone.id, "another");
    assert_eq!(devices.push_targets()[0].1, push, "only the one that ended");
    devices.forget_activity(&phone.id, ACTIVITY);
    assert_eq!(
        devices.push_targets()[0].1,
        target(),
        "the app's own token stays"
    );
}

#[test]
fn quiet_hours_within_one_day_and_across_midnight() {
    let at = |hour, minute| Utc.with_ymd_and_hms(2026, 11, 1, hour, minute, 0).unwrap();
    let day = Quiet {
        from: 13 * 60,
        to: 14 * 60,
        time_zone: "UTC".to_owned(),
    };
    assert!(day.holds(at(13, 30)));
    assert!(!day.holds(at(14, 0)));
    let night = Quiet {
        from: 22 * 60,
        to: 6 * 60,
        time_zone: "Nowhere/Unknown".to_owned(),
    };
    assert!(night.holds(at(23, 0)) && night.holds(at(5, 59)));
    assert!(!night.holds(at(12, 0)));
}

#[test]
fn a_phones_push_target_is_kept_with_it_and_old_files_still_open() {
    let folder = std::env::temp_dir().join(format!("loomwatch-push-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("devices.json"),
        r#"{"devices":[{"id":"p","name":"iPhone","kind":"phone","keySha256":"00","pairedAt":"2026-11-01T00:00:00Z"}]}"#,
    )
    .unwrap();
    let devices = Devices::open(&folder);
    assert!(
        devices.push_targets().is_empty(),
        "a file from before push opens"
    );
    assert!(devices.set_push("p", Some(target())));
    assert!(!devices.set_push("nobody", Some(target())));

    let reopened = Devices::open(&folder);
    assert_eq!(reopened.push_targets(), [("p".to_owned(), target())]);
    reopened.forget_push_token("p", "another");
    assert_eq!(
        reopened.push_targets().len(),
        1,
        "only the token Apple refused is forgotten"
    );
    reopened.forget_push_token("p", TOKEN);
    assert!(Devices::open(&folder).push_targets().is_empty());
    let _ = std::fs::remove_dir_all(&folder);
}

#[tokio::test]
async fn a_phone_gives_its_own_token_at_the_door_and_hears_whether_this_computer_can_send() {
    let devices = Devices::memory();
    let phone = devices.connect_for_test(Kind::Phone, "phone-key");
    let computer = devices.connect_for_test(Kind::Computer, "computer-key");
    let keys = KeyPlace::memory();
    let door = serve(door_router(
        devices.clone(),
        keys.clone(),
        "http://127.0.0.1:9",
    ))
    .await;
    let put = |key: &'static str, body: Value| {
        let door = door.clone();
        async move {
            reqwest::Client::new()
                .put(format!("{door}/phone/v0/push"))
                .bearer_auth(key)
                .json(&body)
                .send()
                .await
                .unwrap()
        }
    };
    let body = json!({
        "token": TOKEN, "environment": "sandbox", "tellNeedsMe": true, "tellDone": false,
        "quiet": { "from": 1380, "to": 420, "timeZone": "Asia/Ho_Chi_Minh" },
    });

    assert_eq!(put("nobody", body.clone()).await.status(), 401);
    let reply = put("phone-key", body.clone()).await;
    assert_eq!(reply.status(), 200);
    assert_eq!(
        reply.json::<Value>().await.unwrap(),
        json!({ "sending": false })
    );
    let kept = devices.push_targets();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].0, phone.id);
    assert!(!kept[0].1.tell_done);

    keys.write(Some(&push_key())).await.unwrap();
    let reply = put("phone-key", body.clone()).await;
    assert_eq!(
        reply.json::<Value>().await.unwrap(),
        json!({ "sending": true })
    );

    let mut bad = body.clone();
    bad["token"] = json!("not hex");
    assert_eq!(put("phone-key", bad).await.status(), 400);

    let mut followed = body.clone();
    followed["activity"] = json!({ "token": ACTIVITY, "run": "r1" });
    assert_eq!(put("phone-key", followed.clone()).await.status(), 200);
    assert_eq!(
        devices.push_targets()[0].1.activity,
        Some(ActivityTarget {
            token: ACTIVITY.to_owned(),
            run: "r1".to_owned()
        })
    );
    followed["activity"]["token"] = json!("not hex");
    assert_eq!(put("phone-key", followed).await.status(), 400);
    // A computer has no push token: the route is the phone's.
    assert_ne!(put("computer-key", body).await.status(), 200);
    assert!(
        devices
            .push_targets()
            .iter()
            .all(|(id, _)| *id != computer.id)
    );

    let removed = reqwest::Client::new()
        .delete(format!("{door}/phone/v0/push"))
        .bearer_auth("phone-key")
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 200);
    assert!(devices.push_targets().is_empty());
}

type Seen = Arc<Mutex<Vec<Value>>>;

/// A stand-in for Apple's push service: records each push, and answers 410 for the token `gone`.
async fn apple(seen: Seen) -> String {
    async fn push(
        State(seen): State<Seen>,
        Path(token): Path<String>,
        request: Request,
    ) -> axum::response::Response {
        let (parts, body) = request.into_parts();
        let header = |name: &str| {
            parts
                .headers
                .get(name)
                .map(|value| value.to_str().unwrap().to_owned())
        };
        let body: Value =
            serde_json::from_slice(&axum::body::to_bytes(body, 1 << 16).await.unwrap()).unwrap();
        seen.lock().unwrap().push(json!({
            "token": token,
            "authorization": header("authorization"),
            "topic": header("apns-topic"),
            "type": header("apns-push-type"),
            "priority": header("apns-priority"),
            "collapse": header("apns-collapse-id"),
            "body": body,
        }));
        if token == "gone" {
            return (StatusCode::GONE, Json(json!({ "reason": "Unregistered" }))).into_response();
        }
        StatusCode::OK.into_response()
    }
    serve(
        Router::new()
            .route("/3/device/{token}", post(push))
            .with_state(seen),
    )
    .await
}

#[tokio::test]
async fn a_push_goes_to_apple_signed_for_the_app_and_a_gone_token_says_so() {
    let seen: Seen = Arc::default();
    let apns = Apns::at(push_key(), &apple(seen.clone()).await);
    let notice = Notice {
        target: "answer-r1-review".to_owned(),
        about: About::Waiting {
            permission: false,
            review: true,
        },
        run: Some("r1".to_owned()),
        node: Some("review".to_owned()),
        room: None,
        waiting: 1,
    };
    let notice = Push::Notice(notice);
    assert_eq!(apns.send(&target(), &notice).await, Sent::Done);
    let gone = PushTarget {
        token: "gone".to_owned(),
        ..target()
    };
    assert_eq!(apns.send(&gone, &notice).await, Sent::Gone);

    let seen = seen.lock().unwrap();
    let first = &seen[0];
    assert_eq!(first["token"], TOKEN);
    assert_eq!(first["topic"], "loomwatch.phone");
    assert_eq!(first["type"], "alert");
    assert_eq!(first["collapse"], "answer-r1-review");
    assert!(
        first["authorization"]
            .as_str()
            .unwrap()
            .starts_with("Bearer ey")
    );
    assert_eq!(first["body"]["aps"]["category"], "review");
    assert_eq!(first["body"]["node"], "review");
}

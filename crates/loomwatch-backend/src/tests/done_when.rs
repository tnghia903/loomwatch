//! ADR 0098: a message that says what done looks like gets its work checked against it, by the
//! team's own check step or by `LoomWatch`, before the work becomes the answer.

use super::*;
use crate::message_done::{CHECKER_ID, MessageDone};
use crate::test_support::{stand_in, turn};

const LIMIT: &str = "At most 250 words";
const SECTIONS: &str = "Three sections: Agreed, Open and Next steps";
const REQUEST: &str = "Write the update for Lan. Three sections: Agreed, Open and Next steps. At most \
     250 words, 3 tries.";

/// A team of one agent, `writer`, with no fixed order: how a chat with one of My agents runs.
fn solo(id: &str, writer: &str) -> Arc<TeamConfig> {
    Arc::new(TeamConfig {
        project: None,
        shares: None,
        project_file: None,
        schema_version: 1,
        id: id.into(),
        name: format!("{id} team"),
        entrypoint: "writer".into(),
        responder: None,
        schedule: None,
        deliver: None,
        conversation: ConversationConfig::default(),
        permissions: crate::config::TeamPermissions::default(),
        spend: crate::spend::SpendConfig::default(),
        memory: None,
        guards: GuardsConfig::default(),
        agents: vec![pipeline_agent("writer", writer)],
        edges: Vec::new(),
    })
}

/// Run `team` in team mode as the app runs it: with a desk to stop at, and what the message said
/// recorded in the run's archive as it changes.
async fn run_solo(
    team: &Arc<TeamConfig>,
    archive: &EventArchive,
    desk: &crate::operator::OperatorDesk,
    run_id: &str,
    asked: &MessageDone,
) -> Result<SessionOutcome> {
    let log = EventLog::new(archive.clone(), run_id.to_owned());
    asked.record_in(log.clone());
    let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
    tokio::time::timeout(
        Duration::from_secs(30),
        run_team_mode(
            team,
            &team_path,
            archive.clone(),
            REQUEST,
            Duration::from_secs(5),
            Some(log),
            &Arc::new(memory::TeamMemory::default()),
            &RunLineage {
                operator: Some(desk.clone()),
                asked: Some(asked.clone()),
                ..RunLineage::default()
            },
        ),
    )
    .await
    .context("the run hung")?
}

/// Every `done_when` record: what the chat shows under the message.
fn done_when_records(events: &[RunEvent]) -> Vec<&serde_json::Value> {
    events
        .iter()
        .filter(|event| event.payload["phase"] == crate::message_done::PHASE)
        .map(|event| &event.payload)
        .collect()
}

/// **The message's own limit sends the answer back until it is met.** One agent, no check step:
/// `LoomWatch` checks the reply against the message's items and the request, on its own checker,
/// which finds the work in a file to measure. What is not met goes back into the agent's open
/// session; the revision is the answer. Everything is recorded under `LoomWatch`'s own id, and the
/// stop counts tries, as the message did.
#[tokio::test]
async fn a_message_s_own_limit_sends_the_answer_back_until_it_is_met() -> Result<()> {
    let pool = crate::db::Db::temp().await;
    let (writer, _) = stand_in(vec![
        turn(&[REQUEST], "draft of 266 words"),
        turn(
            &[
                "## Sent back by LoomWatch",
                "- At most 250 words (266 words)",
                "This is round 1 of 2.",
            ],
            "draft of 241 words",
        )
        .remembering(&["draft of 266 words"]),
    ]);
    let team = solo("message-limit", &writer);
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let answer_file = crate::answer_folder(&run_id).join("answer.md");
    let answer_file = answer_file.display().to_string();
    let named = format!("The work is also in the file `{answer_file}`, to count and measure");
    let (checker, _) = stand_in(vec![
        turn(
            &[
                "### Work from writer name\n\ndraft of 266 words",
                "1. Three sections: Agreed, Open and Next steps\n2. At most 250 words\n3. Does \
                 what the request asked",
                "An item with a number is Met only on what you measured",
                &named,
                "You check writer name's work",
            ],
            &loop_block(
                "",
                &[
                    (1, "Met", SECTIONS, "3 sections: Agreed, Open, Next steps"),
                    (2, "Not met", LIMIT, "266 words"),
                    (3, "Met", "Does what the request asked", "it is the update"),
                ],
            ),
        )
        .never(&[CONTRADICTION_ITEM])
        .calling(
            "read_file",
            serde_json::json!({"path": answer_file}),
            "draft of 266 words",
        ),
        turn(
            &[
                "## The revised work",
                "draft of 241 words",
                "2. At most 250 words (Not met)",
            ],
            &loop_block("", &[(2, "Met", LIMIT, "wc -w gives 241")]),
        )
        .calling(
            "read_file",
            serde_json::json!({"path": answer_file}),
            "draft of 241 words",
        ),
    ]);
    let asked = MessageDone::found(&[SECTIONS, LIMIT], Some(3)).checked_on(Some(checker.clone()));

    let outcome = run_solo(&team, &archive, &desk, &run_id, &asked).await?;

    assert_eq!(outcome.reply, "draft of 241 words");
    let events = archive.load_verified_session(&run_id).await?;
    assert_eq!(events.len(), outcome.event_count);
    assert_eq!(
        check_results(&events),
        [
            (1, verdict_list(["met", "not_met", "met"]), true),
            (2, verdict_list(["met", "met", "met"]), true),
        ]
    );
    assert!(
        events
            .iter()
            .filter(|event| event.payload["phase"]
                .as_str()
                .is_some_and(|phase| phase.starts_with("check_")))
            .all(|event| event.agent_id == CHECKER_ID),
        "LoomWatch's own check is recorded as LoomWatch's"
    );
    let stopped = events
        .iter()
        .find(|event| event.payload["phase"] == "check_stopped")
        .expect("the check stopped");
    assert_eq!(stopped.payload["reason"], "all_met");
    assert_eq!(stopped.payload["sent"], 1);
    assert_eq!(stopped.payload["tries"], true);
    let shown = done_when_records(&events);
    let last = shown.last().expect("what the message asks is shown");
    assert_eq!(last["state"], "found");
    assert_eq!(last["items"][1]["text"], LIMIT);
    assert_eq!(last["items"][1]["checked"], true);
    assert_eq!(last["tries"], 3);
    assert_eq!(last["rounds"], 2);
    assert_eq!(last["checker"]["model"], checker.as_str());
    assert_eq!(last["ended"], true, "the marks go once the check has ended");
    assert!(
        !crate::answer_folder(&run_id).exists(),
        "the answer's file goes when the check ends"
    );
    Ok(())
}

/// **The check finds the files the work names where the work was done.** The reply says it wrote
/// `reconciliation.csv`; `LoomWatch`'s checker reads it by that name, in the agent's own folder,
/// and finds what the agent wrote. A checker in a folder of its own found no such file and sent
/// the work back for it (the calibration of 2026-10-29). The check leaves nothing in that folder.
#[tokio::test]
async fn the_check_finds_the_files_the_work_names_where_the_work_was_done() -> Result<()> {
    const FILE: &str = "Writes reconciliation.csv, one row per invoice";
    let pool = crate::db::Db::temp().await;
    let work = std::env::temp_dir().join(format!("loomwatch-work-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work)?;
    let work = platform::canonicalize(&work)?;
    std::fs::write(
        work.join("reconciliation.csv"),
        "invoice,status\nINV-1031,paid\n",
    )?;
    let (writer, _) = stand_in(vec![turn(
        &[REQUEST],
        "Wrote reconciliation.csv: 1 invoice, paid.",
    )]);
    let (checker, _) = stand_in(vec![
        turn(
            &["Your folder is the one the work was done in"],
            &loop_block(
                "",
                &[
                    (1, "Met", FILE, "reconciliation.csv has 1 row, INV-1031"),
                    (2, "Met", "Does what the request asked", "it reconciles"),
                ],
            ),
        )
        .calling(
            "read_file",
            serde_json::json!({"path": "reconciliation.csv"}),
            "INV-1031,paid",
        ),
    ]);
    let mut team = (*solo("message-files", &writer)).clone();
    team.agents[0].spawn.cwd.clone_from(&work);
    let team = Arc::new(team);
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let asked = MessageDone::found(&[FILE], None).checked_on(Some(checker));

    let outcome = run_solo(&team, &archive, &desk, &run_id, &asked).await?;

    assert_eq!(outcome.reply, "Wrote reconciliation.csv: 1 invoice, paid.");
    let events = archive.load_verified_session(&run_id).await?;
    assert_eq!(
        check_results(&events),
        [(1, verdict_list(["met", "met"]), true)]
    );
    let left: Vec<_> = std::fs::read_dir(&work)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<_>>()?;
    assert_eq!(
        left,
        ["reconciliation.csv"],
        "the check wrote nothing where the work was done"
    );
    let _ = std::fs::remove_dir_all(&work);
    Ok(())
}

/// A message that says nothing checkable starts no check: the checker is never prompted, and the
/// chat shows nothing under the message.
#[tokio::test]
async fn a_message_with_nothing_to_check_starts_no_check() -> Result<()> {
    let pool = crate::db::Db::temp().await;
    let (writer, _) = stand_in(vec![turn(&[], "the update")]);
    let team = solo("message-nothing", &writer);
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let asked = MessageDone::reading().checked_on(Some(never_prompted()));
    asked.finish(crate::message_done::Reading::Nothing);

    let outcome = run_solo(&team, &archive, &desk, &run_id, &asked).await?;

    assert_eq!(outcome.reply, "the update");
    let events = archive.load_verified_session(&run_id).await?;
    assert_eq!(check_results(&events), []);
    assert!(done_when_records(&events).is_empty());
    Ok(())
}

/// An item the person took off the check is neither checked nor sent back, and the chat shows it
/// taken off.
#[tokio::test]
async fn an_item_taken_off_is_neither_checked_nor_sent_back() -> Result<()> {
    let pool = crate::db::Db::temp().await;
    let (writer, _) = stand_in(vec![turn(&[], "draft of 300 words")]);
    let (checker, _) = stand_in(vec![
        turn(
            &["1. Three sections: Agreed, Open and Next steps\n2. Does what the request asked"],
            &loop_block(
                "",
                &[
                    (1, "Met", SECTIONS, "three headed sections"),
                    (2, "Met", "Does what the request asked", "it is the update"),
                ],
            ),
        )
        .never(&["1. At most 250 words", "2. At most 250 words"]),
    ]);
    let team = solo("message-off", &writer);
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let asked = MessageDone::found(&[SECTIONS, LIMIT], None).checked_on(Some(checker));
    asked
        .set_checked(1, false)
        .expect("an item comes off before the check");

    let outcome = run_solo(&team, &archive, &desk, &run_id, &asked).await?;

    assert_eq!(outcome.reply, "draft of 300 words");
    let events = archive.load_verified_session(&run_id).await?;
    assert_eq!(
        check_results(&events),
        [(1, verdict_list(["met"; 2]), true)]
    );
    let last = *done_when_records(&events).last().expect("shown");
    assert_eq!(last["items"][1]["checked"], false);
    Ok(())
}

/// An item taken off while the check runs is not sent back: here the person takes the limit off
/// while the checker is finding it not met, and the work, which met everything else, is the answer
/// with nothing going back.
#[tokio::test]
async fn an_item_taken_off_while_the_check_runs_is_not_sent_back() -> Result<()> {
    let pool = crate::db::Db::temp().await;
    let (writer, _) = stand_in(vec![turn(&[], "draft of 300 words")]);
    let asked = MessageDone::found(&[SECTIONS, LIMIT], None);
    let checker = crate::engine::demo_model(crate::agent::Demo::responder({
        let asked = asked.clone();
        move |_| {
            asked
                .set_checked(1, false)
                .expect("the check has not ended");
            Some(crate::agent::Completion::text(&loop_block(
                "",
                &[
                    (1, "Met", SECTIONS, "3 headed sections"),
                    (2, "Not met", LIMIT, "300 words"),
                    (3, "Met", "Does what the request asked", "it is the update"),
                ],
            )))
        }
    }));
    let team = solo("message-off-later", &writer);
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let asked = asked.checked_on(Some(checker));

    let outcome = run_solo(&team, &archive, &desk, &run_id, &asked).await?;

    assert_eq!(outcome.reply, "draft of 300 words");
    let events = archive.load_verified_session(&run_id).await?;
    assert_eq!(
        check_results(&events),
        [(1, verdict_list(["met", "not_met", "met"]), true)]
    );
    let stopped = events
        .iter()
        .find(|event| event.payload["phase"] == "check_stopped")
        .expect("the check stopped");
    assert_eq!(stopped.payload["reason"], "all_met");
    assert_eq!(stopped.payload["sent"], 0);
    Ok(())
}

/// The run's end settles what the message asked, and its last record is written before the run's
/// events are counted, even when no check ran: here the person took the only item off first.
#[tokio::test]
async fn the_run_s_end_settles_what_the_message_asked_before_its_events_are_counted() -> Result<()>
{
    let pool = crate::db::Db::temp().await;
    let (writer, _) = stand_in(vec![turn(&[], "draft of 300 words")]);
    let team = solo("message-settled", &writer);
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let asked = MessageDone::found(&[LIMIT], None).checked_on(Some(never_prompted()));
    asked.set_checked(0, false).expect("before the work starts");

    let outcome = run_solo(&team, &archive, &desk, &run_id, &asked).await?;

    let events = archive.load_verified_session(&run_id).await?;
    assert_eq!(
        events.len(),
        outcome.event_count,
        "nothing written after the count"
    );
    assert_eq!(check_results(&events), []);
    let last = *done_when_records(&events).last().expect("shown");
    assert_eq!(last["ended"], true, "the marks go once the run is over");
    assert!(asked.now().ended);
    Ok(())
}

/// **What the person takes off at the stop does not go back.** The send-backs ran out with the
/// limit still open, so the stop asks in tries; the person takes the limit off and sends the work
/// back with a note. Nothing still checked is open, so only the note goes, with no check listed,
/// and its revision is the answer with no recheck.
#[tokio::test]
async fn an_item_taken_off_at_the_stop_does_not_go_back_with_the_note() -> Result<()> {
    let pool = crate::db::Db::temp().await;
    let (writer, _) = stand_in(vec![
        turn(&[], "draft A"),
        turn(
            &[
                "## Sent back by LoomWatch",
                "- At most 250 words (300 words)",
                "- Three sections: Agreed, Open and Next steps (two sections)",
            ],
            "draft B",
        ),
        turn(
            &["## Direction from you", "Tighten the opening."],
            "draft C",
        )
        .never(&["The checks still open were", "- At most 250 words ("]),
    ]);
    let (checker, _) = stand_in(vec![
        turn(
            &["draft A"],
            &loop_block(
                "",
                &[
                    (1, "Not met", LIMIT, "300 words"),
                    (2, "Not met", SECTIONS, "two sections"),
                    (3, "Met", "Does what the request asked", "it is the update"),
                ],
            ),
        ),
        turn(
            &["draft B", "This is the last round."],
            &loop_block(
                "",
                &[
                    (1, "Not met", LIMIT, "290 words"),
                    (2, "Met", SECTIONS, "3 sections: Agreed, Open, Next steps"),
                ],
            ),
        ),
    ]);
    let team = solo("message-off-at-stop", &writer);
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let asked = MessageDone::found(&[LIMIT, SECTIONS], Some(2)).checked_on(Some(checker));
    let answering = tokio::spawn({
        let (desk, run_id, asked) = (desk.clone(), run_id.clone(), asked.clone());
        async move {
            let waiting = wait_for_stop(&desk, &run_id, |_| true).await;
            asked
                .set_checked(0, false)
                .expect("the check has not ended while it waits");
            desk.deliver(
                &run_id,
                &waiting.node,
                answer("Tighten the opening.", Some("writer")),
            )
            .await
            .expect("the stop takes the send-back");
            waiting
        }
    });

    let outcome = run_solo(&team, &archive, &desk, &run_id, &asked).await?;
    let waiting = answering.await?;

    assert_eq!(
        waiting.question,
        "writer name's work still misses 1 check after 2 tries. Approve it as it is, or send it \
         back to try again."
    );
    assert_eq!(outcome.reply, "draft C");
    Ok(())
}

/// **Still not met after the message's tries, the run stops and asks, in tries.** Sent back from the
/// stop with no note, the work goes back on the checks still open, and the recheck that meets them
/// ends the stop.
#[tokio::test]
async fn still_not_met_after_the_message_s_tries_asks_and_a_bare_send_back_tries_again()
-> Result<()> {
    let pool = crate::db::Db::temp().await;
    let (writer, _) = stand_in(vec![
        turn(&[], "draft of 290 words"),
        turn(
            &[
                "## Sent back by LoomWatch",
                "- At most 250 words (290 words)",
            ],
            "draft of 270 words",
        )
        .never(&["This is round"]),
        turn(
            &[
                "## Direction from you",
                "sent it back to try again on the checks still open.",
                "- At most 250 words (not met: 270 words)",
            ],
            "draft of 240 words",
        ),
    ]);
    let not_met = |words: &str| {
        loop_block(
            "",
            &[
                (1, "Not met", LIMIT, words),
                (2, "Met", "Does what the request asked", "it is the update"),
            ],
        )
    };
    let (checker, _) = stand_in(vec![
        turn(&["draft of 290 words"], &not_met("290 words")),
        turn(
            &["draft of 270 words", "This is the last round."],
            &loop_block("", &[(1, "Not met", LIMIT, "270 words")]),
        ),
        turn(
            &["draft of 240 words"],
            &loop_block("", &[(1, "Met", LIMIT, "240 words")]),
        ),
    ]);
    let team = solo("message-ask", &writer);
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let asked = MessageDone::found(&[LIMIT], Some(2)).checked_on(Some(checker));
    let answering = tokio::spawn({
        let desk = desk.clone();
        let run_id = run_id.clone();
        async move {
            let waiting = wait_for_stop(&desk, &run_id, |_| true).await;
            desk.deliver(&run_id, &waiting.node, answer("", Some("writer")))
                .await
                .expect("the stop takes a bare send-back");
            waiting
        }
    });

    let outcome = run_solo(&team, &archive, &desk, &run_id, &asked).await?;
    let waiting = answering.await?;

    assert_eq!(outcome.reply, "draft of 240 words");
    assert_eq!(waiting.node, CHECKER_ID);
    assert_eq!(waiting.name, "LoomWatch");
    assert_eq!(waiting.handover_from.as_deref(), Some("writer"));
    assert!(waiting.send_back_available, "the writer's session is open");
    assert!(
        waiting.check.as_ref().is_some_and(|check| check.tries),
        "the stop's card counts tries too"
    );
    assert_eq!(
        waiting.question,
        "writer name's work still misses 1 check after 2 tries (the last try fixed none of them). \
         Approve it as it is, or send it back to try again."
    );
    Ok(())
}

/// **A check step on the answer checks the message first.** Its items are the message's, then the
/// checked agent's own Done when, the request and the contradiction item; the message's tries set
/// how many times it goes back, though the step itself sends back once.
#[tokio::test]
async fn a_check_step_on_the_answer_checks_the_message_s_items_first() -> Result<()> {
    let pool = crate::db::Db::temp().await;
    let (writer, _) = stand_in(vec![
        turn(&[], "draft one"),
        turn(&["This is round 1 of 2."], "draft two"),
    ]);
    let (checker, _) = stand_in(vec![
        turn(
            &["draft one"],
            &loop_block(
                "",
                &[
                    (1, "Not met", LIMIT, "266 words"),
                    (2, "Met", LOOP_A, "cites the 2025 report"),
                    (3, "Met", LOOP_B, "170 words"),
                    (4, "Met", "Does what the request asked", "it is"),
                    (5, "Met", CONTRADICTION_ITEM, "traced"),
                ],
            ),
        )
        .in_order(&[
            "1. At most 250 words",
            &format!("2. {LOOP_A}"),
            &format!("3. {LOOP_B}"),
            "4. Does what the request asked",
            &format!("5. {CONTRADICTION_ITEM}"),
        ]),
        turn(
            &["draft two"],
            &loop_block("", &[(1, "Met", LIMIT, "241 words")]),
        ),
    ]);
    let team = loop_team(
        "message-check-step",
        &writer,
        &checker,
        rounds(1, config::WhenStillNotMet::Answer),
        None,
    );
    let archive = EventArchive::new(pool);
    let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
    let asked = MessageDone::found(&[LIMIT], Some(3));
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        run_pipeline_mode(
            &team,
            &team_path,
            archive.clone(),
            "write it",
            Duration::from_secs(5),
            None,
            &Arc::new(memory::TeamMemory::default()),
            &RunLineage {
                asked: Some(asked.clone()),
                ..RunLineage::default()
            },
        ),
    )
    .await
    .context("the run hung")??;
    assert_eq!(outcome.reply, "draft two");
    assert_eq!(asked.now().rounds, Some(2));
    assert!(asked.now().ended);
    Ok(())
}

/// **The last stage of a pipeline is checked by `LoomWatch` when no check step checks it.** Its
/// reply goes back into its own open session, and the revision is the run's answer.
#[tokio::test]
async fn the_unchecked_last_stage_of_a_pipeline_is_checked_by_loomwatch() -> Result<()> {
    let pool = crate::db::Db::temp().await;
    let (researcher, _) = stand_in(vec![turn(&[], "facts: launch on 3 December")]);
    let (writer, _) = stand_in(vec![
        turn(&["facts: launch on 3 December"], "draft of 266 words"),
        turn(&["## Sent back by LoomWatch"], "draft of 241 words"),
    ]);
    let (checker, _) = stand_in(vec![
        turn(
            &["draft of 266 words", "facts: launch on 3 December"],
            &loop_block(
                "",
                &[
                    (1, "Not met", LIMIT, "266 words"),
                    (2, "Met", "Does what the request asked", "it is"),
                ],
            ),
        ),
        turn(
            &["draft of 241 words"],
            &loop_block("", &[(1, "Met", LIMIT, "241 words")]),
        ),
    ]);
    let team = check_team(
        "message-last-stage",
        vec![
            named("researcher", "Researcher", &researcher),
            named("writer", "Writer", &writer),
        ],
        &[("researcher", "writer")],
    );
    let archive = EventArchive::new(pool);
    let (_registry, desk, run_id) = operator_desk(&team, &archive);
    let team_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("team.yaml");
    let outcome = tokio::time::timeout(
        Duration::from_secs(30),
        run_pipeline_mode(
            &team,
            &team_path,
            archive.clone(),
            REQUEST,
            Duration::from_secs(5),
            Some(EventLog::new(archive.clone(), run_id.clone())),
            &Arc::new(memory::TeamMemory::default()),
            &RunLineage {
                operator: Some(desk),
                asked: Some(MessageDone::found(&[LIMIT], None).checked_on(Some(checker))),
                ..RunLineage::default()
            },
        ),
    )
    .await
    .context("the run hung")??;
    assert_eq!(outcome.reply, "draft of 241 words");
    let events = archive.load_verified_session(&run_id).await?;
    assert_eq!(
        check_results(&events),
        [
            (1, verdict_list(["not_met", "met"]), true),
            (2, verdict_list(["met", "met"]), true),
        ]
    );
    Ok(())
}

/// **A number is measured, not read by eye.** Met on an item with a number is Not sure unless its
/// evidence gives a number, in digits or in words; an item that does not apply needs only its
/// reason; and the miss is the checker's to fix, never sent to the writer.
#[test]
fn met_on_a_number_needs_a_measurement() {
    let items = vec![LIMIT.to_owned(), "Plain words".to_owned()];
    let read = |block: &str| read_checks(block, &items).settle(&items, None);
    let by_eye =
        read("## Check\n1. Met — At most 250 words — short enough\n2. Met — Plain words — it is");
    assert_eq!(by_eye[0].verdict, "not_sure");
    assert_eq!(by_eye[0].evidence, MET_WITHOUT_MEASURING);
    assert!(is_checker_gap(&by_eye[0]));
    assert_eq!(
        by_eye[1].verdict, "met",
        "an item with no number needs none"
    );
    let named = vec!["Names the three tools".to_owned()];
    let counted = read_checks(
        "## Check\n1. Met — Names the three tools — Otter, Fathom",
        &named,
    )
    .settle(&named, None);
    assert_eq!(
        counted[0].verdict, "met",
        "a count in words is met by naming them"
    );
    for evidence in [
        "241 words",
        "two hundred and forty",
        "Does not apply: no limit here",
    ] {
        let measured = read(&format!(
            "## Check\n1. Met — At most 250 words — {evidence}\n2. Met — Plain words — yes"
        ));
        assert_eq!(measured[0].verdict, "met", "{evidence}");
    }
}

/// The message's items come first, the request stays an item beside them, and `LoomWatch`'s own
/// check holds the work to the message and the request only.
#[test]
fn the_message_s_items_come_first() {
    let mut writer = pipeline_agent("writer", OFFLINE);
    writer.done_when = vec![LOOP_A.into()];
    let team = check_team("items", vec![writer], &[]);
    assert_eq!(
        check_items(&team, "writer", &[]),
        [LOOP_A, CONTRADICTION_ITEM]
    );
    assert_eq!(
        check_items(&team, "writer", &[LIMIT.to_owned()]),
        [LIMIT, LOOP_A, CHECK_REQUEST.text(), CONTRADICTION_ITEM]
    );
    assert_eq!(
        answer_check_items(&[LIMIT.to_owned()]),
        [LIMIT, CHECK_REQUEST.text()]
    );
}

/// How the work goes back for a message: its tries over a check step's rounds, else the step's own,
/// else the team's `fromMessage`.
#[test]
fn a_message_s_tries_set_how_many_times_the_work_goes_back() {
    let from = config::FromMessage::default();
    let own = Some(rounds(1, config::WhenStillNotMet::Answer));
    assert_eq!(send_back_with_message(None, from, None).rounds, 2);
    assert_eq!(
        send_back_with_message(own, from, None),
        rounds(1, config::WhenStillNotMet::Answer)
    );
    let tries = send_back_with_message(own, from, Some(4));
    assert_eq!(tries.rounds, 3);
    assert_eq!(tries.when_still_not_met, config::WhenStillNotMet::Answer);
    assert_eq!(send_back_with_message(None, from, Some(40)).rounds, 5);
    assert_eq!(send_back_with_message(None, from, Some(1)).rounds, 0);
}

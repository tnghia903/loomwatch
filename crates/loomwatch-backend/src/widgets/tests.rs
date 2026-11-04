use super::*;

fn zoo_trip() -> Value {
    json!({
        "kind": "calculator",
        "title": "Zoo trip: cost per family",
        "inputs": [
            {"id": "pupils", "label": "Pupils", "start": 32, "min": 1, "max": 60},
            {"id": "bus", "label": "Bus", "start": 2_400_000, "unit": "₫"},
            {"id": "ticket", "label": "Ticket", "start": 60000, "unit": "₫"},
            {"id": "round_up", "label": "Round up", "on": true}
        ],
        "results": [
            {"id": "each", "label": "Each family pays", "formula": "if(round_up, ceil((bus + pupils * ticket) / pupils, -4), (bus + pupils * ticket) / pupils)", "unit": "₫", "decimals": 0}
        ]
    })
}

#[test]
fn a_calculator_is_checked_and_worked_out_with_its_starting_values() {
    let widget = read(&zoo_trip()).expect("a good calculator");
    let told = shown(&widget);
    assert_eq!(told["shown"], "a calculator \"Zoo trip: cost per family\"");
    assert_eq!(told["results"], "Each family pays = 140,000 ₫");
    assert_eq!(told["next"], SHOW_WIDGET_SHOWN.text());
}

#[test]
fn each_kind_reads_with_only_its_own_fields() {
    let choices = read(&json!({
        "kind": "choices", "title": "Which theme?",
        "options": [{"label": "Animals", "detail": "rabbit, giraffe"}, {"label": "Food"}],
        "items": [{"text": "ignored"}]
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(&choices).unwrap(),
        json!({"kind": "choices", "title": "Which theme?", "options": [{"label": "Animals", "detail": "rabbit, giraffe"}, {"label": "Food"}]})
    );
    let steps = read(&json!({
        "kind": "steps", "title": "The water cycle", "repeats": true,
        "steps": [{"label": "Evaporation", "text": "The sun warms the sea."}, {"label": "Rain", "text": "Drops fall."}]
    }))
    .unwrap();
    assert!(matches!(steps, Widget::Steps { repeats: true, .. }));
    let checklist = read(&json!({
        "kind": "checklist", "title": "Before Wednesday",
        "items": [{"text": "Print 32 copies", "note": "Tue"}]
    }))
    .unwrap();
    assert_eq!(checklist.kind(), "checklist");
}

#[test]
fn a_bad_widget_says_what_to_change() {
    let cases = [
        (json!({"kind": "chart", "title": "x"}), "isn't a widget"),
        (json!({"kind": "choices"}), "title is missing"),
        (
            json!({"kind": "choices", "title": "x", "options": [{"label": "only one"}]}),
            "options has 1; give 2 to 6",
        ),
        (
            json!({"kind": "checklist", "title": "x", "items": []}),
            "items has 0; give 1 to 20",
        ),
        (
            json!({"kind": "steps", "title": "x", "steps": [{"label": "a", "text": "b"}]}),
            "steps has 1; give 2 to 8",
        ),
        (
            json!({"kind": "choices", "title": "x".repeat(81), "options": []}),
            "keep it to 80",
        ),
        (
            json!({"kind": "calculator", "title": "x", "inputs": [{"id": "a", "label": "A"}], "results": [{"id": "r", "label": "R", "formula": "a"}]}),
            "give start for a number, or on",
        ),
        (
            json!({"kind": "calculator", "title": "x", "inputs": [{"id": "A", "label": "A", "start": 1}], "results": [{"id": "r", "label": "R", "formula": "1"}]}),
            "must start with a lowercase letter",
        ),
        (
            json!({"kind": "calculator", "title": "x", "inputs": [{"id": "round", "label": "A", "start": 1}], "results": [{"id": "r", "label": "R", "formula": "1"}]}),
            "is the name of a function",
        ),
        (
            json!({"kind": "calculator", "title": "x", "inputs": [{"id": "a", "label": "A", "start": 1}], "results": [{"id": "r", "label": "R", "formula": "a + b"}]}),
            "reads \"b\", which isn't an input or a result above it; it can read a",
        ),
        (
            json!({"kind": "calculator", "title": "x", "inputs": [{"id": "a", "label": "A", "start": 0}], "results": [{"id": "r", "label": "Share", "formula": "10 / a"}]}),
            "result \"Share\" with the starting values: the formula divides by zero",
        ),
        (
            json!({"kind": "calculator", "title": "x", "inputs": [{"id": "a", "label": "A", "start": 1}], "results": [{"id": "r", "label": "R", "formula": "sqrt(a)"}]}),
            "there is no function \"sqrt\"",
        ),
        (
            json!({"kind": "calculator", "title": "x", "inputs": [{"id": "a", "label": "A", "start": 5, "max": 4}], "results": [{"id": "r", "label": "R", "formula": "a"}]}),
            "start is outside min and max",
        ),
        (
            json!({"kind": "calculator", "title": "x", "inputs": [{"id": "a", "label": "A", "start": 1}, {"id": "a", "label": "B", "start": 2}], "results": [{"id": "r", "label": "R", "formula": "a"}]}),
            "id \"a\" is used twice",
        ),
    ];
    for (arguments, says) in cases {
        let error = read(&arguments).expect_err(&format!("{arguments} should be refused"));
        assert!(
            error.contains(says),
            "{arguments}: {error:?} should say {says:?}"
        );
    }
}

#[test]
fn a_result_reads_the_results_above_it() {
    let widget = read(&json!({
        "kind": "calculator", "title": "Split",
        "inputs": [{"id": "total", "label": "Total", "start": 90}, {"id": "people", "label": "People", "start": 3}],
        "results": [
            {"id": "each", "label": "Each", "formula": "total / people"},
            {"id": "tip", "label": "With a tip", "formula": "each * 1.1", "decimals": 2}
        ]
    }))
    .unwrap();
    assert_eq!(shown(&widget)["results"], "Each = 30; With a tip = 33.00");
}

#[test]
fn the_tool_uses_only_schema_words_every_provider_already_takes() {
    // A schema a provider refuses fails every call that agent makes, not only this tool's.
    const TAKEN: [&str; 11] = [
        "type",
        "description",
        "enum",
        "minLength",
        "minimum",
        "maximum",
        "maxItems",
        "items",
        "properties",
        "required",
        "additionalProperties",
    ];
    fn walk(schema: &Value, at: &str) {
        let Some(object) = schema.as_object() else {
            return;
        };
        for (key, value) in object {
            assert!(
                TAKEN.contains(&key.as_str()),
                "{at}.{key} isn't a word every provider takes"
            );
            match key.as_str() {
                "properties" => {
                    for (name, property) in value.as_object().expect("properties") {
                        walk(property, &format!("{at}.{name}"));
                    }
                }
                "items" => walk(value, &format!("{at}[]")),
                _ => {}
            }
        }
    }
    let tool = tool_definition();
    assert_eq!(tool["name"], TOOL);
    walk(&tool["inputSchema"], "show_widget");
}

fn event(seq: u64, kind: EventKind, payload: Value) -> RunEvent {
    RunEvent {
        id: format!("e{seq}"),
        session_id: "run".to_owned(),
        agent_id: "writer".to_owned(),
        seq,
        ts: format!("2026-11-05T10:00:{seq:02}Z"),
        kind,
        payload,
        raw: None,
    }
}

/// A turn of the writer's: its prompt, and a `show_widget` call per title that went through.
fn turn(events: &mut Vec<RunEvent>, purpose: &str, titles: &[&str]) {
    let mut seq = events.len() as u64;
    let mut next = |kind, payload| {
        seq += 1;
        event(seq, kind, payload)
    };
    events.push(next(
        EventKind::SessionMeta,
        json!({"phase": "turn_purpose", "purpose": purpose}),
    ));
    events.push(next(
        EventKind::Message,
        json!({"role": "user", "content": {"text": "go"}}),
    ));
    for title in titles {
        let call = format!("call-{title}");
        events.push(next(
            EventKind::ToolCall,
            json!({"callId": call, "name": TOOL, "rawInput": {"kind": "checklist", "title": title, "items": [{"text": "one"}]}}),
        ));
        events.push(next(
            EventKind::ToolUpdate,
            json!({"callId": call, "status": "completed"}),
        ));
    }
    events.push(next(
        EventKind::Message,
        json!({"role": "agent", "content": {"text": "the answer"}}),
    ));
}

fn titles(widgets: &[Widget]) -> Vec<&str> {
    widgets.iter().map(Widget::title).collect()
}

#[test]
fn the_answer_keeps_the_widgets_of_the_turn_whose_reply_became_the_answer() {
    let mut events = Vec::new();
    turn(&mut events, "work", &["first try"]);
    turn(&mut events, "work", &["revised"]);
    turn(&mut events, "checkpoint", &["bookkeeping"]);
    assert_eq!(titles(&of_answer(&events, Some("writer"))), ["revised"]);
}

#[test]
fn a_revision_that_shows_nothing_keeps_the_widgets_shown_before_it() {
    let mut events = Vec::new();
    turn(&mut events, "work", &["first try"]);
    turn(&mut events, "work", &[]);
    assert_eq!(titles(&of_answer(&events, Some("writer"))), ["first try"]);
}

#[test]
fn a_call_that_failed_and_another_agent_show_nothing() {
    let mut events = Vec::new();
    turn(&mut events, "work", &["kept"]);
    events.push(event(
        90,
        EventKind::ToolCall,
        json!({"callId": "bad", "name": TOOL, "rawInput": {"kind": "checklist", "title": "refused", "items": [{"text": "x"}]}}),
    ));
    events.push(event(
        91,
        EventKind::ToolUpdate,
        json!({"callId": "bad", "status": "failed"}),
    ));
    let mut other = event(
        92,
        EventKind::ToolCall,
        json!({"callId": "other", "name": TOOL, "rawInput": {"kind": "checklist", "title": "someone else's", "items": [{"text": "x"}]}}),
    );
    other.agent_id = "researcher".to_owned();
    events.push(other);
    assert_eq!(titles(&of_answer(&events, Some("writer"))), ["kept"]);
    assert!(of_answer(&events, None).is_empty());
}

#[test]
fn an_answer_keeps_its_last_four() {
    let mut events = Vec::new();
    turn(&mut events, "work", &["1", "2", "3", "4", "5"]);
    assert_eq!(
        titles(&of_answer(&events, Some("writer"))),
        ["2", "3", "4", "5"]
    );
}

#[test]
fn state_is_checked_against_the_widget() {
    let trip = read(&zoo_trip()).unwrap();
    assert_eq!(
        read_state(&trip, &json!({"values": {"pupils": 30, "round_up": false}})).unwrap(),
        json!({"values": {"pupils": 30, "round_up": false}})
    );
    for (state, says) in [
        (
            json!({"values": {"teachers": 4}}),
            "isn't one of the calculator's inputs",
        ),
        (json!({"values": {"pupils": 61}}), "outside its min and max"),
        (json!({"values": {"round_up": 1}}), "is a switch"),
        (json!({"values": {"pupils": "thirty"}}), "is a number"),
        (json!({"checked": [true]}), "a calculator's state is"),
    ] {
        let error = read_state(&trip, &state).expect_err(&state.to_string());
        assert!(error.contains(says), "{state}: {error}");
    }
    let list = read(&json!({"kind": "checklist", "title": "Before Wednesday", "items": [{"text": "a"}, {"text": "b"}]})).unwrap();
    assert!(read_state(&list, &json!({"checked": [true, false]})).is_ok());
    assert!(read_state(&list, &json!({"checked": [true]})).is_err());
    let choices = read(
        &json!({"kind": "choices", "title": "x", "options": [{"label": "a"}, {"label": "b"}]}),
    )
    .unwrap();
    assert!(read_state(&choices, &json!({})).is_err());
}

fn kept(n: u32, spec: Widget, state: Option<Value>, changed_at: Option<&str>) -> Kept {
    Kept {
        n,
        spec,
        state,
        changed_at: changed_at.map(str::to_owned),
    }
}

#[test]
fn the_next_run_reads_what_the_answer_showed_and_what_the_person_changed() {
    let trip = read(&zoo_trip()).unwrap();
    let list = read(&json!({"kind": "checklist", "title": "Before Wednesday", "items": [{"text": "Print 32 copies"}, {"text": "Read the words aloud"}]})).unwrap();
    let widgets = [
        kept(
            1,
            trip,
            Some(json!({"values": {"pupils": 25, "round_up": true}})),
            Some("2026-11-05T10:05:00Z"),
        ),
        kept(
            2,
            list,
            Some(json!({"checked": [true, false]})),
            Some("2026-11-05T10:06:00Z"),
        ),
    ];
    assert_eq!(
        showed(&widgets).unwrap(),
        "[Under this answer: a calculator \"Zoo trip: cost per family\" (Each family pays = \
         140,000 ₫); a checklist \"Before Wednesday\" (2 items).]"
    );
    assert_eq!(
        changes("Mai", "1a2b3c4d", &widgets, "2026-11-05T11:00:00Z").unwrap(),
        "Mai changed what is under the answer of work 1a2b3c4d: \"Zoo trip: cost per family\": Pupils 25, Bus \
         2,400,000 ₫, Ticket 60,000 ₫, Round up on → Each family pays = 160,000 ₫. In \"Before \
         Wednesday\", ticked: Print 32 copies (of 2)."
    );
    // A change made after the new run was created is the run after's.
    assert_eq!(
        changes("Mai", "1a2b3c4d", &widgets, "2026-11-05T10:05:30Z").unwrap(),
        "Mai changed what is under the answer of work 1a2b3c4d: \"Zoo trip: cost per family\": Pupils 25, Bus \
         2,400,000 ₫, Ticket 60,000 ₫, Round up on → Each family pays = 160,000 ₫."
    );
    assert_eq!(
        changes("Mai", "1a2b3c4d", &widgets, "2026-11-05T10:00:00Z"),
        None
    );
    assert_eq!(showed(&[]), None);
}

#[test]
fn many_changes_stay_short() {
    let list = |title: &str| {
        read(&json!({"kind": "checklist", "title": title, "items": [{"text": "x".repeat(150)}]}))
            .unwrap()
    };
    let widgets: Vec<Kept> = (1..=4)
        .map(|n| {
            kept(
                n,
                list(&format!("List {n}")),
                Some(json!({"checked": [true]})),
                Some("2026-11-05T10:00:00Z"),
            )
        })
        .collect();
    let line = changes("Mai", "1a2b3c4d", &widgets, "2026-11-05T11:00:00Z").unwrap();
    assert!(line.chars().count() <= limits::CHANGES_CHARS + 20, "{line}");
    assert!(line.ends_with("more."), "{line}");
}

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
    let told = shown(&widget, 1);
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
        (json!({"kind": "map", "title": "x"}), "isn't a widget"),
        (
            json!({"kind": "chart", "title": "x", "bars": [{"label": "a", "value": 1}]}),
            "bars has 1; give 2 to 12",
        ),
        (
            json!({"kind": "chart", "title": "x", "bars": [{"label": "a", "value": 1}, {"label": "b"}]}),
            "bars 2: value is missing",
        ),
        (
            json!({"kind": "chart", "title": "x", "bars": [{"label": "a", "value": 1}, {"label": "b", "value": "51"}]}),
            "bars 2: value is a number",
        ),
        (
            json!({"kind": "chart", "title": "x", "decimals": 9, "bars": [{"label": "a", "value": 1}, {"label": "b", "value": 2}]}),
            "decimals is a whole number from 0 to",
        ),
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

fn senate() -> Value {
    json!({
        "kind": "chart",
        "title": "US Senate after the midterms",
        "unit": "seats",
        "bars": [
            {"label": "Democrats", "value": 51, "note": "+4"},
            {"label": "Republicans", "value": 49, "note": "−4"}
        ],
        "options": [{"label": "ignored"}]
    })
}

/// A chart reads its bars and one unit for all of them; the agent is told the figures as the person
/// reads them, and the next run's conversation says them too. It keeps nothing.
#[test]
fn a_chart_is_checked_and_its_figures_said_as_the_person_reads_them() {
    let chart = read(&senate()).expect("a good chart");
    assert_eq!(chart.kind(), "chart");
    assert_eq!(
        serde_json::to_value(&chart).unwrap(),
        json!({
            "kind": "chart",
            "title": "US Senate after the midterms",
            "unit": "seats",
            "bars": [
                {"label": "Democrats", "value": 51.0, "note": "+4"},
                {"label": "Republicans", "value": 49.0, "note": "−4"}
            ]
        }),
        "only a chart's own fields are kept"
    );
    let told = shown(&chart, 1);
    assert_eq!(told["shown"], "a chart \"US Senate after the midterms\"");
    assert_eq!(told["bars"], "Democrats 51 seats; Republicans 49 seats");
    assert!(told.get("results").is_none());

    let markets = read(&json!({
        "kind": "chart", "title": "Markets on Wednesday", "unit": "%", "decimals": 1,
        "bars": [{"label": "S&P 500", "value": 2.36}, {"label": "Nikkei", "value": -0.4}]
    }))
    .unwrap();
    assert_eq!(shown(&markets, 1)["bars"], "S&P 500 2.4 %; Nikkei -0.4 %");
    assert_eq!(
        showed(&[kept(1, chart.clone(), None, None)]).unwrap(),
        "[Under this answer: a chart \"US Senate after the midterms\" (Democrats 51 seats; \
         Republicans 49 seats).]"
    );
    assert!(
        read_state(&chart, &json!({})).is_err(),
        "a chart keeps nothing"
    );
    assert_eq!(
        changes(
            "Mai",
            "1a2b3c4d",
            &[kept(
                1,
                chart,
                Some(json!({})),
                Some("2026-11-05T10:00:00Z")
            )],
            "2026-11-05T11:00:00Z"
        ),
        None
    );
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
    assert_eq!(
        shown(&widget, 1)["results"],
        "Each = 30; With a tip = 33.00"
    );
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

fn titles(widgets: &[Shown]) -> Vec<&str> {
    widgets.iter().map(|shown| shown.widget.title()).collect()
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
        line: None,
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
        changes(
            "Mai",
            "the answer of work 1a2b3c4d",
            &widgets,
            "2026-11-05T11:00:00Z"
        )
        .unwrap(),
        "Mai changed what is under the answer of work 1a2b3c4d: \"Zoo trip: cost per family\": Pupils 25, Bus \
         2,400,000 ₫, Ticket 60,000 ₫, Round up on → Each family pays = 160,000 ₫. In \"Before \
         Wednesday\", ticked: Print 32 copies (of 2)."
    );
    // A change made after the new run was created is the run after's.
    assert_eq!(
        changes(
            "Mai",
            "the answer of work 1a2b3c4d",
            &widgets,
            "2026-11-05T10:05:30Z"
        )
        .unwrap(),
        "Mai changed what is under the answer of work 1a2b3c4d: \"Zoo trip: cost per family\": Pupils 25, Bus \
         2,400,000 ₫, Ticket 60,000 ₫, Round up on → Each family pays = 160,000 ₫."
    );
    assert_eq!(
        changes(
            "Mai",
            "the answer of work 1a2b3c4d",
            &widgets,
            "2026-11-05T10:00:00Z"
        ),
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
    let line = changes(
        "Mai",
        "the answer of work 1a2b3c4d",
        &widgets,
        "2026-11-05T11:00:00Z",
    )
    .unwrap();
    assert!(line.chars().count() <= limits::CHANGES_CHARS + 20, "{line}");
    assert!(line.ends_with("more."), "{line}");
}

/// The relevance calculator a person taps through: five switches in one row, two results with a
/// line saying why, and a button that sets a case worth trying.
fn relevance() -> Value {
    json!({
        "kind": "calculator",
        "title": "Select relevant documents",
        "inputs": [
            {"id": "d1", "label": "#1", "on": false, "group": "Relevant?"},
            {"id": "d2", "label": "#2", "on": true, "group": "Relevant?"},
            {"id": "d3", "label": "#3", "on": true, "group": "Relevant?"},
            {"id": "d4", "label": "#4", "on": true, "group": "Relevant?"},
            {"id": "d5", "label": "#5", "on": false, "group": "Relevant?"}
        ],
        "results": [
            {"id": "found", "label": "Recall@5", "formula": "(d1 + d2 + d3 + d4 + d5) / 3", "decimals": 3, "note": "{d1 + d2 + d3 + d4 + d5} / 3 found"},
            {"id": "rr", "label": "RR@5", "formula": "if(d1, 1, if(d2, 1/2, if(d3, 1/3, 0)))", "decimals": 3, "note": "First at #{if(d1, 1, if(d2, 2, 3))}"}
        ],
        "presets": [{"label": "Try moving relevant documents to the top", "values": {"d1": true, "d2": true, "d3": true, "d4": false}}]
    })
}

#[test]
fn a_result_says_why_and_a_preset_is_worked_out_for_the_agent() {
    let widget = read(&relevance()).expect("a good calculator");
    let told = shown(&widget, 2);
    assert_eq!(told["place"], "{{widget 2}}");
    assert_eq!(
        told["results"],
        "Recall@5 = 1.000 (3 / 3 found); RR@5 = 0.500 (First at #2)"
    );
    assert_eq!(
        told["presets"],
        json!([
            "Try moving relevant documents to the top → Recall@5 = 1.000 (3 / 3 found); RR@5 = 1.000 (First at #1)"
        ]),
        "a preset sets what it names and puts the rest back to the start"
    );
    let Widget::Calculator { inputs, .. } = &widget else {
        panic!("a calculator");
    };
    assert_eq!(inputs[0].group.as_deref(), Some("Relevant?"));
}

/// A change to the relevance calculator that should be refused.
type Change<'a> = &'a dyn Fn(&mut Value);

#[test]
fn notes_presets_and_groups_say_what_to_change() {
    let with = |change: &dyn Fn(&mut Value)| {
        let mut widget = relevance();
        change(&mut widget);
        read(&widget).expect_err("refused")
    };
    let cases: [(Change, &str); 7] = [
        (
            &|w| w["results"][0]["note"] = json!("{d1 + d9} found"),
            "result \"Recall@5\"'s note reads \"d9\", which isn't an input or a result above it",
        ),
        (
            &|w| w["results"][0]["note"] = json!("{d1 found"),
            "result \"Recall@5\"'s note: a { in a note needs a } after its formula",
        ),
        (
            &|w| w["results"][0]["note"] = json!("{rr}"),
            "reads \"rr\", which isn't an input or a result above it",
        ),
        (
            &|w| w["presets"][0]["values"] = json!({"d9": true}),
            "preset \"Try moving relevant documents to the top\": \"d9\" isn't one of the calculator's inputs",
        ),
        (
            &|w| w["presets"][0]["values"] = json!({"d1": 1}),
            "\"d1\" is a switch: true or false",
        ),
        (
            &|w| w["inputs"][2]["group"] = json!("Other"),
            "group \"Relevant?\": put its switches next to each other",
        ),
        (
            &|w| {
                w["inputs"][0] =
                    json!({"id": "d1", "label": "#1", "start": 1, "group": "Relevant?"});
            },
            "group is for switches",
        ),
    ];
    for (change, says) in cases {
        let error = with(change);
        assert!(error.contains(says), "{error:?} should say {says:?}");
    }
    // A preset whose figures can't be worked out is refused too.
    let error = read(&json!({
        "kind": "calculator", "title": "Share",
        "inputs": [{"id": "people", "label": "People", "start": 2}],
        "results": [{"id": "each", "label": "Each", "formula": "100 / people"}],
        "presets": [{"label": "Nobody comes", "values": {"people": 0}}]
    }))
    .expect_err("refused");
    assert!(
        error.contains("result \"Each\" with preset \"Nobody comes\": the formula divides by zero"),
        "{error}"
    );
}

#[test]
fn marks_a_flow_and_a_graph_are_read_and_checked() {
    let marks = read(&json!({
        "kind": "marks", "title": "Top 5 retrieved documents",
        "cells": [{"label": "#1", "mark": "no", "note": "Irrelevant"}, {"label": "#2", "mark": "yes", "note": "Relevant"}, {"label": "#3", "mark": "neither"}],
        "facts": ["2 relevant documents retrieved out of 3", "First relevant at #2"]
    }))
    .expect("good marks");
    assert_eq!(marks.kind(), "marks");
    let flow = read(&json!({
        "kind": "flow", "title": "A RAG pipeline",
        "boxes": [{"label": "User query"}, {"label": "Retriever", "note": "Recall@K: coverage"}, {"label": "Reranker", "note": "MRR@K: ranking quality"}]
    }))
    .expect("a good flow");
    let graph = read(&json!({
        "kind": "graph", "title": "Rent", "style": "line", "labels": ["Jan", "Feb", "Mar"],
        "series": [{"label": "Flat", "values": [1200, 1250, 1300]}], "prefix": "$"
    }))
    .expect("a good graph");
    let widgets = [
        kept(1, marks, None, None),
        kept(2, flow, None, None),
        kept(3, graph.clone(), None, None),
    ];
    assert_eq!(
        showed(&widgets).unwrap(),
        "[Under this answer: a row of marks \"Top 5 retrieved documents\" (#1 no, #2 yes, #3 \
         neither, 2 relevant documents retrieved out of 3, First relevant at #2); a flow \"A RAG \
         pipeline\" (User query → Retriever → Reranker); a line graph \"Rent\" (Flat: Jan $1,200, \
         Feb $1,250, Mar $1,300).]"
    );
    assert!(
        read_state(&graph, &json!({"values": {}})).is_err(),
        "a graph keeps nothing"
    );

    let cases = [
        (
            json!({"kind": "marks", "title": "x", "cells": [{"label": "a", "mark": "maybe"}]}),
            "cells 1: mark is yes, no or neither",
        ),
        (
            json!({"kind": "marks", "title": "x", "cells": [{"label": "a", "mark": "yes"}], "facts": ["a", "b", "c", "d"]}),
            "facts has 4; give 0 to 3",
        ),
        (
            json!({"kind": "flow", "title": "x", "boxes": [{"label": "only"}]}),
            "boxes has 1; give 2 to 8",
        ),
        (
            json!({"kind": "graph", "title": "x", "style": "pie", "labels": ["a", "b"], "series": [{"label": "s", "values": [1, 2]}]}),
            "style is bar or line",
        ),
        (
            json!({"kind": "graph", "title": "x", "style": "bar", "labels": ["a", "b"], "series": [{"label": "s", "values": [1]}]}),
            "series 1: values has 1; give 2, one per label",
        ),
        (
            json!({"kind": "graph", "title": "x", "style": "bar", "labels": ["a", "b"], "series": [{"label": "s", "values": [1, "two"]}]}),
            "each value is a number",
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

fn shown_at(places: &[Option<u32>]) -> Vec<Shown> {
    places
        .iter()
        .map(|place| Shown {
            place: *place,
            widget: read(&json!({"kind": "checklist", "title": "x", "items": [{"text": "one"}]}))
                .unwrap(),
        })
        .collect()
}

/// Every case in `schemas/widget-place.cases.json`, which the app reads too: it places widgets the
/// same way while the answer is still being written.
#[test]
fn a_place_line_puts_its_widget_there_as_the_app_does() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../../schemas/widget-place.cases.json"))
            .expect("schemas/widget-place.cases.json holds the cases");
    let cases = cases["cases"].as_array().expect("cases");
    assert!(cases.len() > 5, "the cases are all read");
    for case in cases {
        let name = case["name"].as_str().unwrap_or_default();
        let places: Vec<Option<u32>> = case["places"]
            .as_array()
            .expect("places")
            .iter()
            .map(|place| place.as_u64().map(|place| u32::try_from(place).unwrap()))
            .collect();
        let (words, at) = place(case["reply"].as_str().expect("a reply"), &shown_at(&places));
        assert_eq!(words, case["words"].as_str().expect("words"), "{name}");
        let lines: Vec<Option<u32>> = case["lines"]
            .as_array()
            .expect("lines")
            .iter()
            .map(|line| line.as_u64().map(|line| u32::try_from(line).unwrap()))
            .collect();
        assert_eq!(at, lines, "{name}");
    }
}

#[test]
fn the_place_comes_from_what_the_agent_was_told() {
    let mut events = Vec::new();
    turn(&mut events, "work", &["a", "b"]);
    let mut seq = events.len() as u64;
    for event in &mut events {
        if event.kind == EventKind::ToolUpdate {
            seq += 1;
            event.payload["rawOutput"] = json!({"place": place_line(u32::try_from(seq).unwrap())});
        }
    }
    let places: Vec<Option<u32>> = of_answer(&events, Some("writer"))
        .iter()
        .map(|shown| shown.place)
        .collect();
    let told = u32::try_from(events.len()).unwrap();
    assert_eq!(places, [Some(told + 1), Some(told + 2)]);
}

#[test]
fn a_place_line_never_shows_when_no_widget_was_kept() {
    assert_eq!(
        without_place_lines("Here it is.\n\n{{widget 1}}\n\nTry it."),
        "Here it is.\n\nTry it."
    );
    let plain = "No widgets, {{braces}} and a last line\n";
    assert_eq!(
        without_place_lines(plain),
        plain,
        "words with none are kept exactly"
    );
}

fn plans() -> Value {
    json!({
        "kind": "compare", "title": "Two phone plans",
        "whole": {"label": "Your family's lines", "note": "Four phones"},
        "sides": [
            {"label": "Basic", "value": 4.0, "note": "Shared data"},
            {"label": "Unlimited", "value": 12.0, "note": "Each line its own"}
        ],
        "rows": [
            {"label": "Data", "values": ["20 GB shared", "Unlimited"]},
            {"label": "Calls abroad", "values": ["Paid by the minute", "Included"]}
        ],
        "unit": "lines", "counted": true
    })
}

#[test]
fn a_comparison_is_read_checked_and_told_back() {
    let widget = read(&plans()).expect("a good comparison");
    assert_eq!(widget.kind(), "compare");
    assert_eq!(
        serde_json::to_value(&widget).unwrap(),
        plans(),
        "kept as the agent gave it"
    );
    let told = shown(&widget, 2);
    assert_eq!(told["shown"], "a comparison \"Two phone plans\"");
    assert_eq!(told["figures"], "Basic 4 lines; Unlimited 12 lines");
    assert_eq!(told["place"], "{{widget 2}}");
    assert_eq!(
        showed(&[kept(1, widget.clone(), None, None)]).unwrap(),
        "[Under this answer: a comparison \"Two phone plans\" (Your family's lines: Basic 4 \
         lines, Unlimited 12 lines; Data: 20 GB shared | Unlimited; Calls abroad: Paid by the \
         minute | Included).]"
    );
    assert!(
        read_state(&widget, &json!({"checked": []})).is_err(),
        "a comparison keeps nothing"
    );

    // Without figures, the sides are named and the rows carry it.
    let words = read(&json!({
        "kind": "compare", "title": "TCP or UDP",
        "sides": [{"label": "TCP"}, {"label": "UDP"}],
        "rows": [{"label": "Order", "values": ["Kept", "Not kept"]}]
    }))
    .expect("a comparison of words");
    assert!(shown(&words, 1).get("figures").is_none());
    assert_eq!(
        showed(&[kept(1, words, None, None)]).unwrap(),
        "[Under this answer: a comparison \"TCP or UDP\" (TCP, UDP; Order: Kept | Not kept).]"
    );
}

#[test]
fn a_bad_comparison_says_what_to_change() {
    let with = |change: &dyn Fn(&mut Value)| {
        let mut arguments = plans();
        change(&mut arguments);
        read(&arguments).expect_err(&format!("{arguments} should be refused"))
    };
    let cases: [(Change, &str); 9] = [
        (
            &|w| w["sides"] = json!([{"label": "Only", "value": 1}]),
            "sides has 1; give 2 to 3",
        ),
        (
            &|w| {
                w["sides"] = json!([{"label": "a", "value": 1}, {"label": "b", "value": 2}, {"label": "c", "value": 3}, {"label": "d", "value": 4}]);
                w.as_object_mut().unwrap().remove("rows");
            },
            "sides has 4; give 2 to 3",
        ),
        (
            &|w| {
                w["sides"][1].as_object_mut().unwrap().remove("value");
            },
            "1 of 2 sides have a value: give every side a value in the same unit, or none",
        ),
        (
            &|w| w["rows"][0]["values"] = json!(["only one"]),
            "rows 1: values has 1; give 2, one per side in their order",
        ),
        (
            &|w| w["rows"][0]["values"] = json!(["a", "b", "c"]),
            "rows 1: values has 3; give 2, one per side in their order",
        ),
        (
            &|w| w["sides"][0]["value"] = json!(2.5),
            "counted figures are whole numbers of things",
        ),
        (
            &|w| w["sides"][0]["value"] = json!(-1),
            "counted figures are whole numbers of things",
        ),
        (
            &|w| {
                w["sides"] = json!([{"label": "a"}, {"label": "b"}]);
            },
            "counted draws the sides' values: give each side a value",
        ),
        (&|w| w["whole"] = json!("Congress"), "whole is"),
    ];
    for (change, says) in cases {
        let error = with(change);
        assert!(error.contains(says), "{error:?} should say {says:?}");
    }
    let nothing = read(&json!({
        "kind": "compare", "title": "x", "sides": [{"label": "a"}, {"label": "b"}]
    }))
    .expect_err("nothing to compare");
    assert!(
        nothing.contains("a comparison needs something to compare"),
        "{nothing}"
    );
}

#[test]
fn a_chart_of_whole_things_may_be_counted() {
    let mut arguments = senate();
    arguments["counted"] = json!(true);
    let counted = read(&arguments).expect("whole seats can be counted");
    assert!(matches!(counted, Widget::Chart { counted: true, .. }));
    assert_eq!(serde_json::to_value(&counted).unwrap()["counted"], true);
    let plain = read(&senate()).unwrap();
    assert!(
        serde_json::to_value(&plain)
            .unwrap()
            .get("counted")
            .is_none(),
        "a chart that isn't counted keeps no field for it"
    );
    arguments["bars"][0]["value"] = json!(-2);
    assert!(
        read(&arguments)
            .unwrap_err()
            .contains("counted figures are whole numbers of things"),
        "a count is never below zero"
    );
    arguments["bars"][0]["value"] = json!(50.5);
    let error = read(&arguments).expect_err("half a seat isn't counted");
    assert!(
        error.contains("counted figures are whole numbers of things"),
        "{error}"
    );
    arguments["counted"] = json!("yes");
    assert!(
        read(&arguments)
            .unwrap_err()
            .contains("counted is true or false")
    );
}

/// The agent picks a kind by the shape of what it tells: every kind the tool offers has its line
/// in the tool's guide and in the answering agent's habit, and is read, not refused.
#[test]
fn every_kind_the_tool_offers_has_its_place_in_the_guide() {
    let tool = tool_definition();
    let kinds: Vec<&str> = tool["inputSchema"]["properties"]["kind"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|kind| kind.as_str().unwrap())
        .collect();
    assert_eq!(kinds.len(), 10);
    let guide = SHOW_WIDGET.default_text();
    let habit = crate::agent::prompt::WIDGETS.default_text();
    let kind_line = SHOW_WIDGET_KIND.default_text();
    for kind in &kinds {
        assert!(
            guide
                .lines()
                .any(|line| line.starts_with("- ") && line.ends_with(&format!(": {kind}"))),
            "the guide has a line ending in \": {kind}\""
        );
        assert!(
            habit.contains(&format!("{kind} for ")),
            "the habit says what {kind} is for"
        );
        assert!(kind_line.contains(kind), "kind's description names {kind}");
        let error = read(&json!({"kind": kind, "title": "x"})).unwrap_err();
        assert!(!error.contains("isn't a widget"), "{kind} is read: {error}");
    }
    assert!(
        guide.contains("parts that sit side by side")
            && guide.contains("are shown with compare, not flow"),
        "the guide says a flow is not for parts side by side"
    );
    // ADR 0117: something to see is drawn. The picture is offered before the flow in the guide
    // and the habit, and the flow is for what has nothing to see: a live model drew a plane's
    // take-off as three boxes in a flow while the picture came after it.
    let at = |text: &str, words: &str| text.find(words).unwrap_or(usize::MAX);
    assert!(at(guide, ": picture") < at(guide, ": flow"), "{guide}");
    assert!(
        guide.contains("when there is nothing to see: flow"),
        "{guide}"
    );
    assert!(
        at(habit, "a picture for") < at(habit, "a flow for"),
        "{habit}"
    );
}

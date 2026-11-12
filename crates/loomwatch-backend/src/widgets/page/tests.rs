use serde_json::json;

use super::super::{
    Kept, changes, read_for, read_state as read_widget_state, showed, shown, tool_definition_for,
};
use super::*;

/// A pendulum on Earth and on the Moon: no kind draws one that swings.
fn pendulum() -> Value {
    json!({
        "kind": "page",
        "title": "How the length sets a pendulum's swing",
        "why": "A pendulum that swings at the length you set, on Earth and on the Moon.",
        "inputs": [
            {"id": "length", "label": "Length", "start": 1, "min": 0.2, "max": 3, "step": 0.1, "unit": "m"}
        ],
        "results": [
            {"id": "earth", "label": "One swing on Earth", "formula": "2 * pi * sqrt(length / 9.81)", "unit": "s", "decimals": 1},
            {"id": "moon", "label": "On the Moon", "formula": "2 * pi * sqrt(length / 1.62)", "unit": "s", "decimals": 1}
        ],
        "presets": [
            {"label": "A playground swing, 2.5 m", "values": {"length": 2.5}}
        ],
        "html": "<div class=\"lw-row\"><span data-result=\"earth\"></span></div><canvas data-canvas=\"swing\"></canvas>",
        "script": "lw.canvas('swing', (ctx, w, h, t) => { ctx.clearRect(0, 0, w, h) })"
    })
}

fn page(arguments: &Value) -> Result<Widget, String> {
    read_for(arguments, true)
}

#[test]
fn a_page_is_read_and_its_figures_worked_out_and_told_to_the_agent() {
    let widget = page(&pendulum()).expect("a good page");
    assert_eq!(widget.kind(), "page");
    let told = shown(&widget, 1);
    assert_eq!(
        told["shown"],
        "a drawing \"How the length sets a pendulum's swing\""
    );
    assert_eq!(
        told["results"],
        "One swing on Earth = 2.0 s; On the Moon = 4.9 s"
    );
    assert_eq!(
        told["presets"],
        json!(["A playground swing, 2.5 m → One swing on Earth = 3.2 s; On the Moon = 7.8 s"])
    );
    assert!(
        told["checked"]
            .as_str()
            .is_some_and(|said| said.contains("data-result")),
        "{told}"
    );
}

#[test]
fn a_page_keeps_its_html_script_and_why_for_the_app() {
    let widget = page(&pendulum()).expect("a good page");
    let kept = serde_json::to_value(&widget).expect("serialised");
    assert_eq!(kept["kind"], "page");
    assert_eq!(
        kept["why"],
        "A pendulum that swings at the length you set, on Earth and on the Moon."
    );
    assert!(
        kept["html"]
            .as_str()
            .is_some_and(|html| html.contains("data-canvas"))
    );
    assert!(
        kept["script"]
            .as_str()
            .is_some_and(|script| script.contains("lw.canvas"))
    );
    let back: Widget = serde_json::from_value(kept).expect("read back");
    assert_eq!(back, widget);
}

#[test]
fn a_page_is_only_a_widget_when_pages_are_offered() {
    let refused = read_for(&pendulum(), false).expect_err("not offered");
    assert!(refused.contains("isn't a widget"), "{refused}");
    assert!(!refused.contains("page,"), "{refused}");
    let other =
        read_for(&json!({"kind": "poster", "title": "A poster"}), true).expect_err("no kind");
    assert!(other.contains("use page, compare"), "{other}");
}

#[test]
fn the_tool_offers_a_page_only_when_pages_are_offered() {
    let without = tool_definition_for(false);
    let kinds = without["inputSchema"]["properties"]["kind"]["enum"].clone();
    assert!(!kinds.as_array().expect("kinds").contains(&json!("page")));
    assert!(without["inputSchema"]["properties"].get("script").is_none());
    assert_eq!(without["description"], super::super::SHOW_WIDGET.text());

    let with = tool_definition_for(true);
    let kinds = with["inputSchema"]["properties"]["kind"]["enum"].clone();
    assert_eq!(kinds[0], "page");
    for field in ["why", "html", "script"] {
        assert!(
            with["inputSchema"]["properties"].get(field).is_some(),
            "{field}"
        );
    }
    assert_eq!(
        with["inputSchema"]["properties"]["results"]["maxItems"],
        limits::PAGE_RESULTS.1
    );
    assert!(
        with["description"]
            .as_str()
            .is_some_and(|said| said.ends_with(super::super::SHOW_WIDGET_PAGES.text()))
    );
}

#[test]
fn a_page_needs_why_and_something_to_draw_within_its_limit() {
    let mut no_why = pendulum();
    no_why.as_object_mut().expect("object").remove("why");
    assert!(page(&no_why).expect_err("why").contains("why is missing"));

    let mut nothing = pendulum();
    let fields = nothing.as_object_mut().expect("object");
    fields.remove("html");
    fields.remove("script");
    assert!(
        page(&nothing)
            .expect_err("empty")
            .contains("give html, script or both")
    );

    let mut long = pendulum();
    long["html"] = json!("x".repeat(30_000));
    long["script"] = json!("y".repeat(10_001));
    let refused = page(&long).expect_err("too long");
    assert!(refused.contains("40001 characters together"), "{refused}");

    let mut script_only = pendulum();
    script_only.as_object_mut().expect("object").remove("html");
    assert!(page(&script_only).is_ok());
}

#[test]
fn a_page_may_have_no_figures_at_all() {
    let drawing = json!({
        "kind": "page",
        "title": "How a heart pumps",
        "why": "The heart's four chambers filling and squeezing in turn.",
        "script": "lw.frame((t) => lw.draw('<svg></svg>'))"
    });
    let widget = page(&drawing).expect("a page with no figures");
    let told = shown(&widget, 2);
    assert!(told.get("results").is_none(), "{told}");
    assert!(told.get("checked").is_none(), "{told}");
    let kept = Kept {
        n: 1,
        line: None,
        spec: widget,
        state: None,
        changed_at: None,
    };
    assert_eq!(
        showed(std::slice::from_ref(&kept)).as_deref(),
        Some("[Under this answer: a drawing \"How a heart pumps\".]")
    );
}

#[test]
fn a_formula_that_breaks_at_the_end_of_its_range_is_refused_with_the_input_that_broke_it() {
    let savings = json!({
        "kind": "page",
        "title": "What your savings grow to",
        "why": "A line of savings that bends as the rate changes.",
        "inputs": [
            {"id": "monthly", "label": "Each month", "start": 200, "min": 0, "max": 2000, "prefix": "$"},
            {"id": "rate", "label": "Yearly return", "start": 5, "min": 0, "max": 12, "unit": "%"},
            {"id": "years", "label": "Years", "start": 20, "min": 1, "max": 40}
        ],
        "results": [
            {"id": "have", "label": "You'd have", "formula": "monthly * 12 * (pow(1 + rate / 100, years) - 1) / (rate / 100)", "prefix": "$", "decimals": 0}
        ],
        "html": "<span data-result=\"have\"></span>"
    });
    let refused = page(&savings).expect_err("divides by zero at a rate of 0");
    assert!(refused.contains("result \"You'd have\""), "{refused}");
    assert!(refused.contains("Yearly return 0 %"), "{refused}");
    assert!(refused.contains("divides by zero"), "{refused}");
    assert!(refused.contains("if()"), "{refused}");

    let mut mended = savings.clone();
    mended["results"][0]["formula"] = json!(
        "if(rate > 0, monthly * 12 * (pow(1 + rate / 100, years) - 1) / (rate / 100), monthly * 12 * years)"
    );
    let widget = page(&mended).expect("works everywhere now");
    assert_eq!(shown(&widget, 1)["results"], "You'd have = $79,358");
}

#[test]
fn a_switch_is_tried_both_ways_and_a_number_with_no_range_stays_at_its_start() {
    let stop = json!({
        "kind": "page",
        "title": "Stopping distance",
        "why": "A car on a road with its stretches drawn to length.",
        "inputs": [
            {"id": "speed", "label": "Speed", "start": 50, "unit": "km/h"},
            {"id": "wet", "label": "Wet road", "on": false}
        ],
        "results": [
            {"id": "brake", "label": "Braking", "formula": "speed * speed / if(wet, 0, 14)"}
        ],
        "html": "<span data-result=\"brake\"></span>"
    });
    let refused = page(&stop).expect_err("divides by zero when wet");
    assert!(refused.contains("Wet road on"), "{refused}");
    assert!(
        !refused.contains("Speed"),
        "a speed with no range isn't varied: {refused}"
    );
}

#[test]
fn past_six_inputs_each_end_is_tried_alone() {
    let inputs: Vec<Value> = (1..=7)
        .map(|n| json!({"id": format!("a{n}"), "label": format!("A{n}"), "start": 1, "min": 1, "max": 2}))
        .collect();
    let wide = json!({
        "kind": "page",
        "title": "Seven dials",
        "why": "Seven dials at once.",
        "inputs": inputs,
        "results": [{"id": "sum", "label": "Sum", "formula": "1 / (a7 - 2)"}],
        "html": "<span data-result=\"sum\"></span>"
    });
    let refused = page(&wide).expect_err("a7 at its max divides by zero");
    assert!(refused.contains("with A7 2:"), "{refused}");
}

#[test]
fn a_page_s_figures_get_a_calculator_s_checks() {
    let mut unknown = pendulum();
    unknown["results"][0]["formula"] = json!("2 * pi * sqrt(length / gravity)");
    let refused = page(&unknown).expect_err("gravity isn't declared");
    assert!(refused.contains("reads \"gravity\""), "{refused}");

    let mut stray = pendulum();
    stray["presets"][0]["values"] = json!({"mass": 2});
    let refused = page(&stray).expect_err("mass isn't an input");
    assert!(
        refused.contains("preset \"A playground swing, 2.5 m\""),
        "{refused}"
    );
}

#[test]
fn pi_is_known_and_no_input_may_be_called_pi() {
    let mut named_pi = pendulum();
    named_pi["inputs"][0]["id"] = json!("pi");
    assert!(page(&named_pi).expect_err("pi").contains("the number pi"));
}

#[test]
fn presets_need_inputs_to_set() {
    let lonely = json!({
        "kind": "page",
        "title": "A preset alone",
        "why": "Nothing to set.",
        "presets": [{"label": "Try this", "values": {"x": 1}}],
        "html": "<p>Hi</p>"
    });
    assert!(
        page(&lonely)
            .expect_err("no inputs")
            .contains("declare the inputs")
    );
}

#[test]
fn a_page_keeps_what_the_person_set_and_that_it_broke_and_the_next_run_is_told() {
    let widget = page(&pendulum()).expect("a good page");
    let state = read_widget_state(&widget, &json!({"values": {"length": 2.5}})).expect("kept");
    assert_eq!(state, json!({"values": {"length": 2.5}}));
    assert!(
        read_widget_state(&widget, &json!({"values": {"length": 9}}))
            .expect_err("past max")
            .contains("outside its min and max")
    );
    assert!(
        read_widget_state(&widget, &json!({"values": {"mass": 1}}))
            .expect_err("not declared")
            .contains("isn't one of the page's inputs")
    );
    let broke = read_widget_state(
        &widget,
        &json!({"broke": format!("  ReferenceError: ctx is not defined{}", " ".repeat(5))}),
    )
    .expect("kept");
    assert_eq!(
        broke,
        json!({"broke": "ReferenceError: ctx is not defined"})
    );
    let long = read_widget_state(&widget, &json!({"broke": "x".repeat(500)})).expect("cut");
    assert_eq!(
        long["broke"].as_str().map(str::len),
        Some(limits::BROKE_CHARS)
    );
    assert!(read_widget_state(&widget, &json!({})).is_err());

    let kept = Kept {
        n: 1,
        line: None,
        spec: widget,
        state: Some(json!({"values": {"length": 2.5}, "broke": "it ran too long"})),
        changed_at: Some("2026-11-12T10:00:00Z".to_owned()),
    };
    let line = changes(
        "Mai",
        "the answer",
        std::slice::from_ref(&kept),
        "2026-11-12T11:00:00Z",
    )
    .expect("a change");
    assert_eq!(
        line,
        "Mai changed what is under the answer: \"How the length sets a pendulum's swing\": \
         Length 2.5 m → One swing on Earth = 3.2 s; On the Moon = 7.8 s; it didn't draw for them \
         (it ran too long)."
    );
}

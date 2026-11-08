use serde_json::json;

use super::super::{Kept, read as read_widget, read_state, showed, shown};
use super::*;

/// Whether 38.5 °C is a fever.
fn fever() -> Value {
    json!({
        "kind": "scale",
        "title": "Is 38.5 °C a fever?",
        "unit": "°C",
        "decimals": 1,
        "ranges": [
            {"label": "Low", "from": 35, "to": 36.1},
            {"label": "Normal", "from": 36.1, "to": 37.5},
            {"label": "Fever", "from": 37.5, "to": 40}
        ],
        "pins": [{"label": "You", "value": 38.5}]
    })
}

#[test]
fn the_agent_is_told_the_range_each_figure_falls_in() {
    let widget = read_widget(&fever()).expect("a good scale");
    assert_eq!(widget.kind(), "scale");
    let told = shown(&widget, 1);
    assert_eq!(told["shown"], "a scale \"Is 38.5 °C a fever?\"");
    assert_eq!(told["pins"], "You 38.5 °C: in Fever (37.5 to 40.0 °C)");
    let kept = Kept {
        n: 1,
        line: None,
        spec: widget,
        state: None,
        changed_at: None,
    };
    assert_eq!(
        showed(&[kept]).unwrap(),
        "[Under this answer: a scale \"Is 38.5 °C a fever?\" (Low 35.0 to 36.1 °C, Normal 36.1 \
         to 37.5 °C, Fever 37.5 to 40.0 °C; You 38.5 °C: in Fever (37.5 to 40.0 °C)).]"
    );
}

#[test]
fn a_figure_where_two_ranges_meet_is_in_the_higher_and_the_top_is_in_the_last() {
    let Widget::Scale { ranges, .. } = read_widget(&fever()).unwrap() else {
        panic!("a scale");
    };
    let named = |value: f64| range_of(&ranges, value).map(|range| range.label.as_str());
    assert_eq!(named(35.0), Some("Low"));
    assert_eq!(named(37.5), Some("Fever"));
    assert_eq!(named(40.0), Some("Fever"));
    assert_eq!(named(41.0), None);
    assert_eq!(named(34.9), None);
}

#[test]
fn ranges_that_dont_meet_or_a_figure_off_the_scale_say_what_to_change() {
    let with = |change: &dyn Fn(&mut Value)| {
        let mut scale = fever();
        change(&mut scale);
        read_widget(&scale).expect_err("refused")
    };
    let gap = with(&|scale| scale["ranges"][1]["from"] = json!(36.2));
    assert!(
        gap.contains("\"Normal\" starts at 36.2, but \"Low\" ends at 36.1"),
        "{gap}"
    );
    let overlap = with(&|scale| scale["ranges"][1]["from"] = json!(36.0));
    assert!(
        overlap.contains("\"Normal\" starts at 36, but \"Low\" ends at 36.1"),
        "{overlap}"
    );
    assert!(
        with(&|scale| scale["ranges"][2] = json!({"label": "Fever", "from": 37.5, "to": 37}))
            .contains("from low to high")
    );
    assert!(
        with(&|scale| scale["ranges"][2] = json!({"label": "Fever", "from": 37.5, "to": 37.5}))
            .contains("it ends at 37.5, not above where it starts, 37.5")
    );
    assert!(
        with(&|scale| scale["pins"][0]["value"] = json!(34))
            .contains("value 34 is off the scale, which runs from 35 to 40")
    );
    assert!(
        with(&|scale| scale["pins"][0]["value"] = json!(41))
            .contains("value 41 is off the scale, which runs from 35 to 40")
    );
    assert!(
        with(&|scale| scale["ranges"] = json!([{"label": "All", "from": 0, "to": 50}]))
            .contains("ranges has 1; give 2 to 6")
    );
    assert!(with(&|scale| scale["pins"] = json!([])).contains("pins has 0; give 1 to 3"));
}

#[test]
fn a_scale_keeps_nothing() {
    let widget = read_widget(&fever()).unwrap();
    assert!(read_state(&widget, &json!({"values": {}})).is_err());
}

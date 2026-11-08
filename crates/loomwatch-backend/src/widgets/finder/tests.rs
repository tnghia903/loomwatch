use serde_json::json;

use super::super::{Kept, Widget, changes, read as read_widget, read_state, showed, shown};
use super::*;

/// Whether a visitor needs a visa for Japan, as a model would set it out: the passport first, since
/// it settles the most, then how long they stay.
fn visa() -> Value {
    json!({
        "kind": "finder",
        "title": "Do you need a visa for Japan?",
        "questions": [
            {"text": "Which passport do you hold?", "answers": [
                {"label": "US, UK or EU", "outcome": 1},
                {"label": "Vietnam", "next": 2},
                {"label": "Another", "outcome": 3}
            ]},
            {"text": "How long will you stay?", "answers": [
                {"label": "Up to 15 days", "next": 3},
                {"label": "Longer", "outcome": 3}
            ]},
            {"text": "Is it for a holiday?", "answers": [
                {"label": "Yes", "outcome": 2},
                {"label": "No, for work", "outcome": 3}
            ]}
        ],
        "outcomes": [
            {"label": "No visa needed", "text": "Stay up to 90 days on your passport."},
            {"label": "An e-visa", "text": "Apply online at least a week before you fly."},
            {"label": "A visa from the embassy"}
        ]
    })
}

fn kept(state: Value) -> Kept {
    Kept {
        n: 1,
        line: None,
        spec: read_widget(&visa()).expect("a good finder"),
        state: Some(state),
        changed_at: Some("2026-11-08T10:00:00Z".to_owned()),
    }
}

#[test]
fn a_finder_is_read_as_given_and_named_for_the_agent() {
    let widget = read_widget(&visa()).expect("a good finder");
    assert_eq!(widget.kind(), "finder");
    let Widget::Finder {
        questions,
        outcomes,
        ..
    } = &widget
    else {
        panic!("a finder");
    };
    assert_eq!(questions.len(), 3);
    assert_eq!(questions[1].answers[0].next, Some(3));
    assert_eq!(outcomes[2].text, None);
    assert_eq!(
        shown(&widget, 1)["shown"],
        "a decision guide \"Do you need a visa for Japan?\""
    );
    assert_eq!(
        serde_json::to_value(&widget).unwrap()["questions"][0]["answers"][1],
        json!({"label": "Vietnam", "next": 2})
    );
}

#[test]
fn a_finder_that_could_loop_or_strand_someone_says_what_to_change() {
    let with = |change: &dyn Fn(&mut Value)| {
        let mut finder = visa();
        change(&mut finder);
        read_widget(&finder).expect_err("refused")
    };
    // Back to an earlier question: a path that never ends.
    assert!(
        with(&|finder| finder["questions"][2]["answers"][0] = json!({"label": "Yes", "next": 1}))
            .contains("next is 1, but this is the last question: give outcome instead")
    );
    assert!(
        with(&|finder| finder["questions"][1]["answers"][0] =
            json!({"label": "Up to 15 days", "next": 2}))
        .contains("next is 2: an answer leads to a later question, 3 to 3")
    );
    assert!(
        with(&|finder| finder["questions"][0]["answers"][1] =
            json!({"label": "Vietnam", "next": 2, "outcome": 1}))
        .contains("not both")
    );
    assert!(
        with(&|finder| finder["questions"][0]["answers"][1] = json!({"label": "Vietnam"}))
            .contains("give next")
    );
    assert!(
        with(&|finder| finder["questions"][0]["answers"][0]["outcome"] = json!(4))
            .contains("outcome is 4: give the number of one of the 3 outcomes")
    );
    // Past the last question, or an outcome 0: refused with what to change, never a crash.
    assert!(
        with(&|finder| finder["questions"][0]["answers"][1]["next"] = json!(4))
            .contains("next is 4: an answer leads to a later question, 2 to 3")
    );
    assert!(
        with(&|finder| finder["questions"][0]["answers"][0]["outcome"] = json!(0))
            .contains("outcome is 0: give the number of one of the 3 outcomes")
    );
    // Nothing leads to the third question: it can never be asked.
    let unasked = with(&|finder| {
        finder["questions"][1]["answers"][0] = json!({"label": "Up to 15 days", "outcome": 2});
    });
    assert!(unasked.contains("question 3 is never reached"), "{unasked}");
    // Nothing ends at the second outcome.
    let unused = with(&|finder| finder["questions"][2]["answers"][0]["outcome"] = json!(1));
    assert!(unused.contains("outcome 2 is never reached"), "{unused}");
    assert!(
        with(&|finder| finder["questions"][0]["answers"] = json!([{"label": "Any", "outcome": 1}]))
            .contains("answers has 1; give 2 to 4")
    );
}

#[test]
fn a_finders_kept_answers_are_a_path_through_it() {
    let widget = read_widget(&visa()).unwrap();
    assert_eq!(
        read_state(&widget, &json!({"answers": [1, 0, 0]})).unwrap(),
        json!({"answers": [1, 0, 0]})
    );
    // Part of the way, or started again.
    assert!(read_state(&widget, &json!({"answers": [1]})).is_ok());
    assert!(read_state(&widget, &json!({"answers": []})).is_ok());
    // An answer the question doesn't have.
    assert!(read_state(&widget, &json!({"answers": [1, 5]})).is_err());
    // Past the outcome: "US, UK or EU" ends there.
    assert!(read_state(&widget, &json!({"answers": [0, 0]})).is_err());
    assert!(read_state(&widget, &json!({"answers": [-1]})).is_err());
    assert!(read_state(&widget, &json!({"checked": [true]})).is_err());
}

#[test]
fn the_next_run_reads_the_path_the_person_took() {
    assert_eq!(
        showed(&[kept(json!({"answers": []}))]).unwrap(),
        "[Under this answer: a decision guide \"Do you need a visa for Japan?\" (3 questions, \
         first \"Which passport do you hold?\"; outcomes: No visa needed, An e-visa, A visa from \
         the embassy).]"
    );
    let said = |state: Value| {
        changes(
            "Mai",
            "the answer of work 1a2b3c4d",
            &[kept(state)],
            "2026-11-08T11:00:00Z",
        )
        .unwrap()
    };
    assert_eq!(
        said(json!({"answers": [1, 0, 0]})),
        "Mai changed what is under the answer of work 1a2b3c4d: In \"Do you need a visa for \
         Japan?\", answered: Which passport do you hold? Vietnam; How long will you stay? Up to \
         15 days; Is it for a holiday? Yes → An e-visa."
    );
    assert_eq!(
        said(json!({"answers": [1]})),
        "Mai changed what is under the answer of work 1a2b3c4d: In \"Do you need a visa for \
         Japan?\", answered: Which passport do you hold? Vietnam, and stopped there."
    );
    assert_eq!(
        said(json!({"answers": []})),
        "Mai changed what is under the answer of work 1a2b3c4d: In \"Do you need a visa for \
         Japan?\", nothing is answered."
    );
}

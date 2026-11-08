use serde_json::json;

use super::super::{Kept, Widget, changes, read as read_widget, read_state, showed};
use super::*;

/// Two questions after an answer that explains photosynthesis.
fn photosynthesis() -> Value {
    json!({
        "kind": "quiz",
        "title": "Check yourself",
        "checks": [
            {"question": "Where does the oxygen a plant gives off come from?",
             "choices": ["Carbon dioxide", "Water", "The soil"], "answer": "Water",
             "why": "Light splits water in the leaf; the oxygen is what is left over."},
            {"question": "What does the plant make with the light's energy?",
             "choices": ["Sugar", "Salt"], "answer": "Sugar"}
        ]
    })
}

fn kept(state: Value) -> Kept {
    Kept {
        n: 2,
        line: None,
        spec: read_widget(&photosynthesis()).expect("a good quiz"),
        state: Some(state),
        changed_at: Some("2026-11-08T10:00:00Z".to_owned()),
    }
}

#[test]
fn a_quiz_keeps_its_right_answer_by_place() {
    let widget = read_widget(&photosynthesis()).expect("a good quiz");
    let Widget::Quiz { checks, .. } = &widget else {
        panic!("a quiz");
    };
    assert_eq!(checks[0].answer, 1);
    assert_eq!(checks[1].answer, 0);
    assert_eq!(checks[1].why, None);
    assert_eq!(
        serde_json::to_value(&widget).unwrap()["checks"][0]["answer"],
        json!(1)
    );
}

#[test]
fn a_quiz_with_no_right_answer_or_the_same_choice_twice_is_refused() {
    let with = |change: &dyn Fn(&mut Value)| {
        let mut quiz = photosynthesis();
        change(&mut quiz);
        read_widget(&quiz).expect_err("refused")
    };
    assert!(
        with(&|quiz| quiz["checks"][0]["answer"] = json!("Air"))
            .contains("answer is the right choice, written as in choices")
    );
    assert!(
        with(&|quiz| quiz["checks"][1]["choices"] = json!(["Sugar", "sugar"]))
            .contains("\"sugar\" is a choice twice")
    );
    assert!(
        with(&|quiz| quiz["checks"][1]["choices"] = json!(["Sugar"]))
            .contains("choices has 1; give 2 to 4")
    );
    assert!(with(&|quiz| quiz["checks"] = json!([])).contains("checks has 0; give 1 to 5"));
}

#[test]
fn a_quizs_kept_picks_are_one_for_each_question() {
    let widget = read_widget(&photosynthesis()).unwrap();
    assert_eq!(
        read_state(&widget, &json!({"picked": [0, null]})).unwrap(),
        json!({"picked": [0, null]})
    );
    assert!(read_state(&widget, &json!({"picked": [0]})).is_err());
    assert!(read_state(&widget, &json!({"picked": [3, null]})).is_err());
    assert!(read_state(&widget, &json!({"picked": ["Water", null]})).is_err());
}

#[test]
fn the_next_run_hears_what_the_person_missed() {
    assert_eq!(
        showed(&[kept(json!({"picked": [null, null]}))]).unwrap(),
        "[Under this answer: a quiz \"Check yourself\" (2 questions).]"
    );
    let said = |state: Value| {
        changes(
            "Mai",
            "Tutor's answer in the chat",
            &[kept(state)],
            "2026-11-08T11:00:00Z",
        )
        .unwrap()
    };
    assert_eq!(
        said(json!({"picked": [0, 0]})),
        "Mai changed what is under Tutor's answer in the chat: In \"Check yourself\", 1 of 2 \
         right. Missed \"Where does the oxygen a plant gives off come from?\": picked Carbon \
         dioxide; it's Water."
    );
    assert_eq!(
        said(json!({"picked": [null, 0]})),
        "Mai changed what is under Tutor's answer in the chat: In \"Check yourself\", 1 of 1 \
         right (1 not answered)."
    );
    assert_eq!(
        said(json!({"picked": [null, null]})),
        "Mai changed what is under Tutor's answer in the chat: In \"Check yourself\", nothing is \
         answered."
    );
}

// Figures here are exact tenths, as the picture writes them.
#![allow(clippy::float_cmp)]

use serde_json::json;

use super::super::{Kept, Widget, read as read_widget, read_state, showed};
use super::*;

/// How a plane takes off, as a model draws it: one plane shape, moved and turned for each stage,
/// a runway, a backdrop, words, a gradient and an arrow.
fn take_off() -> Value {
    json!({
        "kind": "picture",
        "title": "How a plane takes off",
        "drawing": concat!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 640 360\" fill=\"none\" stroke=\"#333\">",
            "<defs><linearGradient id=\"sky\"><stop offset=\"0\" stop-color=\"#9cf\"/></linearGradient>",
            "<marker id=\"head\"><path d=\"M0 0L10 5L0 10z\"/></marker></defs>",
            "<rect width=\"640\" height=\"360\" fill=\"url(#sky)\"/>",
            "<title>Take-off</title>",
            "<line x1=\"20\" y1=\"320\" x2=\"620\" y2=\"320\" stroke-dasharray=\"12 8\"/>",
            "<g data-part=\"1\" transform=\"translate(60 300)\">",
            "  <path d=\"M0 0 h80 q10 0 10 -6 l-20 -4 h-60 z\" fill=\"#eee\"/>",
            "  <circle cx=\"20\" cy=\"6\" r=\"4\" fill=\"#222\"/>",
            "</g>",
            "<g data-part=\"2\" transform=\"translate(260 290) rotate(-10)\">",
            "  <path d=\"M0 0 h80 q10 0 10 -6 l-20 -4 h-60 z\" fill=\"#eee\"/>",
            "</g>",
            "<g data-part=\"3\" transform=\"translate(470 200) rotate(-20)\">",
            "  <path d=\"M0 0 h80 q10 0 10 -6 l-20 -4 h-60 z\" fill=\"#eee\"/>",
            "</g>",
            "<path data-part=\"2\" d=\"M300 330 v-40\" marker-end=\"url(#head)\"/>",
            "<text x=\"10\" y=\"20\">Runway</text>",
            "</svg>"
        ),
        "parts": [
            {"label": "Speed up", "text": "The engines push the plane along the runway."},
            {"label": "Lift", "text": "Air under the wings pushes them up.", "at": [330, 250]},
            {"label": "Climb", "text": "The nose rises and the plane leaves the ground."}
        ]
    })
}

fn picture(arguments: &Value) -> (f64, Vec<Shape>, Vec<Part>) {
    match read_widget(arguments) {
        Ok(Widget::Picture {
            width,
            height,
            shapes,
            parts,
            ..
        }) => {
            assert!((width - WIDTH).abs() < f64::EPSILON);
            (height, shapes, parts)
        }
        other => panic!("a picture, not {other:?}"),
    }
}

fn drawing(svg: &str) -> Value {
    json!({"kind": "picture", "title": "x", "drawing": svg})
}

/// The one shape of `svg` as read, in the drawing's own units: before it is framed.
fn only_shape(svg: &str) -> Shape {
    let reading = Reading::of(svg).unwrap();
    assert_eq!(reading.shapes.len(), 1, "one shape: {:?}", reading.shapes);
    let raw = &reading.shapes[0];
    Shape {
        d: path_data(&raw.segments),
        part: raw.part,
        fill: raw.fill,
        dashed: raw.dashed,
    }
}

/// ADR 0117: the agent's drawing comes back as shapes and labels only. The backdrop, the title,
/// the gradient and the marker's own definition are gone; the plane is drawn three times where the
/// transforms put it, each in its part; the arrow has its head, in its part; its one word is a
/// label, never a shape.
#[test]
fn a_drawing_keeps_its_shapes_in_their_parts_and_nothing_else() {
    let (height, shapes, parts) = picture(&take_off());
    // Its word at the top left keeps its room, so the frame stays whole (amended 7 November: before
    // words were kept, this picture was cut to what is drawn).
    assert_eq!(height, 360.0);
    let Ok(Widget::Picture { labels, .. }) = read_widget(&take_off()) else {
        panic!("a picture");
    };
    assert_eq!(
        labels
            .iter()
            .map(|label| label.text.as_str())
            .collect::<Vec<_>>(),
        ["Runway"]
    );
    let in_part = |part| {
        shapes
            .iter()
            .filter(|shape| shape.part == Some(part))
            .count()
    };
    // The runway; the plane and its wheel; the plane; the plane; the arrow and its head.
    assert_eq!(shapes.len(), 7, "{shapes:#?}");
    assert_eq!(
        (in_part(1), in_part(2), in_part(3)),
        (2, 3, 1),
        "{shapes:#?}"
    );
    let runway = &shapes[0];
    let level = runway
        .d
        .strip_prefix("M20 ")
        .and_then(|rest| rest.split_once("L620 "))
        .unwrap();
    assert_eq!(level.0, level.1, "a level runway: {}", runway.d);
    assert_eq!(
        (runway.part, runway.fill, runway.dashed),
        (None, None, true)
    );
    // translate(60 300), then h80 from 0 0: on the runway's level less 20.
    let ground: f64 = level.0.parse().unwrap();
    let plane = format!(
        "M60 {}L140 {}C",
        number(ground - 20.0),
        number(ground - 20.0)
    );
    assert!(
        shapes[1].d.starts_with(&plane),
        "{} for {plane}",
        shapes[1].d
    );
    assert_eq!(shapes[1].fill, Some(Shade::Light));
    assert_eq!(shapes[2].fill, Some(Shade::Dark), "the wheel's dark fill");
    // The arrow points up from 330 to 290, its head two strokes below the tip.
    let head = shapes
        .iter()
        .rev()
        .find(|shape| shape.part == Some(2))
        .unwrap();
    let tip = format!("L300 {}L", number(ground - 30.0));
    assert!(head.d.contains(&tip), "{} for {tip}", head.d);
    let written = serde_json::to_string(&shapes).unwrap();
    assert!(
        !written.contains('<') && !written.contains("url") && !written.contains("Runway"),
        "{written}"
    );
    assert_eq!(
        parts
            .iter()
            .map(|part| part.label.as_str())
            .collect::<Vec<_>>(),
        ["Speed up", "Lift", "Climb"]
    );
    // Its number stands where the agent put it, 70 above the runway, moved just clear of the plane
    // it would sit on.
    let put = [330.0, ground - 70.0];
    let moved = (parts[1].at[0] - put[0]).hypot(parts[1].at[1] - put[1]);
    assert!(
        moved > 0.0 && moved <= 16.0,
        "{:?} from {put:?}",
        parts[1].at
    );
}

/// Without `at`, a part's number stands above its shapes, centred; below them when they reach the
/// top; and always inside the picture.
#[test]
fn a_parts_number_stands_beside_its_shapes() {
    let (_, _, parts) = picture(&json!({
        "kind": "picture",
        "title": "x",
        "drawing": concat!(
            "<svg viewBox=\"0 0 640 360\">",
            "<path d=\"M0 360L0 0L640 0\" fill=\"none\"/>",
            "<rect data-part=\"1\" x=\"100\" y=\"200\" width=\"100\" height=\"50\"/>",
            "<rect data-part=\"2\" x=\"300\" y=\"4\" width=\"100\" height=\"50\"/>",
            "<rect data-part=\"3\" x=\"600\" y=\"300\" width=\"80\" height=\"80\"/>",
            "</svg>"
        ),
        "parts": [
            {"label": "a", "text": "a"},
            {"label": "b", "text": "b"},
            {"label": "c", "text": "c"}
        ]
    }));
    assert_eq!(parts[0].at, [150.0, 176.0]);
    assert_eq!(parts[1].at, [350.0, 78.0]);
    assert_eq!(parts[2].at, [624.0, 276.0]);
}

/// Several arrows written as one path with one marker each get their head, as the model meant;
/// a closed outline gets none.
#[test]
fn each_open_stroke_of_an_arrowed_path_gets_its_head() {
    let (_, shapes, _) = picture(&drawing(concat!(
        "<svg viewBox=\"0 0 640 360\">",
        "<line x1=\"0\" y1=\"0\" x2=\"640\" y2=\"360\"/>",
        "<path d=\"M100 100 H200 M100 200 H200 M300 100 h50 v50 z\" fill=\"none\" marker-end=\"url(#a)\"/>",
        "</svg>"
    )));
    let heads: Vec<&str> = shapes
        .iter()
        .map(|shape| shape.d.as_str())
        .filter(|d| d.contains("L200 100L") || d.contains("L200 200L"))
        .collect();
    assert_eq!(heads.len(), 2, "{shapes:#?}");
    // The diagonal, the path, and a head for each of its two open strokes.
    assert_eq!(shapes.len(), 4, "{shapes:#?}");
}

/// A number the agent put away from its part is joined to it by a line in that part, stopping
/// short of the part; one beside its part has none.
#[test]
fn a_number_away_from_its_part_is_joined_to_it() {
    let (_, shapes, parts) = picture(&json!({
        "kind": "picture", "title": "x",
        "drawing": concat!(
            "<svg viewBox=\"0 0 640 360\">",
            "<path d=\"M0 360L0 0L640 0\" fill=\"none\"/>",
            "<rect data-part=\"1\" x=\"100\" y=\"200\" width=\"100\" height=\"50\"/>",
            "<rect data-part=\"2\" x=\"400\" y=\"200\" width=\"100\" height=\"50\"/>",
            "</svg>"
        ),
        "parts": [
            {"label": "far", "text": "a", "at": [150, 60]},
            {"label": "near", "text": "b", "at": [450, 176]}
        ]
    }));
    assert_eq!(parts[0].at, [150.0, 60.0]);
    let leaders: Vec<&Shape> = shapes
        .iter()
        .filter(|shape| shape.d.starts_with("M150 60L"))
        .collect();
    assert_eq!(leaders.len(), 1, "{shapes:#?}");
    // Down to the box's top edge at 200, stopping 6 short of it.
    assert_eq!(leaders[0].d, "M150 60L150 194");
    assert_eq!(
        (leaders[0].part, leaders[0].fill, leaders[0].dashed),
        (Some(1), None, false)
    );
    assert_eq!(
        shapes.len(),
        4,
        "a line for the far number only: {shapes:#?}"
    );
}

/// A drawing in other units is scaled to 640 wide, its height in proportion, and so is an `at`.
#[test]
fn a_drawing_in_other_units_is_scaled_to_the_pictures_width() {
    let (height, shapes, parts) = picture(&json!({
        "kind": "picture",
        "title": "x",
        "drawing": "<svg viewBox=\"10 10 320 240\"><line x1=\"10\" y1=\"10\" x2=\"330\" y2=\"250\" data-part=\"1\"/></svg>",
        "parts": [{"label": "a", "text": "a", "at": [90, 50]}]
    }));
    assert!((height - 480.0).abs() < f64::EPSILON);
    assert_eq!(shapes[0].d, "M0 0L640 480");
    assert_eq!(parts[0].at, [160.0, 80.0]);
    // No viewBox: width and height, then the shapes' own box.
    let (height, ..) = picture(&drawing(
        "<svg width=\"200px\" height=\"100\"><line x1=\"0\" y1=\"0\" x2=\"200\" y2=\"100\"/></svg>",
    ));
    assert!((height - 320.0).abs() < f64::EPSILON);
    let (_, shapes, _) = picture(&drawing("<path d=\"M0 0L100 0L100 50Z\"/>"));
    assert!(
        shapes[0].d.starts_with("M23.7 23.7L616.3 23.7"),
        "{}",
        shapes[0].d
    );
}

/// A drawing that leaves much of its frame empty is cut to what is drawn, with room around it and
/// its numbers, then scaled back to the picture's width; never flatter or taller than 3:1.
#[test]
fn a_picture_is_cut_to_what_is_drawn() {
    let (height, shapes, parts) = picture(&json!({
        "kind": "picture", "title": "x",
        "drawing": "<svg viewBox=\"0 0 640 360\"><rect data-part=\"1\" x=\"100\" y=\"100\" width=\"200\" height=\"100\"/></svg>",
        "parts": [{"label": "a", "text": "a", "at": [200, 80]}]
    }));
    // From (80, 60) to (320, 220), scaled by 640 / 240.
    assert_eq!(rounded(height), 426.7);
    assert_eq!(
        shapes[0].d,
        "M53.3 106.7L586.7 106.7L586.7 373.3L53.3 373.3Z"
    );
    assert_eq!(parts[0].at, [320.0, 53.3]);
    // A level line alone is given a third of its width in height, around it.
    let (height, shapes, _) = picture(&drawing(
        "<svg viewBox=\"0 0 640 360\"><line x1=\"0\" y1=\"180\" x2=\"640\" y2=\"180\"/></svg>",
    ));
    assert_eq!(rounded(height), 213.3);
    assert_eq!(shapes[0].d, "M0 106.7L640 106.7");
    // A drawing that fills its frame keeps it.
    let (height, ..) = picture(&drawing(
        "<svg viewBox=\"0 0 640 360\"><line x1=\"10\" y1=\"10\" x2=\"630\" y2=\"350\"/></svg>",
    ));
    assert_eq!(height, 360.0);
}

/// Every path command becomes absolute moves, lines and cubic curves, as SVG draws them.
#[test]
fn path_commands_become_moves_lines_and_curves() {
    let d = |d: &str| path_data(&path(d).unwrap());
    assert_eq!(d("M10 10 h20 v20 H10 z"), "M10 10L30 10L30 30L10 30Z");
    assert_eq!(d("m10,10 20,0 0,20"), "M10 10L30 10L30 30");
    assert_eq!(d("M0 0 L1e1 -5"), "M0 0L10 -5");
    assert_eq!(d("M0 0Q30 30 60 0"), "M0 0C20 20 40 20 60 0");
    // A smooth quadratic reflects the last handle: down, then up.
    assert_eq!(
        d("M0 0Q30 30 60 0T120 0"),
        "M0 0C20 20 40 20 60 0C80 -20 100 -20 120 0"
    );
    assert_eq!(
        d("M0 0C0 10 10 10 10 0S20 -10 20 0"),
        "M0 0C0 10 10 10 10 0C10 -10 20 -10 20 0"
    );
    // A half turn over the top in two quarters, its middle at the top, ending exactly.
    let arc = d("M0 0 A10 10 0 0 1 20 0");
    assert!(
        arc.starts_with("M0 0C") && arc.contains(" 10 -10C") && arc.ends_with(" 20 0"),
        "{arc}"
    );
    // Flags may run into the next number.
    assert_eq!(d("M0 0a10 10 0 0120 0"), arc);
    assert_eq!(d("M0 0 A0 10 0 0 1 20 0"), "M0 0L20 0");
}

/// Circles, ellipses, rounded rectangles, polylines and polygons are outlines too; a closed shape
/// with no fill said is shaded lightly, an open line isn't.
#[test]
fn shapes_become_outlines_and_closed_ones_are_shaded() {
    let circle =
        only_shape("<svg viewBox=\"0 0 640 360\"><circle cx=\"100\" cy=\"100\" r=\"10\"/></svg>");
    assert!(
        circle
            .d
            .starts_with("M110 100C110 105.5 105.5 110 100 110C"),
        "{}",
        circle.d
    );
    assert!(circle.d.ends_with("110 100Z"));
    assert_eq!(circle.fill, Some(Shade::Light));
    let rounded = only_shape(
        "<svg viewBox=\"0 0 640 360\"><rect x=\"0\" y=\"0\" width=\"100\" height=\"40\" rx=\"10\"/></svg>",
    );
    assert!(
        rounded
            .d
            .starts_with("M10 0L90 0C95.5 0 100 4.5 100 10L100 30C"),
        "{}",
        rounded.d
    );
    let line =
        only_shape("<svg viewBox=\"0 0 640 360\"><polyline points=\"0,0 10,10 20,0\"/></svg>");
    assert_eq!((line.d.as_str(), line.fill), ("M0 0L10 10L20 0", None));
    let polygon =
        only_shape("<svg viewBox=\"0 0 640 360\"><polygon points=\"0 0 10 10 20 0\"/></svg>");
    assert_eq!(
        (polygon.d.as_str(), polygon.fill),
        ("M0 0L10 10L20 0Z", Some(Shade::Light))
    );
}

/// What the fill says: none, a light shade, or a dark one for a dark colour, inherited from a
/// group and overridden by a shape's own style.
#[test]
fn a_fill_is_none_light_or_dark() {
    let fill = |attributes: &str| {
        only_shape(&format!(
            "<svg viewBox=\"0 0 640 360\"><g fill=\"#fff\"><circle cx=\"9\" cy=\"9\" r=\"5\" {attributes}/></g></svg>"
        ))
        .fill
    };
    assert_eq!(fill(""), Some(Shade::Light));
    assert_eq!(fill("fill=\"none\""), None);
    assert_eq!(fill("fill=\"#1a1a1a\""), Some(Shade::Dark));
    assert_eq!(fill("fill=\"rgb(20, 30, 40)\""), Some(Shade::Dark));
    assert_eq!(fill("fill=\"black\""), Some(Shade::Dark));
    assert_eq!(fill("fill=\"skyblue\""), Some(Shade::Light));
    assert_eq!(fill("fill=\"#000\" style=\"fill: none\""), None);
    assert_eq!(fill("fill=\"#000\" fill-opacity=\"0\""), None);
}

/// Transforms compose from the outer group in, each list read as SVG reads it.
#[test]
fn transforms_compose_as_svg_composes_them() {
    let d = |svg: &str| only_shape(&format!("<svg viewBox=\"0 0 640 360\">{svg}</svg>")).d;
    assert_eq!(
        d(
            "<g transform=\"translate(100 0)\"><line x1=\"0\" y1=\"0\" x2=\"10\" y2=\"0\" transform=\"rotate(90)\"/></g>"
        ),
        "M100 0L100 10"
    );
    assert_eq!(
        d("<line x1=\"10\" y1=\"0\" x2=\"20\" y2=\"0\" transform=\"rotate(180 10 0)\"/>"),
        "M10 0L0 0"
    );
    assert_eq!(
        d("<line x1=\"1\" y1=\"1\" x2=\"2\" y2=\"2\" transform=\"scale(10) translate(5, 5)\"/>"),
        "M60 60L70 70"
    );
    assert_eq!(
        d("<line x1=\"1\" y1=\"1\" x2=\"2\" y2=\"2\" transform=\"matrix(2 0 0 3 10 20)\"/>"),
        "M12 23L14 26"
    );
}

/// A filled backdrop covering the picture goes: the picture stands on the chat's own ground. So
/// does everything that isn't a shape, and anything hidden.
#[test]
fn backdrops_words_and_hidden_things_are_left_out() {
    let (_, shapes, _) = picture(&drawing(concat!(
        "<svg viewBox=\"0 0 640 360\">",
        "<rect x=\"-10\" y=\"-10\" width=\"700\" height=\"400\" fill=\"#cdf\"/>",
        "<text x=\"5\" y=\"5\"><tspan>Sky</tspan></text>",
        "<script>alert(1)</script>",
        "<foreignObject><div>hi</div></foreignObject>",
        "<image href=\"https://example.com/a.png\" width=\"10\" height=\"10\"/>",
        "<circle cx=\"5\" cy=\"5\" r=\"3\" display=\"none\"/>",
        "<g style=\"display:none\"><circle cx=\"5\" cy=\"5\" r=\"3\"/></g>",
        "<circle cx=\"5\" cy=\"5\" r=\"3\" visibility=\"hidden\"/>",
        "<g style=\"visibility: hidden\"><circle cx=\"5\" cy=\"5\" r=\"3\"/></g>",
        "<circle cx=\"50\" cy=\"50\" r=\"10\" onclick=\"alert(1)\"/>",
        "</svg>"
    )));
    assert_eq!(shapes.len(), 1, "{shapes:#?}");
    // A backdrop that is a part is kept: the agent meant it.
    let (_, shapes, _) = picture(&json!({
        "kind": "picture", "title": "x",
        "drawing": "<svg viewBox=\"0 0 640 360\"><rect width=\"640\" height=\"360\" data-part=\"1\"/></svg>",
        "parts": [{"label": "Field", "text": "The whole field."}]
    }));
    assert_eq!(shapes.len(), 1);
}

/// What the agent is told when its drawing can't be drawn, so it can fix it.
#[test]
fn a_drawing_that_cant_be_drawn_says_what_to_change() {
    let refused = |arguments: Value| read_widget(&arguments).unwrap_err();
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 360\"><text>Hi</text></svg>",
    ));
    assert!(error.contains("nothing to draw"), "{error}");
    let error = refused(json!({"kind": "picture", "title": "x"}));
    assert!(error.contains("drawing is missing"), "{error}");
    let error = refused(json!({
        "kind": "picture", "title": "x",
        "drawing": "<svg viewBox=\"0 0 640 360\"><circle cx=\"5\" cy=\"5\" r=\"3\" data-part=\"3\"/></svg>",
        "parts": [{"label": "a", "text": "a"}, {"label": "b", "text": "b"}]
    }));
    assert!(error.contains("there are 2 parts"), "{error}");
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 360\"><circle cx=\"5\" cy=\"5\" r=\"3\" data-part=\"1\"/></svg>",
    ));
    assert!(error.contains("there are no parts: give parts"), "{error}");
    let error = refused(json!({
        "kind": "picture", "title": "x",
        "drawing": "<svg viewBox=\"0 0 640 360\"><circle cx=\"5\" cy=\"5\" r=\"3\"/></svg>",
        "parts": [{"label": "Wing", "text": "a"}]
    }));
    assert!(
        error.contains("part 1 \"Wing\" has no shapes and no at"),
        "{error}"
    );
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 100\"><circle cx=\"5\" cy=\"5\" r=\"3\"/></svg>",
    ));
    assert!(error.contains("between 1:3 and 3:1"), "{error}");
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 360\"><path d=\"L10 10\"/></svg>",
    ));
    assert!(error.contains("start with M"), "{error}");
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 360\"><path d=\"M0 0 X10 10\"/></svg>",
    ));
    assert!(error.contains("isn't a path command"), "{error}");
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 360\"><circle cx=\"5\" cy=\"5\" r=\"3\" transform=\"spin(3)\"/></svg>",
    ));
    assert!(error.contains("isn't one of translate"), "{error}");
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 360\"><rect width=\"100%\" height=\"5\"/></svg>",
    ));
    assert!(error.contains("width=\"100%\" isn't a number"), "{error}");
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 360\"><defs><g id=\"p\"><circle r=\"3\"/></g></defs><use href=\"#p\" x=\"9\"/></svg>",
    ));
    assert!(error.contains("draw each copy in a g"), "{error}");
    let error = refused(drawing(
        "<svg viewBox=\"0 0 640 360\"><circle cx=\"5\" cy=\"5\" r=\"3\"></svg>",
    ));
    assert!(error.contains("isn't SVG LoomWatch can read"), "{error}");
    let long = format!(
        "<svg viewBox=\"0 0 640 360\">{}</svg>",
        "<line x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"/>".repeat(1000)
    );
    let error = refused(drawing(&long));
    assert!(error.contains("characters; keep it to"), "{error}");
}

/// A picture keeps nothing the person changes, reads back from its kept form exactly, and the next
/// run hears its parts.
#[test]
fn a_picture_is_kept_and_named_by_its_parts() {
    let widget = read_widget(&take_off()).unwrap();
    assert!(read_state(&widget, &json!({})).is_err());
    let kept: Widget = serde_json::from_value(serde_json::to_value(&widget).unwrap()).unwrap();
    assert_eq!(kept, widget);
    let line = showed(&[Kept {
        n: 1,
        line: None,
        spec: widget,
        state: None,
        changed_at: None,
    }])
    .unwrap();
    assert_eq!(
        line,
        "[Under this answer: a picture \"How a plane takes off\" (1 Speed up, 2 Lift, 3 Climb).]"
    );
}

#[test]
fn numbers_are_written_to_a_tenth() {
    assert_eq!(number(-0.04), "0");
    assert_eq!(number(12.0), "12");
    assert_eq!(number(12.345), "12.3");
    assert_eq!(number(-7.25), "-7.3");
}

/// Drawings a live model wrote (`drawn-by-a-model.json`, GPT-6.1 Terra on the bench): each reads,
/// keeps its parts, and is drawn as the model meant: the heart's arrows, written three to a path
/// with one marker, each have a head; the flower's numbers set beyond its petals are joined to
/// the parts they name.
#[test]
fn drawings_a_model_wrote_read_as_it_meant_them() {
    let fixture: Value = serde_json::from_str(include_str!("drawn-by-a-model.json")).unwrap();
    let calls = fixture["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 4);
    for call in calls {
        let (height, shapes, parts) = picture(call);
        let asked = call["parts"].as_array().unwrap().len();
        assert_eq!(parts.len(), asked, "{}", call["title"]);
        assert!(!shapes.is_empty() && height > 0.0, "{}", call["title"]);
    }
    let heads = |shapes: &[Shape], part: u8| {
        shapes
            .iter()
            .filter(|shape| {
                shape.part == Some(part) && shape.d.matches('L').count() == 2 && shape.d.len() < 40
            })
            .count()
    };
    let (_, heart, _) = picture(&calls[1]);
    assert_eq!((heads(&heart, 2), heads(&heart, 3)), (3, 3), "{heart:#?}");
    let (_, flower, parts) = picture(&calls[2]);
    let joined = parts
        .iter()
        .enumerate()
        .filter(|(at, part)| {
            let from = format!("M{} {}L", number(part.at[0]), number(part.at[1]));
            flower.iter().any(|shape| {
                shape.part == Some(u8::try_from(at + 1).unwrap()) && shape.d.starts_with(&from)
            })
        })
        .count();
    assert!(
        joined >= 2,
        "the stamens' and the pistil's numbers are joined to them: {parts:#?}"
    );
}

/// A picture of `svg` with `parts` parts, as the daemon keeps it.
fn kept(svg: &str, parts: usize, guess: Option<Value>) -> Result<Widget, String> {
    let mut arguments = json!({
        "kind": "picture", "title": "x", "drawing": svg,
        "parts": (1..=parts).map(|n| json!({"label": format!("Stage {n}"), "text": "What happens.", "at": [600, 20]})).collect::<Vec<_>>(),
    });
    if let Some(guess) = guess {
        arguments["guess"] = guess;
    }
    read_widget(&arguments)
}

/// ADR 0117, amended 7 November: the drawing's words come back as plain labels where the agent
/// put them, in their part, with the edge they stand on; words that aren't on the picture (a title,
/// something hidden, nothing but spaces) don't.
#[test]
fn a_drawings_words_are_kept_as_labels_where_it_put_them() {
    let Ok(Widget::Picture { labels, .. }) = kept(
        concat!(
            "<svg viewBox=\"0 0 640 360\">",
            // Along two edges, so the picture keeps its whole frame and no line crosses a word.
            "<path d=\"M0 360L0 0L640 0\" fill=\"none\"/>",
            "<g data-part=\"1\" text-anchor=\"middle\">",
            "<rect x=\"100\" y=\"100\" width=\"200\" height=\"100\"/>",
            "<text x=\"200\" y=\"90\" font-size=\"20\">wing &amp;\n <tspan>flap</tspan></text>",
            "</g>",
            "<text x=\"400 410\" y=\"300\" dominant-baseline=\"middle\" transform=\"translate(10 0)\">runway</text>",
            "<title>Not on the picture</title>",
            "<text x=\"10\" y=\"10\" display=\"none\">hidden</text>",
            "<defs><text>in a definition</text></defs>",
            "<text x=\"5\" y=\"5\">   </text>",
            "<text x=\"620\" y=\"350\" text-anchor=\"end\">&#233;t&#xE9;</text>",
            "</svg>"
        ),
        1,
        None,
    ) else {
        panic!("a picture");
    };
    assert_eq!(
        labels,
        [
            Label {
                text: "wing & flap".to_owned(),
                // Its baseline at 90, raised to the middle of 20-unit letters.
                at: [200.0, 83.0],
                anchor: Anchor::Middle,
                part: Some(1),
            },
            Label {
                text: "runway".to_owned(),
                at: [410.0, 300.0],
                anchor: Anchor::Start,
                part: None,
            },
            Label {
                text: "été".to_owned(),
                at: [620.0, 344.4],
                anchor: Anchor::End,
                part: None,
            },
        ]
    );
}

/// A label is a few words; a picture names only what the person needs.
#[test]
fn labels_that_say_too_much_say_what_to_change() {
    let long = format!(
        "<svg viewBox=\"0 0 640 360\"><circle cx=\"9\" cy=\"9\" r=\"4\"/><text>{}</text></svg>",
        "word ".repeat(12)
    );
    let error = kept(&long, 0, None).unwrap_err();
    assert!(
        error.contains("keep each label to a few words, 40 at most"),
        "{error}"
    );
    let many = format!(
        "<svg viewBox=\"0 0 640 360\"><circle cx=\"9\" cy=\"9\" r=\"4\"/>{}</svg>",
        "<text x=\"9\" y=\"9\">one</text>".repeat(25)
    );
    let error = kept(&many, 0, None).unwrap_err();
    assert!(error.contains("more than 24 labels"), "{error}");
    let error = kept(
        "<svg viewBox=\"0 0 640 360\"><circle cx=\"9\" cy=\"9\" r=\"4\"/><text data-part=\"2\">x</text></svg>",
        1,
        None,
    )
    .unwrap_err();
    assert!(error.contains("a label has data-part=\"2\""), "{error}");
}

/// The same ball drawn at two stages, its words with it: written in either order, it comes back as
/// one thing that moves from part 1 to part 2, each stage's shapes alike so every point has one to
/// move to.
const BALL: &str = concat!(
    "<svg viewBox=\"0 0 640 360\">",
    "<path d=\"M0 360L0 0L640 0\" fill=\"none\"/>",
    "<g data-part=\"2\" data-moves=\"ball\" transform=\"translate(300 200) scale(2)\">",
    "<circle r=\"10\"/><path d=\"M0 0h20\" marker-end=\"url(#a)\"/><text y=\"-20\">ball</text></g>",
    "<g data-part=\"1\" data-moves=\"ball\" transform=\"translate(100 100)\">",
    "<circle r=\"10\"/><path d=\"M0 0h20\" marker-end=\"url(#a)\"/><text y=\"-20\">ball</text></g>",
    "<circle data-part=\"3\" cx=\"500\" cy=\"300\" r=\"5\"/>",
    "</svg>"
);

#[test]
fn a_thing_drawn_at_each_stage_moves_from_one_to_the_next() {
    let widget = kept(BALL, 3, None).unwrap();
    let Widget::Picture {
        shapes,
        labels,
        moves,
        ..
    } = &widget
    else {
        panic!("a picture");
    };
    assert_eq!(moves.len(), 1, "{moves:#?}");
    let stages = &moves[0].stages;
    assert_eq!(
        stages.iter().map(|stage| stage.part).collect::<Vec<_>>(),
        [1, 2],
        "in the order of their parts, not the drawing's"
    );
    // The ball, its line and the line's head; its word.
    for stage in stages {
        assert_eq!(stage.shapes.len(), 3, "{stage:?}");
        assert_eq!(stage.labels.len(), 1, "{stage:?}");
        assert!(
            stage
                .shapes
                .iter()
                .all(|at| shapes[*at].part == Some(stage.part))
        );
    }
    for (from, to) in stages[0].shapes.iter().zip(&stages[1].shapes) {
        assert_eq!(commands(&shapes[*from].d), commands(&shapes[*to].d));
        assert_ne!(shapes[*from].d, shapes[*to].d, "it has moved");
    }
    assert_eq!(labels[stages[0].labels[0]].at, [100.0, 74.4]);
    assert_eq!(labels[stages[1].labels[0]].at, [300.0, 148.8]);
    // Its parts' numbers stand on the line of steps, not on it: nothing joins them, however far
    // the agent put them (the drawing has 8 shapes; a leader would be a 9th).
    assert_eq!(shapes.len(), 8, "{shapes:#?}");
    // What the apps read.
    let written = serde_json::to_value(&widget).unwrap();
    assert_eq!(written["moves"][0]["stages"][1]["part"], 2);
    assert!(written.get("guess").is_none());
}

/// The example the agent is shown for a picture that plays is one the daemon reads as one: the same
/// g at three steps comes back as one thing moving through parts 1, 2 and 3, its word with it.
#[test]
fn the_instructions_example_of_a_picture_that_plays_plays() {
    let told = crate::widgets::SHOW_WIDGET_DRAWING.text();
    let start = told
        .find("<g data-part=\"1\" data-moves=")
        .expect("the instructions show a g that moves");
    let end = start + told[start..].find("</g>").expect("the example g closes") + "</g>".len();
    let step = &told[start..end];
    assert!(step.contains("translate(80 120)"), "{step}");
    let at = |part: u8, x: u16| {
        step.replace("data-part=\"1\"", &format!("data-part=\"{part}\""))
            .replace("translate(80 120)", &format!("translate({x} 120)"))
    };
    let svg = format!(
        "<svg viewBox=\"0 0 640 360\"><path d=\"M0 0L640 360\" fill=\"none\"/>{}{}{}</svg>",
        at(1, 80),
        at(2, 320),
        at(3, 560)
    );
    let Ok(Widget::Picture { moves, .. }) = kept(&svg, 3, None) else {
        panic!("the example reads as a picture: {svg}");
    };
    assert_eq!(moves.len(), 1, "{moves:#?}");
    assert_eq!(
        moves[0]
            .stages
            .iter()
            .map(|stage| stage.part)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    for stage in &moves[0].stages {
        assert_eq!(
            (stage.shapes.len(), stage.labels.len()),
            (1, 1),
            "{stage:?}"
        );
    }
}

/// ADR 0117, amended 7 November: a picture whose stages are values of a cause names it, and its
/// parts' labels are the values; a dial turns what changes, so a still picture can't have one.
#[test]
fn a_picture_that_plays_can_be_a_dial_its_parts_the_values() {
    let values: Vec<Value> = ["0 km/h", "150 km/h", "250 km/h"]
        .iter()
        .map(|value| json!({"label": value, "text": "What this speed does.", "at": [600, 20]}))
        .collect();
    let dialled = |svg: &str, dial: Value| {
        read_widget(&json!({
            "kind": "picture", "title": "What makes a plane lift off", "drawing": svg, "dial": dial,
            "parts": values,
        }))
    };
    let widget = dialled(BALL, json!("Speed")).unwrap();
    let Widget::Picture { dial, parts, .. } = &widget else {
        panic!("a picture");
    };
    assert_eq!(dial.as_deref(), Some("Speed"));
    assert_eq!(
        parts
            .iter()
            .map(|part| part.label.as_str())
            .collect::<Vec<_>>(),
        ["0 km/h", "150 km/h", "250 km/h"]
    );
    assert_eq!(serde_json::to_value(&widget).unwrap()["dial"], "Speed");
    // Nothing moves: there is nothing for a dial to turn, and the agent is told what to draw.
    let still = "<svg viewBox=\"0 0 640 360\"><circle data-part=\"1\" cx=\"100\" cy=\"100\" r=\"9\"/><circle data-part=\"2\" cx=\"300\" cy=\"100\" r=\"9\"/><circle data-part=\"3\" cx=\"500\" cy=\"300\" r=\"9\"/></svg>";
    let error = dialled(still, json!("Speed")).unwrap_err();
    assert!(
        error.contains("dial is for a picture that plays") && error.contains("data-moves"),
        "{error}"
    );
    // A word or two, not a sentence.
    let error = dialled(BALL, json!("The speed of the plane along the runway")).unwrap_err();
    assert!(error.contains("dial"), "{error}");
    // Steps in time have no dial.
    let Ok(Widget::Picture { dial, .. }) = kept(BALL, 3, None) else {
        panic!("a picture");
    };
    assert_eq!(dial, None);
    assert!(
        serde_json::to_value(kept(BALL, 3, None).unwrap())
            .unwrap()
            .get("dial")
            .is_none()
    );
}

/// What the agent is told when what it means to move can't, so it can draw it again.
#[test]
fn a_thing_that_cant_move_says_what_to_change() {
    let refused = |svg: &str| kept(svg, 2, None).unwrap_err();
    let svg = |inside: &str| {
        format!("<svg viewBox=\"0 0 640 360\"><circle cx=\"9\" cy=\"9\" r=\"4\"/>{inside}</svg>")
    };
    let cases = [
        (
            "<g data-part=\"1\" data-moves=\"cart\"><circle r=\"5\"/></g>",
            "\"cart\" is drawn in one part only",
        ),
        (
            "<g data-moves=\"cart\"><circle r=\"5\"/></g><g data-part=\"2\" data-moves=\"cart\"><circle r=\"5\"/></g>",
            "data-moves=\"cart\" needs its stage",
        ),
        (
            "<g data-part=\"1\" data-moves=\"cart\"><circle r=\"5\"/></g><g data-part=\"1\" data-moves=\"cart\"><circle r=\"5\"/></g>",
            "\"cart\" is drawn twice in part 1",
        ),
        (
            "<g data-part=\"1\" data-moves=\"cart\"><circle r=\"5\"/></g><g data-part=\"2\" data-moves=\"cart\"><rect width=\"5\" height=\"5\"/></g>",
            "\"cart\" isn't drawn the same way in parts 1 and 2",
        ),
        (
            "<g data-part=\"1\" data-moves=\"cart\"><circle r=\"5\"/><text>cart</text></g><g data-part=\"2\" data-moves=\"cart\"><circle r=\"5\"/></g>",
            "\"cart\" has 1 labels in part 1 and 0 in part 2",
        ),
        (
            "<g data-part=\"1\" data-moves=\"cart\"><g data-moves=\"wheel\"><circle r=\"5\"/></g></g>",
            "has data-moves inside another data-moves",
        ),
        (
            "<g data-part=\"1\" data-moves=\"cart\"><circle r=\"5\" data-part=\"2\"/></g><g data-part=\"2\" data-moves=\"cart\"><circle r=\"5\"/></g>",
            "everything in a copy of \"cart\" belongs to its stage, part 1",
        ),
    ];
    for (inside, says) in cases {
        let error = refused(&svg(inside));
        assert!(error.contains(says), "{inside}: {error}");
    }
}

/// The one question a picture may ask before a surprising step: kept with its right choice's
/// place, and refused for a picture that doesn't play or a guess that doesn't add up.
#[test]
fn a_guess_is_kept_for_a_picture_that_plays_and_checked() {
    let guess = json!({
        "before": 2,
        "question": "Which way does the ball go?",
        "choices": ["Up", " Down and right "],
        "answer": "Down and right"
    });
    let Ok(Widget::Picture {
        guess: Some(kept_guess),
        ..
    }) = kept(BALL, 3, Some(guess.clone()))
    else {
        panic!("a picture with its guess");
    };
    assert_eq!(
        kept_guess,
        Guess {
            before: 2,
            question: "Which way does the ball go?".to_owned(),
            choices: vec!["Up".to_owned(), "Down and right".to_owned()],
            answer: 1,
        }
    );
    let still =
        "<svg viewBox=\"0 0 640 360\"><circle data-part=\"1\" cx=\"9\" cy=\"9\" r=\"4\"/></svg>";
    let error = kept(still, 2, Some(guess.clone())).unwrap_err();
    assert!(
        error.contains("guess is for a picture that plays"),
        "{error}"
    );
    let mut wrong = guess.clone();
    wrong["answer"] = json!("Sideways");
    let error = kept(BALL, 3, Some(wrong)).unwrap_err();
    assert!(
        error.contains("guess.answer is the right choice"),
        "{error}"
    );
    let mut first = guess.clone();
    first["before"] = json!(1);
    let error = kept(BALL, 3, Some(first)).unwrap_err();
    assert!(
        error.contains("guess.before is the part the question comes before, from 2 to 3"),
        "{error}"
    );
    let mut four = guess;
    four["choices"] = json!(["a", "b", "c", "Down and right"]);
    let error = kept(BALL, 3, Some(four)).unwrap_err();
    assert!(error.contains("guess.choices has 4"), "{error}");
}

/// Words after a `tspan` stay in their label, and the `text`'s end doesn't end the group around
/// it: what follows keeps the group's part.
#[test]
fn words_after_a_nested_tspan_stay_in_their_label() {
    let Ok(Widget::Picture { labels, shapes, .. }) = kept(
        concat!(
            "<svg viewBox=\"0 0 640 360\"><path d=\"M0 0L640 360\" fill=\"none\"/>",
            "<g data-part=\"1\"><text x=\"10\" y=\"10\">wing <tspan>flap</tspan> up</text>",
            "<circle cx=\"50\" cy=\"50\" r=\"5\"/></g></svg>"
        ),
        1,
        None,
    ) else {
        panic!("a picture");
    };
    assert_eq!(labels[0].text, "wing flap up");
    assert!(shapes[1].d.contains('C'), "the circle: {:?}", shapes[1]);
    assert_eq!(shapes[1].part, Some(1));
}

/// ADR 0117, amended 7 November: a number the agent put on a line, on a word or on another number
/// moves to the nearest clear ground, near what it names; a word a line runs through moves just
/// above or below it. On the drawings agents made on 7 November, numbers on a line went from 82
/// of 273 to none on the drawing's own lines.
#[test]
fn numbers_and_words_keep_clear_of_the_lines() {
    // Clear of every line but the number's own joining line, which starts at it.
    let clear_of = |at: [f64; 2], shapes: &[Shape]| {
        let here = super::P { x: at[0], y: at[1] };
        shapes.iter().all(|shape| {
            let outline = super::segments_of(&shape.d);
            if outline.first() == Some(&super::Segment::Move(here)) {
                return true;
            }
            let near = super::nearest(&outline, here).unwrap();
            // A number's mark as a phone draws it, the room the daemon keeps (CLEAR_MARK).
            near.minus(here).length() >= 22.0 - 1e-6
        })
    };
    // A long line and an arrow with a head; part 1's number on the line, part 2's clear of the
    // arrow's shaft but on the head LoomWatch draws at its tip, part 3's on part 1's.
    let drawing = concat!(
        "<svg viewBox=\"0 0 640 360\">",
        "<path d=\"M0 360L0 0L640 0\" fill=\"none\"/>",
        "<line data-part=\"1\" x1=\"40\" y1=\"200\" x2=\"600\" y2=\"200\"/>",
        "<line data-part=\"2\" x1=\"300\" y1=\"300\" x2=\"300\" y2=\"240\" marker-end=\"url(#a)\"/>",
        "<circle data-part=\"3\" cx=\"500\" cy=\"100\" r=\"30\"/>",
        "</svg>"
    );
    let widget = read_widget(&json!({
        "kind": "picture", "title": "x", "drawing": drawing,
        "parts": [
            {"label": "Line", "text": "A line.", "at": [200, 200]},
            {"label": "Arrow", "text": "An arrow.", "at": [323, 250]},
            {"label": "Ball", "text": "A ball.", "at": [200, 200]},
        ],
    }))
    .unwrap();
    let Widget::Picture { parts, shapes, .. } = &widget else {
        panic!("a picture");
    };
    for part in parts {
        assert!(
            clear_of(part.at, shapes),
            "{} at {:?} is on a line",
            part.label,
            part.at
        );
    }
    // Near where the agent put it, and apart from each other.
    let gap = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).hypot(a[1] - b[1]);
    assert!(
        gap(parts[0].at, [200.0, 200.0]) <= 32.0,
        "{:?}",
        parts[0].at
    );
    assert!(
        gap(parts[0].at, parts[2].at) >= 32.0,
        "{:?} {:?}",
        parts[0].at,
        parts[2].at
    );
    // A number with clear ground where it was put stays there.
    let still = read_widget(&json!({
        "kind": "picture", "title": "x", "drawing": drawing,
        "parts": [{"label": "Line", "text": "A line.", "at": [200, 150]}, {"label": "Arrow", "text": "An arrow.", "at": [360, 270]}, {"label": "Ball", "text": "A ball.", "at": [500, 160]}],
    }))
    .unwrap();
    let Widget::Picture { parts, .. } = &still else {
        panic!("a picture");
    };
    assert_eq!(parts[0].at, [200.0, 150.0]);

    // A word the line runs through moves just above or below it; one with no clear room stays.
    let worded = |extra: &str| {
        read_widget(&json!({
            "kind": "picture", "title": "x", "drawing": format!(
                "<svg viewBox=\"0 0 640 360\"><path d=\"M0 360L0 0L640 0\" fill=\"none\"/><line x1=\"40\" y1=\"200\" x2=\"600\" y2=\"200\"/>{extra}</svg>"),
        }))
        .unwrap()
    };
    let Widget::Picture { labels, .. } = worded("<text x=\"100\" y=\"206\">Thrust</text>") else {
        panic!("a picture");
    };
    assert_eq!(labels[0].at[0], 100.0);
    assert!(
        (labels[0].at[1] - 200.0).abs() >= 10.0 && (labels[0].at[1] - 200.0).abs() <= 50.0,
        "{:?}",
        labels[0].at
    );
    let boxed = concat!(
        "<line x1=\"40\" y1=\"178\" x2=\"600\" y2=\"178\"/><line x1=\"40\" y1=\"222\" x2=\"600\" y2=\"222\"/>",
        "<line x1=\"40\" y1=\"156\" x2=\"600\" y2=\"156\"/><line x1=\"40\" y1=\"244\" x2=\"600\" y2=\"244\"/>",
        "<text x=\"100\" y=\"206\">Thrust</text>"
    );
    let Widget::Picture { labels, .. } = worded(boxed) else {
        panic!("a picture");
    };
    assert_eq!(labels[0].at[0], 100.0);
    assert!(
        (labels[0].at[1] - 200.0).abs() < 1.0,
        "no clear room: it stays, {:?}",
        labels[0].at
    );
}

/// A number never covers a word or another number as a phone draws them: its mark there is 22 px on
/// a picture about 300 px wide, some 24 units from its middle, and Inter's 11 px letters take about
/// 13 units a character for nine words in ten.
#[test]
fn a_number_never_covers_a_word_or_a_number_as_a_phone_draws_them() {
    // How far a number's middle is from a word's letters, the word from `left` to `right`.
    let from_word = |at: [f64; 2], left: f64, right: f64, middle: f64| {
        let dx = (left - at[0]).max(0.0).max(at[0] - right);
        let dy = (middle - 12.0 - at[1]).max(0.0).max(at[1] - middle - 12.0);
        dx.hypot(dy)
    };
    let picture = |words: &str, parts: Value| {
        read_widget(&json!({
            "kind": "picture", "title": "x", "parts": parts,
            "drawing": format!("<svg viewBox=\"0 0 640 360\"><path d=\"M0 360L0 0L640 0\" fill=\"none\"/>{words}</svg>"),
        }))
        .unwrap()
    };
    // A number put just after its word, as agents often do.
    let Widget::Picture { parts, .. } = picture(
        "<text x=\"100\" y=\"100\">Sepals</text>",
        json!([{"label": "Sepals", "text": "They guard the bud.", "at": [200, 100]}]),
    ) else {
        panic!("a picture");
    };
    let word_ends = 100.0 + 6.0 * 13.0;
    assert!(
        from_word(parts[0].at, 100.0, word_ends, 100.0) >= 24.0,
        "the number covers the end of its word: {:?}",
        parts[0].at
    );
    // A word that would cross the picture's side is drawn inside it, so its room is there too.
    let Widget::Picture { parts, .. } = picture(
        "<text x=\"600\" y=\"100\">Petals</text>",
        json!([{"label": "Petals", "text": "They draw the bees.", "at": [550, 100]}]),
    ) else {
        panic!("a picture");
    };
    assert!(
        from_word(parts[0].at, 640.0 - 6.0 * 13.0, 640.0, 100.0) >= 24.0,
        "the number covers its word where the app moves it in: {:?}",
        parts[0].at
    );
    // Two numbers put side by side stand a mark's width apart.
    let Widget::Picture { parts, .. } = picture(
        "",
        json!([
            {"label": "One", "text": "One.", "at": [200, 300]},
            {"label": "Two", "text": "Two.", "at": [246, 300]},
        ]),
    ) else {
        panic!("a picture");
    };
    let apart = (parts[0].at[0] - parts[1].at[0]).hypot(parts[0].at[1] - parts[1].at[1]);
    assert!(
        apart >= 47.0,
        "the numbers touch: {:?} {:?}",
        parts[0].at,
        parts[1].at
    );
}

/// The kept path data reads back as the outline it was written from.
#[test]
fn kept_path_data_reads_back() {
    for d in [
        "M10 20L30 40",
        "M0 0C10 0 20 10 20 20Z",
        "M-5.5 3L640 360M1 1L2 2Z",
    ] {
        assert_eq!(super::path_data(&super::segments_of(d)), d);
    }
}

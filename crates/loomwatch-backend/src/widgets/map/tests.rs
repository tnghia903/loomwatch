use serde_json::json;

use super::super::{Kept, read as read_widget, read_state, showed, shown};
use super::*;

/// Lunch near Galaxis, in Singapore's one-north, as an agent found it.
fn lunch() -> Value {
    json!({
        "kind": "map",
        "title": "Lunch near Galaxis",
        "from": {"name": "Galaxis", "lat": 1.29947, "lng": 103.78753},
        "places": [
            {
                "name": "Bread Yard", "lat": 1.29875, "lng": 103.78761, "category": "Cafe",
                "note": "A bakery-café that started at SUTD: pasta and brunch.",
                "rating": 4.83, "price": 2, "link": "https://breadyard.sg"
            },
            {"name": "One Fattened Calf Burgers", "lat": 1.29812, "lng": 103.78702, "category": "food"},
            {"name": "Wok Palace", "lat": 1.30561, "lng": 103.79213, "address": "1 Fusionopolis Way"}
        ]
    })
}

#[test]
fn a_map_keeps_each_place_as_found_and_tells_the_agent_how_far_each_is() {
    let widget = read_widget(&lunch()).expect("a good map");
    let Widget::Map { places, from, .. } = &widget else {
        panic!("a map");
    };
    assert_eq!(
        from.as_ref().map(|from| from.name.as_str()),
        Some("Galaxis")
    );
    let bread = &places[0];
    assert_eq!(
        bread.category,
        Some(Category::Cafe),
        "read without minding case"
    );
    assert_eq!(bread.rating, Some(4.8), "kept to one decimal");
    assert_eq!(bread.price, Some(2));
    assert_eq!(bread.link.as_deref(), Some("https://breadyard.sg/"));
    assert_eq!(places[2].category, None);
    assert_eq!(places[2].address.as_deref(), Some("1 Fusionopolis Way"));
    // The agent hears the distances the map shows, so its words agree with it.
    assert_eq!(
        shown(&widget, 1)["distances"],
        "From Galaxis, as the crow flies: Bread Yard 80 m, One Fattened Calf Burgers 160 m, Wok \
         Palace 850 m"
    );
    assert!(
        read_state(&widget, &json!({"checked": []})).is_err(),
        "a map keeps nothing"
    );
    // The apps read it as kept: `kind` and each place's fields, nothing left out.
    let kept = serde_json::to_value(&widget).expect("kept");
    assert_eq!(kept["kind"], "map");
    assert_eq!(kept["places"][0]["category"], "cafe");
    assert_eq!(kept["from"]["lng"], 103.78753);
    assert!(kept["places"][1].get("rating").is_none());
}

#[test]
fn without_a_start_the_agent_hears_how_far_apart_the_places_are() {
    let mut map = lunch();
    map.as_object_mut().expect("object").remove("from");
    let widget = read_widget(&map).expect("a good map");
    assert_eq!(
        shown(&widget, 1)["distances"],
        "The places are within 1 km of each other, as the crow flies"
    );
    map["places"] = json!([map["places"][0].clone()]);
    let widget = read_widget(&map).expect("one place is a map too");
    assert_eq!(shown(&widget, 1)["distances"], "One place on the map");
}

#[test]
fn the_next_run_reads_a_maps_places() {
    let kept = Kept {
        n: 1,
        line: None,
        spec: read_widget(&lunch()).expect("a good map"),
        state: None,
        changed_at: None,
    };
    assert_eq!(
        showed(&[kept]).unwrap(),
        "[Under this answer: a map \"Lunch near Galaxis\" (Bread Yard, One Fattened Calf Burgers, \
         Wok Palace; from Galaxis).]"
    );
}

#[test]
fn a_position_off_the_earth_or_in_the_sea_at_zero_is_refused() {
    let refused = |place: Value| {
        let mut map = lunch();
        map["places"][1] = place;
        read_widget(&map).expect_err("refused")
    };
    let error = refused(json!({"name": "Up", "lat": 103.78, "lng": 1.29}));
    assert!(
        error.starts_with("places 2: lat is 103.78: it is -90 to 90"),
        "{error}"
    );
    let error = refused(json!({"name": "Round", "lat": 1.29, "lng": 203.78}));
    assert!(
        error.starts_with("places 2: lng is 203.78: it is -180 to 180"),
        "{error}"
    );
    let error = refused(json!({"name": "Nowhere", "lat": 0, "lng": 0}));
    assert!(error.contains("both 0, in the sea"), "{error}");
    let error = refused(json!({"name": "Guessed"}));
    assert!(error.starts_with("places 2: lat is missing"), "{error}");
    let error = refused(json!({"name": "Words", "lat": "1.29", "lng": 103.78}));
    assert!(error.starts_with("places 2: lat is a number"), "{error}");

    let mut map = lunch();
    map["from"]["lat"] = json!(-91);
    let error = read_widget(&map).expect_err("refused");
    assert!(error.starts_with("from: lat is -91"), "{error}");
}

#[test]
fn a_place_far_from_the_rest_is_refused_as_most_likely_given_wrong() {
    let mut map = lunch();
    // West where the rest are east: the other side of the world.
    map["places"][2]["lng"] = json!(-103.79213);
    let error = read_widget(&map).expect_err("refused");
    assert!(
        error.starts_with("\"Wok Palace\" is 16,935 km from \"Galaxis\": a map shows one area"),
        "{error}"
    );
    // A road trip's stops are one area.
    let trip = json!({
        "kind": "map", "title": "Hanoi to Hue",
        "places": [
            {"name": "Hanoi", "lat": 21.0285, "lng": 105.8542},
            {"name": "Ninh Binh", "lat": 20.2506, "lng": 105.9745},
            {"name": "Hue", "lat": 16.4637, "lng": 107.5909}
        ]
    });
    assert!(read_widget(&trip).is_ok());
}

#[test]
fn what_a_place_says_of_itself_is_checked() {
    let refused = |field: &str, value: Value| {
        let mut map = lunch();
        map["places"][0][field] = value;
        read_widget(&map).expect_err("refused")
    };
    assert!(refused("category", json!("restaurant")).contains("use food, cafe, bar, shop"));
    assert!(refused("category", json!(3)).contains("category is a word"));
    assert!(refused("rating", json!(0)).contains("rating is 0: give the rating out of 5"));
    assert!(refused("rating", json!(9.2)).contains("rating is 9.2"));
    assert!(refused("price", json!(5)).contains("price is 1 to 4"));
    assert!(refused("price", json!(1.5)).contains("price is 1 to 4"));
    for link in [
        "breadyard.sg",
        "ftp://breadyard.sg",
        "http://localhost:3000/",
        "http://192.168.1.4/menu",
        "https://me:secret@breadyard.sg",
    ] {
        assert!(
            refused("link", json!(link)).contains("isn't a website"),
            "{link}"
        );
    }
    let mut map = lunch();
    map["places"][1]["name"] = json!("bread yard");
    let error = read_widget(&map).expect_err("refused");
    assert!(error.contains("\"bread yard\" is there twice"), "{error}");
    let mut map = lunch();
    map["places"] = json!([]);
    assert!(
        read_widget(&map)
            .expect_err("refused")
            .contains("give 1 to 8")
    );
}

#[test]
fn a_distance_reads_as_a_person_says_it() {
    assert_eq!(distance(0.0), "10 m");
    assert_eq!(distance(3.0), "10 m");
    assert_eq!(distance(344.0), "340 m");
    assert_eq!(distance(345.0), "350 m");
    assert_eq!(distance(994.0), "990 m");
    assert_eq!(distance(995.0), "1 km");
    assert_eq!(distance(1_249.0), "1.2 km");
    assert_eq!(distance(1_250.0), "1.3 km");
    assert_eq!(distance(9_949.0), "9.9 km");
    assert_eq!(distance(9_950.0), "10 km");
    assert_eq!(distance(12_345.0), "12 km");
    assert_eq!(distance(1_240_499.0), "1,240 km");
    assert_eq!(distance(16_935_577.0), "16,936 km");
}

#[test]
fn a_degree_north_is_about_111_km() {
    assert!((metres(0.0, 0.0, 1.0, 0.0) - 111_195.08).abs() < 0.01);
    assert!((metres(1.29947, 103.78753, 1.30561, 103.79213) - 853.01).abs() < 0.01);
    assert!(metres(1.3, 103.8, 1.3, 103.8).abs() < 1e-9, "no way apart");
}

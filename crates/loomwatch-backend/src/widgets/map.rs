//! A map (ADR 0114, amended 10 November): places to go or where things are, each a pin where the
//! agent found it, such as cafés near the person, a trip's stops or where to stay. `LoomWatch`
//! checks each position is on the Earth and that the places lie in one area, and tells the agent
//! how far each is from where the person starts (`from`), so its words agree with the map. The app
//! draws the map (`ui/src/lib/widgets/map.ts`); the iPhone draws it with Apple Maps. To look at:
//! nothing is kept.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Widget, limits, list, number, optional_text, text};

/// One place: its name, where it is, what sort of place it is, a few words on why, and what the
/// agent found of it: its rating out of 5, how dear it is (1 to 4) and its own website.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Place {
    pub(crate) name: String,
    pub(crate) lat: f64,
    pub(crate) lng: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) category: Option<Category>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) rating: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) price: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) link: Option<String>,
}

/// Where the person is or starts: the places' distances are from here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Start {
    pub(crate) name: String,
    pub(crate) lat: f64,
    pub(crate) lng: f64,
}

/// What sort of place it is, for its pin's mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Category {
    Food,
    Cafe,
    Bar,
    Shop,
    Hotel,
    Sight,
    Park,
    Transit,
    Other,
}

impl Category {
    const ALL: [(&'static str, Self); 9] = [
        ("food", Self::Food),
        ("cafe", Self::Cafe),
        ("bar", Self::Bar),
        ("shop", Self::Shop),
        ("hotel", Self::Hotel),
        ("sight", Self::Sight),
        ("park", Self::Park),
        ("transit", Self::Transit),
        ("other", Self::Other),
    ];

    /// The words `show_widget`'s schema lists.
    pub(crate) fn names() -> impl Iterator<Item = &'static str> {
        Self::ALL.iter().map(|(name, _)| *name)
    }
}

/// The Earth's mean radius, in metres: the app and the iPhone reckon distances with the same.
const EARTH_METRES: f64 = 6_371_008.8;

/// How far apart two positions are along the Earth, in metres, as the crow flies.
pub(crate) fn metres(lat_a: f64, lng_a: f64, lat_b: f64, lng_b: f64) -> f64 {
    let (a, b) = (lat_a.to_radians(), lat_b.to_radians());
    let across = (lat_b - lat_a).to_radians() / 2.0;
    let along = (lng_b - lng_a).to_radians() / 2.0;
    let h = across.sin().powi(2) + a.cos() * b.cos() * along.sin().powi(2);
    2.0 * EARTH_METRES * h.sqrt().min(1.0).asin()
}

/// A distance as the person reads it: `350 m` to the nearest 10 metres under a kilometre, `1.2 km`
/// to a tenth under 10 km, then whole kilometres (`1,240 km`). Twin of `distance` in
/// `ui/src/lib/widgets/map.ts` and of the iPhone's `MapDistance.written`.
pub(crate) fn distance(metres: f64) -> String {
    let tens = (metres / 10.0).round() * 10.0;
    if tens < 1_000.0 {
        return format!("{} m", tens.max(10.0));
    }
    let tenths = (metres / 100.0).round() / 10.0;
    if tenths < 10.0 {
        return if tenths.fract() == 0.0 {
            format!("{tenths:.0} km")
        } else {
            format!("{tenths:.1} km")
        };
    }
    format!("{} km", grouped(metres / 1_000.0))
}

/// A whole number with commas between thousands: `1,240`.
fn grouped(value: f64) -> String {
    let digits = format!("{:.0}", value.round());
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A position as the agent gave it: `lat` and `lng`, in degrees, on the Earth.
fn position(value: &Value) -> Result<(f64, f64), String> {
    let shape = "give lat and lng in degrees, as you found them, such as 1.2996 and 103.7875";
    let lat = number(value, "lat")?.ok_or_else(|| format!("lat is missing: {shape}"))?;
    let lng = number(value, "lng")?.ok_or_else(|| format!("lng is missing: {shape}"))?;
    if !(-90.0..=90.0).contains(&lat) {
        return Err(format!("lat is {lat}: it is -90 to 90; {shape}"));
    }
    if !(-180.0..=180.0).contains(&lng) {
        return Err(format!("lng is {lng}: it is -180 to 180; {shape}"));
    }
    if lat == 0.0 && lng == 0.0 {
        return Err(format!("lat and lng are both 0, in the sea: {shape}"));
    }
    Ok((lat, lng))
}

/// A rating out of 5 as the place's reviews give it, kept to one decimal: `4.8`.
fn rating(place: &Value) -> Result<Option<f64>, String> {
    let Some(rating) = number(place, "rating")? else {
        return Ok(None);
    };
    if !(1.0..=5.0).contains(&rating) {
        return Err(format!(
            "rating is {rating}: give the rating out of 5 its reviews give, such as 4.6, or leave \
             it out"
        ));
    }
    Ok(Some((rating * 10.0).round() / 10.0))
}

/// How dear a place is, from 1 (`$`) to 4 (`$$$$`).
fn price(place: &Value) -> Result<Option<u8>, String> {
    match place.get("price") {
        None | Some(Value::Null) => Ok(None),
        Some(price) => price
            .as_u64()
            .and_then(|price| u8::try_from(price).ok())
            .filter(|price| (1..=4).contains(price))
            .map(Some)
            .ok_or_else(|| "price is 1 to 4, from cheap ($) to dear ($$$$)".to_owned()),
    }
}

/// The place's own website, which the person opens: a public `https` or `http` address.
fn link(place: &Value) -> Result<Option<String>, String> {
    let Some(written) = optional_text(place, "link", limits::PLACE_LINK_CHARS)? else {
        return Ok(None);
    };
    let refused = || {
        format!(
            "link \"{written}\" isn't a website: give the place's own, such as https://breadyard.sg"
        )
    };
    let url = url::Url::parse(&written).map_err(|_| refused())?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || crate::agent::tools::link::on_this_network(&url)
    {
        return Err(refused());
    }
    Ok(Some(url.to_string()))
}

/// A map, read and checked: every position on the Earth, every name once, and every place within
/// [`limits::MAP_SPREAD_KM`] of the others and of `from`, since a map shows one area and a place
/// far from the rest is most likely given in the wrong place.
pub(crate) fn read(arguments: &Value, title: String) -> Result<Widget, String> {
    let places = list(arguments, "places", limits::PLACES, |place| {
        let (lat, lng) = position(place)?;
        Ok(Place {
            name: text(place, "name", 1, limits::PLACE_NAME_CHARS)?,
            lat,
            lng,
            category: match place.get("category") {
                None | Some(Value::Null) => None,
                Some(Value::String(word)) => Some(
                    Category::ALL
                        .iter()
                        .find(|(name, _)| word.trim().eq_ignore_ascii_case(name))
                        .map(|(_, category)| *category)
                        .ok_or_else(|| {
                            format!(
                                "category \"{word}\" isn't one: use {}",
                                Category::names().collect::<Vec<_>>().join(", ")
                            )
                        })?,
                ),
                Some(_) => return Err("category is a word, such as cafe".to_owned()),
            },
            note: optional_text(place, "note", limits::PLACE_NOTE_CHARS)?,
            address: optional_text(place, "address", limits::PLACE_ADDRESS_CHARS)?,
            rating: rating(place)?,
            price: price(place)?,
            link: link(place)?,
        })
    })?;
    let from = match arguments.get("from") {
        None | Some(Value::Null) => None,
        Some(from) if from.is_object() => {
            let (lat, lng) = position(from).map_err(|error| format!("from: {error}"))?;
            Some(Start {
                name: text(from, "name", 1, limits::FROM_NAME_CHARS)
                    .map_err(|error| format!("from: {error}"))?,
                lat,
                lng,
            })
        }
        Some(_) => {
            return Err("from is where they start: its name, lat and lng".to_owned());
        }
    };
    for (at, place) in places.iter().enumerate() {
        if places[..at]
            .iter()
            .any(|before| before.name.eq_ignore_ascii_case(&place.name))
        {
            return Err(format!(
                "\"{}\" is there twice: give each place once",
                place.name
            ));
        }
    }
    let spots: Vec<(&str, f64, f64)> = from
        .iter()
        .map(|from| (from.name.as_str(), from.lat, from.lng))
        .chain(
            places
                .iter()
                .map(|place| (place.name.as_str(), place.lat, place.lng)),
        )
        .collect();
    for (at, (name, lat, lng)) in spots.iter().enumerate() {
        for (other, other_lat, other_lng) in &spots[..at] {
            let apart = metres(*lat, *lng, *other_lat, *other_lng);
            if apart > limits::MAP_SPREAD_KM * 1_000.0 {
                return Err(format!(
                    "\"{name}\" is {} from \"{other}\": a map shows one area, so check where it \
                     is, or show the places of one region",
                    distance(apart)
                ));
            }
        }
    }
    Ok(Widget::Map {
        title,
        places,
        from,
    })
}

/// What the agent is told of the map it showed, so its words agree with it: "From Galaxis, as the
/// crow flies: Bread Yard 350 m, Wok Palace 1.2 km", or how far apart the places are.
pub(crate) fn distances_line(places: &[Place], from: Option<&Start>) -> String {
    if let Some(from) = from {
        let each = places
            .iter()
            .map(|place| {
                format!(
                    "{} {}",
                    place.name,
                    distance(metres(from.lat, from.lng, place.lat, place.lng))
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        return format!("From {}, as the crow flies: {each}", from.name);
    }
    let widest = places
        .iter()
        .enumerate()
        .flat_map(|(at, place)| {
            places[..at]
                .iter()
                .map(move |other| metres(place.lat, place.lng, other.lat, other.lng))
        })
        .fold(0.0, f64::max);
    if places.len() < 2 {
        "One place on the map".to_owned()
    } else {
        format!(
            "The places are within {} of each other, as the crow flies",
            distance(widest)
        )
    }
}

/// "Bread Yard, Wok Palace; from Galaxis": a map's places in a line, for the next run.
pub(crate) fn line(places: &[Place], from: Option<&Start>) -> String {
    let names = places
        .iter()
        .map(|place| place.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    match from {
        Some(from) => format!("{names}; from {}", from.name),
        None => names,
    }
}

#[cfg(test)]
mod tests;

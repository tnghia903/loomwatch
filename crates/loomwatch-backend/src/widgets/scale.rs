//! A scale (ADR 0114, amended 8 November): named ranges from low to high, drawn to scale, with up
//! to three values pinned where they fall, such as a temperature among Normal and Fever. A value
//! read against ranges that say what it means is judged better than the number alone. `LoomWatch`
//! works out which range each pin falls in and tells the agent ([`pins_line`]), so its words say
//! the same. To look at: nothing is kept.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Widget, decimals, limits, list, number, optional_text, text, written};

/// One named range: where it starts and where it ends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Range {
    pub(crate) label: String,
    pub(crate) from: f64,
    pub(crate) to: f64,
}

/// One value placed on the scale, and whose it is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Pin {
    pub(crate) label: String,
    pub(crate) value: f64,
}

/// A scale, read and checked: each range ends above where it starts and starts where the one
/// before it ends, and every pin is on the scale.
pub(crate) fn read(arguments: &Value, title: String) -> Result<Widget, String> {
    let ranges = list(arguments, "ranges", limits::RANGES, |range| {
        let from = number(range, "from")?.ok_or("from is missing: give where it starts")?;
        let to = number(range, "to")?.ok_or("to is missing: give where it ends")?;
        if to <= from {
            return Err(format!(
                "it ends at {to}, not above where it starts, {from}: give ranges from low to high"
            ));
        }
        Ok(Range {
            label: text(range, "label", 1, limits::RANGE_LABEL_CHARS)?,
            from,
            to,
        })
    })?;
    for (at, pair) in ranges.windows(2).enumerate() {
        let (before, this) = (&pair[0], &pair[1]);
        // The same written number reads as the same float, so meeting ranges compare equal.
        #[allow(clippy::float_cmp)]
        let meets = this.from == before.to;
        if !meets {
            return Err(format!(
                "ranges {}: \"{}\" starts at {}, but \"{}\" ends at {}: start each range where \
                 the one before it ends, such as 36.1 to 37.5 then 37.5 to 40",
                at + 2,
                this.label,
                this.from,
                before.label,
                before.to
            ));
        }
    }
    let (low, high) = (ranges[0].from, ranges[ranges.len() - 1].to);
    let pins = list(arguments, "pins", limits::PINS, |pin| {
        let value = number(pin, "value")?.ok_or("value is missing: give it as a number")?;
        if value < low || value > high {
            return Err(format!(
                "value {value} is off the scale, which runs from {low} to {high}: widen the \
                 first or last range to take it in"
            ));
        }
        Ok(Pin {
            label: text(pin, "label", 1, limits::PIN_LABEL_CHARS)?,
            value,
        })
    })?;
    Ok(Widget::Scale {
        title,
        ranges,
        pins,
        unit: optional_text(arguments, "unit", limits::UNIT_CHARS)?,
        prefix: optional_text(arguments, "prefix", limits::UNIT_CHARS)?,
        decimals: decimals(arguments)?,
    })
}

/// The range `value` falls in: the one it is at or above the start of and below the end of, or
/// the last for its very top. The app's `rangeOf` (`ui/src/lib/widgets/scale.ts`) is its twin.
pub(crate) fn range_of(ranges: &[Range], value: f64) -> Option<&Range> {
    ranges
        .iter()
        .find(|range| value >= range.from && value < range.to)
        .or_else(|| {
            ranges
                .last()
                .filter(|last| value <= last.to && value >= last.from)
        })
}

/// "You 38.5 °C: in Fever (37.5 to 40 °C)": each pin and the range it falls in, for the agent and
/// the next run.
pub(crate) fn pins_line(
    ranges: &[Range],
    pins: &[Pin],
    prefix: Option<&str>,
    unit: Option<&str>,
    decimals: Option<u8>,
) -> String {
    pins.iter()
        .map(|pin| {
            let mut line = format!(
                "{} {}",
                pin.label,
                written(pin.value, prefix, unit, decimals)
            );
            if let Some(range) = range_of(ranges, pin.value) {
                let _ = write!(
                    line,
                    ": in {} ({} to {})",
                    range.label,
                    written(range.from, prefix, None, decimals),
                    written(range.to, prefix, unit, decimals)
                );
            }
            line
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// "Low 35 to 36.1 °C, Normal 36.1 to 37.5 °C, Fever 37.5 to 40 °C": the ranges in a line.
pub(crate) fn ranges_line(
    ranges: &[Range],
    prefix: Option<&str>,
    unit: Option<&str>,
    decimals: Option<u8>,
) -> String {
    ranges
        .iter()
        .map(|range| {
            format!(
                "{} {} to {}",
                range.label,
                written(range.from, prefix, None, decimals),
                written(range.to, prefix, unit, decimals)
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests;

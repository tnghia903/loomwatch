//! Excel workbooks, sheet by sheet, each cell as Excel shows it.
//!
//! The reader draws these words as sheets (ADR 0091, `ui/src/lib/files/cells.ts` `parseWorkbook`):
//! keep each sheet's first line ("Sheet 2 of 3: Sales (12 rows, 4 columns, from cell B3)") as it is.

use std::fmt::Write as _;
use std::path::Path;

use calamine::Reader as _;

use super::MAX_TEXT_BYTES;

pub(super) fn text(path: &Path, name: &str) -> Result<String, String> {
    let zipped = !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xls"));
    if zipped {
        // Checked before calamine unpacks it.
        super::office::open_zip(path, name, "Excel")?;
    }
    let mut book = calamine::open_workbook_auto(path).map_err(|_| {
        format!("{name} isn't an Excel file LoomWatch can open: it may be damaged.")
    })?;
    let sheets = book.sheet_names();
    let count = sheets.len();
    let mut out = String::new();
    for (index, sheet) in sheets.iter().enumerate() {
        let _ = write!(out, "Sheet {} of {count}: {sheet}", index + 1);
        let Ok(range) = book.worksheet_range(sheet) else {
            out.push_str(" (not a table of cells)\n\n");
            continue;
        };
        let (rows, columns) = range.get_size();
        let Some((first_row, first_column)) = range.start().filter(|_| !range.is_empty()) else {
            out.push_str(" (empty)\n\n");
            continue;
        };
        let _ = write!(
            out,
            " ({rows} row{}, {columns} column{}",
            if rows == 1 { "" } else { "s" },
            if columns == 1 { "" } else { "s" }
        );
        if (first_row, first_column) != (0, 0) {
            let _ = write!(
                out,
                ", from cell {}{}",
                column_name(first_column),
                first_row + 1
            );
        }
        out.push_str(")\n");
        for row in range.rows() {
            let cells: Vec<String> = row.iter().map(cell_text).collect();
            let end = cells
                .iter()
                .rposition(|cell| !cell.is_empty())
                .map_or(0, |at| at + 1);
            out.push_str(&cells[..end].join("\t"));
            out.push('\n');
            if out.len() > MAX_TEXT_BYTES {
                return Ok(out);
            }
        }
        out.push('\n');
    }
    Ok(out)
}

/// `0` → `A`, `27` → `AB`.
pub(crate) fn column_name(index: u32) -> String {
    let mut name = Vec::new();
    let mut rest = index + 1;
    while rest > 0 {
        let digit = (rest - 1) % 26;
        name.push(b'A' + u8::try_from(digit).unwrap_or(0));
        rest = (rest - 1) / 26;
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_default()
}

/// A cell as Excel shows it: a number to 15 significant figures, a date as a date, `TRUE`.
fn cell_text(cell: &calamine::Data) -> String {
    use calamine::Data;
    let text = match cell {
        Data::Empty => String::new(),
        Data::Float(number) => number_text(*number),
        Data::Bool(value) => if *value { "TRUE" } else { "FALSE" }.to_owned(),
        Data::DateTime(moment) => date_text(moment),
        other => other.to_string(),
    };
    if text.contains(['\t', '\n', '\r']) {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        text
    }
}

pub(super) fn number_text(number: f64) -> String {
    if !number.is_finite() {
        return number.to_string();
    }
    if number.fract() == 0.0 && number.abs() < 1e15 {
        return format!("{number:.0}");
    }
    // Excel shows 15 significant figures: 0.1 + 0.2 is 0.3 there, not 0.30000000000000004.
    #[allow(clippy::cast_possible_truncation)] // A finite f64's log10 is far inside i32.
    let magnitude = number.abs().log10().floor() as i32;
    if !(-9..15).contains(&magnitude) {
        return format!("{number:e}");
    }
    let decimals = usize::try_from((14 - magnitude).clamp(0, 30)).unwrap_or(0);
    let fixed = format!("{number:.decimals$}");
    if fixed.contains('.') {
        fixed.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        fixed
    }
}

fn date_text(moment: &calamine::ExcelDateTime) -> String {
    if moment.is_duration() {
        let seconds = (moment.as_f64() * 86_400.0).round();
        #[allow(clippy::cast_possible_truncation)] // A duration a sheet shows fits easily.
        let seconds = seconds as i64;
        return format!(
            "{}:{:02}:{:02}",
            seconds / 3600,
            seconds % 3600 / 60,
            seconds % 60
        );
    }
    let (year, month, day, hour, minute, second, _) = moment.to_ymd_hms_milli();
    let date = format!("{year:04}-{month:02}-{day:02}");
    match (hour, minute, second) {
        (0, 0, 0) => date,
        (_, _, 0) => format!("{date} {hour:02}:{minute:02}"),
        _ => format!("{date} {hour:02}:{minute:02}:{second:02}"),
    }
}

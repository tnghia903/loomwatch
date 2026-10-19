//! Word and `PowerPoint` files: ZIPs of XML parts, read in the order a person sees them.

use std::fmt::Write as _;
use std::fs;
use std::io::Read as _;
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

use super::{MAX_PART_BYTES, MAX_UNPACKED_BYTES};

type Archive = zip::ZipArchive<fs::File>;

pub(super) fn open_zip(path: &Path, name: &str, kind: &str) -> Result<Archive, String> {
    let file = fs::File::open(path).map_err(|error| format!("{name} couldn't be read: {error}"))?;
    let archive = zip::ZipArchive::new(file).map_err(|_| {
        format!("{name} isn't a {kind} file LoomWatch can open: it may be damaged.")
    })?;
    if archive
        .decompressed_size()
        .is_some_and(|size| size > MAX_UNPACKED_BYTES)
    {
        return Err(format!(
            "{name} unpacks to more than {} MB, more than LoomWatch reads.",
            MAX_UNPACKED_BYTES / 1024 / 1024
        ));
    }
    Ok(archive)
}

/// One part of an Office file as text, or `None` when it has no such part.
fn part(archive: &mut Archive, part: &str) -> Option<String> {
    let entry = archive.by_name(part).ok()?;
    let mut bytes = Vec::new();
    entry.take(MAX_PART_BYTES).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// A ZIP part's path from a relationship `target`, which is relative to the folder of the part
/// that names it unless it starts at the root.
fn resolve_part(folder: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_owned();
    }
    let mut parts: Vec<&str> = folder.split('/').filter(|part| !part.is_empty()).collect();
    for piece in target.split('/') {
        match piece {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            piece => parts.push(piece),
        }
    }
    parts.join("/")
}

/// `(id, target, type)` of each relationship in a `.rels` part.
fn relationships(xml: &str) -> Vec<(String, String, String)> {
    let mut reader = Reader::from_str(xml);
    let mut found = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag))
                if tag.local_name().as_ref() == "Relationship" =>
            {
                found.push((
                    attribute(&tag, "Id").unwrap_or_default(),
                    attribute(&tag, "Target").unwrap_or_default(),
                    attribute(&tag, "Type").unwrap_or_default(),
                ));
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    found
}

fn attribute(tag: &BytesStart<'_>, key: &str) -> Option<String> {
    tag.attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| attribute.key.as_ref() == key)
        .map(|attribute| {
            quick_xml::escape::unescape(&attribute.value).map_or_else(
                |_| attribute.value.to_string(),
                std::borrow::Cow::into_owned,
            )
        })
}

/// The element names of one Office format's text.
struct Tags {
    paragraph: &'static str,
    text: &'static str,
    run: &'static str,
    row: &'static str,
    cell: &'static str,
    breaks: &'static [&'static str],
    /// Word's breaks sit in runs; outside one, `w:br` is something else. A slide's sit between them.
    breaks_in_runs: bool,
    tab: Option<&'static str>,
}

const WORD_TAGS: Tags = Tags {
    paragraph: "w:p",
    text: "w:t",
    run: "w:r",
    row: "w:tr",
    cell: "w:tc",
    breaks: &["w:br", "w:cr"],
    breaks_in_runs: true,
    tab: Some("w:tab"),
};

const SLIDE_TAGS: Tags = Tags {
    paragraph: "a:p",
    text: "a:t",
    run: "a:r",
    row: "a:tr",
    cell: "a:tc",
    breaks: &["a:br"],
    breaks_in_runs: false,
    tab: None,
};

/// One paragraph or table row of an Office part.
#[derive(Debug, Default)]
struct Line {
    text: String,
    /// `# ` marks for a Word heading: its level.
    heading: usize,
    /// A list item.
    listed: bool,
    /// The placeholder the shape holding it is, on a slide: `title`, `body`, `sldNum`, …
    placeholder: Option<String>,
}

/// The paragraphs of an Office part in order. A table row is one line, its cells separated by tabs;
/// a cell's own paragraphs are joined by spaces. Text boxes come out where they are anchored, and
/// the copy Office keeps for older readers (`mc:Fallback`) is left out, so nothing comes twice.
fn lines(xml: &str, tags: &Tags) -> Vec<Line> {
    let mut reader = Reader::from_str(xml);
    let mut walk = Walk::new(tags);
    let mut skipping = 0_usize;
    loop {
        let event = match reader.read_event() {
            Ok(Event::Eof) | Err(_) => break,
            Ok(event) => event,
        };
        if skipping > 0 {
            match &event {
                Event::Start(tag) if tag.name().as_ref() == "mc:Fallback" => skipping += 1,
                Event::End(tag) if tag.name().as_ref() == "mc:Fallback" => skipping -= 1,
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(tag) if tag.name().as_ref() == "mc:Fallback" => skipping = 1,
            Event::Start(tag) => walk.start(&tag),
            Event::Empty(tag) => walk.empty(&tag),
            Event::End(tag) => walk.end(tag.name().as_ref()),
            Event::Text(text) if walk.in_text => walk.push(&text.xml10_content()),
            Event::CData(text) if walk.in_text => walk.push(&text.xml10_content()),
            Event::GeneralRef(reference) if walk.in_text => {
                let resolved = match reference.resolve_char_ref() {
                    Ok(Some(character)) => character.to_string(),
                    _ => quick_xml::escape::resolve_predefined_entity(&reference.xml10_content())
                        .unwrap_or_default()
                        .to_owned(),
                };
                walk.push(&resolved);
            }
            _ => {}
        }
    }
    walk.lines
}

/// Where a walk through an Office part has got to.
struct Walk<'t> {
    tags: &'t Tags,
    lines: Vec<Line>,
    /// Paragraphs open now: a text box's sits inside the paragraph it is anchored in.
    open: Vec<Line>,
    /// The cells of the table row open now.
    cells: Vec<String>,
    cell_depth: usize,
    row_depth: usize,
    in_text: bool,
    in_run: usize,
    /// The placeholder the slide shape open now fills.
    placeholder: Option<String>,
}

impl<'t> Walk<'t> {
    fn new(tags: &'t Tags) -> Self {
        Self {
            tags,
            lines: Vec::new(),
            open: Vec::new(),
            cells: Vec::new(),
            cell_depth: 0,
            row_depth: 0,
            in_text: false,
            in_run: 0,
            placeholder: None,
        }
    }

    fn start(&mut self, tag: &BytesStart<'_>) {
        let name = tag.name();
        let name = name.as_ref();
        if name == self.tags.paragraph {
            self.open.push(Line {
                placeholder: self.placeholder.clone(),
                ..Line::default()
            });
        } else if name == self.tags.text {
            self.in_text = true;
        } else if name == self.tags.run {
            self.in_run += 1;
        } else if name == self.tags.row {
            self.row_depth += 1;
            if self.row_depth == 1 {
                self.cells.clear();
            }
        } else if name == self.tags.cell {
            self.cell_depth += 1;
            if self.cell_depth == 1 {
                self.cells.push(String::new());
            }
        } else if name == "w:numPr" {
            if let Some(line) = self.open.last_mut() {
                line.listed = true;
            }
        } else if name == "p:sp" {
            self.placeholder = None;
        } else if name == "p:ph" {
            self.found_placeholder(tag);
        }
    }

    fn empty(&mut self, tag: &BytesStart<'_>) {
        let name = tag.name();
        let name = name.as_ref();
        if (self.in_run > 0 || !self.tags.breaks_in_runs) && self.tags.breaks.contains(&name) {
            self.push("\n");
        } else if self.in_run > 0 && self.tags.tab == Some(name) {
            self.push("\t");
        } else if name == "w:pStyle" {
            let level = attribute(tag, "w:val").map_or(0, |style| heading_level(&style));
            if let Some(line) = self.open.last_mut() {
                line.heading = level;
            }
        } else if name == "p:ph" {
            self.found_placeholder(tag);
        } else if name == self.tags.paragraph {
            self.end_paragraph(Line::default());
        }
    }

    fn end(&mut self, name: &str) {
        if name == self.tags.paragraph {
            if let Some(line) = self.open.pop() {
                self.end_paragraph(line);
            }
        } else if name == self.tags.text {
            self.in_text = false;
        } else if name == self.tags.run {
            self.in_run = self.in_run.saturating_sub(1);
        } else if name == self.tags.cell {
            self.cell_depth = self.cell_depth.saturating_sub(1);
        } else if name == self.tags.row {
            self.row_depth = self.row_depth.saturating_sub(1);
            if self.row_depth == 0 {
                self.end_row();
            }
        } else if name == "p:sp" {
            self.placeholder = None;
        }
    }

    /// Text into the paragraph open now, or into the table cell it is in.
    fn push(&mut self, text: &str) {
        if let Some(line) = self.open.last_mut() {
            line.text.push_str(text);
        } else if self.cell_depth > 0
            && let Some(cell) = self.cells.last_mut()
        {
            cell.push_str(text);
        }
    }

    fn end_paragraph(&mut self, line: Line) {
        if self.cell_depth == 0 {
            self.lines.push(line);
        } else if let Some(cell) = self.cells.last_mut() {
            if !cell.is_empty() && !line.text.trim().is_empty() {
                cell.push(' ');
            }
            cell.push_str(line.text.trim());
        }
    }

    fn end_row(&mut self) {
        let row: Vec<String> = self
            .cells
            .drain(..)
            .map(|cell| cell.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        let end = row
            .iter()
            .rposition(|cell| !cell.is_empty())
            .map_or(0, |at| at + 1);
        self.lines.push(Line {
            text: row[..end].join("\t"),
            placeholder: self.placeholder.clone(),
            ..Line::default()
        });
    }

    /// A slide shape says which placeholder it fills; one with no type is the body.
    fn found_placeholder(&mut self, tag: &BytesStart<'_>) {
        self.placeholder = Some(attribute(tag, "type").unwrap_or_else(|| "body".to_owned()));
        if let Some(line) = self.open.last_mut() {
            line.placeholder.clone_from(&self.placeholder);
        }
    }
}

/// `Heading2` → 2, `Title` → 1; any other style is not a heading.
pub(super) fn heading_level(style: &str) -> usize {
    if style.eq_ignore_ascii_case("Title") {
        return 1;
    }
    style
        .strip_prefix("Heading")
        .or_else(|| style.strip_prefix("heading"))
        .and_then(|level| level.trim().parse::<usize>().ok())
        .filter(|level| (1..=6).contains(level))
        .unwrap_or(0)
}

fn written(lines: &[Line]) -> String {
    let mut out = String::new();
    for line in lines {
        let text = line.text.trim_end();
        if line.heading > 0 && !text.trim().is_empty() {
            let _ = write!(out, "{} ", "#".repeat(line.heading));
        } else if line.listed && !text.trim().is_empty() {
            out.push_str("- ");
        }
        out.push_str(text);
        out.push('\n');
    }
    out
}

pub(super) fn word(path: &Path, name: &str) -> Result<String, String> {
    let mut archive = open_zip(path, name, "Word")?;
    let document = part(&mut archive, "word/document.xml").ok_or_else(|| {
        format!("{name} isn't a Word file LoomWatch can open: it has no text part.")
    })?;
    Ok(written(&lines(&document, &WORD_TAGS)))
}

pub(super) fn powerpoint(path: &Path, name: &str) -> Result<String, String> {
    let mut archive = open_zip(path, name, "PowerPoint")?;
    let slides = slide_parts(&mut archive);
    if slides.is_empty() {
        return Err(format!("{name} has no slides."));
    }
    let count = slides.len();
    let mut out = String::new();
    for (index, slide) in slides.iter().enumerate() {
        let Some(xml) = part(&mut archive, slide) else {
            continue;
        };
        let hidden = xml_root_attribute(&xml, "show").as_deref() == Some("0");
        let _ = writeln!(
            out,
            "Slide {} of {count}{}",
            index + 1,
            if hidden { " (hidden)" } else { "" }
        );
        out.push_str(&written(&lines(&xml, &SLIDE_TAGS)));
        if let Some(notes) =
            notes_part(&mut archive, slide).and_then(|notes| part(&mut archive, &notes))
        {
            let spoken: Vec<Line> = lines(&notes, &SLIDE_TAGS)
                .into_iter()
                .filter(|line| line.placeholder.as_deref() == Some("body"))
                .collect();
            let spoken = written(&spoken);
            if !spoken.trim().is_empty() {
                out.push_str("Notes:\n");
                out.push_str(&spoken);
            }
        }
        out.push('\n');
    }
    Ok(out)
}

/// The slides in the order the deck shows them, by `presentation.xml`; by their numbers when it
/// can't say.
fn slide_parts(archive: &mut Archive) -> Vec<String> {
    let order = part(archive, "ppt/presentation.xml").map(|xml| {
        let mut reader = Reader::from_str(&xml);
        let mut ids = Vec::new();
        loop {
            match reader.read_event() {
                Ok(Event::Start(tag) | Event::Empty(tag)) if tag.name().as_ref() == "p:sldId" => {
                    ids.extend(attribute(&tag, "r:id"));
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        ids
    });
    let targets = part(archive, "ppt/_rels/presentation.xml.rels")
        .map(|xml| relationships(&xml))
        .unwrap_or_default();
    let ordered: Vec<String> = order
        .unwrap_or_default()
        .iter()
        .filter_map(|id| targets.iter().find(|(rid, _, _)| rid == id))
        .map(|(_, target, _)| resolve_part("ppt", target))
        .collect();
    if !ordered.is_empty() {
        return ordered;
    }
    let mut numbered: Vec<(u32, String)> = archive
        .file_names()
        .filter_map(Result::ok)
        .filter_map(|file| {
            let number = file
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse()
                .ok()?;
            Some((number, file.into_owned()))
        })
        .collect();
    numbered.sort();
    numbered.into_iter().map(|(_, file)| file).collect()
}

/// The notes part of a slide part, from the slide's relationships.
fn notes_part(archive: &mut Archive, slide: &str) -> Option<String> {
    let (folder, file) = slide.rsplit_once('/')?;
    let rels = part(archive, &format!("{folder}/_rels/{file}.rels"))?;
    relationships(&rels)
        .into_iter()
        .find(|(_, _, kind)| kind.ends_with("/notesSlide"))
        .map(|(_, target, _)| resolve_part(folder, &target))
}

fn xml_root_attribute(xml: &str, key: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) => return attribute(&tag, key),
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

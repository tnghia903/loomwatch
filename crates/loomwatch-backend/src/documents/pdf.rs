//! A PDF's text, page by page.

use std::fmt::Write as _;
use std::fs;
use std::panic::AssertUnwindSafe;
use std::path::Path;

use super::{MAX_TEXT_BYTES, tidy};

pub(super) fn text(path: &Path, name: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("{name} couldn't be read: {error}"))?;
    let locked = || {
        format!(
            "{name} is locked with a password, so LoomWatch can't read it. Ask the person for a \
             copy without one."
        )
    };
    let document = pdf_extract::Document::load_mem(&bytes).map_err(|error| match error {
        pdf_extract::Error::Decryption(_) | pdf_extract::Error::InvalidPassword => locked(),
        other => format!("{name} couldn't be read as a PDF: {other}."),
    })?;
    // Loading opens a PDF that needs no password, as most locked ones do: they only restrict
    // printing or copying. One still locked needs a password.
    if document.is_encrypted() {
        return Err(locked());
    }
    let pages: Vec<u32> = document.get_pages().keys().copied().collect();
    let count = pages.len();
    let mut texts = Vec::with_capacity(count);
    let mut size = 0;
    for number in pages {
        let mut text = String::new();
        // The reader stops with a panic on some damaged pages: the others are still read.
        let read = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let mut output = pdf_extract::PlainTextOutput::new(&mut text);
            pdf_extract::output_doc_page(&document, &mut output, number)
        }));
        let text = match read {
            Ok(Ok(())) => tidy(&text),
            _ => "(This page couldn't be read.)".to_owned(),
        };
        size += text.len();
        texts.push(text);
        if size > MAX_TEXT_BYTES {
            break;
        }
    }
    if texts.iter().all(String::is_empty) {
        return Err(format!(
            "{name} has no text in it. It is probably scanned pages, and LoomWatch can't read the \
             words in pictures of pages yet."
        ));
    }
    if count == 1 {
        return Ok(texts.remove(0));
    }
    let mut out = String::new();
    for (index, text) in texts.iter().enumerate() {
        let _ = writeln!(out, "— Page {} of {count} —", index + 1);
        if text.is_empty() {
            out.push_str("(No text on this page: it may be a scanned picture.)");
        } else {
            out.push_str(text);
        }
        out.push_str("\n\n");
    }
    Ok(out)
}

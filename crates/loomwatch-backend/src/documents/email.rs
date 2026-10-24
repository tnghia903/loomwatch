//! An email file (`.eml`: RFC 822 and MIME), as Mail hands over a message dragged out of it: who
//! wrote to whom and when, its subject, and its words, then what was attached, by name and size.
//! A body sent in base64 or quoted-printable, in any charset, comes out as words, and a message
//! with only HTML comes out as its text. A message forwarded as an attachment is read in its place,
//! a few levels deep; other attachments are named, not opened.

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use mail_parser::{Address, Message, MessageParser, MimeHeaders as _};

/// How many messages inside messages are read: one forwarded as an attachment of one forwarded as
/// an attachment, and so on. Past that, an attached message is named like any attachment.
const NESTED_MESSAGES: usize = 3;

/// `path`'s headers, words and attachments, as text.
pub(super) fn text(path: &Path, name: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("{name} couldn't be read: {error}"))?;
    let message = MessageParser::default()
        .parse(&bytes)
        // An email says who it is from or to, what about, or when; a file that says none of it,
        // whatever its name, isn't one.
        .filter(|message| {
            message.from().is_some()
                || message.to().is_some()
                || message.subject().is_some()
                || message.date().is_some()
        })
        .ok_or_else(|| format!("{name} isn't an email LoomWatch can read: it may be damaged."))?;
    let mut out = String::new();
    write_message(&mut out, &message, 0);
    Ok(out)
}

fn write_message(out: &mut String, message: &Message<'_>, depth: usize) {
    for (label, address) in [
        ("From", message.from()),
        ("To", message.to()),
        ("Cc", message.cc()),
    ] {
        if let Some(people) = address.map(listed).filter(|people| !people.is_empty()) {
            let _ = writeln!(out, "{label}: {people}");
        }
    }
    if let Some(date) = message.date() {
        let _ = writeln!(out, "Date: {}", date.to_rfc822());
    }
    if let Some(subject) = message.subject() {
        let _ = writeln!(out, "Subject: {subject}");
    }
    for index in 0..message.text_body_count() {
        if let Some(words) = message.body_text(index) {
            out.push('\n');
            out.push_str(words.trim_end());
            out.push('\n');
        }
    }
    let mut named = Vec::new();
    for part in message.attachments() {
        match part.message() {
            Some(inner) if depth < NESTED_MESSAGES => {
                out.push_str("\n--- Attached message ---\n");
                write_message(out, inner, depth + 1);
                out.push_str("--- End of attached message ---\n");
            }
            // A picture placed in the words of an HTML message, with no name, is part of how it
            // looked, not something sent.
            _ => match part.attachment_name() {
                Some(file) => named.push(format!(
                    "- {file} ({})",
                    crate::chosen_knowledge::human_size(part.len() as u64)
                )),
                None if part.is_message() => named.push("- an attached message".to_owned()),
                None => {}
            },
        }
    }
    if !named.is_empty() {
        out.push_str("\nAttached files (named here; their contents aren't part of this text):\n");
        for line in named {
            out.push_str(&line);
            out.push('\n');
        }
    }
}

/// "Lan Nguyen <lan@example.com>, team@example.com".
fn listed(address: &Address<'_>) -> String {
    address
        .iter()
        .filter_map(|person| match (person.name(), person.address()) {
            (Some(name), Some(address)) if !name.is_empty() => Some(format!("{name} <{address}>")),
            (_, Some(address)) => Some(address.to_owned()),
            (Some(name), None) => Some(name.to_owned()),
            (None, None) => None,
        })
        .collect::<Vec<_>>()
        .join(", ")
}

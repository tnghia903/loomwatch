//! `osascript`'s command line, read the way `/usr/bin/osascript` reads it (`man osascript`):
//!
//! ```text
//! osascript [-l language] [-i] [-s flags] [-e statement | programfile] [argument ...]
//! ```
//!
//! Options come first, in `getopt` style (`-sh`, `-lJavaScript`, `--`). With `-e`, every word
//! after the options is an argument for the script's `run` handler; without it the first is the
//! script's file (`-` or none: the script is read from standard input).

use std::ffi::OsString;
use std::path::PathBuf;

/// Where the script comes from.
#[derive(Debug, PartialEq, Eq)]
pub enum Source {
    /// The `-e` lines, joined by line breaks.
    Lines(String),
    File(PathBuf),
    Stdin,
}

/// One run of `osascript`.
#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    /// `-l`: the language plain text is compiled in. `AppleScript` when not given.
    pub language: Option<String>,
    pub source: Source,
    /// Handed to the script's `run` handler as a list of strings.
    pub arguments: Vec<String>,
    /// `-s s`: results as recompilable source (`{"a", 1}`) rather than for people (`a, 1`).
    pub source_form: bool,
    /// `-s o`: errors go to standard output rather than standard error.
    pub errors_to_stdout: bool,
    /// `-i`: one line at a time, typed in.
    pub interactive: bool,
}

pub const USAGE: &str =
    "usage: osascript [-l language] [-e script] [-i] [-s {ehso}] [programfile] [argument ...]";

/// What `osascript` prints before [`USAGE`] for a command line it can't read.
#[derive(Debug, PartialEq, Eq)]
pub struct Problem(pub String);

/// Reads `osascript`'s arguments. `program` is the name it was started by, which `getopt`'s
/// complaints begin with.
///
/// # Errors
///
/// An unknown option, an option missing its value, or an unknown `-s` flag, in the words
/// `/usr/bin/osascript` uses.
pub fn parse(
    program: &str,
    words: impl IntoIterator<Item = OsString>,
) -> Result<Invocation, Problem> {
    let mut words = words
        .into_iter()
        .map(|word| word.to_string_lossy().into_owned());
    let mut invocation = Invocation {
        language: None,
        source: Source::Stdin,
        arguments: Vec::new(),
        source_form: false,
        errors_to_stdout: false,
        interactive: false,
    };
    let mut lines: Option<Vec<String>> = None;
    let mut rest = Vec::new();
    while let Some(word) = words.next() {
        if word == "--" {
            rest.extend(words.by_ref());
            break;
        }
        if word.len() < 2 || !word.starts_with('-') {
            rest.push(word);
            rest.extend(words.by_ref());
            break;
        }
        for (at, letter) in word[1..].char_indices() {
            if letter == 'i' {
                invocation.interactive = true;
                continue;
            }
            if !matches!(letter, 'e' | 'l' | 's') {
                return Err(Problem(format!("{program}: illegal option -- {letter}")));
            }
            // The value is the rest of this word, or else the next word.
            let attached = &word[1 + at + letter.len_utf8()..];
            let value = if attached.is_empty() {
                words.next().ok_or_else(|| {
                    Problem(format!(
                        "{program}: option requires an argument -- {letter}"
                    ))
                })?
            } else {
                attached.to_owned()
            };
            match letter {
                'e' => lines.get_or_insert_with(Vec::new).push(value),
                'l' => invocation.language = Some(value),
                _ => {
                    for flag in value.chars() {
                        match flag {
                            'e' => invocation.errors_to_stdout = false,
                            'o' => invocation.errors_to_stdout = true,
                            'h' => invocation.source_form = false,
                            's' => invocation.source_form = true,
                            other => {
                                return Err(Problem(format!(
                                    "osascript: unrecognized flag '{other}' for -s option."
                                )));
                            }
                        }
                    }
                }
            }
            break;
        }
    }
    let mut rest = rest.into_iter();
    invocation.source = match lines {
        Some(lines) => Source::Lines(lines.join("\n")),
        None => match rest.next() {
            Some(file) if file != "-" => Source::File(PathBuf::from(file)),
            _ => Source::Stdin,
        },
    };
    invocation.arguments = rest.collect();
    Ok(invocation)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(words: &[&str]) -> Result<Invocation, Problem> {
        parse("osascript", words.iter().map(OsString::from))
    }

    #[test]
    fn lines_join_and_every_word_after_them_is_an_argument() {
        let invocation = read(&["-e", "on run argv", "-e", "end run", "a", "-e", "b"]).unwrap();
        assert_eq!(
            invocation.source,
            Source::Lines("on run argv\nend run".to_owned())
        );
        assert_eq!(invocation.arguments, ["a", "-e", "b"]);
    }

    #[test]
    fn without_lines_the_first_word_is_the_file() {
        let invocation = read(&["script.applescript", "one", "two"]).unwrap();
        assert_eq!(invocation.source, Source::File("script.applescript".into()));
        assert_eq!(invocation.arguments, ["one", "two"]);
        assert_eq!(read(&[]).unwrap().source, Source::Stdin);
        let dash = read(&["-", "x"]).unwrap();
        assert_eq!(
            (dash.source, dash.arguments),
            (Source::Stdin, vec!["x".to_owned()])
        );
    }

    #[test]
    fn options_read_like_getopt() {
        let invocation = read(&["-lJavaScript", "-ss", "-so", "-e1+1"]).unwrap();
        assert_eq!(invocation.language.as_deref(), Some("JavaScript"));
        assert!(invocation.source_form && invocation.errors_to_stdout);
        assert_eq!(invocation.source, Source::Lines("1+1".to_owned()));
        let later = read(&["-s", "s", "-s", "he", "-e", "x"]).unwrap();
        assert!(
            !later.source_form && !later.errors_to_stdout,
            "later flags win"
        );
        assert!(read(&["-ie", "x"]).unwrap().interactive);
        let ended = read(&["--", "-e"]).unwrap();
        assert_eq!(ended.source, Source::File("-e".into()));
    }

    #[test]
    fn what_osascript_refuses_it_refuses_in_its_words() {
        assert_eq!(
            read(&["-x"]).unwrap_err().0,
            "osascript: illegal option -- x"
        );
        assert_eq!(
            read(&["-e"]).unwrap_err().0,
            "osascript: option requires an argument -- e"
        );
        assert_eq!(
            read(&["-s", "z", "-e", "1"]).unwrap_err().0,
            "osascript: unrecognized flag 'z' for -s option."
        );
    }
}

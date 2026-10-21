//! Finding words in a team's earlier work (ADR 0081): every request, answer, note and line of the
//! agents' talk, split into passages and searched by their words.
//!
//! The words are matched on a folded copy of each passage: lower case, accents taken off, and `đ`
//! read as `d`, so "duong" finds "Đường". `SQLite`'s own folding leaves `đ` alone, so the copy is
//! folded here, one character for one character, and the app folds the same way
//! (`ui/src/lib/chat/findWords.ts`) to light the words where they are shown.
//!
//! What to index is kept in `work_index_queue`, filled by triggers on `runs` and `chat_messages`
//! (`migrations/20261021120000_work_passages.sql`), so no way of writing a run or a message can
//! be missed. [`WorkIndex::drain`] empties it: in the background after anything is written, at
//! start for what an older version left, and before every search, so a search never misses what
//! was already said.

use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sqlx::Row as _;
use tokio::sync::Notify;
use unicode_normalization::char::decompose_canonical;

use crate::chat::{ChatMessage, Route};
use crate::db::Db;

/// The most of one message a passage holds. A longer message is split at its paragraphs, so a
/// match points at the paragraph that holds it rather than at a whole brief.
pub(crate) const PASSAGE_CHARS: usize = 1_200;
/// Pieces of work the queue gives at a time, each written in a transaction of its own.
const DRAIN_BATCH: i64 = 20;
/// The most passages one search reads before grouping them by piece of work.
const SEARCH_ROWS: i64 = 200;
/// A word this long, or the last word while it is still being typed, also finds longer words that
/// start with it: "clip" finds "clipping". A shorter one must be the whole word, or "da" would find
/// every word that starts with it.
const PREFIX_CHARS: usize = 4;
/// The most words a search uses.
const MAX_TERMS: usize = 12;
/// How much of a piece's first words name it in the results.
const TITLE_CHARS: usize = 140;

/// Wakes the background indexer when a run or a chat message was written.
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Say that something may need indexing. Cheap, and safe to call from anywhere.
pub(crate) fn wake() {
    WAKE.notify_one();
}

// ---------------------------------------------------------------------------------------------
// Folding and words
// ---------------------------------------------------------------------------------------------

/// One character as the search reads it: lower case, without its accent, `đ` as `d`.
///
/// Always exactly one character for one, so a position in the folded text is the same position
/// in the original.
#[must_use]
pub(crate) fn fold_char(c: char) -> char {
    if matches!(c, 'đ' | 'Đ') {
        return 'd';
    }
    let mut base = None;
    decompose_canonical(c, |part| {
        if base.is_none() {
            base = Some(part);
        }
    });
    let base = base.unwrap_or(c);
    base.to_lowercase().next().unwrap_or(base)
}

/// `text` as the search reads it, character for character.
#[must_use]
pub(crate) fn fold(text: &str) -> String {
    text.chars().map(fold_char).collect()
}

/// The words of folded text: runs of letters and digits.
fn words(folded: &str) -> impl Iterator<Item = &str> {
    folded
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
}

/// One word of a search and what it finds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Term {
    /// Folded. A word of a message matches when it equals this, or, with `prefix`, starts with it.
    pub(crate) text: String,
    pub(crate) prefix: bool,
}

impl Term {
    /// Whether a folded word of a message is one this term finds.
    pub(crate) fn finds(&self, word: &str) -> bool {
        if self.prefix {
            word.starts_with(self.text.as_str())
        } else {
            word == self.text
        }
    }

    /// The FTS5 string for it, quoted so nothing typed is read as FTS5 syntax.
    fn fts(&self) -> String {
        if self.prefix {
            format!("\"{}\"*", self.text)
        } else {
            format!("\"{}\"", self.text)
        }
    }
}

/// An English word's stem, for words that end the way English plurals and verbs do: "batteries"
/// finds "battery", "clipping" finds "clip". `None` when nothing comes off. Vietnamese syllables
/// never end in these letters, so they pass through whole.
fn stem(word: &str) -> Option<String> {
    if !word.is_ascii() {
        return None;
    }
    let cut = |suffix: &str, keep: usize| {
        word.strip_suffix(suffix)
            .filter(|rest| rest.len() >= keep)
            .map(str::to_owned)
    };
    if let Some(rest) = cut("ies", 3) {
        return Some(rest);
    }
    for suffix in ["ing", "ed"] {
        if let Some(mut rest) = cut(suffix, 3) {
            // "clipping" → "clipp" → "clip"; "falling" keeps its double l, as "fall" does.
            let bytes = rest.as_bytes();
            let n = bytes.len();
            if n >= 2 && bytes[n - 1] == bytes[n - 2] && !b"aeioulsz".contains(&bytes[n - 1]) {
                rest.pop();
            }
            return Some(rest);
        }
    }
    if word.ends_with("sses")
        || word.ends_with("xes")
        || word.ends_with("ches")
        || word.ends_with("shes")
    {
        return cut("es", 3);
    }
    if word.ends_with('s')
        && !word.ends_with("ss")
        && !word.ends_with("us")
        && !word.ends_with("is")
    {
        return cut("s", 3);
    }
    None
}

/// The words a search is made of, as typed in `query`.
///
/// Common English words ("the", "what") are left out unless nothing else is left. The last word
/// finds longer words while it may still be being typed, that is unless the query ends in a space.
#[must_use]
pub(crate) fn terms(query: &str) -> Vec<Term> {
    let folded = fold(query);
    let typed: Vec<&str> = words(&folded).collect();
    let still_typing = !query.ends_with(char::is_whitespace);
    let wanted: Vec<&str> = {
        let kept: Vec<&str> = typed
            .iter()
            .copied()
            .filter(|word| !crate::memory::STOP_WORDS.contains(word))
            .collect();
        if kept.is_empty() { typed.clone() } else { kept }
    };
    let last = typed.last().copied();
    let mut terms: Vec<Term> = Vec::new();
    for word in wanted {
        let typing = still_typing && Some(word) == last;
        let term = match stem(word) {
            Some(stemmed) => Term {
                text: stemmed,
                prefix: true,
            },
            None => Term {
                text: word.to_owned(),
                prefix: typing || word.chars().count() >= PREFIX_CHARS,
            },
        };
        if !terms.contains(&term) {
            terms.push(term);
        }
        if terms.len() == MAX_TERMS {
            break;
        }
    }
    terms
}

/// The first line of `text`, cut at a word to at most `chars` characters.
fn first_words(text: &str, chars: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if line.chars().count() <= chars {
        return line.to_owned();
    }
    let cut: String = line.chars().take(chars).collect();
    let cut = cut.rfind(' ').map_or(cut.as_str(), |at| &cut[..at]);
    format!("{}…", cut.trim_end())
}

/// Whether `text` holds a word `term` finds.
fn holds(folded: &str, term: &Term) -> bool {
    words(folded).any(|word| term.finds(word))
}

// ---------------------------------------------------------------------------------------------
// Passages
// ---------------------------------------------------------------------------------------------

/// `text` cut into passages of at most [`PASSAGE_CHARS`], at paragraph breaks where it can be,
/// then at line breaks, then at sentence ends, then anywhere.
#[must_use]
pub(crate) fn passages(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut rest = text;
    while rest.chars().count() > PASSAGE_CHARS {
        let window_end = rest
            .char_indices()
            .nth(PASSAGE_CHARS)
            .map_or(rest.len(), |(at, _)| at);
        let window = &rest[..window_end];
        let floor = window.len() / 3;
        let cut = ["\n\n", "\n", ". ", "? ", "! ", " "]
            .iter()
            .find_map(|breaker| {
                window
                    .rfind(breaker)
                    .filter(|&at| at > floor)
                    .map(|at| at + breaker.len())
            })
            .unwrap_or(window_end);
        let (part, tail) = rest.split_at(cut);
        let part = part.trim();
        if !part.is_empty() {
            out.push(part.to_owned());
        }
        rest = tail.trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_owned());
    }
    out
}

/// Something said in a piece of work, as the chat names it (the `target` a reaction uses):
/// `request`, `answer`, `note:<id>`, `talk:<line>`, `mine:<line>` or `reply:<agent>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Said {
    pub(crate) target: String,
    /// The agent who said it; `None` for the person.
    pub(crate) who: Option<String>,
    pub(crate) at: String,
    pub(crate) text: String,
}

/// A piece of the chat that is searched as one: a piece of work (a run) or a team note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Piece {
    /// The run id, or the team note's message id.
    pub(crate) id: String,
    pub(crate) kind: PieceKind,
    pub(crate) team_key: String,
    pub(crate) team_path: String,
    pub(crate) at: String,
    pub(crate) said: Vec<Said>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PieceKind {
    Work,
    Note,
}

impl PieceKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Note => "note",
        }
    }

    fn parse(value: &str) -> Self {
        if value == "note" {
            Self::Note
        } else {
            Self::Work
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------

/// The passages of every team's earlier work, on the run archive's database.
#[derive(Clone)]
pub(crate) struct WorkIndex {
    db: Db,
}

impl WorkIndex {
    pub(crate) fn new(db: Db) -> Self {
        Self { db }
    }

    /// Index everything waiting in the queue. Returns how many pieces were written.
    ///
    /// Each piece is read first and then written in one short transaction, so the single writing
    /// connection is never held while a piece is read. A piece written again while it was being
    /// read stays queued for the next round.
    ///
    /// # Errors
    ///
    /// Returns an error when the database fails.
    pub(crate) async fn drain(&self) -> Result<usize, sqlx::Error> {
        let mut written = 0;
        loop {
            let rows = sqlx::query(
                "SELECT piece, kind, version FROM work_index_queue ORDER BY rowid LIMIT $1",
            )
            .bind(DRAIN_BATCH)
            .fetch_all(self.db.reader())
            .await?;
            if rows.is_empty() {
                return Ok(written);
            }
            // Talk is archived in batches: what a run said last is written before it is read.
            self.db.flush_events().await;
            for row in &rows {
                let id: String = row.try_get("piece")?;
                let kind = PieceKind::parse(&row.try_get::<String, _>("kind")?);
                let version: i64 = row.try_get("version")?;
                let piece = match kind {
                    PieceKind::Work => self.read_work(&id).await?,
                    PieceKind::Note => self.read_note(&id).await?,
                };
                self.write(&id, piece.as_ref(), version).await?;
                written += 1;
            }
        }
    }

    /// Replace one piece's passages with `piece`'s, or remove them when it is gone, and take it
    /// off the queue unless it was queued again meanwhile.
    async fn write(
        &self,
        id: &str,
        piece: Option<&Piece>,
        version: i64,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.db.writer().begin().await?;
        sqlx::query(
            "DELETE FROM work_passages_search
             WHERE rowid IN (SELECT id FROM work_passages WHERE piece = $1)",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM work_passages WHERE piece = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if let Some(piece) = piece {
            for said in &piece.said {
                for (part, text) in passages(&said.text).into_iter().enumerate() {
                    let row = sqlx::query(
                        "INSERT INTO work_passages
                         (piece, kind, team_key, team_path, piece_at, target, who, said_at, part, text)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                         RETURNING id",
                    )
                    .bind(&piece.id)
                    .bind(piece.kind.as_str())
                    .bind(&piece.team_key)
                    .bind(&piece.team_path)
                    .bind(&piece.at)
                    .bind(&said.target)
                    .bind(&said.who)
                    .bind(&said.at)
                    .bind(i64::try_from(part).unwrap_or(i64::MAX))
                    .bind(&text)
                    .fetch_one(&mut *tx)
                    .await?;
                    let passage: i64 = row.try_get("id")?;
                    sqlx::query("INSERT INTO work_passages_search (rowid, folded) VALUES ($1, $2)")
                        .bind(passage)
                        .bind(fold(&text))
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
        sqlx::query("DELETE FROM work_index_queue WHERE piece = $1 AND version = $2")
            .bind(id)
            .bind(version)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }

    /// A run as its chat shows it: the request, the answer, the notes sent into it, and what the
    /// agents said to each other.
    async fn read_work(&self, run_id: &str) -> Result<Option<Piece>, sqlx::Error> {
        let Some(row) = sqlx::query("SELECT * FROM runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_optional(self.db.reader())
            .await?
        else {
            return Ok(None);
        };
        let team_key: Option<String> = row.try_get("team_key")?;
        let record = crate::runs::decode_run(&row)?.record;
        let team_key = team_key.unwrap_or_else(|| format!("path:{}", record.team_path));
        let messages = sqlx::query(
            "SELECT * FROM chat_messages WHERE run_id = $1 ORDER BY created_at ASC, id ASC",
        )
        .bind(run_id)
        .fetch_all(self.db.reader())
        .await?
        .iter()
        .map(crate::chat::decode_message)
        .collect::<Result<Vec<ChatMessage>, _>>()?;
        let mut said = Vec::new();
        let request = messages
            .iter()
            .find(|message| matches!(message.route, Route::Team | Route::Agent));
        // Continue with the team is a press, not words: the chat shows a notice there, and the run's
        // prompt is the earlier work's, which belongs to that work.
        let continued = request.is_none()
            && record.follows_run_id.is_some()
            && record.start_at.is_some()
            && record.only_agent.is_none();
        if !continued {
            said.push(Said {
                target: "request".to_owned(),
                who: None,
                at: record.created_at.clone(),
                text: request.map_or_else(|| record.prompt.clone(), |message| message.text.clone()),
            });
        }
        for note in messages
            .iter()
            .filter(|message| matches!(message.route, Route::Note | Route::TeamNote))
        {
            said.push(Said {
                target: format!("note:{}", note.id),
                who: None,
                at: note.created_at.clone(),
                text: note.text.clone(),
            });
        }
        said.extend(self.talk(run_id).await?);
        if let Some(reply) = record
            .reply
            .as_deref()
            .filter(|reply| !reply.trim().is_empty())
        {
            said.push(Said {
                target: "answer".to_owned(),
                who: Some(record.responder.clone()),
                at: record
                    .finished_at
                    .clone()
                    .unwrap_or_else(|| record.created_at.clone()),
                text: reply.to_owned(),
            });
        }
        Ok(Some(Piece {
            id: record.run_id,
            kind: PieceKind::Work,
            team_key,
            team_path: record.team_path,
            at: record.created_at,
            said,
        }))
    }

    /// A team note and what the agents answered it. `None` once it started work: from then on it
    /// is that work's request.
    async fn read_note(&self, id: &str) -> Result<Option<Piece>, sqlx::Error> {
        let Some(row) = sqlx::query("SELECT * FROM chat_messages WHERE id = $1")
            .bind(id)
            .fetch_optional(self.db.reader())
            .await?
        else {
            return Ok(None);
        };
        let note = crate::chat::decode_message(&row)?;
        if note.route != Route::TeamNote || note.run_id.is_some() {
            return Ok(None);
        }
        let mut said = vec![Said {
            target: format!("note:{}", note.id),
            who: None,
            at: note.created_at.clone(),
            text: note.text.clone(),
        }];
        for answer in note.answers.iter().flat_map(|answers| answers.said.iter()) {
            said.push(Said {
                target: format!("reply:{}", answer.from),
                who: Some(answer.from.clone()),
                at: answer.at.clone(),
                text: answer.text.clone(),
            });
        }
        Ok(Some(Piece {
            id: note.id,
            kind: PieceKind::Note,
            team_key: note.team_key,
            team_path: note.team_path,
            at: note.created_at,
            said,
        }))
    }

    /// What the agents said to each other in a run, from its archive.
    async fn talk(&self, run_id: &str) -> Result<Vec<Said>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, agent_id, ts, kind, payload FROM run_events
             WHERE session_id = $1 AND kind IN ('session_meta', 'tool_call', 'tool_update')
             ORDER BY seq ASC",
        )
        .bind(run_id)
        .fetch_all(self.db.reader())
        .await?;
        let mut events = Vec::with_capacity(rows.len());
        for row in &rows {
            let payload: String = row.try_get("payload")?;
            let Ok(payload) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            events.push(TalkEvent {
                id: row.try_get("id")?,
                agent: row.try_get("agent_id")?,
                at: row.try_get("ts")?,
                kind: row.try_get("kind")?,
                payload,
            });
        }
        Ok(talk(&events))
    }

    /// Passages of `team`'s earlier work that hold `query`'s words, grouped by piece: first the
    /// pieces that hold the most of the words anywhere in them (a request may hold one word and
    /// the answer the other), then by how well their best passage matches.
    ///
    /// # Errors
    ///
    /// Returns an error when the database fails.
    pub(crate) async fn find(
        &self,
        team_key: &str,
        team_path: &str,
        query: &str,
        limit: usize,
    ) -> Result<Found, sqlx::Error> {
        let terms = terms(query);
        if terms.is_empty() {
            return Ok(Found {
                terms,
                every_word: true,
                pieces: Vec::new(),
            });
        }
        if let Err(error) = self.drain().await {
            eprintln!("warning: could not bring the chat's search up to date: {error}");
        }
        let any = terms.iter().map(Term::fts).collect::<Vec<_>>().join(" OR ");
        let rows = self.matching(team_key, team_path, &any).await?;
        let mut pieces = group(rows, &terms, limit);
        let every_word = pieces.iter().all(|piece| piece.every_word);
        self.title(&mut pieces).await?;
        Ok(Found {
            terms,
            every_word,
            pieces,
        })
    }

    /// What each piece began with: the request of a piece of work, or the team note.
    async fn title(&self, pieces: &mut [FoundPiece]) -> Result<(), sqlx::Error> {
        if pieces.is_empty() {
            return Ok(());
        }
        let ids = pieces
            .iter()
            .map(|piece| piece.id.clone())
            .collect::<Vec<_>>();
        let rows = sqlx::query(
            "SELECT piece, text FROM work_passages
             WHERE piece IN (SELECT value FROM json_each($1)) AND part = 0
               AND (target = 'request' OR (kind = 'note' AND target = 'note:' || piece))",
        )
        .bind(crate::db::json_list(&ids))
        .fetch_all(self.db.reader())
        .await?;
        for row in &rows {
            let id: String = row.try_get("piece")?;
            let text: String = row.try_get("text")?;
            if let Some(piece) = pieces.iter_mut().find(|piece| piece.id == id) {
                piece.title = first_words(&text, TITLE_CHARS);
            }
        }
        Ok(())
    }

    async fn matching(
        &self,
        team_key: &str,
        team_path: &str,
        expression: &str,
    ) -> Result<Vec<Passage>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT p.id, p.piece, p.kind, p.piece_at, p.target, p.who, p.said_at, p.part, p.text
             FROM work_passages_search AS s
             JOIN work_passages AS p ON p.id = s.rowid
             WHERE work_passages_search MATCH $1
               AND (p.team_key = $2 OR p.team_key = 'path:' || $3 OR p.team_path = $3)
             ORDER BY bm25(work_passages_search), p.said_at DESC
             LIMIT $4",
        )
        .bind(expression)
        .bind(team_key)
        .bind(team_path)
        .bind(SEARCH_ROWS)
        .fetch_all(self.db.reader())
        .await?;
        rows.iter()
            .map(|row| {
                Ok(Passage {
                    id: row.try_get("id")?,
                    piece: row.try_get("piece")?,
                    kind: PieceKind::parse(&row.try_get::<String, _>("kind")?),
                    piece_at: row.try_get("piece_at")?,
                    target: row.try_get("target")?,
                    who: row.try_get("who")?,
                    at: row.try_get("said_at")?,
                    part: row.try_get("part")?,
                    text: row.try_get("text")?,
                })
            })
            .collect()
    }
}

/// One archived event of a run, as [`talk`] reads it.
#[derive(Debug, Clone)]
pub(crate) struct TalkEvent {
    pub(crate) id: String,
    pub(crate) agent: String,
    pub(crate) at: String,
    pub(crate) kind: String,
    pub(crate) payload: Value,
}

/// The Team Bus tools that carry a message from one agent to another.
const BUS_TOOLS: &[&str] = &["ask", "dispatch", "handoff", "escalate", "start_helper"];

/// The lines of the agents' talk, each under the id the chat shows it by (`ui/src/lib/watch/
/// messages.ts`), so a match opens that very line: `handover:<event>`, `direction:<event>`,
/// `question:<event>`, `check:<event>`, `check-back:<event>`, and `<agent>:<call>` for a Team Bus
/// message and its reply. A check that found everything met has no words worth finding.
fn talk(events: &[TalkEvent]) -> Vec<Said> {
    let mut reader = Talk::default();
    for event in events {
        match (event.kind.as_str(), event.payload["phase"].as_str()) {
            ("session_meta", Some("prompt_sections")) => reader.prompt(event),
            ("session_meta", Some("awaiting_operator")) => reader.question(event),
            ("session_meta", Some("check_result")) => reader.check(event),
            ("session_meta", Some("check_sent_back")) => reader.sent_back(event),
            ("session_meta", Some("delegated_result")) => reader.helped(event),
            ("tool_call", _) => reader.bus_call(event),
            ("tool_update", _) => reader.bus_reply(event),
            _ => {}
        }
    }
    reader.said
}

/// Words of a recorded field, trimmed; `None` for anything empty or not text.
fn words_of(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The talk read so far, and what a later event needs to find the line it belongs to.
#[derive(Default)]
struct Talk {
    said: Vec<Said>,
    /// The Team Bus calls by `<agent>:<call>`: which tool, and to whom.
    calls: BTreeMap<String, (String, Option<String>)>,
    /// Helpers started and not yet heard back from: the call's line id, and the helper.
    helpers: Vec<(String, Option<String>)>,
    /// The last check line each check step wrote about each agent, by position in `said`.
    checks: BTreeMap<(String, String), usize>,
}

impl Talk {
    fn line(&mut self, event: &TalkEvent, target: &str, who: Option<String>, text: String) {
        self.said.push(Said {
            target: format!("talk:{target}"),
            who,
            at: event.at.clone(),
            text,
        });
    }

    /// What a stage was handed, and the direction you gave before it.
    fn prompt(&mut self, event: &TalkEvent) {
        let p = &event.payload;
        let section = |kind: &str| {
            p["sections"].as_array().and_then(|sections| {
                sections
                    .iter()
                    .find(|section| section["kind"] == kind)
                    .and_then(|section| words_of(&section["text"]))
            })
        };
        if let Some(direction) = section("direction") {
            self.line(event, &format!("direction:{}", event.id), None, direction);
        }
        if let Some(handover) = section("stage_results") {
            let from = p["stageResultsFrom"]
                .as_array()
                .and_then(|from| from.first())
                .and_then(Value::as_str)
                .map_or_else(|| event.agent.clone(), str::to_owned);
            self.line(
                event,
                &format!("handover:{}", event.id),
                Some(from),
                handover,
            );
        }
    }

    /// An agent's question for you.
    fn question(&mut self, event: &TalkEvent) {
        let p = &event.payload;
        if p["kind"] != "question" {
            return;
        }
        if let Some(question) = words_of(&p["question"]) {
            let text = match words_of(&p["context"]) {
                Some(context) => format!("{question}\n\n{context}"),
                None => question,
            };
            self.line(
                event,
                &format!("question:{}", event.id),
                Some(event.agent.clone()),
                text,
            );
        }
    }

    /// A check round's verdict: the items it did not find met.
    fn check(&mut self, event: &TalkEvent) {
        let p = &event.payload;
        let open = check_items(&p["items"]);
        if let (Some(checked), false) = (words_of(&p["checked"]), open.is_empty()) {
            self.checks
                .insert((event.agent.clone(), checked), self.said.len());
            self.line(
                event,
                &format!("check:{}", event.id),
                Some(event.agent.clone()),
                open,
            );
        }
    }

    /// A check round sent back: your direction as a line of its own, or the check step's account
    /// of the problems added to the round it sent back.
    fn sent_back(&mut self, event: &TalkEvent) {
        let p = &event.payload;
        let Some(to) = words_of(&p["to"]) else { return };
        if let Some(direction) = words_of(&p["direction"]) {
            self.line(event, &format!("check-back:{}", event.id), None, direction);
        } else if let (Some(problems), Some(&at)) = (
            words_of(&p["problems"]),
            self.checks.get(&(event.agent.clone(), to)),
        ) {
            let check = &mut self.said[at];
            check.text = format!("{problems}\n\n{}", check.text);
        }
    }

    /// What a helper sent back, as the reply to the brief that started it.
    fn helped(&mut self, event: &TalkEvent) {
        let p = &event.payload;
        if p["mode"] != "helper" {
            return;
        }
        let reply = words_of(&p["reply"]).or_else(|| words_of(&p["error"]));
        let started = self
            .helpers
            .iter()
            .rposition(|(_, to)| to.as_deref() == Some(event.agent.as_str()));
        if let (Some(reply), Some(at)) = (reply, started) {
            let (id, _) = self.helpers.remove(at);
            self.line(event, &id, Some(event.agent.clone()), reply);
        }
    }

    /// A message one agent sent another through the Team Bus. Only the bus's own record of the
    /// call counts; an app's echo of it does not.
    fn bus_call(&mut self, event: &TalkEvent) {
        let p = &event.payload;
        let Some(name) = p["name"].as_str().filter(|name| BUS_TOOLS.contains(name)) else {
            return;
        };
        let (Some(call), true) = (
            p["callId"].as_str(),
            p["title"].as_str() == Some(&format!("Team Bus: {name}")),
        ) else {
            return;
        };
        let input = &p["rawInput"];
        let text = match name {
            "ask" => words_of(&input["question"]),
            "escalate" => words_of(&input["reason"]),
            "start_helper" => words_of(&input["task"]).map(|task| {
                words_of(&input["send_back"])
                    .map_or(task.clone(), |back| format!("{task}\n\nSend back: {back}"))
            }),
            _ => words_of(&input["task"]),
        };
        let id = format!("{}:{call}", event.agent);
        let to = words_of(&input["agent"]);
        if name == "start_helper" {
            self.helpers.push((id.clone(), to.clone()));
        }
        self.calls.insert(id.clone(), (name.to_owned(), to));
        if let Some(text) = text {
            self.line(event, &id, Some(event.agent.clone()), text);
        }
    }

    /// The reply to an `ask`.
    fn bus_reply(&mut self, event: &TalkEvent) {
        let p = &event.payload;
        let Some(call) = p["callId"].as_str() else {
            return;
        };
        let id = format!("{}:{call}", event.agent);
        let Some((name, to)) = self.calls.get(&id) else {
            return;
        };
        if name != "ask" {
            return;
        }
        if let Some(reply) = words_of(&p["rawOutput"]["reply"]) {
            let who = words_of(&p["rawOutput"]["agent"]).or_else(|| to.clone());
            self.line(event, &id, who, reply);
        }
    }
}

/// A check round's items that were not met or not sure, each with its evidence, as the chat lists
/// them.
fn check_items(items: &Value) -> String {
    items
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["verdict"] != "met")
        .filter_map(|item| {
            let what = item["item"].as_str()?.trim();
            let evidence = item["evidence"].as_str().map(str::trim).unwrap_or_default();
            Some(if evidence.is_empty() {
                format!("- {what}")
            } else {
                format!("- {what} — {evidence}")
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One stored passage that matched.
#[derive(Debug, Clone)]
struct Passage {
    /// Written in the order things were said in the piece.
    id: i64,
    piece: String,
    kind: PieceKind,
    piece_at: String,
    target: String,
    who: Option<String>,
    at: String,
    part: i64,
    text: String,
}

/// What a search found.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Found {
    /// How the words were read, so the app lights the same words.
    pub(crate) terms: Vec<Term>,
    /// Whether each piece holds every word, or only some of them.
    pub(crate) every_word: bool,
    pub(crate) pieces: Vec<FoundPiece>,
}

/// A piece of work or a team note that matched, and the passages in it that did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundPiece {
    pub(crate) id: String,
    pub(crate) kind: PieceKind,
    pub(crate) at: String,
    /// What it began with, its first words: the request, or the team note.
    pub(crate) title: String,
    /// The agents whose words matched, in the order they first did.
    pub(crate) agents: Vec<String>,
    /// Whether it holds every word of the search, in one message or across several.
    pub(crate) every_word: bool,
    pub(crate) passages: Vec<FoundPassage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundPassage {
    #[serde(skip)]
    order: i64,
    pub(crate) target: String,
    pub(crate) who: Option<String>,
    pub(crate) at: String,
    pub(crate) part: i64,
    pub(crate) text: String,
}

/// The matches grouped by piece: the pieces holding the most of the words first, then in the
/// order of each piece's best passage; at most `limit` pieces, each with its passages in the order
/// they were said (the order they were written in).
fn group(rows: Vec<Passage>, terms: &[Term], limit: usize) -> Vec<FoundPiece> {
    let mut order: Vec<String> = Vec::new();
    let mut by_piece: BTreeMap<String, FoundPiece> = BTreeMap::new();
    let mut held: BTreeMap<String, Vec<bool>> = BTreeMap::new();
    for row in rows {
        // FTS5 matches the words anywhere in a passage; keep only those that really hold one, as
        // the app will light it.
        let folded = fold(&row.text);
        let holding = terms
            .iter()
            .map(|term| holds(&folded, term))
            .collect::<Vec<_>>();
        if !holding.iter().any(|held| *held) {
            continue;
        }
        let covered = held
            .entry(row.piece.clone())
            .or_insert_with(|| vec![false; terms.len()]);
        for (covered, holds) in covered.iter_mut().zip(&holding) {
            *covered |= *holds;
        }
        let piece = by_piece.entry(row.piece.clone()).or_insert_with(|| {
            order.push(row.piece.clone());
            FoundPiece {
                id: row.piece.clone(),
                kind: row.kind,
                at: row.piece_at.clone(),
                title: String::new(),
                agents: Vec::new(),
                every_word: false,
                passages: Vec::new(),
            }
        });
        if let Some(who) = &row.who
            && !piece.agents.contains(who)
        {
            piece.agents.push(who.clone());
        }
        piece.passages.push(FoundPassage {
            order: row.id,
            target: row.target,
            who: row.who,
            at: row.at,
            part: row.part,
            text: row.text,
        });
    }
    let words_held = |id: &String| {
        held.get(id)
            .map_or(0, |held| held.iter().filter(|held| **held).count())
    };
    // A stable sort keeps the best-passage order among pieces holding as many words.
    order.sort_by_key(|id| std::cmp::Reverse(words_held(id)));
    order
        .into_iter()
        .take(limit)
        .filter_map(|id| {
            let every_word = words_held(&id) == terms.len();
            by_piece.remove(&id).map(|mut piece| {
                piece.every_word = every_word;
                piece
            })
        })
        .map(|mut piece| {
            piece.passages.sort_by_key(|passage| passage.order);
            piece
        })
        .collect()
}

/// Keep the index up to date in the background for as long as the daemon runs: once at start,
/// then whenever something is written, and every minute in case a wake was missed.
pub(crate) fn spawn_indexer(index: WorkIndex) {
    tokio::spawn(async move {
        loop {
            match index.drain().await {
                Ok(_) => {}
                Err(error) => eprintln!("warning: could not index the team chats: {error}"),
            }
            let _ = tokio::time::timeout(Duration::from_secs(60), WAKE.notified()).await;
            // Let a burst of writes (a run's last events, its record, its answer) settle first.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn term(text: &str, prefix: bool) -> Term {
        Term {
            text: text.to_owned(),
            prefix,
        }
    }

    /// The same cases as `ui/src/lib/chat/findWords.test.ts`: the app lights what the daemon finds.
    #[test]
    fn folding_takes_off_case_and_accents_and_reads_d_with_a_stroke_as_d() {
        for (text, folded) in [
            ("Đường phố Đà Nẵng", "duong pho da nang"),
            ("Tái chế ắc quy", "tai che ac quy"),
            ("Label CLIPPING", "label clipping"),
            ("naïve café", "naive cafe"),
            ("emoji 🙂 stays", "emoji 🙂 stays"),
        ] {
            assert_eq!(fold(text), folded, "{text}");
            assert_eq!(
                fold(text).chars().count(),
                text.chars().count(),
                "one for one: {text}"
            );
        }
    }

    #[test]
    fn words_are_read_in_any_form_and_short_ones_whole() {
        assert_eq!(
            terms("label clip"),
            [term("label", true), term("clip", true)]
        );
        assert_eq!(
            terms("clipping labels "),
            [term("clip", true), term("label", true)]
        );
        assert_eq!(terms("batteries"), [term("batter", true)]);
        assert_eq!(terms("checked"), [term("check", true)]);
        assert_eq!(terms("falling"), [term("fall", true)]);
        assert_eq!(terms("boxes"), [term("box", true)]);
        assert_eq!(terms("class"), [term("class", true)]);
        // Vietnamese syllables keep their letters, and a short word is the whole word unless it is
        // still being typed.
        assert_eq!(terms("Đà Nẵng"), [term("da", false), term("nang", true)]);
        assert_eq!(terms("da"), [term("da", true)]);
        assert_eq!(terms("da "), [term("da", false)]);
        // Common English words go, unless nothing else is left; repeats count once.
        assert_eq!(terms("what about the plot"), [term("plot", true)]);
        assert_eq!(terms("the"), [term("the", true)]);
        assert_eq!(terms("plot plots"), [term("plot", true)]);
        assert!(terms("% ? -").is_empty());
    }

    #[test]
    fn a_term_finds_the_words_it_should_and_no_others() {
        let clip = &terms("clip")[0];
        assert!(clip.finds("clipping") && clip.finds("clip") && !clip.finds("eclipse"));
        let da = &terms("da ")[0];
        assert!(da.finds("da") && !da.finds("dan") && !da.finds("dang"));
        assert!(holds(&fold("Đà Nẵng"), &terms("nang")[0]));
    }

    #[test]
    fn typed_syntax_is_quoted_never_run() {
        for query in ["\"NEAR(a b)", "a* OR -b", "col:val ^x"] {
            for term in terms(query) {
                assert!(
                    term.text.chars().all(char::is_alphanumeric),
                    "{query}: {term:?}"
                );
                let fts = term.fts();
                assert!(
                    fts.starts_with('"') && fts.trim_end_matches('*').ends_with('"'),
                    "{fts}"
                );
            }
        }
    }

    #[test]
    fn a_long_message_is_cut_at_its_paragraphs_and_nothing_is_lost() {
        let paragraph = |n: usize| format!("Paragraph {n}. {}", "word ".repeat(90).trim_end());
        let text = (0..5).map(paragraph).collect::<Vec<_>>().join("\n\n");
        let parts = passages(&text);
        assert!(parts.len() > 1, "{}", parts.len());
        for part in &parts {
            assert!(
                part.chars().count() <= PASSAGE_CHARS,
                "{}",
                part.chars().count()
            );
            assert!(
                part.starts_with("Paragraph"),
                "cut at a paragraph: {part:.40}"
            );
        }
        let words = |text: &str| {
            text.split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        assert_eq!(words(&parts.join(" ")), words(&text));
        // One unbroken run of letters is still cut, and short text is one passage.
        assert!(
            passages(&"x".repeat(3_000))
                .iter()
                .all(|part| part.chars().count() <= PASSAGE_CHARS)
        );
        assert_eq!(passages("  short  "), ["short"]);
        assert!(passages(" \n ").is_empty());
    }

    fn event(id: &str, agent: &str, kind: &str, payload: Value) -> TalkEvent {
        TalkEvent {
            id: id.to_owned(),
            agent: agent.to_owned(),
            at: format!("2026-10-21T10:00:0{}Z", id.len() % 10),
            kind: kind.to_owned(),
            payload,
        }
    }

    /// A run's archive with every kind of line the talk holds, and an echo that is not one.
    fn talk_events() -> Vec<TalkEvent> {
        vec![
            event(
                "e1",
                "writer",
                "session_meta",
                json!({"phase": "prompt_sections", "stageResultsFrom": ["researcher"], "sections": [
                    {"kind": "role", "text": "You write."},
                    {"kind": "direction", "text": "Keep it short"},
                    {"kind": "stage_results", "text": "Lead-acid batteries are broken by hand"},
                ]}),
            ),
            event(
                "e2",
                "checker",
                "session_meta",
                json!({"phase": "check_result", "checked": "writer", "round": 1, "items": [
                    {"verdict": "met", "item": "Has a title", "evidence": "yes"},
                    {"verdict": "not_met", "item": "Every figure has a source", "evidence": "99% is the EU figure"},
                ]}),
            ),
            event(
                "e3",
                "checker",
                "session_meta",
                json!({"phase": "check_sent_back", "to": "writer", "round": 1, "problems": "The recovery rate is wrong"}),
            ),
            event(
                "e4",
                "checker",
                "session_meta",
                json!({"phase": "check_result", "checked": "writer", "round": 2, "items": [
                    {"verdict": "met", "item": "Every figure has a source", "evidence": "removed"},
                ]}),
            ),
            event(
                "e5",
                "writer",
                "session_meta",
                json!({"phase": "awaiting_operator", "kind": "question", "question": "Which year?", "context": "Two decrees"}),
            ),
            event(
                "e6",
                "writer",
                "tool_call",
                json!({"name": "ask", "title": "Team Bus: ask", "callId": "c1", "rawInput": {"agent": "researcher", "question": "Is Decree 08 current?"}}),
            ),
            event(
                "e7",
                "writer",
                "tool_update",
                json!({"callId": "c1", "status": "completed", "rawOutput": {"agent": "researcher", "reply": "Yes, since 2022"}}),
            ),
            // An app's own echo of a bus call is not a line of its own.
            event(
                "e8",
                "writer",
                "tool_call",
                json!({"name": "ask", "title": "mcp ask", "callId": "c2", "rawInput": {"question": "echo"}}),
            ),
            event(
                "e9",
                "writer",
                "tool_call",
                json!({"name": "start_helper", "title": "Team Bus: start_helper", "callId": "c3", "rawInput": {"agent": "helper-1", "task": "Find the decree", "send_back": "its number"}}),
            ),
            event(
                "e10",
                "helper-1",
                "session_meta",
                json!({"phase": "delegated_result", "mode": "helper", "status": "succeeded", "reply": "Decree 08/2022"}),
            ),
        ]
    }

    /// Each line of the talk is kept under the id the chat shows it by, so a match opens it.
    #[test]
    fn the_talk_is_read_under_the_ids_the_chat_shows_it_by() {
        let events = talk_events();
        let said = talk(&events);
        let lines = said
            .iter()
            .map(|line| {
                (
                    line.target.as_str(),
                    line.who.as_deref(),
                    line.text.as_str(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            lines,
            [
                ("talk:direction:e1", None, "Keep it short"),
                (
                    "talk:handover:e1",
                    Some("researcher"),
                    "Lead-acid batteries are broken by hand"
                ),
                (
                    "talk:check:e2",
                    Some("checker"),
                    "The recovery rate is wrong\n\n- Every figure has a source — 99% is the EU figure"
                ),
                (
                    "talk:question:e5",
                    Some("writer"),
                    "Which year?\n\nTwo decrees"
                ),
                ("talk:writer:c1", Some("writer"), "Is Decree 08 current?"),
                ("talk:writer:c1", Some("researcher"), "Yes, since 2022"),
                (
                    "talk:writer:c3",
                    Some("writer"),
                    "Find the decree\n\nSend back: its number"
                ),
                ("talk:writer:c3", Some("helper-1"), "Decree 08/2022"),
            ]
        );
    }

    async fn passage_count(db: &Db, piece: &str) -> i64 {
        sqlx::query("SELECT COUNT(*) AS n FROM work_passages WHERE piece = $1")
            .bind(piece)
            .fetch_one(db.reader())
            .await
            .unwrap()
            .get("n")
    }

    /// Whatever writes a run or a message, the triggers queue it, and a search brings the index
    /// up to date first. Another team's words are never found.
    #[tokio::test]
    async fn the_index_follows_every_write_and_keeps_to_its_team() {
        let db = Db::temp().await;
        let index = WorkIndex::new(db.clone());
        let insert = |run: &str, team: &str, prompt: &str| {
            sqlx::query(
                "INSERT INTO runs (run_id, session_id, team_path, team_key, prompt, status, mode,
                                   entrypoint, responder, created_at, trigger)
                 VALUES ($1, $1, $2, $3, $4, 'running', 'team', 'writer', 'writer',
                         '2026-10-21T10:00:00Z', 'manual')",
            )
            .bind(run.to_owned())
            .bind(format!("{team}.yaml"))
            .bind(team.to_owned())
            .bind(prompt.to_owned())
            .execute(db.writer())
        };
        insert("run-a", "research", "Research battery recycling in Vietnam")
            .await
            .unwrap();
        insert("run-b", "other", "Battery recycling, for another team")
            .await
            .unwrap();

        let found = index
            .find("research", "research.yaml", "recycling", 10)
            .await
            .unwrap();
        let ids = found
            .pieces
            .iter()
            .map(|piece| piece.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["run-a"], "another team's work stays its own");
        assert_eq!(
            found.pieces[0].title,
            "Research battery recycling in Vietnam"
        );

        // The answer arrives with the run's end, and is found by its own words.
        sqlx::query("UPDATE runs SET status = 'succeeded', reply = $1 WHERE run_id = 'run-a'")
            .bind("Mostly informal: done by hand in Đông Mai.")
            .execute(db.writer())
            .await
            .unwrap();
        let found = index
            .find("research", "research.yaml", "dong", 10)
            .await
            .unwrap();
        assert_eq!(
            found.pieces.len(),
            1,
            "the answer is found once the run ends: {found:?}"
        );
        assert_eq!(found.pieces[0].passages[0].target, "answer");
        assert_eq!(found.pieces[0].passages[0].who.as_deref(), Some("writer"));
        assert_eq!(found.pieces[0].agents, ["writer"]);

        // Some of the words, when all of them find too little.
        let found = index
            .find("research", "research.yaml", "vietnam penguins", 10)
            .await
            .unwrap();
        assert!(!found.every_word && found.pieces.len() == 1, "{found:?}");

        // A run that goes takes its passages with it, and nothing stays queued.
        sqlx::query("DELETE FROM runs WHERE run_id = 'run-a'")
            .execute(db.writer())
            .await
            .unwrap();
        index.drain().await.unwrap();
        assert_eq!(passage_count(&db, "run-a").await, 0);
        let queued: i64 = sqlx::query("SELECT COUNT(*) AS n FROM work_index_queue")
            .fetch_one(db.reader())
            .await
            .unwrap()
            .get("n");
        assert_eq!(queued, 0);
    }

    /// A piece holding one word in its request and the other in its answer holds every word, and
    /// comes before a piece that holds only one, however well that one matches.
    #[tokio::test]
    async fn a_piece_with_every_word_across_its_messages_comes_first() {
        let db = Db::temp().await;
        let index = WorkIndex::new(db.clone());
        for (run, prompt, reply, at) in [
            (
                "both",
                "Research battery recycling",
                "Decree 08 sets the rules",
                "2026-10-21T09:00:00Z",
            ),
            (
                "one",
                "Recycling recycling recycling, again recycling",
                "Nothing on rules",
                "2026-10-21T10:00:00Z",
            ),
        ] {
            sqlx::query(
                "INSERT INTO runs (run_id, session_id, team_path, team_key, prompt, status, mode,
                                   entrypoint, responder, created_at, trigger, reply)
                 VALUES ($1, $1, 'research.yaml', 'research', $2, 'succeeded', 'team', 'writer',
                         'writer', $4, 'manual', $3)",
            )
            .bind(run)
            .bind(prompt)
            .bind(reply)
            .bind(at)
            .execute(db.writer())
            .await
            .unwrap();
        }
        let found = index
            .find("research", "research.yaml", "recycling decree", 10)
            .await
            .unwrap();
        let order = found
            .pieces
            .iter()
            .map(|piece| (piece.id.as_str(), piece.every_word))
            .collect::<Vec<_>>();
        assert_eq!(order, [("both", true), ("one", false)]);
        assert!(!found.every_word);
        let targets = found.pieces[0]
            .passages
            .iter()
            .map(|passage| passage.target.as_str())
            .collect::<Vec<_>>();
        assert_eq!(targets, ["request", "answer"]);
    }

    /// Pieces holding more of the words come first, whatever order the search ranked their
    /// passages in.
    #[test]
    fn a_piece_holding_more_of_the_words_is_put_first() {
        let passage = |id: i64, piece: &str, text: &str| Passage {
            id,
            piece: piece.to_owned(),
            kind: PieceKind::Work,
            piece_at: "2026-10-21T10:00:00Z".to_owned(),
            target: "answer".to_owned(),
            who: None,
            at: "2026-10-21T10:00:00Z".to_owned(),
            part: 0,
            text: text.to_owned(),
        };
        // As the search might rank them: the piece with one word, said twice, first.
        let rows = vec![
            passage(1, "one", "recycling recycling"),
            passage(2, "one", "more recycling"),
            passage(3, "both", "battery recycling"),
            passage(4, "both", "the decree"),
        ];
        let pieces = group(rows, &terms("recycling decree"), 10);
        let order = pieces
            .iter()
            .map(|piece| (piece.id.as_str(), piece.every_word))
            .collect::<Vec<_>>();
        assert_eq!(order, [("both", true), ("one", false)]);
    }

    /// Continue with the team is a press, not words: its run's prompt is the earlier work's, so
    /// it is not found as this work's request, while its answer still is.
    #[tokio::test]
    async fn a_continue_is_not_found_by_the_earlier_works_words() {
        let db = Db::temp().await;
        let index = WorkIndex::new(db.clone());
        sqlx::query(
            "INSERT INTO runs (run_id, session_id, team_path, team_key, prompt, status, mode,
                               entrypoint, responder, created_at, trigger, reply,
                               follows_run_id, start_at)
             VALUES ('next', 'next', 'research.yaml', 'research', 'Research battery recycling',
                     'succeeded', 'pipeline', 'researcher', 'writer', '2026-10-21T10:00:00Z',
                     'manual', 'The brief, carried on', 'first', 'writer')",
        )
        .execute(db.writer())
        .await
        .unwrap();
        let found = index
            .find("research", "research.yaml", "recycling", 10)
            .await
            .unwrap();
        assert!(found.pieces.is_empty(), "{found:?}");
        let found = index
            .find("research", "research.yaml", "carried", 10)
            .await
            .unwrap();
        assert_eq!(found.pieces[0].passages[0].target, "answer");
    }

    /// A piece queued again while it was being read is not taken off the queue: the newer write
    /// is indexed next time.
    #[tokio::test]
    async fn a_piece_written_again_while_it_was_read_stays_queued() {
        let db = Db::temp().await;
        let index = WorkIndex::new(db.clone());
        sqlx::query("INSERT INTO work_index_queue (piece, kind, version) VALUES ('n1', 'note', 1)")
            .execute(db.writer())
            .await
            .unwrap();
        // Read at version 1; a write meanwhile made it version 2.
        sqlx::query("UPDATE work_index_queue SET version = 2 WHERE piece = 'n1'")
            .execute(db.writer())
            .await
            .unwrap();
        index.write("n1", None, 1).await.unwrap();
        let left: i64 =
            sqlx::query("SELECT COUNT(*) AS n FROM work_index_queue WHERE piece = 'n1'")
                .fetch_one(db.reader())
                .await
                .unwrap()
                .get("n");
        assert_eq!(left, 1);
    }
}

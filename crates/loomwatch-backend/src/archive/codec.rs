//! How `run_events.raw` is stored: the exact ACP frame, minus what `payload` already holds.
//!
//! An event keeps two things: `payload`, the projection the UI reads, and `raw`, the whole frame
//! the app sent, which is the full-fidelity trace. Most of a frame *is* its projection. A tool
//! update's frame carries the tool's output in `rawOutput`, in `content`, and once more in the
//! app's own `_meta`, and `payload` copies the first two, so the archive used to hold the same
//! output five times. Measured on a real archive, tool updates were 5% of rows and 88% of bytes.
//!
//! So `raw` is stored as the frame with every value it shares with `payload` taken out, and the
//! rest compressed when that is smaller. Reading it puts the shared values back from `payload`,
//! which gives back a [`Value`] equal to the frame that was archived: equal values serialize to
//! the same bytes (`serde_json` keeps object keys sorted), so the trace the API returns does not
//! change by a byte. Nothing is dropped that cannot be put back exactly; a value is only taken out
//! when it is equal to the one `payload` holds at the recorded place.
//!
//! The stored bytes are `[FORMAT, flags, body…]`, where `body` is the JSON text
//! `{"r": <frame minus shared values>, "u": [...], "w": "..."}`, zstd-compressed when bit 0 of
//! `flags` is set:
//!
//! * `w` names one part of the frame that is the whole `payload`: `"update"` for
//!   `params.update` (plans, usage, other session updates), `"params"` for a permission request,
//!   `"result"` for the answer to one.
//! * `u` lists the keys of `params.update` taken out because `payload` holds them: a key alone
//!   when `payload` has it under the same name, or `[key, payloadKey]` when the projection renamed
//!   it (`toolCallId` is `callId`, `kind` is `toolKind`).

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Map, Value, json};

/// The first byte of every stored frame. A later layout gets a new number; this one stays readable.
const FORMAT: u8 = 1;
/// Bit 0 of the second byte: the body is zstd-compressed.
const COMPRESSED: u8 = 1;
/// Bodies shorter than this are stored as they are: zstd's own framing outweighs what it saves.
const COMPRESS_FROM: usize = 256;
/// Fast, and on real frames within a few percent of the ratio of much slower levels.
const LEVEL: i32 = 3;

/// The parts of a frame that can be the whole payload, as `w` names them.
const WHOLE: [(&str, &str); 3] = [
    ("update", "/params/update"),
    ("params", "/params"),
    ("result", "/result"),
];

/// Names the tool projection gives keys of `params.update` (`acp::project_tool`).
fn renamed(key: &str) -> Option<&'static str> {
    match key {
        "toolCallId" => Some("callId"),
        "kind" => Some("toolKind"),
        _ => None,
    }
}

/// Encode `raw` for storage beside `payload`.
///
/// # Errors
///
/// Returns an error only when compression itself fails.
pub(crate) fn encode(payload: &Value, raw: &Value) -> Result<Vec<u8>> {
    let mut rest = raw.clone();
    let mut body = Map::new();
    if let Some((name, pointer)) = WHOLE
        .iter()
        .find(|(_, pointer)| raw.pointer(pointer) == Some(payload))
    {
        remove(&mut rest, pointer);
        body.insert("w".into(), json!(name));
    } else if let (Some(update), Some(projected)) = (
        rest.pointer_mut("/params/update")
            .and_then(Value::as_object_mut),
        payload.as_object(),
    ) {
        let mut shared = Vec::new();
        update.retain(|key, value| {
            if projected.get(key) == Some(value) {
                shared.push(json!(key));
                return false;
            }
            if let Some(name) = renamed(key)
                && projected.get(name) == Some(value)
            {
                shared.push(json!([key, name]));
                return false;
            }
            true
        });
        if !shared.is_empty() {
            body.insert("u".into(), Value::Array(shared));
        }
    }
    body.insert("r".into(), rest);
    let text = serde_json::to_vec(&Value::Object(body)).context("cannot encode a raw frame")?;
    if text.len() >= COMPRESS_FROM {
        let compressed =
            zstd::bulk::compress(&text, LEVEL).context("cannot compress a raw frame")?;
        if compressed.len() < text.len() {
            let mut stored = Vec::with_capacity(compressed.len() + 2);
            stored.extend_from_slice(&[FORMAT, COMPRESSED]);
            stored.extend_from_slice(&compressed);
            return Ok(stored);
        }
    }
    let mut stored = Vec::with_capacity(text.len() + 2);
    stored.extend_from_slice(&[FORMAT, 0]);
    stored.extend_from_slice(&text);
    Ok(stored)
}

/// The frame `encode` was given, from what it stored and the event's `payload`.
///
/// # Errors
///
/// Returns an error for bytes this build did not write, or that do not match their payload.
pub(crate) fn decode(payload: &Value, stored: &[u8]) -> Result<Value> {
    let [format, flags, body @ ..] = stored else {
        bail!("a stored raw frame is too short");
    };
    ensure!(
        *format == FORMAT,
        "a stored raw frame is in format {format}, which this build cannot read"
    );
    let text = if flags & COMPRESSED == 0 {
        std::borrow::Cow::Borrowed(body)
    } else {
        std::borrow::Cow::Owned(decompress(body)?)
    };
    let Value::Object(mut body) =
        serde_json::from_slice(&text).context("a stored raw frame is not JSON")?
    else {
        bail!("a stored raw frame is not an object");
    };
    let mut raw = body
        .remove("r")
        .context("a stored raw frame has no frame")?;
    if let Some(name) = body.get("w").and_then(Value::as_str) {
        let (_, pointer) = WHOLE
            .iter()
            .find(|(whole, _)| *whole == name)
            .with_context(|| format!("a stored raw frame names an unknown part {name:?}"))?;
        put(&mut raw, pointer, payload.clone())?;
    }
    if let Some(shared) = body.get("u").and_then(Value::as_array) {
        let update = raw
            .pointer_mut("/params/update")
            .and_then(Value::as_object_mut)
            .context("a stored raw frame lost its update")?;
        for entry in shared {
            let (key, name) = match entry {
                Value::String(key) => (key.as_str(), key.as_str()),
                Value::Array(pair) => match pair.as_slice() {
                    [Value::String(key), Value::String(name)] => (key.as_str(), name.as_str()),
                    _ => bail!("a stored raw frame has a malformed shared key"),
                },
                _ => bail!("a stored raw frame has a malformed shared key"),
            };
            let value = payload
                .get(name)
                .with_context(|| format!("the payload no longer holds {name:?}"))?;
            update.insert(key.to_owned(), value.clone());
        }
    }
    Ok(raw)
}

/// A compressed body, into one buffer of exactly its size: `encode`'s frames record it. A frame
/// that does not, or claims an implausible size, is grown as it is read instead.
fn decompress(body: &[u8]) -> Result<Vec<u8>> {
    const PLAUSIBLE: u64 = 256 * 1024 * 1024;
    match zstd::zstd_safe::get_frame_content_size(body) {
        Ok(Some(size)) if size <= PLAUSIBLE => {
            let size = usize::try_from(size).context("a raw frame is too large to read")?;
            zstd::bulk::decompress(body, size).context("cannot decompress a raw frame")
        }
        _ => zstd::stream::decode_all(body).context("cannot decompress a raw frame"),
    }
}

/// Take the value at `pointer` out of `value`. Only called with pointers that exist.
fn remove(value: &mut Value, pointer: &str) {
    if let Some((parent, key)) = pointer.rsplit_once('/')
        && let Some(object) = value.pointer_mut(parent).and_then(Value::as_object_mut)
    {
        object.remove(key);
    }
}

/// Put `part` back at `pointer`, whose parent object must still be there.
fn put(value: &mut Value, pointer: &str, part: Value) -> Result<()> {
    let (parent, key) = pointer
        .rsplit_once('/')
        .context("a stored raw frame names no place")?;
    value
        .pointer_mut(parent)
        .and_then(Value::as_object_mut)
        .context("a stored raw frame lost the object a part belongs in")?
        .insert(key.to_owned(), part);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    fn round_trip(payload: &Value, raw: &Value) -> Vec<u8> {
        let stored = encode(payload, raw).expect("encodes");
        let back = decode(payload, &stored).expect("decodes");
        assert_eq!(&back, raw, "the frame comes back equal");
        assert_eq!(
            serde_json::to_string(&back).unwrap(),
            serde_json::to_string(raw).unwrap(),
            "and serializes to the same bytes"
        );
        stored
    }

    fn tool_update(output: &str) -> (Value, Value) {
        let content = json!([{"type": "content", "content": {"type": "text", "text": output}}]);
        let raw = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-7",
                    "kind": "execute",
                    "status": "completed",
                    "rawOutput": output,
                    "content": content,
                    "_meta": {"claudeCode": {"toolResponse": {"stdout": output, "stderr": ""}}}
                }
            }
        });
        let payload = json!({
            "callId": "call-7",
            "toolKind": "execute",
            "status": "completed",
            "rawOutput": output,
            "content": content,
        });
        (payload, raw)
    }

    /// The contract: what goes in comes back, byte for byte, and the output the payload already
    /// holds is not stored a second time.
    #[test]
    fn a_tool_update_round_trips_without_storing_its_output_twice() {
        let output = (0..2_000).fold(String::new(), |mut output, line| {
            let _ = writeln!(output, "line {line}: compiled crate number {}", line * 7);
            output
        });
        let (payload, raw) = tool_update(&output);
        let stored = round_trip(&payload, &raw);
        let frame = serde_json::to_vec(&raw).unwrap();
        assert!(
            stored.len() * 10 < frame.len(),
            "stored {} bytes for a {}-byte frame",
            stored.len(),
            frame.len()
        );
        assert_eq!(stored[1] & COMPRESSED, COMPRESSED);
        let text = zstd::stream::decode_all(&stored[2..]).unwrap();
        let body: Value = serde_json::from_slice(&text).unwrap();
        assert_eq!(
            body["u"],
            json!([
                "content",
                ["kind", "toolKind"],
                "rawOutput",
                "status",
                ["toolCallId", "callId"]
            ])
        );
        assert!(body["r"]["params"]["update"].get("rawOutput").is_none());
    }

    #[test]
    fn whole_parts_and_frames_with_nothing_shared_round_trip() {
        let usage = json!({"sessionUpdate": "usage_update", "used": 10, "size": 200});
        let frame = json!({"jsonrpc": "2.0", "method": "session/update",
                           "params": {"sessionId": "a", "update": usage}});
        let stored = round_trip(&usage, &frame);
        assert_eq!(stored[1], 0, "a short body is stored as it is");

        let request = json!({"sessionId": "a", "toolCall": {"toolCallId": "c"}, "options": []});
        round_trip(
            &request,
            &json!({"jsonrpc": "2.0", "id": 4, "method": "session/request_permission",
                    "params": request}),
        );
        let outcome = json!({"outcome": {"outcome": "selected", "optionId": "allow"}});
        round_trip(
            &outcome,
            &json!({"jsonrpc": "2.0", "id": 4, "result": outcome}),
        );

        // LoomWatch's own records share nothing with their payload, and some frames are not
        // even objects.
        round_trip(
            &json!({"role": "user", "content": {"type": "text", "text": "hi"}}),
            &json!({"source": "loomwatch", "phase": "operator_answer", "sendBack": "b"}),
        );
        round_trip(&json!({"a": 1}), &json!(null));
        round_trip(&json!({"a": 1}), &json!(["x", 1]));
        // A key equal in name but not in value stays in the frame.
        round_trip(
            &json!({"content": "projected", "messageId": "m"}),
            &json!({"params": {"update": {"content": "different", "messageId": "m"}}}),
        );
    }

    #[test]
    fn a_frame_whose_payload_changed_is_refused_rather_than_misread() {
        let (payload, raw) = tool_update("ok");
        let stored = encode(&payload, &raw).unwrap();
        assert!(decode(&json!({"callId": "call-7"}), &stored).is_err());
        assert!(decode(&payload, &[2, 0, b'{', b'}']).is_err());
        assert!(decode(&payload, &[1]).is_err());
    }
}

//! Server-sent events, as `OpenRouter` streams them: `data:` lines, blank lines between events, and
//! comment lines (`: OPENROUTER PROCESSING`) that only keep the connection open.

/// Collects a byte stream into the `data` of each complete event.
///
/// Lines are cut at `\n` bytes before they are decoded, so a character split across two network
/// chunks is never decoded half-way.
#[derive(Debug, Default)]
pub(crate) struct SseDecoder {
    pending: Vec<u8>,
    data: String,
    has_data: bool,
}

impl SseDecoder {
    /// The events `chunk` completes, in order.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|&byte| byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            self.line(line.trim_end_matches(['\n', '\r']), &mut events);
        }
        events
    }

    /// The event the stream ended in the middle of, if it carried any data.
    pub(crate) fn finish(&mut self) -> Option<String> {
        if !self.pending.is_empty() {
            let line = String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned();
            let mut events = Vec::new();
            self.line(line.trim_end_matches('\r'), &mut events);
            if let Some(event) = events.pop() {
                return Some(event);
            }
        }
        self.has_data.then(|| {
            self.has_data = false;
            std::mem::take(&mut self.data)
        })
    }

    fn line(&mut self, line: &str, events: &mut Vec<String>) {
        if line.is_empty() {
            if self.has_data {
                self.has_data = false;
                events.push(std::mem::take(&mut self.data));
            }
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = line.split_once(':').map_or((line, ""), |(field, value)| {
            (field, value.strip_prefix(' ').unwrap_or(value))
        });
        if field == "data" {
            if self.has_data {
                self.data.push('\n');
            }
            self.data.push_str(value);
            self.has_data = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_are_skipped_and_events_end_at_blank_lines() {
        let mut decoder = SseDecoder::default();
        let events =
            decoder.push(b": OPENROUTER PROCESSING\n\ndata: {\"a\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(events, ["{\"a\":1}", "[DONE]"]);
    }

    #[test]
    fn an_event_split_across_chunks_arrives_whole() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"data: {\"text\":\"caf").is_empty());
        // "é" is two bytes; the chunk boundary falls between them.
        assert!(decoder.push(&[0xC3]).is_empty());
        let events = decoder.push(&[0xA9, b'"', b'}', b'\r', b'\n', b'\r', b'\n']);
        assert_eq!(events, ["{\"text\":\"café\"}"]);
    }

    #[test]
    fn a_stream_cut_off_without_a_blank_line_still_yields_its_last_event() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"data: last").is_empty());
        assert_eq!(decoder.finish().as_deref(), Some("last"));
        assert_eq!(decoder.finish(), None);
    }
}

//! Listening while ⌃⌥Space is held (ADR 0083): the microphone, through macOS's own speech
//! recognition, written into the box at the notch as the person speaks.
//!
//! `Speech` and `AVFAudio` have no safe Rust interface, so this module calls them directly, as
//! `notch_panel.rs` does `AppKit` and `WebKit`. When to listen, and what the page is told, is
//! decided in `crate::island`, where it is tested; what is left here is asking macOS, hearing, and
//! handing the words on.
//!
//! macOS turns the words out on the Mac itself where it can for the language, and otherwise sends
//! the sound to Apple to do it, as dictation does. Nothing is kept: the sound goes no further than
//! the recognizer, and only the words reach the page.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::{AnyThread, sel};
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
use objc2_foundation::{NSError, NSObjectProtocol};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognitionTaskHint, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};

use crate::island::{self, CantListen};

/// What the recognizer says, for the app's event loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Heard {
    /// Every word heard so far; `done` once they are the last.
    Words { text: String, done: bool },
    /// The recognizer stopped without more words: what was heard so far is the last.
    Ended,
}

/// Whether the person has let `LoomWatch` use the microphone and speech recognition. The first time,
/// macOS asks them for the microphone and, once that is allowed, straight after for speech
/// recognition, so one hold asks both. Either way the box can't listen this time
/// (`CantListen::Asked`): the answers are read again on the next hold.
pub fn allowed() -> Result<(), CantListen> {
    // SAFETY: `AVMediaTypeAudio` is `AVFoundation`'s own constant.
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return Err(CantListen::Unavailable);
    };
    // SAFETY: a class method asked with a media type it takes.
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => {}
        AVAuthorizationStatus::NotDetermined => {
            let asked = RcBlock::new(|allowed: Bool| {
                if allowed.as_bool() {
                    ask_for_speech();
                }
            });
            // SAFETY: as above; the block asks only `Speech`, which any queue may.
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &asked) };
            return Err(CantListen::Asked);
        }
        _ => return Err(CantListen::Microphone),
    }
    // SAFETY: a class method with no arguments.
    match unsafe { SFSpeechRecognizer::authorizationStatus() } {
        SFSpeechRecognizerAuthorizationStatus::Authorized => Ok(()),
        SFSpeechRecognizerAuthorizationStatus::NotDetermined => {
            ask_for_speech();
            Err(CantListen::Asked)
        }
        _ => Err(CantListen::Speech),
    }
}

/// macOS asks the person whether `LoomWatch` may turn speech into words, unless they have answered.
fn ask_for_speech() {
    // SAFETY: a class method with no arguments.
    if unsafe { SFSpeechRecognizer::authorizationStatus() }
        != SFSpeechRecognizerAuthorizationStatus::NotDetermined
    {
        return;
    }
    let asked = RcBlock::new(|_: SFSpeechRecognizerAuthorizationStatus| {});
    // SAFETY: the app's Info.plist says why it asks (`NSSpeechRecognitionUsageDescription`),
    // without which macOS ends the app; the block captures nothing.
    unsafe { SFSpeechRecognizer::requestAuthorization(&asked) };
}

/// The box listening: the microphone running into a recognizer, from when ⌃⌥Space has been held
/// long enough until the last words are in after it is let go. Dropped, everything stops.
pub struct Hearing {
    engine: Retained<AVAudioEngine>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    _recognizer: Retained<SFSpeechRecognizer>,
    /// The microphone's latest loudness, as `f32` bits: written on the audio thread, read here.
    rms: Arc<AtomicU32>,
    /// The words heard so far, as the recognizer last gave them.
    words: Rc<RefCell<String>>,
    /// When it was let go, and the microphone stopped.
    stopped_at: Option<Instant>,
}

impl Hearing {
    /// Start listening, on the language macOS is set to, with each new set of words handed to
    /// `send` on the main thread. Allowed or not is asked first (`allowed`).
    pub fn start(send: impl Fn(Heard) + 'static) -> Result<Self, CantListen> {
        allowed()?;
        // SAFETY: `init` on a fresh allocation; `None` when macOS has no recognizer for the
        // language, or the keyboard's dictation language.
        let recognizer = unsafe { SFSpeechRecognizer::init(SFSpeechRecognizer::alloc()) }
            .ok_or(CantListen::Unavailable)?;
        // SAFETY: plain property reads and writes on objects made here.
        unsafe {
            if !recognizer.isAvailable() {
                return Err(CantListen::Unavailable);
            }
        }
        // SAFETY: as above.
        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        // SAFETY: as above. `addsPunctuation` is only on macOS 13 and later.
        unsafe {
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(recognizer.supportsOnDeviceRecognition());
            request.setTaskHint(SFSpeechRecognitionTaskHint::Dictation);
            if request.respondsToSelector(sel!(setAddsPunctuation:)) {
                request.setAddsPunctuation(true);
            }
        }

        // SAFETY: an engine made here.
        let engine = unsafe { AVAudioEngine::new() };
        // SAFETY: its input node, the Mac's microphone, made as it is first asked for.
        let input = unsafe { engine.inputNode() };
        // SAFETY: bus 0 is the input node's only output.
        let format = unsafe { input.outputFormatForBus(0) };
        // SAFETY: plain reads; a Mac with no microphone reports no channels.
        if unsafe { format.channelCount() } == 0 || unsafe { format.sampleRate() } <= 0.0 {
            return Err(CantListen::NoMicrophone);
        }

        let rms = Arc::new(AtomicU32::new(0));
        let tap = {
            let rms = Arc::clone(&rms);
            let request = request.clone();
            RcBlock::new(
                move |buffer: NonNull<AVAudioPCMBuffer>, _: NonNull<AVAudioTime>| {
                    // SAFETY: `AVAudioEngine` hands the tap a buffer that is valid for the call.
                    let buffer = unsafe { buffer.as_ref() };
                    rms.store(root_mean_square(buffer).to_bits(), Ordering::Relaxed);
                    // SAFETY: appending from the tap, on the audio thread, is how Apple's own
                    // examples feed a recognition request; the request is kept alive by this block.
                    unsafe { request.appendAudioPCMBuffer(buffer) };
                },
            )
        };
        // SAFETY: the tap's format is the bus's own; the block lives as long as the tap, which is
        // removed in `stop`. About a tenth of a second at 44.1 kHz per buffer.
        unsafe {
            input.installTapOnBus_bufferSize_format_block(
                0,
                4096,
                Some(&format),
                RcBlock::as_ptr(&tap),
            );
            engine.prepare();
        }
        // SAFETY: as above.
        if unsafe { engine.startAndReturnError() }.is_err() {
            // SAFETY: the tap installed just above.
            unsafe { input.removeTapOnBus(0) };
            return Err(CantListen::Unavailable);
        }

        let words = Rc::new(RefCell::new(String::new()));
        let handler = {
            let words = Rc::clone(&words);
            RcBlock::new(
                move |result: *mut SFSpeechRecognitionResult, _error: *mut NSError| {
                    // SAFETY: the recognizer calls this on its queue, the main queue unless told
                    // otherwise, with a result that is valid for the call or none.
                    match unsafe { result.as_ref() } {
                        Some(result) => {
                            // SAFETY: plain reads of the result handed over.
                            let (text, done) = unsafe {
                                (
                                    result.bestTranscription().formattedString().to_string(),
                                    result.isFinal(),
                                )
                            };
                            words.borrow_mut().clone_from(&text);
                            send(Heard::Words { text, done });
                        }
                        None => send(Heard::Ended),
                    }
                },
            )
        };
        // SAFETY: a request made above, and a handler that holds what it uses.
        let task =
            unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };
        Ok(Self {
            engine,
            request,
            task,
            _recognizer: recognizer,
            rms,
            words,
            stopped_at: None,
        })
    }

    /// Whether the microphone is still on: ⌃⌥Space has not been let go.
    pub fn listening(&self) -> bool {
        self.stopped_at.is_none()
    }

    /// How loud the microphone is now, from 0 to 1.
    pub fn level(&self) -> f64 {
        island::loudness(f32::from_bits(self.rms.load(Ordering::Relaxed)))
    }

    /// The words heard so far.
    pub fn words(&self) -> String {
        self.words.borrow().clone()
    }

    /// ⌃⌥Space was let go: the microphone stops, and the recognizer finishes the words it has.
    pub fn stop(&mut self, now: Instant) {
        if self.stopped_at.is_some() {
            return;
        }
        self.stopped_at = Some(now);
        // SAFETY: the engine and tap started in `start`, each stopped once.
        unsafe {
            self.engine.stop();
            self.engine.inputNode().removeTapOnBus(0);
            self.request.endAudio();
        }
    }

    /// Whether the last words have had long enough to arrive after it was let go
    /// (`island::LAST_WORDS_WAIT`).
    pub fn waited(&self, now: Instant) -> bool {
        self.stopped_at
            .is_some_and(|at| now.saturating_duration_since(at) >= island::LAST_WORDS_WAIT)
    }

    /// When it has waited long enough for the last words.
    pub fn waits_until(&self) -> Option<Instant> {
        self.stopped_at.map(|at| at + island::LAST_WORDS_WAIT)
    }
}

impl Drop for Hearing {
    fn drop(&mut self) {
        self.stop(Instant::now());
        // SAFETY: a task made in `start`; cancelling one that has finished does nothing.
        unsafe { self.task.cancel() };
    }
}

/// The root mean square of the first channel of `buffer`: how loud it is.
fn root_mean_square(buffer: &AVAudioPCMBuffer) -> f32 {
    // SAFETY: the engine's input format is 32-bit floats, one pointer per channel, each to
    // `frameLength` samples, valid while the tap holds the buffer.
    unsafe {
        let channels = buffer.floatChannelData();
        let frames = buffer.frameLength() as usize;
        if channels.is_null() || frames == 0 {
            return 0.0;
        }
        let samples = std::slice::from_raw_parts((*channels).as_ptr(), frames);
        #[allow(clippy::cast_precision_loss)]
        let mean = samples.iter().map(|sample| sample * sample).sum::<f32>() / frames as f32;
        mean.sqrt()
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn packaging(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packaging/macos")
            .join(name)
    }

    /// macOS ends an app that asks for the microphone or speech recognition without saying why in
    /// its `Info.plist`: the first hold of ⌃⌥Space would close `LoomWatch`.
    #[test]
    fn the_app_says_why_it_asks_for_the_microphone_and_speech_recognition() {
        for key in [
            "NSMicrophoneUsageDescription",
            "NSSpeechRecognitionUsageDescription",
        ] {
            let read = std::process::Command::new("/usr/bin/plutil")
                .args(["-extract", key, "raw", "-o", "-"])
                .arg(packaging("Info.plist"))
                .output()
                .unwrap();
            let why = String::from_utf8_lossy(&read.stdout);
            assert!(
                read.status.success() && why.contains("Control-Option-Space"),
                "{key}: {why}{}",
                String::from_utf8_lossy(&read.stderr)
            );
        }
    }

    /// Under the hardened runtime only a program entitled to it hears the microphone: the app is,
    /// and `loomwatchd`, which runs the agents' commands, is not.
    #[test]
    fn only_the_app_is_signed_for_the_microphone() {
        const MICROPHONE: &str = "<key>com.apple.security.device.audio-input</key>";
        let app = std::fs::read_to_string(packaging("LoomWatch-app.entitlements")).unwrap();
        let daemon = std::fs::read_to_string(packaging("LoomWatch.entitlements")).unwrap();
        assert!(app.contains(MICROPHONE));
        assert!(!daemon.contains(MICROPHONE));
        // Both may send Apple Events, as before.
        let events = "<key>com.apple.security.automation.apple-events</key>";
        assert!(app.contains(events) && daemon.contains(events));
        let script = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/package-macos-app.sh"),
        )
        .unwrap();
        assert!(script.contains(
            "--entitlements \"$app_entitlements\" \\\n    --sign \"$MACOS_SIGN_IDENTITY\" \"$app\"\n"
        ));
        assert!(script.contains(
            "--entitlements \"$entitlements\" \\\n    --sign \"$MACOS_SIGN_IDENTITY\" \"$app/Contents/MacOS/loomwatchd\""
        ));
    }
}

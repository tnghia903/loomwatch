//! Compiling and running a script through `OpenScripting`, the macOS framework `/usr/bin/osascript`
//! runs scripts with, so that a script behaves the same here: the same languages, results, `log`
//! lines and errors.
//!
//! One thing works better here than in `/usr/bin/osascript`: an app that macOS quit to free memory
//! still looks running, so `AppleScript` sends to it instead of starting it, and the script fails
//! with "Application isn't running" (-600). This module starts such an app and sends again.
//!
//! `OpenScripting`, the Apple Event Manager, Launch Services and Core Foundation are C interfaces
//! with no safe Rust crate, so this module, and only this one in the program, calls them directly.
//! Every descriptor, compiled script, component and Core Foundation object it gets back is held by
//! a type that frees it when dropped.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::ffi::c_void;
use std::io::Write as _;
use std::ptr;
use std::time::{Duration, Instant};

type FourCharCode = u32;
type OsErr = i16;
type OsaError = i32;
type OsaId = u32;
type Size = isize;
type ComponentInstance = *mut c_void;
type EventHandler = extern "C" fn(*const AeDesc, *mut AeDesc, *mut c_void) -> OsErr;
/// What a scripting component sends its Apple Events with (`OSASendProcPtr`): `AESend`'s
/// arguments and the value given when it was set.
type SendProc = unsafe extern "C" fn(
    *const AeDesc,
    *mut AeDesc,
    i32,
    i16,
    i32,
    *const c_void,
    *const c_void,
    *mut c_void,
) -> OsErr;
type CfType = *const c_void;

/// An Apple Event descriptor (`AEDesc`): a type code and the data it owns. The Apple Event headers
/// pack it to two bytes (`#pragma pack(push, 2)`), so it is 12 bytes, not 16.
#[repr(C, packed(2))]
struct AeDesc {
    descriptor_type: FourCharCode,
    data_handle: *mut c_void,
}

/// A process serial number (`ProcessSerialNumber`), which is how `AppleScript` addresses an app it
/// takes for running.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct Psn {
    high: u32,
    low: u32,
}

/// How to start an app (`LSLaunchURLSpec`). Launch Services packs it to two bytes like `AEDesc`,
/// so the last field sits at 28, not 32.
#[repr(C, packed(2))]
struct LaunchSpec {
    app: CfType,
    items: CfType,
    pass_through: *const AeDesc,
    flags: u32,
    async_refcon: *mut c_void,
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn AECreateDesc(kind: FourCharCode, data: *const c_void, size: Size, out: *mut AeDesc)
    -> OsErr;
    fn AEDisposeDesc(desc: *mut AeDesc) -> OsErr;
    fn AECoerceDesc(desc: *const AeDesc, to: FourCharCode, out: *mut AeDesc) -> OsErr;
    fn AEGetDescDataSize(desc: *const AeDesc) -> Size;
    fn AEGetDescData(desc: *const AeDesc, data: *mut c_void, size: Size) -> OsErr;
    fn AECreateList(factoring: *const c_void, size: Size, record: u8, out: *mut AeDesc) -> OsErr;
    fn AEPutPtr(
        list: *mut AeDesc,
        index: std::ffi::c_long,
        kind: FourCharCode,
        data: *const c_void,
        size: Size,
    ) -> OsErr;
    fn AEGetParamPtr(
        record: *const AeDesc,
        key: FourCharCode,
        wanted: FourCharCode,
        kind: *mut FourCharCode,
        data: *mut c_void,
        size: Size,
        actual: *mut Size,
    ) -> OsErr;
    fn AECreateAppleEvent(
        class: FourCharCode,
        id: FourCharCode,
        target: *const AeDesc,
        return_id: i16,
        transaction: i32,
        out: *mut AeDesc,
    ) -> OsErr;
    fn AEPutParamDesc(event: *mut AeDesc, key: FourCharCode, desc: *const AeDesc) -> OsErr;
    fn AEGetParamDesc(
        event: *const AeDesc,
        key: FourCharCode,
        wanted: FourCharCode,
        out: *mut AeDesc,
    ) -> OsErr;
    fn AEInstallEventHandler(
        class: FourCharCode,
        id: FourCharCode,
        handler: EventHandler,
        refcon: *mut c_void,
        system: u8,
    ) -> OsErr;
    fn AERemoveEventHandler(
        class: FourCharCode,
        id: FourCharCode,
        handler: EventHandler,
        system: u8,
    ) -> OsErr;
    fn AEGetAttributeDesc(
        event: *const AeDesc,
        key: FourCharCode,
        wanted: FourCharCode,
        out: *mut AeDesc,
    ) -> OsErr;
    fn OpenDefaultComponent(kind: FourCharCode, subtype: FourCharCode) -> ComponentInstance;
    fn CloseComponent(component: ComponentInstance) -> OsErr;
    fn LSOpenFromURLSpec(spec: *const LaunchSpec, launched: *mut CfType) -> i32;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn ProcessInformationCopyDictionary(psn: *const Psn, info: u32) -> CfType;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithBytes(
        allocator: CfType,
        bytes: *const u8,
        size: isize,
        encoding: u32,
        external: u8,
    ) -> CfType;
    fn CFStringGetTypeID() -> usize;
    fn CFStringGetCString(text: CfType, buffer: *mut u8, size: isize, encoding: u32) -> u8;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(number: CfType, kind: isize, out: *mut c_void) -> u8;
    fn CFGetTypeID(object: CfType) -> usize;
    fn CFDictionaryGetValue(dictionary: CfType, key: CfType) -> CfType;
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: CfType,
        path: *const u8,
        size: isize,
        directory: u8,
    ) -> CfType;
    fn CFRelease(object: CfType);
}

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn OSACompile(
        osa: ComponentInstance,
        source: *const AeDesc,
        mode: i32,
        id: *mut OsaId,
    ) -> OsaError;
    fn OSALoad(osa: ComponentInstance, data: *const AeDesc, mode: i32, id: *mut OsaId) -> OsaError;
    fn OSAExecuteEvent(
        osa: ComponentInstance,
        event: *const AeDesc,
        context: OsaId,
        mode: i32,
        result: *mut OsaId,
    ) -> OsaError;
    fn OSADisplay(
        osa: ComponentInstance,
        value: OsaId,
        wanted: FourCharCode,
        mode: i32,
        text: *mut AeDesc,
    ) -> OsaError;
    fn OSACoerceFromDesc(
        osa: ComponentInstance,
        data: *const AeDesc,
        mode: i32,
        id: *mut OsaId,
    ) -> OsaError;
    fn OSAScriptError(
        osa: ComponentInstance,
        selector: FourCharCode,
        wanted: FourCharCode,
        out: *mut AeDesc,
    ) -> OsaError;
    fn OSADispose(osa: ComponentInstance, id: OsaId) -> OsaError;
    fn OSASetDefaultScriptingComponent(osa: ComponentInstance, subtype: FourCharCode) -> OsaError;
    fn OSAGetSendProc(
        osa: ComponentInstance,
        send: *mut Option<SendProc>,
        refcon: *mut *mut c_void,
    ) -> OsaError;
    fn OSASetSendProc(
        osa: ComponentInstance,
        send: Option<SendProc>,
        refcon: *mut c_void,
    ) -> OsaError;
    fn AESend(
        event: *const AeDesc,
        reply: *mut AeDesc,
        mode: i32,
        priority: i16,
        timeout: i32,
        idle: *const c_void,
        filter: *const c_void,
    ) -> OsErr;
}

const fn code(name: [u8; 4]) -> FourCharCode {
    u32::from_be_bytes(name)
}

const TYPE_NULL: FourCharCode = code(*b"null");
const TYPE_WILDCARD: FourCharCode = code(*b"****");
const TYPE_UTF8: FourCharCode = code(*b"utf8");
const TYPE_SINT32: FourCharCode = code(*b"long");
const TYPE_KERNEL_PID: FourCharCode = code(*b"kpid");
const TYPE_COMPILED: FourCharCode = code(*b"scpt");
const TYPE_ERROR_RANGE: FourCharCode = code(*b"erng");
const KEY_DIRECT: FourCharCode = code(*b"----");
const KEY_ERROR_NUMBER: FourCharCode = code(*b"errn");
const KEY_ERROR_MESSAGE: FourCharCode = code(*b"errs");
const KEY_ERROR_RANGE: FourCharCode = code(*b"erng");
const KEY_SOURCE_START: FourCharCode = code(*b"srcs");
const KEY_SOURCE_END: FourCharCode = code(*b"srce");
const COMPONENT_OSA: FourCharCode = code(*b"osa ");
const COMPONENT_GENERIC: FourCharCode = code(*b"scpt");
/// The `run` handler's event: "open application".
const EVENT_CLASS_CORE: FourCharCode = code(*b"aevt");
const EVENT_RUN: FourCharCode = code(*b"oapp");
/// `AppleScript`'s `log` command, sent to the program running the script.
const EVENT_CLASS_APPLESCRIPT: FourCharCode = code(*b"ascr");
const EVENT_LOG: FourCharCode = code(*b"cmnt");
const MODE_NULL: i32 = 0;
/// A script compiled this way is a context with its own handlers, which `AppleScript` needs
/// before it runs the `run` event (`JavaScript` runs it either way).
const MODE_INTO_CONTEXT: i32 = 0x0000_0002;
const MODE_FOR_HUMANS: i32 = 0x0000_0008;
const AUTO_RETURN_ID: i16 = -1;
const ANY_TRANSACTION: i32 = 0;
/// `errOSAScriptError`: the script itself failed, and `OSAScriptError` says how.
const SCRIPT_ERROR: OsaError = -1753;
/// `procNotFound`: no running app at the address an event was sent to.
const PROC_NOT_FOUND: OsErr = -600;
const KEY_ADDRESS: FourCharCode = code(*b"addr");
const TYPE_PSN: FourCharCode = code(*b"psn ");
/// `kProcessDictionaryIncludeAllInformationMask`.
const ALL_INFORMATION: u32 = 0xFFFF_FFFF;
const CF_UTF8: u32 = 0x0800_0100;
const CF_SINT64: isize = 4;
/// `kLSLaunchDefaults | kLSLaunchDontAddToRecents | kLSLaunchDontSwitch`: started the way
/// `AppleScript` starts an app, behind the app in front.
const LAUNCH_BEHIND: u32 = 0x0000_0001 | 0x0000_0100 | 0x0000_0200;
/// How long an app macOS quit may take to start again before its event is given up on.
const START_WAIT: Duration = Duration::from_secs(30);

/// The scripting language a name passed to `-l` stands for, spelled as `osalang` lists it.
#[must_use]
pub fn language(name: &str) -> Option<FourCharCode> {
    match name {
        "AppleScript" => Some(code(*b"ascr")),
        "JavaScript" => Some(code(*b"jscr")),
        "Generic Scripting System" => Some(COMPONENT_GENERIC),
        _ => None,
    }
}

/// A script to run.
pub enum Script {
    /// Source text, compiled in the language asked for.
    Text(String),
    /// A compiled script file (`.scpt`), which carries its own language.
    Compiled(Vec<u8>),
}

impl Script {
    /// A script file's contents: compiled when it starts the way compiled scripts do, otherwise
    /// text (UTF-8, or UTF-16 with its byte order mark).
    #[must_use]
    pub fn from_file(bytes: Vec<u8>) -> Self {
        if bytes.starts_with(b"FasdUAS") {
            return Self::Compiled(bytes);
        }
        Self::Text(text(&bytes))
    }
}

/// Text read from a file or standard input.
#[must_use]
pub fn text(bytes: &[u8]) -> String {
    let utf16 = |little: bool| {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&pair| {
                if little {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    match bytes {
        [0xFF, 0xFE, ..] => utf16(true),
        [0xFE, 0xFF, ..] => utf16(false),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// How a run went: the result as `osascript` prints it (none when the script gave no value), or
/// the error line it prints, such as `6:12: execution error: boom (42)`.
pub type Outcome = Result<Option<String>, Failure>;

/// Why a run failed: the line `osascript` prints, and the script error's number when there is one.
#[derive(Debug)]
pub struct Failure {
    pub line: String,
    pub number: Option<i32>,
}

impl From<String> for Failure {
    fn from(line: String) -> Self {
        Self { line, number: None }
    }
}

impl From<&str> for Failure {
    fn from(line: &str) -> Self {
        line.to_owned().into()
    }
}

/// What a person can do about a script error macOS gave because it didn't let `LoomWatch` use the
/// app: told once, it doesn't ask again. Calendar, Reminders, Contacts and Photos also need their
/// own switch, and they answer `-1743` for either one. Said after macOS's own line, for the agent
/// to pass on, since `-10004` reads like anything but a setting.
#[must_use]
pub fn refusal_hint(number: Option<i32>) -> Option<&'static str> {
    // errAEEventNotPermitted, errAEEventWouldRequireUserConsent, errAEPrivilegeError.
    matches!(number, Some(-1743 | -1744 | -10004)).then_some(
        "osascript: macOS didn't let LoomWatch use this app. The person can allow it in \
         System Settings → Privacy & Security → Automation → LoomWatch. Calendar, Reminders, \
         Contacts and Photos also have their own list under Privacy & Security, where LoomWatch \
         must be allowed too (Full Access, where macOS offers a choice). If macOS then says \
         LoomWatch must quit first, choose Quit & Reopen and ask again.",
    )
}

/// Runs `script`, handing `arguments` to its `run` handler. `log` lines go to standard error as
/// they come.
pub fn run(
    script: &Script,
    language: Option<FourCharCode>,
    arguments: &[String],
    source_form: bool,
) -> Outcome {
    let display_mode = if source_form {
        MODE_NULL
    } else {
        MODE_FOR_HUMANS
    };
    let component =
        Component::open().ok_or("osascript: macOS's scripting system couldn't be opened.")?;
    let osa = component.0;
    if let Some(language) = language {
        // SAFETY: `osa` is an open generic scripting component.
        let error = unsafe { OSASetDefaultScriptingComponent(osa.0, language) };
        if error != 0 {
            return Err(Failure::from(format!(
                "osascript: the language couldn't be used ({error})."
            )));
        }
    }
    let logging = Logging::start(osa);
    // Before compiling, which may already ask an app for its words.
    let sending = Sending::start(osa);
    let compiled = match script {
        Script::Text(source) => {
            let source = Desc::bytes(TYPE_UTF8, source.as_bytes())
                .ok_or("osascript: the script couldn't be read.")?;
            let mut id = 0;
            // SAFETY: `source` is a live descriptor; `id` receives the new script's ID.
            let error =
                unsafe { OSACompile(osa.0, &raw const source.0, MODE_INTO_CONTEXT, &raw mut id) };
            if error == SCRIPT_ERROR {
                return Err(osa.script_error("syntax error"));
            }
            if error != 0 {
                return Err(Failure::from(format!(
                    "osascript: the script couldn't be compiled ({error})."
                )));
            }
            Value { osa, id }
        }
        Script::Compiled(bytes) => {
            let data = Desc::bytes(TYPE_COMPILED, bytes)
                .ok_or("osascript: the script couldn't be read.")?;
            let mut id = 0;
            // SAFETY: as for `OSACompile` above.
            let error = unsafe { OSALoad(osa.0, &raw const data.0, MODE_NULL, &raw mut id) };
            if error != 0 {
                return Err(Failure::from(format!(
                    "osascript: the compiled script couldn't be loaded ({error})."
                )));
            }
            Value { osa, id }
        }
    };
    let event = run_event(arguments).ok_or("osascript: the script couldn't be started.")?;
    let mut result = 0;
    // SAFETY: `event` is a live Apple Event and `compiled.id` a script this component holds.
    let error = unsafe {
        OSAExecuteEvent(
            osa.0,
            &raw const event.0,
            compiled.id,
            MODE_NULL,
            &raw mut result,
        )
    };
    drop(sending);
    drop(logging);
    if error == SCRIPT_ERROR {
        return Err(osa.script_error("execution error"));
    }
    if error != 0 {
        return Err(Failure::from(format!(
            "osascript: the script couldn't run ({error})."
        )));
    }
    if result == 0 {
        return Ok(None);
    }
    let result = Value { osa, id: result };
    Ok(osa.display(result.id, display_mode))
}

/// The `run` event, with the arguments as a list of strings in its direct parameter.
fn run_event(arguments: &[String]) -> Option<Desc> {
    let mut list = Desc::null();
    // SAFETY: an empty list is written into `list`, which owns it from here.
    if unsafe { AECreateList(ptr::null(), 0, 0, &raw mut list.0) } != 0 {
        return None;
    }
    for argument in arguments {
        // SAFETY: index 0 appends; the bytes are copied into the list.
        let error = unsafe {
            AEPutPtr(
                &raw mut list.0,
                0,
                TYPE_UTF8,
                argument.as_ptr().cast(),
                Size::try_from(argument.len()).ok()?,
            )
        };
        if error != 0 {
            return None;
        }
    }
    let pid = i32::try_from(std::process::id()).ok()?;
    let target = Desc::bytes(TYPE_KERNEL_PID, &pid.to_ne_bytes())?;
    let mut event = Desc::null();
    // SAFETY: `target` is live; the new event is written into `event`, which owns it.
    let error = unsafe {
        AECreateAppleEvent(
            EVENT_CLASS_CORE,
            EVENT_RUN,
            &raw const target.0,
            AUTO_RETURN_ID,
            ANY_TRANSACTION,
            &raw mut event.0,
        )
    };
    if error != 0 {
        return None;
    }
    // SAFETY: both descriptors are live; the list is copied into the event.
    if unsafe { AEPutParamDesc(&raw mut event.0, KEY_DIRECT, &raw const list.0) } != 0 {
        return None;
    }
    Some(event)
}

/// A descriptor this program owns.
struct Desc(AeDesc);

impl Desc {
    fn null() -> Self {
        Self(AeDesc {
            descriptor_type: TYPE_NULL,
            data_handle: ptr::null_mut(),
        })
    }

    fn bytes(kind: FourCharCode, bytes: &[u8]) -> Option<Self> {
        let mut desc = Self::null();
        // SAFETY: the bytes are copied into the new descriptor.
        let error = unsafe {
            AECreateDesc(
                kind,
                bytes.as_ptr().cast(),
                Size::try_from(bytes.len()).ok()?,
                &raw mut desc.0,
            )
        };
        (error == 0).then_some(desc)
    }

    /// The descriptor's data, as it is.
    fn data(&self) -> Vec<u8> {
        // SAFETY: `self.0` is a live descriptor.
        let size = unsafe { AEGetDescDataSize(&raw const self.0) };
        let mut data = vec![0u8; usize::try_from(size).unwrap_or(0)];
        // SAFETY: `data` has room for `size` bytes.
        let error = unsafe { AEGetDescData(&raw const self.0, data.as_mut_ptr().cast(), size) };
        if error != 0 {
            data.clear();
        }
        data
    }

    /// The descriptor as UTF-8 text, coerced when it holds something else.
    fn utf8(&self) -> Option<String> {
        if self.0.descriptor_type == TYPE_UTF8 {
            return Some(String::from_utf8_lossy(&self.data()).into_owned());
        }
        let mut text = Self::null();
        // SAFETY: `self.0` is live; the coerced copy is owned by `text`.
        if unsafe { AECoerceDesc(&raw const self.0, TYPE_UTF8, &raw mut text.0) } != 0 {
            return None;
        }
        Some(String::from_utf8_lossy(&text.data()).into_owned())
    }

    fn sint32(&self) -> Option<i32> {
        let mut number = Self::null();
        // SAFETY: as in `utf8`.
        if unsafe { AECoerceDesc(&raw const self.0, TYPE_SINT32, &raw mut number.0) } != 0 {
            return None;
        }
        Some(i32::from_ne_bytes(number.data().try_into().ok()?))
    }

    /// A number kept under `key` in this record.
    fn key_sint32(&self, key: FourCharCode) -> Option<i32> {
        let mut number = 0i32;
        let mut kind = 0;
        let mut size = 0;
        // SAFETY: `number` has room for the four bytes asked for.
        let error = unsafe {
            AEGetParamPtr(
                &raw const self.0,
                key,
                TYPE_SINT32,
                &raw mut kind,
                (&raw mut number).cast(),
                4,
                &raw mut size,
            )
        };
        (error == 0).then_some(number)
    }
}

impl Drop for Desc {
    fn drop(&mut self) {
        // SAFETY: the descriptor is owned here and freed once; a null one is a no-op.
        unsafe { AEDisposeDesc(&raw mut self.0) };
    }
}

/// The generic scripting component, which compiles in any installed language. Closed when
/// dropped.
struct Component(Osa);

impl Component {
    fn open() -> Option<Self> {
        // SAFETY: no arguments to get wrong; a null instance means it couldn't be opened.
        let instance = unsafe { OpenDefaultComponent(COMPONENT_OSA, COMPONENT_GENERIC) };
        (!instance.is_null()).then_some(Self(Osa(instance)))
    }
}

impl Drop for Component {
    fn drop(&mut self) {
        // SAFETY: the instance was opened here and is closed once.
        unsafe { CloseComponent(self.0.0) };
    }
}

/// An open scripting component, borrowed.
#[derive(Clone, Copy)]
struct Osa(ComponentInstance);

impl Osa {
    /// A value the component holds, as text: for people, or as source.
    fn display(&self, id: OsaId, mode: i32) -> Option<String> {
        let mut text = Desc::null();
        // SAFETY: `id` names a value this component holds; the text is owned by `text`.
        if unsafe { OSADisplay(self.0, id, TYPE_UTF8, mode, &raw mut text.0) } != 0 {
            return None;
        }
        text.utf8()
    }

    /// A descriptor someone handed over, as text the same way.
    fn display_desc(&self, desc: &Desc, mode: i32) -> Option<String> {
        let mut id = 0;
        // SAFETY: `desc` is live; `id` receives a value this component then holds.
        if unsafe { OSACoerceFromDesc(self.0, &raw const desc.0, MODE_NULL, &raw mut id) } != 0 {
            return None;
        }
        let value = Value { osa: *self, id };
        self.display(value.id, mode)
    }

    /// The last script error as `osascript` prints it: `start:end: <phase>: message (number)`,
    /// without the place when the language gives none.
    fn script_error(&self, phase: &str) -> Failure {
        let part = |selector, wanted| {
            let mut desc = Desc::null();
            // SAFETY: the description is written into `desc`, which owns it.
            let error = unsafe { OSAScriptError(self.0, selector, wanted, &raw mut desc.0) };
            (error == 0).then_some(desc)
        };
        let number = part(KEY_ERROR_NUMBER, TYPE_SINT32).and_then(|desc| desc.sint32());
        let message = part(KEY_ERROR_MESSAGE, TYPE_UTF8)
            .and_then(|desc| desc.utf8())
            .unwrap_or_default();
        let place = part(KEY_ERROR_RANGE, TYPE_ERROR_RANGE).and_then(|range| {
            Some((
                range.key_sint32(KEY_SOURCE_START)?,
                range.key_sint32(KEY_SOURCE_END)?,
            ))
        });
        let shown = number
            .map(|number| format!(" ({number})"))
            .unwrap_or_default();
        let line = match place {
            // `JavaScript` gives 0:0 for every error, and `osascript` leaves it out.
            Some((start, end)) if (start, end) != (0, 0) => {
                format!("{start}:{end}: {phase}: {message}{shown}")
            }
            _ => format!("{phase}: {message}{shown}"),
        };
        Failure { line, number }
    }
}

/// A script or value a component holds, freed when dropped.
struct Value {
    osa: Osa,
    id: OsaId,
}

impl Drop for Value {
    fn drop(&mut self) {
        if self.id != 0 {
            // SAFETY: the ID was given by this component and is freed once.
            unsafe { OSADispose(self.osa.0, self.id) };
        }
    }
}

/// `log` lines written to standard error while a script runs, the way `osascript` writes them:
/// always for people, even with `-s s`.
struct Logging {
    /// What the handler reads; boxed so its address holds while the handler is installed.
    _osa: Box<Osa>,
}

impl Logging {
    fn start(osa: Osa) -> Self {
        let mut state = Box::new(osa);
        // SAFETY: `state` outlives the handler, which `drop` removes before the box is freed.
        unsafe {
            AEInstallEventHandler(
                EVENT_CLASS_APPLESCRIPT,
                EVENT_LOG,
                on_log,
                (&raw mut *state).cast(),
                0,
            );
        }
        Self { _osa: state }
    }
}

impl Drop for Logging {
    fn drop(&mut self) {
        // SAFETY: removes the handler `start` installed.
        unsafe { AERemoveEventHandler(EVENT_CLASS_APPLESCRIPT, EVENT_LOG, on_log, 0) };
    }
}

extern "C" fn on_log(event: *const AeDesc, _reply: *mut AeDesc, refcon: *mut c_void) -> OsErr {
    // SAFETY: `refcon` is the `Osa` `Logging::start` installed, alive until it is removed.
    let osa = unsafe { *refcon.cast::<Osa>() };
    let mut value = Desc::null();
    // SAFETY: `event` is the live event being handled; the parameter is copied into `value`.
    let found = unsafe { AEGetParamDesc(event, KEY_DIRECT, TYPE_WILDCARD, &raw mut value.0) } == 0;
    if found && let Some(line) = osa.display_desc(&value, MODE_FOR_HUMANS) {
        let _ = writeln!(std::io::stderr(), "{line}");
    }
    0
}

/// The component's Apple Events sent as before, except that an app macOS quit to free memory is
/// started again first. macOS keeps such an app listed as running, so `AppleScript` sends to it
/// rather than starting it, and every try finds nobody there (-600).
struct Sending {
    osa: Osa,
    /// What the send proc reads; boxed so its address holds while it is set.
    state: Box<SendState>,
}

struct SendState {
    /// How the component sent before, and the value that goes with it.
    before: Option<SendProc>,
    before_refcon: *mut c_void,
    /// The apps started this run, each started once at most.
    started: RefCell<Vec<Psn>>,
}

impl Sending {
    fn start(osa: Osa) -> Self {
        let mut state = Box::new(SendState {
            before: None,
            before_refcon: ptr::null_mut(),
            started: RefCell::new(Vec::new()),
        });
        // SAFETY: `osa` is open; the old proc and its value are written into `state`, which
        // outlives the new proc: `drop` puts the old one back before the box is freed.
        unsafe {
            OSAGetSendProc(osa.0, &raw mut state.before, &raw mut state.before_refcon);
            OSASetSendProc(osa.0, Some(on_send), (&raw mut *state).cast());
        }
        Self { osa, state }
    }
}

impl Drop for Sending {
    fn drop(&mut self) {
        // SAFETY: puts back what `start` found.
        unsafe { OSASetSendProc(self.osa.0, self.state.before, self.state.before_refcon) };
    }
}

extern "C" fn on_send(
    event: *const AeDesc,
    reply: *mut AeDesc,
    mode: i32,
    priority: i16,
    timeout: i32,
    idle: *const c_void,
    filter: *const c_void,
    refcon: *mut c_void,
) -> OsErr {
    // SAFETY: `refcon` is the `SendState` `Sending::start` set, alive until `drop` unsets it.
    let state = unsafe { &*refcon.cast::<SendState>() };
    let send = || match state.before {
        // SAFETY: the component's own proc, with the arguments it was given.
        Some(before) => unsafe {
            before(
                event,
                reply,
                mode,
                priority,
                timeout,
                idle,
                filter,
                state.before_refcon,
            )
        },
        // SAFETY: `event` and `reply` are the live descriptors the component passed in.
        None => unsafe { AESend(event, reply, mode, priority, timeout, idle, filter) },
    };
    let mut error = send();
    if error != PROC_NOT_FOUND {
        return error;
    }
    let Some(psn) = target(event) else {
        return error;
    };
    if state.started.borrow().contains(&psn) || !start_quit_app(psn) {
        return error;
    }
    state.started.borrow_mut().push(psn);
    // The app keeps its address when it starts again; it takes events once it is up.
    let started = Instant::now();
    let mut pause = Duration::from_millis(100);
    while error == PROC_NOT_FOUND && started.elapsed() < START_WAIT {
        std::thread::sleep(pause);
        pause = (pause * 2).min(Duration::from_secs(1));
        error = send();
    }
    error
}

/// The app an event is addressed to, when it is addressed as `AppleScript` addresses an app it
/// takes for running.
fn target(event: *const AeDesc) -> Option<Psn> {
    let mut address = Desc::null();
    // SAFETY: `event` is live; the address is copied into `address`, which owns it.
    if unsafe { AEGetAttributeDesc(event, KEY_ADDRESS, TYPE_WILDCARD, &raw mut address.0) } != 0 {
        return None;
    }
    if address.0.descriptor_type != TYPE_PSN {
        return None;
    }
    let data = address.data();
    Some(Psn {
        high: u32::from_ne_bytes(data.get(0..4)?.try_into().ok()?),
        low: u32::from_ne_bytes(data.get(4..8)?.try_into().ok()?),
    })
}

/// Starts the app at `psn` again when it isn't running although macOS still lists it: macOS quit
/// it, or it quit. Whether it was started.
fn start_quit_app(psn: Psn) -> bool {
    // SAFETY: reads the process's details into a dictionary this program then owns.
    let Some(details) =
        Cf::new(unsafe { ProcessInformationCopyDictionary(&raw const psn, ALL_INFORMATION) })
    else {
        return false;
    };
    if details.number("pid").is_some_and(running) {
        // Still starting, or busy: not this module's to start.
        return false;
    }
    let Some(path) = details.text("BundlePath") else {
        return false;
    };
    let Ok(size) = isize::try_from(path.len()) else {
        return false;
    };
    // SAFETY: the path's bytes are copied into the new URL.
    let Some(app) = Cf::new(unsafe {
        CFURLCreateFromFileSystemRepresentation(ptr::null(), path.as_ptr(), size, 1)
    }) else {
        return false;
    };
    let spec = LaunchSpec {
        app: app.0,
        items: ptr::null(),
        pass_through: ptr::null(),
        flags: LAUNCH_BEHIND,
        async_refcon: ptr::null_mut(),
    };
    // SAFETY: `spec` and the URL in it are live for the call.
    unsafe { LSOpenFromURLSpec(&raw const spec, ptr::null_mut()) == 0 }
}

/// Whether a process with this ID is there. It may belong to someone else (`EPERM`).
fn running(pid: i64) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only asks whether the process is there.
    let there = unsafe { kill(pid, 0) } == 0;
    // EPERM: there, but someone else's.
    there || std::io::Error::last_os_error().raw_os_error() == Some(1)
}

/// A Core Foundation object this program owns, released when dropped.
struct Cf(CfType);

impl Cf {
    fn new(object: CfType) -> Option<Self> {
        (!object.is_null()).then_some(Self(object))
    }

    fn string(text: &str) -> Option<Self> {
        let size = isize::try_from(text.len()).ok()?;
        // SAFETY: the bytes are copied into the new string.
        Self::new(unsafe { CFStringCreateWithBytes(ptr::null(), text.as_ptr(), size, CF_UTF8, 0) })
    }

    /// The value under `key` in this dictionary, still owned by it.
    fn get(&self, key: &str) -> Option<CfType> {
        let key = Self::string(key)?;
        // SAFETY: both are live; the value is borrowed from the dictionary.
        let value = unsafe { CFDictionaryGetValue(self.0, key.0) };
        (!value.is_null()).then_some(value)
    }

    fn text(&self, key: &str) -> Option<String> {
        let value = self.get(key)?;
        // SAFETY: `value` is live while the dictionary is.
        if unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
            return None;
        }
        let mut buffer = vec![0u8; 4096];
        let size = isize::try_from(buffer.len()).ok()?;
        // SAFETY: `buffer` has room for `size` bytes, the end marker included.
        if unsafe { CFStringGetCString(value, buffer.as_mut_ptr(), size, CF_UTF8) } == 0 {
            return None;
        }
        let end = buffer.iter().position(|&byte| byte == 0)?;
        buffer.truncate(end);
        String::from_utf8(buffer).ok()
    }

    fn number(&self, key: &str) -> Option<i64> {
        let value = self.get(key)?;
        // SAFETY: `value` is live while the dictionary is.
        if unsafe { CFGetTypeID(value) != CFNumberGetTypeID() } {
            return None;
        }
        let mut number = 0i64;
        // SAFETY: `number` has room for the 64-bit integer asked for.
        let exact = unsafe { CFNumberGetValue(value, CF_SINT64, (&raw mut number).cast()) };
        (exact != 0).then_some(number)
    }
}

impl Drop for Cf {
    fn drop(&mut self) {
        // SAFETY: the object is owned here and released once.
        unsafe { CFRelease(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_files_are_read_as_compiled_or_text() {
        assert!(matches!(
            Script::from_file(b"FasdUAS 1.101.10\x0e".to_vec()),
            Script::Compiled(_)
        ));
        assert_eq!(text(b"\xEF\xBB\xBFreturn 1"), "return 1");
        assert_eq!(text(b"\xFF\xFEr\x00e\x00"), "re");
        assert_eq!(text(b"\xFE\xFF\x00r\x00e"), "re");
        assert_eq!(text("return \"✓\"".as_bytes()), "return \"✓\"");
    }

    #[test]
    fn a_refusal_from_macos_names_the_settings_that_lift_it() {
        for number in [-1743, -1744, -10004] {
            let hint = refusal_hint(Some(number)).unwrap();
            assert!(
                hint.contains("Privacy & Security → Automation → LoomWatch"),
                "{hint}"
            );
            assert!(
                hint.contains(
                    "Calendar, Reminders, Contacts and Photos also have their own list under \
                     Privacy & Security"
                ),
                "{hint}"
            );
            assert!(hint.contains("Quit & Reopen"), "{hint}");
        }
        assert_eq!(refusal_hint(Some(42)), None);
        assert_eq!(refusal_hint(None), None);
    }

    /// Laid out as the C headers lay them out (checked with `offsetof`): one byte off and Launch
    /// Services reads the flags, or the pointer after them, from the wrong place.
    #[test]
    fn launch_services_and_process_structs_match_their_c_layout() {
        assert_eq!(std::mem::size_of::<LaunchSpec>(), 36);
        assert_eq!(std::mem::offset_of!(LaunchSpec, flags), 24);
        assert_eq!(std::mem::offset_of!(LaunchSpec, async_refcon), 28);
        assert_eq!(std::mem::size_of::<Psn>(), 8);
        assert_eq!(std::mem::size_of::<AeDesc>(), 12);
    }

    #[test]
    fn languages_are_found_by_the_names_osalang_lists() {
        assert_eq!(language("JavaScript"), Some(code(*b"jscr")));
        assert_eq!(language("AppleScript"), Some(code(*b"ascr")));
        assert_eq!(
            language("javascript"),
            None,
            "osascript reads the name as spelled"
        );
    }
}

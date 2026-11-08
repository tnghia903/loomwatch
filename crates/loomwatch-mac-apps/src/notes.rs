//! Notes, through fixed scripts run by `/usr/bin/osascript`: Notes has no framework to call.
//!
//! The script is the same every time. The action and its arguments reach it only as `run(argv)`'s
//! arguments, as JSON it parses, so nothing an agent writes is ever read as script.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::args::{Args, MAX_ITEMS};

const OSASCRIPT: &str = "/usr/bin/osascript";
/// How long one action may take, macOS's question about Notes included.
const WAIT: Duration = Duration::from_secs(180);
/// What macOS answers when the person hasn't allowed `LoomWatch` to control Notes.
const NOT_ALLOWED: i64 = -1743;

/// Every action, in JavaScript for Automation. It prints `{"ok": …}` or `{"error", "number"}`.
const SCRIPT: &str = r#"
function run(argv) {
  const action = argv[0];
  const a = JSON.parse(argv[1]);
  const Notes = Application('Notes');
  const limit = Math.max(1, Math.min(a.limit || MAX_ITEMS, MAX_ITEMS));
  const cut = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
  const escape = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = t => t.split('\n').map(l => '<div>' + (l ? escape(l) : '<br>') + '</div>').join('');
  const fail = said => { const e = new Error(said); e.said = true; throw e; };
  const needed = key => (typeof a[key] === 'string' && a[key].trim() ? a[key] : fail('Give `' + key + '`: it is needed for this.'));
  const folderNamed = name => {
    const all = Notes.folders();
    const found = all.find(f => f.name().toLowerCase() === name.toLowerCase() || f.id() === name);
    return found || fail('There\'s no folder called ' + JSON.stringify(name) + '. There are: ' + all.map(f => f.name()).join(', ') + '.');
  };
  const noteNamed = id => {
    const n = Notes.notes.byId(id);
    try { n.name(); } catch (e) { fail('There\'s no note with id ' + id + '. Find it again with find_notes; it may have been deleted.'); }
    return n;
  };
  const folderOf = n => { try { return n.container().name(); } catch (e) { return null; } };
  const brief = n => ({ id: n.id(), title: n.name(), folder: folderOf(n), changed: n.modificationDate().toISOString() });
  try {
    switch (action) {
      case 'access':
        return JSON.stringify({ ok: Notes.folders.length });
      case 'list_folders':
        return JSON.stringify({ ok: Notes.folders().map(f => ({ id: f.id(), name: f.name(), notes: f.notes.length })) });
      case 'find_notes': {
        let found = a.folder ? folderNamed(a.folder).notes : Notes.notes;
        if (a.text) found = found.whose({ _or: [{ name: { _contains: a.text } }, { plaintext: { _contains: a.text } }] });
        const ids = found.id(), titles = found.name(), changed = found.modificationDate();
        const order = ids.map((_, i) => i).sort((x, y) => changed[y] - changed[x]);
        const notes = order.slice(0, limit).map(i => ({ id: ids[i], title: titles[i], changed: changed[i].toISOString() }));
        return JSON.stringify({ ok: { notes: notes, more: ids.length > limit } });
      }
      case 'read_note': {
        const n = noteNamed(needed('id'));
        return JSON.stringify({ ok: Object.assign(brief(n), { text: cut(n.plaintext(), MAX_NOTE_CHARS) }) });
      }
      case 'add_note': {
        const title = needed('title');
        const folder = a.folder ? folderNamed(a.folder) : Notes.defaultAccount().defaultFolder();
        const n = Notes.Note({ body: '<div><h1>' + escape(title) + '</h1></div>' + html(a.text || '') });
        folder.notes.push(n);
        return JSON.stringify({ ok: { added: brief(n) } });
      }
      case 'change_note': {
        const n = noteNamed(needed('id'));
        const text = needed('text');
        if ((a.how || 'append') === 'append') {
          n.body = n.body() + html(text);
        } else if (a.how === 'replace') {
          n.body = '<div><h1>' + escape(a.title || n.name()) + '</h1></div>' + html(text);
        } else {
          fail('`how` is "append" (add to the end) or "replace" (write it all again).');
        }
        return JSON.stringify({ ok: { changed: brief(n) } });
      }
      case 'delete_note': {
        const n = noteNamed(needed('id'));
        const gone = brief(n);
        Notes.delete(n);
        return JSON.stringify({ ok: { deleted: gone, recentlyDeleted: true } });
      }
      default:
        fail('There\'s no action called ' + action + ' here.');
    }
  } catch (e) {
    return JSON.stringify({ error: e.said ? e.message : String(e.message || e), number: e.errorNumber || null });
  }
}
"#;

/// The most of a note's text one answer carries.
const MAX_NOTE_CHARS: usize = 20_000;

/// The script as it runs: [`SCRIPT`] with its limits written in. Nothing else is ever added.
fn script() -> String {
    SCRIPT
        .replace("MAX_ITEMS", &MAX_ITEMS.to_string())
        .replace("MAX_NOTE_CHARS", &MAX_NOTE_CHARS.to_string())
}

/// The command line for `action`: the fixed script, then the action and its arguments as data.
fn command(action: &str, arguments: &Value) -> Command {
    let mut command = Command::new(OSASCRIPT);
    command
        .args(["-l", "JavaScript", "-e"])
        .arg(script())
        .arg(action)
        .arg(arguments.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// What the script printed, or what went wrong running it.
fn run(action: &str, arguments: &Value) -> Result<Value, String> {
    let mut child = command(action, arguments)
        .spawn()
        .map_err(|error| format!("LoomWatch couldn't start osascript for Notes: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < WAIT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Notes didn't answer in time. Try again.".to_owned());
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Notes' answer couldn't be read: {error}"))?;
    let printed = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Value>(printed.trim()).map_err(|_| {
        let said = String::from_utf8_lossy(&output.stderr);
        if said.contains(&NOT_ALLOWED.to_string()) {
            not_allowed()
        } else {
            format!("Notes didn't answer: {}", said.trim())
        }
    })
}

fn not_allowed() -> String {
    "macOS didn't let LoomWatch control Notes. The person can allow it in System Settings → \
     Privacy & Security → Automation → LoomWatch → Notes."
        .to_owned()
}

fn answer(printed: &Value) -> Result<Value, String> {
    if let Some(found) = printed.get("ok") {
        return Ok(found.clone());
    }
    if printed.get("number").and_then(Value::as_i64) == Some(NOT_ALLOWED) {
        return Err(not_allowed());
    }
    Err(printed
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Notes didn't say what went wrong.")
        .to_owned())
}

/// Whether `LoomWatch` may control Notes, asking the person first if macOS never has.
pub fn access() -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Err("This works only on a Mac.".to_owned());
    }
    match run("access", &json!({})).and_then(|printed| answer(&printed)) {
        Ok(_) => Ok(true),
        Err(said) if said == not_allowed() => Ok(false),
        Err(said) => Err(said),
    }
}

pub fn call(action: &str, args: &Args) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("This works only on a Mac.".to_owned());
    }
    if action == "access" {
        return Err(format!("There's no action called {action} here."));
    }
    run(action, args.0).and_then(|printed| answer(&printed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agents_words_reach_the_script_only_as_its_arguments() {
        let sly = json!({"title": "\"); doShellScript('rm -rf ~'); (\"", "text": "${x} `y`"});
        let built = command("add_note", &sly);
        let words: Vec<String> = built
            .get_args()
            .map(|word| word.to_string_lossy().into_owned())
            .collect();
        assert_eq!(words[..3], ["-l", "JavaScript", "-e"]);
        assert_eq!(words[3], script(), "the script is always the same");
        assert!(!words[3].contains("rm -rf"));
        assert_eq!(words[4], "add_note");
        assert_eq!(serde_json::from_str::<Value>(&words[5]).unwrap(), sly);
        assert_eq!(words.len(), 6);
    }

    #[test]
    fn a_refusal_says_where_to_allow_notes() {
        let refused = answer(&json!({"error": "Not authorized", "number": -1743})).unwrap_err();
        assert!(
            refused.contains("Automation → LoomWatch → Notes"),
            "{refused}"
        );
        assert_eq!(answer(&json!({"ok": [1]})).unwrap(), json!([1]));
        assert_eq!(
            answer(&json!({"error": "boom", "number": null})).unwrap_err(),
            "boom"
        );
    }

    #[test]
    fn the_script_has_its_limits_written_in() {
        let script = script();
        assert!(!script.contains("MAX_ITEMS") && !script.contains("MAX_NOTE_CHARS"));
        assert!(script.contains(&format!("a.limit || {MAX_ITEMS}")));
    }
}

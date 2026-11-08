#!/usr/bin/env python3
"""A stand-in for `loomwatch-mac-apps`, for trials of the Mac apps' tools that touch no real data.

Start a trial daemon with LOOMWATCH_MAC_APPS_PROGRAM set to this file (it must be executable). It
reads the same command lines as the real helper (ADR 0121):

    mock-mac-apps.py access <app>            -> {"access": "granted"}, or "refused" while the file
                                                that MOCK_MAC_APPS_REFUSE names exists
    mock-mac-apps.py call <app> <action>     -> {"ok": ...} with made-up events, reminders, notes or
                                                contacts; the arguments come as JSON on stdin

Each call is appended to MOCK_MAC_APPS_LOG, when set, as one JSON line.
"""
import json
import os
import sys

EVENT = {
    "id": "mock-event-1",
    "title": "Dentist",
    "start": "2026-11-12T15:00:00+07:00",
    "end": "2026-11-12T16:00:00+07:00",
    "allDay": False,
    "calendar": "Home",
    "location": None,
    "notes": None,
    "repeats": False,
}
REMINDER = {"id": "mock-reminder-1", "title": "Buy oat milk", "done": False, "due": None,
            "list": "Groceries", "notes": None, "priority": 0}
NOTE = {"id": "mock-note-1", "title": "Tokyo trip", "folder": "Notes",
        "changed": "2026-11-01T09:00:00.000Z"}
CONTACT = {"id": "mock-contact-1", "givenName": "Lan", "familyName": "Nguyen", "nickname": None,
           "organization": None, "jobTitle": None,
           "phones": [{"label": "mobile", "number": "+84 90 000 0000"}], "emails": [], "birthday": None}

ANSWERS = {
    ("calendar", "list_calendars"): [{"id": "home", "name": "Home", "canChange": True}],
    ("calendar", "find_events"): {"from": "2026-11-09T00:00:00+07:00", "to": "2026-11-16T00:00:00+07:00",
                                  "events": [EVENT], "more": False},
    ("calendar", "add_event"): {"added": EVENT},
    ("calendar", "change_event"): {"changed": EVENT},
    ("calendar", "delete_event"): {"deleted": EVENT},
    ("reminders", "list_lists"): [{"id": "groceries", "name": "Groceries", "canChange": True}],
    ("reminders", "find_reminders"): {"reminders": [REMINDER], "more": False},
    ("reminders", "add_reminder"): {"added": REMINDER},
    ("reminders", "change_reminder"): {"changed": REMINDER},
    ("reminders", "complete_reminder"): {"changed": dict(REMINDER, done=True)},
    ("reminders", "delete_reminder"): {"deleted": REMINDER},
    ("notes", "list_folders"): [{"id": "notes", "name": "Notes", "notes": 1}],
    ("notes", "find_notes"): {"notes": [NOTE], "more": False},
    ("notes", "read_note"): dict(NOTE, text="Tokyo trip\nHotel: to choose"),
    ("notes", "add_note"): {"added": NOTE},
    ("notes", "change_note"): {"changed": NOTE},
    ("notes", "delete_note"): {"deleted": NOTE, "recentlyDeleted": True},
    ("contacts", "find_contacts"): {"contacts": [CONTACT], "more": False},
    ("contacts", "get_contact"): {"contact": CONTACT},
    ("contacts", "add_contact"): {"added": CONTACT},
    ("contacts", "change_contact"): {"changed": CONTACT},
    ("contacts", "delete_contact"): {"deleted": CONTACT},
}


def log(entry):
    path = os.environ.get("MOCK_MAC_APPS_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as file:
            file.write(json.dumps(entry) + "\n")


def main(words):
    if len(words) == 2 and words[0] == "access":
        refuse = os.environ.get("MOCK_MAC_APPS_REFUSE")
        refused = bool(refuse) and os.path.exists(refuse)
        log({"access": words[1], "refused": refused})
        return {"access": "refused" if refused else "granted"}
    if len(words) == 3 and words[0] == "call":
        arguments = json.loads(sys.stdin.read() or "{}")
        log({"app": words[1], "action": words[2], "arguments": arguments})
        answer = ANSWERS.get((words[1], words[2]))
        if answer is None:
            return {"error": f"There's no action called {words[2]} here."}
        return {"ok": answer}
    print("usage: mock-mac-apps.py access <app> | call <app> <action>", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1:])))

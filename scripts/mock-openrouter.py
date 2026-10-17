"""A stand-in for OpenRouter on 127.0.0.1, for end-to-end checks of LoomWatch with no real key.

It answers the three things LoomWatch asks OpenRouter: the key check (GET /api/v1/key), the model
list (GET /api/v1/models) and streamed chat completions (POST /api/v1/chat/completions). Replies are
scripted from what the request says, so a run exercises real tool calls:

- "MOCK-RUN: <command>" in the task  -> a run_command call, then a summary
- "MOCK-WRITE: <path>" in the task    -> a write_file call, then a summary
- "MOCK-READ: <path>" in the task     -> a read_file call, then a summary
- "MOCK-FAIL-402" in the task         -> a 402 out-of-credits answer
- a Research lead (its role says so)  -> two dispatch calls at once, then ask the Writer
- a Researcher / a Writer             -> findings / a cited report
- anything else                       -> a short text reply

The task is the text after the last "## Task" in the latest request, so earlier messages in the
team's chat don't trigger anything again. Only a key starting "sk-or-v1-mock" is accepted.

Every request is logged to requests.jsonl, and the latest one in full to last_request.json, in
$MOCK_OPENROUTER_LOG (default: the system's temporary folder). Nothing is written elsewhere.

Usage: python3 scripts/mock-openrouter.py [port]   (default 4100)
"""

import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.environ.get("MOCK_OPENROUTER_LOG") or tempfile.gettempdir()
LOG = os.path.join(HERE, "requests.jsonl")
LOCK = threading.Lock()
COUNTER = [0]

MODELS = [
    {"id": "anthropic/claude-opus-5.5", "name": "Anthropic: Claude Opus 5.5", "created": 3,
     "context_length": 1000000, "pricing": {"prompt": "0.000004", "completion": "0.00002"},
     "supported_parameters": ["tools", "reasoning"]},
    {"id": "anthropic/claude-sonnet-5.5", "name": "Anthropic: Claude Sonnet 5.5", "created": 2,
     "context_length": 1000000, "pricing": {"prompt": "0.000002", "completion": "0.00001"},
     "supported_parameters": ["tools", "reasoning"]},
    {"id": "openai/gpt-6.1-sol", "name": "OpenAI: GPT-6.1 Sol", "created": 1,
     "context_length": 400000, "pricing": {"prompt": "0.000003", "completion": "0.000015"},
     "supported_parameters": ["tools", "reasoning"]},
    {"id": "google/gemma-4-31b-it:free", "name": "Google: Gemma 4 31B (free)", "created": 1,
     "context_length": 128000, "pricing": {"prompt": "0", "completion": "0"},
     "supported_parameters": ["tools"]},
]


def log(entry):
    with LOCK:
        with open(LOG, "a") as handle:
            handle.write(json.dumps(entry) + "\n")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def tool_names(body):
    names = []
    for tool in body.get("tools") or []:
        function = tool.get("function") or {}
        if function.get("name"):
            names.append(function["name"])
    return names


def find_tool(names, suffix):
    for name in names:
        if name == suffix or name.endswith("__" + suffix) or name.endswith("." + suffix):
            return name
    return None


def plan(body):
    """What to answer: ("text", str) or ("calls", [(name, args)])."""
    messages = body.get("messages") or []
    system = "\n".join(text_of(m.get("content")) for m in messages if m.get("role") == "system")
    users = [text_of(m.get("content")) for m in messages if m.get("role") == "user"]
    latest = users[-1] if users else ""
    last = messages[-1] if messages else {}
    names = tool_names(body)
    # A job is said in the system prompt or under "## Your assigned role" in the first request.
    first = users[0] if users else ""
    own = first.split("## Your assigned role", 1)[1].split("\n## ", 1)[0] if "## Your assigned role" in first else system
    lower_system = own.lower()

    if last.get("role") == "tool":
        said = text_of(last.get("content"))
        # Which call this answers.
        call_name = ""
        for message in reversed(messages):
            for call in message.get("tool_calls") or []:
                if call.get("id") == last.get("tool_call_id"):
                    call_name = (call.get("function") or {}).get("name", "")
            if call_name:
                break
        if call_name.endswith("ask"):
            try:
                reply = json.loads(said).get("reply", said)
            except (ValueError, AttributeError):
                reply = said
            return ("text", f"{reply}\n\n## Not confirmed\n- Nothing: both sources agreed.")
        if call_name.endswith("dispatch"):
            # Both dispatches answered with "accepted": end this turn; the results come back later.
            return ("text", "I handed the two parts of the question to the Researcher. Their findings come back next.")
        return ("text", f"Done. The tool answered: {said[:300]}")

    task = latest.rsplit("## Task", 1)[-1]
    if "MOCK-RUN:" in task:
        command = task.rsplit("MOCK-RUN:", 1)[1].strip().splitlines()[0]
        return ("calls", [(find_tool(names, "run_command") or "run_command", {"command": command})])
    if "MOCK-WRITE:" in task:
        path = task.rsplit("MOCK-WRITE:", 1)[1].strip().split()[0]
        return ("calls", [(find_tool(names, "write_file") or "write_file",
                           {"path": path, "content": "# Notes\n\nWritten by the mock model.\n"})])

    if "MOCK-READ:" in task:
        path = task.rsplit("MOCK-READ:", 1)[1].strip().split()[0]
        return ("calls", [(find_tool(names, "read_file") or "read_file", {"path": path})])

    dispatch = find_tool(names, "dispatch")
    ask = find_tool(names, "ask")
    if "team’s research lead" in lower_system or "team's research lead" in lower_system:
        if "came back with" in latest and ask:
            return ("calls", [(ask, {"agent": "writer", "question":
                "Write a short report that answers: what makes a good onboarding guide? Use only these "
                "findings, with a numbered citation after every claim and a ## Sources list.\n\n"
                "Findings: short guides get finished more often [https://example.com/a, 2026-09-01]; "
                "screenshots help newcomers [https://example.com/b, 2026-08-15]."})])
        if dispatch:
            return ("calls", [
                (dispatch, {"agent": "researcher", "task": "Sub-question 1: how long should an onboarding guide be? Send back findings with sources."}),
                (dispatch, {"agent": "researcher", "task": "Sub-question 2: do screenshots help newcomers? Send back findings with sources."}),
            ])
    if "you are the team’s researcher" in lower_system:
        return ("text", "## Summary\nShort guides get finished more often.\n\n## Findings\n- Guides under one page are finished twice as often ([Example A](https://example.com/a), 2026-09-01).\n\n## Conflicts and gaps\nNone found.\n\n## Sources\n- Example A — https://example.com/a — 2026-09-01")
    if "you are the team’s writer" in lower_system:
        return ("text", "# What makes a good onboarding guide\n\nShort guides get finished more often [1]. Screenshots help newcomers follow along [2].\n\n## Sources\n1. Example A — https://example.com/a — 2026-09-01\n2. Example B — https://example.com/b — 2026-08-15")
    return ("text", f"Mock reply: {latest.strip()[:160]}")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self):
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer sk-or-v1-mock")

    def do_GET(self):
        if self.path.startswith("/api/v1/models"):
            log({"at": time.time(), "path": self.path})
            return self.send_json(200, {"data": MODELS})
        if self.path.startswith("/api/v1/key"):
            log({"at": time.time(), "path": self.path, "authorised": self.authorised()})
            if not self.authorised():
                return self.send_json(401, {"error": {"code": 401, "message": "No auth credentials found"}})
            return self.send_json(200, {"data": {"label": "sk-or-v1-moc...ock", "usage": 0.42,
                                                 "limit_remaining": 9.58, "is_free_tier": False}})
        self.send_json(404, {"error": {"code": 404, "message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        COUNTER[0] += 1
        number = COUNTER[0]
        messages = body.get("messages") or []
        users = [text_of(m.get("content")) for m in messages if m.get("role") == "user"]
        entry = {"at": time.time(), "n": number, "path": self.path, "authorised": self.authorised(),
                 "model": body.get("model"), "stream": body.get("stream"),
                 "reasoning": body.get("reasoning"), "tools": tool_names(body),
                 "messages": len(messages), "latest_user": (users[-1] if users else "")[:200],
                 "system_head": text_of(messages[0].get("content"))[:120] if messages else ""}
        if not self.path.startswith("/api/v1/chat/completions"):
            return self.send_json(404, {"error": {"code": 404, "message": "not found"}})
        if not self.authorised():
            log({**entry, "answer": "401"})
            return self.send_json(401, {"error": {"code": 401, "message": "No auth credentials found"}})
        if "MOCK-FAIL-402" in (users[-1] if users else "").rsplit("## Task", 1)[-1]:
            log({**entry, "answer": "402"})
            return self.send_json(402, {"error": {"code": 402, "message": "Insufficient credits"}})
        # The whole latest request, for checking what an agent was told (skills, orientation).
        with LOCK:
            with open(os.path.join(HERE, "last_request.json"), "w") as handle:
                json.dump(body, handle, indent=1)
        kind, value = plan(body)
        log({**entry, "answer": kind, "detail": value if kind == "calls" else value[:120]})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def event(payload):
            self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
            self.wfile.flush()

        self.wfile.write(b": OPENROUTER PROCESSING\n\n")
        base = {"id": f"gen-{number}", "model": body.get("model"), "object": "chat.completion.chunk"}
        if kind == "text":
            words = value.split(" ")
            step = max(1, len(words) // 4)
            for start in range(0, len(words), step):
                piece = " ".join(words[start:start + step])
                if start + step < len(words):
                    piece += " "
                event({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": piece}, "finish_reason": None}]})
                time.sleep(0.05)
            finish = "stop"
        else:
            for index, (name, args) in enumerate(value):
                arguments = json.dumps(args)
                half = len(arguments) // 2
                event({**base, "choices": [{"index": 0, "delta": {"tool_calls": [
                    {"index": index, "id": f"call_{number}_{index}", "type": "function",
                     "function": {"name": name, "arguments": arguments[:half]}}]}, "finish_reason": None}]})
                time.sleep(0.03)
                event({**base, "choices": [{"index": 0, "delta": {"tool_calls": [
                    {"index": index, "function": {"arguments": arguments[half:]}}]}, "finish_reason": None}]})
            finish = "tool_calls"
        prompt_tokens = 900 + 40 * len(messages)
        event({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
               "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": 120,
                         "prompt_tokens_details": {"cached_tokens": 600},
                         "cost": round(prompt_tokens * 0.000002 + 120 * 0.00001, 6)}})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4100
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()

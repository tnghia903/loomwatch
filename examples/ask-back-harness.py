#!/usr/bin/env python3
"""Offline ACP fixture for ask-back.yaml; never contacts a model provider.

Like operator-stop-harness.py, but the writer also puts a question back to the researcher through
the Team Bus `ask` tool, the way a real agent would, so a run shows every kind of message between
agents: a handover, a question to an earlier stage and its answer, a review you can send back, and
your direction to the stage after it.
"""
import json
import sys
import urllib.request

agent = sys.argv[1]
bus = None  # (url, headers) of the Team Bus, from session/new
turns = 0
feedback = ""


def emit(value):
    print(json.dumps(value), flush=True)


def say(text):
    emit({"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": agent, "update": {"sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": text}}}})


def ask(target, question):
    """Call the Team Bus `ask` tool and return the answer text."""
    url, headers = bus
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": "ask", "arguments": {"agent": target, "question": question}}}).encode()
    request = urllib.request.Request(url, data=body, method="POST",
                                     headers={**headers, "Content-Type": "application/json", "Accept": "application/json"})
    # The bus listens on 127.0.0.1: never send it through a proxy the environment names.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=120) as response:
        result = json.load(response)["result"]
    text = result["content"][0]["text"]
    return json.loads(text).get("reply", text) if not result.get("isError") else "(the question failed: " + text + ")"


def operator_note(prompt):
    """The operator's own words from "## Direction from you", without LoomWatch's framing."""
    if "## Direction from you" not in prompt:
        return ""
    section = prompt.split("## Direction from you", 1)[1]
    section = section.split("## Results from preceding stages", 1)[0].strip()
    framing, _, note = section.partition("\n\n")
    return note.strip() if framing.startswith("The operator") else section


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    result = {}
    if method == "initialize":
        # Advertise HTTP MCP, or LoomWatch cannot hand this agent the Team Bus.
        result = {"protocolVersion": 1, "agentCapabilities": {"mcpCapabilities": {"http": True}}}
    elif method == "session/new":
        for server in request["params"].get("mcpServers", []):
            if server.get("type") == "http" and server.get("name") == "loomwatch-team-bus":
                bus = (server["url"], {header["name"]: header["value"] for header in server.get("headers", [])})
        result = {"sessionId": agent, "configOptions": []}
    elif method == "session/prompt":
        turns += 1
        prompt = "\n".join(part.get("text", "") for part in request["params"]["prompt"])
        if prompt.startswith("Last step. Record where this work stands"):
            say("## Done\nFinished the offline demo step.\n\n## Next\nNothing further.")
        elif prompt.startswith("Your work on this task is done. Write the handover"):
            if agent == "researcher":
                say("## Summary\nThree stories for today, each with a source.\n\n"
                    "## Findings\n1. New chip export rule published (Commerce Department, 3 Oct).\n"
                    "2. A chip maker's shares fell 4% before the market opened (Bloomberg, 4 Oct).\n"
                    "3. A model lab raised a large funding round (TechCrunch, 2 Oct).")
            else:
                say("## Draft\nLead: the chip export rule, confirmed by two outlets.\nAlso: the funding round, in one line." +
                    ("\n\n## Changed after your note\n" + feedback if feedback else ""))
        elif "read your handover and sent this" in prompt:
            feedback = prompt.split("\n\n", 1)[1].split("\n\nWhen you are done", 1)[0]
            say("Revised the draft: " + feedback)
        elif agent == "researcher" and turns > 1:
            # A later stage's question, answered in the session that did the research.
            say("Bloomberg reported the 4% drop at 07:12 ET on 4 Oct, and Reuters confirmed the same figure at 07:40 ET.")
        elif agent == "researcher":
            say("Found three stories for today and noted a source for each. No model provider was called.")
        elif agent == "writer":
            answer = ask("researcher", "Which outlet reported the 4% drop, and did a second outlet confirm it?") if bus else "(no Team Bus)"
            say("Draft written. I checked the 4% figure with the researcher first: " + answer)
        else:
            note = operator_note(prompt)
            say("Offline demo complete. No AI model was used. " +
                ("The editor followed your direction:\n\n" + note if note else "The editor received no direction."))
        result = {"stopReason": "end_turn"}
    elif method == "session/cancel":
        continue
    elif method != "session/close":
        emit({"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32601, "message": "Unsupported demo method"}})
        continue
    emit({"jsonrpc": "2.0", "id": request.get("id"), "result": result})
    if method == "session/close":
        break

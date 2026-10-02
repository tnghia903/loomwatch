#!/usr/bin/env python3
"""Offline ACP fixture for operator-stop.yaml; never contacts a model provider."""
import json
import sys

agent = sys.argv[1]
feedback = ""


def emit(value):
    print(json.dumps(value), flush=True)


def say(text):
    emit({"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": agent, "update": {"sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": text}}}})


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    result = {}
    if method == "initialize":
        result = {"protocolVersion": 1}
    elif method == "session/new":
        result = {"sessionId": agent, "configOptions": [], "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Ask first"}]}}
    elif method == "session/prompt":
        prompt = "\n".join(part.get("text", "") for part in request["params"]["prompt"])
        if prompt.startswith("Last step. Record where this work stands"):
            say("## Done\nPrepared the offline demonstration." +
                "\n\n## Next\nApply the operator's next direction.")
        elif prompt.startswith("Your work on this task is done. Write the handover"):
            say("## Summary\nDemo options: a short guide or a detailed walkthrough." +
                ("\n\n## Revision requested\n" + feedback if feedback else "") +
                "\n\n## Open questions\nWhich format should Writer use?")
        elif "read your handover and sent this" in prompt:
            feedback = prompt.split("\n\n", 1)[1].split("\n\nWhen you are done", 1)[0]
            say("Revised the demo findings: " + feedback)
        elif agent == "writer":
            direction = prompt.split("## Direction from you", 1)[-1].split("## Results from preceding stages", 1)[0].strip()
            say("Offline demo complete. Writer received your direction:\n\n" + direction)
        else:
            say("Offline demo findings: choose a short guide or a detailed walkthrough. No model provider was called.")
        result = {"stopReason": "end_turn"}
    elif method == "session/cancel":
        continue
    elif method != "session/close":
        emit({"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32601, "message": "Unsupported demo method"}})
        continue
    emit({"jsonrpc": "2.0", "id": request.get("id"), "result": result})
    if method == "session/close":
        break

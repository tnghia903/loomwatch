# Delivery Lane interaction prototype

[Open local prototype](http://127.0.0.1:4173/) · [Selected concept](../04-concept-delivery-lane.png) · [Visual QA](design-qa.md)

This is a labeled, self-contained example using simulated runs. It does not scan the machine or execute agents.

Explore Run 15 for loaded skills, Run 14 for a missing required skill, or the live example for progress and stopping. The capability graph supports agent/team scope, filters, a list alternative, and clickable receipts. The output stays visible while inspecting the work.

Build lets you connect example skills across harnesses, select the output owner, and save a draft locally. Existing example runs keep their own snapshots. Review output, revision simulation, copy, and Markdown download are interactive. Other output formats are visibly unavailable.

The actual LoomWatch implementation is in `ui/src/components/run/DeliveryLane.tsx`; its live preview is [here](http://127.0.0.1:4174/). Production uses real archive evidence and backend instruction-delivery receipts. Persistent report approval and rich generated-file previews are still prototype concepts.

Build: `npm run build`. The checked-in source includes no model service calls. Nothing has been published.

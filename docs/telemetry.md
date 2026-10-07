# Telemetry

[Back to the README](../README.md) · [Docs map](../README.md#docs)

- **Engine events:** every `wf` command appends to the attempt's hash-chained ledger: phase, role, step, suite, status, reuse, duration and chosen workers. Resource sampling (memory and CPU peaks) is not built yet.
- **Agent usage:** the model, tokens, time and tool calls for each role are read from the runtime's own session logs after the fact. A Claude Code subagent is found by the name it was started with (the `--agent` id) and its agent type, so no session id is needed. Per handoff the report shows the work item, class, declared and observed effort, agent type, model, the owner session's model at the handoff, wall minutes, active minutes (wall time minus gaps of 5 minutes or more), rounds (a fresh prompt to a finished agent starts a new one) and output tokens. One agent measured 185 wall minutes for about 21 active, so compare active minutes. This is measurement only; it never allows or blocks anything.
- **`wf status --all`** shows open work across every enabled project.
- **`wf report`** shows where time and tokens go: by phase, step, role and model, with reuse rate and repair rounds. Details: [DESIGN.md](DESIGN.md#telemetry). Each attempt row counts `impactGaps`: review findings tagged `impact-gap`, about something the planner's impact map did not list (a direct measure of the plan; see [lifecycle.md](lifecycle.md#impact-analysis)). `--csv` writes one row per attempt, `--handoffs-csv` one row per handoff, `--html` both.

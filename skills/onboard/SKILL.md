---
name: onboard
description: Onboard the current project to agentic-workflow. Use when the user asks to set up, onboard or enable agentic-workflow (or "wf") in a project. Detects repos, components, commands and secrets, confirms them with the user, and proves the setup with wf doctor.
---

# Onboard a project

`wf` is the agentic-workflow CLI. If `wf` is not on PATH, run `node <this plugin's root>/bin/wf install` once, or call `node <plugin root>/bin/wf` directly.

1. **Detect.** Run `wf init` at the project root (the folder holding the repos). It drafts `.workflow/project.yaml` (disabled), `.workflow/secrets.yaml` (names only) and `.workflow/AGENTS.invariants.md`.
2. **Confirm the system with the user.** Show a table of components (id, kind, repo/package, what it provides, what it depends on) and a dependency diagram. Ask them to confirm, rename, add missing components (including services in repos not checked out and third parties), and mark contracts that must never break.
3. **Ask only what you can't detect:** tracker (kind, team, the status names for started / in review / delivered / done, or none), lanes (quick, standard, batch), the real invariants, and the product stage (pre-launch or live) — write the stage and invariants into `.workflow/AGENTS.invariants.md`.
4. **Gate steps.** Walk through each detected step: command, inputs, tier (light/heavy), lease, workers. Fix anything wrong in the draft. Add steps the detection missed.
5. **Secrets.** Show the catalogued keys as a table (key, purpose, used by, kind, state from `wf secrets status`). Fill in `obtain` (console URL and steps) for each provided key. Run `wf secrets init` for generated and test keys. Then ask the user to run `wf secrets guide` **in their own terminal** — never in this session, never with `!`, never pasting values into chat. Poll `wf secrets status` until they are done.
6. **Skills, connectors, tools.** List what the roles need. Vendor skills into `.workflow/skills/<name>/` only when the license allows (show it), add them under `requires.skills`, run `wf sync`. For connectors (the tracker), check with one read-only call and tell the user exactly where to connect it if missing.
7. **Prove.** Run `wf doctor`. Config problems: fix the draft and rerun. Tests already failing on a clean base: fix them as the first quick fix; if the fix is large, stop and show the user the failing suites and logs.
8. **Enable.** Commit `.workflow/` on the base branch of the adapter repo (the gate trusts only the committed adapter), then `wf enable`. Tell the user what was set up and what is still pending.

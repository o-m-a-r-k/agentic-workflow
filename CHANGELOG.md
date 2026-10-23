# Changelog

## 0.9.8

Meaning first: what a person sees, a screen or a report, is shaped by who it is for and what they must come away knowing or doing. The plan's new "What people see" section holds that purpose, the user's questions and the reference screen; a new or rejected screen compares two or three directions against those questions, chosen by the planner where the design system settles the look and by the person otherwise. A new `read` role, isolated from code, plan and data, sees only a commit's screenshots and that purpose before each review round on a changed screen, answers the user's questions from the screen alone and lists what it had to work out; review raises what holds as findings, and delivery checks the reader saw the delivered screens. A rejected screen restarts from its purpose, checked with the person before rebuilding. Handoffs open with what the reader must know or do.

## 0.9.7

Settings for running on a small or local model. `agents_at_once: 1` runs every step and agent one after another, with the orchestrator idle while a worker runs, so the workflow keeps one model call in flight at a time; the method is unchanged, and a slow worker counts as gone only when the harness says it ended. `context_tokens` tells the orchestrator and workers the window to read within. `models: session` runs every role on the session's model. `profiles.<name>` groups settings, active when named in the session or by `AGENTS_WORKFLOW_PROFILE`, and wins over a project's role models. Records carry the profile. The orchestrator reads only the plan parts the next decision needs.

## 0.9.6

Screens are judged as their user reads them, for any visible change, new or altered, from a whole page to one component; a shared component is judged on the screens that use it. The plan names the existing page, drawer, form or component of the same kind each visible change follows. The implementer looks at the running screen itself, and review reads the whole design-system sections for what is on it and judges composition: what is found first, grouping, labels and values in the user's words, use of space. Neighbours are screens that do the same kind of job, not the nearest route; fitting every width is not looking right; a new arrangement of existing components is a new look for the person to decide.

## 0.9.5

A ticket's scope is what it delivers, never a wider guarantee than it asks for. A guarantee the change leans on is named with where it holds; making it hold everywhere is its own ticket, unless the change breaks it. Shared-code defects and the reach search cover what the ticket's own paths hit and the inconsistencies the change would create. The challenger tests the plan against what the ticket asks and what already works, and work counts as stalled when a round's fixes keep opening gaps of their own.

## 0.9.4

Project and personal instructions can add steps to the method but never remove one. Authority to deliver doesn't approve a high-risk plan; only the person, in the session, can waive a step, for the ticket they name.

## 0.9.3

A check that fails while proving a ticket is fixed in that ticket, even when the failure sits in untouched code or only happens sometimes. A delivery never stands on a red or flaky run, and a failing test is not filed away as a separate ticket.

## 0.9.2

A `test` skill, which planning, building and review follow: every test names the failure it catches, sits at the cheapest level that can see it, asserts outcomes, and the change removes the tests it makes redundant, so the suite stays fast. The build role now defaults to Sonnet on Claude Code; planning, challenge and review stay on Opus.

## 0.9.1

Every delivery record now lists what was missed and where it was caught (grounding, challenge, review, verification, the person, or after delivery). Learning and re-running onboarding read these records first, so a kind of miss that repeats points at the wording to improve.

## 0.9.0

A complete replacement. agentic-workflow is now a plugin made only of text: a `deliver` skill with its way of working (`WORKFLOW.md`), role briefs, templates and default role models, and an `onboard` skill that writes each project's definition. The engine, the `wf` CLI, the hooks, the adapters and the scenario suite are gone. It installs in Claude Code and Codex from the same repository.

Every finished delivery ends with a report to the person, the same as the tracker handoff: what changed, its impact and how that was proven, every screenshot, the tickets filed along the way, accepted risks, and where it lives. The report and its screenshots are kept in `~/.agents/reports/<project>/<ticket>/`, so they outlive the ticket folder.

## 0.8 and earlier

See the git history and the `v0.*` tags.

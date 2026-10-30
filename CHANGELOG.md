# Changelog

## 0.10.0

A `design` skill holds the goal, principles and practice for anything people see: purpose before layout, visible importance with one focal point, grouping by meaning, like things alike, one clear next step, the common shown and the rare disclosed, the person's words and formats, every real state designed, belonging to the product, and use by everyone. It adds visual craft, a screen whose words and actions agree, one name per thing, and feedback, prevention and recovery. A visible change is proven as a rendered picture before the build, showing the actions and the states that stress it: one for a small change, two or three directions that differ in structure for a new, contested or failed screen; a fresh reader reads the chosen picture before the plan is grounded. Plan, implement, review and verify follow the skill instead of carrying their own design clauses, and onboarding records each project's design system, reference screens and cheapest renderer.

## 0.9.11

What a screen shows or says is a claim like any other, true in every real state that shows it: the grounder checks the plan's words that way and review checks the built ones. A state shown to be unreachable through real use or existing data gets no design of its own, only the guard that keeps it safe.

## 0.9.10

A screen that fails its purpose is redesigned as a whole, not mended finding by finding. It fails when the person rejects it, or when its fresh reader leaves one of its user's questions unanswered and review confirms it, even where the screen was built as planned; a question answered only in part counts as unanswered. Review raises that as one finding, not as fixes or questions for the person, and its return line says the screen goes back to the plan, which derives again what it must say, in what order and form, from its user's questions and compares two or three directions before anything is rebuilt. The reviewer's other findings stand. What the reader had to work out on a screen that answers every question is still reviewed item by item. Any question still unanswered after the redesign is the same gap left open.

## 0.9.9

The project definition can live in the project's own versioned folder: `.agents/project.md`, found from the current directory upward or in a sibling folder, with paths relative to it and no `roots`. A personal `<project>.local.md` adds machine-only facts and never removes any. Onboarding writes it there when the folder is versioned, so a checkout in the cloud or on a new machine carries the same definition. Where `~/.agents` does not exist, the report and the record line are skipped and the tracker comment is the record. Screenshots are a named gate: when the change affects what people see, the handoff carries every screenshot of the delivered commit attached in the tracker, read back and matched, before the ticket moves to `delivered`. A definition has a `name`; a repo-held one wins over a personal one, which onboarding retires; the personal `.local.md` may give this machine's paths and never removes a step.

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

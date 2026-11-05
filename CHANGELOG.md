# Changelog

## 0.14.2

Heavy test runs start when measured free memory covers their peak, not by a count. Free memory is taken less what every heavy run already going, whoever started it, has yet to reach of its peak; a run makes itself visible before it takes memory, and both the container VM and the machine must have room. A run with no recorded peak starts only alone. The project definition gives peaks, margin, where to measure and how a run is seen; onboarding measures peaks and no longer writes `heavy_runs: 1`. `heavy_runs`, when set, is only an outer limit.

## 0.14.1

Screens answer with what they show, not with sentences. Each question in a plan's purpose names the element that answers it (a labelled value, a state, a mark, a control or a link); a sentence needs the reason no element can carry the fact, since a sentence is a claim that can turn false in a state nobody pictured. A request to change a screen's words starts from the question its user couldn't answer. A screen that failed through its words is redone by what it shows; options that differ only in wording are one direction. A question a reader answered only from explaining text is unanswered.

## 0.14.0

Screens are designed so they don't fail their first reading. The design answers every question in its purpose whether or not the data exists yet; what it needs and the product lacks is the ticket's work, in the delivery the plan gives it. What a screen says will happen, and its figures, come from the rules and data the product acts on, not from words written apart from them. Pictures are rendered from the code that will draw the screen, with the product's own rules and one consistent set of data the product could hold, in a spike saved as a patch the build starts from. The plan names the rule behind each consequence and figure a screen shows, so grounding can check it. When the person couldn't tell from one short line what an action will do in their case, simpler behaviour goes to the person before design.

## 0.13.1

A plan is written on the code it will be built on. Each revision names the commit of each worktree it read, and while it is written, grounded and challenged the orchestrator starts no worker that would change the files its claims rest on; a fix due there waits for the revision or joins it. Other files, work for an earlier delivery and base updates go on. The grounder and challenger read at those commits and say first if a worktree moved; the grounder's return line names the move.

## 0.13.0

Tickets stop looping on work that isn't theirs. Related work is the ticket's: what the users can't get the outcome without, and what the change caused. Everything else found is an extra, shown to the person in plain words, one at a time or together, with a recommendation (file it, fix it now, fix it after this delivery) while work goes on; a hotfix shows them after its first delivery. The users' part ships first when the related work beyond it is large, and is held back only by a regression or what it can't be true without; plans, checks and progress track each delivery, and the ticket moves to delivered with the last. Only a changed decision or corrected claim is a plan revision. A rare failure on a money or setup path stops safely for an operator; automatic recovery is the person's decision. Investigation walks the users' path, read-only, before planning. An unrelated check that fails the same way on the base is an extra, not a blocker. A re-plan that doesn't help stops the ticket for the person. Proof is the tests a change reaches; a complete suite runs only for dependencies, build or test tooling, or shared infrastructure, once per delivery.

## 0.12.2

A production hotfix stays on its failure and root cause. Its outcome is the failure stopping and its cause removed at its root; nothing else is, even in the same screen or code. Planner, challenger, implementer, reviewer and the reader's purpose stay on that cause; a check that fails off the cause path and fails the same way on the base doesn't block it. Nothing is filed while it runs: what would be is held under "Outside the ticket" in `PROGRESS.md` and named, one line each, in the handoff of the delivery that stops the failure, for the person to decide. Wrong money, data, permissions or state reaching users now is told to the person at once, still not fixed in the hotfix. A bug's or hotfix's outcome is the behaviour working again as it did before the change that broke it, found from history and measured against that version, or as it was meant to where it never worked. How the product met the failure is outside the ticket; hiding, retrying or recovering from a failure whose cause stays, or altering what users relied on, doesn't count toward it, and a cause that can't be removed without such a change is the person's decision, undoing the breaking change among the options. Planner, challenger, reviewer and the design loop are held to the cause path for bugs as well as hotfixes. A picture earns its place by showing what no other does. A value's length, rounding or format, a width and a language are shown in the state they stress, not as states of their own; the other direction is pictured once, in the state with the most parts; a change to words re-takes only the pictures that show them. The reader, review and delivery screenshots cover the pictured states only.

## 0.12.1

Work stops looping. Progress is an item gone from what `PROGRESS.md` says stands between the users and the outcome, judged against when it is needed; a finding, a revision or a passing run is not progress by itself. When one re-plan hasn't brought it nearer, or the time will pass first, the person gets the evidence and the options, always including delivering first the part that makes the outcome true for the users waiting, with nothing wrong left reachable and the rest staying this ticket's work; that is not a waiver, and agents never ask for one. The planner orders that part first; a hotfix whose cause takes longer is two deliveries of one ticket, cleaned up after the second. Later review rounds read the fixes against earlier findings. A base update is made only when delivery needs the branch current, the delivery agent names what it touched, and only the checks covering that overlap run again. `heavy_runs` counts every heavy run on the machine; the project definition says how a run claims a slot and how to see the others. The orchestrator runs no tests, builds, containers or servers, and a permission a worker couldn't get goes to the person, not to the orchestrator. Projects onboarded earlier get how to claim and see heavy runs by re-running onboarding.

## 0.12.0

What the project's environments can produce is produced and checked: a ticket never reports a walkthrough, a state or a check it could have run as unchecked or a limit, and the handoff lists only what couldn't be produced, as work not done. Verification walks the outcome through as its users meet it, in the running app, through the product's real paths (a mocked response passes no check), runs each check as written and sets only its result; the delivery agent treats a producible gap as a failed link. Everything a worker starts or creates, and whatever its runs leave behind that it can trace to itself, is removed or recorded in `PROGRESS.md` as left behind; cleanup removes that list and whatever the project's way of finding leftovers shows. The orchestrator routes what workers return, never rules on findings about the plan or the change, never writes fixes, checks, memos or a reader's purpose, asks only what the method gives the person, records their standing instructions once and doesn't ask again; nobody offers the person a waiver. The reader gets the plan's purpose word for word, and the planner changes it only when the person or a grounded fact does, so rounds are comparable. The plan is rewritten in place with current decisions only, each revision copied to `evidence/` so grounding and approval compare against it, and it owns `CHECKS.json`, grounded with it. A product decision is one whose answer changes what the users or the business get and that nothing else settles. Only a change that can't alter any answer the reader gives skips the picture, and a builder returns a screen that fails its purpose to the plan. A failure counts as possible when the product's real paths reach it. Delivery screenshots are the states the plan names. Every message to the person opens with where the outcome stands. Onboarding records how an agent runs the app to walk through, the browser it drives, and how a ticket's leftovers are found and removed; projects onboarded earlier get these by re-running onboarding.

## 0.11.0

The workflow is built around the ticket's outcome instead of its steps. Each ticket starts by writing what will be true in its users' world once it is delivered, the most direct evidence of it and how soon it is needed. The orchestrator owns the distance to that outcome and picks each move by what shortens it, weighed against time; the steps stay the usual moves, and grounding, review, verification, high-risk approval and delivery checks are never skipped. Local reproductions, benchmarks, suites, readers and sign-offs count only while shown to track the outcome; progress is the distance shrinking, and a round that shrinks nothing sends the work back to the outcome rather than to another round, another check or a filed ticket. A plan shows the change is enough to reach the outcome, not only that it improves something; the challenger tests that and whether the outcome is the whole of the ticket. Investigation reads a failure where it happens first. Verification runs the proofs the plan names, once, on the final tree. Delivery looks for the outcome where it lives and says what will show it when only time or real use can. The reader says what it would do on a screen, not only what it can answer. The method's text is shorter, and several case clauses fold into the outcome.

## 0.10.2

Show, don't tell: a screen carries its meaning in what it shows, and text that explains it or narrates what to do elsewhere is the design not yet done; the action is offered where it is needed, and a missing action is a product question for the person, never a sentence. Errors, confirmations and required notices stay words, short and in place. The reader says whether each answer came from what the screen shows or only from explaining text; at the picture read such an answer goes back into the design unless the planner records why text is the right form, and in review one the reviewer confirms the screen should show counts as unanswered, so the screen is redesigned rather than reworded. What can't be done is shown by the state that prevents it.

## 0.10.1

What a ticket delivers is the whole feature as its users will meet it, so a defect in it is the ticket's to fix whoever wrote it and however old it is; wrong money, data, permissions or state is never minor or cheap, and whether it can happen is settled in the ticket, not filed as untraced. The orchestrator judges what workers list as outside the ticket before filing it, and filing never makes a ticket smaller; the handoff names each ticket filed and why it lies outside.

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

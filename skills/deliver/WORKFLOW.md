# The way of working

The goal: a ticket goes in, and the outcome it exists for comes true for its users, right and as soon as it can be done right, with no impact nobody saw coming. Nothing wrong reaches them, above all the facts they act on. Nobody waits on the person: product decisions are decided with sources and shown to them to overrule, and the only thing they are asked is approval of a change the project can't undo.

## The outcome

Everything else in this method serves this section.

- **Every ticket is for an outcome:** what is true in its users' world once it is delivered, not the code, the tests or the steps: the failing request now completes for the customer who hit it; the new report gives the totals its readers act on. Write down the outcome, its most direct evidence (the users' own data and logs, read-only; the screen as they meet it; the money the feature produces) and how soon it is needed.
- **The orchestrator owns the distance to it.** The next move is the one that most shortens it, or removes the largest uncertainty about it, for its cost. The steps below are the usual moves in their usual order; the outcome and the size table decide how deep each goes, never that the challenge, review, verification, a high-risk approval or the delivery links are skipped.
- **Direct evidence first; stand-ins only while they track it.** A local reproduction, a mocked state, a passing suite, a reader's answers and a challenger's verdict stand in for the outcome's own evidence, and count only while they move with it. When one doesn't, the work goes back to the outcome's evidence.
- **A move earns its place by what it could still reveal or change about the outcome,** weighed against the time it costs the people waiting. An unlikely, cheap failure is an accepted risk with its numbers. A wrong fact people act on, or wrong data or state, once shown reachable through the product's real paths (its users, providers and jobs), however rare, is never an accepted risk: a path that writes such a fact is made to stop safely (stuck, visible, correctable by an operator).
- **Find it before building, not after.** Every cycle after the build repeats review, verification and delivery; a defect found at Discover or Design costs minutes. Review, verification and the reader should find only what the build introduced.
- **One delivery, unless users are failing now.** Each delivery repeats the whole cycle, so the ticket's work ships as one. It splits only when people are failing now and a part ends that sooner: that part ships first, proven and leaving nothing wrong reachable, and the rest follows as the next delivery.

## The Surface

A change shows or writes facts people act on: an amount, an appointment time, a slot's availability, a status, a balance, who may do what. Each must equal its record (the stored state, a provider's, or the rule that derives it from them) in every reachable state. The Surface lists, one line each, every such fact the change shows or writes: its kind, where it is met, and the record it must equal. The project definition names its kinds and their oracles. It is drafted when the ticket is taken (`STATE.md`), possibly empty, and finalised in the plan; a draft line the plan drops is marked "not touched" with its source, and the challenger judges that claim like any other. Each line has a check in `CHECKS.json` whose `expect` would fail on the wrong state, comparing what is shown or written with the record read apart from the code that shows it: the oracle for its kind where the project has one (run from the project definition's folder, never from the branch under test), otherwise a read-only query or a walk. The Surface is what the person approves on a high-risk ticket, what review and verification prove, and what the cold audit compares after delivery. Approval is asked again only when a line is added or removed, turns touched or not touched, or changes its kind or the record it must equal; `plan-shape` prints the hash of those and `links` compares it. Nothing on the Surface, and nothing the outcome names, is ever dropped, cut or delivered as a stated limit.

## How the work is trusted

- **Agents judge meaning; scripts count, match and compare.** No script decides what the work is. The six in the skill folder's `scripts/` (`plan-shape`, `rounds`, `proof`, `checks`, `links`, `record`) run as `node <skill folder>/scripts/<name>.mjs` and read the ticket's files through one shared reader, `ticket.mjs`, so a field a later script reads is the one `plan-shape` checked at design time; each writes at most one result file in `evidence/`, exits 0 or 1, and says at its top what it compares. A `checks` run is its ticket's alone: `evidence/checks.run` names it and `checks <folder> --stop` ends it, or clears what a killed run left; wait or stop by that, never by matching process names.
- **Agents check agents.** A fresh agent checks the work against raw sources: code, git, logs, data, the running app; confidence never comes from the author's own account. A challenger or reviewer answers each rubric item yes or no with the evidence that decided it; an item without evidence is no. It runs on a different model or effort than the author where the harness allows.
- **Grounded.** Every claim names its source: `file:line` at a named commit, a read-only query and its result, a log line, a screenshot, the ticket, or an external source opened, with its date and the words that establish the point. A source counts only for what it establishes; an agent's file counts only for the raw facts it quotes, never for its own proposal. A choice no source establishes is a question for the decision judge, never built on. Whoever passes a claim on keeps its basis: found (with its source) or proposed (by whom).
- **Findings are claims too.** Whoever receives one checks it first and disputes a false one with evidence; the next challenger or reviewer settles it. A finding names the state or path where something fails; taste and "could be better" are not findings.
- **Prove by running.** A question the design hinges on is settled by running something. Whoever writes a test runs it, through `proof`. Whatever the project's environments can produce (a state, an account, data, a running app) is produced and checked, never reported as unchecked; only what can't be produced there, such as a real third party, real money or elapsed time, is reported, first, as work not done, with why.
- **Proof belongs to a tree.** Proof lines, check results and reviews are compared by the tree they ran on: a commit with an identical tree is the same proof, and nothing proven on a tree is proven again. A red stays paired with the green that ran its words. When the tree changes, only what the change touches is proven again.
- **One writer per file.** Only the planner writes `PLAN.md` and `CHECKS.json`, and runs `plan-shape` after each change; anyone else sends the planner the item. Only the orchestrator writes `STATE.md`.
- **Meaning first.** What a person sees exists so they understand and can act; the plugin's `design` skill holds how.
- **Files, not memory.** The ticket folder is the state.

## Decisions

A product decision is one whose answer changes what the users or the business get and that the code, the design system and the project's rules don't settle. A fresh decision judge (`roles/decide.md`) answers every such question, whoever raises it, so nobody waits on the person: by established industry practice (vendors' own documentation, standards, regulators and law, published research on how people use products), the users' experience, and safety; on money, tax, law, access and data, established practice wins over convenience. Where sources disagree or none exists, it picks the option easiest to reverse and marks it so. The planner records each answer as a decision with its sources, quoted, and the alternatives it beats. The handoff lists every decision for the person to overrule; an overrule is that ticket's next delivery.

The one approval left is a high-risk change, whose effect the project's way of undoing a delivery can't reverse (data lost or rewritten, a write outside the project, access widened). The orchestrator asks it as one plain message with the outcome and the Surface, and records the answer with the revision and the Surface hash in `STATE.md`; it blocks only the irreversible delivery step, never design, build, review or verification. The orchestrator never uses a blocking question dialog while any step can proceed.

## Scope

The outcome as its users meet it, whatever they can't get it without, and whatever the change causes or breaks are the ticket's, fixed in it at their root. So are defects already present on the ticket's ground (what the change touches and what users meet on the way to the outcome): Discover finds them and the design folds them in. One found later is fixed in the round that found it, and counted in `evidence/missed.md` as a Discover miss. Everything beyond the ground is extra, recorded under "Outside the ticket" in `STATE.md`. An extra is a finding like any other: it names the state that triggers it and shows it by running it; one that can't be shown in the project's environments is a lead in the handoff with what would show it.

- **A Surface extra,** a wrong fact people act on, shown reachable by users now, opens a hotfix ticket at once and the person is told; it starts after the current delivery unless they say now.
- **A change to an oracle** is the ticket's when its outcome needs it; any other is its own ticket.
- **Every other extra** goes to the decision judge (fix now, after, or file it) and into the handoff in plain words.

The project's `AGENTS.md` files and the person's own instructions add to this method; where they ask for more, they win. They never remove a step: authority to deliver doesn't approve a high-risk change. Only the person, of their own accord, can waive a step, for the ticket they name; never ask them to.

## Size

The type is hotfix, bug, enhancement or new feature, as the person names it, the project definition says, or inferred and recorded so. The size sets how deep each step goes; the orchestrator records it in `STATE.md`, and nothing else in the method varies by type.

| Size | Discover | Design | Challenge |
|---|---|---|---|
| Hotfix (people failing in production now) | the failure and its blast radius | the guard that gets them working, then the root fix; no diagrams | one pass |
| Small: a bug or small enhancement | the touched screens and flows | short; a state diagram only where there are states | until no objection that changes the outcome |
| New feature | the area's whole current state | full design and its documents | iterated |
| Big change: new data, migrations or many consumers | the whole area, its data and migrations | full, with the way back | iterated, with a second independent challenger |

Whatever the size, the one who checks is never the one who wrote, every design is challenged, and every change is reviewed and verified. A small ticket's discovery and design may be one worker; a backend change has no reader.

## The steps

1. **Take.** Choose the delivery target as the project definition says (a hotfix's is the one production is built from). Create `<work>/<ticket>/` from the templates and a worktree per repo the ticket needs, each from its freshly fetched base and set up by a worker; a repo found later gets its worktree then. If the work folder lies inside a repo, its `.git/info/exclude` lists it. Move the ticket to `started`. Fill `STATE.md`: the outcome, type, size, the worktrees (paths from the ticket folder, or absolute) and a first draft of the Surface. Tell the person in one line the outcome, size and the moves you expect.

2. **Discover** (`roles/discover.md`). Fresh agents, one angle each, review the current state of everything the change touches: what exists, what is already broken there, every impact (consumers, data, flows, events, contracts, inside the worktrees or beyond), and for a bug or hotfix a reproduction where the failure happens. One angle is always the ground as it is today, read with the rubric review and the reader apply at the end. Each finding is shown by running something; each writes `evidence/discover-<angle>.md`. One pass per angle; what isn't settled is listed open.

3. **Design** (`roles/plan.md`). The planner designs the solution from the outcome and the current state, not from the ticket text alone, and writes it as `PLAN.md` and `CHECKS.json` in the templates' form: for what people see, the purpose first, by the plugin's `design` skill; for the backend, contracts, data and migrations with their way back, state machines, sequences, idempotency and failure paths; documents the complexity calls for in `design/`; the Surface with a check per line; the tests table, which is the acceptance tests; one delivery unless users are failing now. Before the challenge, the planner runs each check once on the base and sees each "fails before: yes" test fail there, so a check or row that could never work is found now. Product questions go to the decision judge; the planner folds its answers. `plan-shape` passes before a challenge starts.

4. **Challenge** (`roles/challenge.md`). A fresh challenger attacks the design at its revision and writes `evidence/challenge-<k>.md`: `build`, or the objections, each naming the concrete state or path where the design fails. The planner answers each objection with a new revision, or disputes it with evidence, and a fresh challenger reads the new revision; a dispute between them goes to the decision judge, which rules with sources. The design is ready when every challenger of its revision returns `build`: when none can name a failing state. An implementer's `plan wrong` reopens this step.

5. **Build** (`roles/implement.md`). Fresh implementers take the plan as their brief, lanes for independent items in their own worktrees; the last lane's implementer merges them in order. Each acceptance test runs red on the base, then green on HEAD with the same words, through `proof`; the commands the definition says every change runs, run too. A fact that changes the design goes to the planner; one that changes a Surface line or the risk is a new revision and challenge. Done is `done at <sha>`.

6. **Read** (screens only, `roles/read.md`). One fresh reader per delivery, on the built screenshots alone, answers the purpose's questions for each pictured state; the orchestrator runs `rounds` for it. Its "no"s go to review.

7. **Review** (`roles/review.md`). A fresh reviewer reads the whole change against the review rubric; round 2 reads the fixes; a narrow round 3 reads the fixes of round 2's findings and any diff after review that `links` reports. After round 3 an open finding holds the delivery, and the handoff says so. A defect already there before the change is fixed in the round that found it and recorded as a Discover miss.

8. **Verify** (`roles/verify.md`) on the final tree, in the target environment, alongside review: each check as written, `checks` for the runnable ones, the walks through the product's real paths, screenshots of the named states. A check that fails is this ticket's to fix, as a diff after review.

9. **Release** (`roles/deliver.md`). `links` first: a broken link names the worker to start. A fresh delivery worker brings the branch up to date where needed, takes each irreversible step once `links` holds at that tree and the high-risk approval, where needed, is recorded, confirms each from its output, and looks for the outcome where it lives. The handoff opens with the outcome and its evidence, then the approval asked, the decisions to overrule, the `links` table, the screenshots and the extras. A delivery that can only wait for an outside party or elapsed time becomes a follow-up ticket carrying its plan and branch, listed first as work not done, and the ticket moves to its delivered status.

10. **Cold audit** (`roles/audit.md`), right after each delivery: a fresh agent compares every Surface fact with its record through the oracle for its kind; a confirmed wrong fact opens a hotfix as Scope says. Then, after the last delivery, the auditor records and cleans: `evidence/missed.md`, `record`, and removing what the ticket left, the ticket folder last.

Rounds per delivery: one reader, two reviews and the narrow third, counted by `rounds` from the file names; an overrun is reported in the `links` table, the handoff and the record. Challenges are not counted: they end when no failing state is left.

## Several tickets

Each ticket is independent and is delivered when it is ready; a pause for one never pauses another. A heavy test run starts when there is room for it by measured memory, as the project definition says; otherwise it waits, never skipped. The most urgent outcome goes first.

## Learning

The records, their `missed` lists, the cold audits and the reopened tickets show where the method fails. A kind of miss that repeats points at the method: find what let the work drift from the outcome and change that, rather than adding a clause for the case. Learning is its own piece of work, never done inside a ticket or in the installed copy.

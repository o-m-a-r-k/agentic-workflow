# The way of working

The goal: a ticket goes in, and it comes out delivered, with no bugs, no missed edge cases and no impact nobody saw coming. The person sees the plan. They are asked only to approve high-risk plans and to make product decisions.

These ideas carry everything below.

- **Agents check agents.** Confidence comes from a fresh agent checking the work against raw sources: code, git, logs, data, the running app, and for a screen, how it looks beside the screens around it, judged strictly and live; a check that saw only a screenshot or the code says so. It never comes from the author's own account of the work.
- **Grounded.** Every claim names its source: `file:line`, a read-only query and its result, a log line, a screenshot, the ticket, or an authoritative external source with its date. A design choice names the constraints it meets and the alternatives it beats. A claim without a source goes back to investigation, never forward.
- **Findings are claims too.** Whoever receives a finding checks it before acting on it. A false finding is disputed with evidence, and the next reviewer settles the dispute. Reviewers raise only gaps that affect correctness or the ticket's requirements.
- **Weigh before acting.** Every gap, finding or failure is weighed by how likely it is at the project's real volumes and what it would cost if it happened. Work goes to what is realistically likely to hurt someone. An unlikely, cheap one is written into the plan as an accepted risk, with its numbers, and not designed around. The aim is a ticket delivered right and fast; depth that doesn't change the outcome is waste. The same holds for the work itself: a step, an agent or a check earns its place by what it could still reveal about this change that the work so far hasn't proven, so the proof a change needs follows from what it alters and how far that reaches, never from a habit of running everything.
- **Prove early.** The assumption a design hinges on is settled by running something before anything is built on it: a query, a throwaway spike in the worktree, the screen in a browser. A paper design checked by agents is slower and less certain than the same question put to the running system. Whoever writes a test runs it.
- **Proof belongs to a version.** Each proof names what it proved: grounding and approval name the plan revision, tests and review name the commit, verification names the build. When what was proven changes (a new revision, a different tree, a new build), the proof that rested on it no longer counts, and a fresh agent does it again for what changed.
- **Files, not memory.** The ticket folder is the state. Every cycle starts by reading it again, and where the files and anyone's recollection disagree, the files win.

## Scope

The ticket's goal sets the scope: the bug, the feature, and the code the change depends on. A gap inside that scope that could realistically hurt is fixed in the ticket, whatever its size. A regression the change caused is always part of the work. A defect in shared code is fixed at its root, for everything that uses it. Anything else that turns up and would matter to a user or the product is listed by whoever found it and filed once as a separate ticket, per the project definition, without asking the person. Smaller observations go in the handoff.

The project's `AGENTS.md` files and the person's own instructions add to this method. Where they ask for more, such as a confirmation before a push or an extra check, they win.

## Ticket types and size

Type and size together set which steps a ticket gets and how deep. Size is judgement: how much the change touches, whether a contract or data changes, how open its design is. Size sets the shape of the work, not only its depth. Every agent that starts fresh pays to read the same code again, so a small ticket uses few of them: one investigates and writes a plan of about a page in the same breath, and one fresh agent grounds and challenges it in a single pass. A larger ticket gets its lanes and separate roles. Whatever the size, the one who checks is never the one who wrote, every plan is grounded, and every change is reviewed and verified.

- **Hotfix:** urgent, in production. Narrow and fast, but proven.
- **Bug:** in production, not urgent.
- **Enhancement:** changes behaviour that already exists.
- **New feature:** simple or complex. A complex one needs architecture, design, several angles and its edge cases worked out.

The person names the type in the session, unless the project definition says where else it comes from. If nobody named it, infer it from the ticket.

## The steps

1. **Take the ticket.** Choose its delivery target as the project definition says; a hotfix's is the one production is built from. Create the ticket folder `<work>/<ticket>/` from the templates, and inside it a worktree per repo the ticket needs, each branched from that repo's freshly fetched base for the target (the definition's `repos`) and set up as the definition says. If the work folder lies inside a repo, make sure that repo's `.git/info/exclude` lists it. Move the ticket to its `started` status. Then tell the person in one line its type, size, steps and depth, so they can override. Lay out its lanes before work starts: what runs together, what each writes, and where they merge, so investigation, grounding and challenge feed one merge instead of revision after revision.

2. **Understand, and prove the approach.** Send investigators in parallel, one angle each.
   - *Bug:* reproduce it where it happens, as far as reading allows: logs, read-only data, the screen as its user sees it. Anything that would write there is reproduced locally instead. Find the root cause from logs, data rows and the code path.
   - *Hotfix:* as for a bug, and always reproduce it locally with simulated data shaped like production: read the shape read-only and never copy production data. That reproduction becomes the failing test the plan names.
   - *Enhancement:* the current behaviour, with sources; every consumer (other screens, APIs, reports, exports, integrations); the existing data that must keep working; the ticket's open questions.
   - *New feature:* the system it plugs into (architecture, conventions, data model, permissions and tenancy, design system, real data volumes); the domain, from authoritative sources; prior art (competitors, industry practice, libraries).

   Whatever the ticket, find the reach of what the change alters: what uses it, through code, shared data, events or contracts, and what elsewhere does the same job and must stay consistent with it, because the same cause or the same change applies there too. Search as far as an inconsistency would realistically show or hurt. Each part of that reach the change touches is proven still working: by its own tests, which the build runs, or, where none covers the affected path, by a test or check the plan adds.

   Investigation ends when the questions the design hinges on are answered, by running something wherever reading can't settle them.

3. **Plan.** Write `PLAN.md` and `CHECKS.json` from what was established. The plan holds the decisions with their evidence and the alternatives they beat, a test for each behaviour and edge case, the verification steps for the target environment, the accepted risks and what is out of scope. It is as long as its decisions need and no longer; it doesn't repeat the investigation. A product question, including a new look nothing settles, becomes a decision memo for the person: the options, shown where they can be seen, the market and competitors, the industry standard, and a recommendation with its reasons. Every change to the plan raises its revision.

4. **Ground and challenge,** at the same time, on the same revision. A fresh grounder checks each claim against its source, the memos included, by running something wherever it can: open the file at that line, run the query and compare the count. A fresh challenger assumes the plan was carried out and failed, and explains why. The planner folds both in as a new revision. Each revision's changed claims are grounded again; the challenge is asked again only if the design changed. A claim that fails for lack of facts sends the plan back to step 2.

5. **Judge risk.** How much harm could this change do if it were wrong? The planner and the grounder each judge it from the evidence: reach (callers, data, users), reversibility (can it be undone: migrations, external writes and data changes often can't, while a deploy that a redeploy undoes can) and remaining uncertainty. The result is a level, with reasons and their evidence. If the two disagree, the higher level stands.
   - **Low:** work goes on. The person can read the plan at any time.
   - **High:** pause for the person's approval, asking once: show the plan and any grounded decision memos as a visual page, with whatever the harness offers for that, and link the plan file, which stays the source. They may have another agent review it first. Record their words, the time and the revision they approved in `PROGRESS.md`. A later revision that changes the design, the scope or the risk needs their approval again.

6. **Build.** A fresh implementer takes the plan as its brief. Independent work items run in parallel, each in its own worktree branched from the ticket's branch and merged back in order. Items that share files run one after another. The implementer runs every test it writes or changes, the heavy ones included, and the project's fast suite, before it calls the work done. A new fact goes into the plan with its evidence. If it raises the risk to high, the plan goes back to the person. If the plan turns out wrong at its root, return to planning instead of patching around it.

7. **Review.** Every change gets one, however small. A fresh reviewer reads the whole change against the plan: is every planned edge case handled and tested, does it keep the project's rules and design language, and is anything outside the scope? If the reviewer judges the change needs more confidence, it says what, in its own words. That might be a second look from a named angle, a test that fails before the change, or the person reading the diff. Each request is met by doing it. A later full review may lift a request, with its reason.

8. **Verify** in the target environment, as the project defines it, once, on the commit to be delivered: the real flow in a browser, data checks, screenshots where screens are affected, and the checks from the project's proofs that cover what the change alters and its reach. A check in `CHECKS.json` flips to passing only after it has been verified for real, with its evidence. A check whose environment only a delivery step reaches, such as a deploy, is verified right after that step.

9. **Deliver** to the ticket's target, as the project defines it, ending with the ticket at the target's `delivered` status. If the base has moved, first bring the branch up to date the way the project delivers. Before each irreversible step (merge, deploy, ticket move), a fresh delivery agent checks from raw sources that every proof belongs to what it would deliver: grounding, tests, review, the person's approval if the risk is high, and the verification due before this step. Then it takes the step and confirms it from its output. A delivery step whose check then fails is rolled back as the plan says, and goes to the person. The handoff (a tracker comment or a document) and the report to the person carry the same thing: what changed, in plain words; its impact, meaning what it reaches and how that was proven to keep working; every screenshot; the tickets filed along the way, with links; the risks accepted; and where it now lives (merge commits, tracker link).

10. **Clean up**, once delivered, leaving the project as it was apart from the delivery: its canonical checkouts on the delivered commit. Remove the worktrees, the branches once merged, whatever `PROGRESS.md` lists as running, and the ticket folder, confirming each from its output. Then append one line to `~/.agents/records.jsonl`.

## When work stalls

A round that leaves the same gap open as the round before it is not progress. Pause for the person with the evidence and the options. Don't loop, and don't guess.

## Several tickets

Each ticket is independent and is delivered when it is ready. Nothing waits for a shared gate, and a pause for one ticket never pauses another. Run at most `heavy_runs` heavy test runs at a time (from the user settings, 1 if unset), so the machine stays usable. The project definition says which runs are heavy. A hotfix goes first.

## Learning

The records, the handoffs and the reopened tickets show where the method fails. Learning is its own piece of work, never done inside a ticket or in the installed copy: a change to this method's repository, or to the project's definition or `AGENTS.md`. Fix the wording; never add a rule to the workflow.

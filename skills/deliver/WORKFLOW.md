# The way of working

The goal: a ticket goes in, and it comes out delivered, with no bugs, no missed edge cases and no impact nobody saw coming. The person sees the plan. They are asked only to approve high-risk plans and to make product decisions.

Four ideas carry everything below.

- **Agents check agents.** Confidence comes from a fresh agent checking the work against raw sources: code, git, logs, data, the running app. It never comes from the author's own account of the work.
- **Grounded.** Every claim names its source: `file:line`, a read-only query and its result, a log line, a screenshot, the ticket, or an authoritative external source with its date. A design choice names the constraints it meets and the alternatives it beats. A claim without a source goes back to investigation, never forward.
- **Findings are claims too.** Whoever receives a finding checks it before acting on it. A false finding is disputed with evidence, and the next reviewer settles the dispute. Reviewers raise only gaps that affect correctness or the ticket's requirements.
- **Files, not memory.** The ticket folder is the state. Every cycle starts by reading it again, and where the files and anyone's recollection disagree, the files win.

## Scope

The ticket's goal sets the scope: the bug, the feature, and the code the change depends on. A gap inside that scope is fixed in the ticket, whatever its size. A regression the change caused is always part of the work. Anything else that turns up is filed as a separate ticket, per the project definition, without asking the person, and noted in `PROGRESS.md`.

## Ticket types and effort

The steps are the same for every ticket. What changes is depth: how many angles are investigated, how hard the plan is challenged, how much is verified.

- **Hotfix:** urgent, in production. Narrow and fast, but proven.
- **Bug:** in production, not urgent.
- **Enhancement:** changes behaviour that already exists.
- **New feature:** simple or complex. A complex one needs architecture, design, several angles and its edge cases worked out.

The person names the type in the session, unless the project definition says where else it comes from. If nobody named it, infer it from the ticket and say which type you took, so the person can correct it.

## The steps

1. **Take the ticket.** Create the ticket folder `<project root>/.work/<ticket>/` from the templates, and a worktree per repo the ticket touches inside it, branched from a freshly fetched base. Make sure each repo's `.git/info/exclude` lists `.work/`. Move the ticket to its started status, as the project definition says.

2. **Understand.** Send several investigators in parallel, one angle each.
   - *Bug:* reproduce it where it happens. Find the root cause from logs, data rows (read-only) and the code path. Then find every other place the same cause can strike.
   - *Hotfix:* as for a bug. Then reproduce it locally with simulated data shaped like production: read the shape read-only and never copy production data. Prove the fix locally.
   - *Enhancement:* the current behaviour, with sources; every consumer (other screens, APIs, reports, exports, integrations); the existing data that must keep working; the ticket's open questions.
   - *New feature:* the system it plugs into (architecture, conventions, data model, permissions and tenancy, design system, real data volumes); the domain, from authoritative sources; prior art (competitors, industry practice, libraries).

3. **Plan.** Write `PLAN.md` and `CHECKS.json` from the investigation. The plan cites every claim, names a test for each behaviour and edge case, gives the verification steps for the target environment, and states what is out of scope. A product question becomes a decision memo for the person: the options, the market and competitors, the industry standard, and a recommendation with its reasons.

4. **Ground the plan.** A fresh agent checks each claim against its source. Where it can, it checks by running something: open the file at that line, run the query and compare the count. It uses judgement only where no check reaches. A claim that fails sends the plan back to step 2 or 3.

5. **Challenge the plan.** A fresh agent assumes the plan was carried out and failed, and explains why. Its answers go into the plan.

6. **Judge risk.** How much harm could this change do if it were wrong? The planner and the grounder each judge it from the evidence: reach (callers, data, users), reversibility (migrations, external writes, deploys) and remaining uncertainty. The result is a level, with reasons and their evidence. If the two disagree, the higher level stands.
   - **Low:** work goes on. The person can read the plan at any time.
   - **High:** pause for the person's approval and link the plan file. They may have another agent review it first. Record their answer, word for word, in `PROGRESS.md`.

7. **Build.** A fresh implementer takes the plan as its brief. Independent work items run in parallel. Items that share files run one after another. The implementer runs the tests the plan names and the project's fast suite. New facts go into the plan with their evidence. If they raise the risk to high, the plan goes back to the person. If the plan turns out wrong at its root, return to planning instead of patching around it.

8. **Review.** Every change gets one, however small. A fresh reviewer reads the whole change against the plan: is every planned edge case handled and tested, and is anything outside the scope? If the reviewer judges the change needs more confidence, it says what, in its own words. That might be a second look from a named angle, a test that fails before the change, or the person reading the diff. Each request is met by doing it. A later full review may lift a request, with its reason.

9. **Verify** in the target environment, as the project defines it: the real flow in a browser, data checks, screenshots where screens are affected, and the full suite where the project runs it locally. A check in `CHECKS.json` flips to passing only after it has been verified for real, with its evidence.

10. **Deliver**, as the project defines it. Before anything irreversible (merge, deploy, ticket move), a fresh delivery agent checks the whole chain from raw sources:
    - the plan was grounded;
    - the tests passed on this exact commit;
    - the review read this exact commit;
    - the person approved, if the risk was high;
    - the verification evidence is real.

    Then it merges, deploys and moves the ticket. The handoff (a tracker comment or a document) carries the summary and the evidence: screenshots, data checks, tests.

11. **Clean up.** Remove the worktrees and the ticket folder. Delete the local branch, and the remote one if it was pushed. Stop and remove whatever the ticket started: containers, databases, servers. Confirm each step from its output. Then append one line to `~/.agents/records.jsonl`.

## When work stalls

A round that leaves the same gap open as the round before it is not progress. Pause for the person with the evidence and the options. Don't loop, and don't guess.

## Several tickets

Each ticket is independent and is delivered when it is ready. Nothing waits for a shared gate. Run at most `heavy_runs` heavy test runs at a time (from the user settings, 1 if unset), so the machine stays usable.

## Learning

The records, the reviews and the reopened tickets show where the method fails. Fix the wording of this method, or the project's knowledge in its definition or its `AGENTS.md`. Never add a rule to the workflow.

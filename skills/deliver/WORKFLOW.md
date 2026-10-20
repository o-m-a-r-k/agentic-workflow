# The way of working

The goal: a ticket goes in, and it comes out delivered, with no bugs, no missed edge cases and no impact nobody saw coming. The person sees the plan. They are asked only to approve high-risk plans and to make product decisions.

Seven ideas carry everything below.

- **Agents check agents.** Confidence comes from a fresh agent checking the work against raw sources: code, git, logs, data, the running app. It never comes from the author's own account of the work.
- **Grounded.** Every claim names its source: `file:line`, a read-only query and its result, a log line, a screenshot, the ticket, or an authoritative external source with its date. A design choice names the constraints it meets and the alternatives it beats. A claim without a source goes back to investigation, never forward.
- **Findings are claims too.** Whoever receives a finding checks it before acting on it. A false finding is disputed with evidence, and the next reviewer settles the dispute. Reviewers raise only gaps that affect correctness or the ticket's requirements.
- **Weigh before acting.** Every gap, finding or failure is weighed by how likely it is at the project's real volumes and what it would cost if it happened. Work goes to what is realistically likely to hurt someone. An unlikely, cheap one is written into the plan as an accepted risk, with its numbers, and not designed around. The aim is a ticket delivered right and fast; depth that doesn't change the outcome is waste.
- **Prove early.** The assumption a design hinges on is settled by running something before anything is built on it: a query, a throwaway spike in the worktree, the screen in a browser. A paper design checked by agents is slower and less certain than the same question put to the running system. The same holds for the build: whoever writes a test runs it.
- **Proof belongs to a version.** Each proof names what it proved: grounding and approval name the plan revision, tests and review name the commit, verification names the build it ran against. When that version moves, the proof that rested on it no longer counts, and a fresh agent does it again for what changed. Versions move when the plan is revised, when the branch is brought up to date with a moved base, when the platform makes its own merge commit, and when a new build is deployed.
- **Files, not memory.** The ticket folder is the state. Every cycle starts by reading it again, and where the files and anyone's recollection disagree, the files win.

## Scope

The ticket's goal sets the scope: the bug, the feature, and the code the change depends on. A gap inside that scope that could realistically hurt is fixed in the ticket, whatever its size. A regression the change caused is always part of the work. A defect found in shared code is fixed where it lives, for everything that uses it, not worked around at one caller. Anything else that turns up and would matter to a user or the product is listed by whoever found it and filed once as a separate ticket, per the project definition, without asking the person. Smaller observations go in the handoff.

The project's `AGENTS.md` files and the person's own instructions add to this method. Where they ask for more, such as a confirmation before a push or an extra check, they win.

## Ticket types and effort

The steps are the same for every ticket. What changes is depth: how many angles are investigated, how hard the plan is challenged, how much is verified.

- **Hotfix:** urgent, in production. Narrow and fast, but proven.
- **Bug:** in production, not urgent.
- **Enhancement:** changes behaviour that already exists.
- **New feature:** simple or complex. A complex one needs architecture, design, several angles and its edge cases worked out.

The person names the type in the session, unless the project definition says where else it comes from. If nobody named it, infer it from the ticket and say which type you took, so the person can correct it.

## The steps

1. **Take the ticket.** Choose its delivery target as the project definition says; a hotfix's is the one production is built from. Create the ticket folder `<work>/<ticket>/` from the templates, and inside it a worktree per repo the ticket touches, plus any its tooling needs beside them, each branched from that repo's freshly fetched base for the target (the definition's `repos`). If the work folder lies inside a repo, make sure that repo's `.git/info/exclude` lists it. Move the ticket to its `started` status.

2. **Understand, and prove the approach.** Send several investigators in parallel, one angle each.
   - *Bug:* reproduce it where it happens, as far as reading allows: logs, read-only data, the screen as its user sees it. Anything that would write there is reproduced locally instead. Find the root cause from logs, data rows and the code path. Then find every other place the same cause can strike.
   - *Hotfix:* as for a bug, and always reproduce it locally with simulated data shaped like production: read the shape read-only and never copy production data. That reproduction becomes the failing test the plan names.
   - *Enhancement:* the current behaviour, with sources; every consumer (other screens, APIs, reports, exports, integrations); the existing data that must keep working; the ticket's open questions.
   - *New feature:* the system it plugs into (architecture, conventions, data model, permissions and tenancy, design system, real data volumes); the domain, from authoritative sources; prior art (competitors, industry practice, libraries).

   Investigation ends when the questions the design hinges on are answered, by running something wherever reading can't settle them. A change people will see starts from screenshots of the screen as it is today.

3. **Plan.** Write `PLAN.md` and `CHECKS.json` from what was established. The plan holds the decisions with their evidence and the alternatives they beat, a test for each behaviour and edge case, the verification steps for the target environment, the accepted risks and what is out of scope. It is as long as its decisions need and no longer; it doesn't repeat the investigation. A product question becomes a decision memo for the person: the options, the market and competitors, the industry standard, and a recommendation with its reasons. A visible pattern the ticket and the project's design don't already settle is a product question too, and its memo shows each option rendered. Every change to the plan raises its revision.

4. **Ground and challenge,** at the same time, on the same revision. A fresh grounder checks each claim against its source, the memos included, by running something wherever it can: open the file at that line, run the query and compare the count. A fresh challenger assumes the plan was carried out and failed, and explains why. The planner folds both in as a new revision. Every revision has the claims it changed grounded again before anything that rests on them is delivered; that check is narrow and quick. The challenge is asked again only if the design changed in answer to it. A claim that fails for lack of facts sends the plan back to step 2.

5. **Judge risk.** How much harm could this change do if it were wrong? The planner and the grounder each judge it from the evidence: reach (callers, data, users), reversibility (can it be undone: migrations, external writes and data changes often can't, while a deploy that a redeploy undoes can) and remaining uncertainty. The result is a level, with reasons and their evidence. If the two disagree, the higher level stands.
   - **Low:** work goes on. The person can read the plan at any time.
   - **High:** pause for the person's approval and link the plan file, with any grounded decision memos, so the person is asked once. They may have another agent review it first. Record their words, the time and the revision they approved in `PROGRESS.md`. A later revision that changes the design, the scope or the risk needs their approval again.

6. **Build.** A fresh implementer takes the plan as its brief. Independent work items run in parallel, each in its own worktree branched from the ticket's branch and merged back in order. Items that share files run one after another. The implementer runs every test it writes or changes, the heavy ones included, and the project's fast suite, before it calls the work done. For a change people will see, it captures the result at the widths and themes that matter and looks at it beside the screens around it. A new fact goes into the plan with its evidence. If it raises the risk to high, the plan goes back to the person. If the plan turns out wrong at its root, return to planning instead of patching around it.

7. **Review.** Every change gets one, however small. A fresh reviewer reads the whole change against the plan: is every planned edge case handled and tested, does it keep the project's rules, and is anything outside the scope? A change people will see is also judged as design, from its screenshots, next to the screens around it and the project's design language: what looks wrong is raised, not only what is broken. If the reviewer judges the change needs more confidence, it says what, in its own words. That might be a second look from a named angle, a test that fails before the change, or the person reading the diff. Each request is met by doing it. A later full review may lift a request, with its reason.

8. **Verify** in the target environment, as the project defines it, once, on the commit to be delivered: the real flow in a browser, data checks, screenshots where screens are affected, and the suite the project names for this kind of change. A check in `CHECKS.json` flips to passing only after it has been verified for real, with its evidence. A check whose environment only a delivery step reaches, such as a deploy, is verified right after that step.

9. **Deliver** to the ticket's target, as the project defines it, ending with the ticket at the target's `delivered` status. If the base has moved, first bring the branch up to date the way the project delivers; the new commit is proven again, its review covering what the update changed. Before each irreversible step (merge, deploy, ticket move), a fresh delivery agent checks the chain behind it from raw sources:
    - the plan's current revision, and every claim each revision changed, was grounded;
    - the tests passed on this exact commit;
    - the review read this exact commit;
    - if the risk is high, the person approved it, and no later revision changed the design, the scope or the risk;
    - the verification evidence is real, for every check due before this step.

    Then it takes the step and confirms it from its output. A merge commit the platform makes counts as tested only if its tree is the tested tree. A delivery step whose check then fails is rolled back as the plan says, and goes to the person. The handoff (a tracker comment or a document) carries the summary and the evidence: screenshots, data checks, tests.

10. **Clean up**, once delivered. Leave the project's canonical checkouts on the delivered commit. Remove the worktrees and the ticket folder. Delete the local branch, and the remote one once what it carried is merged. Stop and remove whatever the ticket started, as `PROGRESS.md` lists it. Confirm each step from its output. Then append one line to `~/.agents/records.jsonl`.

## When work stalls

A round that leaves the same gap open as the round before it is not progress. Pause for the person with the evidence and the options. Don't loop, and don't guess.

## Several tickets

Each ticket is independent and is delivered when it is ready. Nothing waits for a shared gate, and a pause for one ticket never pauses another. Run at most `heavy_runs` heavy test runs at a time (from the user settings, 1 if unset), so the machine stays usable. The project definition says which runs are heavy. A hotfix goes first.

## Learning

The records, the handoffs and the reopened tickets show where the method fails. Learning is its own piece of work, never done inside a ticket or in the installed copy: a change to this method's repository, or to the project's definition or `AGENTS.md`. Fix the wording; never add a rule to the workflow.

# The way of working

The goal: a ticket goes in, and the outcome it exists for comes true for its users, right and as soon as it can be done right, with no impact nobody saw coming. Nothing wrong reaches them, money, data and permissions above all. The person sees the plan, and is asked once per ticket, in one message, for the product decisions and, when the risk is high, approval of the outcome and its Surface.

## The outcome

Everything else in this method serves this section.

- **Every ticket is for an outcome:** what is true in its users' world once it is delivered, not the code, the tests or the steps: the failing request now completes for the customer who hit it; the new report gives the totals its readers act on. Write down the outcome, its most direct evidence (the users' own data and logs, read-only; the screen as they meet it; the money the feature produces) and how soon it is needed.
- **The orchestrator owns the distance to it.** The next move is the one that most shortens it, or removes the largest uncertainty about it, for its cost. The steps below are the usual moves in their usual order; the outcome decides how deep each goes, never that the plan judge, review, verification, a high-risk approval or the delivery links are skipped.
- **Direct evidence first; stand-ins only while they track it.** A local reproduction, a mocked state, a passing suite, a reader's answers and a judge's verdict stand in for the outcome's own evidence, and count only while they move with it. When one doesn't, the work goes back to the outcome's evidence; making the stand-in stricter is not progress.
- **A move earns its place by what it could still reveal or change about the outcome,** weighed against the time it costs the people waiting. An unlikely, cheap failure is an accepted risk with its numbers. Wrong money, data, permissions or state, once shown reachable through the product's real paths (its users, providers and jobs), however rare, is never an accepted risk: a rare failure on a path that moves money or sets things up is made to stop safely (stuck, visible, correctable by an operator), and automatic recovery is a decision memo with its cost.
- **Progress is the distance shrinking,** judged against when the outcome is needed. A finding, a revision or a passing run is not progress by itself.
- **The users' part ships first.** The plan names the smallest change that makes the outcome true for the users waiting, proven and leaving nothing wrong reachable, and shows it can be delivered alone or says why not. When the related work beyond it is large, it follows as this ticket's next delivery. A proven users' part is held back only by a regression the change caused or by what it can't be true without.

## The Surface

The Surface lists, one line each, every money figure shown, every write and every permission outcome the change touches: where its users meet it and the stored state or provider record it must equal. It is drafted when the ticket is taken (`STATE.md`), possibly empty, and finalised in the plan; a draft line the plan drops is marked "not touched" with its source, and the plan judge judges that claim like any other. Each line has a check in `CHECKS.json` whose `expect` would fail on the wrong state, with a truth read apart from the code that shows the figure: usually one of the project's oracles (a money oracle comparing the shown figures with the stored state and the provider; a permission matrix of route, role and tenant against the expected outcome), run from the project definition's folder, never from the branch under test. The Surface is what the person approves on a high-risk ticket, what review item 4 and verification prove, and what the cold audit compares after delivery.

Approval is asked again only when a Surface line is added or removed, turns touched or not touched, or changes what it must equal; wording is not a change. `plan-shape` prints the hash of those, the approval records it, and `links` compares them. Nothing on the Surface, and nothing the outcome names, is ever dropped, limited, cut or delivered as a stated limit; no verdict or question form in this method offers that.

## How the work is trusted

- **Agents judge meaning; scripts count, match and compare.** No script decides what the work is. The six in the skill folder's `scripts/` run as `node <skill folder>/scripts/<name>.mjs`; each reads the ticket folder and git, writes one result file in `evidence/`, and exits 0 or 1:
  - `plan-shape`: the plan's fields, citations, decisions, tests rows, Surface and checks are in shape, every `path:line` resolves at the commits it names;
  - `rounds`: how many judge, read and review files each delivery has, and whether one more may start;
  - `proof`: runs a command in a worktree and records its tree, exit and output in `evidence/proof.jsonl`;
  - `checks`: runs the checks whose command starts with an entry of the project's allow-list, never through a shell, and compares their output with `expect`; a run that executed nothing fails; a walk needs an evidence file naming the commit and what was seen;
  - `links`: whether each link between the proof and what would be delivered holds, and which worker a broken one needs;
  - `record`: the ticket's record line, from its files.
- **Agents check agents.** A fresh agent checks the work against raw sources: code, git, logs, data, the running app; confidence never comes from the author's own account. A judge answers each rubric item yes or no with the evidence that decided it; an item without evidence is no. A judge runs once per version of its object, on a different model or effort than the author where the harness allows, and never again on the same version.
- **Grounded.** Every claim names its source: `file:line` at a named commit, a read-only query and its result, a log line, a screenshot, the ticket, or an authoritative external source with its date. A decision names the alternative it beats.
- **Findings are claims too.** Whoever receives one checks it first, and disputes a false one with evidence; the next judge settles it. A finding counts by what it does to the outcome or to what already works; taste is not a finding.
- **Prove by running.** A question the design hinges on is settled by running something. Whoever writes a test runs it, through `proof`. Whatever the project's environments can produce (a state, an account, data, a running app) is produced and checked, never reported as unchecked or a limit; only what can't be produced there, such as a real third party, real money or elapsed time, is reported, first, as work not done, with why.
- **Proof belongs to a version.** The judge and the approval name the plan revision, tests and review the commit and its tree, verification the build. When what was proven changes, the proof that rested on it no longer counts and is done again for what changed. A base update proves again only what it changed in what this change alters or relies on.
- **Meaning first.** What a person sees exists so they understand and can act; the plugin's `design` skill holds how.
- **Files, not memory.** The ticket folder is the state. Where the files and anyone's recollection disagree, the files win.

## Scope

The outcome as its users meet it, whatever they can't get it without and whatever the change caused or broke are the ticket's, fixed in it at their root. Everything else found on the way is extra, recorded under "Outside the ticket" in `STATE.md`:

- **A Surface extra,** wrong money, data or permissions reachable by users now, opens a hotfix ticket at once and the person is told at once; it starts after the current delivery unless they say now, and they can veto it. Where the tracker refuses the ticket, it is written in `STATE.md` and the handoff.
- **Every other extra** goes into the handoff, the Surface's kinds first, each in plain words (what is wrong, who meets it, what fixing it would take) with a recommendation to file it, fix it now or after this delivery.

The project's `AGENTS.md` files and the person's own instructions add to this method; where they ask for more, they win. They never remove a step: authority to deliver doesn't approve a high-risk plan. Only the person, of their own accord in the session, can waive a step, for the ticket they name; never ask them to.

## Ticket types and size

The type is one of four. The person names it in the session, unless the project definition says where it comes from; otherwise infer it and record that it was inferred.

- **Hotfix:** the people hitting a production failure work again, now, and its cause is removed at its root; nothing else is its outcome. Getting them working again is its users' part; where the cause can still reach users it is guarded to fail safe. Removing the cause follows as the next delivery when it takes longer.
- **Bug:** the failing behaviour works again as it did, or as it was meant to, with its cause removed.
- **Enhancement:** behaviour that exists changes as asked, and everything that relies on it keeps working.
- **New feature:** its users can do the new thing, correctly, in every real state.

Every fresh agent pays to read the same code again, so a small ticket uses few: a backend bug or hotfix is investigated and planned by one worker and has no reader, and the worker that delivers it records and cleans: six agents with one review. Whatever the size, the one who checks is never the one who wrote, every plan is judged and every change is reviewed and verified.

## The steps

1. **Take.** Choose the delivery target as the project definition says (a hotfix's is the one production is built from). Create `<work>/<ticket>/` from the templates and inside it a worktree per repo the ticket needs, each from that repo's freshly fetched base and set up as the definition says; if the work folder lies inside a repo, its `.git/info/exclude` lists it. Move the ticket to `started`. Fill `STATE.md`: the outcome, the type, the worktrees and a first draft of the Surface. Tell the person in one line the outcome, type, size and the moves you expect.

2. **Understand.** One to three investigators, one angle each. A bug or hotfix reproduces first: the failure seen where it happens (logs, traces, read-only data, the screen as its user sees it), or a failing test; anything that would write there is reproduced locally with data shaped like production. Walk the users' path, read-only, before planning; ask the person at once for any access that needs. Find the reach: what uses what the change alters, through code, shared data, events or contracts, and what elsewhere does the same job. One pass per angle; what isn't settled is listed open, never sent to a second investigator.

3. **Plan.** `PLAN.md` and `CHECKS.json`, in the templates' form: the decisions, each with its choice, source and the alternative it beats; the tests table, each row saying whether it fails before the change; the Surface finalised, with a runnable check per line; the reach, each part covered by a test or check; the deliveries, the users' part first; any product memos. No narrative: facts that change no decision, and logistics, go in `evidence/log.md`. The planner runs `plan-shape`, fixes what fails once, and what still fails stands in `evidence/plan-shape.md` as unsourced for the judge. A changed decision raises the revision and rewrites the plan in place; there are no per-revision copies.

4. **Judge the plan.** One fresh judge, once per delivery, runs `rounds` first and answers the plan rubric (`roles/judge.md`). Its verdict is `build`, `fix items … once` or `approval needed`. The planner folds the items in place and the build starts; no second judge. The risk is the higher of the planner's and the judge's, low or high.

5. **The person, once.** One message per ticket carries every product memo with its recommendation and, when the risk is high, the outcome and the Surface to approve, as a visual page linking the plan. Record their words, the time, the revision and the Surface hash in `STATE.md`. Ask again only when a Surface line changes.

6. **Build.** Fresh implementers take the plan as their brief, lanes for independent items, each in its own worktree merged back in order. Each tests row is run through `proof`: red on the base tree with only the test applied, where it fails before, and green on HEAD; the commands the project definition says every change runs, run too. A new fact that changes a decision goes into the plan; one that raises the risk or changes a Surface line goes to the person; a plan wrong at its root goes back to planning. Done is `done at <sha>`.

7. **Read** (screens only). One fresh reader per delivery, on the built screenshots (the orchestrator runs `rounds` for it, since it sees nothing else), answers the purpose's five to eight questions for each pictured state: yes or no, where on the screen, from an element or only from a sentence (`roles/read.md`). Its "no"s go to review.

8. **Review.** A fresh judge reads the whole change against the review rubric (`roles/review.md`), running the tests, the oracles and the screen; at most two rounds per delivery, `rounds` first each time, one implementer between them, and round 2 reads the fixes. A finding on a Surface line carries `[S<n>]`. After round 2, anything the outcome names that is still open is fixed by one implementer with a test; an open `[S<n>]` finding's fix then gets a third, narrow review that reads only that fix, so a money fix never ships unjudged. Everything else goes into the handoff as findings, with no question to the person. A commit after the last review stands only if it touches just the files that review's findings name, plus tests, with those rows green on HEAD.

9. **Verify** on the final tree, in the target environment as the project defines it: each check as written, `checks` for the runnable ones, the walks through the product's real paths, screenshots of the named states, and the tests the reach covers (a complete suite only where the reach can't be named, once per delivery). Every check due is true with an evidence file naming HEAD. A check that fails on that commit is this ticket's to fix, unless it fails the same way on the base and the outcome doesn't need it, which is an extra.

10. **Deliver.** `links` first: a broken link stops the delivery and its table names the worker to start. Then a fresh delivery worker brings the branch up to date where the project's way needs it, takes each irreversible step (merge, deploy, ticket move) after `links` holds at that commit, confirms each from its output, has the checks due after a step verified (`checks --after`) before the last one (`links --final`), and looks for the outcome where it lives. The handoff opens with the outcome and the evidence it is now true, pastes the `links` table, carries the screenshots read back from the tracker, and lists the extras.

11. **Cold audit.** Where the Surface draft had any line and the project definition names an oracle, once the last delivery is where its users meet it, one fresh agent compares every figure, action and permission outcome on the Surface with the stored records and the running stack, through the oracles (`roles/audit.md`). A confirmed wrong-money or permission finding opens a hotfix as Scope says.

12. **Record and clean,** after the last delivery and its audit: the delivery worker (the one that delivered, where no audit runs) writes `evidence/missed.md`, runs `record`, and removes the worktrees, merged branches, what `STATE.md` lists as left behind, what the project's way of finding leftovers shows, and last the ticket folder, each confirmed from its output.

Rounds per delivery: one judge, one reader, two reviews and the narrow third, counted by `rounds` from the exact evidence file names (`judge-<n>.md`, `read-<n>.md`, `review-<n>-<round>.md`). A judge past its cap refuses itself; an overrun is reported in the `links` table, the handoff and the record.

## Several tickets

Each ticket is independent and is delivered when it is ready. Nothing waits for a shared gate, and a pause for one ticket never pauses another. A heavy test run starts when there is room for it by measured memory, as the project definition says; otherwise it waits, never skipped. `heavy_runs`, where the settings set it, is an outer limit. The most urgent outcome goes first.

## Learning

The records, their `missed` lists, the cold audits and the reopened tickets show where the method fails. A kind of miss that repeats points at the method: find what let the work drift from the outcome and change that, rather than adding a clause for the case. A seventh script needs a failure class the records show was missed twice. Learning is its own piece of work, never done inside a ticket or in the installed copy.

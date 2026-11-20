# The way of working

The goal: a ticket goes in, and the outcome it exists for comes true for its users, right, and in hours. How deep the work goes is set by what the change can damage, never by the ticket's label. Nothing wrong reaches users on the facts they act on.

## Words

- **Outcome:** what is true in the users' world once the ticket is delivered. Not the code, the tests or the steps.
- **Fact people act on:** an amount, a date or time, a status, a balance, who may do what. Each must equal its record: the stored state, a provider's, or the rule that derives it.
- **Boundary:** a kind of such fact the project names (money, access, dates, stored data, a contract between repositories). The project definition maps each to the code that computes or enforces it.
- **Ground:** the places people or other systems meet that the ticket itself names: its screens, endpoints, messages, files. The orchestrator writes it from the ticket's words when it takes the ticket. Code is never ground, and only the person's own words add to it later.
- **Delivery:** the work from Take, or from a rejection, up to the next `Delivered:` line in `STATE.md`. Fix rounds, the triage judge and the reconsider are counted within one.
- **Oracle:** a project-owned check that compares a shown or written fact with its record, apart from the code under test.

## Lanes

| Lane | When | Who says |
|---|---|---|
| **Direct** | No boundary path touched, and the change restores or adjusts behaviour that already exists | Discover, with its reason |
| **Standard** | No boundary path touched; new behaviour | Discover, with its reason |
| **Critical** | A boundary path or a migration is touched, the change adds a rule that computes, selects or enforces a fact people act on, or changes what such a rule decides, in code the map does not cover, or the effect cannot be undone by the project's way of undoing a delivery | The `lane` script for paths; Discover and every verifier for the other two |

- `lane --paths` runs on the paths Discover expects to touch, before anything is built. `lane` runs again on the real diff before verification. Either can raise the lane; nothing lowers it.
- Discover judges the planned change for such a rule before anything is built; a verifier who finds one in the diff that Discover did not raises the lane. Either names the path for the project's map. Showing a fact through the code that already derives it is not such a rule.
- A rise runs the steps the lower lane skipped, and the build is revised to what they conclude. Built code is evidence for a design, never a constraint on it.

## Steps

| # | Step | Kind | Direct | Standard | Critical |
|---|---|---|---|---|---|
| 1 | Take | the orchestrator, from the definition | ✓ | ✓ | ✓ |
| 2 | Discover | judgement | with Build, where no screen changes | ✓ | ✓ |
| 3 | Shape | judgement, then the person | a new or restructured screen, on any lane | | |
| 4 | Design, challenge, confirm | judgement | | | ✓ |
| 5 | Build | judgement | ✓ | ✓ | ✓ |
| 6 | Gate | the `gate` script, run by the builder | ✓ | ✓ | ✓ with `checks` |
| 7 | Verify | judgement, fresh | ✓ | ✓ | one per boundary touched; one for what made it critical where none is |
| 8 | Read | the project's captures, `words`, a fresh reader | any visible change, on any lane | | |
| 9 | Deliver | the definition's steps; `ready` first | ✓ | ✓ | ✓ |
| 10 | Audit | judgement, fresh | | | where delivery puts the change somewhere Verify did not run |
| 11 | Accept | the person | ✓ | ✓ | ✓ |

1. **Take.** Create the ticket folder with `STATE.md` from its template, and a worktree per repository from its freshly fetched base, as the definition says. Move the ticket to its started status.
2. **Discover** (`roles/discover.md`) writes `BRIEF.md`, one page: the outcome on the ticket's ground, the acceptance checks, for a bug its reproduction and root cause, the paths it expects to touch, the lane, whether the effect can be undone, whether a person will see the change (`Screen:`), and what it found on the way, reported as the `triage` skill says. For a visible change that is not shaped, Discover also writes the question sheet and answer key, limited to the questions the change affects. On the direct lane the same worker runs `lane --paths` itself and goes on to build only when it passes, no question is open and no screen changes.
3. **Shape** (`roles/shape.md`), for a new page, a screen whose structure changes, a change to how a kind of thing looks across the product, or a screen the person asked to have redesigned. A question sheet and answer key, three rough directions in the real app, and one message to the person, who picks. A single label, spacing or token correction skips it. Discover says which it is; `lane` reports new pages; the person may name a redesign. On the critical lane the order is: the question sheet, the design's contract drafted alongside, the directions on stand-in data, the designer's word on what each direction needs, the person's pick, then the challenge.
4. **Design** (`roles/design.md`) writes `DESIGN.md` and `CHECKS.json`. One fresh challenger (`roles/challenge.md`) reads it once. The designer answers. A confirming checker (`roles/confirm.md`) reads the objections and the changes; an objection it leaves open goes to the person as rule 3's one question. No shaping, design or challenge is repeated for a fix.
5. **Build** (`roles/build.md`): a failing test first, then the code, then a look at the running app.
6. **Gate.** The builder runs `gate` as the last act of every build and fix, on the tree brought up to date with its base; it reruns only the entries that what changed since they passed can reach. On the critical lane the builder runs `checks` with it. Whoever moves the branch afterwards runs both again.
7. **Verify** (`roles/verify.md`): a fresh agent with the brief and the diff, never the builder's account. When every verifier has returned, one fresh triage judge (`roles/triage.md`) rules on everything the workers found on the way; what it rules fixed here joins the findings in the fix round.
8. **Read** (`roles/read.md`): the project captures the ground's screens across their state axes; `words` counts the visible words; fresh readers answer the questions from the screenshots alone, and the orchestrator scores them against the answer key (`roles/read-score.md`). After a fix, one reader reads the changed states only.
9. **Deliver** (`roles/deliver.md`): `ready` must pass at the tree to be delivered: the gate, the branch up to date with its base, the lane not below its floor, the newest verification clean, the checks and the read where they apply, the approval where the change cannot be undone, and the question sheet unchanged since the person saw it. Then the definition's steps, each confirmed from its output, and the handoff.
10. **Audit** (`roles/audit.md`): each fact people act on compared with its record where the change now runs.
11. **Accept.** The person tries it. The orchestrator restates each rejection in one line with the class it took it as; the person corrects the class if it is wrong. The ticket folder and worktrees stay until the person accepts or says to close; then `record`, and cleanup.

| Rejection | What happens |
|---|---|
| Missed purpose: the screen answers the wrong question | Back to Shape, from the question sheet restated with the person, then every later step of its lane, as a shaped screen |
| Defect: it does not do what was agreed, or a bug the person met on the ticket's ground | One fix round, on the ticket's lane: build, `lane` on the new diff, the confirming checks, a read of the changed states, then Deliver again with `ready` first |
| New wish | Added to the ticket only at the person's word, as below; otherwise a note |

**Work the person adds to a ticket** after Discover is discovered before it is built: Discover adds a section to the brief with its acceptance checks, paths and questions, the orchestrator adds what the person named to `Ground:`, in their terms, and `lane --paths` runs again.

A second rejection of the same screen for how it reads or what it offers, not for a wrong value, is a missed purpose. A rejection that states a rule is listed in the handoff as a line proposed for the project's design reference, so the next screen can start with it.

## Hotfix

People are failing in production now. The order changes; nothing is skipped for the root fix.

1. **Guard first:** the smallest change that stops the wrong thing and can be undone by reverting it, with a test that reproduces the failure. It runs the steps of the lane its paths give it, without Shape, Design or Challenge: on the critical lane Discover writes the guard's `CHECKS.json` (the reproduction, and the boundary's oracle where one exists). Audit follows its delivery. It is delivered to the base production is built from and carried to every base the definition names, each proven the way the definition says for that base. A guard that cannot be undone by reverting needs the person's approval.
2. **Root fix second,** in the same ticket, from a worktree at the base the guard landed on, on the lane its paths give it.

## How loops end

1. **Evidence or it is a note.** After the build, a finding blocks only with a failing test, a reproduction, or a cited line together with the acceptance check or rule it breaks. Before the build, with the input or state that makes the design fail and the real path that reaches it. Everything else goes in the handoff as a note. Taste and "could be better" are not findings. A dispute over whether something is wrong is settled by running it: a failing test or a reproduction decides, and without one it is a note. The decision judge rules on product questions, not on correctness.
2. **One full read, then the fix only.** A confirming checker's brief is the earlier findings and the changes since. It answers whether each is closed and whether the fix broke what it reaches. It raises a new finding only in changed code, or for a wrong fact people act on that the change causes, with evidence; an older one is a found item.
3. **The open set must shrink, and a second round is reconsidered first.** The orchestrator counts the open findings after every round, new ones included. Before a second fix round starts in one delivery, a fresh reconsider (`roles/reconsider.md`) says whether the open findings share a choice and rules on it; the orchestrator acts on the ruling and the handoff shows it. A ruling that changes what is built returns the ticket to the first step it changes (the brief; on the critical lane the design and its checks) and to a fresh verification; that is not a fix round. After that, a round that ends with as many open as it began with, or that reports the same finding not closed a second time, ends the loop, and the person is asked one question about the choice behind those findings; their answer is the rule a confirming checker then judges those findings by. A recapture is not a fix round. The same holds for reads: a re-read counts only on the states that changed.

## How the work is trusted

- **Agents judge meaning; scripts count, match and compare.** `lane`, `gate`, `ready`, `words`, `checks`, `proof` and `record` (with two shared modules, `ticket` and `runner`) run as `node <skill folder>/scripts/<name>.mjs`; each says at its top what it compares.
- **Fresh agents check.** The one who checks never wrote what it checks, and works from raw sources: the code, git, logs, data, the running app.
- **Grounded.** A claim names its source: `file:line` at a named commit, a query and its result, a log line, a screenshot, an external source opened. Whoever passes a claim on says whether it was found or proposed.
- **Prove by running.** Whatever the project's environments can produce (a state, an account, data) is produced and checked, never reported as unchecked. Only what cannot be produced there (a real third party, real money, elapsed time) is reported, first, as work not done.
- **A changed run condition changes what was proven.** Preserve a failed run when retrying with fewer workers, less load, a different timeout or a narrower selection. Compare the conditions and investigate the original failure. A passing retry proves its own conditions; it closes the original failure only with evidence that explains it and verifies the applicable acceptance conditions. Otherwise keep the failure open for triage under the same acceptance rules. Record its disposition and any remaining uncertainty in the user handoff.
- **A sentence is not an answer.** What a person sees is judged by the `design` skill. An answer the screen gives only in a sentence counts as not given.
- **Files, not memory.** The ticket folder is the state.

## Decisions and the person

A product question (one whose answer changes what users or the business get, and that the code and the project's rules do not settle) goes to a fresh decision judge (`roles/decide.md`), who answers from sources. The handoff lists every decision for the person to overrule.

The person is asked for: a screen's direction; approval of a change the project cannot undo, asked once its design has answered the challenge, and asked again if what was approved changes afterwards; an access a worker could not get; a step that cannot go on without them; and the one question rule 3 ends in. The person is told, not asked, when a hotfix ticket or a next ticket is opened; starting such a ticket follows the project's own rules on who may start work. The person does not approve plans. Never wait on the person while any other step can proceed.

The project's `AGENTS.md` files and the person's own instructions add to this method; where they ask for more, they win.

## Learning

`record` writes each ticket's numbers: time to delivery and to acceptance, idle time, the person's rejections by class, agents started, gate runs, lane raises, words per screen. A kind of miss that repeats points at the method: change what let the work drift, rather than adding a clause for the case. A check that keeps finding nothing in a lane is removed from that lane. Learning is its own piece of work, never done inside a ticket.

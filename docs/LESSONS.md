# Lessons and plugin improvements

When something was not done right, or did not go as the user wanted, the system should learn so it does not happen
again. There are two kinds of learning, kept apart:

- A **lesson** is about the project: its code, its repos, its design system, its tests, how its tickets are planned.
  Its content is the project's; the plugin provides the harness. It is stored in the repository it concerns and
  delivered with the ticket that taught it.
- A **plugin improvement** is about the workflow itself (the engine, a template, a skill, the guard, the tracker
  handling, onboarding, the docs). It is not a lesson: the plugin's maintainer fixes it in the plugin repo, with a
  scenario test that reproduces the failure.

Terms (README, "Terms"): a **project** is the whole onboarded system (one adapter, one tracker); a **repo** is one Git
repository in it; a **component** is a logical part mapped to a repo or a package; the **plugin** is agentic-workflow.

Nothing here edits the adapter or any instruction file on its own, and nothing is posted anywhere.

## Named failures this is built from

| What happened | Kind | What now prevents it |
| --- | --- | --- |
| Screenshots were attached to the ticket but not visible in it | plugin improvement I-3 | the delivered comment embeds each image; the readback checks it |
| UI tables did not use the shared design-system components and no reviewer caught it | repo lesson (design-system) | a designSystem rule over added lines |
| A value that differed between two captures of the same state was dismissed as cosmetic | plugin improvement I-5 | `wf shown` anomalies need a cause or a follow-up |
| A hand-built tracker readback was accepted | plugin improvement I-4 | raw shape, comment equality |
| The reviewer judged screenshots before the gate had produced them | plugin improvement | the evidence pass after a passing gate |
| A shared helper change broke another spec | repo or project lesson (test) | a gate check, or dependents named in the plan |
| A behaviour was kept because an earlier merge and its tests chose it, citing an invariant about a different subject | plugin improvement I-8 | precedent check, invariant scope check, `precedent-only` findings, `rationale` on kept criteria |
| Lessons were written into one repo's adapter folder, uncommitted; workflow findings were stored in projects | plugin improvement I-10 | repo and project lessons committed with the attempt; workflow findings to the improvement inbox |

## Classify first

At every trigger (a reopen, a review finding with a `category`, a `wf shown` anomaly with a follow-up, a correction
the owner relays), the question is: **project or workflow?**

- Project: `wf lesson add --repo <name>` (about one repo) or `wf lesson add --project` (spans repos).
- Workflow: `wf improve add --title ... --what ... --observed-in <attempt or step> --quote "<their words>" --class
  <engine|template|skill|guard|tracker|onboarding|docs|other>`.

## Lessons

### Where they live

- A **repo** lesson: `<repo>/.workflow/lessons/<id>.yaml`, field `repo` set to that repo.
- A **project** lesson: in the adapter repo's `.workflow/lessons/`, `scope: project`, `repo: null`.
- Recorded during an open attempt (before acceptance), the file is committed in that attempt's worktree of the repo:
  it is in the reviewed diff (`lesson (covered)` in `wf status`, never an unplanned file) and delivered with the
  ticket. Otherwise it goes to the repo's main checkout, to commit there.
- Without `--repo`: the only repo, or the attempt's repo with the most changed files; otherwise wf asks.
- Read from every declared repo: at the attempt's base commit, in the main checkout, and in the attempt's worktree. A
  lesson at the base or in the main checkout is never replaced by a weaker worktree copy: a ticket can add lessons and
  record recurrences, never drop or soften one.
- `wf lesson list` flags lessons in the wrong place (a `repo` other than the one holding it, a project lesson outside
  the adapter repo, a workflow finding stored as a lesson); `wf lesson move <id> --repo R` (or `--project`, or
  `--improvement` to send it to the inbox) moves it.

### The file

```yaml
id: L-3                      # the file name; letters, digits, dashes, at most 64
title: Data tables use the shared table and pagination components
scope: repo                  # repo (about one repo) | project (spans repos)
repo: web                    # the repo it concerns (null for a project lesson)
trigger:
  what: A report page rendered a raw table without pagination; the review did not catch it.
  attempt: ENG-12.2
  finding: F2
  quote: "why isn't this using our table?"   # the owner's words, verbatim
cause: design-system         # process | tooling | criteria | review | test | design-system | other
mechanism:
  kind: designSystem-rule    # review-rule | designSystem-rule | planner-criterion-template | reviewer-checklist | gate-check | engine-change | doc
  ref: table-has-pagination  # what enforces it (required when enforced)
status: proposed             # proposed (advisory) | enforced | retired
tags: [ui, tables]
paths: ["src/**/*.tsx"]      # in its repo; none = every change in it
recurrence: 0
```

### Flows

- **Capture**: `wf lesson add` (flags or `--file`), recorded in the attempt's ledger. A reopened attempt records its
  lesson before `wf handoff reviewer` (or `--no-lesson "<why>"` / `wf lesson waive --reason`), so it is reviewed and
  delivered with the change.
- **Use**: every non-retired lesson that applies is in the planner, implementer and reviewer bundles, with why it
  matched, labelled enforced or advisory. Planner: the ticket's words, the repos in scope, the plan's paths.
  Implementer: the same, plus what has already changed. Reviewer: the changed files, the ticket's words. Enforced and
  recurring lessons are never capped; the rest at most 5, omitted ids listed. Handoffs print `lessons injected: ...`;
  `wf lesson preview --attempt ID --role ...` shows it beforehand.
- **Acknowledge**: the implementer adds a commit trailer per lesson (`Lesson <id>: applied - <how>` or
  `Lesson <id>: not-applicable - <why>`); `wf handoff reviewer` refuses until each is there and records them.
- **Judge**: the reviewer gives each a verdict (`complied | not-applicable | finding`); a `finding` is a recurrence.
- **Apply**: `wf lesson apply <id>` prints the snippet; the owner commits it and sets `status: enforced`.
- **Review**: `wf lesson review` lists lessons to promote (recurred twice), apply (proposed) and retire.

## Plugin improvements

- **Inbox**: `~/.agentic-workflow/improvements/<id>.yaml` (or `WF_IMPROVEMENTS_DIR`), outside every repo; ids `I-<n>`
  continue after the plugin repo's history. Title, description and where it was observed are stripped of project and
  repo names, ticket ids, paths, emails and URLs; the owner's quote is kept verbatim in this user-level file only.
- **Work**: `wf improve list|show|next` (next: regressions first, then the oldest) in a plugin maintainer session.
- **Close**: `wf improve close <id> --version X --test scenarios/<file>.test.mjs --fix "..."` only when the test exists in
  the plugin repo (and contains `--name`, when given); writes `improvements/<id>.md` there, generic, to commit with the
  fix.
- **Regression**: a new item with the same class and a similar title as a closed one, or `--regression-of I-n`, is
  flagged "regression of I-n fixed in X" and goes first.
- **Visibility**: counts in `wf status` and `wf doctor`.

## Deliberately left out

- No automatic edits of the adapter, instruction files or templates; no auto-filed issues; nothing posted.
- No similarity scoring beyond tags, mechanism kind and title words; no embedding or free-text matching.
- No per-lesson metrics beyond the recurrence counter and the injection history the ledgers already hold.

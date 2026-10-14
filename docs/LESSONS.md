# Lessons and plugin improvements

When something was not done right, or did not go as the user wanted, the system should learn so it does not happen
again. There are two kinds of learning, kept apart:

- A **lesson** is about the project: its code, its repos, its design system, its tests, how its tickets are planned.
  Its content is the project's; the plugin provides the harness. It is stored in the repository it concerns and
  delivered with the ticket that taught it.
- A **plugin improvement** is about the workflow itself (the engine, a template, a skill, the guard, the tracker
  handling, onboarding, the docs). It is not a lesson: the plugin's maintainer fixes it in the plugin repo, with a
  scenario test that reproduces the failure, or, when the finding is that a check caught nothing, retires the check.

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
- **Which checkout** (0.7.4, I-99, I-112; `wf lesson add|recur|set|move --attempt <id>`). The file is committed in the
  attempt's worktree of the repo, so it is in the reviewed diff (`lesson (covered)` in `wf status`, never an unplanned
  file) and delivered with the ticket, while the attempt is open and **its acceptance does not stand**. An acceptance
  stands while the tree is the accepted one: nothing committed since, and no implementer handed after the acceptance still
  open (`wf deliver` refuses a tree "modified after acceptance", so a lesson cannot be committed into it). Then the lesson
  is written to the repo's main checkout, to commit there. The worktree takes over again as soon as the tree has moved
  past the accepted heads (a repair committed, the implementer closed or not) or an implementer handed after the
  acceptance is open: that repair is reviewed again, and the lesson with it. An implementer that was already open when the
  review was accepted counts for nothing. A delivered or abandoned attempt, and a command without `--attempt`, write to
  the main checkout. A recurrence recorded at acceptance (a reviewer's `finding` verdict) on a lesson the attempt itself
  added is recorded in the ledger only (the file in the attempt's worktree is the one delivered, and no second copy goes
  into the main checkout; the file's own count rises with the next change to the lesson). A lesson that is part of the
  accepted tree is not moved out of it (`wf lesson move --attempt`, refused for attempts admitted at 0.7.4 or later): that
  would change the tree the acceptance describes.
- **A repo the attempt does not hold.** `wf lesson add --attempt <id> --repo X` with X not among the attempt's repos, or
  `--project` when the adapter repo is not, is refused (attempts admitted at 0.7.4 or later; earlier ones keep the write
  to the main checkout): the lesson could be neither reviewed nor delivered with the ticket, and an untracked file in a
  main checkout is what the other rules above exist to avoid. The refusal names the route: add the repo to the attempt
  (`wf criteria amend --file <amendment.json> --reason "<why>" --add-repo X --attempt <id>`) and record the lesson again,
  or record it without `--attempt` to write it into X's main checkout on purpose (a reopened attempt that owes a lesson
  then closes the obligation with `wf lesson waive --reason "<where it went>"`).
- Without `--repo`: the only repo, or the attempt's repo with the most changed files; otherwise wf asks.
- Read from every declared repo: at the attempt's base commit, in the main checkout, and in the attempt's worktree. A
  lesson at the base or in the main checkout is never replaced by a weaker worktree copy: a ticket can add lessons and
  record recurrences, never drop or soften one.
- `wf lesson list` flags lessons in the wrong place (a `repo` other than the one holding it, a project lesson outside
  the adapter repo, a workflow finding stored as a lesson); `wf lesson move <id> --repo R` (or `--project`, or
  `--improvement` to send it to the inbox) moves it. A move never overwrites a different lesson of the same id in the
  repository it moves to.
- **Identity** (0.7.0, I-95). Ids are allocated per repository, so two repositories can each hold a different `L-4` (after
  integrating bases, or two attempts each adding one). Neither is hidden. A lesson's identity is its id while no other
  repository holds a different lesson of that id, and `<id>@<repository>` (`L-4@api`, `L-4@web`; the repository whose
  folder holds the file) while one does; bundles, acknowledgement trailers (`Lesson L-4@api: applied - ...`), verdicts
  and every `wf lesson` command use it. The qualified form names the same lesson whether or not the collision still
  exists, so a reference recorded during it stays valid when one is renamed; a bare `L-4` that is two lessons is refused
  with the identities to choose from. The file keeps its own id. The same lesson held twice (a copy left after a move)
  is one lesson. `wf lesson add` allocates the next number counting the lessons in every repository and in the
  worktrees of every open attempt, so parallel attempts do not take the same one.

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
tags: [ui, tables]           # matched against the ticket's words
paths: ["src/**/*.tsx"]      # scope: globs (in its repo for a repo lesson); ["**"] on a project lesson = every change
components: [web]            # scope: adapter component ids (optional)
kinds: [ui]                  # scope: ui | test | migration | docs | script | config | source (optional)
recurrence: 0
```

### The layout of the file (0.7.4, I-49)

A lesson file is written to pass the repository's own `prettier --check`, without running Prettier or any code of the
repository. The configuration is found the way Prettier 3 finds it: from the lesson's folder up to the repository's root,
the first folder that holds a config wins whole (nothing merges across folders), and inside one folder the first of these
that exists is the one, in this order: `package.json` (only with a `prettier` key), `package.yaml`, `.prettierrc`,
`.prettierrc.json`, `.prettierrc.yml`, `.prettierrc.yaml`, `.prettierrc.json5`, the JavaScript and TypeScript forms
(`.prettierrc.js`, `prettier.config.js`, ... `.cts`), and `.prettierrc.toml`. Its `overrides` are applied by the lesson
file's path (`files` and `excludeFiles` as Prettier reads them). A config above the repository is not read.

- `singleQuote`: the quote Prettier would choose: yours unless the text needs the other; a text holding both kinds of quote
  is single-quoted.
- `tabWidth`: the indentation, also of lists and block texts.
- `endOfLine`: `lf`, `crlf` or `cr`; `auto` keeps the line ending the file already has.
- `printWidth`, and `proseWrap` `preserve` or `never`: no effect. Prettier keeps a one-line text on one line, and so does the
  file (it is never folded at 80 columns).
- `proseWrap: always`: a text that does not fit within `printWidth` is written as a literal block (`|-`), which Prettier
  never reflows.

The text of every field is the same whatever the layout (the parsed file is checked against the lesson before it is
written). `recur`, `set` and `move` rewrite the file in the same layout, so a lesson that passed stays passing.

What is not read: `.prettierrc.json5`, the JavaScript and TypeScript configs and `.prettierrc.toml` (they need code, or a
parser, the engine does not run), a shared-config name in package.json, and `.editorconfig` (Prettier merges it under the
config). A config reached through a link is read, as Prettier reads it, and a package.json (or package.yaml) with no
`prettier` key, an empty one, or one that cannot be read is skipped, as Prettier skips it. When the config Prettier would use is one of these, the search
stops there (a lower file Prettier would never reach is not consulted), a new lesson is written in Prettier's defaults (LF,
two spaces, double quotes), and a lesson file that exists keeps its own line endings, indentation and quote style when a
command rewrites it, so a manual `prettier --write` sticks. The same holds where there is no configuration at all, and, for
the options a readable config does not set, where an `.editorconfig` lies between the file and the repository's root. Left to
`prettier --write`: a text that needs escapes (a control character, say) or has white space at the end of a line, when
`proseWrap` is `always` or `never` and it does not fit on one line, because Prettier wraps inside the quotes and no layout
here can match it.

### Flows

- **Capture**: `wf lesson add` (flags or `--file`), recorded in the attempt's ledger. A reopened attempt records its
  lesson before `wf handoff reviewer` (or `--no-lesson "<why>"` / `wf lesson waive --reason`), so it is reviewed and
  delivered with the change.
- **Use**: every non-retired lesson whose declared scope (repo, components, paths, kinds: all it declares) the change
  falls in is in the planner, implementer and reviewer bundles, with why it matched, labelled enforced or advisory.
  Planner: the ticket's words (tags), the plan's paths, the lesson's repo admitted. Implementer: tags, planned and
  changed files in scope, its repo only when it is the attempt's only repo or the work item's. Reviewer: tags and the
  changed files in scope. A lesson declaring no scope (no repo, components, paths or kinds) matches by its tags only; a
  project lesson that declares no scope and no tags applies project-wide (I-64), and `paths: ["**"]` on a project lesson
  says "every change". Enforced and recurring lessons are never capped; the rest at most 5, omitted ids listed. Handoffs print `lessons injected: ...` and the filtered ids; filtered
  lessons stay out of the bundle (no verdict owed). `wf lesson preview --attempt ID --role ...` shows both, with why
  each was filtered.
- **Acknowledge** (optional): an implementer may add a commit trailer per lesson (`Lesson <id>: applied - <how>` or
  `Lesson <id>: not-applicable - <why>`); `wf handoff reviewer` records the ones that exist and shows them to the
  reviewer, and never refuses for a missing one (0.7.0: the refusal caught nothing).
- **Judge**: the reviewer may give each a verdict (`complied | not-applicable | finding`; none is required, one given is recorded with the acceptance); a `finding` is a recurrence.
- **Apply**: `wf lesson apply <id>` prints the snippet; the owner commits it and sets `status: enforced`.
- **Review**: `wf lesson review` lists lessons to promote (recurred twice), apply (proposed) and retire.

## Plugin improvements

- **Inbox**: `~/.agentic-workflow/improvements/<id>.yaml` (or `WF_IMPROVEMENTS_DIR`), outside every repo; ids `I-<n>`
  continue after the plugin repo's history. Title, description and where it was observed are stripped of project and
  repo names, ticket ids, paths, emails and URLs; the owner's quote is kept verbatim in this user-level file only.
- **Work**: `wf improve list|show|next` (next: regressions first, then the oldest) in a plugin maintainer session.
- **States**: `open`, `closed` (fixed) or `retired` (a check removed because it caught nothing).
- **Close**: `wf improve close <id> --version X --test scenarios/<file>.test.mjs --fix "..."` only when the test exists in
  the plugin repo (and contains `--name`, when given); writes `improvements/<id>.md` there, generic, to commit with the
  fix.
- **Retire**: `wf improve close <id> --retire --version X --reason "..." [--refusal id,id]` needs no scenario test (no
  behaviour is left to reproduce) but records the reason and the refusal count of each named id from the refusal log
  (`wf refusals`); the history entry says "Retired in" instead of "Test". Named failure: closing needed a new scenario,
  so a check that only ever refused wrongly could never leave the engine, and every path from an incident to code added
  and none removed.
- **Review**: `wf improve review` lists the refusal ids by count, each with the improvements and closures that cite it,
  and which are cited by none: the checks nobody has judged (design principle 13 made measurable).
- **Regression**: a new item with the same class and a similar title as a closed one, or `--regression-of I-n`, is
  flagged "regression of I-n fixed in X" and goes first. A retired item never makes a regression.
- **Visibility**: counts in `wf status` and `wf doctor`.

## Deliberately left out

- No automatic edits of the adapter, instruction files or templates; no auto-filed issues; nothing posted.
- No similarity scoring beyond tags, mechanism kind and title words; no embedding or free-text matching.
- No per-lesson metrics beyond the recurrence counter and the injection history the ledgers already hold.

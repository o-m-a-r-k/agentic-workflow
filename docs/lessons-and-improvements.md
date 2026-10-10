# Lessons and plugin improvements

[Back to the README](../README.md) · [Docs map](../README.md#docs)

The design of the lessons harness: [LESSONS.md](LESSONS.md).

## Discovered issues, lessons and improvements

Three different things, kept apart:

- A **discovered issue** is a defect found during a ticket. Related defects are fixed in that ticket; independent existing defects follow the [owner scope decision](scope-decisions.md). Existing explicit owner deferrals remain available: `wf discovered` ([lifecycle](lifecycle.md#scope-decisions-and-discovered-issues)). Calling it a follow-up does not close it.
- A **lesson** is what the project learns so a kind of mistake does not recur (below).
- A **plugin improvement** is a finding about the workflow itself (below).

## Lessons: the learning path

When something was not done right or did not go as the user wanted, the project records what it learns so it does not recur ([design](LESSONS.md)). The content is the project's; the plugin provides the harness.

- **Where a lesson lives.** A **repo** lesson (`--repo <name>`) is about one repo and lives in that repo's tree: `<repo>/.workflow/lessons/<id>.yaml`. A **project** lesson (`--project`) spans repos and lives in the adapter repo's tree. Recorded during an open attempt, it is committed in that attempt's worktree of the repo, so it is in the reviewed diff (listed as `lesson (covered)`, never as an unplanned file) and delivered with the ticket; otherwise it goes to the repo's main checkout, to commit there. Without `--repo`, the repo with the most changed files in the attempt is used, or the only repo; otherwise wf asks. `wf lesson list` flags a lesson in the wrong place; `wf lesson move <id> --repo R` (or `--project`) moves it.
- **Capture.** `wf lesson add --attempt <id> --repo <name> --title ... --what ... --cause <process|tooling|criteria|review|test|design-system|other> --mechanism <review-rule|designSystem-rule|planner-criterion-template|reviewer-checklist|gate-check|engine-change|doc> --quote "<the user's words>" [--tags --paths]`, or `--file l.yaml`. A reopen, a review finding with a `category`, and a `wf shown` anomaly with a follow-up prompt the owner: is this about the project (a lesson) or the workflow itself (a plugin improvement, below)? **A reopened attempt records its lesson before the review** (or `--no-lesson "<why>"` on `wf reopen`, or `wf lesson waive --reason`), ledgered.
- **Declared scope.** A lesson says where it applies: its `repo` (a repo lesson), `components` (adapter component ids), `paths` (globs) and `kinds` (file kinds: `ui`, `test`, `migration`, `docs`, `script`, `config`, `source`, judged from the file's path). A changed file is in its scope when it satisfies every one it declares. `paths: ["**"]` on a project lesson means every change. A lesson that declares none of them matches only when the ticket mentions one of its tags; `wf lesson list` warns about each such lesson. Add the scope with `--repo`, `--components`, `--paths` and `--kinds` on `wf lesson add`, or in the file.
- **Every role uses the ones in scope.** Each lesson that applies is in the planner, implementer and reviewer bundles under `lessons`, with why it matched, labelled enforced (by its mechanism) or advisory (proposed).
  - The planner matches by the ticket's words (tags), the files the plan names, and the lesson's repo (or its components' repos) being admitted to the attempt.
  - The implementer matches by tags, planned and already changed files in scope, and its repo when that repo is the attempt's only repo or the work item's. A multi-repo quick fix therefore gets no other repo's lessons before it changes anything.
  - The reviewer matches by tags and the changed files in scope. A lesson for a repo the change did not touch is not handed to it.

  Enforced and recurring lessons are never dropped; the rest are capped at 5, the omitted ids listed. Every handoff prints `lessons injected: ...` and `lessons filtered out (outside this change's scope): ...`; the ledger keeps both lists. Filtered lessons never enter a bundle, so no verdict or trailer is owed on them. `wf lesson preview --attempt ID --role planner|implementer|reviewer` shows the selection and, for each filtered lesson, why it was left out.
- **Acknowledged and judged.** The implementer acknowledges each lesson in a commit trailer (`Lesson L-3: applied - <how>` or `Lesson L-3: not-applicable - <why>`); `wf handoff reviewer` refuses until every one is there and records them in the ledger. The reviewer sees them and gives its own verdict per lesson (`lessons: [{ lesson, verdict: complied|not-applicable|finding, evidence, finding }]`); `wf review` refuses a closure without them.
- **Apply.** `wf lesson apply <id>` prints the exact adapter snippet or template text for its mechanism; it never edits anything. The owner commits it and runs `wf lesson set <id> --status enforced --ref <what enforces it>`.
- **Feedback.** A `finding` verdict on a lesson, or a new lesson with the same mechanism kind and a shared tag, is a recurrence: its counter goes up (in the attempt, so it ships with it) and `wf status` says "lesson X recurred: its mechanism failed". `wf lesson review` lists lessons to promote to a gate check, to apply, and to retire.
- **Paths.** A lesson id is letters, digits and dashes (at most 64) and is the file's name, never taken from its content. Lesson folders must be real folders inside their repo and outside the evidence; files are read and written without following links, never through a hard link; anything else is skipped and listed.
- **Prior decisions are inputs, not authority.** A past merge, an existing test, a prior verdict or a comment says what was decided, never what should be. The role templates carry a precedent check, an invariant scope check and the `precedent-only` finding category; a criterion the reviewer marks `precedentOnly` needs a purpose-based `rationale` or such a finding.

## Plugin improvements

A finding about the workflow itself (the engine, a template, a skill, the guard, the tracker handling, onboarding, the docs) is not a lesson: it is an improvement to the plugin, made by the plugin's maintainer in the plugin repo.

- `wf improve add --title ... --what ... --observed-in <attempt or step> --quote "<their words>" --class <engine|template|skill|guard|tracker|onboarding|docs|other> [--regression-of I-n]` records it in your own inbox outside every repo (`~/.agentic-workflow/improvements/<id>.yaml`, or `WF_IMPROVEMENTS_DIR`), with project and repo names, ticket ids, paths, emails and URLs stripped; the owner's quote stays verbatim in that file only.
- `wf improve list|show|next`: `next` is the highest-priority open item (regressions first, then the oldest), for a plugin maintainer session.
- `wf improve close <id> --version X --test scenarios/<file>.test.mjs --fix "..." [--name "<test>"] [--commit SHA]` closes it only when that test exists in the plugin repo (and contains the named test), and writes a generic history entry to the plugin repo's [`improvements/`](../improvements/). A new item matching a closed one (same class and a similar title, or `--regression-of`) is flagged "regression of I-n fixed in X" and goes first.
- `wf status` and `wf doctor` show how many are open. Nothing is posted anywhere.

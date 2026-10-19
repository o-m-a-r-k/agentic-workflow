# Delivery and tracker

[Back to the README](../README.md) · [Docs map](../README.md#docs)

Ticketing and delivery are the project's (D96). The adapter names its tracker and its delivery stages; `wf deliver` runs the stages an attempt started with, in order, up to the first one that is not settled, and says what is next.

## Stages

`delivery.stages` is a list. The stage list is snapshotted when the attempt starts, so a later adapter change does not reach it (D60). Each repo's part is delivered separately, against its own base, in `delivery.order`.

| Stage | What it does |
| --- | --- |
| `land` | Lands the attempt on the base: directly, or through the landing queue (below). |
| `push` | Pushes each repo's part. With `authority.push: agent` the engine pushes once per repo, in order; otherwise it waits for the person's push to appear on the remote. A push onto the base needs a passing `full` run on the tip tree, from the landing queue or CI (`merge:untested`). |
| `merge-request` | Opens a merge request per repo (`repos:`), each against its own base, and records the commit per repo. |
| `wait-merged` | Waits until each repo's commits are on its base, by ancestry or by patch-id, so a squash or rebase merge counts. The project's CI and reviewers decide the merge. |
| `confirm-deployed` | Waits for the person to confirm the change runs where it deploys (`where:`), read-only, then test it there. |
| `deploy` | A production deploy: always the person's decision (`stage:deploy`). |
| `status` | Sets the ticket's status (`to:`), with an optional `comment:` template. |
| `comment` | Posts a comment. |
| `module` | Runs a project module (`{ repo, path }`), loaded as the base holds it, with the stage's marker and repos. |

- `when: { labels: [...] }` runs a stage only for a ticket carrying one of the labels. A label the engine could not read is `pending`, never false, and the stage waits for it. Through a connector, labels are read from the result of the owner's read call in the transcript; `wf deliver --labels` is refused.
- `after: <item>` waits until that item has shipped: the only cross-ticket wait (D97).
- Every comment and filed ticket carries an idempotency marker (`wf:<attempt>:stage-<n>`), and the engine searches for it before writing, so a rerun after a lost result writes nothing twice.
- Under a hold no stage runs (`hold`).
- Telemetry records the time spent waiting in each stage.

## The landing queue

For projects with no CI whose full suite is long (`delivery.landing: queue`):

1. Tickets that are ready (reviewed, `fast` green, decisions answered) enter the queue; the queue never waits for one that is not ready.
2. `wf land` stacks every ready ticket onto the current base in a landing worktree, one squashed commit per ticket, and runs `full` once.
3. On green, it pushes them all.
4. On red, it bisects to the first ticket that turns the stack red, returns that ticket to its implementer with the failing log, and lands the rest.

A base that moves during the run is fetched again and the stack rebuilt and retested: only a tested tree is pushed. A landed tree without a passing `full` run, from the queue or from CI, is refused (`merge:untested`), and so is an attempt whose `fast` tests are not green on HEAD.

## Merge facts

Before anything lands, two facts are checked against the last reviewed tree (D97):

- `merge:unreviewed`: anything other than git's automatic merge from the base changed since that tree.
- `merge:foreign`: a merge commit whose second parent is not the base, or is reachable from another remote branch. The person may allow it.

## Trackers

`ticketing.via` says who performs each tracker operation:

- **`connector`:** the owner agent performs it through its host's connector, in the adapter's own words (`ticketing.operations`, D68), and the engine reads the result back from the owner's transcript. A `ticketing.tracker` given as a string is then a label in those words, never a built-in driver. An operation counts only when all of these hold:
  - the call was made after the stage was first asked;
  - its result is present and is not an error;
  - for a follow-up, the input carries the marker and the title, and the result shows the new id (filing a follow-up through a connector needs `ticketing.idPattern`, to recognise that id);
  - for a status change, the result shows the new status.

  Until then the step is `pending` and `wf status` prints what to do. A pending follow-up is read back at every `wf status`, `wf resume`, `wf review --record` and `wf deliver`, counting calls since its first `finding.filed`; the status set at start (`ticketing.take`) is asked again by `wf deliver`, which runs no other stage until it is done. The operations, and so the keys of `ticketing.operations`, are one list (`TRACKER_OPERATIONS` in `engine/contract.mjs`): `read`, `search`, `fileFollowUp`, `setStatus`, `comment` and `mergeRequest`.
- **`module`:** the engine calls the project's tracker module (`ticketing.tracker: { module: { repo, path } }`), which exports a driver: `read`, `search`, `create`, `setStatus`, `comment`, and optionally `normalise`. Through a connector a tracker module needs no driver methods: it exports `operations` (named, or on its default object), the owner's words.
- **`files`:** the built-in files tracker. Each ticket is `<root>/tickets/<id>.md` with YAML frontmatter (`id`, `title`, `status`, `labels`) and the description as its body; comments are appended between marker lines. Ids are an allowlist checked before any file is touched, and nothing is read or written through a link.
- **`none`:** no tracker. `wf start --no-tracker <item>` records `ticketing: none` for one attempt of a project that has a tracker.

The plugin ships no vendor tracker. `ticketing.idPattern` and the tracker's `normalise` turn a raw id (any case, inside a URL) into one id, so attempt numbers continue across spellings.

## Findings outside the goal

An `other` finding (D92) is searched for in the tracker first, then handled by `ticketing.followUps.mode`:

- `file`: a ticket is filed (with `team`, `status` and `label` from the adapter; the ticket's own labels are never copied);
- `digest`: it goes into the person's daily digest (`wf digest`);
- `off`: it is listed in the delivered comment only.

An `other` finding rated high, or on a risk path, also goes to the person as a priority item in the digest. It does not hold the ticket.

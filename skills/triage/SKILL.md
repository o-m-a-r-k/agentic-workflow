---
name: triage
description: Decide what becomes of a defect or idea found while working on a ticket (fix it in this ticket, open a hotfix or next ticket, note it in the handoff, or drop it) so related bugs get fixed without the backlog or the ticket growing. Use whenever work on a ticket turns up something the ticket did not ask for.
---

# What a found item becomes

Related bugs get fixed where they are found; a ticket still ends.

The ticket's ground is in its `STATE.md` (`WORKFLOW.md`, Words). An **extra** is a fix row 3 makes in the ticket. A **bug** is the product showing or doing something that contradicts its record, its rules or what it says of the same thing elsewhere; a wrong word is one.

**Decide first.** An item whose fix depends on a product choice, one the code and the project's rules do not settle, goes to the decision judge and is placed once it is answered. It is never fixed or noted undecided.

Then ask in order. The first yes decides, and the answer is the same on every lane.

| # | Question | Result |
|---|---|---|
| 1 | Did this change cause or worsen it, or would acceptance be false with it present? | **Fix in this ticket** |
| 2 | Is a fact people act on wrong and reachable by users now? | **Its own hotfix ticket,** opened at once; the person is told |
| 3 | Is it a bug on the ground, or met on the ticket's own path, whose fix touches no boundary, needs no design and stays in the repositories the ticket is already in? | **Fix in this ticket,** as its own commit with its own test |
| 4 | Is it a bug whose fix touches a boundary? | **The next ticket:** its own ticket, opened now and first in the handoff, started right after this delivery where the project's rules let work start without the person |
| 5 | Anything else | A **note:** one line in the handoff with what shows it, not fixed, no ticket. The person says which notes become tickets |

## Rules that keep it honest

- **Show it.** An item is shown by running something: a failing test, a reproduction, a query and its result. One that cannot be shown in the project's environments is a lead in the handoff, with what would show it. A lead is never work.
- **Know where it lives.** An item placed in the ticket names the paths its fix needs, found by searching every place the thing is defined or shown, never assumed from the one place it was met.
- **The root cause is fixed where it lives,** shared code included: that is the ticket. The same kind of defect in another place is a bug off the ground: rows 3 and 4.
- **The ground does not grow.** Shared code the ticket changes is checked wherever it is used, for what the change broke there: row 1. Row 3 is for what the ticket's own path meets. What is met only where that shared code is used, or while building or checking an extra or added work, and is shown to be on the base already, is a note unless row 2 or 4 applies.
- **An in-ticket fix reopens nothing** unless it changes the contract or what a screen is for. One that touches a boundary raises the lane, like any other change.
- **Before verification,** an in-ticket fix is a commit in the build. **After it,** in-ticket fixes are gathered into one fix round, and the confirming checker's brief lists them.
- **Taste is dropped.** "Could be better" with no failing state behind it is not an item.

## Examples

| Found while | The item | Row | Result |
|---|---|---|---|
| Fixing a filter on a list page | The same page's empty state shows a raw error code | 3 | Fix in this ticket, own commit: same screen, one place, no boundary |
| Fixing a filter on a list page | The same page's totals are labelled by a service in another repository, wrongly | 5 | A note: on the screen, but its fix is not where the ticket is |
| Changing a label on a settings page | A total on an unrelated statement is computed without a discount | 2 | Hotfix ticket now; this ticket carries on |
| Adding a column to a table | The date helper that column uses drops the timezone in a tooltip, with no stored value affected | 3 | Fix in this ticket, own commit, own test |
| Fixing a notification's wording | The endpoint behind it, which no screen calls yet, lets any member through | 4 | Next ticket, started right after this delivery |
| Building a detail page | The list it links from could use a saved-filter feature | 5 | A note in the handoff: not needed here |
| Reviewing a form | "The spacing here feels tight" | — | Dropped: taste |

Record each item in the brief's "Found on the way" (Discover) or the ticket's `STATE.md` (later), with the row that decided it.

---
name: triage
description: Decide what becomes of a defect or idea found while working on a ticket (fix it now, fix it in this ticket, open a hotfix or next ticket, file it, or drop it) so related bugs get fixed without the backlog or the ticket growing. Use whenever work on a ticket turns up something the ticket did not ask for.
---

# What a found item becomes

Related bugs get fixed where they are found; a ticket still ends.

The ticket's ground is in its `STATE.md` (`WORKFLOW.md`, Words). An **extra** is a fix row 3 makes in the ticket.

Ask in order. The first yes decides, and the answer is the same on every lane.

| # | Question | Result |
|---|---|---|
| 1 | Did this change cause or worsen it, is it on the ticket's ground, or would acceptance be false with it present? | **Fix in this ticket** |
| 2 | Is a fact people act on wrong, reachable by users now, off the ground? | **Its own hotfix ticket,** opened at once; the person is told |
| 3 | Is it a bug off the ground, whose fix touches no boundary and needs no design? | **Fix in this ticket,** as its own commit with its own test |
| 4 | Is it such a bug whose fix touches a boundary or needs a design? | **The next ticket:** its own ticket, opened now and first in the handoff, started right after this delivery where the project's rules let work start without the person |
| 5 | Not a bug: is it needed for acceptance? | In the ticket if yes. Otherwise **file** one line if the person would value it, else **drop** it with a line in the handoff |

## Rules that keep it honest

- **Show it.** An item is shown by running something: a failing test, a reproduction, a query and its result. One that cannot be shown in the project's environments is a lead in the handoff, with what would show it. A lead is never work.
- **A product question is not a reason to file.** It goes to the decision judge, and the item is placed once it is answered.
- **The root cause is fixed where it lives,** shared code included: that is the ticket. The same kind of defect in another place is a bug off the ground: rows 3 and 4.
- **The ground does not grow.** Shared code the ticket changes is checked wherever it is used, for what the change broke there: row 1. What is met only there, or while building or checking an extra, and is shown to be on the base already, is a **note** unless row 2 applies: one line in the handoff with what shows it, not fixed, no ticket.
- **An in-ticket fix reopens nothing** unless it changes the contract or what a screen is for. One that touches a boundary raises the lane, like any other change.
- **Before verification,** an in-ticket fix is a commit in the build. **After it,** in-ticket fixes are gathered into one fix round, and the confirming checker's brief lists them.
- **Taste is dropped.** "Could be better" with no failing state behind it is not an item.

## Examples

| Found while | The item | Row | Result |
|---|---|---|---|
| Fixing a filter on a list page | The same page's empty state shows a raw error code | 1 | Fix in this ticket: the ticket touches that screen |
| Changing a label on a settings page | A total on an unrelated statement is computed without a discount | 2 | Hotfix ticket now; this ticket carries on |
| Adding a column to a table | A date helper used by another page drops the timezone in a tooltip, with no stored value affected | 3 | Fix in this ticket, own commit, own test |
| Fixing a notification's wording | The job that sends it can run twice for one event and charge twice | 4 | Next ticket, started right after this delivery |
| Building a detail page | The list it links from could use a saved-filter feature | 5 | File one line: not a bug, not needed here |
| Reviewing a form | "The spacing here feels tight" | — | Dropped: taste |

Record each item in the brief's "Found on the way" (Discover) or the ticket's `STATE.md` (later), with the row that decided it.

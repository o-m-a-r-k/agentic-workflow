---
name: triage
description: Decide what becomes of everything found while working on a ticket (fix it here, open a hotfix or next ticket, note it in the handoff), by a fresh judge who sees the ticket and earlier rulings together, so related bugs get fixed without the ticket or the backlog growing. Use when reporting something a ticket did not ask for, and when judging what was reported.
---

# What a found item becomes

Work on a ticket turns up things it did not ask for. The workers report them. A fresh judge places the reported items with the whole ticket in view. Later evidence receives the same rulings; carry earlier decisions forward unless the evidence changes them.

## What is not a found item

- **What this change broke.** Something right on the base and wrong on the change is a finding: it is fixed in the ticket, always. Which it is, is shown by running it on both; when that cannot be shown, it is a finding.
- **What the outcome needs.** While an acceptance check, the gate or a check due before delivery fails, the ticket is not done, whatever the cause. What keeps one failing is a finding even when it was there before the change.

Everything else the work met that is wrong, and was so before the change, is a found item. An idea for something new is reported the same way, without `shown`, and is always a note.

## Reporting one: every worker

You place nothing and fix nothing you found. Write one line each under `## Found on the way` in your file:

`- <what is wrong, and for whom> | shown: <the run, query or reproduction> | where: <every path its fix needs> | urgent`

- **Shown** by running something: what the project's environments can show, you show. Only one they cannot show is a **lead**: say what would show it.
- **Where** is found by searching each place the thing is defined or shown, never assumed from the one place it was met.
- **Urgent** only when a fact people act on is wrong where real users are today. Say so in your return line too.
- You do not go looking: report what the ticket's own work met. Taste, "could be better" with no failing state behind it, is not reported.

## Judging them: the triage judge

Rule each item by the first of these that fits:

1. **A fact people act on, wrong where real users are today:** its own hotfix ticket, opened at once. A product with no users yet has none of these.
2. **The ticket's own work:** another case of the defect the ticket exists to end, or something wrong that its own work rests on, a cause or a state its brief or design reasons from. It is a `finding`, fixed in the ticket wherever its fix sits: left as a note it stays wrong, and as a new ticket its discovery is paid for twice. One nobody has shown is a `finding` only with a run the project's environments can make: the builder makes it first, and a run that rules it out closes the item. Without such a run it is a lead.
3. **A fix that touches a boundary,** by the project definition's map: never fixed here. The next ticket if it is shown wrong; a note otherwise.
4. **Shown wrong, with a small fix:** `fix here`. Small is one commit with its test, in paths you have bounded, needing no Shape or Design step the ticket has not run. The work is open now, and left as a note it stays wrong until the person asks again.
5. **Anything else** is a `note`.

**The whole.** What you take in, added up, leaves a ticket the person would still recognise as the one they asked for. Where it would not, keep what is nearest the ticket's change, on its ground first, and rule the rest that is shown wrong the next ticket. Everything one delivery rules the next ticket is one ticket, together.

A product choice a fix needs is no reason to rule an item out, and you decide none: write the choice under `## Questions`, naming its item. The decision judge answers before the fix round starts, and the builder gets the answer with the item.

**A note** is one line in the handoff with what shows it and the reason it was not fixed. It opens no ticket; the person turns it into one by saying so. A lead goes in the same list.

## When

When every verifier of the delivery has returned; an urgent item is ruled at once, on its own. What is ruled `fix here` joins the verifier's findings in the one fix round, each as its own commit with its own test. When new items arrive afterward, a fresh judge rules on those items with the earlier rulings in view. Revisit an earlier item only when new evidence changes it. Discovery time never determines whether an item is a finding, a ticket or a note.

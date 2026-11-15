---
name: triage
description: Decide what becomes of everything found while working on a ticket (fix it here, open a hotfix or next ticket, note it in the handoff), once, by one fresh judge who sees all of it together, so related bugs get fixed without the ticket or the backlog growing. Use when reporting something a ticket did not ask for, and when judging what was reported.
---

# What a found item becomes

Work on a ticket turns up things it did not ask for. The workers report them. One fresh judge places them all, once, with the whole ticket in view.

## What is not a found item

- **What this change broke.** Something right on the base and wrong on the change is a finding: it is fixed in the ticket, always. Which it is, is shown by running it on both; when that cannot be shown, it is a finding.
- **What the outcome needs.** While an acceptance check fails, the ticket is not done.

Everything else the work met that is wrong, and was so before the change, is a found item. An idea for something new is reported the same way, without `shown`, and is always a note.

## Reporting one: every worker

You place nothing and fix nothing you found. Write one line each under `## Found on the way` in your file:

`- <what is wrong, and for whom> | shown: <the run, query or reproduction> | where: <every path its fix needs> | urgent`

- **Shown** by running something. One the project's environments cannot show is a **lead**: say what would show it.
- **Where** is found by searching each place the thing is defined or shown, never assumed from the one place it was met.
- **Urgent** only when a fact people act on is wrong where real users are today. Say so in your return line too.
- You do not go looking: report what the ticket's own work met. Taste, "could be better" with no failing state behind it, is not reported.

## Judging them: the triage judge

Two rulings are facts, not judgement:

1. **A fact people act on, wrong where real users are today:** its own hotfix ticket, opened at once. A product with no users yet has none of these.
2. **A fix that touches a boundary,** by the project definition's map: never fixed here. The next ticket if it is shown wrong; a note otherwise.

Every other item is `fix here` or `note`, weighed together:

- **Towards fixing here:** the person trying the delivery will meet it, on the ticket's ground; its fix sits in files the ticket already changes, or beside them; it is cheap to fix and check now, and would be dear to find again. Where the verifier asked for no fix round, a fix here costs one: weigh that too.
- **Towards a note:** its fix needs a design, a product choice nobody has made, or another part of the product; it was met only where shared code is used, or while checking another item; fixing it would need acceptance checks of its own.
- **The whole.** What you take in, added up, leaves a ticket the person would still recognise as the one they asked for, with its own change the larger part. When the items are many, take those nearest the ticket's change and note the rest.

A product choice is never decided to make room for a fix: the item is a note that carries the question.

**A note** is one line in the handoff with what shows it and the reason it was not fixed. It opens no ticket; the person turns it into one by saying so. A lead goes in the same list.

## When

When every verifier of the delivery has returned; an urgent item is ruled at once, on its own. What is ruled `fix here` joins the verifier's findings in the one fix round, each as its own commit with its own test. What is found after that is a note unless it is urgent; the handoff lists it.

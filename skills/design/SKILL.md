---
name: design
description: Design and judge anything a person will see, from a whole page to one component, starting from the questions the person brings so the screen answers them through structure rather than sentences. Use when shaping, building, reading or verifying a change people will see.
---

# Screens that answer their person

A screen answers the questions its person arrives with. It is not a rendering of the record it loads, and it is not finished by explaining itself.

## The method

1. **Questions before layout.** Write who arrives and from where, the few questions they bring in the order they matter, the one or two things they do here, and what a wrong reading costs. How the data is stored or returned is never the layout.
2. **Rank the facts and let rank show.** The answers to the questions come first, as prominent values or computed answers ("Overdue by 12 days", not a due date to subtract from). Reference facts sit below them. Rare or technical facts go behind a named disclosure. A field that answers no question is not on the screen.
3. **Structure before style.** For a new or restructured screen, build two or three directions that differ in their organising idea (by what needs a decision, by the thing's life cycle, by comparison), rough, in the real app, on the hardest realistic scenario. Compare them by the questions. Take references from the screens the project lists as accepted.
4. **A state changes what a place shows.** List the axes that change the screen (how much data, the role, the plan, a pending change, loading or failed) and, for each region, what each axis does to it: hides it, disables it, swaps its value, replaces it. A state never adds a paragraph. A person who may not do something is not offered it, and is not told about it unless knowing changes what they do next.
5. **Words come last.** Before adding a sentence, try in order: reorder, group, emphasise, a status component, a better label. A sentence that is still needed names the question it answers, is one short line, and sits where its case occurs, on the affected row or behind a disclosure, never as a standing note. Words that grow each time someone fails to understand the screen mean its structure is wrong. The words an action answers with (an error, a confirmation of what cannot be undone) and notices the law or the money requires are words by nature.

## Craft

- One focal point per view: the answer the person came for, and the next step. Things that look equally strong are read as equally important.
- Group by meaning and separate by space before lines and boxes. Like things look alike; a different look means a different meaning.
- One primary action, the step the person most likely needs. Danger styling only for what is destructive or cannot be undone.
- The person's words and formats: money with its currency, dates in their calendar, states as words, one name for one thing everywhere.
- Every action answers where the person is looking. Prevent errors before explaining them; confirm only what cannot be undone.
- Everyone can use it at every size: contrast, meaning never by colour alone, keyboard and focus order, touch targets, layouts that mirror for right-to-left languages, reflow rather than shrink.
- It belongs to the product: the design system's tokens and components. A new pattern is a product decision.

## Judging a screen

A screen is judged by a closed question with a right answer, never by "find issues".

- **The reading test.** A fresh reader gets the screenshots and the questions only, and answers each for each scenario. The answers are compared with a key written from the seeded data before the screen was built.
- **What counts:** a wrong answer; an answer that would lead to a wrong or irreversible action; an answer found only in a sentence, which counts as not given; a captured state that is broken, clipped or misleading; a design-system or accessibility rule broken, found by lint or a script.
- **What does not count:** "could be clearer", a preference between layouts that both pass, wording, anything with no wrong answer behind it.
- **The fix changes what the screen shows.** Where only a sentence could answer a question, either nobody asks that question there, or the product is missing an action and that is a product question. A question leaves the sheet only when every reader marked it not asked there, and the person is shown each one that left.
- **Words are counted.** A fix that grows the visible words of a state is looked at again for structure. This is a signal, not a limit.
- **Two looks anyone can take:** cover the sentences, and the person can still tell what is true and what to do; blur the page, and the loudest thing is the answer they came for.

## After the person rejects a screen

Restate the question sheet with them, then derive the directions again from it, not from the findings against the last version. Write the rejection into the project's design reference as a before and after with the principle behind it.

The project supplies its specifics: its design system, the screens the person has accepted and why, which composition suits which job, its state axes and how to seed them, how screens are captured with their visible text, and the rules learned from rejections.

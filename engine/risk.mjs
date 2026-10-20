// Risk (design section 2, "Risk", D94): every first seat judges how much harm the change could do if it is wrong and
// names what it needs to be confident (`risk.needs`). The engine never judges risk. This module folds the judgements of
// an item's reviews into the needs that stand, and normalises a need's spelling; flow.mjs checks each need's evidence.
export const NEEDS = Object.freeze({ second: 'second-review', test: 'failing-test', read: 'diff-read' });
export const KNOWN_NEEDS = Object.freeze(Object.values(NEEDS));
// The second seats are `second` and, above the split size, `second:<area>`; every other seat is a first seat.
export const firstSeat = (seat) => !String(seat ?? 'whole').startsWith('second');

// A need as written, mapped to a known one when its spelling only differs by case, separators or "the person's"
// (named failure: "diff read" became free text the second reviewer marked met, so the person never read the diff).
export function normNeed(text) {
  const t = String(text ?? '').trim();
  const key = t.toLowerCase().replace(/^(the\s+)?(person'?s|persons|human'?s)\s+/, '').replace(/[\s_.-]+/g, '-').replace(/^-|-$/g, '');
  return KNOWN_NEEDS.includes(key) ? key : t;
}

// The standing needs of an item, in review order across its attempts (`reviews`: review.recorded payloads, oldest
// first): a first seat's needs join them, and only a recorded `drop` lowers one. `latest` is the last first-seat
// judgement, `shown` the one the person is shown; `dropped` lists every drop with its reason.
export function foldRisk(reviews) {
  const standing = new Map();
  const dropped = [];
  let latest = null;
  const highWhy = [];
  for (const r of reviews) {
    if (!firstSeat(r.seat) || !r.risk) continue;
    latest = r.risk;
    if (r.risk.level === 'high' && !highWhy.includes(r.risk.why)) highWhy.push(r.risk.why);
    for (const n of r.risk.needs ?? []) if (!standing.has(n)) standing.set(n, r.risk.why);
    for (const d of r.risk.drop ?? []) {
      if (!standing.has(d.need)) continue;
      standing.delete(d.need);
      dropped.push({ need: d.need, why: d.why });
    }
  }
  const needs = [...standing.keys()];
  // What the person is shown: the last high judgement whose needs still stand (a later low one does not lower them),
  // else the last judgement.
  const shown = [...reviews].reverse().find((r) => firstSeat(r.seat) && r.risk?.level === 'high' && (r.risk.needs ?? []).some((n) => standing.has(n)))?.risk ?? latest;
  return { needs, standing, dropped, latest, shown, high: highWhy.length > 0, why: highWhy, free: needs.filter((n) => !KNOWN_NEEDS.includes(n)) };
}

// One line for the person and the tracker: the judgement shown and every dropped need. Null before any judgement.
export function riskLine(reviews) {
  const r = foldRisk(reviews);
  if (!r.latest) return null;
  const drops = r.dropped.length ? `; dropped: ${r.dropped.map((d) => `${d.need} (${d.why})`).join('; ')}` : '';
  return `Reviewer's risk: ${r.shown.level} – ${r.shown.why}${drops}`;
}

// The line for an item, from the reviews of all its attempts.
export async function itemRiskLine(root, item) {
  const { itemHistory } = await import('./attempt.mjs');
  return riskLine((await itemHistory(root, item)).flatMap((h) => h.events.filter((e) => e.type === 'review.recorded').map((e) => e.data)));
}

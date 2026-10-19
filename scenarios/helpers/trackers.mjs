// Fake trackers for 0.8 scenarios. Both implement the TrackerDriver of engine/contract.mjs over one JSON state file:
//   { issues: [{ id, title, body, status, labels, open, comments: [{ body, marker }] }], unreadable: [ids], log: [..], next }
// - fakeTracker(file): the driver in-process (a test passes it as a double, or reads the file after a run).
// - writeTrackerModule(dir, rel, file): the same driver as a tracker module file (`ticketing.tracker: { module }`), for a
//   spawned `wf` to import. Every operation is logged, so a test asserts idempotency (one write per marker) and
//   search-before-write order from the log.
// An id in `unreadable` reads with `labels: null`: the engine must treat its label filters as pending, never false.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DRIVER_SOURCE = `
import fs from 'node:fs';
export function driverOver(file, prefix = 'TK') {
  const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const save = (s) => fs.writeFileSync(file, JSON.stringify(s, null, 2));
  const step = (fn) => { const s = load(); const r = fn(s); save(s); return r; };
  const view = (s, i) => ({ id: i.id, title: i.title, body: i.body, status: i.status, url: 'fake://' + i.id, labels: s.unreadable.includes(i.id) ? null : [...i.labels] });
  return {
    async read(id) { return step((s) => { s.log.push('read ' + id); const i = s.issues.find((x) => x.id === id); return i ? view(s, i) : null; }); },
    async normalise(raw) { const m = new RegExp('^' + prefix + '-?(\\\\d+)$', 'i').exec(String(raw).trim()); return m ? prefix + '-' + Number(m[1]) : null; },
    async search({ text, marker } = {}) {
      return step((s) => {
        s.log.push('search ' + (marker ? 'marker ' + marker : 'text ' + text));
        return s.issues.filter((i) => (marker ? (i.body.includes(marker) || i.comments.some((c) => c.body.includes(marker))) : i.open && (i.title.includes(text) || i.body.includes(text)))).map((i) => view(s, i));
      });
    },
    async create({ title, body, team = null, status = 'Backlog', label = null, marker }) {
      if (!marker || !body.includes(marker)) throw new Error('create: the body must carry the marker');
      return step((s) => { const id = prefix + '-' + s.next++; s.issues.push({ id, title, body, team, status, labels: label ? [label] : [], open: true, comments: [] }); s.log.push('create ' + id + ' ' + marker); return { id }; });
    },
    async setStatus(id, status) { return step((s) => { const i = s.issues.find((x) => x.id === id); if (!i) throw new Error('no issue ' + id); i.status = status; s.log.push('status ' + id + ' ' + status); }); },
    async comment(id, { body, marker, files = [] }) {
      if (!marker || !body.includes(marker)) throw new Error('comment: the body must carry the marker');
      return step((s) => { const i = s.issues.find((x) => x.id === id); if (!i) throw new Error('no issue ' + id); i.comments.push({ body, marker, files }); s.log.push('comment ' + id + ' ' + marker); });
    },
  };
}
`;

export const DEFAULT_ISSUES = [
  { id: 'TK-1', title: 'First item', body: 'The first item of the fixture project.', status: 'Todo', labels: [], open: true, comments: [] },
  { id: 'TK-2', title: 'Second item', body: 'The second item.', status: 'Todo', labels: ['urgent'], open: true, comments: [] },
  { id: 'TK-3', title: 'Item with unreadable labels', body: 'Labels cannot be read.', status: 'Todo', labels: ['urgent'], open: true, comments: [] },
];

export function writeTrackerState(file, { issues = DEFAULT_ISSUES, unreadable = ['TK-3'] } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = Math.max(0, ...issues.map((i) => Number(/\d+$/.exec(i.id)?.[0] ?? 0))) + 1;
  fs.writeFileSync(file, JSON.stringify({ issues: structuredClone(issues), unreadable, log: [], next }, null, 2));
  return file;
}

// The driver module's source, with the state file baked in: `export default driverOver(<file>)`.
const moduleSource = (stateFile, prefix) => `${DRIVER_SOURCE}\nexport default driverOver(${JSON.stringify(stateFile)}, ${JSON.stringify(prefix)});\n`;

// In-process fake tracker. Returns { driver, file, state(), log() }.
export async function fakeTracker(file, { issues, unreadable, prefix = 'TK' } = {}) {
  writeTrackerState(file, { issues, unreadable });
  const mod = path.join(path.dirname(file), `driver-${path.basename(file, '.json')}.mjs`);
  fs.writeFileSync(mod, moduleSource(file, prefix));
  const driver = (await import(`${pathToFileURL(mod).href}?t=${Date.now()}`)).default;
  const state = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { driver, file, state, log: () => state().log };
}

// The fake as a tracker module at `<dir>/<rel>` (a repo's `.workflow/tracker.mjs`, as the fixture adapter names it).
export function writeTrackerModule(dir, rel, stateFile, { issues, unreadable, prefix = 'TK' } = {}) {
  if (!fs.existsSync(stateFile)) writeTrackerState(stateFile, { issues, unreadable });
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, moduleSource(stateFile, prefix));
  return file;
}

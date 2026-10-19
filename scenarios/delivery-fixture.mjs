// Stream 3 scenario fixture: an in-memory ledger (doubles for stream 5), a normalised adapter (a double for stream 6),
// and attempt worktrees made with git, so tracker and delivery are tested without the other streams.
import fs from 'node:fs';
import path from 'node:path';
import { setDoubles, clearDoubles, worktreeDir, branchName } from '../engine/contract.mjs';
import { YAML, makeProject, git, writeTrackerModule } from './helpers/index.mjs';

// The adapter as loadAdapter returns it: every key present.
export function normalised(raw, root) {
  return {
    version: 2,
    name: raw.name,
    root,
    source: { file: path.join(root, '.workflow', 'project.yaml'), location: 'repo', hash: 'x' },
    requires: { connectors: [], tools: [], skills: [] },
    repos: raw.repos.map((r) => ({ remote: 'origin', provision: { clone: [], fingerprint: [], install: null, copyIgnored: [] }, kinds: { tests: [], other: [] }, ...r })),
    components: raw.components ?? [],
    invariants: null,
    rules: [],
    screens: raw.screens ?? null,
    review: raw.review ?? { diffRead: 'before' },
    risk: { confirmed: true, paths: [] },
    ticketing: { tracker: null, via: 'none', idPattern: null, take: null, followUps: { mode: 'off' }, operations: {}, ...(raw.ticketing ?? {}) },
    delivery: { landing: 'queue', order: raw.repos.map((r) => r.name), authority: { push: 'person', mergeRequest: 'person', merge: 'person' }, stages: [], ...(raw.delivery ?? {}) },
    models: {},
    budget: raw.budget,
    onboarded: { at: null, engine: null, hashes: {} },
  };
}

// An in-memory ledger: append / readEvents / attemptState / listAttempts over one map of attempt → entries.
export function memLedger() {
  const ledgers = new Map();
  let clock = Date.parse('2026-01-05T09:00:00.000Z');
  const tick = () => new Date((clock += 60000)).toISOString();
  const append = async (root, attempt, type, data, actor) => {
    const list = ledgers.get(attempt) ?? [];
    if (!list.length && type !== 'attempt.started') throw new Error(`first event of ${attempt} must be attempt.started`);
    const e = { seq: list.length + 1, at: tick(), type, actor, data, schema: 2 };
    list.push(e);
    ledgers.set(attempt, list);
    return e;
  };
  const readEvents = async (root, attempt) => {
    if (!ledgers.has(attempt)) throw new Error(`no attempt ${attempt}`);
    return ledgers.get(attempt);
  };
  const attemptState = async (root, attempt) => {
    const list = await readEvents(root, attempt);
    const s = { id: attempt, schema: 2, open: true, outcome: null, owner: null, repos: {}, stages: [], hold: null, stageResults: {}, landings: [] };
    for (const e of list) {
      if (e.type === 'attempt.started') Object.assign(s, { item: e.data.item, n: e.data.n, repos: e.data.repos, stages: e.data.stages, owner: e.actor });
      if (e.type === 'hold') s.hold = { reason: e.data.reason, quote: e.data.quote, at: e.at };
      if (e.type === 'release') s.hold = null;
      if (e.type === 'stage') s.stageResults[e.data.index] = { ...e.data, at: e.at };
      if (e.type === 'landing') s.landings.push({ ...e.data, at: e.at });
      if (e.type === 'attempt.closed') Object.assign(s, { open: false, outcome: e.data.outcome });
    }
    return s;
  };
  const listAttempts = async (root, { item } = {}) => [...ledgers.keys()].filter((a) => !item || a.startsWith(`${item}.`));
  return { ledgers, append, readEvents, attemptState, listAttempts, events: (a) => ledgers.get(a) ?? [], stageEvents: (a) => (ledgers.get(a) ?? []).filter((e) => e.type === 'stage') };
}

// A project with a tracker module, an adapter double and an in-memory ledger. `ticketing`/`delivery` merge into the
// fixture adapter. Returns { p, adapter, ledger, trackerFile, startAttempt(item, n, opts), doubles(extra) }.
export function deliveryProject({ ticketing = {}, delivery = {}, issues, unreadable } = {}) {
  const p = makeProject({ adapter: true });
  const raw = JSON.parse(JSON.stringify(adapterRaw(p)));
  raw.ticketing = { ...raw.ticketing, ...ticketing };
  raw.delivery = { ...raw.delivery, ...delivery };
  const adapter = normalised(raw, p.root);
  const trackerFile = path.join(p.tmp, 'tracker.json');
  writeTrackerModule(p.repos.server.dir, '.workflow/tracker.mjs', trackerFile, { issues, unreadable });
  const ledger = memLedger();
  const state = () => JSON.parse(fs.readFileSync(trackerFile, 'utf8'));
  // Start an attempt: a worktree per repo on `wf/<attempt>` at its base, and attempt.started with the stage snapshot.
  const startAttempt = async (item, n = 1, { stages = adapter.delivery.stages, owner = null, repos = Object.keys(p.repos) } = {}) => {
    const attempt = `${item}.${n}`;
    const recs = {};
    for (const name of repos) {
      const r = p.repos[name];
      const wt = worktreeDir(p.root, attempt, name);
      git(r.dir, ['worktree', 'add', '--quiet', '-b', branchName(attempt), wt, r.base]);
      recs[name] = { branch: branchName(attempt), base: r.base, baseSha: p.head(name), worktree: wt };
    }
    await ledger.append(p.root, attempt, 'attempt.started', { item, n, repos: recs, stages: structuredClone(stages), adapter: 'x', engine: '0.8.0' }, owner);
    return attempt;
  };
  const doubles = (extra = {}) => setDoubles({
    loadAdapter: async () => adapter,
    append: ledger.append,
    readEvents: ledger.readEvents,
    attemptState: ledger.attemptState,
    listAttempts: ledger.listAttempts,
    callerSession: async () => null,
    connectorCalls: async () => [],
    mergeFacts: async () => [],
    ...extra,
  });
  return { p, adapter, ledger, trackerFile, tracker: state, startAttempt, doubles, cleanup: () => { clearDoubles(); p.cleanup(); } };
}

// The fixture adapter makeProject wrote.
const adapterRaw = (p) => YAML.parse(fs.readFileSync(p.adapterFile, 'utf8'));

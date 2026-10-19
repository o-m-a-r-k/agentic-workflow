// Stream 7 fixtures: an invented module-heavy 0.7 project, the hardest migration shape. Three repos with different bases;
// its tests run in containers through a module, its tracker and its delivery are modules of its own under `.workflow/`
// (a folder in the `core` repo that the project root links to), and product code imports workflow material.
// Nothing here is any real project's: names, bases, statuses and labels are made up.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, clearDoubles, setDoubles } from '../engine/contract.mjs';
import { YAML, makeProject, writeLegacyLedgers, STORY } from './helpers/index.mjs';

const ENGINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'engine');

export const MODULE_REPOS = [
  {
    name: 'core', base: 'trunk', files: {
      'package.json': JSON.stringify({ name: 'core', scripts: { lint: 'lint .', test: 'unit', 'test:e2e': 'docker compose run e2e' } }, null, 2),
      'src/modules/tally/total.mjs': 'import Decimal from "decimal.js";\nexport const total = (xs) => xs.reduce((a, b) => a.plus(new Decimal(b)), new Decimal(0)).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);\n',
      'src/modules/relay/send.mjs': 'import axios from "axios";\nexport const send = (url, body) => axios.post(url, body);\n',
      'src/modules/relay/hook.controller.mjs': 'export const onWebhook = (req) => req.body;\n',
      'src/modules/access/guard.mjs': 'export const allowed = (user, action) => hasPermission(user, action);\n',
      'src/modules/notes/list.mjs': 'export const list = () => [];\n',
      'src/migrations/0001_init.sql': 'CREATE TABLE notes (id int);\n',
      'test/tally/total.spec.mjs': '// spec\n',
      'test/support/capture.mjs': 'import { shoot } from "../../.workflow/browser/shots.mjs";\nexport default shoot;\n',
      'AGENTS.md': '# core\n\nRun `wf batch create` for shared gates.\nUse `wf status` to see what is next.\n',
      '.workflow/steps/runner.mjs': 'import { shoot } from "../browser/shots.mjs";\nexport default async () => ({ pass: Boolean(shoot) });\n',
      '.workflow/steps/tk7.mjs': 'export default async () => ({ pass: true });\n',
      '.workflow/tracker/board.mjs': 'export default {};\n',
      '.workflow/delivery/review-request.mjs': 'export default {};\n',
      '.workflow/browser/shots.mjs': 'export const shoot = () => {};\n',
      '.workflow/invariants.md': '# Invariants\n\n- Tally totals are exact to the cent and never rounded twice.\n- Relay writes are idempotent.\n',
    },
  },
  {
    name: 'panel', base: 'release', files: {
      'package.json': JSON.stringify({ name: 'panel', scripts: { lint: 'lint .', test: 'unit', shots: 'shoot' } }, null, 2),
      'src/pages/home.mjs': 'export const home = "/";\n',
      'test/home.spec.mjs': '// spec\n',
    },
  },
  {
    name: 'handset', base: 'dev', files: {
      'ios/Podfile': "platform :ios, '15.0'\n",
      'ios/App.xcodeproj/project.pbxproj': '// project\n',
      'README.md': '# handset\n',
    },
  },
];

// The 0.7 adapter (schema 1), written in core/.workflow/ and reached through the root's `.workflow` link, as 0.7 kept it.
export const ADAPTER_07 = {
  version: 1,
  enabled: true,
  name: 'modular',
  engine: '0.x',
  adapterRepo: 'core',
  instructionFiles: ['core/AGENTS.md'],
  repos: [
    { name: 'core', path: 'core', base: 'trunk', packages: [{ path: '.', sharedInfra: ['package.json'], docsOnly: ['**/*.md'] }], provision: { clone: [], fingerprint: ['package.json'], install: null, copyIgnored: [] } },
    { name: 'panel', path: 'panel', base: 'release', packages: [{ path: '.', docsOnly: ['**/*.md', 'docs/**'] }] },
    { name: 'handset', path: 'handset', base: 'dev' },
  ],
  components: [{ id: 'panel', kind: 'web', repo: 'panel', dependsOn: [{ component: 'core', via: 'http', contract: 'core/src/**/*.controller.mjs' }] }],
  lanes: ['quick', 'standard', 'batch'],
  classes: { review: { claude: { model: 'm1', effort: 'high' } } },
  roles: { reviewer: { class: 'review' } },
  tracker: { kind: './tracker/board.mjs', via: 'connector', idPrefix: 'TK', statuses: { started: 'Doing', delivered: 'Testing', deployed: 'Finished', done: 'Finished' }, statusByLabel: { delivered: { Urgent: 'Verify' } }, deliveredComment: 'ready: {summary}' },
  delivery: { kind: './delivery/review-request.mjs', deployment: { labels: ['Urgent'], where: 'live' } },
  gate: {
    maxParallelSteps: 2,
    leases: { containers: 2, screen: 1 },
    steps: [
      { id: 'core-lint', repo: 'core', tier: 'light', plugin: './steps/runner.mjs', lease: 'containers', command: ['lint'], inputs: ['**'] },
      { id: 'core-unit', repo: 'core', tier: 'light', plugin: './steps/runner.mjs', lease: 'containers', command: ['unit'], inputs: ['**'] },
      { id: 'core-e2e', repo: 'core', tier: 'heavy', plugin: './steps/runner.mjs', lease: 'containers', command: ['e2e'], inputs: ['**'] },
      { id: 'tk7-proof', repo: 'core', tier: 'heavy', plugin: './steps/tk7.mjs', lease: 'containers', inputs: ['**'] },
      { id: 'panel-unit', repo: 'panel', tier: 'light', run: 'npm test', inputs: ['**'] },
      { id: 'panel-shots', repo: 'panel', tier: 'heavy', run: 'npm run shots {select}', lease: 'screen', artifacts: ['shots/*.png'], inputs: ['**'] },
    ],
  },
  review: { rules: [{ id: 'panel-pages', repo: 'panel', paths: ['src/pages/**'], read: ['docs/pages.md'] }] },
  invariants: 'invariants.md',
  quality: ['Every page reads well at phone width.', 'Totals cover the whole set, never one page.'],
};

// TK-7.1: a 0.7 attempt that registered `tk7-proof` as its own validation step, then closed.
const STORY_07 = {
  ...STORY,
  'TK-7.1': [
    ['2026-01-04T09:00:00.000Z', 'admitted', { id: 'TK-7.1', item: 'TK-7', lane: 'standard', repos: { core: { branch: 'wf/TK-7.1', base: 'trunk' } } }],
    ['2026-01-04T09:30:00.000Z', 'validation.added', { commit: 'c'.repeat(40), steps: [{ id: 'tk7-proof', definition: { repo: 'core' } }], criteria: ['C1'], reason: 'proof' }],
    ['2026-01-04T12:00:00.000Z', 'closed', { reason: 'delivered' }],
  ],
};

export function makeModuleProject() {
  const p = makeProject({ name: 'modular', repos: MODULE_REPOS, adapter: false });
  fs.mkdirSync(path.join(p.repos.core.dir, '.workflow'), { recursive: true });
  fs.writeFileSync(path.join(p.repos.core.dir, '.workflow', 'project.yaml'), YAML.stringify(ADAPTER_07));
  fs.symlinkSync(path.join(p.repos.core.dir, '.workflow'), path.join(p.root, '.workflow'));
  writeLegacyLedgers(p.root, STORY_07);
  return p;
}

// Doubles for stream 5 (ledger) over the files themselves, recording appends.
export function ledgerDoubles(appended = []) {
  const dir = (root) => path.join(root, '.wf-evidence', 'attempts');
  const file = (root, id) => path.join(dir(root), id, 'ledger.jsonl');
  return {
    listAttempts: async (root) => (fs.existsSync(dir(root)) ? fs.readdirSync(dir(root)).filter((id) => fs.existsSync(file(root, id))).sort() : []),
    readEvents: async (root, id) => fs.readFileSync(file(root, id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    append: async (root, id, type, data, actor) => {
      const entry = { seq: 0, at: new Date().toISOString(), type, actor, data, schema: 2 };
      appended.push({ id, ...entry });
      fs.appendFileSync(file(root, id), `${JSON.stringify(entry)}\n`);
      return entry;
    },
  };
}

// Stream 6 (config) once it is built; until then a small stand-in: the adapter as written, with the keys this stream reads.
const configBuilt = fs.readFileSync(path.join(ENGINE, 'config.mjs'), 'utf8').includes('implements08');
export function configDoubles() {
  if (configBuilt) return {};
  const fileOf = (root, env) => {
    const repo = path.join(root, '.workflow', 'project.yaml');
    if (fs.existsSync(repo)) return { file: repo, location: 'repo' };
    const dir = path.join(env.WF_USER_DIR, 'projects');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const raw = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (raw.root === root) return { file: path.join(dir, f), location: 'user' };
    }
    throw new Error(`no adapter for ${root}`);
  };
  return {
    checkAdapter: async (raw) => (raw.version === 2 && Array.isArray(raw.repos) && raw.repos.every((r) => r.base) ? [] : ['invalid']),
    loadAdapter: async (root, { env = process.env } = {}) => {
      const { file, location } = fileOf(root, env);
      const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
      if (raw.version !== 2) throw new Error('schema 1: run `wf init --from-07`');
      return {
        ...raw, root, source: { file, location, hash: canonicalJson(raw) },
        repos: raw.repos.map((r) => ({ remote: 'origin', tests: { fast: null, full: null }, ...r })),
        rules: raw.rules ?? [], requires: { connectors: [], tools: [], skills: [], ...(raw.requires ?? {}) },
        screens: { routes: null, capture: null, ...(raw.screens ?? {}) },
        risk: raw.risk === 'none' ? { confirmed: true, paths: [] } : Array.isArray(raw.risk) ? { confirmed: true, paths: raw.risk } : { confirmed: false, paths: [] },
        ticketing: { operations: {}, ...(raw.ticketing ?? {}) },
        delivery: { stages: [], ...(raw.delivery ?? {}) },
        budget: { adapter: { rules: null, risk: null, modules: null, operationWords: null, ...(raw.budget?.adapter ?? {}) } },
        invariants: raw.invariants ?? null,
      };
    },
    adapterBudget: async (a) => {
      const counts = { rules: a.rules.length, risk: a.risk.paths.length, modules: 0, operationWords: Object.values(a.ticketing.operations).join(' ').split(/\s+/).filter(Boolean).length };
      const limits = a.budget.adapter;
      return { counts, limits, over: Object.keys(counts).filter((k) => limits[k] !== null && counts[k] > limits[k]) };
    },
  };
}

export function useDoubles(extra = {}) {
  setDoubles({ ...configDoubles(), ...extra });
}
export { clearDoubles };

// A CommandContext for in-process handler calls.
export const ctxFor = (p, over = {}) => ({ cwd: p.root, root: p.root, env: { ...process.env, ...p.env }, actor: null, json: false, ...over });
export const readAdapter = (file) => YAML.parse(fs.readFileSync(file, 'utf8'));

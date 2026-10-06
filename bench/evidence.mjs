// Evidence integrity benchmark: one attempt with realistic evidence (1,300+ screenshots of 0.2-1.2 MB, 20 logs of
// 5-50 MB, 5,000 small files), then the time of each command. Run: `node bench/evidence.mjs [--keep]`. Not part of
// `npm test` (it writes about 3 GB to the temporary folder and removes it unless --keep).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, wf } from '../scenarios/helpers.mjs';

const SHOTS = 1320;
const LOGS = 20;
const SMALL = 5000;
// The step writes the screenshots into the worktree (collected by the artifacts glob) and the logs and small files into
// its scratch folder (copied into the evidence after the step). Content varies per file; sizes are spread evenly.
const gen = `
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const block = crypto.randomBytes(1 << 20);
const fill = (file, size, i) => { const fd = fs.openSync(file, 'w'); let left = size; const head = Buffer.from(String(i).padStart(16, '0'));
  fs.writeSync(fd, head); left -= head.length; while (left > 0) { const n = Math.min(left, block.length); fs.writeSync(fd, block, 0, n); left -= n; } fs.closeSync(fd); };
fs.mkdirSync('shots', { recursive: true });
for (let i = 0; i < ${SHOTS}; i++) fill(path.join('shots', 'shot-' + i + '.png'), Math.round((0.2 + (i % 100) / 100) * 1048576), i);
const ev = process.env.WF_EVIDENCE;
for (let i = 0; i < ${LOGS}; i++) fill(path.join(ev, 'log-' + i + '.log'), Math.round((5 + (i * 45) / (${LOGS} - 1)) * 1048576), i);
fs.mkdirSync(path.join(ev, 'small'), { recursive: true });
for (let i = 0; i < ${SMALL}; i++) fs.writeFileSync(path.join(ev, 'small', 'f-' + i + '.json'), JSON.stringify({ i }));
`;

const time = (label, fn) => {
  const t = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  rows.push([label, ms]);
  return r;
};
const rows = [];
const { base, root } = singleRepoProject('bench', { gate: { steps: [{ id: 'ui', repo: 'app', run: 'node gen.cjs', artifacts: ['shots/*.png'] }] }, lanes: ['quick', 'standard'] }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n', 'gen.cjs': gen });
const env = { env: { WF_EVIDENCE_FLAGS: process.env.WF_EVIDENCE_FLAGS ?? '1' } };
const run = (args) => ok(wf(root, args, env));
try {
  const e = run(['entry', '--item', 'BENCH-1', '--lane', 'quick', '--owner', 'o', '--json']).json();
  run(['plan', '--file', criteriaFile(base), '--attempt', e.id]);
  run(['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]);
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'bench\n' });
  const g = time('wf gate (writes and records the fixture)', () => run(['gate', '--attempt', e.id, '--json']).json());
  const shas = g.steps[0].artifacts.map((a) => a.sha256);
  const dir = path.join(root, '.wf-evidence', 'attempts', e.id);
  const du = spawnSync('du', ['-sk', dir], { encoding: 'utf8' }).stdout.split('\t')[0];
  const files = spawnSync('sh', ['-c', `find '${dir}' -type f | wc -l`], { encoding: 'utf8' }).stdout.trim();
  for (let i = 1; i <= 3; i++) time(`wf status (quick verify, run ${i})`, () => run(['status', '--attempt', e.id]));
  time('wf resume (quick verify)', () => run(['resume', '--attempt', e.id]));
  time('wf verify (full re-hash)', () => run(['verify', '--attempt', e.id]));
  time('wf handoff reviewer (full)', () => run(['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  time('wf review (full)', () => run(['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: shas })), '--attempt', e.id]));
  time('wf accept (full + re-check before recording)', () => run(['accept', '--attempt', e.id]));
  time('wf deliver (full + re-check before pushing)', () => run(['deliver', '--attempt', e.id]));
  time('wf status after delivery (quick)', () => run(['status', '--attempt', e.id]));
  console.log(`fixture: ${files} evidence files, ${(Number(du) / 1048576).toFixed(2)} GB (${SHOTS} screenshots 0.2-1.2 MB, ${LOGS} logs 5-50 MB, ${SMALL} small files); immutable flag ${env.env.WF_EVIDENCE_FLAGS === '0' ? 'off' : 'on'}; ${process.platform} ${process.arch}, node ${process.version}`);
  for (const [label, ms] of rows) console.log(`${(ms / 1000).toFixed(2).padStart(8)} s  ${label}`);
} finally {
  if (!process.argv.includes('--keep')) {
    spawnSync('chflags', ['-R', 'nouchg', base], { stdio: 'ignore' });
    spawnSync('chmod', ['-R', 'u+w', base], { stdio: 'ignore' });
    fs.rmSync(base, { recursive: true, force: true });
  }
}

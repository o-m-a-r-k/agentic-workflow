#!/usr/bin/env node
// Records the hello-ticket demo into docs/assets/, from a real run:
//   node scripts/record-demo.mjs
// - demo.txt: the captured output of `examples/hello-ticket/demo.sh`, unchanged except that the temporary folder is
//   shown as ~/demo and the home folder as ~ (no local paths in the repo);
// - demo.svg: that same text as an animated terminal (SVG animation, no script); only the pacing is chosen here;
// - social-preview.svg (1280x640) and, when a local Chrome or Chromium is found, social-preview.png rendered from it.
// No package is installed; nothing outside the temporary folder and docs/assets/ is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'assets');
const started = Date.now();
fs.mkdirSync(OUT, { recursive: true });

// 1. Run the demo for real.
const demoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-demo-')));
const run = spawnSync('sh', ['-c', 'exec sh "$0" 2>&1', path.join(ROOT, 'examples', 'hello-ticket', 'demo.sh')], { env: { ...process.env, DEMO_DIR: path.join(demoDir, 'run') }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) {
  process.stderr.write(run.stdout);
  console.error(`the demo failed (exit ${run.status}); nothing recorded`);
  process.exit(1);
}
const variants = (p) => [...new Set([p, p.replace(/^\/private\//, '/')])];
let text = run.stdout;
for (const p of variants(path.join(demoDir, 'run'))) text = text.split(p).join('~/demo');
for (const p of variants(os.homedir())) text = text.split(p).join('~');
text = text.replace(/~\/demo\/\//g, '~/demo/');
fs.writeFileSync(path.join(OUT, 'demo.txt'), text);

// 2. The animated terminal.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = text.replace(/\n$/, '').split('\n');
const W = 1100;
const LH = 18;
const ROWS = 30;
const PAD = 16;
const TOP = 40;
const H = TOP + ROWS * LH + PAD;
// Monospace at 13px is 0.6em per character: a line longer than the window wraps onto the next rows (indented), so
// nothing is clipped. Wrapped rows appear with their line.
const CHARS = Math.floor((W - 2 * PAD) / (13 * 0.6));
let t = 0.6;
const lines = [];
const at = [];
for (const l of out) {
  t += l.startsWith('$ ') ? 1.1 : l.startsWith('# ') ? 0.9 : l === '' ? 0.15 : 0.06;
  const parts = [];
  for (let rest = l; ; ) {
    parts.push(rest.slice(0, CHARS));
    rest = rest.slice(CHARS);
    if (!rest) break;
    rest = `    ${rest}`;
  }
  for (const p of parts) {
    lines.push({ text: p, kind: l });
    at.push(t);
  }
}
const total = t + 5;
const kt = (x) => (x / total).toFixed(4);
const color = (l) => (l.startsWith('$ ') ? 'var(--cmd)' : l.startsWith('# ') ? 'var(--note)' : /refused|failed|cannot review/.test(l) ? 'var(--bad)' : /passed|delivered|accepted|read back/.test(l) ? 'var(--good)' : 'var(--fg)');
const rows = lines.map((l, i) => {
  if (l.text.length > CHARS) throw new Error(`demo row ${i + 1} is ${l.text.length} characters, over ${CHARS}`);
  return `<text x="${PAD}" y="${TOP + (i + 1) * LH - 4}" fill="${color(l.kind)}" opacity="0">${esc(l.text)}<animate attributeName="opacity" values="0;1;0" keyTimes="0;${kt(at[i])};${kt(total - 0.01)}" calcMode="discrete" dur="${total.toFixed(2)}s" repeatCount="indefinite"/></text>`;
});
const shifts = [];
for (let i = ROWS; i < lines.length; i++) shifts.push([at[i], -(i - ROWS + 1) * LH]);
const values = ['0 0', ...shifts.map(([, y]) => `0 ${y}`), '0 0'].join(';');
const keyTimes = ['0', ...shifts.map(([x]) => kt(x)), kt(total - 0.01)].join(';');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="wf hello-ticket demo: a real run from entry to delivery">
<title>wf: one ticket from entry to delivery (real output)</title>
<style>
  svg { --bg: #0f1419; --bar: #1c232b; --fg: #d6dde4; --cmd: #ffffff; --note: #7f8b96; --good: #6fcf97; --bad: #ff7b72; }
  text { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
</style>
<rect width="${W}" height="${H}" rx="10" fill="var(--bg)"/>
<rect width="${W}" height="28" rx="10" fill="var(--bar)"/><rect y="18" width="${W}" height="10" fill="var(--bar)"/>
<circle cx="18" cy="14" r="5" fill="#ff5f57"/><circle cx="36" cy="14" r="5" fill="#febc2e"/><circle cx="54" cy="14" r="5" fill="#28c840"/>
<text x="${W / 2}" y="18" fill="var(--note)" text-anchor="middle">bash examples/hello-ticket/demo.sh</text>
<clipPath id="screen"><rect x="0" y="${TOP + 1}" width="${W}" height="${ROWS * LH}"/></clipPath>
<g clip-path="url(#screen)"><g>
<animateTransform attributeName="transform" type="translate" values="${values}" keyTimes="${keyTimes}" calcMode="discrete" dur="${total.toFixed(2)}s" repeatCount="indefinite"/>
${rows.join('\n')}
</g></g>
</svg>
`;
fs.writeFileSync(path.join(OUT, 'demo.svg'), svg);

// 3. The social preview: the project name and real lines from this run.
// Whole lines only, each a step of the story; refused if any is missing or too wide for the panel (no clipping).
const pick = (re) => {
  const l = out.find((x) => re.test(x));
  if (!l) throw new Error(`the demo output has no line matching ${re}`);
  return l;
};
const quote = [pick(/^\$ wf gate --attempt/), pick(/^wf gate: the gate runs after a clean code review/), pick(/^\(exit 75: refused\)$/), pick(/^\$ wf handoff reviewer --agent implementer-1/), pick(/cannot review it$/), pick(/^gate passed \(/), pick(/^delivered HT-1\.1: /)];
const PANEL = Math.floor((1120 - 2 * 28) / (20 * 0.6));
for (const l of quote) if (l.length > PANEL) throw new Error(`social preview line is ${l.length} characters, over ${PANEL}: ${l}`);
const social = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
<style>
  svg { --fg: #d6dde4; --cmd: #ffffff; --note: #7f8b96; --good: #6fcf97; --bad: #ff7b72; }
  .t { font: 600 64px ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #ffffff; }
  .s { font: 28px ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #b8c2cc; }
  .m { font: 20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
</style>
<rect width="1280" height="640" fill="#0f1419"/>
<text class="t" x="80" y="150">agentic-workflow</text>
<text class="s" x="80" y="205">Your agent says the tests passed. wf makes it prove it.</text>
<text class="s" x="80" y="245">Frozen criteria, a gate on the exact tree, an independent review, a verified handoff.</text>
<rect x="80" y="290" width="1120" height="${36 + quote.length * 34}" rx="10" fill="#1c232b"/>
${quote.map((l, i) => `<text class="m" x="108" y="${330 + i * 34}" fill="${color(l)}">${esc(l)}</text>`).join('\n')}
</svg>
`;
fs.writeFileSync(path.join(OUT, 'social-preview.svg'), social);

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (chrome) {
  const page = path.join(demoDir, 'social.html');
  fs.writeFileSync(page, `<!doctype html><html><body style="margin:0;background:#0f1419">${social}</body></html>`);
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(demoDir, 'chrome')}`, '--window-size=1280,640', `--screenshot=${path.join(OUT, 'social-preview.png')}`, `file://${page}`], { encoding: 'utf8', timeout: 30000 });
  // Headless Chrome can stay running after it wrote the screenshot; the timeout ends it and the file decides.
  const png = path.join(OUT, 'social-preview.png');
  console.log(fs.existsSync(png) && fs.statSync(png).mtimeMs >= started ? 'social-preview.png rendered with the local browser' : `social-preview.png not rendered: ${String(r.stderr ?? r.error).trim().split('\n').at(-1)}`);
} else console.log('no local Chrome or Chromium: social-preview.png not rendered (the SVG is written)');
fs.rmSync(demoDir, { recursive: true, force: true });
console.log(`recorded ${out.length} lines into ${path.relative(ROOT, OUT)}/: demo.txt, demo.svg, social-preview.svg`);

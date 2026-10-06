import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ok, singleRepoProject, tmp, wf } from './helpers.mjs';

// 0.1.24: named finding (0.1.23 review): path options validated one way and used another. Every path option is now
// resolved once (engine/paths.mjs), validated, and replaced by that resolved path before anything opens or writes it.
// This table runs every option against every attack form and checks the refusal and that the evidence is untouched.

const OPTIONS = {
  // option: argv that takes it (the rest of the command is valid enough; the refusal comes first)
  out: (v, id) => ['export', '--attempt', id, ...v('out')],
  csv: (v) => ['report', ...v('csv')],
  'handoffs-csv': (v) => ['report', ...v('handoffs-csv')],
  html: (v) => ['report', ...v('html')],
  dir: (v) => ['install', ...v('dir')],
  to: (v, id) => ['export', 'screenshots', '--attempt', id, ...v('to')],
  root: (v) => ['init', ...v('root')],
  file: (v, id) => ['plan', '--attempt', id, ...v('file')],
  capture: (v, id) => ['tracker', 'record', '--event', 'admitted', '--attempt', id, ...v('capture')],
  'summary-file': (v, id) => ['deliver', '--attempt', id, ...v('summary-file')],
  closure: (v, id) => ['review', '--attempt', id, ...v('closure')],
  'issue-file': (v) => ['entry', '--item', 'ENG-299', ...v('issue-file')],
  from: (v) => ['skills', 'update', 'x', ...v('from')],
};
const FILE_INPUTS = new Set(['file', 'capture', 'summary-file', 'closure', 'issue-file']);

function fixture() {
  const { base, root } = singleRepoProject('cli-paths', { gate: { steps: [] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-240', '--owner', 'o', '--json'])).json();
  const ev = path.join(root, '.wf-evidence');
  const inside = path.join(ev, 'attempts', e.id);
  fs.symlinkSync(path.join(ev, 'attempts', e.id), path.join(base, 'shortcut'));
  const outsideFile = path.join(base, 'outside.json');
  fs.writeFileSync(outsideFile, '{}');
  return { base, root, id: e.id, ev, inside, outsideFile };
}
const digest = (dir) => {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      h.update(`${path.relative(dir, p)}:${st.mode}:${st.size}\n`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
};

test('every path option x every attack form is refused before use, and the evidence is untouched', () => {
  const f = fixture();
  const attacks = [
    { name: 'inside the evidence', value: () => path.join(f.inside, 'x.json'), re: /is inside \.wf-evidence/ },
    { name: 'a link followed by ..', value: () => `${f.base}/shortcut/../x.json`, re: /is inside \.wf-evidence|resolves into \.wf-evidence/ },
    { name: 'a case variant', value: () => path.join(f.root, '.WF-EVIDENCE', 'x.json'), re: /is inside \.wf-evidence/ },
    { name: 'an invisible character', value: () => path.join(f.root, '.wf-​evidence', 'x.json'), re: /is inside \.wf-evidence/ },
    { name: 'empty', value: () => '', re: /is empty|needs a path/ },
    { name: 'a URL', value: () => `file://${f.outsideFile}`, re: /looks like a URL/ },
    { name: 'a ~ the shell did not expand', value: () => '~/x.json', re: /starts with `~`/ },
  ];
  const before = digest(f.ev);
  const forms = [
    { name: '--opt value', argv: (k, v) => [`--${k}`, v] },
    { name: '--opt=value', argv: (k, v) => [`--${k}=${v}`] },
  ];
  let ran = 0;
  for (const [k, build] of Object.entries(OPTIONS)) {
    for (const a of attacks) {
      for (const form of forms) {
        if (a.name === 'empty' && form.name === '--opt value') continue; // an empty argv word: covered by --opt=
        const r = wf(f.root, build((key) => form.argv(key, a.value()), f.id));
        assert.equal(r.code, 2, `--${k} ${a.name} (${form.name}): ${r.out}${r.err}`);
        assert.match(r.err, new RegExp(`--${k.replace(/[-]/g, '\\-')} .*${a.re.source}`), `--${k} ${a.name} (${form.name})`);
        ran += 1;
      }
    }
    // Repeated: validated once, used once; the ambiguity is refused.
    const r = wf(f.root, build((key) => [`--${key}`, f.outsideFile, `--${key}`, path.join(f.inside, 'x.json')], f.id));
    assert.equal(r.code, 2, `--${k} repeated`);
    assert.match(r.err, new RegExp(`--${k.replace(/[-]/g, '\\-')} given more than once`));
    // A flag where a path belongs (the next word was another option).
    const flag = wf(f.root, [...build((key) => [`--${key}`], f.id), '--json']);
    assert.equal(flag.code, 2, `--${k} with no value`);
    assert.match(flag.err, /needs a path/);
    ran += 2;
  }
  // File inputs: a trailing slash on a file, and a folder where a file is expected.
  for (const k of FILE_INPUTS) {
    const r = wf(f.root, OPTIONS[k]((key) => [`--${key}`, `${f.outsideFile}/`], f.id));
    assert.equal(r.code, 2);
    assert.match(r.err, /ends with a slash but names a file/);
    const d = wf(f.root, OPTIONS[k]((key) => [`--${key}`, f.base], f.id));
    assert.match(d.err, /is not a regular file/);
    ran += 2;
  }
  // A relative path from a working folder inside the evidence resolves there and is refused too.
  for (const k of ['out', 'csv', 'file', 'capture']) {
    const r = wf(f.inside, OPTIONS[k]((key) => [`--${key}`, 'x.json'], f.id));
    assert.notEqual(r.code, 0, `--${k} relative inside the evidence`);
    assert.match(r.err, /inside \.wf-evidence|resolves into/);
    ran += 1;
  }
  assert.ok(ran > 200, `ran ${ran}`);
  assert.equal(digest(f.ev), before, 'nothing in the evidence changed');
});

test('a path option is used as it was validated: the resolved path, not the raw argument', () => {
  const f = fixture();
  const out = tmp('cli-out');
  fs.mkdirSync(path.join(out, 'real'));
  fs.symlinkSync(path.join(out, 'real'), path.join(out, 'link'));
  // `link/../report.csv` is resolved as the OS does (the link's parent): the file lands next to `real`, where the
  // check looked, not where path.resolve would have put it.
  ok(wf(f.root, ['report', '--csv', `${out}/link/../report.csv`]));
  assert.ok(fs.existsSync(path.join(out, 'report.csv')));
  // A value starting with a single dash is a file name, not an option.
  ok(wf(f.root, ['report', '--csv', '-dash.csv']));
  assert.ok(fs.existsSync(path.join(f.root, '-dash.csv')));
});

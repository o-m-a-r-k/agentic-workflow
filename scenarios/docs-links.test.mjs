import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The README is a landing page whose reference lives in docs/ (0.4.1): a moved section must not leave a dead link.
const ROOT = path.resolve(import.meta.dirname, '..');
const pages = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

// GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes.
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
function anchors(file) {
  const out = new Set();
  let fence = false;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (l.trimStart().startsWith('```')) fence = !fence;
    const m = !fence && /^#{1,6} (.+)$/.exec(l);
    if (m) out.add(slug(m[1]));
  }
  return out;
}

test('every relative link in the README and docs points at a file and heading that exist', () => {
  const dead = [];
  for (const page of pages) {
    const file = path.join(ROOT, page);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [rel, hash] = target.split('#');
      const dest = rel ? path.resolve(path.dirname(file), rel) : file;
      if (!fs.existsSync(dest)) dead.push(`${page}: ${target} (no such file)`);
      else if (hash && dest.endsWith('.md') && !anchors(dest).has(hash)) dead.push(`${page}: ${target} (no such heading)`);
    }
  }
  assert.deepEqual(dead, []);
});

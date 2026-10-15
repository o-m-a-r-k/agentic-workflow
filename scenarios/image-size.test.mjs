// I-117: a runner labelled its desktop captures 1440 px wide but wrote 1280 px images (its window stayed smaller), cropping
// the right of every screen; the gate passed and the reviewer, handed no size, saw a plausible picture. Every screenshot
// now carries its measured width and height, from the gate, a plugin step or an import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitIn, ok, OUT_OF_ORDER, singleRepoProject, wf } from './helpers.mjs';
import { imageSize } from '../engine/image-size.mjs';

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w, h) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(w), ...u32(h), 8, 2, 0, 0, 0]);
const gif = (w, h) => Buffer.from([...Buffer.from('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
// SOI, an APP0 segment, then SOF0 (length 17, precision 8, height, width).
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const webpX = (w, h) => Buffer.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1), 0, 0]);

test('the size of PNG, JPEG, GIF and WebP screenshots is read from their headers; anything else is unknown', () => {
  assert.deepEqual(imageSize(png(1280, 800)), { width: 1280, height: 800 });
  assert.deepEqual(imageSize(jpeg(1440, 900)), { width: 1440, height: 900 });
  assert.deepEqual(imageSize(gif(390, 844)), { width: 390, height: 844 });
  assert.deepEqual(imageSize(webpX(2880, 1800)), { width: 2880, height: 1800 });
  assert.equal(imageSize(Buffer.from('en')), null, 'not an image');
  assert.equal(imageSize(png(1280, 800).subarray(0, 20)), null, 'cut short');
});

test('a gate screenshot carries its measured size in its evidence record (the record the reviewer\'s bundle lists)', () => {
  const write = `node -e "const fs=require('fs');fs.mkdirSync('shots',{recursive:true});fs.writeFileSync('shots/desktop.png',Buffer.from('${png(1280, 800).toString('base64')}','base64'))"`;
  const p = singleRepoProject('image-size', { gate: { steps: [{ id: 'ui', repo: 'app', run: write, artifacts: ['shots/*.png'] }] } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'IS-1', '--owner', 'o', '--json'])).json();
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const g = JSON.parse(ok(wf(p.root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).out);
  const shot = g.steps[0].artifacts[0];
  assert.deepEqual([shot.kind, shot.width, shot.height], ['screenshot', 1280, 800]);
});

// Stream 2: `wf screens` picks screens by facts (reverse imports → the project's routes module; a shared file adds the
// sentinel set in every language at the narrowest viewport), captures them with the project's command, records each
// image with the page's own lang and dir, and refuses a wrong width (screens:width) or duplicated bytes (screens:dup).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, commandHandler } from '../engine/contract.mjs';
import { DEFAULT_REPOS } from './helpers/index.mjs';
import { change, done, eventsOf, fixture, startAttempt, useDoubles } from './tests-doubles.mjs';

const CLIENT = {
  name: 'client', base: 'stable', files: {
    'src/common/button.mjs': 'export const button = 1;\n',
    'src/common/card.mjs': 'import { button } from "./button.mjs";\nexport const card = button;\n',
    'src/pages/items.mjs': 'import { card } from "../common/card.mjs";\nexport const page = "/items";\n',
    'src/pages/settings.tsx': 'import { button } from "@ui/button";\nexport default button;\n',
    'src/pages/other.mjs': 'export const page = "/other";\n',
    'tsconfig.json': '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@ui/*": ["src/common/*"] }, },\n}\n',
    'scripts/routes-of.mjs': 'export default async (files) => [["pages/items", "/items"], ["pages/settings", "/settings"], ["pages/other", "/other"]].filter(([f]) => files.some((x) => x.includes(f))).map(([, r]) => r);\n',
    'README.md': '# client\n',
    // A capture module: the same fake images, returned as the manifest; it notes the folder it was given and its own copy.
    'scripts/capture-mod.mjs': 'import fs from "node:fs";\nimport path from "node:path";\nexport const COPY = "base";\nexport default async ({ cwd, out, viewport, lang, dir, routes }) => {\n  fs.writeFileSync(path.join(out, "ctx.json"), JSON.stringify({ cwd, copy: COPY }));\n  return routes.map((route, i) => {\n    const head = Buffer.alloc(24);\n    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);\n    head.writeUInt32BE(13, 8); head.write("IHDR", 12, "ascii"); head.writeUInt32BE(viewport, 16); head.writeUInt32BE(600, 20);\n    fs.writeFileSync(path.join(out, "m-" + i + ".png"), Buffer.concat([head, Buffer.from(route + lang + viewport)]));\n    return { route, file: "m-" + i + ".png", lang, dir };\n  });\n};\n',
  },
};

// A capture command: one fake PNG per route at the requested width, and the manifest with the page's lang and dir.
const CAPTURE = `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const get = (k) => args[args.indexOf(k) + 1];
const out = get('--out'), viewport = Number(get('--viewport')), lang = get('--lang'), dir = get('--dir');
const routes = args.slice(args.indexOf('--routes') + 1);
const mode = process.env.WF_FIXTURE_MODE || '';
const png = (w, h, tag) => {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'ascii'); head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.from(tag)]);
};
const manifest = routes.map((route, i) => {
  const file = 'shot-' + i + '.png';
  const width = (mode === 'narrow' || mode === 'narrow-ltr') && route === '/items' && viewport > 1000 ? viewport - 160 : viewport;
  fs.writeFileSync(path.join(out, file), png(width, 800, mode === 'stuck' ? 'same' : mode === 'per-route' ? route : route + lang + viewport));
  return { route, file, lang, dir: mode === 'ltr-only' || mode === 'narrow-ltr' ? 'ltr' : dir };
});
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest));
`;

function project() {
  const p = fixture({ repos: [DEFAULT_REPOS[0], CLIENT] });
  const script = path.join(p.tmp, 'capture.mjs');
  fs.writeFileSync(script, CAPTURE);
  p.adapter.screens.capture = `node ${script} --out {out} --viewport {viewport} --lang {lang} --dir {dir} --routes {routes}`;
  useDoubles(p);
  startAttempt(p, 'TK-5.1');
  return p;
}

const key = (i) => `${i.route} ${i.viewport} ${i.lang} ${i.dir}${i.sentinel ? ' S' : ''}`;

test('a shared file reaches its importers (relative and aliased, transitively) and adds the sentinel set in every language', async () => {
  const p = project();
  try {
    change(p, 'TK-5.1', 'client', { 'src/common/button.mjs': 'export const button = 2;\n' });
    const images = await capture(p.root, 'TK-5.1');
    assert.deepEqual(images.map(key).sort(), [
      '/ 400 l1 ltr S', '/ 400 l2 rtl S',
      '/items 1200 l1 ltr', '/items 1200 l2 rtl', '/items 400 l1 ltr', '/items 400 l2 rtl',
      '/settings 1200 l1 ltr', '/settings 1200 l2 rtl', '/settings 400 l1 ltr', '/settings 400 l2 rtl',
    ]);
    for (const i of images) {
      assert.equal(i.width, i.viewport);
      assert.equal(i.height, 800);
      assert.match(i.sha256, /^[0-9a-f]{64}$/);
      assert.ok(i.file.startsWith(path.join(p.root, '.wf-evidence', 'attempts', 'TK-5.1', 'screens')), 'kept in the attempt state folder');
    }
    const [ev] = eventsOf(p, 'screens.captured', 'TK-5.1');
    assert.equal(ev.images.length, 10);
    assert.deepEqual(ev.routes.sort(), ['/items', '/settings']);
    assert.equal(ev.refused, undefined);
    assert.ok(ev.tree);
  } finally {
    done(p);
  }
});

test('a change outside the shared paths captures only the screens it reaches, one language per direction', async () => {
  const p = project();
  try {
    p.adapter.screens.langs = [{ lang: 'l1', dir: 'ltr' }, { lang: 'l3', dir: 'ltr' }, { lang: 'l2', dir: 'rtl' }];
    change(p, 'TK-5.1', 'client', { 'src/pages/other.mjs': 'export const page = "/other2";\n' });
    const images = await capture(p.root, 'TK-5.1');
    assert.deepEqual(images.map(key).sort(), ['/other 1200 l1 ltr', '/other 1200 l2 rtl', '/other 400 l1 ltr', '/other 400 l2 rtl']);
  } finally {
    done(p);
  }
});

test('the page\'s own lang and dir are recorded, not the requested ones', async () => {
  const p = project();
  try {
    process.env.WF_FIXTURE_MODE = 'ltr-only';
    change(p, 'TK-5.1', 'client', { 'src/pages/other.mjs': 'export const page = 3;\n' });
    const images = await capture(p.root, 'TK-5.1');
    assert.deepEqual([...new Set(images.map((i) => `${i.lang} ${i.dir}`))].sort(), ['l1 ltr', 'l2 ltr']);
  } finally {
    delete process.env.WF_FIXTURE_MODE;
    done(p);
  }
});

test('an image narrower than its viewport is refused with screens:width, after the capture is recorded with what was refused', async () => {
  const p = project();
  try {
    process.env.WF_FIXTURE_MODE = 'narrow';
    change(p, 'TK-5.1', 'client', { 'src/common/card.mjs': 'export const card = 0;\n' });
    await assert.rejects(capture(p.root, 'TK-5.1'), (e) => {
      assert.equal(e.refusalId, 'screens:width');
      assert.equal(e.code, 75);
      assert.match(e.message, /\/items at 1200px \(l\d\) is 1040px wide/);
      return true;
    });
    const [ev] = eventsOf(p, 'screens.captured');
    assert.deepEqual([...new Set(ev.refused.map((r) => r.id))], ['screens:width']);
    assert.equal(ev.refused.length, 2);
  } finally {
    delete process.env.WF_FIXTURE_MODE;
    done(p);
  }
});

test('identical bytes for different screens are refused with screens:dup', async () => {
  const p = project();
  try {
    process.env.WF_FIXTURE_MODE = 'stuck';
    change(p, 'TK-5.1', 'client', { 'src/common/button.mjs': 'export const button = 3;\n' });
    await assert.rejects(capture(p.root, 'TK-5.1'), (e) => e.refusalId === 'screens:dup' && /same bytes as/.test(e.message));
  } finally {
    delete process.env.WF_FIXTURE_MODE;
    done(p);
  }
});

test('a capture command that writes no manifest is an error naming the protocol, and nothing is recorded', async () => {
  const p = project();
  try {
    p.adapter.screens.capture = 'true';
    change(p, 'TK-5.1', 'client', { 'src/pages/other.mjs': 'export const page = 4;\n' });
    await assert.rejects(capture(p.root, 'TK-5.1'), (e) => /wrote no .*manifest\.json/.test(e.message) && /lang and dir read from the page/.test(e.hint));
    assert.equal(eventsOf(p, 'screens.captured').length, 0);
  } finally {
    done(p);
  }
});

test('wf screens lists each image with its viewport, lang, dir and size', async () => {
  const p = project();
  try {
    change(p, 'TK-5.1', 'client', { 'src/pages/other.mjs': 'export const page = 5;\n' });
    const r = await commandHandler('screens')({ cwd: p.root, root: p.root, env: {}, actor: null, json: false }, { _: [], flags: { attempt: 'TK-5.1' } });
    assert.match(r.text, /^\/other 400px l1 ltr 400x800: /m);
    assert.equal(r.data.images.length, 4);
  } finally {
    done(p);
  }
});

test('identical bytes for the same route at two viewports or languages are refused with screens:dup', async () => {
  const p = project();
  try {
    process.env.WF_FIXTURE_MODE = 'per-route';
    change(p, 'TK-5.1', 'client', { 'src/pages/other.mjs': 'export const page = 6;\n' });
    await assert.rejects(capture(p.root, 'TK-5.1'), (e) => e.refusalId === 'screens:dup' && /\/other at \d+px \(l\d\) has the same bytes as \/other at/.test(e.message));
  } finally {
    delete process.env.WF_FIXTURE_MODE;
    done(p);
  }
});

test('a page that ignores the requested direction is recorded as a mismatch and named in the width refusal', async () => {
  const p = project();
  try {
    process.env.WF_FIXTURE_MODE = 'ltr-only';
    change(p, 'TK-5.1', 'client', { 'src/pages/other.mjs': 'export const page = 7;\n' });
    const images = await capture(p.root, 'TK-5.1');
    const rtl = images.filter((i) => i.lang === 'l2');
    assert.ok(rtl.length > 0);
    for (const i of rtl) assert.deepEqual(i.mismatch, { requested: { lang: 'l2', dir: 'rtl' }, page: { lang: 'l2', dir: 'ltr' } });
    assert.ok(images.filter((i) => i.lang === 'l1').every((i) => !i.mismatch));
    assert.ok(eventsOf(p, 'screens.captured', 'TK-5.1')[0].images.some((i) => i.mismatch));

    process.env.WF_FIXTURE_MODE = 'narrow-ltr';
    change(p, 'TK-5.1', 'client', { 'src/common/card.mjs': 'export const card = 8;\n' });
    await assert.rejects(capture(p.root, 'TK-5.1'), (e) => e.refusalId === 'screens:width' && /did not show the requested language or direction: .*asked l2 rtl, the page is l2 ltr/.test(e.message));
  } finally {
    delete process.env.WF_FIXTURE_MODE;
    done(p);
  }
});

test('a capture module loads from the fetched base and runs with the attempt folder as its cwd', async () => {
  const p = project();
  try {
    p.adapter.screens.capture = { module: { repo: 'client', path: 'scripts/capture-mod.mjs' } };
    // The ticket changes the module: the base copy still captures it.
    change(p, 'TK-5.1', 'client', { 'src/pages/other.mjs': 'export const page = 9;\n', 'scripts/capture-mod.mjs': 'export default async () => { throw new Error("the worktree copy ran"); };\n' });
    const images = await capture(p.root, 'TK-5.1');
    assert.deepEqual(images.map(key).sort(), ['/other 1200 l1 ltr', '/other 1200 l2 rtl', '/other 400 l1 ltr', '/other 400 l2 rtl']);
    const ctx = JSON.parse(fs.readFileSync(path.join(path.dirname(images[0].file), 'ctx.json'), 'utf8'));
    assert.deepEqual(ctx, { cwd: path.join(p.root, '.wf-worktrees', 'TK-5.1'), copy: 'base' });
  } finally {
    done(p);
  }
});

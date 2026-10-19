// Screens (design-0.8 section 2, step 5; stream 2). Screenshots caught about a quarter of real defects, most of them in
// code that existed before the ticket, so the screens a change reaches are a regression net as well as a check on it.
//
// Selection is a fact of the code, never a guess:
// - the changed files and every file that imports them (transitively, within the repo) go to the project's
//   `screens.routes` module, which maps files to routes;
// - a changed file under `screens.shared` adds the project's fixed `screens.sentinel` set, in every language and
//   direction the adapter lists, at the narrowest viewport.
// Routed screens are captured at every viewport, once per direction the project ships.
//
// The capture command is the project's (`screens.capture`). It is run once per viewport and language with the
// placeholders {out} {viewport} {lang} {dir} {routes}, and writes `{out}/manifest.json`: `[{ route, file, lang, dir }]`,
// file relative to {out}, lang and dir read from the rendered page's root element (the page's own, not the requested).
//
// Refusals:
// - screens:width: an image's width is not the requested viewport (I-117: cropped screens passed).
// - screens:dup: an image's bytes equal those of another screen (a stuck page passed as several screens).
// Captures stay in the attempt's state folder: they belong to one run, never to a shared gate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WfError, append, attemptDir, changedFiles, loadAdapter, refusal, worktreeDir } from './contract.mjs';
import { projectEnv } from './env.mjs';
import { imageSize } from './image-size.mjs';
import { attemptOf, baseModule, git, mkdirs, stamp } from './tests.mjs';
import { matchesAny } from './util.mjs';

const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|sass|less)$/;
const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro', '.css', '.scss', '.sass', '.less'];
const SPECIFIERS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /@(?:import|use|forward)\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g,
];

// ---- reverse imports ------------------------------------------------------------------------------------------------

function readJsonc(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    // Strip comments outside strings, and trailing commas.
    const stripped = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '').replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

// Path aliases a repo declares itself (tsconfig.json / jsconfig.json `compilerOptions.paths`, following `extends`).
function aliasesOf(repoDir) {
  const out = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const cfg = readJsonc(file);
    if (!cfg) return;
    const dir = path.dirname(file);
    if (typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) visit(path.resolve(dir, cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`));
    const co = cfg.compilerOptions ?? {};
    const baseUrl = path.resolve(dir, co.baseUrl ?? '.');
    for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
      for (const t of [].concat(targets)) out.push({ pattern, target: path.relative(repoDir, path.resolve(baseUrl, t)).split(path.sep).join('/') });
    }
  };
  visit(path.join(repoDir, 'tsconfig.json'));
  visit(path.join(repoDir, 'jsconfig.json'));
  return out;
}

function resolveIn(files, rel) {
  const n = path.posix.normalize(rel);
  if (n.startsWith('..')) return null;
  const stem = n.replace(/\.(?:[cm]?js|jsx)$/, '');
  for (const c of [n, ...RESOLVE_EXT.map((e) => n + e), ...RESOLVE_EXT.map((e) => stem + e), ...RESOLVE_EXT.map((e) => `${n}/index${e}`)]) if (files.has(c)) return c;
  // Sass partials: `@use 'x'` resolves to `_x.scss`.
  const partial = path.posix.join(path.posix.dirname(n), `_${path.posix.basename(n)}`);
  for (const e of ['.scss', '.sass']) if (files.has(partial + e)) return partial + e;
  return null;
}

// importee (repo-relative) → importers, over the repo's code files that git does not ignore.
export function importGraph(repoDir) {
  const list = git(repoDir, ['ls-files', '-co', '--exclude-standard']).split('\n').filter((f) => CODE.test(f));
  const files = new Set(list);
  const aliases = aliasesOf(repoDir);
  const reverse = new Map();
  for (const file of list) {
    let text;
    try {
      text = fs.readFileSync(path.join(repoDir, file), 'utf8');
    } catch {
      continue;
    }
    const dir = path.posix.dirname(file);
    for (const re of SPECIFIERS) {
      for (const m of text.matchAll(re)) {
        const spec = m[1].split('?')[0];
        let target = null;
        if (spec.startsWith('.')) target = resolveIn(files, path.posix.join(dir, spec));
        else if (spec.startsWith('/')) target = resolveIn(files, spec.slice(1));
        else {
          for (const a of aliases) {
            const star = a.pattern.indexOf('*');
            if (star < 0 ? spec === a.pattern : spec.startsWith(a.pattern.slice(0, star)) && spec.endsWith(a.pattern.slice(star + 1))) {
              const middle = star < 0 ? '' : spec.slice(star, spec.length - (a.pattern.length - star - 1));
              target = resolveIn(files, a.target.replace('*', middle));
              if (target) break;
            }
          }
        }
        if (target && target !== file) {
          if (!reverse.has(target)) reverse.set(target, new Set());
          reverse.get(target).add(file);
        }
      }
    }
  }
  return reverse;
}

// The changed files and everything that imports them, transitively (repo-relative).
export function reachedFrom(reverse, changed) {
  const out = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    for (const importer of reverse.get(queue.shift()) ?? []) {
      if (!out.has(importer)) {
        out.add(importer);
        queue.push(importer);
      }
    }
  }
  return out;
}

// ---- selection ------------------------------------------------------------------------------------------------------

const prefixOf = (adapter, repo) => adapter.repos.find((r) => r.name === repo)?.path.replace(/\/+$/, '') ?? repo;

// The screens to capture: [{ route, viewport, lang, dir, sentinel }], plus the facts they came from.
export async function pickScreens(root, attempt, adapter, changed) {
  const s = adapter.screens;
  const viewports = [...new Set(s.viewports ?? [])].map(Number).filter((v) => Number.isInteger(v) && v > 0).sort((a, b) => a - b);
  if (!viewports.length) throw new WfError('screens.viewports is empty: name the widths to capture in the adapter');
  const langs = s.langs?.length ? s.langs : [{ lang: null, dir: null }];
  // Routed screens: the first listed language of each direction the project ships.
  const perDir = langs.filter((l, i) => langs.findIndex((x) => x.dir === l.dir) === i);
  const rootRel = changed.map((f) => `${prefixOf(adapter, f.repo)}/${f.path}`);
  const reached = new Set();
  for (const repo of [...new Set(changed.map((f) => f.repo))]) {
    const dir = worktreeDir(root, attempt, repo);
    if (!fs.existsSync(dir)) continue;
    const graph = importGraph(dir);
    for (const f of reachedFrom(graph, changed.filter((c) => c.repo === repo).map((c) => c.path))) reached.add(`${prefixOf(adapter, repo)}/${f}`);
  }
  for (const f of rootRel) reached.add(f);
  let routes = [];
  if (s.routes) {
    // From the fetched base, not the worktree: a ticket does not choose which of its screens are seen.
    const file = baseModule(root, adapter, s.routes, 'screens.routes module');
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.default !== 'function') throw new WfError(`screens.routes module ${s.routes.repo}/${s.routes.path} has no default export function`);
    const got = await mod.default([...reached].sort());
    if (!Array.isArray(got)) throw new WfError(`screens.routes module ${s.routes.repo}/${s.routes.path} returned ${typeof got}, not a list of routes`);
    routes = [...new Set(got.map(String))];
  }
  const shared = rootRel.filter((f) => matchesAny(f, s.shared ?? []));
  const sentinel = shared.length ? [...new Set((s.sentinel ?? []).map(String))] : [];
  const picks = new Map();
  const add = (route, viewport, l, isSentinel) => {
    const key = `${route}\0${viewport}\0${l.lang}`;
    const prev = picks.get(key);
    picks.set(key, { route, viewport, lang: l.lang ?? null, dir: l.dir ?? null, sentinel: (prev?.sentinel ?? false) || isSentinel });
  };
  for (const route of routes) for (const v of viewports) for (const l of perDir) add(route, v, l, false);
  for (const route of sentinel) for (const l of langs) add(route, viewports[0], l, true);
  return { picks: [...picks.values()], routes, sentinel, shared, reached: [...reached].sort() };
}

// ---- capture --------------------------------------------------------------------------------------------------------

const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

export function fillCommand(template, { out, viewport, lang, dir, routes }) {
  return template.replace(/\{(out|viewport|lang|dir|routes)\}/g, (_, k) => {
    if (k === 'routes') return routes.map(quote).join(' ');
    const v = { out, viewport, lang, dir }[k];
    return quote(v ?? '');
  });
}

function readManifest(out) {
  const file = path.join(out, 'manifest.json');
  if (!fs.existsSync(file)) throw new WfError(`the capture command wrote no ${file}`, { hint: 'screens.capture must write {out}/manifest.json: [{ "route", "file", "lang", "dir" }], lang and dir read from the page.' });
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new WfError(`${file} is not JSON: ${e.message}`);
  }
  if (!Array.isArray(list)) throw new WfError(`${file} must be a list of { route, file, lang, dir }`);
  return list;
}

const tail = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-2000) : '');

// Pick, capture and check the attempt's screens; append `screens.captured`. Refuses screens:width and screens:dup (after
// recording what was captured, with `refused`).
export async function capture(root, attempt) {
  const adapter = await loadAdapter(root);
  const s = adapter.screens;
  if (!s?.capture) throw new WfError('screens.capture is not set: the adapter names no capture command', { hint: 'Run `wf init` to set the screens settings.' });
  const { tree, files } = await changedFiles(root, attempt);
  const { picks, routes } = await pickScreens(root, attempt, adapter, files);
  const runDir = mkdirs(path.join(attemptDir(root, attempt), 'screens', stamp()));
  const cwd = path.join(root, '.wf-worktrees', attempt);
  const jobs = new Map();
  for (const p of picks) {
    const key = `${p.viewport}\0${p.lang}`;
    if (!jobs.has(key)) jobs.set(key, { viewport: p.viewport, lang: p.lang, dir: p.dir, picks: [] });
    jobs.get(key).picks.push(p);
  }
  const images = [];
  for (const job of jobs.values()) {
    const out = mkdirs(path.join(runDir, `${job.viewport}-${job.lang ?? 'default'}`));
    const wanted = [...new Set(job.picks.map((p) => p.route))];
    const command = fillCommand(s.capture, { out, viewport: job.viewport, lang: job.lang, dir: job.dir, routes: wanted });
    const log = path.join(out, 'capture.log');
    const env = projectEnv(null, { WF_ROOT: root, WF_ATTEMPT: attempt, WF_SCREENS_OUT: out, WF_VIEWPORT: String(job.viewport), WF_LANG: job.lang ?? '', WF_DIR: job.dir ?? '' });
    const fd = fs.openSync(log, 'w');
    const r = spawnSync('sh', ['-c', command], { cwd: fs.existsSync(cwd) ? cwd : root, env, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    if (r.error || r.status !== 0) throw new WfError(`the capture command failed (exit ${r.status ?? r.error?.message}) at ${job.viewport}px${job.lang ? `, ${job.lang}` : ''}: ${command}\n${tail(log)}`);
    const manifest = readManifest(out);
    for (const p of job.picks) {
      const entry = manifest.find((m) => String(m?.route) === p.route);
      if (!entry || typeof entry.file !== 'string') throw new WfError(`the capture command wrote no image for ${p.route} at ${job.viewport}px${job.lang ? `, ${job.lang}` : ''} (${path.join(out, 'manifest.json')})`);
      const file = path.resolve(out, entry.file);
      if (path.relative(out, file).startsWith('..')) throw new WfError(`manifest image ${entry.file} is outside ${out}`);
      if (!fs.existsSync(file)) throw new WfError(`manifest image ${file} does not exist`);
      const bytes = fs.readFileSync(file);
      const size = imageSize(bytes);
      images.push({
        route: p.route, viewport: p.viewport,
        lang: typeof entry.lang === 'string' && entry.lang ? entry.lang : null,
        dir: entry.dir === 'ltr' || entry.dir === 'rtl' ? entry.dir : null,
        width: size?.width ?? 0, height: size?.height ?? 0,
        file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sentinel: p.sentinel,
      });
    }
  }
  const refused = [];
  for (const img of images) {
    if (img.width !== img.viewport) refused.push({ id: 'screens:width', file: img.file, message: `${img.route} at ${img.viewport}px${img.lang ? ` (${img.lang})` : ''} is ${img.width ? `${img.width}px` : 'of unreadable width'} wide` });
  }
  const bySha = new Map();
  for (const img of images) {
    const first = bySha.get(img.sha256);
    if (first && first.route !== img.route) refused.push({ id: 'screens:dup', file: img.file, message: `${img.route} at ${img.viewport}px${img.lang ? ` (${img.lang})` : ''} has the same bytes as ${first.route} at ${first.viewport}px${first.lang ? ` (${first.lang})` : ''}` });
    else if (!first) bySha.set(img.sha256, img);
  }
  await append(root, attempt, 'screens.captured', { tree, images, routes, ...(refused.length ? { refused } : {}) }, null);
  if (refused.length) {
    const hint = refused[0].id === 'screens:width'
      ? 'Capture at the requested viewport width with a device pixel ratio of 1, then run `wf screens` again.'
      : 'The page did not change between screens (still loading, an error page, a redirect): fix the capture, then run `wf screens` again.';
    throw refusal(refused[0].id, `screens refused: ${refused.map((x) => `${x.id}: ${x.message}`).join('; ')}`, hint);
  }
  return images;
}

// wf screens [--attempt a]
export async function cmdScreens(ctx, args) {
  if (!ctx.root) throw new WfError('no project here: wf screens runs inside a project with an adapter');
  const attempt = attemptOf(ctx, args);
  const images = await capture(ctx.root, attempt);
  const text = images.length
    ? images.map((i) => `${i.route} ${i.viewport}px ${i.lang ?? '-'} ${i.dir ?? '-'} ${i.width}x${i.height}${i.sentinel ? ' (sentinel)' : ''}: ${i.file}`).join('\n')
    : 'No screen is reached by this change.';
  return { text, data: { attempt, images } };
}

export const implements08 = { capture, cmdScreens };

// Project modules (`{ repo, path }`: test runners, the screens routes module, tracker and delivery modules) load only as
// the repo's fetched base holds them, never from an attempt's worktree or the checkout's working files.
//
// Named failure (0.7, "a ticket cannot remove its own checks"): resolved in the attempt's worktree, a ticket could change
// the code that judges or delivers it, for example a test runner that always reports a pass, or a delivery module that
// marks itself merged. A ticket's change to a module ships through delivery and takes effect after it lands. The code a
// test runner executes (the tests, the app) is still the ticket's own, from the worktree.
//
// The module's top-level folder in its repo (all of `.workflow/` for `.workflow/steps/unit.mjs`; the whole repo for a
// file at its root) is extracted from the base into `<userDir>/modules/<folder tree sha>-<key>/`, so `../` imports
// anywhere inside that folder resolve as committed. Bare package imports resolve through a `node_modules` link placed
// where the checkout's nearest `node_modules` above the module sits; `<key>` hashes the folder name and that link
// target, so two checkouts never share a link. Extraction goes to a temporary folder renamed into place, so concurrent
// runs never see half a folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WfError, userDir } from './contract.mjs';

const gitEnv = () => ({ ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' });
const git = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });

// The base ref a module is read at: `refs/remotes/<remote>/<base>`, fetched once per process; a repo with no such
// remote reads its local base branch.
const fetched = new Set();
export function moduleBaseRef(dir, spec) {
  const remote = spec.remote || 'origin';
  const remotes = git(dir, ['remote']).stdout?.split('\n').filter(Boolean) ?? [];
  if (!remotes.includes(remote)) return `refs/heads/${spec.base}`;
  const key = `${dir}\0${remote}\0${spec.base}`;
  if (!fetched.has(key)) {
    git(dir, ['fetch', '--quiet', remote, `+refs/heads/${spec.base}:refs/remotes/${remote}/${spec.base}`], { env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' } });
    fetched.add(key);
  }
  return `refs/remotes/${remote}/${spec.base}`;
}

// The folder a module is extracted with: its top-level folder in the repo, or '' (the whole repo) for a file at the root.
export const moduleFolder = (rel) => {
  const r = path.posix.normalize(String(rel).replaceAll('\\', '/')).replace(/^\.\//, '');
  return r.includes('/') ? r.split('/')[0] : '';
};

// The file to import for a project module, extracted as the base holds it. `what` names the module in errors.
export function baseModuleFile(root, adapter, ref, { what = 'module' } = {}) {
  const spec = adapter.repos.find((r) => r.name === ref?.repo);
  if (!spec) throw new WfError(`${what} ${JSON.stringify(ref)}: no repo named \`${ref?.repo}\` in the adapter`);
  const rel = path.posix.normalize(String(ref.path ?? '').replaceAll('\\', '/')).replace(/^\.\//, '');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) throw new WfError(`${what} ${ref.repo}/${ref.path}: the path must be a file inside the repo`);
  const checkout = path.join(root, spec.path);
  const base = moduleBaseRef(checkout, spec);
  const missing = (r) => new WfError(`${what} ${ref.repo}/${rel} is not committed on ${base} (${String(r.stderr || r.error?.message || '').trim() || 'not found'})`, { hint: 'a project module the engine runs is read from the fetched base: land it there first' });
  const blob = git(checkout, ['cat-file', '-e', `${base}:${rel}`]);
  if (blob.error || blob.status !== 0) throw missing(blob);
  const top = moduleFolder(rel);
  const tree = git(checkout, ['rev-parse', top ? `${base}:${top}` : `${base}^{tree}`]);
  if (tree.error || tree.status !== 0) throw missing(tree);
  // The checkout's nearest node_modules above the module's own folder, up to the repo's root.
  let deps = null;
  const own = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  for (let d = own; ; d = path.posix.dirname(d) === '.' ? '' : path.posix.dirname(d)) {
    if (fs.existsSync(path.join(checkout, d, 'node_modules'))) {
      deps = { at: d, target: path.join(checkout, d, 'node_modules') };
      break;
    }
    if (!d) break;
  }
  const key = crypto.createHash('sha256').update(`${top}\0${deps?.at ?? ''}\0${deps?.target ?? ''}`).digest('hex').slice(0, 12);
  const modules = path.join(userDir(), 'modules');
  const dir = path.join(modules, `${tree.stdout.trim()}-${key}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(modules, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(modules, `.${path.basename(dir)}-`));
    try {
      const tar = git(checkout, ['archive', '--format=tar', base, ...(top ? ['--', top] : [])], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
      if (tar.error || tar.status !== 0) throw missing(tar);
      const x = spawnSync('tar', ['-x', '-f', '-', '-C', tmp], { input: tar.stdout });
      if (x.error || x.status !== 0) throw new WfError(`could not extract ${ref.repo}/${top || '.'} from ${base}: ${String(x.stderr || x.error?.message).trim()}`);
      if (deps) {
        const link = path.join(tmp, deps.at, 'node_modules');
        if (!fs.existsSync(link)) {
          fs.mkdirSync(path.dirname(link), { recursive: true });
          fs.symlinkSync(deps.target, link, 'dir');
        }
      }
      try {
        fs.renameSync(tmp, dir);
      } catch (e) {
        // Another run extracted the same folder first: its copy is identical.
        if (!fs.existsSync(dir)) throw e;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return path.join(dir, ...rel.split('/'));
}

// The module itself (its namespace), imported from the extracted folder.
export async function importBaseModule(root, adapter, ref, opts = {}) {
  const { pathToFileURL } = await import('node:url');
  return import(pathToFileURL(baseModuleFile(root, adapter, ref, opts)).href);
}

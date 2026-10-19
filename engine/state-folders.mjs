// Named failure: cloud conflict copies left the expected evidence directory empty while its sibling held the data.
// Protect newly created state roots before creating children or writing payloads; never retrofit a synced directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WfError } from './util.mjs';

export const STATE_FOLDERS = ['.wf-evidence', '.workflow-evidence', '.wf-worktrees', '.workflow-maintenance'];
export const ICLOUD_IGNORE = 'com.apple.fileprovider.ignore#P';
// In-process scenario seams only. No environment switch can disable folder marking on macOS.
export const stateFolderSeams = { platform: null, xattr: null };
// Named failure: a marker failure escaped CLI refusal handling as a generic stack trace and exit 1.
const refused = message => new WfError(message, { code: 75 });

function realDirectory(dir) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) throw refused(`${dir} is a link or not a real state folder; nothing is written through it`);
  return st;
}

function markNewFolder(dir) {
  if ((stateFolderSeams.platform ?? process.platform) !== 'darwin') return;
  const before = realDirectory(dir);
  // The system xattr utility's -s selects XATTR_NOFOLLOW. No shell, recursion or PATH-selected executable.
  const result = (stateFolderSeams.xattr ?? spawnSync)('/usr/bin/xattr', ['-s', '-w', ICLOUD_IGNORE, '1', dir], { encoding: 'utf8' });
  const after = realDirectory(dir);
  if (!before || !after || before.ino !== after.ino || before.dev !== after.dev || before.birthtimeMs !== after.birthtimeMs) throw refused(`state folder changed while setting its iCloud ignore attribute: ${dir}`);
  if (result.status !== 0) throw refused(`cannot set the iCloud ignore attribute on new state folder ${dir}; no payload was written: ${result.error?.message ?? result.stderr?.trim() ?? 'xattr failed'}`);
}

const gitCall = (dir, args) => spawnSync('git', ['--no-replace-objects', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: os.devNull } });

// Local Git metadata only. Linked worktrees use their actual common Git directory; unrelated patterns are preserved.
export function ensureGitStateExcludes(root) {
  const topResult = gitCall(root, ['rev-parse', '--show-toplevel']);
  if (topResult.status !== 0) return []; // multi-repo project parents deliberately have no Git repository
  const top = fs.realpathSync(topResult.stdout.trim()), realRoot = fs.realpathSync(root);
  const relative = path.relative(top, realRoot).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw refused('state folder parent lies outside its Git repository');
  const names = STATE_FOLDERS.map(name => `${relative ? relative + '/' : ''}${name}/`);
  const missing = names.filter(name => {
    const result = gitCall(top, ['check-ignore', '--no-index', '--quiet', '--', name]);
    if (![0, 1].includes(result.status)) throw refused(`cannot check Git ignores for ${name}: ${result.stderr?.trim()}`);
    return result.status === 1;
  });
  if (!missing.length) return [];
  const commonResult = gitCall(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonResult.status !== 0) throw refused('cannot locate the common Git directory for local state excludes');
  const common = fs.realpathSync(commonResult.stdout.trim()), info = path.join(common, 'info'), file = path.join(info, 'exclude');
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() || fs.lstatSync(info, { throwIfNoEntry: false })?.isSymbolicLink()) throw refused('Git exclude path is a link; state ignores were not written through it');
  realDirectory(info);
  fs.mkdirSync(info, { recursive: true });
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o644);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw refused('Git exclude is not a regular file with one name; state ignores were not written');
    const existing = fs.readFileSync(fd, 'utf8');
    fs.writeSync(fd, `${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.map(name => '/' + name).join('\n')}\n`);
  } finally { fs.closeSync(fd); }
  return missing;
}

// A drop-in mkdir for engine-owned directories. Intermediate state roots are created and marked separately,
// so recursive mkdir cannot create an unmarked root and populate it in the same call.
export function mkdirStateDirectory(dir, options = {}) {
  const absolute = path.resolve(dir), parts = absolute.split(path.sep);
  let createdTarget = false;
  for (let i = 0; i < parts.length; i++) {
    if (!STATE_FOLDERS.includes(parts[i])) continue;
    const folder = parts.slice(0, i + 1).join(path.sep);
    if (realDirectory(folder)) continue;
    if (options.recursive) fs.mkdirSync(path.dirname(folder), { recursive: true, mode: options.mode });
    try { fs.mkdirSync(folder, { mode: options.mode }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; realDirectory(folder); continue; }
    const created = realDirectory(folder);
    if (folder === absolute) createdTarget = true;
    try { markNewFolder(folder); }
    catch (error) {
      // Remove only our still-empty real directory after failed marking. A replacement or any data stays for diagnosis.
      try {
        const current = realDirectory(folder);
        if (current && current.ino === created.ino && current.dev === created.dev && current.birthtimeMs === created.birthtimeMs && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
      } catch {}
      throw error;
    }
    ensureGitStateExcludes(path.dirname(folder));
  }
  return createdTarget ? undefined : fs.mkdirSync(dir, options);
}

const conflictSuffix = /^(?:[2-9]|[1-9][0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function stateFolderWarnings(root) {
  const warnings = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { return [{ check: 'state folder conflict inspection', problem: error.message }]; }
  for (const name of STATE_FOLDERS) {
    const siblings = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(name + ' ') && conflictSuffix.test(entry.name.slice(name.length + 1)));
    if (!siblings.length) continue;
    const fix = 'preserve every copy, compare the local evidence and its ledger before restoring the expected folder; do not merge or delete automatically';
    warnings.push({ check: `state folder conflict copies: ${name}`, problem: `possible cloud conflict copies: ${siblings.map(s => s.name).join(', ')}`, fix });
    if (!name.endsWith('evidence')) continue;
    try {
      const original = path.join(root, name);
      if (realDirectory(original) && fs.readdirSync(original).length === 0) {
        const populated = siblings.filter(s => fs.readdirSync(path.join(root, s.name)).length > 0);
        if (populated.length) warnings.push({ check: `empty evidence folder: ${name}`, problem: `${name} is empty while ${populated.map(s => s.name).join(', ')} contains entries; the expected evidence may have been moved by a sync conflict`, fix });
      }
    } catch (error) { warnings.push({ check: `state folder conflict inspection: ${name}`, problem: error.message }); }
  }
  return warnings;
}

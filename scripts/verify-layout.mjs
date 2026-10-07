// The checkout `npm run verify` copies into its Linux container, and the git directories it needs there.
//
// Named failure: `npm run verify` from a linked git worktree failed both Linux legs before a single test ran ("fatal:
// not a git repository"): the worktree's `.git` is a file naming a git directory on the host, which the container never
// saw. The git directories it names (the worktree's own and the common one) are mounted read-only, copied inside the
// container next to the copied checkout, and relinked to the copies' paths, so the suite never writes to the host's.
// A plain checkout (`.git` is a directory) is copied with the checkout, as before.
import fs from 'node:fs';
import path from 'node:path';

// `dir`: the checkout on the host. `at`: a prefix for every path inside the container (empty in the container; a
// temporary folder when a scenario plays the container on the host). Returns the read-only bind mounts as
// [{ host, at }], the environment the script reads, and the shell script that copies the checkout to `${at}/tmp/w`.
export function verifyLayout(dir, at = '') {
  const w = `${at}/w`;
  const g = `${at}/g`;
  const gw = `${at}/gw`;
  const copy = { w: `${at}/tmp/w`, g: `${at}/tmp/g`, gw: `${at}/tmp/gw` };
  const binds = [{ host: dir, at: w }];
  const env = {};
  const steps = [`rm -rf "${copy.w}" "${copy.g}" "${copy.gw}"`, `cp -r "${w}" "${copy.w}"`];
  const dotgit = path.join(dir, '.git');
  let st = null;
  try {
    st = fs.lstatSync(dotgit);
  } catch {}
  if (st?.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (!m) throw new Error(`${dotgit} is a file without a gitdir line`);
    const gitdir = path.resolve(dir, m[1]);
    const commonFile = path.join(gitdir, 'commondir');
    const common = fs.existsSync(commonFile) ? path.resolve(gitdir, fs.readFileSync(commonFile, 'utf8').trim()) : gitdir;
    for (const d of [gitdir, common]) if (!fs.statSync(d).isDirectory()) throw new Error(`${d} (named by ${dotgit}) is not a directory`);
    binds.push({ host: common, at: g });
    steps.push(`cp -r "${g}" "${copy.g}"`);
    let target;
    if (gitdir === common) target = copy.g;
    else {
      const rel = path.relative(common, gitdir).split(path.sep).join('/');
      if (rel && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel)) {
        // Passed through the environment, never spliced into the script: a folder name is data.
        env.WF_VERIFY_GITDIR_REL = rel;
        target = `${copy.g}/$WF_VERIFY_GITDIR_REL`;
      } else {
        binds.push({ host: gitdir, at: gw });
        steps.push(`cp -r "${gw}" "${copy.gw}"`);
        target = copy.gw;
      }
      steps.push(`printf '%s\\n' "${copy.w}/.git" > "${target}/gitdir"`, `printf '%s\\n' "${copy.g}" > "${target}/commondir"`);
    }
    steps.push(`printf 'gitdir: %s\\n' "${target}" > "${copy.w}/.git"`);
  }
  return { binds, env, script: steps.join(' && '), checkout: copy.w };
}

// Linux protection probe, for a container: which layers work as this user on these filesystems.
// Run: docker run --rm --label agentic-workflow-probe=1 -v "$PWD":/w:ro node:22-bookworm node /w/bench/linux-protection.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { protectionLayers } from '../engine/evidence.mjs';

const where = { tmp: os.tmpdir(), shm: '/dev/shm' };
const fsType = (p) => spawnSync('stat', ['-f', '-c', '%T', p], { encoding: 'utf8' }).stdout.trim();
console.log(`user ${os.userInfo().username} (uid ${process.getuid()}), ${os.platform()} ${os.release()}`);
for (const [name, dir] of Object.entries(where)) {
  if (!fs.existsSync(dir)) continue;
  const root = fs.mkdtempSync(path.join(dir, 'wf-probe-'));
  const layers = protectionLayers(root);
  // The immutable flag directly, to show the raw error.
  const f = path.join(root, 'f');
  fs.writeFileSync(f, 'x');
  const set = spawnSync('chattr', ['+i', f], { encoding: 'utf8' });
  let removable = true;
  try {
    fs.unlinkSync(f);
  } catch {
    removable = false;
  }
  spawnSync('chattr', ['-i', f], { stdio: 'ignore' });
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`${name} (${dir}, ${fsType(dir)}): chattr +i exit ${set.status}${set.stderr ? ` "${set.stderr.trim()}"` : ''}; file ${removable ? 'still removable' : 'held'}`);
  for (const l of layers) console.log(`  ${l.active ? 'on ' : 'off'}  ${l.layer}${l.detail ? `: ${l.detail}` : ''}`);
}

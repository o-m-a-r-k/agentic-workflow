#!/usr/bin/env node
// Puts this copy's `wf` on the PATH: links `~/.local/bin/wf` (or `--dir <folder>`/wf) to this checkout's bin/wf.
//
//   node scripts/install.mjs [--dir <folder>]
//
// The linked copy is "the installed release": an older copy of wf run from anywhere else runs it instead (bin/wf, D27).
// A file at the link's place that is not a link is never replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wf');
const i = process.argv.indexOf('--dir');
const dir = path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(os.homedir(), '.local', 'bin'));
const link = path.join(dir, 'wf');
fs.mkdirSync(dir, { recursive: true });
const st = fs.lstatSync(link, { throwIfNoEntry: false });
if (st && !st.isSymbolicLink()) {
  process.stderr.write(`install: ${link} exists and is not a link; move it aside first\n`);
  process.exit(1);
}
if (st) fs.rmSync(link);
fs.symlinkSync(bin, link);
const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir);
process.stdout.write(`linked ${link} -> ${bin}${onPath ? '' : `\n${dir} is not on PATH; add it to your shell profile`}\n`);

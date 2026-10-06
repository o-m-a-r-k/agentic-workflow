// A fake `gh` for the tracker tests: `gh auth status` and `gh api -X M <path|url> [-H h]... [--input file|-]`, backed by
// the fake GitHub in WF_TEST_GH_STATE. `gh auth status` prints a token-like line so the tests can prove wf never prints it.
import fs from 'node:fs';
import { apply } from './fake-github.mjs';

const args = process.argv.slice(2);
const file = process.env.WF_TEST_GH_STATE;
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.WF_TEST_GH_LOGGED_OUT) {
    process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
    process.exit(1);
  }
  process.stdout.write('github.com\n  ✓ Logged in to github.com account tester (keyring)\n  - Token: gho_fakeTokenThatMustNeverBePrinted\n');
  process.exit(0);
}
if (args[0] !== 'api') {
  process.stderr.write(`fake gh: unsupported ${args.join(' ')}\n`);
  process.exit(2);
}
let method = 'GET';
let target;
let input;
const headers = {};
for (let i = 1; i < args.length; i++) {
  if (args[i] === '-X') method = args[++i];
  else if (args[i] === '-H') {
    const [k, ...v] = args[++i].split(':');
    headers[k.trim().toLowerCase()] = v.join(':').trim();
  } else if (args[i] === '--input') input = args[++i];
  else target = args[i];
}
let body;
if (input !== undefined) {
  const raw = input === '-' ? fs.readFileSync(0) : fs.readFileSync(input);
  body = String(headers['content-type'] ?? 'application/json').includes('json') ? JSON.parse(raw.toString('utf8')) : raw;
}
fs.appendFileSync(`${file}.argv`, `${JSON.stringify(args)}\n`);
fs.appendFileSync(`${file}.env`, `${JSON.stringify(Object.keys(process.env).sort())}\n`);
const r = apply(file, method, target, body);
if (r.status >= 400) {
  process.stderr.write(`gh: ${r.data?.message ?? 'error'} (HTTP ${r.status})\n`);
  process.exit(1);
}
if (r.data !== null) process.stdout.write(JSON.stringify(r.data));

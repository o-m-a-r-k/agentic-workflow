import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoDir } from './config.mjs';
import { WfError, YAML, refuse, run } from './util.mjs';

// Values never leave this module except into a step's environment or the store.
// Nothing here prints a value.

export function loadCatalog(root) {
  const file = path.join(root, '.workflow', 'secrets.yaml');
  if (!fs.existsSync(file)) return [];
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  const keys = raw.keys ?? raw;
  if (!Array.isArray(keys)) throw new WfError(`${file}: expected a list under \`keys\``);
  return keys.map((k) => ({ kind: 'provided', usedBy: [], ...k }));
}

const envFileFor = (root, cfg, entry) => {
  const repo = cfg.repos.find((r) => r.name === (entry.repo ?? cfg.repos[0].name));
  if (!repo) throw new WfError(`secret ${entry.key}: unknown repo \`${entry.repo}\``);
  return path.join(repoDir(root, repo), entry.file ?? cfg.secrets.file ?? '.env.local');
};

function parseEnv(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).replace(/\\n/g, '\n');
    out.set(m[1], v);
  }
  return out;
}

const keychainService = (cfg, key) => `agentic-workflow:${cfg.name}:${key}`;

export function readSecret(root, cfg, entry) {
  if (cfg.secrets.store === 'keychain') {
    const r = run('security', ['find-generic-password', '-s', keychainService(cfg, entry.key), '-a', os.userInfo().username, '-w'], { allowFail: true });
    return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
  }
  const file = envFileFor(root, cfg, entry);
  if (!fs.existsSync(file)) return null;
  const v = parseEnv(fs.readFileSync(file, 'utf8')).get(entry.key);
  return v === undefined || v === '' ? null : v;
}

export function writeSecret(root, cfg, entry, value) {
  if (cfg.secrets.store === 'keychain') {
    if (/[\r\n]/.test(value)) throw refuse(`${entry.key}: multi-line values (PEM keys) cannot go through the keychain command; use \`secrets.store: env-file\` for this project`);
    // The value goes through stdin (`security -i`), never argv, so it is not visible in the process list.
    const q = (v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
    run('security', ['-i'], { input: `add-generic-password -U -s ${q(keychainService(cfg, entry.key))} -a ${q(os.userInfo().username)} -w ${q(value)}\n`, sensitive: true });
    return;
  }
  const file = envFileFor(root, cfg, entry);
  const quoted = /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : JSON.stringify(value);
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${entry.key}\\s*=`).test(l));
  if (idx >= 0) lines[idx] = `${entry.key}=${quoted}`;
  else {
    if (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(`${entry.key}=${quoted}`, '');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function checkFormat(entry, value) {
  const f = entry.format ?? {};
  const problems = [];
  if (f.prefix && !value.startsWith(f.prefix)) problems.push(`should start with "${f.prefix}"`);
  if (f.length && value.length !== f.length) problems.push(`should be ${f.length} characters, got ${value.length}`);
  if (f.minLength && value.length < f.minLength) problems.push(`should be at least ${f.minLength} characters`);
  if (f.regex && !new RegExp(f.regex).test(value)) problems.push('does not match the expected format');
  if (/\s/.test(value) && !f.allowWhitespace) problems.push('contains whitespace (a copy/paste slip?)');
  return problems;
}

export function verifySecret(root, cfg, entry, value) {
  if (!entry.verify) return { ran: false };
  const r = run('sh', ['-c', entry.verify], { allowFail: true, cwd: root, env: { ...process.env, [entry.key]: value }, sensitive: true });
  return { ran: true, ok: r.status === 0, exit: r.status };
}

export function status(root, cfg) {
  return loadCatalog(root).map((e) => {
    const v = readSecret(root, cfg, e);
    return { key: e.key, kind: e.kind, purpose: e.purpose ?? '', usedBy: e.usedBy, state: v === null ? 'missing' : checkFormat(e, v).length ? 'invalid' : 'filled', store: cfg.secrets.store };
  });
}

function generate(entry) {
  const g = entry.generate ?? {};
  const bytes = g.bytes ?? 32;
  const v = crypto.randomBytes(bytes).toString(g.encoding ?? 'base64url');
  return g.length ? v.slice(0, g.length) : v;
}

// Fills generated keys and test keys from the project's own example files. Returns names only.
export function init(root, cfg) {
  const done = [];
  for (const e of loadCatalog(root)) {
    if (readSecret(root, cfg, e) !== null) continue;
    if (e.kind === 'generated') {
      writeSecret(root, cfg, e, generate(e));
      done.push({ key: e.key, action: 'generated' });
    } else if (e.kind === 'test' && e.from) {
      const file = path.resolve(root, e.from);
      const v = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')).get(e.fromKey ?? e.key) : undefined;
      if (v) {
        writeSecret(root, cfg, e, v);
        done.push({ key: e.key, action: `copied test value from ${e.from}` });
      }
    }
  }
  return done;
}

export function stepEnv(root, cfg, stepId) {
  const env = {};
  for (const e of loadCatalog(root)) {
    if (e.usedBy.length && !e.usedBy.includes(stepId)) continue;
    const v = readSecret(root, cfg, e);
    if (v !== null) env[e.key] = v;
  }
  return env;
}

export function missingFor(root, cfg, stepId) {
  return loadCatalog(root)
    .filter((e) => e.required !== false && e.usedBy.includes(stepId))
    .filter((e) => readSecret(root, cfg, e) === null)
    .map((e) => e.key);
}

// Masks every catalogued value. Short values (< 6 chars) are not masked to avoid shredding normal output.
export function redactor(root, cfg) {
  const values = loadCatalog(root)
    .map((e) => readSecret(root, cfg, e))
    .filter((v) => v && v.length >= 6)
    .sort((a, b) => b.length - a.length);
  if (!values.length) {
    const id = (s) => s;
    id.maxLen = 0;
    return id;
  }
  const re = new RegExp(values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const fn = (s) => s.replace(re, '[secret]');
  fn.maxLen = values[0].length;
  return fn;
}

function hiddenPrompt(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new WfError('not a terminal: run `wf secrets guide` in your own terminal, or pipe the value: `pbpaste | wf secrets set KEY`'));
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          return reject(new WfError('cancelled'));
        }
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export async function set(root, cfg, key) {
  const entry = loadCatalog(root).find((e) => e.key === key);
  if (!entry) throw new WfError(`${key} is not in .workflow/secrets.yaml`, { hint: 'add it to the catalog first so it is masked and checked' });
  const value = process.stdin.isTTY ? await hiddenPrompt(`${key}: `) : await readStdin();
  if (!value) throw refuse(`${key}: empty value, nothing stored`);
  const problems = checkFormat(entry, value);
  if (problems.length) throw refuse(`${key} ${problems.join('; ')}; nothing stored`);
  writeSecret(root, cfg, entry, value);
  const v = verifySecret(root, cfg, entry, value);
  return { key, stored: true, verified: v.ran ? v.ok : null };
}

export async function guide(root, cfg, onlyKey) {
  const out = (s = '') => process.stdout.write(`${s}\n`);
  const entries = loadCatalog(root).filter((e) => (onlyKey ? e.key === onlyKey : e.kind === 'provided'));
  const pending = entries.filter((e) => readSecret(root, cfg, e) === null || checkFormat(e, readSecret(root, cfg, e)).length);
  if (!pending.length) return out('Every provided secret is filled. Nothing to do.');
  out(`${pending.length} secret(s) to enter. Values are hidden as you paste and never shown again.\n`);
  let done = 0;
  for (const [i, e] of pending.entries()) {
    out(`[${i + 1}/${pending.length}] ${e.key}`);
    if (e.purpose) out(`  What it is for: ${e.purpose}`);
    if (e.usedBy.length) out(`  Used by: ${e.usedBy.join(', ')}`);
    if (e.obtain?.url) out(`  Get it here: ${e.obtain.url}`);
    for (const [n, s] of (e.obtain?.steps ?? []).entries()) out(`    ${n + 1}. ${s}`);
    for (;;) {
      let value;
      try {
        value = await hiddenPrompt('  Paste the value (Enter on empty to skip): ');
      } catch (error) {
        out(`  ${error.message}. Resume later with \`wf secrets guide\`.`);
        return;
      }
      if (!value) {
        out('  Skipped. It stays pending.\n');
        break;
      }
      const problems = checkFormat(e, value);
      if (problems.length) {
        out(`  ✗ ${problems.join('; ')}. Try again.`);
        continue;
      }
      writeSecret(root, cfg, e, value);
      const v = verifySecret(root, cfg, e, value);
      if (v.ran && !v.ok) {
        out(`  ✗ Stored, but the check failed (exit ${v.exit}). Paste again to replace it, or Enter to keep it.`);
        continue;
      }
      out(`  ✓ Stored${v.ran ? ' and verified' : ''}.\n`);
      done += 1;
      break;
    }
  }
  out(`${done}/${pending.length} done.`);
}

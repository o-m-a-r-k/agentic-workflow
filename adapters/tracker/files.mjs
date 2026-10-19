// The built-in files tracker (`ticketing: { tracker: files, via: files }`): each issue is `<root>/tickets/<id>.md`, YAML
// frontmatter (`id`, `title`, `status`, `labels`, `open`, and `team` on a filed issue) and the description as the body.
// Comments are appended to the body between `<!-- wf:comment -->` lines, each carrying its marker, so a marker search
// finds them. It implements the TrackerDriver of engine/contract.mjs; the engine calls it directly.
//
// Ids are an allowlist (letters, digits, `-`, `_`, inner dots; at most 64), checked before any filesystem call, so an
// id can never name a path. The folder and every ticket file must be real: a symbolic link is never read or written
// through, and a write goes to a temporary file renamed into place.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const YAML = createRequire(import.meta.url)('../../engine/vendor/yaml/dist/index.js');
const ID = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?$/;
const COMMENT = /<!-- wf:comment at=(\S+) -->\n([\s\S]*?)\n<!-- \/wf:comment -->/g;

export function checkId(id) {
  const s = String(id ?? '');
  if (!ID.test(s) || s.includes('..')) throw new Error(`invalid ticket id ${JSON.stringify(s.slice(0, 80))}: letters, digits, -, _ and inner dots only, at most 64`);
  return s;
}

function realFolder(folder) {
  const st = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (!st) throw new Error(`the tickets folder ${folder} does not exist`);
  if (!st.isDirectory()) throw new Error(`${folder} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a folder'}; tickets are not read or written through it`);
  return folder;
}

function fileOf(folder, id) {
  const file = path.join(folder, `${checkId(id)}.md`);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (st && !st.isFile()) throw new Error(`${file} is not a regular file; not read or written through`);
  return { file, exists: Boolean(st) };
}

function parse(file, id) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file} has no YAML frontmatter (--- id, title, status ---)`);
  const front = YAML.parse(m[1]) ?? {};
  if (front.id !== undefined && String(front.id) !== id) throw new Error(`${file}: its id \`${front.id}\` differs from its file name`);
  return { front, body: m[2] };
}

function write(file, front, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `---\n${YAML.stringify(front)}---\n${body}`, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

const view = (id, { front, body }) => ({
  id,
  title: String(front.title ?? ''),
  status: front.status ?? null,
  // A file with no `labels:` key carries none; the files tracker can always read its labels.
  labels: Array.isArray(front.labels) ? front.labels.map(String) : [],
  url: `tickets/${id}.md`,
  body,
});

// The driver over `<root>/tickets`. `folder` overrides it (tests).
export function filesTracker(root, { folder = path.join(root, 'tickets') } = {}) {
  const dir = () => realFolder(folder);
  const all = () => fs.readdirSync(dir()).filter((n) => n.endsWith('.md') && ID.test(n.slice(0, -3))).map((n) => n.slice(0, -3)).sort();
  const load = (id) => {
    const { file, exists } = fileOf(dir(), id);
    return exists ? { file, ...parse(file, id) } : null;
  };
  return {
    async read(id) {
      const t = load(id);
      return t ? view(id, t) : null;
    },
    async normalise(raw) {
      const s = String(raw ?? '').trim();
      if (!ID.test(s)) return null;
      // The file's own spelling, so `abc-1` and `ABC-1` reach one ticket on every volume.
      return all().find((id) => id.toLowerCase() === s.toLowerCase()) ?? null;
    },
    async search({ text, marker } = {}) {
      const out = [];
      for (const id of all()) {
        const t = load(id);
        const hit = marker ? t.body.includes(marker) : t.front.open !== false && (String(t.front.title ?? '').includes(text) || t.body.includes(text));
        if (hit) out.push(view(id, t));
      }
      return out;
    },
    async create({ title, body, team = null, status = null, label = null, marker }) {
      if (!marker || !String(body).includes(marker)) throw new Error('create: the body must carry the marker');
      const ids = all();
      // The next number after the highest, with that ticket's prefix (`ABC-7` → `ABC-8`); `1` in an empty folder.
      const nums = ids.map((id) => /^(.*?)(\d+)$/.exec(id)).filter(Boolean).sort((a, b) => Number(b[2]) - Number(a[2]));
      const id = nums.length ? `${nums[0][1]}${Number(nums[0][2]) + 1}` : '1';
      const { file, exists } = fileOf(dir(), id);
      if (exists) throw new Error(`create: ${file} already exists`);
      const front = { id, title, status, labels: label ? [label] : [], ...(team ? { team } : {}) };
      write(file, front, `${String(body).trim()}\n`);
      return { id };
    },
    async setStatus(id, status) {
      const t = load(id);
      if (!t) throw new Error(`no ticket ${id}`);
      if (t.front.status !== status) write(t.file, { ...t.front, status }, t.body);
    },
    async comment(id, { body, marker }) {
      if (!marker || !String(body).includes(marker)) throw new Error('comment: the body must carry the marker');
      const t = load(id);
      if (!t) throw new Error(`no ticket ${id}`);
      if (t.body.includes(marker)) return;
      const head = t.body.includes('\n## Comments') ? '' : '\n\n## Comments\n';
      write(t.file, t.front, `${t.body.replace(/\s*$/, '')}${head}\n<!-- wf:comment at=${new Date().toISOString()} -->\n${String(body).trim()}\n<!-- /wf:comment -->\n`);
    },
    // The comments of a ticket, for tests and readers.
    async comments(id) {
      const t = load(id);
      return t ? [...t.body.matchAll(COMMENT)].map((c) => ({ at: c[1], body: c[2] })) : [];
    },
  };
}

export const operations = {
  read: 'the engine reads tickets/<id>.md',
  search: 'the engine searches the ticket files',
  fileFollowUp: 'the engine writes a new ticket file',
  setStatus: 'the engine rewrites the frontmatter status',
  comment: 'the engine appends the comment to the ticket file',
};

export default filesTracker;

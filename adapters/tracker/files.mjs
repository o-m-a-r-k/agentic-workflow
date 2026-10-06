// Tickets as files in the repo (`tracker.kind: files`, `via: files`). Each ticket is `<folder>/<id>.md` (default
// folder `tickets/` at the project root): YAML frontmatter (id, title, status, labels) and the description as the body.
// The engine does every tracker action itself and reads the files back as its own, verifiable readback:
// - read: the ticket file;
// - status: the frontmatter `status` rewritten to the configured name (`tracker.statuses`);
// - comment: appended as a dated section between `<!-- wf:comment -->` markers;
// - attach: each delivered screenshot copied into `<folder>/<id>/attachments/<title>`, listed with its caption and
//   sha256 in `attachments.json` there.
// Ticket ids are an allowlist; the folder and every file must be real (no link is ever followed or written through,
// no hard link), inside the project and outside the evidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readRegular, writeNoFollow } from '../../engine/evidence.mjs';
import { canonical, isInside, touchesEvidence } from '../../engine/paths.mjs';
import { YAML } from '../../engine/util.mjs';

// Named finding (0.4.0 review: path traversal): the item id was joined into paths, and folders created, before it
// was validated. Every entry point now validates the id first, before any filesystem call: ASCII letters, digits,
// `-`, `_`, and `.` only inside the name (no leading `.` or `-`, no `..`), at most 64 characters; no separator, NUL,
// look-alike or invisible character can pass. The ticket's paths are then resolved and must lie strictly inside the
// resolved tickets folder and outside the evidence; on a case-insensitive volume a ticket whose name differs only
// in case is refused. Attachment titles pass the same kind of allowlist as plain file names.
const ID = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?$/;
const TITLE = /^[A-Za-z0-9_](?:[A-Za-z0-9_. -]{0,126}[A-Za-z0-9_])?$/;
export function checkItem(item) {
  const s = String(item ?? '');
  if (!ID.test(s) || s.includes('..')) throw new Error(`invalid ticket id ${JSON.stringify(s.slice(0, 80))}: letters, digits, -, _ and inner dots only, at most 64, no path`);
  return s;
}
export function checkTitle(title) {
  const s = String(title ?? '');
  if (!TITLE.test(s) || s.includes('..')) throw new Error(`invalid attachment name ${JSON.stringify(s.slice(0, 80))}: a plain file name (letters, digits, space, -, _, inner dots), no path`);
  return s;
}
function ticketPaths(folder, item) {
  checkItem(item);
  const real = canonical(folder);
  const file = path.join(folder, `${item}.md`);
  const dir = path.join(folder, item);
  // The folder resolved, the last name kept as is: a link there is never followed (no-follow reads and writes, and
  // the ticket's folder must be a real folder), so it cannot lead outside.
  for (const p of [file, dir]) {
    const c = path.join(real, path.basename(p));
    if (c === real || path.dirname(c) !== real || path.basename(c) !== path.basename(p)) throw new Error(`ticket ${item}: ${p} resolves outside the tickets folder`);
    if (touchesEvidence(c)) throw new Error(`ticket ${item}: ${p} is in the evidence`);
  }
  const names = fs.readdirSync(folder);
  const twin = names.find((n) => n !== `${item}.md` && n !== item && [`${item}.md`, item].some((x) => n.toLowerCase() === x.toLowerCase()));
  if (twin) throw new Error(`ticket ${item}: ${twin} differs only in case; refused (one name per ticket on every volume)`);
  return { file, dir };
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const COMMENT = /<!-- wf:comment id=(\S+) at=(\S+) -->\n([\s\S]*?)\n<!-- \/wf:comment -->/g;

function folderOf(root, cfg) {
  const folder = path.resolve(root, cfg.tracker.folder ?? 'tickets');
  if (!isInside(canonical(folder), canonical(root))) throw new Error(`tracker.folder ${folder} is outside the project`);
  if (touchesEvidence(folder)) throw new Error(`tracker.folder ${folder} is in the evidence`);
  const st = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (!st) throw new Error(`the tickets folder ${folder} does not exist`);
  if (!st.isDirectory()) throw new Error(`${folder} is ${st.isSymbolicLink() ? 'a symlink' : 'not a folder'}; tickets are not read or written through it`);
  return folder;
}

function realDir(dir, create) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) throw new Error(`${dir} is ${st.isSymbolicLink() ? 'a symlink' : 'not a folder'}; not written through`);
  if (!st && create) fs.mkdirSync(dir);
  return dir;
}

function readTicket(folder, item) {
  const { file } = ticketPaths(folder, item);
  const r = readRegular(file);
  if (!r) throw new Error(`no ticket ${item}: ${file} is missing, a link or not a regular file with one name`);
  const text = r.bytes.toString('utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file} has no YAML frontmatter (--- id, title, status ---)`);
  const front = YAML.parse(m[1]) ?? {};
  if (front.id !== undefined && String(front.id) !== item) throw new Error(`${file}: its id \`${front.id}\` differs from its file name`);
  const body = m[2];
  const comments = [...body.matchAll(COMMENT)].map((c) => ({ id: c[1], createdAt: c[2], updatedAt: c[2], body: c[3] }));
  const firstMarker = body.search(/<!-- wf:comment /);
  const description = (firstMarker < 0 ? body : body.slice(0, firstMarker)).replace(/\n## Comments\s*$/, '').trim();
  return { file, front, body, comments, description };
}

function readAttachments(folder, item) {
  const dir = path.join(ticketPaths(folder, item).dir, 'attachments');
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return [];
  const r = readRegular(path.join(dir, 'attachments.json'));
  const listed = r ? JSON.parse(r.bytes.toString('utf8')) : [];
  // Each listed file is read back: its bytes' sha256 is what the readback reports (a changed file shows as changed).
  return listed.map((a) => {
    let title = null;
    try {
      title = checkTitle(a.title);
    } catch {}
    const f = title ? readRegular(path.join(dir, title)) : null;
    return { id: a.title, title: a.title, subtitle: a.subtitle ?? null, url: `${item}/attachments/${title ?? 'invalid-name'}`, sha256: f ? sha256(f.bytes) : null, stored: Boolean(f) };
  });
}

function writeTicket(t, front, body) {
  writeNoFollow(t.file, `---\n${YAML.stringify(front)}---\n${body}`);
}

const readback = (folder, item) => {
  const t = readTicket(folder, item);
  return { issue: { identifier: item, title: t.front.title ?? '', description: t.description, status: t.front.status ?? null, url: path.relative(path.dirname(folder), t.file), labels: t.front.labels ?? [], comments: t.comments, attachments: readAttachments(folder, item) }, via: 'files' };
};

export default {
  via: 'files',
  operations: {
    readIssue: 'the engine reads tickets/<id>.md',
    setStatus: 'the engine rewrites the frontmatter status',
    comment: 'the engine appends the comment to the ticket file',
    attach: 'the engine copies each screenshot into tickets/<id>/attachments/ with its caption and sha256',
    readBack: 'the engine reads the files back',
  },
  isUpload: (a) => Boolean(a?.stored) && /^[^/]+\/attachments\/[^/]+$/.test(String(a?.url ?? '')),
  files: {
    async perform({ root, cfg, item, actions }) {
      checkItem(item);
      for (const a of actions) for (const f of a.op === 'attach' ? a.files : []) checkTitle(f.name);
      const folder = folderOf(root, cfg);
      const { dir: ticketDir } = ticketPaths(folder, item);
      const assets = {};
      const ordered = [...actions].sort((x, y) => (x.op === 'attach' ? -1 : 0) - (y.op === 'attach' ? -1 : 0));
      for (const a of ordered) {
        if (a.op === 'attach') {
          const dir = realDir(path.join(realDir(ticketDir, true), 'attachments'), true);
          const listFile = path.join(dir, 'attachments.json');
          const listed = readRegular(listFile);
          const list = listed ? JSON.parse(listed.bytes.toString('utf8')) : [];
          for (const f of a.files) {
            // The bytes the engine read once with its safe reader; this adapter never opens the screenshot's path.
            const title = f.name;
            writeNoFollow(path.join(dir, title), f.bytes);
            const entry = { title, subtitle: f.caption ?? null, sha256: f.sha256 };
            const i = list.findIndex((x) => x.title === title);
            if (i >= 0) list[i] = entry;
            else list.push(entry);
            assets[title] = `${item}/attachments/${title}`;
          }
          writeNoFollow(listFile, `${JSON.stringify(list, null, 2)}\n`);
        } else if (a.op === 'setStatus') {
          const t = readTicket(folder, item);
          if (t.front.status === a.status || (a.unless ?? []).includes(t.front.status)) continue;
          writeTicket(t, { ...t.front, status: a.status }, t.body);
        } else if (a.op === 'comment') {
          if (!a.body) continue;
          const t = readTicket(folder, item);
          const body = a.body.replace(/\{assetUrl:([^}]+)\}/g, (m, title) => assets[title] ?? `${item}/attachments/${path.basename(title)}`);
          if (a.reuseExisting && t.comments.some((c) => c.body.trim() === body.trim())) continue;
          const at = new Date().toISOString();
          const head = t.body.includes('\n## Comments') ? '' : '\n\n## Comments\n';
          writeTicket(t, t.front, `${t.body.replace(/\s*$/, '')}${head}\n<!-- wf:comment id=c-${t.comments.length + 1} at=${at} -->\n${body.trim()}\n<!-- /wf:comment -->\n`);
        }
      }
      return readback(folder, item);
    },
  },
  normalize(raw) {
    const issue = raw?.issue ?? raw ?? {};
    return {
      id: issue.identifier ?? issue.id,
      title: issue.title ?? '',
      description: typeof issue.description === 'string' ? issue.description : '',
      status: issue.status ?? null,
      url: issue.url ?? null,
      updatedAt: null,
      comments: (issue.comments ?? []).map((c) => ({ id: c.id, body: c.body ?? '', createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt })),
      attachments: (issue.attachments ?? []).map((a) => ({ id: a.id, title: a.title, subtitle: a.subtitle ?? null, filename: a.title, url: a.url, sha256: a.sha256 ?? null, stored: a.stored })),
    };
  },
};

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

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
  if (!ID.test(item) || item.includes('..')) throw new Error(`invalid ticket id \`${item}\``);
  const file = path.join(folder, `${item}.md`);
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
  const dir = path.join(folder, item, 'attachments');
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return [];
  const r = readRegular(path.join(dir, 'attachments.json'));
  const listed = r ? JSON.parse(r.bytes.toString('utf8')) : [];
  // Each listed file is read back: its bytes' sha256 is what the readback reports (a changed file shows as changed).
  return listed.map((a) => {
    const f = readRegular(path.join(dir, path.basename(String(a.title))));
    return { id: a.title, title: a.title, subtitle: a.subtitle ?? null, url: `${item}/attachments/${path.basename(String(a.title))}`, sha256: f ? sha256(f.bytes) : null, stored: Boolean(f) };
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
      const folder = folderOf(root, cfg);
      const assets = {};
      const ordered = [...actions].sort((x, y) => (x.op === 'attach' ? -1 : 0) - (y.op === 'attach' ? -1 : 0));
      for (const a of ordered) {
        if (a.op === 'attach') {
          const dir = realDir(path.join(realDir(path.join(folder, item), true), 'attachments'), true);
          const listFile = path.join(dir, 'attachments.json');
          const listed = readRegular(listFile);
          const list = listed ? JSON.parse(listed.bytes.toString('utf8')) : [];
          for (const f of a.files) {
            const title = path.basename(String(f.title ?? path.basename(f.path)));
            const src = readRegular(f.path);
            if (!src) throw new Error(`${f.path} is not a regular file`);
            writeNoFollow(path.join(dir, title), src.bytes);
            const entry = { title, subtitle: f.caption ?? null, sha256: sha256(src.bytes) };
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

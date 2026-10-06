// A fake GitHub REST API for the tracker tests (no network). State lives in one JSON file so both transports share it:
// - `node fake-github.mjs serve <state.json> <token>`: an HTTP server on 127.0.0.1 (via: api), port in <state.json>.port;
// - `gh api ...` / `gh auth status` through the `gh` shim next to this file (via: cli), state from FAKE_GH_STATE.
import fs from 'node:fs';
import http from 'node:http';

const load = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, db) => fs.writeFileSync(file, JSON.stringify(db, null, 2));

// Returns { status, data }. `body` is parsed JSON, or a Buffer for an upload.
export function handle(db, method, target, body) {
  const u = new URL(target, 'https://api.github.com');
  const q = u.searchParams;
  const p = u.pathname.replace(/^\/api\/v3/, '');
  const m = (re) => re.exec(p);
  const repo = `/repos/${db.repo}`;
  if (!p.startsWith(`${repo}/`)) return { status: 404, data: { message: 'Not Found' } };
  const rest = p.slice(repo.length);
  const issue = db.issue;
  const at = () => new Date().toISOString();
  let r;
  if ((r = m(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/)) && method === 'GET') return r[1] === String(issue.number) ? { status: 200, data: issue } : { status: 404, data: { message: 'Not Found' } };
  if (rest === `/issues/${issue.number}/comments` && method === 'GET') return { status: 200, data: db.comments };
  if (rest === `/issues/${issue.number}/comments` && method === 'POST') {
    const c = { id: 1000 + db.comments.length, body: body.body, created_at: at(), updated_at: at() };
    db.comments.push(c);
    db.log.push('comment');
    return { status: 201, data: c };
  }
  if (rest === `/issues/${issue.number}/labels` && method === 'POST') {
    for (const l of body.labels) if (!issue.labels.some((x) => x.name === l)) issue.labels.push({ name: l });
    db.log.push(`label ${body.labels.join(',')}`);
    return { status: 200, data: issue.labels };
  }
  if ((r = m(/\/issues\/\d+\/labels\/(.+)$/)) && method === 'DELETE') {
    const name = decodeURIComponent(r[1]);
    issue.labels = issue.labels.filter((x) => x.name !== name);
    db.log.push(`unlabel ${name}`);
    return { status: 200, data: issue.labels };
  }
  if ((r = m(/\/releases\/tags\/(.+)$/)) && method === 'GET') {
    const rel = db.releases.find((x) => x.tag_name === decodeURIComponent(r[1]));
    return rel ? { status: 200, data: rel } : { status: 404, data: { message: 'Not Found' } };
  }
  if (rest === '/releases' && method === 'POST') {
    const rel = { id: 7, tag_name: body.tag_name, name: body.name, prerelease: body.prerelease, assets: [] };
    db.releases.push(rel);
    db.log.push(`release ${body.tag_name}`);
    return { status: 201, data: rel };
  }
  if ((r = m(/\/releases\/(\d+)\/assets$/))) {
    const rel = db.releases.find((x) => String(x.id) === r[1]);
    if (!rel) return { status: 404, data: { message: 'Not Found' } };
    if (method === 'GET') return { status: 200, data: rel.assets };
    if (method === 'POST') {
      const name = q.get('name');
      if (rel.assets.some((a) => a.name === name)) return { status: 422, data: { message: 'already_exists' } };
      const a = { id: 500 + db.nextAsset++, name, label: q.get('label') ?? '', size: body.length, browser_download_url: `https://github.com/${db.repo}/releases/download/${rel.tag_name}/${name}` };
      rel.assets.push(a);
      db.log.push(`upload ${name}`);
      return { status: 201, data: a };
    }
  }
  if ((r = m(/\/releases\/assets\/(\d+)$/)) && method === 'DELETE') {
    for (const rel of db.releases) rel.assets = rel.assets.filter((a) => String(a.id) !== r[1]);
    db.log.push(`delete asset ${r[1]}`);
    return { status: 204, data: null };
  }
  return { status: 404, data: { message: `fake: no route ${method} ${p}` } };
}

export function seed(file, { repo = 'acme/app', number = 12, title = 'Show the new text', body = 'The home screen shows the new text.', labels = [] } = {}) {
  save(file, { repo, issue: { number, title, body, state: 'open', labels: labels.map((name) => ({ name })), html_url: `https://github.com/${repo}/issues/${number}`, updated_at: '2026-01-01T00:00:00Z' }, comments: [], releases: [], nextAsset: 0, log: [] });
}

export function apply(file, method, target, body) {
  const db = load(file);
  const r = handle(db, method, target, body);
  save(file, db);
  return r;
}

if (process.argv[2] === 'serve') {
  const [file, token] = process.argv.slice(3);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(data === null ? '' : JSON.stringify(data));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Bad credentials' });
      const isJson = String(req.headers['content-type'] ?? '').includes('json');
      const r = apply(file, req.method, req.url, isJson ? JSON.parse(raw.toString('utf8') || 'null') : raw);
      send(r.status, r.data);
    });
  });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(`${file}.port`, String(server.address().port)));
}

// A fake Linear GraphQL endpoint for scenario tests. Usage: node fake-linear.mjs <state.json> <token>
// Writes the port to <state.json>.port, keeps the issue in <state.json> and logs every operation.
import fs from 'node:fs';
import http from 'node:http';

const [stateFile, token] = process.argv.slice(2);
const load = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
let port = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const s = load();
    const reply = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'PUT' && req.url.startsWith('/upload/')) {
      s.log.push(`upload ${decodeURIComponent(req.url.slice(8))}`);
      save(s);
      return reply(200, {});
    }
    if (req.headers.authorization !== token) return reply(401, { errors: [{ message: 'Authentication required' }] });
    const { query, variables } = JSON.parse(body || '{}');
    const issue = s.issue;
    const at = new Date().toISOString();
    if (/query Issue/.test(query)) {
      s.log.push('read');
      save(s);
      if (variables.id !== issue.identifier) return reply(200, { data: { issue: null } });
      return reply(200, { data: { issue: { ...issue, comments: { nodes: issue.comments }, attachments: { nodes: issue.attachments }, team: { states: { nodes: s.states } } } } });
    }
    if (/issueUpdate/.test(query)) {
      issue.state = { name: s.states.find((x) => x.id === variables.stateId).name };
      issue.updatedAt = at;
      s.log.push(`status ${issue.state.name}`);
    } else if (/commentCreate/.test(query)) {
      issue.comments.push({ id: `c${issue.comments.length + 1}`, body: variables.body, createdAt: at, updatedAt: at });
      issue.updatedAt = at;
      s.log.push('comment');
    } else if (/fileUpload/.test(query)) {
      s.log.push(`fileUpload ${variables.filename}`);
      save(s);
      return reply(200, { data: { fileUpload: { uploadFile: { uploadUrl: `http://127.0.0.1:${port}/upload/${encodeURIComponent(variables.filename)}`, assetUrl: `https://assets.example.test/${variables.filename}`, headers: [] } } } });
    } else if (/attachmentCreate/.test(query)) {
      issue.attachments.push({ id: `a${issue.attachments.length + 1}`, title: variables.title, url: variables.url });
      issue.updatedAt = at;
      s.log.push(`attach ${variables.title}`);
    }
    save(s);
    return reply(200, { data: { ok: { success: true } } });
  });
});
server.listen(0, '127.0.0.1', () => {
  port = server.address().port;
  fs.writeFileSync(`${stateFile}.port`, String(port));
});

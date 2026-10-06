// Linear, two ways. `via: connector` (default): the agent performs each operation through its MCP connector and saves the
// raw response as the capture; the engine holds no credentials. `via: api`: the engine performs the pending actions
// itself with a personal API key from `wf secrets` and stores its own readback as the capture.
import path from 'node:path';

// Where a screenshot may be PUT: Linear's own upload storage over https, or the same loopback host as a local test
// endpoint. Anything else is refused before a byte is sent.
const UPLOAD_HOSTS = [/(^|\.)linear\.app$/, /^storage\.googleapis\.com$/];
function uploadUrlProblem(uploadUrl, apiUrl) {
  let u;
  try {
    u = new URL(String(uploadUrl));
  } catch {
    return 'the upload url is not a URL';
  }
  const api = new URL(String(apiUrl));
  const loop = ['127.0.0.1', 'localhost', '[::1]'];
  if (loop.includes(api.hostname) && u.hostname === api.hostname && ['http:', 'https:'].includes(u.protocol)) return null;
  if (u.protocol !== 'https:') return `upload url ${u.protocol}//${u.host} is not https`;
  if (u.username || u.password) return 'the upload url carries credentials';
  return UPLOAD_HOSTS.some((re) => re.test(u.hostname)) ? null : `upload host ${u.host} is not Linear's upload storage`;
}

const ISSUE = `query Issue($id: String!) { issue(id: $id) { id identifier title description url updatedAt state { name }
  team { states { nodes { id name } } }
  comments { nodes { id body createdAt updatedAt } }
  attachments { nodes { id title subtitle url } } } }`;
const UPDATE = 'mutation Update($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }';
const COMMENT = 'mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }';
const UPLOAD = 'mutation Upload($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { uploadFile { uploadUrl assetUrl headers { key value } } } }';
const ATTACH = 'mutation Attach($issueId: String!, $title: String!, $subtitle: String, $url: String!) { attachmentCreate(input: { issueId: $issueId, title: $title, subtitle: $subtitle, url: $url }) { success } }';
// Linear stores uploaded files on its own upload host; any other url is a link attachment.
const UPLOAD_HOST = /^https:\/\/uploads\.linear\.app\//;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const imageUrls = (body) => [...String(body ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
const first = (...values) => values.find((v) => v !== undefined && v !== null);
// A connection (`{ nodes }`), a list_comments response (`{ comments, hasNextPage }`), or a plain list.
const list = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.nodes) ? v.nodes : Array.isArray(v?.[key]) ? v[key] : []);
// An MCP tool result saved whole (`{ content: [{ type: 'text', text: '<json>' }] }`) is unwrapped to its JSON.
const unwrap = (v) => {
  const texts = Array.isArray(v?.content) ? v.content.filter((c) => c?.type === 'text' && typeof c.text === 'string') : [];
  if (!texts.length) return v;
  const parsed = texts.map((c) => {
    try {
      return JSON.parse(c.text);
    } catch {
      return null;
    }
  }).filter(Boolean);
  return parsed.length === 1 ? parsed[0] : parsed.length ? parsed : v;
};
// The fields the Linear MCP tools always return. A capture missing any of them was rebuilt by hand, not saved.
const ISSUE_FIELDS = ['id', 'uuid', 'title', 'status', 'statusType', 'createdAt', 'updatedAt', 'stateHistory', 'attachments'];
const ATTACHMENT_FIELDS = ['id', 'title', 'subtitle', 'url'];
const COMMENT_FIELDS = ['id', 'body', 'createdAt', 'updatedAt', 'author'];
const missingKeys = (o, keys) => (o && typeof o === 'object' && !Array.isArray(o) ? keys.filter((k) => !(k in o)) : keys);
// Linear signs every uploads.linear.app url it returns on read; an unsigned one was edited.
const unsigned = (url) => UPLOAD_HOST.test(String(url ?? '')) && !/[?&]signature=/.test(String(url));
const isIssue = (v) => v && typeof v === 'object' && !Array.isArray(v) && (v.identifier || v.id) && ('title' in v || 'status' in v || 'state' in v);

export default {
  via: 'agent',
  operations: {
    readIssue: 'Linear get_issue (include comments and attachments) or list_comments',
    setStatus: 'Linear save_issue with the status name',
    comment: 'Linear save_comment with the body `wf` rendered (delivery/delivered-comment.md), each {assetUrl:<title>} replaced by the assetUrl that upload returned, so every screenshot shows inline; reuse an existing comment with the same body instead of posting a duplicate',
    attach: 'Upload each file as a real attachment, one file at a time (a signed upload url expires in 60 s): Linear prepare_attachment_upload { issue, filename: <title>, contentType: image/png (or the file\'s type), size: <exact bytes of the exported copy, e.g. wc -c < copy>, title: <title>, subtitle: <caption> }; then PUT the raw bytes of the exported copy (the path the SHOW block lists; never an evidence path, which the guard refuses) to uploadRequest.url with every uploadRequest.headers entry sent verbatim (curl -X PUT --data-binary @<copy> -H ...; never base64); then create_attachment_from_upload { issue, assetUrl, title: <title>, subtitle: <caption> }. Title is the file name `wf` lists, subtitle the caption recorded with `wf shown`. Never create a link attachment: the readback must show an uploads.linear.app attachment with that title and subtitle. Keep each assetUrl: the delivered comment embeds it as `![<title>](<assetUrl>)` (an attachment alone shows only as "added N links")',
    readBack: 'Linear get_issue (its response carries the attachments with title, subtitle and url) + list_comments, saved together as JSON',
  },
  saveRaw: 'run Linear get_issue (id) and list_comments (issueId) and keep each result as returned. In Claude Code a long tool result is saved to a file and the output names its path: copy that file (`cp <saved path> issue.json`); otherwise write the whole JSON text the tool printed to the file unchanged. Then combine them without editing: `jq -s \'{issue: .[0], comments: .[1]}\' issue.json comments.json > capture.json` (or pass the list [get_issue, list_comments] as saved)',
  // What a raw get_issue + list_comments capture always carries; problems name what is missing.
  rawProblems(input, { comments = false } = {}) {
    let raw = unwrap(input);
    let issue = null;
    let list = null;
    if (Array.isArray(raw)) {
      const parts = raw.map(unwrap);
      issue = parts.find((p) => isIssue(p)) ?? null;
      list = parts.find((p) => p && Array.isArray(p.comments) && !isIssue(p)) ?? null;
    } else if (raw && typeof raw === 'object' && 'issue' in raw) {
      issue = unwrap(raw.issue);
      list = 'comments' in raw ? unwrap(raw.comments) : null;
    } else issue = raw;
    const out = [];
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return ['no get_issue result'];
    if (issue.via === 'linear-api' || raw?.via === 'linear-api') out.push('it claims to be the engine\'s API readback, which only `wf` itself records');
    const mi = missingKeys(issue, ISSUE_FIELDS);
    if (mi.length) out.push(`get_issue fields missing: ${mi.join(', ')}`);
    for (const a of Array.isArray(issue.attachments) ? issue.attachments : []) {
      const ma = missingKeys(a, ATTACHMENT_FIELDS);
      if (ma.length) out.push(`attachment ${a?.title ?? a?.id ?? '?'} lacks ${ma.join(', ')}`);
      else if (unsigned(a.url)) out.push(`attachment ${a.title}: its uploads.linear.app url has no signature (Linear signs every url it returns)`);
    }
    if (comments) {
      if (!list || Array.isArray(list) || !Array.isArray(list.comments)) out.push('no list_comments result (`{ comments, hasNextPage }` as the tool returns it)');
      else {
        if (!('hasNextPage' in list)) out.push('list_comments result lacks hasNextPage');
        else if (list.hasNextPage === true) out.push('list_comments has more pages; read until hasNextPage is false and save every page');
        for (const c of list.comments) {
          const mc = missingKeys(c, COMMENT_FIELDS);
          if (mc.length) out.push(`comment ${c?.id ?? '?'} lacks ${mc.join(', ')}`);
          else if (imageUrls(c.body).some(unsigned)) out.push(`comment ${c.id}: an embedded uploads.linear.app image url has no signature (Linear signs on read)`);
        }
      }
    }
    return out;
  },
  captureShape: '{ "issue": <get_issue response, unchanged>, "comments": <list_comments response, unchanged> } (get_issue alone is enough when no comment is checked)',
  // An uploaded file, not a link: what `wf tracker record` requires of every delivered screenshot.
  isUpload: (a) => UPLOAD_HOST.test(String(a?.url ?? '')),
  apiKey: 'LINEAR_API_KEY',
  rules: { attachmentTitleIsFilename: true },
  api: {
    url: 'https://api.linear.app/graphql',
    // Performs one event's actions, then reads the issue back. The token never appears in an error message.
    async perform({ token, url, item, actions }) {
      const gql = async (query, variables) => {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: token }, body: JSON.stringify({ query, variables }), redirect: 'manual' });
        if (r.status >= 300 && r.status < 400) throw new Error(`Linear API: redirected (${r.status}); a request with the key never follows a redirect`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.errors?.length) throw new Error(`Linear API ${r.status}: ${(j.errors ?? []).map((e) => e.message).join('; ') || r.statusText}`);
        return j.data;
      };
      const read = async () => {
        const issue = (await gql(ISSUE, { id: item })).issue;
        if (!issue) throw new Error(`Linear API: issue ${item} not found`);
        return issue;
      };
      let issue = await read();
      // Uploads first: the comment embeds each one by its asset url.
      const assets = {};
      for (const x of issue.attachments?.nodes ?? []) if (UPLOAD_HOST.test(x.url ?? '')) assets[x.title] = String(x.url).split('?')[0];
      const ordered = [...actions].sort((x, y) => (x.op === 'attach' ? -1 : 0) - (y.op === 'attach' ? -1 : 0));
      for (const a of ordered) {
        if (a.op === 'setStatus') {
          if (issue.state?.name === a.status || (a.unless ?? []).includes(issue.state?.name)) continue;
          const state = issue.team?.states?.nodes?.find((x) => x.name === a.status);
          if (!state) throw new Error(`Linear API: no workflow state named "${a.status}" in the issue's team`);
          await gql(UPDATE, { id: issue.id, stateId: state.id });
        } else if (a.op === 'comment') {
          if (!a.body) continue;
          const body = a.body.replace(/\{assetUrl:([^}]+)\}/g, (m, t) => assets[t] ?? m);
          const left = body.match(/\{assetUrl:[^}]+\}/g);
          if (left) throw new Error(`Linear API: no uploaded asset for ${left.join(', ')}`);
          const same = (x) => x.replace(/(https:\/\/uploads\.linear\.app\/[^)\s?]+)\?[^)\s]*/g, '$1');
          if (a.reuseExisting && (issue.comments?.nodes ?? []).some((c) => same(c.body) === same(body))) continue;
          await gql(COMMENT, { issueId: issue.id, body });
        } else if (a.op === 'attach') {
          for (const f of a.files) {
            const name = f.name;
            const existing = (issue.attachments?.nodes ?? []).find((x) => x.title === name && UPLOAD_HOST.test(x.url ?? '') && (x.subtitle ?? '') === (f.caption ?? ''));
            if (existing) {
              assets[name] = String(existing.url).split('?')[0];
              continue;
            }
            // The bytes the engine read once with its safe reader; this adapter never opens the screenshot's path.
            const body = f.bytes;
            const contentType = TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
            const up = (await gql(UPLOAD, { contentType, filename: name, size: body.length })).fileUpload.uploadFile;
            const problem = uploadUrlProblem(up.uploadUrl, url);
            if (problem) throw new Error(`Linear upload of ${name}: ${problem}; not sent`);
            // The signed upload url needs no key: only the headers Linear returned (never an authorization header).
            const signed = Object.fromEntries((up.headers ?? []).filter((h) => !/^(authorization|cookie|proxy-authorization)$/i.test(String(h.key))).map((h) => [h.key, h.value]));
            const put = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000', ...signed }, body, redirect: 'manual' });
            if (!put.ok) throw new Error(`Linear upload of ${name} failed: ${put.status}`);
            await gql(ATTACH, { issueId: issue.id, title: name, subtitle: f.caption ?? null, url: up.assetUrl });
            assets[name] = up.assetUrl;
          }
        }
      }
      issue = await read();
      const { team, ...rest } = issue;
      return { issue: rest, comments: issue.comments?.nodes ?? [], attachments: issue.attachments?.nodes ?? [], via: 'linear-api' };
    },
  },
  // Accepted readbacks: the raw get_issue JSON alone (`id` is the identifier, `status` the state name, `attachments`
  // a list); `{ "issue": <get_issue>, "comments": <list_comments response or its comments> }`; the API mode's
  // `{ issue, comments, attachments }`; a list of tool results ([get_issue, list_comments]); either tool result saved
  // whole as an MCP `content` envelope.
  normalize(input) {
    let raw = unwrap(input);
    if (Array.isArray(raw)) {
      const parts = raw.map(unwrap);
      const found = parts.find((p) => isIssue(p) || isIssue(p?.issue));
      raw = { issue: found?.issue ?? found ?? {}, comments: parts.find((p) => Array.isArray(p?.comments))?.comments ?? found?.comments };
    }
    raw = { ...raw, issue: unwrap(raw.issue) };
    // A hand-written `{ "issue": "ENG-1", "status": ... }`: the string is the identifier, the rest is the issue.
    const issue = typeof raw.issue === 'string' ? { ...raw, identifier: raw.issue } : raw.issue && typeof raw.issue === 'object' ? raw.issue : raw;
    return {
      id: first(issue.identifier, issue.id),
      title: issue.title ?? '',
      // The issue body. `wf tracker record` refuses an `admitted` capture without it unless it says the issue has none.
      description: typeof issue.description === 'string' ? issue.description : '',
      status: first(issue.state?.name, issue.status?.name, issue.status, issue.state),
      url: issue.url ?? null,
      updatedAt: issue.updatedAt ?? null,
      comments: list(unwrap(first(raw.comments, issue.comments)), 'comments').map((c) => ({ id: c.id, body: c.body ?? '', createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt })),
      attachments: list(unwrap(first(raw.attachments, issue.attachments)), 'attachments').map((a) => ({ id: a.id, title: a.title ?? '', subtitle: a.subtitle ?? null, filename: a.filename ?? a.title ?? '', url: a.url ?? null })),
    };
  },
};

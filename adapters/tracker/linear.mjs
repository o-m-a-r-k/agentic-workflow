// Linear, two ways. `via: agent` (default): the agent performs each operation through its MCP connector and saves the
// raw response as the capture; the engine holds no credentials. `via: api`: the engine performs the pending actions
// itself with a personal API key from `wf secrets` and stores its own readback as the capture.
import fs from 'node:fs';
import path from 'node:path';

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

const first = (...values) => values.find((v) => v !== undefined && v !== null);
const list = (v) => (Array.isArray(v) ? v : Array.isArray(v?.nodes) ? v.nodes : []);

export default {
  via: 'agent',
  operations: {
    readIssue: 'Linear get_issue (include comments and attachments) or list_comments',
    setStatus: 'Linear save_issue with the status name',
    comment: 'Linear save_comment; reuse an existing comment with the same body instead of posting a duplicate',
    attach: 'Upload each file as a real attachment, one file at a time (a signed upload url expires in 60 s): Linear prepare_attachment_upload { issue, filename: <title>, contentType: image/png (or the file\'s type), size: <exact bytes, e.g. wc -c < path>, title: <title>, subtitle: <caption> }; then PUT the raw bytes to uploadRequest.url with every uploadRequest.headers entry sent verbatim (curl -X PUT --data-binary @<path> -H ...; never base64); then create_attachment_from_upload { issue, assetUrl, title: <title>, subtitle: <caption> }. Title is the file name `wf` lists, subtitle the caption recorded with `wf shown`. Never create a link attachment or paste the image into a comment: the readback must show an uploads.linear.app attachment with that title and subtitle',
    readBack: 'Linear get_issue (its response carries the attachments with title, subtitle and url) + list_comments, saved together as JSON',
  },
  captureShape: '{ "issue": <get_issue response>, "comments": [<comments>], "attachments": [<attachments>] }',
  // An uploaded file, not a link: what `wf tracker record` requires of every delivered screenshot.
  isUpload: (a) => UPLOAD_HOST.test(String(a?.url ?? '')),
  rules: { attachmentTitleIsFilename: true },
  api: {
    url: 'https://api.linear.app/graphql',
    // Performs one event's actions, then reads the issue back. The token never appears in an error message.
    async perform({ token, url, item, actions }) {
      const gql = async (query, variables) => {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: token }, body: JSON.stringify({ query, variables }) });
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
      for (const a of actions) {
        if (a.op === 'setStatus') {
          if (issue.state?.name === a.status || (a.unless ?? []).includes(issue.state?.name)) continue;
          const state = issue.team?.states?.nodes?.find((x) => x.name === a.status);
          if (!state) throw new Error(`Linear API: no workflow state named "${a.status}" in the issue's team`);
          await gql(UPDATE, { id: issue.id, stateId: state.id });
        } else if (a.op === 'comment') {
          if (a.reuseExisting && (issue.comments?.nodes ?? []).some((c) => c.body === a.body)) continue;
          await gql(COMMENT, { issueId: issue.id, body: a.body });
        } else if (a.op === 'attach') {
          for (const f of a.files) {
            const name = f.title ?? path.basename(f.path);
            if ((issue.attachments?.nodes ?? []).some((x) => x.title === name && UPLOAD_HOST.test(x.url ?? '') && (x.subtitle ?? '') === (f.caption ?? ''))) continue;
            const body = fs.readFileSync(f.path);
            const contentType = TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
            const up = (await gql(UPLOAD, { contentType, filename: name, size: body.length })).fileUpload.uploadFile;
            const put = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000', ...Object.fromEntries((up.headers ?? []).map((h) => [h.key, h.value])) }, body });
            if (!put.ok) throw new Error(`Linear upload of ${name} failed: ${put.status}`);
            await gql(ATTACH, { issueId: issue.id, title: name, subtitle: f.caption ?? null, url: up.assetUrl });
          }
        }
      }
      issue = await read();
      const { team, ...rest } = issue;
      return { issue: rest, comments: issue.comments?.nodes ?? [], attachments: issue.attachments?.nodes ?? [], via: 'linear-api' };
    },
  },
  normalize(raw) {
    const issue = raw.issue ?? raw;
    return {
      id: first(issue.identifier, issue.id),
      title: issue.title ?? '',
      // The issue body. `wf tracker record` refuses an `admitted` capture without it unless it says the issue has none.
      description: typeof issue.description === 'string' ? issue.description : '',
      status: first(issue.state?.name, issue.status?.name, issue.status, issue.state),
      url: issue.url ?? null,
      updatedAt: issue.updatedAt ?? null,
      comments: list(first(raw.comments, issue.comments)).map((c) => ({ id: c.id, body: c.body ?? '', createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt })),
      attachments: list(first(raw.attachments, issue.attachments)).map((a) => ({ id: a.id, title: a.title ?? '', subtitle: a.subtitle ?? null, filename: a.filename ?? a.title ?? '', url: a.url ?? null })),
    };
  },
};

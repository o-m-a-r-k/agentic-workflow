// GitHub Issues (`tracker.kind: github`, `tracker.repo: owner/name`). The engine does every action through the GitHub
// REST API and reads it back itself, two ways:
// - `via: cli` (default): through `gh api`, with the owner's existing `gh` login (wf never sees or prints the token);
// - `via: api`: with a token from `wf secrets` (`tracker.apiKey`, default GITHUB_TOKEN).
// Status is a label: each configured status name (`tracker.statuses`) is a label; setting one removes the others.
// Screenshots: GitHub has no API to upload an issue attachment, so each is uploaded as an asset of one prerelease
// (`tracker.releaseTag`, default `wf-attachments`; created on first use, which creates that git tag in the repo), named
// `<item>--<title>` with the caption as its label, and the delivered comment embeds each by its download url. Release
// assets of a public repo are public. The readback checks the asset's name, label and size (GitHub reports no hash).
// Security: the engine hands over each screenshot's bytes (read once by its safe reader) and endpoints from the
// adapter committed at the base; this file never opens a local path. Requests with a token never follow a redirect;
// `gh` gets no token from wf (it uses its own login) and every value reaches it as one argv element or on stdin, never
// through a shell.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cliEnv } from '../../engine/scrub.mjs';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const numberOf = (item) => {
  const m = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d{1,9})$/.exec(String(item));
  if (!m) throw new Error(`a GitHub issue item is its number (\`123\` or \`GH-123\`), not \`${item}\``);
  return m[1];
};
const repoOf = (cfg) => {
  const r = String(cfg.tracker.repo ?? '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) throw new Error('`tracker.repo` must be owner/name');
  return r;
};

// One REST call. `body` is JSON or { bytes, type } (binary upload).
function transport(via, { token, url, cfg }) {
  const apiBase = String(url ?? cfg.tracker.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const uploadBase = String(cfg.tracker.uploadUrl ?? (apiBase === 'https://api.github.com' ? 'https://uploads.github.com' : apiBase)).replace(/\/$/, '');
  if (via === 'cli') {
    return async (method, p, body, { upload = false } = {}) => {
      const target = upload ? `${uploadBase}${p}` : p;
      const args = ['api', '-X', method, target, '-H', 'Accept: application/vnd.github+json'];
      let input;
      if (body?.bytes) {
        args.push('-H', `Content-Type: ${body.type}`, '--input', '-');
        input = body.bytes;
      } else if (body !== undefined) {
        args.push('--input', '-');
        input = JSON.stringify(body);
      }
      const r = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false, env: cliEnv() });
      if (r.error) throw new Error('the GitHub CLI `gh` is not on PATH');
      if (r.status !== 0) {
        if (/HTTP 404/.test(r.stderr)) return { status: 404, data: null };
        throw new Error(`gh api ${method} ${p}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
      }
      return { status: 200, data: r.stdout.trim() ? JSON.parse(r.stdout) : null };
    };
  }
  return async (method, p, body, { upload = false } = {}) => {
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
    let payload;
    if (body?.bytes) {
      headers['content-type'] = body.type;
      payload = body.bytes;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${upload ? uploadBase : apiBase}${p}`, { method, headers, body: payload, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) throw new Error(`GitHub API ${method} ${p}: redirected (${res.status}); a request with the token never follows a redirect`);
    if (res.status === 404) return { status: 404, data: null };
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`GitHub API ${method} ${p}: ${res.status} ${data?.message ?? res.statusText}`);
    return { status: res.status, data };
  };
}

// Whether the repository is private: true, false, or null when GitHub did not say (treated as public).
async function visibility(via, { token, url, cfg }) {
  try {
    const r = await transport(via, { token, url, cfg })('GET', `/repos/${repoOf(cfg)}`);
    return typeof r.data?.private === 'boolean' ? r.data.private : null;
  } catch {
    return null;
  }
}
export const PUBLIC_NOTICE = 'screenshots will be publicly downloadable: they are stored as release assets of a public repository (or one whose visibility GitHub did not report)';
export const PUBLIC_FIX = 'the owner decides: keep it with `publicAssets: acknowledged` under `tracker:` committed on the base branch, use the files tracker (`tracker.kind: files`), or keep the issues in a private repository';

async function perform(via, { token, url, item, actions, cfg }) {
  const call = transport(via, { token, url, cfg });
  const repo = repoOf(cfg);
  const n = numberOf(item);
  const statuses = Object.values(cfg.tracker.statuses ?? {}).filter(Boolean);
  const tag = String(cfg.tracker.releaseTag ?? 'wf-attachments');
  const prefix = `${item}--`;
  let release = null;
  const getRelease = async (create) => {
    if (release) return release;
    const r = await call('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (r.status !== 404) return (release = r.data);
    if (!create) return null;
    release = (await call('POST', `/repos/${repo}/releases`, { tag_name: tag, name: 'wf attachments', body: 'Screenshots delivered with tickets (agentic-workflow).', prerelease: true })).data;
    return release;
  };
  const assetsOf = async () => {
    const rel = await getRelease(false);
    if (!rel) return [];
    return ((await call('GET', `/repos/${repo}/releases/${rel.id}/assets?per_page=100`)).data ?? []).filter((x) => String(x.name).startsWith(prefix));
  };
  const read = async () => {
    const issue = (await call('GET', `/repos/${repo}/issues/${n}`)).data;
    if (!issue) throw new Error(`GitHub: issue ${repo}#${n} not found`);
    const comments = (await call('GET', `/repos/${repo}/issues/${n}/comments?per_page=100`)).data ?? [];
    return { issue, comments, assets: await assetsOf() };
  };
  let cur = await read();
  const assetUrls = Object.fromEntries(cur.assets.map((x) => [x.name.slice(prefix.length), x.browser_download_url]));
  const ordered = [...actions].sort((x, y) => (x.op === 'attach' ? -1 : 0) - (y.op === 'attach' ? -1 : 0));
  for (const a of ordered) {
    if (a.op === 'setStatus') {
      const labels = (cur.issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
      if (labels.includes(a.status) || (a.unless ?? []).some((u) => labels.includes(u))) continue;
      for (const old of labels.filter((l) => statuses.includes(l) && l !== a.status)) await call('DELETE', `/repos/${repo}/issues/${n}/labels/${encodeURIComponent(old)}`);
      await call('POST', `/repos/${repo}/issues/${n}/labels`, { labels: [a.status] });
    } else if (a.op === 'attach') {
      // Release assets of a public repository are downloadable by anyone: uploaded only with the owner's
      // acknowledgement (checked again here, whatever the caller did).
      if (a.files.length && cfg.tracker.publicAssets !== 'acknowledged' && (await visibility(via, { token, url, cfg })) !== true) throw new Error(`${PUBLIC_NOTICE}; not uploaded. Fix: ${PUBLIC_FIX}`);
      const rel = await getRelease(true);
      for (const f of a.files) {
        const title = f.name;
        const name = `${prefix}${title}`.replace(/[^A-Za-z0-9._-]/g, '_');
        const have = cur.assets.find((x) => x.name === name);
        const size = f.size;
        if (have && have.label === (f.caption ?? '') && have.size === size) {
          assetUrls[title] = have.browser_download_url;
          continue;
        }
        if (have) await call('DELETE', `/repos/${repo}/releases/assets/${have.id}`);
        const up = await call('POST', `/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}&label=${encodeURIComponent(f.caption ?? '')}`, { bytes: f.bytes, type: TYPES[path.extname(title).toLowerCase()] ?? 'application/octet-stream' }, { upload: true });
        assetUrls[title] = up.data.browser_download_url;
      }
    } else if (a.op === 'comment') {
      if (!a.body) continue;
      const body = a.body.replace(/\{assetUrl:([^}]+)\}/g, (m, t) => assetUrls[t] ?? m);
      const left = body.match(/\{assetUrl:[^}]+\}/g);
      if (left) throw new Error(`GitHub: no uploaded asset for ${left.join(', ')}`);
      if (a.reuseExisting && cur.comments.some((c) => c.body === body)) continue;
      await call('POST', `/repos/${repo}/issues/${n}/comments`, { body });
    }
    cur = await read();
  }
  return { issue: { ...cur.issue, identifier: item }, comments: cur.comments, assets: cur.assets, statuses, via: `github-${via}` };
}

export default {
  via: 'cli',
  apiKey: 'GITHUB_TOKEN',
  operations: { readIssue: 'the engine reads the issue', setStatus: 'the engine sets the status label', comment: 'the engine comments', attach: 'the engine uploads release assets', readBack: 'the engine reads the issue, its comments and the assets back' },
  isUpload: (a) => /\/releases\/download\//.test(String(a?.url ?? '')),
  cli: { perform: (ctx) => perform('cli', ctx), visibility: (ctx) => visibility('cli', ctx) },
  api: { url: 'https://api.github.com', perform: (ctx) => perform('api', ctx), visibility: (ctx) => visibility('api', ctx) },
  publicNotice: PUBLIC_NOTICE,
  publicFix: PUBLIC_FIX,
  normalize(raw) {
    const issue = raw?.issue ?? {};
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    const statuses = raw?.statuses ?? [];
    const prefix = `${issue.identifier}--`;
    return {
      id: issue.identifier ?? (issue.number !== undefined ? String(issue.number) : undefined),
      title: issue.title ?? '',
      description: typeof issue.body === 'string' ? issue.body : '',
      status: labels.find((l) => statuses.includes(l)) ?? (issue.state === 'closed' ? 'closed' : null),
      url: issue.html_url ?? null,
      updatedAt: issue.updated_at ?? null,
      comments: (raw?.comments ?? []).map((c) => ({ id: c.id, body: c.body ?? '', createdAt: c.created_at, updatedAt: c.updated_at ?? c.created_at })),
      attachments: (raw?.assets ?? []).map((a) => ({ id: a.id, title: String(a.name).startsWith(prefix) ? String(a.name).slice(prefix.length) : a.name, subtitle: a.label || null, filename: a.name, url: a.browser_download_url, size: a.size })),
    };
  },
};

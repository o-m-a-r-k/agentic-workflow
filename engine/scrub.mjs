// What must not leave the process in text wf records, posts or prints (0.4.2 review: credential exfiltration). Masks the
// given secret values (the project's catalogued ones: `secretValues`), credentials in query strings (signed-URL
// signatures, tokens, keys), Authorization and Bearer values, and tokens with a known prefix. Hashes (sha256 hex) are
// left alone: the evidence names files by them.
import fs from 'node:fs';
import path from 'node:path';
import { secretsCatalogFile } from './config.mjs';
import { loadCatalog, readSecret } from './secrets.mjs';
import { YAML } from './util.mjs';

const QUERY = /([?&](?:signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|token|access_token|api_key|apikey|key)=)(?!\[redacted\])[^&\s"'<>)\]]+/gi; // a masked value stays as it is
const AUTH = /((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer\s+|token\s+|basic\s+)?)[^"'\s,}]+/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/g;
const PREFIXED = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|lin_(?:api|oauth)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g;

// Idempotent: scrubbing scrubbed text changes nothing. `secrets`: values to mask wherever they appear (values shorter than 6 characters are left, so ordinary words survive).
export function scrub(text, { secrets = [] } = {}) {
  let s = String(text ?? '');
  for (const v of secrets.filter((x) => typeof x === 'string' && x.length >= 6).sort((a, b) => b.length - a.length)) s = s.split(v).join('[secret]');
  return s.replace(QUERY, '$1[redacted]').replace(AUTH, '$1[secret]').replace(BEARER, '$1 [secret]').replace(PREFIXED, '[secret]');
}

// The project's catalogued secret values, for `scrub`'s `secrets`. Never printed; [] when there is no catalogue or a
// value cannot be read.
export function secretValues(root, adapter) {
  try {
    // The catalogue beside the adapter (config.mjs secretsCatalogFile): the repo copy's `.workflow/`, or the user folder.
    const file = secretsCatalogFile(adapter, root);
    const raw = fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) : null;
    const top = raw && !Array.isArray(raw) ? raw : {};
    // The store as `wf secrets` reads it (engine/onboard.mjs): the catalogue's own `store` and `file`.
    const cfg = { name: adapter?.name ?? path.basename(root), catalogFile: file, repos: adapter?.repos ?? [{ name: path.basename(root), path: '.' }], secrets: adapter?.secrets ?? { store: top.store ?? 'env-file', ...(top.file ? { file: top.file } : {}) } };
    return loadCatalog(root, cfg).map((e) => {
      try {
        return readSecret(root, cfg, e);
      } catch {
        return null;
      }
    }).filter((v) => typeof v === 'string' && v);
  } catch {
    return [];
  }
}

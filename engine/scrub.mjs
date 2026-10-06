// What must not leave the process in text wf prints, records or exports (0.4.2 review: credential exfiltration).
// Masks: the given secret values, signed-URL signatures and credentials in query strings, Authorization/Bearer
// values, and tokens with a known prefix (GitHub, Linear, OpenAI-style, Slack). Hashes (sha256 hex) are left alone:
// the evidence names files by them.
const QUERY = /([?&](?:signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|token|access_token|api_key|apikey|key)=)[^&\s"'<>)\]]+/gi;
const AUTH = /((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer\s+|token\s+|basic\s+)?)[^"'\s,}]+/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/g;
const PREFIXED = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|lin_(?:api|oauth)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g;

export function scrub(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of secrets.filter((x) => typeof x === 'string' && x.length >= 6).sort((a, b) => b.length - a.length)) s = s.split(v).join('[secret]');
  return s.replace(QUERY, '$1[redacted]').replace(AUTH, '$1[secret]').replace(BEARER, '$1 [secret]').replace(PREFIXED, '[secret]');
}

// The environment a tracker CLI child (`gh`) gets: what it needs to find itself, its own login and the network, never
// the rest of the owner's environment (other services' keys). The owner's own GH_TOKEN, if they authenticate gh that
// way, is gh's login and is passed to gh only.
const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN', 'GH_PROMPT_DISABLED', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
export function cliEnv(env = process.env) {
  const out = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  for (const [k, v] of Object.entries(env)) if (PASS.includes(k) || /^LC_/.test(k) || /^WF_TEST_/.test(k)) out[k] = v;
  return out;
}

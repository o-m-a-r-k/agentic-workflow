// The environment a project command (gate step, provisioning, doctor check, secret verify) runs with.
// Steps used to receive the owner's whole environment, session tokens included. They now get an open list of
// toolchain variables, the adapter's `gate.env.pass`, the engine's WF_* variables and the catalogued secrets a
// step lists. Agent-runtime variables are never passed unless the adapter names them itself.

// Exact names, or prefixes ending in `*`. Open list: a project adds what it needs with `gate.env.pass`.
export const BASE_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_*', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'TMPDIR', 'TEMP', 'TMP', 'TZ', 'CI', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_*', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'COMPOSE_*', 'TESTCONTAINERS_*',
  'NODE_OPTIONS', 'npm_config_*', 'NPM_CONFIG_*', 'NVM_*', 'COREPACK_*', 'PNPM_HOME', 'YARN_*', 'BUN_INSTALL', 'VOLTA_HOME',
  'JAVA_HOME', 'GRADLE_USER_HOME', 'MAVEN_OPTS', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DEVELOPER_DIR',
  'VIRTUAL_ENV', 'PYENV_*', 'CONDA_*', 'PIP_*', 'UV_*', 'POETRY_*',
  'GOPATH', 'GOROOT', 'GOCACHE', 'GOMODCACHE', 'GOFLAGS', 'CARGO_HOME', 'RUSTUP_HOME',
  'GEM_HOME', 'GEM_PATH', 'BUNDLE_*', 'RBENV_*', 'ASDF_*', 'MISE_*', 'SDKMAN_*', 'HOMEBREW_*', 'COMPOSER_HOME',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'PLAYWRIGHT_BROWSERS_PATH',
  'WF_*',
];

// Agent-runtime credentials and session ids. Passed only when the adapter lists the name or a prefix starting with
// one of these, so a broad entry such as `C*` never leaks them.
export const NEVER_UNLESS_LISTED = ['CLAUDE_CODE_', 'CLAUDECODE', 'ANTHROPIC_', 'CODEX_', 'OPENAI_', 'GROK_', 'XAI_'];

const matches = (name, entry) => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry);

export function passList(cfg) {
  const pass = cfg?.gate?.env?.pass ?? [];
  return Array.isArray(pass) ? pass.map(String) : [];
}

// `extra` (engine variables, secrets) is added after filtering, so it always reaches the command.
export function projectEnv(cfg, extra = {}, source = process.env) {
  const pass = passList(cfg);
  const out = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const guarded = NEVER_UNLESS_LISTED.find((p) => name.startsWith(p));
    const listed = pass.filter((e) => matches(name, e));
    if (guarded) {
      // Only an entry that itself names the guarded family counts as explicit.
      if (listed.some((e) => e.replace(/\*$/, '').startsWith(guarded) || e === name)) out[name] = value;
      continue;
    }
    if (listed.length || BASE_ENV.some((e) => matches(name, e))) out[name] = value;
  }
  return { ...out, ...extra };
}

// A file's kinds, from its path alone (a file can be of several kinds): what a lesson may declare it applies to (`kinds: [ui,
// test]`, engine/lessons.mjs), and what the course reads as a migration, a critical boundary (engine/signals.mjs `reachSignal`).
// A leaf module, so both read one definition.
export const FILE_KINDS = ['ui', 'test', 'migration', 'docs', 'script', 'config', 'source'];
export function kindsOf(file) {
  const f = String(file).toLowerCase();
  const base = f.split('/').at(-1);
  const out = new Set();
  if (/\.(test|spec|e2e)\.[a-z0-9]+$/.test(f) || /(^|\/)(__tests__|tests?|e2e|specs?|fixtures?)\//.test(f)) out.add('test');
  // Review of 0.7.31 (L7): a documentation file under a migrations folder is documentation, not a migration.
  // Second review of 0.7.31: nor is the folder's index, a barrel that lists the migrations (`migrations/index.ts`).
  if ((/(^|\/)migrations?\//.test(f) || /\.migration\.[a-z0-9]+$/.test(f)) && !/\.(md|mdx|rst|adoc|txt)$/.test(f) && !/^index\.[a-z]+$/.test(base)) out.add('migration');
  if (/\.(md|mdx|rst|adoc|txt)$/.test(f) || /(^|\/)docs?\//.test(f)) out.add('docs');
  if (/\.(sh|bash|zsh|ps1)$/.test(f) || /(^|\/)(scripts?|bin)\//.test(f)) out.add('script');
  if (/^(dockerfile.*|.*\.dockerfile|(docker-)?compose[^/]*\.ya?ml|package\.json|tsconfig[^/]*\.json|\.env.*|makefile)$/.test(base) || /\.(ya?ml|toml|ini|conf)$/.test(f)) out.add('config');
  if (/\.(tsx|jsx|vue|svelte|css|scss|sass|less|html?)$/.test(f) || /(^|\/)(components?|pages|views|app|styles?)\//.test(f) && /\.(tsx|jsx|ts|js)$/.test(f)) out.add('ui');
  if (/\.(ts|js|mjs|cjs|py|go|rb|java|kt|rs|cs|php|swift|scala|ex|exs)$/.test(f) && !out.has('test') && !out.has('migration')) out.add('source');
  return out;
}

// The layout of a lesson file (docs/LESSONS.md, "The file").
//
// Named failure (I-49, 0.7.0 and 0.7.4): a generated lesson failed the repository's own `prettier --check`. 0.7.0 read
// `singleQuote` from the static config, but the YAML library still folded text at 80 columns and indented by two spaces
// with `\n` endings, while Prettier keeps a one-line scalar on one line whatever its width, indents by `tabWidth`, ends lines
// as `endOfLine` says, and wraps prose to `printWidth` only under `proseWrap: always`. Measured with real lesson texts:
// 29 of 70 generated lessons failed with `{"singleQuote": true}` or no config, all 70 with `tabWidth: 4`, `endOfLine: crlf`
// or `proseWrap: always`; `recur`, `set` and `move` re-serialise the whole file, so they brought each failure back after a
// manual `prettier --write`. Now every option Prettier's YAML printer reads is honoured or made irrelevant:
//   singleQuote  the library's quote choice (fewest escapes, the preferred quote on a tie, as Prettier chooses);
//   tabWidth     the indentation, also of sequences and block scalars;
//   endOfLine    lf, crlf, cr, or auto (the line ending the file already has); a lone CR is read back as a line break;
//   printWidth   irrelevant: text is never folded, and Prettier keeps a one-line scalar on one line;
//   proseWrap    never and preserve need nothing; `always` wraps text that does not fit within printWidth, which no layout
//                of ours could do the way Prettier does, so a text that would not fit is written as a literal block (`|-`),
//                the one scalar style Prettier never reflows (its parsed value is the same).
//
// The configuration is found as Prettier finds it (Prettier 3's resolution; checked against Prettier 3.9 during development, and by the opt-in scenario that runs `prettier --check` when WF_TEST_PRETTIER or a `prettier` on PATH is present): from the lesson's folder up, the
// first folder with one of the config files wins, the files tried in Prettier's order (package.json with a `prettier` key
// first, then .prettierrc, .prettierrc.json, .prettierrc.yml, .prettierrc.yaml, the JavaScript and TypeScript forms, TOML
// last), no merging across folders; `overrides` are applied to the lesson file's path. The search stops at the repository's
// root; a config reached through a link is read, as Prettier reads it. The forms that need code to run (JavaScript, TypeScript,
// TOML, JSON5), a shared-config name in package.json and an
// `.editorconfig` are never executed or read: a new lesson is then written in Prettier's defaults (LF, two spaces, double
// quotes where one is needed), and a lesson file that already exists keeps its own line endings, indentation and quote
// style when it is rewritten (`recur`, `set`, `move`), so a manual `prettier --write` sticks. The same holds where there is no
// configuration at all.
import fs from 'node:fs';
import path from 'node:path';
import { YAML, matchesAny } from './util.mjs';

// Prettier 3's search order inside one folder, as `prettier --find-config-path` answers it. The first file that exists wins
// (a package.json counts only with a `prettier` key); a form this module cannot read ends the search as unreadable rather than
// falling through to a lower one Prettier would never reach.
const CONFIG_FILES = ['package.json', 'package.yaml', '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.json5', '.prettierrc.js', 'prettier.config.js', '.prettierrc.ts', 'prettier.config.ts', '.prettierrc.mjs', 'prettier.config.mjs', '.prettierrc.mts', 'prettier.config.mts', '.prettierrc.cjs', 'prettier.config.cjs', '.prettierrc.cts', 'prettier.config.cts', '.prettierrc.toml'];
const READABLE = new Set(['package.json', 'package.yaml', '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml']);
const END_OF_LINE = ['lf', 'crlf', 'cr', 'auto'];
const PROSE_WRAP = ['always', 'never', 'preserve'];

// The options this module honours, from a config object or an override's options; anything else (or a value Prettier would
// refuse) is ignored.
function pickOptions(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  if (typeof o.singleQuote === 'boolean') out.singleQuote = o.singleQuote;
  if (Number.isInteger(o.tabWidth) && o.tabWidth > 0) out.tabWidth = o.tabWidth;
  if (Number.isInteger(o.printWidth) && o.printWidth > 0) out.printWidth = o.printWidth;
  if (END_OF_LINE.includes(o.endOfLine)) out.endOfLine = o.endOfLine;
  if (PROSE_WRAP.includes(o.proseWrap)) out.proseWrap = o.proseWrap;
  return out;
}

// Prettier matches an override's globs with micromatch (`basename`, `dot`): a pattern with no slash is matched against the
// file's name, any other against its path relative to the config's folder (a leading `./` is not part of it).
const matchesGlobs = (globs, relative) => globs.some((g) => {
  const pattern = g.replace(/^\.\//, '');
  return pattern.includes('/') ? matchesAny(relative, [pattern]) : matchesAny(path.posix.basename(relative), [pattern]);
});

// What a config object says about one file: its own options, then each matching override's, in order.
function optionsFor(config, configDir, file) {
  const relative = path.relative(configDir, file).split(path.sep).join('/');
  const out = pickOptions(config);
  for (const o of Array.isArray(config.overrides) ? config.overrides : []) {
    const files = [o?.files].flat().filter((x) => typeof x === 'string');
    const excluded = [o?.excludeFiles].flat().filter((x) => typeof x === 'string');
    if (files.length && matchesGlobs(files, relative) && !matchesGlobs(excluded, relative)) Object.assign(out, pickOptions(o.options));
  }
  return out;
}

// A config file's text, read the way Prettier reads it: through a link, as long as it ends at a regular file of a sane size.
const exists = (file) => Boolean(fs.statSync(file, { throwIfNoEntry: false }));
function textOf(file) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st?.isFile() && st.size <= 1024 * 1024 ? fs.readFileSync(file, 'utf8') : null;
}

// Prettier looks for a `prettier` key in package.json and package.yaml and skips the file when it is missing, empty, or the file
// cannot be read (checked on 3.9: a null, empty or false key and an invalid package.json all fall through to .prettierrc); a
// name there is a shared config this module does not resolve.
function packageField(text, parse) {
  try {
    const field = (parse(text) ?? {}).prettier;
    if (!field) return { skip: true };
    return typeof field === 'object' ? { config: field } : { unreadable: true };
  } catch {
    return { skip: true };
  }
}

function readConfig(dir, name) {
  const text = textOf(path.join(dir, name));
  if (text === null) return { unreadable: true };
  if (name === 'package.json') return packageField(text, JSON.parse);
  if (name === 'package.yaml') return packageField(text, YAML.parse);
  try {
    const parsed = YAML.parse(text) ?? {};
    return typeof parsed === 'object' && !Array.isArray(parsed) ? { config: parsed } : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

// { options, from, unreadable, editorconfig } for a lesson file inside `repoRoot`.
//   options      the honoured options (possibly none) of the config Prettier would use;
//   from         that config's path relative to the repository, or null when no config was found;
//   unreadable   the config file Prettier would use but this module does not read (relative path), or null;
//   editorconfig whether an .editorconfig lies between the file and the repository's root (Prettier merges it under the
//                config; it is not read here).
export function prettierConfig(repoRoot, file) {
  const result = { options: {}, from: null, unreadable: null, editorconfig: false };
  const root = path.resolve(repoRoot);
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    const here = path.relative(root, dir) || '.';
    if (exists(path.join(dir, '.editorconfig'))) result.editorconfig = true;
    if (!result.from && !result.unreadable) {
      for (const name of CONFIG_FILES) {
        if (!exists(path.join(dir, name))) continue;
        const read = READABLE.has(name) ? readConfig(dir, name) : { unreadable: true };
        if (read.skip) continue;
        if (read.unreadable) result.unreadable = path.join(here, name);
        else {
          result.from = path.join(here, name);
          result.options = optionsFor(read.config, dir, path.resolve(file));
        }
        break;
      }
    }
    if (dir === root || path.dirname(dir) === dir || path.relative(root, dir).startsWith('..')) break;
  }
  return result;
}

// What a lesson file already says about its own layout (used only for the options this module could not read).
export function layoutOf(text) {
  const out = {};
  const eol = /\r\n|\r|\n/.exec(text)?.[0];
  if (eol) out.endOfLine = eol === '\r\n' ? 'crlf' : eol === '\r' ? 'cr' : 'lf';
  const indent = /^( +)\S/m.exec(text)?.[1].length;
  if (indent) out.tabWidth = indent;
  try {
    const quotes = new Set();
    YAML.visit(YAML.parseDocument(text.replace(/\r\n?/g, '\n')), { Scalar(_key, node) { if (typeof node.value === 'string' && !/['"]/.test(node.value)) quotes.add(node.type); } });
    if (quotes.has('QUOTE_SINGLE')) out.singleQuote = true;
    else if (quotes.has('QUOTE_DOUBLE')) out.singleQuote = false;
  } catch {}
  return out;
}

// The style one lesson file is written in: the configuration's options, Prettier's defaults for the rest, and, where there is
// no configuration or one this module cannot read in full, the file's own layout (when it exists) before the defaults.
export function lessonStyle(repoRoot, file, existingText = null) {
  const found = prettierConfig(repoRoot, file);
  const own = existingText ? layoutOf(existingText) : {};
  // No configuration at all, or one that is not read in full: nothing says what the file must look like, so the file stays as it is.
  const inherit = !found.from || Boolean(found.unreadable) || found.editorconfig;
  const fill = (key, dflt) => found.options[key] ?? (inherit ? own[key] : undefined) ?? dflt;
  let endOfLine = fill('endOfLine', 'lf');
  if (endOfLine === 'auto') endOfLine = own.endOfLine ?? 'lf';
  return {
    singleQuote: fill('singleQuote', false), tabWidth: fill('tabWidth', 2), printWidth: found.options.printWidth ?? 80,
    endOfLine, proseWrap: found.options.proseWrap ?? 'preserve', source: found.from, unreadable: found.unreadable, editorconfig: found.editorconfig,
  };
}

// Prettier's width of a text: wide characters count two. Counting every character above U+1100 as two can only overestimate;
// a string is measured as JSON writes it (quotes, escapes), which is never shorter than any layout the library gives it.
const widthOf = (text) => { let w = 0; for (const ch of String(text)) w += ch.codePointAt(0) >= 0x1100 ? 2 : 1; return w; };

// A string of the document restyled for `style`:
//   - a literal block where `proseWrap: always` would otherwise reflow it;
//   - one double-quoted line, line breaks as `\n`, where a block scalar would not survive Prettier: it strips the white space
//     that ends a line of a block (and the indentation the library writes on a first blank line), and the library misplaces
//     the indentation indicator of a block that starts with white space when the indent is not two (the parsed text is checked
//     below, so a layout that changed a value is never written).
//   A text with white space at the edge of a line that `proseWrap: always` also wants wrapped keeps the library's layout: Prettier
//   wraps inside the quotes, which no layout of ours can match; `prettier --write` makes it so.
function styled(value, style, depth, keyWidth) {
  if (typeof value === 'string') {
    const inSequence = keyWidth === null;
    const multiline = value.includes('\n');
    const trailing = /[ \t]$/m.test(value);
    const leading = /^[ \t]/.test(value);
    const doubleQuoted = () => {
      const scalar = new YAML.Scalar(value);
      scalar.type = 'QUOTE_DOUBLE';
      return scalar;
    };
    if (multiline) return inSequence || trailing || value.startsWith('\n') || (leading && style.tabWidth !== 2) ? doubleQuoted() : value;
    if (style.proseWrap === 'always' && /\s/.test(value) && !trailing && !(leading && style.tabWidth !== 2) && depth * style.tabWidth + (inSequence ? 2 : keyWidth + 2) + widthOf(JSON.stringify(value)) > style.printWidth) {
      const scalar = new YAML.Scalar(value);
      scalar.type = 'BLOCK_LITERAL';
      return scalar;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((x) => styled(x, style, depth + 1, null));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, styled(x, style, depth + 1, widthOf(k))]));
  return value;
}

// Prettier writes a quoted string that holds both kinds of quote, and no other escape, in single quotes (the library prefers
// double quotes unless `singleQuote` is set, and then also for strings that have none), so the preference stays the
// project's and those strings alone change quotes.
const NO_ESCAPES = /^[^\\\x00-\x1f\x7f-\x9f\u2028\u2029\ufeff]*$/u;
function singleForBoth(text, options) {
  const doc = YAML.parseDocument(text);
  let changed = false;
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (node.type === 'QUOTE_DOUBLE' && typeof node.value === 'string' && node.value.includes("'") && node.value.includes('"') && NO_ESCAPES.test(node.value)) {
        node.type = 'QUOTE_SINGLE';
        changed = true;
      }
    },
  });
  return changed ? doc.toString(options) : text;
}

// The text of a lesson document in `style`. The parsed text is checked against the document: a layout that would change a
// value is never written (the library's default layout is, and the result says so in `fallback`).
export function formatLesson(doc, style) {
  const top = Object.fromEntries(Object.entries(doc).map(([k, x]) => [k, styled(x, style, 0, widthOf(k))]));
  // `doubleQuotedMinMultiLineLength`: the library would break a long double-quoted text at its `\n`s into lines that end in `\ `,
  // which Prettier strips back to `\`; the line breaks stay escapes on the one line.
  const options = { lineWidth: 0, indent: style.tabWidth, singleQuote: style.singleQuote === true ? true : undefined, doubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER };
  const ending = (text) => (style.endOfLine === 'crlf' ? text.replace(/\n/g, '\r\n') : style.endOfLine === 'cr' ? text.replace(/\n/g, '\r') : text);
  let text = YAML.stringify(top, options);
  let fallback = false;
  try {
    if (style.singleQuote !== true) text = singleForBoth(text, options);
    // The text as it will be written is read back (a lone CR is read as a line break, as parseLesson reads it).
    fallback = JSON.stringify(YAML.parse(ending(text).replace(/\r\n?/g, '\n'))) !== JSON.stringify(JSON.parse(JSON.stringify(doc)));
  } catch {
    fallback = true;
  }
  if (fallback) text = YAML.stringify(doc);
  return { text: ending(text), fallback };
}

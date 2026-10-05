import fs from 'node:fs';
import path from 'node:path';
import { adapterLocation, repoDir } from './config.mjs';
import { screenshots } from './gate.mjs';
import { attemptDir } from './ledger.mjs';
import { findSkill } from './skills.mjs';
import { YAML, git, matchesAny, sha256 } from './util.mjs';

// Review rules: project documents (design system, coding rules) a reviewer must read when the change touches the paths
// they govern. Named failure: in eleven review rounds no reviewer read any of the project's rule documents, and the
// required skill was only checked as installed. The list is a pure function of the adapter at the attempt's base and
// the changed files, the same for every reviewer, so it steers no one: it adds to the review and never narrows it.

// Claude-style rule files declare the paths they govern in frontmatter: `paths: [globs]` (a list, or one string).
export function frontmatterPaths(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  let fm;
  try {
    fm = YAML.parse(m[1]);
  } catch {
    return null;
  }
  const p = fm?.paths ?? fm?.globs;
  if (typeof p === 'string') return p.split(',').map((x) => x.trim()).filter(Boolean);
  return Array.isArray(p) ? p.map(String).filter(Boolean) : null;
}

// The repo a rule's documents live in (and whose changed files it governs when it names one), and the commit to read
// them at: the attempt's adapter base for the adapter repo, the repo's admission base otherwise.
function ruleRepo(root, cfg, rule) {
  if (rule.repo) return cfg.repos.find((r) => r.name === rule.repo) ?? null;
  return adapterLocation(root, cfg).repo;
}

export function docAt(root, repo, commit, doc) {
  if (!repo || !commit) return null;
  const text = git(repoDir(root, repo), ['show', `${commit}:${path.posix.normalize(doc)}`], { allowFail: true });
  return text || null;
}

const commitFor = (root, cfg, state, repo) => {
  if (!repo) return null;
  if (repo.name === adapterLocation(root, cfg).repo.name) return state.adapterBase;
  return state.repos[repo.name]?.base ?? null;
};

// Rules that apply to this change: each with the trusted copies of its documents (written from the base commit into
// the attempt's evidence), the changed files it matched, and whether the ticket itself changed one of its documents.
// A document absent at the base is listed under `missing` (doctor warns), never required.
export function reviewRules(root, trusted, state, changed) {
  const multi = Object.keys(changed).length > 1;
  const out = [];
  for (const rule of trusted.review?.rules ?? []) {
    const repo = ruleRepo(root, trusted, rule);
    const commit = commitFor(root, trusted, state, repo);
    const docs = rule.read.map((doc) => ({ doc, text: docAt(root, repo, commit, doc) }));
    const paths = rule.paths ?? frontmatterPaths(docs.find((d) => d.text)?.text) ?? null;
    const scope = rule.repo ? { [rule.repo]: changed[rule.repo] ?? [] } : changed;
    const matched = Object.entries(scope).flatMap(([r, files]) => files.filter((f) => !paths || matchesAny(f, paths)).map((f) => (multi ? `${r}/${f}` : f)));
    if (!matched.length) continue;
    const read = [];
    const worktreeCopies = {};
    for (const d of docs.filter((x) => x.text)) {
      const file = path.join(attemptDir(root, state.id), 'rules', `${sha256(d.text).slice(0, 12)}-${path.posix.basename(d.doc)}`);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, d.text);
      }
      read.push(file);
      // The worktree copy counts as read only when the ticket did not change it (then it is the same document).
      const wt = repo && state.repos[repo.name]?.worktree;
      if (wt && !(changed[repo.name] ?? []).includes(d.doc)) worktreeCopies[file] = path.join(wt, d.doc);
    }
    // Nothing readable at the base: the rule is skipped (doctor warns), never required.
    if (!read.length) continue;
    const docChangedByTicket = Boolean(repo && rule.read.some((doc) => (changed[repo.name] ?? []).includes(path.posix.normalize(doc))));
    out.push({ id: rule.id, read, docs: rule.read, matched, paths, docChangedByTicket, missing: docs.filter((x) => !x.text).map((x) => x.doc), worktreeCopies });
  }
  return out;
}

// Skills this role needs for this round: always without `when`; `visual` when the gate collected screenshots;
// `{ paths }` when a changed file (in any repo) matches, so a review before the gate needs it too.
export function requiredSkills(cfg, role, state, changed) {
  const files = Object.values(changed ?? {}).flat();
  const visual = screenshots(state).length > 0;
  return (cfg.requires.skills ?? []).filter((s) => (s.roles ?? []).includes(role)).filter((s) => {
    if (s.when === undefined || s.when === null) return true;
    if (s.when === 'visual') return visual;
    if (Array.isArray(s.when?.paths)) return files.some((f) => matchesAny(f, s.when.paths));
    return false;
  });
}

export function skillFiles(root, skills, runtime) {
  return skills.map((s) => ({ name: s.name, file: findSkill(root, s.name, runtime)?.path ?? null }));
}

// A rule verdict per applicable rule: `{ rule, verdict: complies|finding|not-applicable, evidence }`, with one line of
// evidence; a `finding` verdict names a finding of the same closure.
const VERDICTS = new Set(['complies', 'finding', 'not-applicable']);
export function ruleVerdicts(rules, closure) {
  const entries = Array.isArray(closure?.rules) ? closure.rules : [];
  const findings = new Set((closure?.findings ?? []).map((f) => f.id));
  const problems = [];
  const verdicts = [];
  for (const r of rules ?? []) {
    const e = entries.find((x) => x?.rule === r.id);
    if (!e) problems.push(`rule ${r.id}: no verdict (it governs ${r.matched.length} changed file(s): ${r.matched.slice(0, 5).join(', ')}${r.matched.length > 5 ? ' …' : ''})`);
    else if (!VERDICTS.has(e.verdict)) problems.push(`rule ${r.id}: verdict must be complies, finding or not-applicable, not \`${e.verdict}\``);
    else if (!String(e.evidence ?? '').trim()) problems.push(`rule ${r.id}: ${e.verdict} needs evidence (file:line or the document's section)`);
    else if (e.verdict === 'finding' && !findings.has(e.finding ?? e.evidence)) problems.push(`rule ${r.id}: a finding verdict names a finding id of this closure in \`finding\` (known: ${[...findings].join(', ') || 'none'})`);
    else verdicts.push({ rule: r.id, verdict: e.verdict, evidence: String(e.evidence), finding: e.verdict === 'finding' ? e.finding ?? e.evidence : null, docChangedByTicket: r.docChangedByTicket });
  }
  return { problems, verdicts };
}

// What the reviewer's transcript shows it read: a Read tool call of the file, or a Bash read (cat, sed, head, tail,
// grep, less, more, nl, awk, bat) naming it, whose result is not an error; a skill counts when a Skill tool call names
// it or its SKILL.md was read. Proves the content reached the reviewer, not that it was understood.
const BASH_READ = /(^|[\s;&|(])(cat|sed|head|tail|grep|egrep|rg|less|more|nl|awk|bat|wc)\b/;
export function transcriptReads(entries) {
  const calls = new Map();
  const failed = new Set();
  for (const e of entries) {
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const b of content) {
      if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input ?? {} });
      if (b.type === 'tool_result' && (b.is_error === true || e.toolUseResult?.is_error === true)) failed.add(b.tool_use_id);
    }
  }
  return [...calls.entries()].filter(([id]) => !failed.has(id)).map(([, c]) => c);
}

const readsFile = (calls, files) => calls.some((c) => (c.name === 'Read' && files.includes(path.resolve(String(c.input.file_path ?? '')))) || (c.name === 'Bash' && BASH_READ.test(String(c.input.command ?? '')) && files.some((f) => String(c.input.command).includes(f))));

export function unreadDocs(entries, rules, skills) {
  const calls = transcriptReads(entries);
  const missing = [];
  for (const r of rules ?? []) {
    for (const f of r.read) {
      const ok = [f, r.worktreeCopies?.[f]].filter(Boolean);
      if (!readsFile(calls, ok)) missing.push(`rule ${r.id}: ${f}`);
    }
  }
  for (const s of skills ?? []) {
    const byTool = calls.some((c) => c.name === 'Skill' && [s.name, String(s.name).split(':').at(-1)].includes(String(c.input.skill ?? c.input.name ?? '').split(':').at(-1)));
    if (!byTool && !(s.file && readsFile(calls, [s.file]))) missing.push(`skill ${s.name}${s.file ? ` (${s.file})` : ''}`);
  }
  return missing;
}

// Doctor: rule documents absent at the adapter base, and rules that govern every change (no paths, no frontmatter).
export function ruleWarnings(root, cfg, commit) {
  const out = [];
  for (const rule of cfg.review?.rules ?? []) {
    const repo = ruleRepo(root, cfg, rule);
    const at = repo && repo.name === adapterLocation(root, cfg).repo.name ? commit : repo ? git(repoDir(root, repo), ['rev-parse', repo.base], { allowFail: true }) : null;
    const docs = rule.read.map((doc) => ({ doc, text: docAt(root, repo, at, doc) }));
    const missing = docs.filter((d) => !d.text).map((d) => d.doc);
    if (missing.length) out.push({ check: `review rule ${rule.id}`, problem: `document(s) not committed on the base: ${missing.join(', ')}; a reviewer cannot be asked to read them, so they are skipped`, fix: 'commit the documents on the base branch, or fix the paths under `review.rules[].read`' });
    if (!rule.paths && !frontmatterPaths(docs.find((d) => d.text)?.text)) out.push({ check: `review rule ${rule.id}`, problem: 'no `paths` and no `paths:` frontmatter in its first document: it applies to every change', fix: 'add `paths: [globs]` to the rule or to the document\'s frontmatter, unless every change should be judged against it' });
  }
  return out;
}

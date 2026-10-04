import fs from 'node:fs';

const attrs = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return out;
};

// Groups test cases into suites by file, then classname, then the enclosing <testsuite> name.
export function parseJUnit(xml) {
  const suites = new Map();
  const suiteRe = /<testsuite\b([^>]*?)(\/>|>([\s\S]*?)<\/testsuite>)/g;
  for (const s of xml.matchAll(suiteRe)) {
    const sAttrs = attrs(s[1]);
    const body = s[3] ?? '';
    const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    let any = false;
    for (const c of body.matchAll(caseRe)) {
      any = true;
      const cAttrs = attrs(c[1]);
      const inner = c[3] ?? '';
      const id = cAttrs.file ?? sAttrs.file ?? cAttrs.classname ?? sAttrs.name ?? 'unnamed';
      const failed = /<(failure|error)\b/.test(inner);
      const skipped = /<skipped\b/.test(inner);
      const suite = suites.get(id) ?? { id, file: cAttrs.file ?? sAttrs.file ?? null, tests: 0, failures: 0, skipped: 0, durationMs: 0 };
      suite.tests += 1;
      if (failed) suite.failures += 1;
      if (skipped) suite.skipped += 1;
      suite.durationMs += Math.round(Number(cAttrs.time ?? 0) * 1000);
      suites.set(id, suite);
    }
    if (!any) {
      const id = sAttrs.file ?? sAttrs.name ?? 'unnamed';
      const failures = Number(sAttrs.failures ?? 0) + Number(sAttrs.errors ?? 0);
      suites.set(id, { id, file: sAttrs.file ?? null, tests: Number(sAttrs.tests ?? 0), failures, skipped: Number(sAttrs.skipped ?? 0), durationMs: Math.round(Number(sAttrs.time ?? 0) * 1000) });
    }
  }
  return [...suites.values()].map((s) => ({ ...s, status: s.failures > 0 ? 'failed' : 'passed' }));
}

export function readJUnitFiles(files) {
  const all = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    all.push(...parseJUnit(fs.readFileSync(f, 'utf8')));
  }
  const merged = new Map();
  for (const s of all) {
    const prev = merged.get(s.id);
    if (!prev) merged.set(s.id, s);
    else merged.set(s.id, { ...prev, tests: prev.tests + s.tests, failures: prev.failures + s.failures, skipped: prev.skipped + s.skipped, durationMs: prev.durationMs + s.durationMs, status: prev.failures + s.failures > 0 ? 'failed' : 'passed' });
  }
  return [...merged.values()];
}

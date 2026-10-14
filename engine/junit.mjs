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

// Playwright's JSON reporter as a suite list, one suite per spec file, so a Playwright step reruns only its failed spec
// files with `select` (0.7.6, I-118). Named failure: the suite list came from JUnit only, so a Playwright step that wrote
// its usual JSON report reran the whole suite (18 minutes) to prove each repair. A spec counts as failed when it ended
// not ok (a flaky spec that passed on retry ends ok); a spec whose every test was skipped counts as skipped; a suite with a
// test that did not run is `not-run`.
export function playwrightJsonSuites(doc) {
  const files = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file ?? null;
      if (!file) continue;
      const s = files.get(file) ?? { id: file, file, tests: 0, failures: 0, skipped: 0, durationMs: 0 };
      for (const t of spec.tests ?? []) {
        s.tests += 1;
        const results = t.results ?? [];
        s.durationMs += results.reduce((n, r) => n + (Number(r.duration) || 0), 0);
        if (t.status === 'skipped' || (results.length && results.every((r) => r.status === 'skipped'))) s.skipped += 1;
        // Skipped with no result is a test that did not run (the run stopped first: maxFailures, globalTimeout, a failed
        // dependency project); a skip the spec declares has a result. Independent review of 0.7.6 (high): such a suite was
        // passed, so it was carried, and a later gate went green without running it.
        if (t?.status === 'skipped' && !results.length) s.notRun = (s.notRun ?? 0) + 1;
      }
      // One failure per failing test, a test being a spec in one project (0.7.6: a spec failing in four projects is four).
      const unexpected = (spec.tests ?? []).filter((t) => t?.status === 'unexpected').length;
      s.failures += unexpected || (spec.ok === false ? 1 : 0);
      files.set(file, s);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const s of Array.isArray(doc?.suites) ? doc.suites : []) if (s && typeof s === 'object') walk(s);
  // A spec file that failed to load is reported only in the top-level `errors`: it is a failed suite, so a rerun of the
  // failed suites runs it again (0.7.6 review: it could otherwise pass without it).
  for (const e of Array.isArray(doc?.errors) ? doc.errors : []) {
    const file = e?.location?.file;
    if (typeof file !== 'string' || !file) continue;
    const s = files.get(file) ?? { id: file, file, tests: 0, failures: 0, skipped: 0, durationMs: 0 };
    s.failures += 1;
    files.set(file, s);
  }
  // A suite with a test that did not run is not passed (`not-run`), so it is rerun, never carried.
  return [...files.values()].map((s) => ({ ...s, status: s.failures > 0 ? 'failed' : s.notRun ? 'not-run' : 'passed' }));
}

export function readPlaywrightSuites(files) {
  const all = new Map();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    for (const s of playwrightJsonSuites(doc)) {
      const prev = all.get(s.id);
      all.set(s.id, prev ? { ...prev, tests: prev.tests + s.tests, failures: prev.failures + s.failures, skipped: prev.skipped + s.skipped, durationMs: prev.durationMs + s.durationMs, status: prev.failures + s.failures > 0 ? 'failed' : 'passed' } : s);
    }
  }
  return [...all.values()];
}

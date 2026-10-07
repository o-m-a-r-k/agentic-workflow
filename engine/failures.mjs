import fs from 'node:fs';

// Failing test names for a failed gate step, recorded on the step so the ledger says which tests failed, not only
// "exit code 1". Sources, first match wins: JUnit reports the step declares, a Playwright JSON report it declares
// (`report.playwright`), then the step's own output (Jest, the Playwright list/line reporters, node:test spec and
// TAP). When none names a test, the exit codes and the last lines of output are kept instead. Measurement only.
export const MAX_NAMES = 50;
const TAIL_LINES = 20;

const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? unxml(m[1]) : null;
};

export function junitFailures(xml) {
  const out = [];
  for (const c of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (!/<(failure|error)\b/.test(c[3] ?? '')) continue;
    const name = attr(c[1], 'name') ?? 'unnamed';
    const where = attr(c[1], 'file') ?? attr(c[1], 'classname');
    out.push(where && where !== name ? `${where} › ${name}` : name);
  }
  return out;
}

// Playwright's JSON reporter: nested suites of specs; a spec with `ok: false` failed (flaky specs end ok).
export function playwrightJsonFailures(doc) {
  const out = [];
  const walk = (suite, titles) => {
    const here = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      if (spec.ok !== false) continue;
      const file = spec.file ?? suite.file ?? null;
      out.push([file ? `${file}${spec.line ? `:${spec.line}` : ''}` : null, ...here, spec.title].filter(Boolean).join(' › '));
    }
    for (const s of suite.suites ?? []) walk(s, here);
  };
  for (const s of doc?.suites ?? []) walk({ ...s, title: null }, []);
  return out;
}

const strip = (l) => l.replace(/\x1b\[[0-9;]*m/g, '');

// Names from console output. Each runner's failure line is distinctive enough to read without its config.
export function logFailures(text) {
  const lines = text.split('\n').map(strip);
  const found = { jest: [], playwright: [], 'node-test': [] };
  for (const raw of lines) {
    const l = raw.trimEnd();
    // Jest: "  ● Suite › test" (the "Test suite failed to run" header names no test; its FAIL line names the file).
    let m = /^\s*● (.+)$/.exec(l);
    if (m && !/^Test suite failed to run/.test(m[1]) && !/^Console$/.test(m[1])) found.jest.push(m[1].trim());
    m = /^\s*FAIL\s+(\S+)/.exec(l);
    if (m) found.jest.push(`FAIL ${m[1]}`);
    // Playwright list and line reporters: "  1) [chromium] › tests/a.spec.ts:3:5 › suite › title ───".
    m = /^\s*\d+\) (?:\[[^\]]+\] › )?(\S+:\d+:\d+ › .+?)(?:\s+[─-]{3,}.*)?$/.exec(l);
    if (m) found.playwright.push(m[1].trim());
    // node:test TAP ("not ok 3 - name") and spec ("✖ name (1.2ms)", not the "failing tests:" heading).
    m = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(l);
    if (m) found['node-test'].push(m[1].trim());
    m = /^\s*✖ (.+?) \(\d[\d.]*m?s\)$/.exec(l);
    if (m) found['node-test'].push(m[1].trim());
  }
  // A Jest run prints FAIL lines for files with failures; keep them only when no test line names the failure.
  const jestTests = found.jest.filter((x) => !x.startsWith('FAIL '));
  if (jestTests.length) found.jest = jestTests;
  for (const [source, names] of Object.entries(found)) if (names.length) return { source, names: [...new Set(names)] };
  return null;
}

export function tailLines(text, n = TAIL_LINES) {
  return text.split('\n').map(strip).filter((l) => l.trim()).slice(-n);
}

// { source, tests: [...], total, exitCodes, tail? }. `redact` masks catalogued secrets in anything kept from output.
export function stepFailures({ junitFiles = [], playwrightFiles = [], log = null, exitCodes = [], suites = [], redact = (x) => x } = {}) {
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };
  const keep = (source, names) => ({ source, tests: names.slice(0, MAX_NAMES).map((x) => redact(x)), total: names.length, exitCodes });
  const junit = junitFiles.flatMap((f) => junitFailures(read(f) ?? ''));
  if (junit.length) return keep('junit', [...new Set(junit)]);
  const pw = playwrightFiles.flatMap((f) => {
    try {
      return playwrightJsonFailures(JSON.parse(read(f) ?? 'null'));
    } catch {
      return [];
    }
  });
  if (pw.length) return keep('playwright-json', [...new Set(pw)]);
  const text = log ? read(log) ?? '' : '';
  const fromLog = text ? logFailures(text) : null;
  if (fromLog) return keep(fromLog.source, fromLog.names);
  const failedSuites = suites.filter((s) => s.status === 'failed').map((s) => s.file ?? s.id);
  if (failedSuites.length) return keep('suites', failedSuites);
  return { source: 'exit-code', tests: [], total: 0, exitCodes, tail: tailLines(text).map((x) => redact(x)) };
}

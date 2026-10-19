// Stream 0: the seam contract. Every cross-stream facade exists, names its owner, and throws NotBuiltError until the owning
// stream exports `implements08`; doubles replace facades; budget.json parses and agrees with the contract's catalogues.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contract from '../engine/contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The design's table (section 12), plus the additions stream 0 made and reported.
const OWNERS = {
  1: ['start', 'setCriteria', 'bundle', 'recordReview', 'noProgress', 'mergeFacts', 'changedFiles'],
  2: ['runTests', 'capture', 'land'],
  3: ['normaliseId', 'search', 'fileFollowUp', 'runStage'],
  4: ['ask', 'answered', 'digest', 'launchReviewer', 'filesRead', 'callerSession', 'sessionActivity', 'connectorCalls'],
  5: ['append', 'readEvents', 'attemptState', 'listAttempts', 'row', 'blameToAttempt', 'recordRefusal', 'propose', 'judge'],
  6: ['findProject', 'loadAdapter', 'checkAdapter', 'adapterBudget'],
  7: ['scan', 'proposePolicy', 'writeAdapter'],
};

test('every cross-stream function is a facade with the right owner', async () => {
  const listed = Object.entries(contract.SIGNATURES).filter(([, s]) => !s.signature.startsWith('(ctx'));
  assert.deepEqual(new Set(listed.map(([n]) => n)), new Set(Object.values(OWNERS).flat()));
  for (const [stream, names] of Object.entries(OWNERS)) {
    for (const name of names) {
      assert.equal(typeof contract[name], 'function', `${name} is exported`);
      assert.equal(contract.SIGNATURES[name].stream, Number(stream), `${name} belongs to stream ${stream}`);
    }
  }
});

test('an unbuilt facade throws NotBuiltError naming its stream and module, and never loads a 0.7 module of the same name', async () => {
  for (const [name, sig] of Object.entries(contract.SIGNATURES)) {
    await assert.rejects(contract[name] ? contract[name]() : contract.commandHandler(Object.keys(contract.COMMANDS).find((c) => contract.COMMANDS[c].handler === name))({}, { _: [], flags: {} }), (e) => {
      assert.ok(e instanceof contract.NotBuiltError, `${name}: ${e}`);
      assert.equal(e.stream, sig.stream);
      assert.equal(e.module, sig.module);
      assert.match(e.message, new RegExp(`stream ${sig.stream} \\(`));
      return true;
    });
  }
});

test('every command has a handler facade owned by one stream; aliases resolve; an unknown command is a usage error', async () => {
  assert.equal(Object.keys(contract.COMMANDS).length, 23);
  for (const [name, c] of Object.entries(contract.COMMANDS)) {
    assert.ok(c.stream >= 1 && c.stream <= 7, name);
    assert.equal(contract.SIGNATURES[c.handler].stream, c.stream, name);
    assert.equal(typeof contract.commandHandler(name), 'function');
  }
  assert.equal(contract.commandHandler('onboard'), contract.commandHandler('init'));
  assert.throws(() => contract.commandHandler('batch'), (e) => e instanceof contract.WfError && e.code === 1);
});

test('doubles replace a facade in-process and are cleared', async () => {
  contract.setDoubles({ runTests: async (root, attempt, repo, kind) => ({ pass: true, tree: 't', ms: 1, exitCode: 0, log: `${repo}:${kind}` }) });
  assert.deepEqual(await contract.runTests('/r', 'TK-1.1', 'server', 'fast'), { pass: true, tree: 't', ms: 1, exitCode: 0, log: 'server:fast' });
  contract.clearDoubles();
  await assert.rejects(contract.runTests('/r', 'TK-1.1', 'server', 'fast'), contract.NotBuiltError);
  assert.throws(() => contract.setDoubles({ notAFacade: () => {} }), /no facade named/);
});

test('refusal() takes only the 19 ids and makes an exit-75 WfError carrying the id', () => {
  assert.equal(Object.keys(contract.REFUSALS).length, 19);
  const e = contract.refusal('merge:open', 'F3 is open', 'fix it');
  assert.ok(e instanceof contract.WfError);
  assert.equal(e.code, 75);
  assert.equal(e.refusalId, 'merge:open');
  assert.equal(e.hint, 'fix it');
  assert.throws(() => contract.refusal('gate:stale', 'x'), /unknown refusal id/);
});

test('budget.json parses and agrees with the contract catalogues', () => {
  const budget = JSON.parse(fs.readFileSync(path.join(ROOT, 'budget.json'), 'utf8'));
  assert.equal(budget.version, contract.CONTRACT_VERSION);
  assert.deepEqual([...budget.refusals].sort(), Object.keys(contract.REFUSALS).sort());
  assert.deepEqual([...budget.commands].sort(), Object.keys(contract.COMMANDS).sort());
  assert.deepEqual([...budget.events].sort(), Object.keys(contract.EVENTS).sort());
  assert.equal(budget.events.length, 15);
  assert.ok(Array.isArray(budget.adapterKeys) && budget.adapterKeys.length > 0);
  for (const k of contract.POLICY_KEYS) assert.ok(budget.adapterKeys.some((a) => a === k || a.startsWith(`${k}.`) || a === `repos.${k}`), `policy key ${k} is an adapter key`);
  assert.ok(Number.isInteger(budget.words.total) && budget.words.roleMax === 150);
});

test('event catalogue: every event names an owning stream and its required fields', () => {
  for (const [type, e] of Object.entries(contract.EVENTS)) {
    assert.ok(e.stream >= 1 && e.stream <= 7, type);
    assert.ok(Array.isArray(e.required) && e.required.length > 0, type);
    assert.ok(Array.isArray(e.optional), type);
  }
  for (const [kind, d] of Object.entries(contract.DECISION_KINDS)) assert.ok([1, 3].includes(d.asker), kind);
});

test('places and value helpers', () => {
  assert.equal(contract.attemptId('TK-7', 2), 'TK-7.2');
  assert.equal(contract.branchName('TK-7.2'), 'wf/TK-7.2');
  assert.deepEqual(contract.parseLocation('server/src/a/b.mjs:12'), { repo: 'server', path: 'src/a/b.mjs', line: 12 });
  assert.equal(contract.parseLocation('nope'), null);
  assert.equal(contract.marker('TK-7.2', 'stage:1'), 'wf:TK-7.2:stage:1');
  assert.equal(contract.canonicalJson({ b: 1, a: [undefined, { d: 2, c: 3 }] }), '{"a":[null,{"c":3,"d":2}],"b":1}');
  assert.equal(contract.userDir({ WF_USER_DIR: '/x' }), '/x');
  assert.equal(contract.hostHome({ WF_HOST_HOME: '/h' }), '/h');
  assert.equal(contract.ledgerFile('/r', 'TK-1.1'), path.join('/r', '.wf-evidence', 'attempts', 'TK-1.1', 'ledger.jsonl'));
});

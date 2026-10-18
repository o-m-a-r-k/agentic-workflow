import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf, write, yaml } from './helpers.mjs';

function fixture(name, files = {}, unit = { id: 'unit', repo: 'app', run: 'test -f src/a.txt', inputs: ['src/**'] }, criteria = undefined) {
  const config = { gate: { steps: [unit] } };
  const f = singleRepoProject(name, config, files);
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'planner', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base, criteria), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(f.root, ['handoff', 'close', '--agent', 'impl', '--attempt', e.id]));
  const cfg = yaml({ version: 1, enabled: true, name, repos: [{ name: 'app', path: '.', base: 'main' }], ...config });
  return { ...f, e, wt: e.repos.app.worktree, cfg };
}

const add = (f, steps = 'http', extra = []) => wf(f.root, ['validation', 'add', '--steps', steps, '--criteria', 'C1', '--reason', 'Required real execution', '--attempt', f.e.id, '--json', ...extra]);
function review(f, agent, extra = {}) {
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', f.e.id]));
  const validationChecked = state(f.root, f.e.id).validations.flatMap(v=>v.steps.map(s=>({id:s.id,commit:v.commit,verdict:'complies',evidence:'Pinned definition and plugin inspected'})));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure(agent, { validationChecked, ...extra })), '--attempt', f.e.id]));
}
function candidate(f, step, files = {}) {
  const parsed = JSON.parse(JSON.stringify({ version: 1, enabled: true, name: 'fixture', repos: [{ name: 'app', path: '.', base: 'main' }], gate: { steps: [step] } }));
  commitIn(f.wt, { '.workflow/project.yaml': yaml(parsed), ...files });
}

test('add committed HTTP and browser proof without replacing frozen checks; require fresh reviews and screenshots', () => {
  const f = fixture('supplemental-proof');
  review(f, 'code-old');
  ok(wf(f.root, ['gate', '--attempt', f.e.id]));
  const original = state(f.root, f.e.id).adapterBase;
  const plugin = `import fs from 'node:fs';export default {async run(ctx){fs.mkdirSync(ctx.dir+'/captures',{recursive:true});fs.writeFileSync(ctx.dir+'/captures/'+ctx.attempt+'.png','image');fs.writeFileSync(ctx.evidenceDir+'/junit.xml','<testsuite><testcase name="http"/></testsuite>');return {status:'passed',suites:[{id:'http',status:'passed'}]};}};`;
  candidate(f, { id: 'http', repo: 'app', plugin: 'steps/proof.mjs', inputs: ['src/**'], tier: 'heavy', artifacts: ['captures/{attempt}.png'] }, { '.workflow/steps/proof.mjs': plugin });
  ok(add(f));
  assert.equal(state(f.root, f.e.id).adapterBase, original);
  const refused = wf(f.root, ['gate', '--attempt', f.e.id]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /fresh code review/);
  review(f, 'code-new');
  const run = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.deepEqual(run.steps.map((s) => s.id).sort(), ['http', 'unit']);
  const http = run.steps.find((s) => s.id === 'http');
  assert.equal(http.status, 'passed');
  assert.equal(http.artifacts[0].kind, 'screenshot');
  const hand = ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'evidence', '--attempt', f.e.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(hand.bundle ?? hand.file, 'utf8'));
  assert.equal(bundle.supplementalValidation.length, 1);
  assert.equal(bundle.gate.screenshots.length, 1);
  const missing = goodClosure('evidence', { validationChecked: [{id:'http',commit:state(f.root,f.e.id).validations[0].commit,verdict:'complies',evidence:'Pinned HTTP and browser runner inspected'}] });
  // Every new screenshot is still governed by the ordinary review/acceptance rules.
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, missing), '--attempt', f.e.id]));
  const accept = wf(f.root, ['accept', '--attempt', f.e.id]);
  assert.notEqual(accept.code, 0);
  assert.match(accept.err, /screenshot|inspected/);
});

test('reject replacing admission steps, invalid criteria, dirty or missing committed definitions', () => {
  const f = fixture('supplemental-refusals');
  candidate(f, { id: 'unit', repo: 'app', run: 'true' });
  assert.match(add(f, 'unit').err, /cannot replace/);
  assert.match(add(f).err, /not committed/);
  candidate(f, { id: 'http', repo: 'app', run: 'true' });
  write(f.wt, 'src/a.txt', 'uncommitted');
  assert.match(add(f).err, /commit the product tree/);
  sh(f.wt, 'git checkout -- src/a.txt');
  assert.notEqual(add(f, 'http', ['--criteria', 'unknown']).code, 0);
  ok(add(f));
  assert.match(add(f).err, /cannot replace/);
});

test('a supplemental failure or plugin skip cannot become a passing full gate', () => {
  for (const status of ['failed', 'skipped']) {
    const f = fixture('supplemental-'+status);
    candidate(f, { id: 'http', repo: 'app', plugin: 'steps/proof.mjs' }, { '.workflow/steps/proof.mjs': `export default { async run(){return {status:'${status}'}} };` });
    ok(add(f)); review(f, 'code');
    const result = wf(f.root, ['gate', '--attempt', f.e.id, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.json().status, 'failed');
  }
});

test('existing catalogued secret bindings are step-specific and cannot change the store or leak values', () => {
  const f = fixture('supplemental-secrets', { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'FIXTURE_KEY', usedBy: ['unit'] }] }) });
  const secret = path.join(f.root, '.env.local'); write(f.root, '.env.local', 'FIXTURE_KEY=fixture-secret-value\n');
  candidate(f, { id: 'http', repo: 'app', run: 'test -n "$FIXTURE_KEY"; echo "$FIXTURE_KEY"' }, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'FIXTURE_KEY', usedBy: ['http'] }] }) });
  const registered = ok(add(f)).json();
  assert.deepEqual(registered.steps[0].secretKeys, ['FIXTURE_KEY']);
  assert.ok(!JSON.stringify(registered).includes('fixture-secret-value'));
  review(f, 'code');
  ok(wf(f.root, ['gate', '--attempt', f.e.id]));
  fs.unlinkSync(secret);
});

test('registration is refused during active roles and unknown keys cannot expand secret access', () => {
  const f = fixture('supplemental-role');
  candidate(f, { id: 'http', repo: 'app', run: 'true' }, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'NEW_KEY', usedBy: ['http'] }] }) });
  assert.match(add(f).err, /only existing catalogued/);
  commitIn(f.wt, { '.workflow/secrets.yaml': yaml({ keys: [] }) });
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'active-review', '--attempt', f.e.id]));
  assert.match(add(f).err, /active roles/);
});


test('supplemental plugin pin never replaces the admission plugin or trusts later edits', () => {
  const original = "export default {async run(ctx){ctx.log('frozen-plugin');return {status:'passed'}}};";
  const changed = "export default {async run(ctx){ctx.log('supplemental-plugin');return {status:'passed'}}};";
  const f = fixture('supplemental-plugin-pin', {'.workflow/steps/shared.mjs': original}, {id:'unit',repo:'app',plugin:'steps/shared.mjs',inputs:['src/**']});
  candidate(f, {id:'http',repo:'app',plugin:'steps/shared.mjs',inputs:['src/**']}, {'.workflow/steps/shared.mjs':changed});
  ok(add(f));
  const pin = state(f.root,f.e.id).validations[0].commit;
  commitIn(f.wt,{'.workflow/steps/shared.mjs':"export default {async run(){throw new Error('unregistered-edit')}};"});
  review(f,'code');
  const result=ok(wf(f.root,['gate','--attempt',f.e.id,'--json'])).json();
  assert.equal(state(f.root,f.e.id).validations[0].commit,pin);
  assert.match(fs.readFileSync(result.steps.find(s=>s.id==='unit').log,'utf8'),/frozen-plugin/);
  assert.match(fs.readFileSync(result.steps.find(s=>s.id==='http').log,'utf8'),/supplemental-plugin/);
});

test('registering another requirement invalidates prior acceptance and the passing gate', () => {
  const f=fixture('supplemental-stale-proof');
  review(f,'code');ok(wf(f.root,['gate','--attempt',f.e.id]));review(f,'evidence');
  ok(wf(f.root,['accept','--attempt',f.e.id]));
  candidate(f,{id:'http',repo:'app',run:'false'});ok(add(f));
  assert.equal(state(f.root,f.e.id).accepted,null);
  const hand=ok(wf(f.root,['handoff','reviewer','--agent','new-code','--attempt',f.e.id,'--json'])).json();
  const bundle=JSON.parse(fs.readFileSync(hand.bundle??hand.file,'utf8'));
  assert.equal(bundle.round,'code-review');assert.equal(bundle.gate.passedOnThisTree,false);
});

// Named failure (0.7.0): a closure was refused for a missing, wrong-pin or duplicate `validationChecked` entry, a form per
// registered step that measured compliance with the form, not defects. The registered validation and its pinned commit stay
// in the reviewer's bundle as context, and the review is recorded whatever verdicts the closure carries.
test('review records supplemental verdicts or none: the bundle carries the pinned validation and a missing, wrong-pin or duplicate verdict refuses nothing', () => {
  const f=fixture('supplemental-review');candidate(f,{id:'http',repo:'app',run:'true'});ok(add(f));
  const pin=state(f.root,f.e.id).validations[0].commit;
  const verdict={id:'http',commit:pin,verdict:'complies',evidence:'Pinned runner inspected'};
  const rounds=[['code',[]],['code-pin',[{id:'http',commit:'0'.repeat(40),verdict:'complies',evidence:'checked'}]],['code-dup',[verdict,verdict]],['code-ok',[verdict]]];
  for (const [agent,validationChecked] of rounds) {
    const hand=ok(wf(f.root,['handoff','reviewer','--agent',agent,'--attempt',f.e.id,'--json'])).json();
    const bundle=JSON.parse(fs.readFileSync(hand.bundle??hand.file,'utf8'));
    // The first round is a full review and carries the registered validation; the later ones are deltas and carry none.
    assert.deepEqual(bundle.supplementalValidation.map((v)=>[v.commit,v.steps.map((s)=>s.id)]),agent==='code'?[[pin,['http']]]:[],'the registered validation is context in the full round');
    ok(wf(f.root,['review','--closure',closureFile(f.base,goodClosure(agent,{validationChecked})),'--attempt',f.e.id]));
  }
  assert.deepEqual(state(f.root,f.e.id).reviews.map((r)=>r.closure.reviewer),rounds.map(([agent])=>agent),'every closure was recorded');
});

// 0.7.23 (I-179), named failure (field): an evidence review raised a blocking finding ("the required browser check was never
// run in the gate"), the owner registered the missing step, and the next code review honestly kept the finding open with
// evidence (a check that has not run cannot be verified). The gate order then waited for every earlier blocking finding to be
// verified, and only the person's gate-order override could run the gate that would run the check. For the gate order only,
// a finding whose proof is the registered step does not hold the gate; acceptance and the reviewer's handoff still need it verified.
const WANT = { id: 'F1', severity: 'high', summary: 'The required browser check was never run in the gate', status: 'open', criterion: 'C1', evidence: 'src/a.txt:1 no step of the gate runs the browser check C1 requires' };
const STILL = (round) => ({ priorFindings: [{ round, id: 'F1', status: 'open', evidence: 'src/a.txt:1 the step has not run yet, so nothing can show it passes' }] });
const NOT_VERIFIED = /the latest review round \(code-2\) has not verified 1 earlier-round finding\(s\) \(\w+-\d:F1\)/;
const mapped = [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log line 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'gate log line 2' } }];

test('0.7.23 (I-179): the gate runs, with no override and no decision, when the only earlier finding it waits for is one an evidence review raised and the step that proves it was registered; acceptance still waits for an evidence round to verify it', () => {
  const f = fixture('supplemental-evidence-repair');
  review(f, 'code-0');
  ok(wf(f.root, ['gate', '--attempt', f.e.id]));
  review(f, 'evidence-1', { findings: [WANT] });
  candidate(f, { id: 'http', repo: 'app', run: 'true' });
  ok(add(f));
  review(f, 'code-2', STILL('evidence-1'));
  // The next step and the gate agree: the gate is next.
  const before = state(f.root, f.e.id);
  assert.deepEqual([before.decision.kind, before.decision.status], ['gate', 'ready']);
  assert.doesNotMatch(before.next, /must verify/);
  const run = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.deepEqual(run.steps.map((x) => x.id).sort(), ['http', 'unit']);
  const s = state(f.root, f.e.id);
  assert.deepEqual([s.gateOverrides ?? [], s.decisions ?? []], [[], []], 'no override and no question to the person');
  // After the gate the evidence review is next, the round that can verify the finding.
  assert.deepEqual([s.decision.kind, s.decision.round], ['review', 'evidence-review']);
  assert.match(s.next, /^evidence review: the gate passed/);
  // Acceptance is not eased: the finding stays an earlier blocking finding that only a later round can settle.
  const refused = wf(f.root, ['accept', '--attempt', f.e.id]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /earlier-round finding\(s\) not verified: evidence-1:F1/);
  // An evidence round written after the gate that still finds it open is not eased either: the next step is the repair.
  review(f, 'evidence-3', STILL('evidence-1'));
  assert.equal(state(f.root, f.e.id).decision.kind, 'repair');
  assert.match(state(f.root, f.e.id).next, /must verify 1 earlier-round finding\(s\) \(evidence-1:F1\)/);
  assert.notEqual(wf(f.root, ['accept', '--attempt', f.e.id]).code, 0);
  review(f, 'evidence-4', { priorFindings: [{ round: 'evidence-1', id: 'F1', status: 'fixed', evidence: 'the http step ran in the gate and passed' }] });
  ok(wf(f.root, ['accept', '--attempt', f.e.id]));
});

test('0.7.23 (I-179): the gate still waits when no step was registered, when the step is for another criterion, and when a code-review round raised the finding', () => {
  const waits = (f, why) => {
    const refused = wf(f.root, ['gate', '--attempt', f.e.id]);
    assert.equal(refused.code, 75, why);
    assert.match(refused.err, NOT_VERIFIED, why);
    const s = state(f.root, f.e.id);
    assert.equal(s.decision.kind, 'repair', `${why}: the next step is the verification`);
    assert.match(s.next, /must verify 1 earlier-round finding\(s\)/, why);
  };
  // No registration: the fix was a commit, and the code review could not verify it either.
  const none = fixture('supplemental-evidence-none');
  review(none, 'code-0');
  ok(wf(none.root, ['gate', '--attempt', none.e.id]));
  review(none, 'evidence-1', { findings: [WANT] });
  commitIn(none.wt, { 'src/a.txt': 'attempted fix\n' });
  review(none, 'code-2', STILL('evidence-1'));
  waits(none, 'no registration');
  // A step registered for another criterion proves nothing about this finding.
  const other = fixture('supplemental-evidence-other', {}, undefined, [{ id: 'C1', text: 'a changes', uat: false }, { id: 'C2', text: 'b changes', uat: false }]);
  review(other, 'code-0', { criteria: mapped });
  ok(wf(other.root, ['gate', '--attempt', other.e.id]));
  review(other, 'evidence-1', { criteria: mapped, findings: [WANT] });
  candidate(other, { id: 'http', repo: 'app', run: 'true' });
  ok(wf(other.root, ['validation', 'add', '--steps', 'http', '--criteria', 'C2', '--reason', 'Required real execution', '--attempt', other.e.id]));
  review(other, 'code-2', { criteria: mapped, ...STILL('evidence-1') });
  waits(other, 'a step for another criterion');
  // A finding a code-review round raised: the step was registered after it, but no gate has judged it yet, and a code review is the round that raised it.
  const code = fixture('supplemental-evidence-code');
  review(code, 'code-1', { findings: [WANT] });
  candidate(code, { id: 'http', repo: 'app', run: 'true' });
  ok(add(code));
  review(code, 'code-2', STILL('code-1'));
  waits(code, 'a code-review round raised it');
});

// 0.7.29 (I-206, I-205), named failure (field): six checks were registered on a batch (`wf validation add`) before its next
// reviewer handoff, and that delta round's bundle carried `supplementalValidation: []`, because a delta was handed corrections
// only; the reviewer kept a finding that the required proof was not registered until the owner showed it the ledger event.
test('0.7.29 (I-206): a check registered after the last reviewed round reaches the next delta reviewer, which is asked its verdict on the pinned definition; the round after carries none', () => {
  const f = fixture('supplemental-delta-added');
  review(f, 'code-0');
  candidate(f, { id: 'http', repo: 'app', run: 'true' });
  ok(add(f));
  const pin = state(f.root, f.e.id).validations[0].commit;
  const bundleOf = (agent) => {
    const hand = ok(wf(f.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', f.e.id, '--json'])).json();
    return JSON.parse(fs.readFileSync(hand.bundle ?? hand.file, 'utf8'));
  };
  const one = bundleOf('code-1');
  assert.equal(one.mode, 'delta');
  assert.deepEqual(one.supplementalValidation.map((v) => [v.commit, v.steps.map((s) => s.id)]), [[pin, ['http']]], 'the registration since the last round is handed');
  assert.match(one.instructions, /`supplementalValidation` lists the checks registered, corrected or carried from a batch member since the last reviewed round \(http\): the gate runs each at its pinned commit[^.]*validationChecked/);
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('code-1', { validationChecked: [{ id: 'http', commit: pin, verdict: 'complies', evidence: 'Pinned definition inspected' }] })), '--attempt', f.e.id]));
  const two = bundleOf('code-2');
  assert.deepEqual(two.supplementalValidation, [], 'a round handed after it has nothing new');
  assert.doesNotMatch(two.instructions, /`supplementalValidation` lists the checks/);
});

// 0.7.32 (D73). Named failure (field): `wf validation add` refused "supplemental step X is not committed in the attempt adapter"
// and named no route, while the session rules said "never change the workflow from a ticket"; a finding ("no final-tree proof")
// stayed open 37 minutes, a strategist escalated it to the person, and the person had to answer before the proof was registered.
// The refusal names the route; the step committed there registers, runs at that commit, and nothing else of that commit (here
// the attempt's adapter drops the frozen `unit` step) becomes a rule the attempt is judged by.
test('D73: a step not committed in the attempt adapter is refused with the route; committed there, it registers and runs beside every frozen step', () => {
  const f = fixture('supplemental-route');
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refused = add(f);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /supplemental step http is not committed in the attempt adapter/);
  assert.match(refused.err, new RegExp(`commit its definition \\(the step under \`gate\\.steps\` in \\.workflow/project\\.yaml, and its plugin if it has one\\) in this attempt's worktree of app \\(${escape(fs.realpathSync(f.wt))}\\), then run \`wf validation add --steps http --criteria <ids> --reason "<why>" --attempt ${escape(f.e.id)}\` again`));
  assert.match(refused.err, /This is the project's adapter, not the workflow: proof a ticket adds is additive by design, and nothing else in that commit becomes a rule this attempt is judged by/);
  candidate(f, { id: 'http', repo: 'app', run: 'true' });
  ok(add(f));
  review(f, 'code');
  const run = ok(wf(f.root, ['gate', '--attempt', f.e.id, '--json'])).json();
  assert.deepEqual(run.steps.map((s) => `${s.id}:${s.status}`).sort(), ['http:passed', 'unit:passed']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf, write, yaml } from './helpers.mjs';

function fixture(name, files = {}, unit = { id: 'unit', repo: 'app', run: 'test -f src/a.txt', inputs: ['src/**'] }) {
  const config = { gate: { steps: [unit] } };
  const f = singleRepoProject(name, config, files);
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'planner', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
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

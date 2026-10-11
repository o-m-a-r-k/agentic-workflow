import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, write } from './helpers.mjs';
import { codexEntries } from '../engine/codex-agent.mjs';
import { unreadDocs } from '../engine/rules.mjs';

function fixture() {
  const base = tmp('codex-node-reads'), doc = path.join(base, 'SKILL.md');
  write(base, 'SKILL.md', '# Required skill\nExact full contents.\n');
  const file = path.join(base, 'host.jsonl'), bundle = { skills: [{ file: doc }] };
  const code = "nodeRepl.write(await fs.readFile(bundle.skills[0].file,'utf8')); nodeRepl.write({done:true});";
  const input = `text(await tools.mcp__node_repl__js(${JSON.stringify({code})}));\ntext(await tools.exec_command({cmd:"true"}));`;
  const call = { type: 'custom_tool_call', name: 'exec', call_id: 'read-1', input };
  const result = { content: [{ type: 'text', text: fs.readFileSync(doc, 'utf8') + '{ done: true }' }], isError: false };
  const output = [{type:'input_text',text:'Script completed\nWall time 0.1 seconds\nOutput:\n'}, {type:'input_text',text:JSON.stringify(result)}, {type:'input_text',text:'{"exit_code":0}'}];
  const check = (c=call, o=output) => {
    fs.writeFileSync(file, [c, { type:'custom_tool_call_output',call_id:'read-1',output:o }].map(payload=>JSON.stringify({type:'response_item',payload})).join('\n'));
    return unreadDocs(codexEntries(file, { bundle }).entries, [], [{name:'required',file:doc}]);
  };
  return { file, doc, bundle, code, call, result, output, check };
}

test('I-48: completed Node reader output binds the handed skill path and full contents across literal tool calls',()=>{
  const f=fixture();
  assert.deepEqual(f.check(), []);
  const code=`nodeRepl.write(await fs.readFile(${JSON.stringify(f.doc)},'utf8'));`;
  const call={type:'function_call',namespace:'mcp__node_repl',name:'js',call_id:'read-1',arguments:JSON.stringify({code})};
  fs.writeFileSync(f.file, [call,{type:'function_call_output',call_id:'read-1',output:JSON.stringify(f.result)}].map(payload=>JSON.stringify({type:'response_item',payload})).join('\n'));
  assert.deepEqual(unreadDocs(codexEntries(f.file).entries,[],[{name:'required',file:f.doc}]),[]);
});

test('I-48: missing, failed, truncated, wrong-path and ambiguous Node reads still refuse',()=>{
  const f=fixture();
  for(const result of [{...f.result,isError:true},{content:[]},{...f.result,content:[{type:'text',text:'# Required skill'}]}]){
    assert.equal(f.check(f.call,[f.output[0],{type:'input_text',text:JSON.stringify(result)},f.output[2]]).length,1);
  }
  for(const call of [
    {...f.call,call_id:'wrong-id'},
    {...f.call,input:'if(false){'+f.call.input+'}'},
    {...f.call,input:f.call.input.replace('bundle.skills[0].file',JSON.stringify('/wrong/SKILL.md'))},
    {...f.call,input:f.call.input.replace("nodeRepl.write(await fs.readFile", "nodeRepl.write('claimed read'); nodeRepl.write(await fs.readFile")},
    {...f.call,input:f.call.input.replace('mcp__node_repl__js','mcp__other__js')}
  ]) assert.equal(f.check(call).length,1);
  assert.equal(f.check(f.call,f.output.slice(0,2)).length,1);
  f.check();
  fs.appendFileSync(f.file,'\n'+JSON.stringify({type:'response_item',payload:f.call}));
  assert.equal(unreadDocs(codexEntries(f.file,{bundle:f.bundle}).entries,[],[{name:'required',file:f.doc}]).length,1,'duplicate call ids are ambiguous');
  fs.writeFileSync(f.doc,'changed after the recorded read');
  assert.equal(f.check().length,1);
});

// Named failure I-75: successful native exec_command reads were not visible to document receipt checks.
test('I-75: direct and wrapped permitted command reads require complete successful output', () => {
  const f = fixture();
  const check = (call, result) => {
    const output = call.type === 'function_call'
      ? { type: 'function_call_output', call_id: 'read-1', output: JSON.stringify(result) }
      : { type: 'custom_tool_call_output', call_id: 'read-1', output: [f.output[0], { type: 'input_text', text: JSON.stringify(result) }] };
    fs.writeFileSync(f.file, [call, output].map(payload => JSON.stringify({ type: 'response_item', payload })).join('\n'));
    return unreadDocs(codexEntries(f.file).entries, [], [{ name: 'required', file: f.doc }]);
  };
  for (const cmd of ['cat ' + f.doc, 'wf evidence show ' + f.doc + ' --attempt ENG-80.1', 'cat "' + f.doc + '"']) {
    const args = { cmd };
    const direct = { type: 'function_call', namespace: 'functions', name: 'exec_command', call_id: 'read-1', arguments: JSON.stringify(args) };
    const wrapped = { type: 'custom_tool_call', name: 'exec', call_id: 'read-1', input: `text(await tools.exec_command(${JSON.stringify(args)}));` };
    const result = { exit_code: 0, output: fs.readFileSync(f.doc, 'utf8') };
    for (const call of [direct, wrapped]) {
      assert.deepEqual(check(call, result), []);
      for (const bad of [{ ...result, exit_code: 1 }, { ...result, session_id: 123 }, { ...result, output: '# Required skill' }]) assert.equal(check(call, bad).length, 1);
    }
    assert.equal(check({ ...wrapped, input: 'if(false){' + wrapped.input + '}' }, result).length, 1);
    assert.equal(check({ ...direct, arguments: JSON.stringify({ cmd: cmd + '; true' }) }, result).length, 1);
    assert.equal(check({ ...direct, arguments: JSON.stringify({ cmd: 'cat /wrong/SKILL.md' }) }, result).length, 1);
    for (const shell of [123, null, {}, '/bin/unsupported']) assert.equal(check({ ...direct, arguments: JSON.stringify({ cmd, shell }) }, result).length, 1);
  }
});

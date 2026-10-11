import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { showEvidence, MAX_SHOW_BYTES } from '../engine/evidence-read.mjs';
import { completedNodeReads } from '../engine/codex-reads.mjs';

function fixture(text) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reader-pages-')));
  const id='ENG-800.1', dir=path.join(root,'.wf-evidence','attempts',id);
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'bundle.json');
  fs.writeFileSync(file,text);
  return {root,id,file,state:{id},dir};
}
function receipt(f,page,id) {
  const input={cmd:`wf evidence show ${f.file} --attempt ${f.id} --offset ${page.offset} --length 32768 --json`};
  return [
    {type:'response_item',payload:{type:'function_call',namespace:'functions',name:'exec_command',call_id:id,arguments:JSON.stringify(input)}},
    {type:'response_item',payload:{type:'function_call_output',call_id:id,output:JSON.stringify({exit_code:0,output:JSON.stringify(page)})}}
  ];
}

// Named failure I-80: a shell-only role could not finish reading its immutable19 MB handoff.
test('I-80: bounded pages cover a file beyond4 MiB, preserve Unicode and earn complete read provenance',()=>{
  const text='a'.repeat(MAX_SHOW_BYTES+7)+'🙂العربية\n';
  const f=fixture(text), raw=[];
  let offset=0, all='';
  do {
    const page=showEvidence(f.root,f.state,f.file,{offset,length:32768});
    assert.equal(page.sha256,crypto.createHash('sha256').update(text).digest('hex'));
    assert.equal(page.offset,offset);
    assert.ok(page.bytes<=32768);
    all+=page.text; raw.push(...receipt(f,page,'page-'+offset)); offset=page.nextOffset;
  } while(offset<Buffer.byteLength(text));
  assert.equal(all,text);
  assert.equal(completedNodeReads(raw,{}).length,1);
  const omitted=raw.slice(0,4).concat(raw.slice(6));
  assert.equal(completedNodeReads(omitted,{}).length,0,'a gap cannot earn read credit');
  const bad=structuredClone(raw);
  const result=JSON.parse(bad[5].payload.output); result.output=result.output.slice(0,-1); bad[5].payload.output=JSON.stringify(result);
  assert.equal(completedNodeReads(bad,{}).length,0,'truncated output cannot earn read credit');
  fs.appendFileSync(f.file,'changed');
  assert.equal(completedNodeReads(raw,{}).length,0,'changed source invalidates receipts');
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('I-80: UTF8 scalar boundaries and invalid ranges fail closed; links and binary stay refused',()=>{
  const f=fixture('abc🙂xyz');
  const first=showEvidence(f.root,f.state,f.file,{offset:0,length:5});
  assert.equal(first.text,'abc'); assert.equal(first.nextOffset,3);
  assert.equal(showEvidence(f.root,f.state,f.file,{offset:3,length:4}).text,'🙂');
  assert.throws(()=>showEvidence(f.root,f.state,f.file,{offset:4,length:4}),/UTF-8 boundary/);
  assert.throws(()=>showEvidence(f.root,f.state,f.file,{offset:3,length:1}),/cannot contain/);
  for(const options of [{offset:true},{offset:''},{offset:'1e2'},{length:true},{offset:-1},{offset:0.5},{offset:'nope'},{offset:100},{length:0},{length:MAX_SHOW_BYTES+1},{length:Infinity}]) assert.throws(()=>showEvidence(f.root,f.state,f.file,options));
  fs.writeFileSync(path.join(f.dir,'invalid.txt'),Buffer.from([97,255,98]));
  assert.throws(()=>showEvidence(f.root,f.state,'invalid.txt',{offset:0,length:2}),/not valid UTF-8/);
  fs.writeFileSync(path.join(f.dir,'binary.txt'),Buffer.from([97,0,98]));
  assert.throws(()=>showEvidence(f.root,f.state,'binary.txt',{offset:0,length:1}),/binary/);
  fs.symlinkSync(f.file,path.join(f.dir,'linked.txt'));
  assert.throws(()=>showEvidence(f.root,f.state,'linked.txt',{offset:0,length:1}),/not a regular file/);
  fs.linkSync(f.file,path.join(f.dir,'hard.txt'));
  assert.throws(()=>showEvidence(f.root,f.state,f.file,{offset:0,length:1}),/one name/);
  assert.throws(()=>showEvidence(f.root,f.state,'../../outside',{offset:0,length:1}));
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('I-80: failed, pending, forged and out-of-order page receipts never prove a read',()=>{
  const f=fixture('abcdefgh');
  const page=showEvidence(f.root,f.state,f.file,{offset:0,length:32768});
  const raw=receipt(f,page,'one'); assert.equal(completedNodeReads(raw,{}).length,1);
  for(const change of [r=>r.exit_code=1,r=>r.session_id=1,r=>{const p=JSON.parse(r.output);p.sha256='0'.repeat(64);r.output=JSON.stringify(p);},r=>{const p=JSON.parse(r.output);p.text='fakefake';r.output=JSON.stringify(p);}]) {
    const bad=structuredClone(raw), r=JSON.parse(bad[1].payload.output); change(r);bad[1].payload.output=JSON.stringify(r);assert.equal(completedNodeReads(bad,{}).length,0);
  }
  const tail=showEvidence(f.root,f.state,f.file,{offset:4,length:32768});
  assert.equal(completedNodeReads(receipt(f,tail,'tail'),{}).length,0);
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('I-80: structured handoffs beyond4 MiB inspect bounded original sections without document read credit',async()=>{
  const {inspectEvidence}=await import('../engine/evidence-read.mjs');
  const f=fixture(JSON.stringify({instructions:'x'.repeat(MAX_SHOW_BYTES+100),work:{id:'W1',criteria:['C1']},impactMap:{queries:[{id:'q1',files:['a.ts']},{id:'q2',files:['b.ts']}]},'a/b~':{value:'kept'},unicode:'a🙂b',controls:'\u0001'.repeat(5000)}));
  const inventory=inspectEvidence(f.root,f.state,f.file,{count:10});
  assert.ok(Buffer.byteLength(JSON.stringify(inventory))<16384);
  assert.equal(inventory.documentReadCredit,false);
  assert.equal(inventory.items.find(x=>x.key==='instructions').oversized,true);
  assert.deepEqual(inspectEvidence(f.root,f.state,f.file,{pointer:'/work'}).items.find(x=>x.key==='id').value,'W1');
  assert.equal(inspectEvidence(f.root,f.state,f.file,{pointer:'/impactMap/queries',count:1}).nextFrom,1);
  assert.equal(inspectEvidence(f.root,f.state,f.file,{pointer:'/impactMap/queries',from:1,count:1}).items[0].value.id,'q2');
  assert.equal(inspectEvidence(f.root,f.state,f.file,{pointer:'/instructions',count:20}).text,'x'.repeat(20));
  assert.equal(inspectEvidence(f.root,f.state,f.file,{pointer:'/a~1b~0/value'}).text,'kept');
  const controls=inspectEvidence(f.root,f.state,f.file,{pointer:'/controls',count:4096});
  assert.ok(Buffer.byteLength(JSON.stringify(controls))<=16384);
  assert.ok(controls.nextFrom>0 && controls.remaining>0);
  assert.equal(controls.text,'\u0001'.repeat(controls.nextFrom));
  const unicode=inspectEvidence(f.root,f.state,f.file,{pointer:'/unicode',count:2});
  assert.equal(unicode.text,'a');assert.equal(unicode.nextFrom,1);
  assert.throws(()=>inspectEvidence(f.root,f.state,f.file,{pointer:'/unicode',from:2,count:2}),/scalar boundary/);
  for(const options of [{pointer:'/__proto__'},{pointer:'/work/constructor'},{pointer:'/bad~2'},{pointer:true},{from:true},{count:0},{count:5000},{from:100}]) assert.throws(()=>inspectEvidence(f.root,f.state,f.file,options));
  const raw=[{type:'response_item',payload:{type:'function_call',namespace:'functions',name:'exec_command',call_id:'inspect',arguments:JSON.stringify({cmd:`wf evidence inspect ${f.file} --attempt ${f.id}`})}},{type:'response_item',payload:{type:'function_call_output',call_id:'inspect',output:JSON.stringify({exit_code:0,output:JSON.stringify(inventory)})}}];
  assert.equal(completedNodeReads(raw,{}).length,0,'structured inspection is not complete rule-document read credit');
  fs.symlinkSync(f.file,path.join(f.dir,'linked.json'));
  assert.throws(()=>inspectEvidence(f.root,f.state,'linked.json'),/not a regular file/);
  fs.linkSync(f.file,path.join(f.dir,'hard.json'));
  assert.throws(()=>inspectEvidence(f.root,f.state,'hard.json'),/one name/);
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('I-80: actual fresh native role bootstrap separates structured input from required document receipts',async()=>{
  const {roleInstructions}=await import('../engine/onboard.mjs');
  const cfg={classes:{full:{use:'Critical boundaries'}}};
  for(const role of ['implementer','reviewer','planner']) {
    const body=roleInstructions(cfg,role,'full');
    assert.match(body,/Handoff JSON is structured input, not a complete-output document receipt/);
    assert.match(body,/wf evidence inspect <handed absolute path>/);
    assert.match(body,/follow every required item marked `oversized`/);
    assert.match(body,/Separate rule\/skill\/invariant\/appendix documents require complete observed output/);
    assert.doesNotMatch(body,/read large handoffs and required documents with one plain/);
  }
});

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

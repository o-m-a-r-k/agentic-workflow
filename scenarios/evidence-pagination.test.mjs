import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { showEvidence, MAX_SHOW_BYTES } from '../engine/evidence-read.mjs';
import { ok, singleRepoProject, wf } from './helpers.mjs';

function fixture(text) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reader-pages-')));
  const id='ENG-800.1', dir=path.join(root,'.wf-evidence','attempts',id);
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'bundle.json');
  fs.writeFileSync(file,text);
  return {root,id,file,state:{id},dir};
}
// Named failure I-80: a shell-only role could not finish reading its immutable19 MB handoff.
test('I-80: bounded pages cover a file beyond4 MiB and preserve Unicode',()=>{
  const text='a'.repeat(MAX_SHOW_BYTES+7)+'🙂العربية\n';
  const f=fixture(text);
  let offset=0, all='';
  do {
    const page=showEvidence(f.root,f.state,f.file,{offset,length:32768});
    assert.equal(page.sha256,crypto.createHash('sha256').update(text).digest('hex'));
    assert.equal(page.offset,offset);
    assert.ok(page.bytes<=32768);
    all+=page.text; offset=page.nextOffset;
  } while(offset<Buffer.byteLength(text));
  assert.equal(all,text);
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

test('I-80: structured handoffs beyond4 MiB inspect bounded original sections',async()=>{
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
  fs.symlinkSync(f.file,path.join(f.dir,'linked.json'));
  assert.throws(()=>inspectEvidence(f.root,f.state,'linked.json'),/not a regular file/);
  fs.linkSync(f.file,path.join(f.dir,'hard.json'));
  assert.throws(()=>inspectEvidence(f.root,f.state,'hard.json'),/one name/);
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('I-80: actual fresh native role bootstrap separates structured input from the documents read far enough to apply every rule',async()=>{
  const {roleInstructions}=await import('../engine/onboard.mjs');
  const cfg={classes:{full:{use:'Critical boundaries'}}};
  const inspect={claude:'structured handoff JSON is inspected with `wf evidence inspect` (never one full-output dump)',codex:'inspects structured handoff JSON with `wf evidence inspect` (never one full-output dump)'};
  for(const [role,host] of ['implementer','reviewer','planner'].flatMap((r)=>['claude','codex'].map((h)=>[r,h]))) {
    const body=roleInstructions(cfg,role,'full','',host);
    // Structured handoff JSON goes through `wf evidence inspect` and is never printed whole; the documents a bundle names
    // are separate files, each read far enough to apply every rule that bears on the work (the page mechanics are the reviewer bundle's, tested with it).
    assert.ok(body.includes(inspect[host]),host+' '+role);
    assert.match(body,/Read the documents your work depends on far enough to apply what bears on it, and say what you did not reach rather than claiming it\./);
    assert.doesNotMatch(body,/read receipt|document receipt|document-read/i);
    assert.doesNotMatch(body,/read large handoffs and required documents with one plain/);
  }
});

// Named failure I-80: budgeting before final pagination metadata could overflow on Linux fixture paths.
test('I-80: final pretty-printed inspection pages stay bounded across filename lengths',async()=>{
  const {inspectEvidence}=await import('../engine/evidence-read.mjs');
  const rows=Array.from({length:12},(_,id)=>({id,text:'\u0001'.repeat(500)}));
  const f=fixture(JSON.stringify({controls:'\u0001'.repeat(5000),rows}));
  try {
    for(let n=0;n<6;n++) {
      let from=0, recovered='';
      do {
        const page=inspectEvidence(f.root,f.state,f.file,{pointer:'/controls',from,count:4096});
        assert.ok(Buffer.byteLength(JSON.stringify(page,null,2)+'\n')<=16384,`filename variant ${n}, offset ${from}`);
        assert.ok(page.nextFrom>from);
        recovered+=page.text;from=page.nextFrom;
      } while(from<5000);
      assert.equal(recovered,'\u0001'.repeat(5000));
      from=0;const recoveredRows=[];
      do {
        const page=inspectEvidence(f.root,f.state,f.file,{pointer:'/rows',from,count:4096});
        assert.ok(Buffer.byteLength(JSON.stringify(page,null,2)+'\n')<=16384);
        assert.ok(page.nextFrom>from);
        for(const item of page.items) {
          if(!item.oversized) recoveredRows.push(item.value);
          else {
            const section=inspectEvidence(f.root,f.state,f.file,{pointer:item.pointer,count:4096});
            assert.ok(Buffer.byteLength(JSON.stringify(section,null,2)+'\n')<=16384);
            assert.ok(section.items.every(child=>!child.oversized));
            recoveredRows.push(Object.fromEntries(section.items.map(child=>[child.key,child.value])));
          }
        }
        from=page.nextFrom;
      } while(from<rows.length);
      assert.deepEqual(recoveredRows,rows);
      const next=f.file+'x';fs.renameSync(f.file,next);f.file=next;
    }
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('I-80: empty sections with oversized escaped pointer metadata fail within the response bound',async()=>{
  const {inspectEvidence}=await import('../engine/evidence-read.mjs');
  const key='\u0001'.repeat(3000),f=fixture(JSON.stringify({[key]:{}}));
  try {assert.throws(()=>inspectEvidence(f.root,f.state,f.file,{pointer:'/'+key}),/cannot fit a bounded inspection response/);}
  finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

// Named failure I-82: the CLI treated numeric --from as the skills-update source directory.
test('I-82: real CLI inspect paginates zero and nonzero offsets while skills source stays a guarded path',()=>{
  const {base,root}=singleRepoProject('inspect-cli-offset');
  const id=ok(wf(root,['entry','--item','ENG-882','--json'])).json().id;
  const handoff=ok(wf(root,['handoff','planner','--agent','reader_i82','--attempt',id,'--json'])).json();
  for(const [from,expected] of [['0','read'],['4','er_i'],['8','82']]) {
    const output=ok(wf(root,['evidence','inspect',handoff.bundle,'--attempt',id,'--pointer','/agent','--from',from,'--count','4']));
    assert.ok(Buffer.byteLength(output.out)<=16384);
    const page=output.json();assert.equal(page.from,Number(from));assert.equal(page.text,expected);
    assert.equal(page.documentReadCredit,false);
  }
  for(const from of ['-1','1e2','true',root]) assert.notEqual(wf(root,['evidence','inspect',handoff.bundle,'--attempt',id,'--pointer','/agent','--from',from]).code,0);
  assert.match(wf(root,['skills','update','sample','--from',handoff.bundle]).err,/inside/);
  const source=path.join(base,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'SKILL.md'),'# Sample\n');
  ok(wf(root,['skills','update','sample','--from',source]));
  assert.equal(fs.readFileSync(path.join(root,'.workflow','skills','sample','SKILL.md'),'utf8'),'# Sample\n');
  assert.match(wf(root,['skills','update','sample','--from',path.join(source,'SKILL.md')]).err,/not a regular folder/);
  assert.notEqual(wf(root,['lesson','inspect',handoff.bundle,'--attempt',id]).code,0,'inspection belongs to evidence, not lesson dispatch');
});

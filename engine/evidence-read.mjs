// `wf evidence list|show` (I-16): read an attempt's evidence without naming its folder in any shell command. Named
// failure: agents reached for `cat`, `ls` or `grep` on evidence paths, the guard refused them (it decides on the raw text
// and never parses shell), and they split commands or switched tools by trial. These commands write nothing of their
// own (opening the attempt runs the usual evidence verification, as every `wf` command does); the attempt folder and
// each file are refused when they are links, each file is opened with O_NOFOLLOW and must have one name, only paths
// inside this attempt's evidence are read, and at most MAX_SHOW_BYTES are read. Images are not printed: `wf export screenshots` copies them out, sha256-checked (`--run <id>` the images of one run or import, I-198).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { attemptDir } from './ledger.mjs';
import { listableOf } from './evidence.mjs';
import { recordedFileProblem } from './evidence.mjs';
import { isInside } from './paths.mjs';
import { WfError, refuse } from './util.mjs';

export const IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
export const MAX_SHOW_BYTES = 4 * 1024 * 1024;

// The kind of an evidence file, from its path inside the attempt folder.
export function kindOf(rel) {
  const [top] = rel.split('/');
  if (IMAGE.test(rel)) return 'screenshot';
  if (rel === 'ledger.jsonl') return 'ledger';
  if (top === 'plans') return 'plan';
  if (top === 'handoffs') return 'handoff';
  if (top === 'review') return 'review';
  if (top === 'gate' || top === 'checks') return /\.(log|txt|out)$/i.test(rel) ? 'gate log' : 'gate record';
  if (top === 'tracker') return 'tracker';
  if (top === 'delivery') return 'delivery';
  if (top === 'issue') return 'issue';
  return 'other';
}

function walk(dir, rel, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, r, out);
    else if (e.isFile()) out.push({ path: r, file: abs, kind: kindOf(r), size: fs.lstatSync(abs).size });
    else out.push({ path: r, file: abs, kind: 'not a regular file (not read)', size: null });
  }
}

function attemptFolder(root, state) {
  const dir = attemptDir(root, state.id);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw refuse(`${dir} is not a real folder (a link or missing); nothing is read through it`);
  return dir;
}

// The export that reads an evidence image (I-198): its run's (`gate/<run id>/…`) or its import's (`captures/import-<n>/…`), else
// the last gate's set.
function imageRoute(rel, state) {
  const run = /^gate\/([\w.-]+)\//.exec(rel)?.[1] ?? /^captures\/(import-\d+)\//.exec(rel)?.[1] ?? null;
  return run ? `\`wf export screenshots --run ${run} --attempt ${state.id} --to <folder>\` (every image of that run or import, sha256-checked)` : `\`wf export screenshots --gate --attempt ${state.id} --to <folder>\` (the gate's set; without --gate, the delivered set)`;
}

export function listEvidence(root, state, { kind = null } = {}) {
  const dir = attemptFolder(root, state);
  const files = [];
  walk(dir, '', files);
  const listable = listableOf(root, state.id);
  const shown = files.filter((f) => listable(f.path));
  return { attempt: state.id, dir, files: kind ? shown.filter((f) => f.kind === kind) : shown };
}

// Named failure I-80: shell-only roles could never read beyond the first 4 MiB of a handed bundle.
// Bounded pages retain every no-follow check and report a whole-file hash; no evidence is rewritten.
export function showEvidence(root, state, rel, { offset, length, maxSize } = {}) {
  const paged = offset !== undefined || length !== undefined;
  for (const value of [offset,length]) if (value !== undefined && !((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^[0-9]+$/.test(value)))) throw new WfError('evidence page offset and length must be decimal integers');
  const start = offset === undefined ? 0 : Number(offset);
  const limit = length === undefined ? MAX_SHOW_BYTES : Number(length);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SHOW_BYTES)
    throw new WfError('evidence page requires nonnegative integer --offset and --length between 1 and 4194304');
  if (typeof rel !== 'string' || !rel.trim()) throw new WfError(`usage: wf evidence show <path> --attempt ${state.id} (a path from \`wf evidence list\`)`);
  const dir = fs.realpathSync.native(attemptFolder(root, state));
  // Named failure I-45: native roles receive absolute bundle/rule paths, but the sanctioned reader rejected them.
  if (rel.split(/[\\/]/).includes('..')) throw refuse(`${rel}: give a path inside this attempt's evidence, relative to it, as \`wf evidence list --attempt ${state.id}\` prints it`);
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.join(dir, rel);
  if (!abs.startsWith(dir + path.sep)) throw refuse('give an evidence file inside the selected attempt; cross-attempt and outside reads are refused');
  let parent;
  try {
    parent = fs.realpathSync.native(path.dirname(abs));
  } catch {
    throw refuse(`${rel}: no such evidence file in ${state.id}`);
  }
  if (!(parent === dir || isInside(parent, dir))) throw refuse(`${rel}: give a path inside this attempt's evidence, relative to it`);
  // 0.7.30 (I-198): an image goes to the export of the run or import it belongs to, which reads it whatever that run's outcome
  // (failed, stopped, interrupted, or an import made before any gate); `--gate` reads only the last gate's collected set.
  if (IMAGE.test(rel)) throw refuse(`${rel} is an image: copy it out with ${imageRoute(path.relative(dir, abs).split(path.sep).join('/'), state)} and view the copy with the Read tool`);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) throw refuse(`${rel}: no such evidence file in ${state.id}`);
  if (st.isSymbolicLink() || !st.isFile()) throw refuse(`${rel} is not a regular file; nothing is read through it`);
  // Named failure (I-50): a file a `wf` command is still writing (not yet recorded) was shown like recorded evidence.
  if (!listableOf(root, state.id)(path.relative(dir, abs).split(path.sep).join('/'))) throw refuse(`${rel}: not recorded yet; a wf command may still be writing it`, 'try again in a moment', { id: 'evidence:unrecorded' });
  const changed = recordedFileProblem(root, state.id, abs);
  if (changed) throw refuse(`${changed}; nothing is read from it`, `\`wf verify --attempt ${state.id}\` lists every difference`);
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    throw refuse(`${rel} could not be opened without following a link; nothing is read through it`);
  }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.nlink > 1) throw refuse(`${rel} is not a regular file with one name; nothing is read through it`);
    if (maxSize !== undefined && fst.size > maxSize) throw refuse('structured evidence exceeds the 64 MiB inspection limit');
    if (start > fst.size) throw new WfError('evidence page offset is past end of file');
    const buf = Buffer.alloc(Math.min(fst.size - start, limit));
    let n = 0;
    while (n < buf.length) {
      const k = fs.readSync(fd, buf, n, buf.length - n, start + n);
      if (!k) break;
      n += k;
    }
    let bytes = buf.subarray(0, n);
    if (bytes.includes(0)) throw refuse(`${rel} is binary; it is not printed`);
    if (!paged) return { path: rel, file: abs, size: fst.size, truncated: fst.size > MAX_SHOW_BYTES, text: bytes.toString('utf8') };
    // A page starts on a UTF-8 scalar boundary. Trim only an incomplete final scalar, never an invalid byte.
    if (bytes.length && (bytes[0] & 0xc0) === 0x80) throw new WfError('evidence page offset must be a UTF-8 boundary');
    if (start + n < fst.size && n) {
      let lead = n - 1;
      while (lead > 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
      const value = bytes[lead], needed = value >= 0xc2 && value <= 0xdf ? 2 : value >= 0xe0 && value <= 0xef ? 3 : value >= 0xf0 && value <= 0xf4 ? 4 : 1;
      if (needed > n - lead) bytes = bytes.subarray(0,lead);
    }
    if (n && !bytes.length) throw new WfError('evidence page length cannot contain the next UTF-8 scalar');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw refuse(`${rel} is not valid UTF-8`); }
    const hash = crypto.createHash('sha256'), scratch = Buffer.alloc(65536);
    let at = 0;
    while (at < fst.size) {
      const k = fs.readSync(fd, scratch, 0, Math.min(scratch.length, fst.size - at), at);
      if (!k) throw refuse('evidence file changed during page read');
      if (scratch.subarray(0,k).includes(0)) throw refuse(`${rel} is binary; it is not printed`);
      hash.update(scratch.subarray(0,k)); at += k;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== fst.size || after.mtimeMs !== fst.mtimeMs || after.ctimeMs !== fst.ctimeMs) throw refuse('evidence file changed during page read');
    const nextOffset = start + bytes.length;
    return { path: rel, file: abs, size: fst.size, offset: start, bytes: bytes.length, nextOffset,
      remaining: fst.size - nextOffset, sha256: hash.digest('hex'), truncated: nextOffset < fst.size, text };
  } finally {
    fs.closeSync(fd);
  }
}

// Named failure I-80: handing a structured JSON bundle to a shell-only role required a full-output dump.
// Inspect original immutable JSON through bounded sections, without awarding complete-document read credit.
export function inspectEvidence(root, state, rel, { pointer = '', from = 0, count = 8 } = {}) {
  const integer = value => (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^[0-9]+$/.test(value));
  if (typeof pointer !== 'string' || Buffer.byteLength(pointer) > 4096 || (pointer && !pointer.startsWith('/')) || !integer(from) || !integer(count) || Number(from) < 0 || Number(count) < 1 || Number(count) > 4096)
    throw new WfError('inspect needs a JSON pointer, nonnegative integer --from and --count between 1 and 4096');
  let page=showEvidence(root,state,rel,{offset:0,length:MAX_SHOW_BYTES,maxSize:64*1024*1024});
  const file=page.file, size=page.size, sha256=page.sha256;
  let text=page.text;
  while(page.remaining) {
    page=showEvidence(root,state,rel,{offset:page.nextOffset,length:MAX_SHOW_BYTES,maxSize:64*1024*1024});
    if(page.file!==file || page.size!==size || page.sha256!==sha256) throw refuse('structured evidence changed during inspection');
    text+=page.text;
  }
  let value;
  try { value=JSON.parse(text); } catch { throw refuse('structured inspection requires valid JSON'); }
  if(pointer) for(const raw of pointer.slice(1).split('/')) {
    if(/~(?![01])/.test(raw)) throw new WfError('invalid JSON pointer escape');
    const key=raw.replace(/~1/g,'/').replace(/~0/g,'~');
    if(value===null || typeof value!=='object' || !Object.prototype.hasOwnProperty.call(value,key)) throw refuse('JSON pointer is not an own property of the handed input');
    value=value[key];
  }
  const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
  const start=Number(from), take=Number(count), escape=key=>String(key).replace(/~/g,'~0').replace(/\//g,'~1');
  const keys=kind==='array'?Object.keys(value):kind==='object'?Object.keys(value):null;
  const total=kind==='string'?value.length:keys?keys.length:1;
  if(start>total) throw new WfError('inspection range starts past the selected value');
  const result={file,size,sha256,pointer,kind,total,from:start,nextFrom:start,remaining:total-start,documentReadCredit:false};
  // Named failure I-80: final cursor digits and pretty-printing exceeded the budget checked against stale metadata.
  const fits = page => Buffer.byteLength(JSON.stringify(page,null,2)+'\n') <= 16384;
  if(kind==='string') {
    if(start && start<total && /[\uDC00-\uDFFF]/.test(value[start]) && /[\uD800-\uDBFF]/.test(value[start-1])) throw new WfError('string range must start at a scalar boundary');
    let end=Math.min(total,start+Math.min(take,4096));
    if(end<total && end>start && /[\uD800-\uDBFF]/.test(value[end-1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    if(end===start && start<total) throw new WfError('string range is too short for the next scalar');
    while (!fits({...result,text:value.slice(start,end),nextFrom:end,remaining:total-end})) {
      end--;
      if(end>start && /[\uD800-\uDBFF]/.test(value[end-1]) && /[\uDC00-\uDFFF]/.test(value[end]))end--;
      if(end<=start)throw refuse('selected string cannot fit a bounded inspection response');
    }
    result.text=value.slice(start,end);result.nextFrom=end;result.remaining=total-end;
    return result;
  }
  result.items=[];
  for(let at=start;at<Math.min(total,start+take);at++) {
    const key=keys?keys[at]:null, child=keys?value[key]:value;
    const childKind=child===null?'null':Array.isArray(child)?'array':typeof child;
    const item={index:at,pointer:keys?pointer+'/'+escape(key):pointer,kind:childKind};
    if(key!==null)item.key=key;
    if(child!==null && typeof child==='object')item.total=Object.keys(child).length;
    else if(typeof child==='string')item.total=child.length;
    const bounded={...item,value:child};
    const withItem = row => ({...result,items:[...result.items,row],nextFrom:at+1,remaining:total-at-1});
    if(fits(withItem(bounded)))result.items.push(bounded);
    else {
      item.oversized=true;
      if(!fits(withItem(item))) {
        if(!result.items.length)throw refuse('selected key cannot fit a bounded inspection response');
        break;
      }
      result.items.push(item);
    }
    result.nextFrom=at+1;result.remaining=total-result.nextFrom;
  }
  if(!fits(result))throw refuse('selected value cannot fit a bounded inspection response');
  return result;
}

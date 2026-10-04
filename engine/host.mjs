import os from 'node:os';
import { run, WfError } from './util.mjs';

const GIB = 1024 ** 3;
export const HOST_RESERVE_BYTES = 2 * GIB;

// Reclaimable memory: free + inactive + purgeable + speculative pages on macOS; MemAvailable on Linux.
export function availableMemory() {
  try {
    if (process.platform === 'darwin') {
      const out = run('vm_stat', [], { allowFail: true }).stdout;
      const size = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384);
      const pages = (label) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
      return (pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable') + pages('Pages speculative')) * size;
    }
    if (process.platform === 'linux') {
      const meminfo = run('cat', ['/proc/meminfo'], { allowFail: true }).stdout;
      const kb = Number(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1]);
      if (kb) return kb * 1024;
    }
    return os.freemem();
  } catch {
    return null;
  }
}

export function performanceCores() {
  if (process.platform === 'darwin') {
    const out = run('sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { allowFail: true }).stdout.trim();
    if (/^\d+$/.test(out)) return Number(out);
  }
  return os.availableParallelism?.() ?? os.cpus().length;
}

export const overrideName = (kind, stepId) => `WF_${kind}_${stepId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

function override(kind, stepId, env) {
  const name = overrideName(kind, stepId);
  if (env[name] === undefined || env[name] === '') return null;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new WfError(`${name} must be an integer from 1 to 64, got "${env[name]}"`, { code: 2 });
  return n;
}

// Workers: explicit override, fixed number, or `auto` sized from measured memory and capped by performance cores.
export function chooseWorkers(step, env = process.env, probe = { availableMemory, performanceCores }) {
  const o = override('WORKERS', step.id, env);
  if (o) return { n: o, source: 'env' };
  const w = step.workers;
  if (w === undefined || w === null) return { n: 1, source: 'default' };
  if (typeof w === 'number') return { n: w, source: 'fixed' };
  const min = w.min ?? 1;
  const max = w.max ?? min;
  const per = (w.perWorkerGiB ?? 1) * GIB;
  const mem = probe.availableMemory();
  if (!mem) return { n: min, source: 'probe-failed' };
  const byMemory = Math.floor(Math.max(0, mem - HOST_RESERVE_BYTES) / per);
  const cores = probe.performanceCores() || min;
  const n = Math.max(min, Math.min(max, byMemory, cores));
  return { n, source: 'auto', availableBytes: mem, byMemory, cores };
}

export function chooseShards(step, env = process.env) {
  const o = override('SHARDS', step.id, env);
  if (o) return { n: o, source: 'env' };
  return { n: step.shards ?? 1, source: step.shards ? 'fixed' : 'default' };
}

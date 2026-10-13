// Scenario helper (not a test): plays the person who confirms a reserved decision with `wf approve` at a terminal
// (engine/approve.mjs). Usage: node approve-as-owner.mjs <project root> <attempt id> <decision id> <choice>.
// The terminal is a pair of in-memory streams marked as a TTY; the process has no agent-runtime environment (helpers.mjs
// scrubs it), exactly the shape `wf approve` accepts.
import { PassThrough } from 'node:stream';
import { approveInTerminal } from '../engine/approve.mjs';

const [root, attempt, id, choice] = process.argv.slice(2);
process.chdir(root);
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
const pending = approveInTerminal(root, id, { attempt, choice }, { input, output, env: {} });
setImmediate(() => input.write(`${choice}\n`));
await pending;

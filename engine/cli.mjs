// The command line (design section 3). Stream 1 is the only stream that wires commands: every command in COMMANDS runs
// through its handler facade (`commandHandler`), whichever stream owns it.
//
// Exit codes: 0 done, 1 a usage or configuration error, 75 a refusal (the state does not allow the action; its id is
// printed and counted).
import { COMMANDS, COMMAND_ALIASES, callerSession, commandHandler, findProject, recordRefusal } from './contract.mjs';
import { ENGINE_VERSION } from './util.mjs';

// The commands that run without a project (they find or make one).
const NO_PROJECT = new Set(['init', 'doctor', 'sync', 'secrets', 'report', 'learn']);

// `--k v`, `--k=v`, `--k` (true); a repeated flag becomes an array. Everything else is positional.
export function parseArgv(argv) {
  const _ = [];
  const flags = {};
  const set = (k, v) => {
    if (Object.hasOwn(flags, k)) flags[k] = [].concat(flags[k], v);
    else flags[k] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      _.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) set(a.slice(2), argv[++i]);
      else set(a.slice(2), true);
    } else _.push(a);
  }
  return { _, flags };
}

// Flags a command takes beyond what its one-line description names.
const MORE = {
  start: '--repos a,b: only these repos; --base <branch> or <repo>=<branch>,..: start from another base; --no-tracker <id>: work with no tracker item',
  review: '--no-wait: return once the reviewers are launched (by default it waits until each is done or failed)',
};

export function help() {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  return [
    `wf ${ENGINE_VERSION}: one flow per ticket. \`wf status\` names the next command.`,
    '',
    ...Object.entries(COMMANDS).flatMap(([name, c]) => [`  ${name.padEnd(width)}  ${c.does.replace(/^\S+\s*/, '')}`, ...(MORE[name] ? [`  ${''.padEnd(width)}    ${MORE[name]}`] : [])]),
    '',
    `Aliases: ${Object.entries(COMMAND_ALIASES).map(([a, b]) => `${a} = ${b}`).join(', ')}. Every command takes --json.`,
  ].join('\n');
}

const isWfError = (e) => e && (e.name === 'WfError' || Number.isInteger(e.code)) && typeof e.message === 'string';

export async function main(argv, { cwd = process.cwd(), env = process.env, out = process.stdout, err = process.stderr } = {}) {
  // Test doubles replace other streams' code only in a test run: production ignores WF_DOUBLES.
  if (env.WF_TEST !== '1') {
    delete env.WF_DOUBLES;
    if (env !== process.env) delete process.env.WF_DOUBLES;
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out.write(`${help()}\n`);
    return 0;
  }
  if (cmd === 'version' || cmd === '--version') {
    out.write(`${ENGINE_VERSION}\n`);
    return 0;
  }
  const args = parseArgv(rest);
  const json = args.flags.json === true;
  let root = null;
  try {
    const handler = commandHandler(cmd);
    const name = COMMAND_ALIASES[cmd] ?? cmd;
    root = (await findProject(cwd, { env }))?.root ?? null;
    const actor = await callerSession(env);
    const ctx = { cwd, root, env, actor, json };
    if (!root && !NO_PROJECT.has(name)) {
      err.write(`wf ${cmd}: no project here: no .workflow/project.yaml above ${cwd}, and no user-folder adapter whose root contains it\n  → \`wf init\` onboards the project\n`);
      return 1;
    }
    const result = (await handler(ctx, args)) ?? { text: '' };
    if (json) out.write(`${JSON.stringify(result.data ?? { text: result.text }, null, 2)}\n`);
    else if (result.text) out.write(`${result.text}\n`);
    return result.exitCode ?? 0;
  } catch (error) {
    if (error?.code === 'WF_NOT_BUILT') {
      err.write(`wf ${cmd}: ${error.message}\n`);
      return 1;
    }
    if (!isWfError(error)) throw error;
    if (error.code === 75) {
      err.write(`wf ${cmd}: refused${error.refusalId ? ` (${error.refusalId})` : ''}: ${error.message}\n${error.hint ? `  → ${error.hint}\n` : ''}`);
      if (error.refusalId) {
        try {
          await recordRefusal(root, typeof args.flags.attempt === 'string' ? args.flags.attempt : error.attempt ?? null, error.refusalId);
        } catch (e) {
          err.write(`wf: the refusal was not counted: ${e.message}\n`);
        }
      }
      if (json) out.write(`${JSON.stringify({ refused: error.refusalId ?? null, message: error.message, hint: error.hint ?? null })}\n`);
      return 75;
    }
    err.write(`wf ${cmd}: ${error.message}\n${error.hint ? `  → ${error.hint}\n` : ''}`);
    return error.code || 1;
  }
}

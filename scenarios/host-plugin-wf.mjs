// `wf` with one extra host adapter registered from outside the engine: the file named by WF_TEST_HOST_ADAPTER (a module
// whose default export is an adapter). The plug-in scenario runs the real CLI through this, so the engine is exercised
// exactly as shipped and no engine file is touched.
import { pathToFileURL } from 'node:url';
import { registerHost } from '../engine/hosts/index.mjs';
import { main } from '../engine/cli.mjs';

registerHost((await import(pathToFileURL(process.env.WF_TEST_HOST_ADAPTER).href)).default);
const code = await main(process.argv.slice(2));
process.exit(code ?? 0);

import { runCli, watchLoop } from '../src/runner.js';

await runCli('watch', (options) => watchLoop(options));

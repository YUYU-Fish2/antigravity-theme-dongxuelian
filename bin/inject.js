import { injectOnce, runCli } from '../src/runner.js';

await runCli('inject', (options) => injectOnce(options));

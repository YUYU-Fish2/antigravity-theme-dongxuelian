import { removeOnce, runCli } from '../src/runner.js';

await runCli('remove', (options) => removeOnce(options));

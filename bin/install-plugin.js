#!/usr/bin/env node
import { installPlugin } from '../src/plugin.js';
import { runCli } from '../src/runner.js';

runCli('install-plugin', (options) => installPlugin(options));

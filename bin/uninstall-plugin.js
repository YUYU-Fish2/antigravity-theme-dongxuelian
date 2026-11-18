#!/usr/bin/env node
import { uninstallPlugin } from '../src/plugin.js';
import { runCli } from '../src/runner.js';

runCli('uninstall-plugin', (options) => uninstallPlugin(options));

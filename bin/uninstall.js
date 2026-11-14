#!/usr/bin/env node
import { runCli } from '../src/runner.js';
import { uninstallTheme } from '../src/service.js';

runCli('uninstall', (options) => uninstallTheme(options));

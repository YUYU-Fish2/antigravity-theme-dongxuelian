#!/usr/bin/env node
import { runCli } from '../src/runner.js';
import { getInstallStatus } from '../src/service.js';

runCli('status', (options) => getInstallStatus(options));

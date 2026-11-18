#!/usr/bin/env node
import { patchAppAsar } from '../src/asar.js';
import { runCli } from '../src/runner.js';

runCli('patch-app', (options) => patchAppAsar(options));

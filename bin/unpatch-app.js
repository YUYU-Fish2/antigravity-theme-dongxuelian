#!/usr/bin/env node
import { unpatchAppAsar } from '../src/asar.js';
import { runCli } from '../src/runner.js';

runCli('unpatch-app', (options) => unpatchAppAsar(options));

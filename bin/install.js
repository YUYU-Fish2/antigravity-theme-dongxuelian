#!/usr/bin/env node
import { runCli } from '../src/runner.js';
import { installTheme } from '../src/service.js';

runCli('install', (options) => installTheme(options));

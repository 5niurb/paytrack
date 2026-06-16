#!/usr/bin/env node
'use strict';

// Test runner: executes every test/*.test.js file in its own process,
// continues past failures (no && short-circuit), and prints an aggregate
// summary. Exits non-zero if any suite fails.
//
// Each suite already prints its own PASS/FAIL lines and exits non-zero on
// failure; this runner just makes sure ALL suites run and reports which
// ones failed.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));

const suites = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

const failures = [];

for (const suite of suites) {
  console.log(`\n${'#'.repeat(60)}\n# ${suite}\n${'#'.repeat(60)}`);
  const result = spawnSync(process.execPath, [join(testDir, suite)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failures.push({ suite, code: result.status, signal: result.signal });
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Suites run: ${suites.length}  |  failed: ${failures.length}`);
if (failures.length > 0) {
  for (const { suite, code, signal } of failures) {
    console.log(`  FAIL: ${suite} (${signal ? `signal ${signal}` : `exit ${code}`})`);
  }
  process.exit(1);
}
console.log('All suites passed.');

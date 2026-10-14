'use strict';

// Read actual cleanup source through the scanner. Never execute the cleanup.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const testSource = fs.readFileSync(path.join(root, 'test/worktree-removal-guard.test.js'), 'utf8');
const scannerStart = testSource.indexOf('const WORKTREE_REMOVAL =');
const scannerEnd = testSource.indexOf("test('every work folder removal", scannerStart);
assert.ok(scannerStart >= 0 && scannerEnd > scannerStart, 'scanner layout changed; review this probe');
const fleetSource = fs.readFileSync(path.join(root, 'lib/fleet.js'), 'utf8');
const cleanupStart = fleetSource.indexOf('function disposeReviewSandbox(');
const cleanupEnd = fleetSource.indexOf('\nfunction ', cleanupStart + 1);
assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, 'cleanup layout changed; review this probe');
const cleanup = fleetSource.slice(cleanupStart, cleanupEnd);
const targets = [...cleanup.matchAll(/fs\.rmSync\((boundary\.\w+),\s*\{\s*recursive:\s*true/g)]
  .map((match) => match[1]);
assert.deepEqual(targets, [
  'boundary.worktreePath', 'boundary.gitDir', 'boundary.quarantine', 'boundary.sandboxRoot',
], 'group changed; review its targets before relying on the census');
const context = vm.createContext({
  fs: { readFileSync: () => cleanup }, path, __dirname: path.join(root, 'test'),
});
vm.runInContext(testSource.slice(scannerStart, scannerEnd) +
  '\nthis.sites = worktreeRemovalSites("lib/fleet.js");', context, { timeout: 1000 });
const lines = cleanup.split('\n');
let missing = 0;
for (const target of targets) {
  const line = lines.findIndex((text) => text.includes(`fs.rmSync(${target},`)) + 1;
  const detected = context.sites.some((site) => site.line === line);
  if (!detected) missing++;
  console.log(`${target}: ${detected ? 'detected' : 'missed'}`);
}
console.log(`group: ${targets.length} recursive targets; ${missing} missing from scan; source only, no folders removed`);
// Advisory mode records gaps. Acceptance mode is ready for the scanner repair.
if (process.argv.includes('--require-protection') && missing) process.exitCode = 1;

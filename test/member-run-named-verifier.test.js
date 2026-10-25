const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inferMemberRunVerifier } = require('../commands/member');

function tempProject(pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-named-verifier-'));
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  return dir;
}

test('a job that names the project test command gets that command as its check', () => {
  // Member lab 2026-10-24: "keep npm test green" ran only git diff --check,
  // the member reported fixed, and the project tests still failed.
  const dir = tempProject({ scripts: { test: 'node --test checks/*.js' } });
  try {
    assert.equal(inferMemberRunVerifier('fix scan.js.\n\nkeep npm test green.', [], dir), 'npm test');
    assert.equal(inferMemberRunVerifier('make `npm run test` pass', [], dir), 'npm run test');
    assert.equal(inferMemberRunVerifier('fix the parser', [], dir), '');
    // Review of PR 1650: a named sub-suite is not the plain test script.
    assert.equal(inferMemberRunVerifier('run npm run test:integration', [], dir), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a named npm test is ignored when the project has no test script', () => {
  const dir = tempProject({ scripts: {} });
  try {
    assert.equal(inferMemberRunVerifier('keep npm test green', [], dir), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the subagent shell reads the job text, not the member name, for its check', () => {
  const { buildMemberSubagentShell } = require('../commands/member');
  if (typeof buildMemberSubagentShell !== 'function') return;
  const dir = tempProject({ scripts: { test: 'node --test' } });
  try {
    const shell = buildMemberSubagentShell('executor', 'Builder', 'claude', 'keep npm test green', dir);
    assert.equal(shell.verify, 'npm test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    assert.equal(inferMemberRunVerifier('run npm run test.integration', [], dir), '');
    assert.equal(inferMemberRunVerifier('run npm test.', [], dir), 'npm test');
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

test('a named test file or "the failing tests" become the check in a node --test project', () => {
  // Member lab: seven of ten jobs got only a whitespace check, so a second AI had
  // to review every one. Task 15 says another test file fails on purpose, so a
  // named file is checked alone rather than the whole suite.
  const dir = tempProject({ scripts: { test: 'node --test checks/*.js' } });
  try {
    fs.mkdirSync(path.join(dir, 'checks'));
    fs.writeFileSync(path.join(dir, 'checks', 'order.js'), '');
    assert.equal(inferMemberRunVerifier('fix the failing order total tests in checks/order.js.\nlegacy.js is out of scope.', [], dir), 'node --test checks/order.js');
    assert.equal(inferMemberRunVerifier('fix the failing shipping tests.\nyou may only modify shipping.js.', [], dir), 'npm test');
    assert.equal(inferMemberRunVerifier('fix the failing test.\n\ndo not create a commit.', [], dir), 'npm test');
    // Feature jobs that never mention tests keep the reviewer.
    assert.equal(inferMemberRunVerifier('add a --json flag to the toy cli.', [], dir), '');
    // A named file that does not exist is not a check.
    assert.equal(inferMemberRunVerifier('fix checks/missing.js', [], dir), '');
    // Review of PR 1656.
    fs.writeFileSync(path.join(dir, 'checks', 'legacy.js'), '');
    assert.equal(inferMemberRunVerifier('checks/legacy.js is out of scope; fix the failing shipping tests', [], dir), 'npm test');
    assert.equal(inferMemberRunVerifier('Update docs; do not run the failing tests', [], dir), '');
    fs.mkdirSync(path.join(path.dirname(dir), 'x'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(dir), 'x', 'order.test.js'), '');
    assert.equal(inferMemberRunVerifier('Fix shipping.js using ../x/order.test.js', [], dir), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('"the failing tests" in a project with no test script infers nothing', () => {
  const dir = tempProject({ scripts: {} });
  try {
    assert.equal(inferMemberRunVerifier('fix the failing tests', [], dir), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a test script that only mentions node --test is not treated as node --test', () => {
  const dir = tempProject({ scripts: { test: 'echo node --test && jest' } });
  try {
    fs.mkdirSync(path.join(dir, 'checks'));
    fs.writeFileSync(path.join(dir, 'checks', 'order.js'), '');
    assert.equal(inferMemberRunVerifier('Fix the failing order tests in checks/order.js', [], dir), 'npm test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

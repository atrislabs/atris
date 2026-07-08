'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractKnownCommands, readKnownCommandsFromDir, diffCommandRegression } = require('../scripts/check-command-regression');

test('extractKnownCommands parses the multi-line knownCommands array', () => {
  const src = `
const knownCommands = ['init', 'log',
                       'deck', 'slop', 'security-review'];
if (!knownCommands.includes(command)) {}
`;
  assert.deepEqual(extractKnownCommands(src), ['init', 'log', 'deck', 'slop', 'security-review']);
});

test('readKnownCommandsFromDir reads the real command surface and includes the safety surface', () => {
  const cmds = readKnownCommandsFromDir(path.join(__dirname, '..'));
  assert.ok(cmds.length > 50);
  for (const c of ['deck', 'card', 'reel', 'slop', 'site', 'theme', 'signup', 'clarity', 'moves', 'unknowns', 'security-review', 'close']) {
    assert.ok(cmds.includes(c), `knownCommands should include ${c}`);
  }
});

test('readKnownCommandsFromDir falls back to the legacy bin/atris.js layout', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atris-layout-'));
  try {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'atris.js'), "const knownCommands = ['init', 'deck'];\n");
    assert.deepEqual(readKnownCommandsFromDir(dir), ['init', 'deck']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diffCommandRegression flags a command dropped since the published version', () => {
  const { ok, removed } = diffCommandRegression(['init', 'deck', 'card', 'slop'], ['init', 'deck']);
  assert.equal(ok, false);
  assert.deepEqual(removed.sort(), ['card', 'slop']);
});

test('diffCommandRegression passes when local is a superset', () => {
  const { ok } = diffCommandRegression(['init', 'deck'], ['init', 'deck', 'reel']);
  assert.equal(ok, true);
});

test('diffCommandRegression honors an explicit allow-list', () => {
  const { ok } = diffCommandRegression(['init', 'oldcmd'], ['init'], { allow: ['oldcmd'] });
  assert.equal(ok, true);
});

test('the publish workflow runs the regression gate before publishing', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.match(wf, /check-command-regression\.js/);
  assert.ok(wf.indexOf('check-command-regression.js') < wf.indexOf('npm run publish:release'), 'gate must run before publish');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractKnownCommands, diffCommandRegression } = require('../scripts/check-command-regression');

test('extractKnownCommands parses the multi-line knownCommands array', () => {
  const src = `
const foo = 1;
const knownCommands = ['init', 'log',
                       'deck', 'slop', 'card'];
if (!knownCommands.includes(command)) {}
`;
  assert.deepEqual(extractKnownCommands(src), ['init', 'log', 'deck', 'slop', 'card']);
});

test('extractKnownCommands reads the real bin/atris.js surface', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'atris.js'), 'utf8');
  const cmds = extractKnownCommands(src);
  assert.ok(cmds.length > 50, `expected a real command surface, got ${cmds.length}`);
  // The recovered creative suite must be present so the gate guards it.
  for (const c of ['deck', 'card', 'reel', 'slop', 'site', 'theme']) {
    assert.ok(cmds.includes(c), `knownCommands should include ${c}`);
  }
});

test('diffCommandRegression flags a command dropped since the published version', () => {
  const published = ['init', 'deck', 'card', 'reel', 'slop'];
  const local = ['init', 'deck']; // dropped card/reel/slop — the 3.25.0 failure
  const { ok, removed } = diffCommandRegression(published, local);
  assert.equal(ok, false);
  assert.deepEqual(removed.sort(), ['card', 'reel', 'slop']);
});

test('diffCommandRegression passes when local is a superset (added commands ok)', () => {
  const { ok, removed } = diffCommandRegression(['init', 'deck'], ['init', 'deck', 'reel']);
  assert.equal(ok, true);
  assert.deepEqual(removed, []);
});

test('diffCommandRegression honors an explicit allow-list for intentional removals', () => {
  const { ok, removed } = diffCommandRegression(['init', 'deck', 'oldcmd'], ['init', 'deck'], { allow: ['oldcmd'] });
  assert.equal(ok, true);
  assert.deepEqual(removed, []);
});

test('the publish workflow runs the regression gate before publishing', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.match(wf, /check-command-regression\.js/);
  const gateIdx = wf.indexOf('check-command-regression.js');
  const publishIdx = wf.indexOf('npm run publish:release');
  assert.ok(gateIdx !== -1 && publishIdx !== -1 && gateIdx < publishIdx, 'gate must run before publish');
});

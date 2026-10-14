'use strict';

// Regression: the README's "Put members to work" section must match how
// members work today. Every `atris member <verb>` it teaches has to be a real
// subcommand in the live help, and it may not warn about a release that has
// already shipped.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const VERSION = require(path.join(ROOT, 'package.json')).version;

function membersSection() {
  const start = README.indexOf('### Put members to work');
  assert.ok(start >= 0, 'expected a "### Put members to work" heading');
  const rest = README.slice(README.indexOf('\n', start) + 1);
  const end = rest.search(/^#{2,3} /m);
  return end >= 0 ? rest.slice(0, end) : rest;
}

function memberHelp() {
  return execFileSync(process.execPath, [path.join(ROOT, 'bin', 'atris.js'), 'member', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

test('section teaches the three words with examples', () => {
  const section = membersSection();
  assert.match(section, /atris member run "/, 'expected a run example');
  assert.match(section, /atris member wake \d/, 'expected wake with a number');
  assert.match(section, /atris member wake [a-z]+ [a-z]+/, 'expected wake with names');
  assert.match(section, /atris member sleep --all/, 'expected a sleep example');
});

test('section shows how to see results and put finished copies away', () => {
  const section = membersSection();
  assert.match(section, /atris member result [a-z]/, 'expected a result example');
  assert.match(section, /atris member tidy/, 'expected a tidy example');
});

test('every member verb in the section is a real subcommand', () => {
  const section = membersSection();
  const help = memberHelp();
  const verbs = new Set([...section.matchAll(/atris member ([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  assert.ok(verbs.size > 0, 'expected member commands in the section');
  for (const verb of verbs) {
    assert.match(help, new RegExp(`^\\s+${verb}\\b`, 'm'), `\`atris member ${verb}\` is not in member help`);
  }
});

test('section does not warn about a release that already shipped', () => {
  const section = membersSection();
  for (const m of section.matchAll(/release after (\d+\.\d+\.\d+)/g)) {
    assert.ok(compareVersions(VERSION, m[1]) <= 0, `README still gates on ${m[1]} but package is ${VERSION}`);
  }
});

test('section has no long dashes', () => {
  assert.doesNotMatch(membersSection(), /—/);
});

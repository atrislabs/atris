'use strict';

// Regression: the README must explain how member work gets checked and lands,
// and every claim it makes must match the code that enforces it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const AUTOLAND = fs.readFileSync(path.join(ROOT, 'lib', 'member-autoland.js'), 'utf8');

function landingSection() {
  const start = README.indexOf('### How member work gets checked and lands');
  assert.ok(start >= 0, 'expected a "How member work gets checked and lands" heading');
  const rest = README.slice(README.indexOf('\n', start) + 1);
  const next = rest.search(/^#{2,3} /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('landing section sits inside the members section', () => {
  const members = README.indexOf('### Put members to work');
  const landing = README.indexOf('### How member work gets checked and lands');
  const chat = README.indexOf('## Chat With Atris 2');
  assert.ok(members >= 0 && landing > members && landing < chat, 'landing section must follow Put members to work');
});

test('README says a check must pass and a different engine reviews', () => {
  const section = landingSection();
  assert.match(section, /check/i);
  assert.match(section, /second engine reviews/);
  assert.match(section, /never the engine that did the work/);
  assert.match(AUTOLAND, /the check did not pass/);
  assert.match(AUTOLAND, /reviewed by the same engine that did the work/);
});

test('README says self-landing is switched on once and GitHub auto-merge does the merge', () => {
  const section = landingSection();
  assert.match(section, /atris autoland on/);
  assert.match(section, /GitHub auto-merge/);
  assert.match(section, /CI passes/);
  assert.match(AUTOLAND, /self-landing is not switched on/);
  assert.match(AUTOLAND, /this never merges, rebases, or polls itself/);
  const autoland = fs.readFileSync(path.join(ROOT, 'commands', 'autoland.js'), 'utf8');
  assert.match(autoland, /sub === 'on'/, 'atris autoland on must be a real subcommand');
});

test('README names the holds the code enforces', () => {
  const section = landingSection();
  assert.match(section, /unsaved changes/);
  assert.match(section, /clash with the main branch/);
  assert.match(section, /protected area/);
  assert.match(AUTOLAND, /held\('unsaved'/);
  assert.match(AUTOLAND, /clashes with the main branch/);
  assert.match(AUTOLAND, /sits in a protected area/);
});

test('README says three failures in a row wait for a person', () => {
  assert.match(landingSection(), /fails three times in a row stops and waits for a person/);
  const member = fs.readFileSync(path.join(ROOT, 'commands', 'member.js'), 'utf8');
  assert.match(member, /failed three times in a row and now waits for a person/);
});

test('landing section has no long dashes', () => {
  assert.ok(!landingSection().includes('—'), 'no em dashes in the landing section');
});

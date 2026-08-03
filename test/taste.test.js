'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { addTaste, listTaste, matchTaste } = require('../lib/taste-lessons');
const { buildFleetPrompt } = require('../lib/fleet');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'atris.js');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-taste-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return root;
}

function runTaste(root, args) {
  return spawnSync(process.execPath, [CLI, 'taste', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', CI: 'true' },
  });
}

test('the taste CLI adds and lists a verdict round trip', () => {
  const root = makeRoot();
  try {
    const added = runTaste(root, [
      'keep',
      'The oversized serif headline',
      '--why',
      'It feels confident without shouting.',
      '--scope',
      'design',
      '--example',
      'design/hero.png',
    ]);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /saved the operator's keep verdict/);

    const listed = runTaste(root, ['list', '--scope', 'design']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /the operator's verdict is keep for "The oversized serif headline"\./);
    assert.match(listed.stdout, /the reason is: It feels confident without shouting\./);
    assert.match(listed.stdout, /the example is design\/hero\.png\./);

    const stored = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'taste.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored), ['the-oversized-serif-headline']);
    assert.match(stored['the-oversized-serif-headline'].added, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('matchTaste ranks exact scope and keyword relevance and excludes another scope', () => {
  const root = makeRoot();
  try {
    const exact = addTaste({
      verdict: 'keep',
      subject: 'Warm serif landing page typography',
      why: 'It feels human and assured.',
      scope: 'design',
      added: '2026-08-03',
      root,
    });
    const broad = addTaste({
      verdict: 'more',
      subject: 'Warm typography across every surface',
      why: 'The product should feel authored.',
      scope: 'any',
      added: '2026-08-03',
      root,
    });
    addTaste({
      verdict: 'kill',
      subject: 'Warm serif landing page copy',
      why: 'The words became sentimental.',
      scope: 'writing',
      added: '2026-08-03',
      root,
    });

    const matches = matchTaste({
      briefText: 'Refine the warm serif typography on the landing page.',
      scope: 'design',
      root,
    });
    assert.deepEqual(matches.map((entry) => entry.slug), [exact.slug, broad.slug]);
    assert.match(matches[0].why_matched, /warm/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('matchTaste returns at most five lessons', () => {
  const root = makeRoot();
  try {
    for (let index = 1; index <= 7; index += 1) {
      addTaste({
        verdict: 'more',
        subject: `Dashboard module ${index}`,
        why: 'The dashboard should feel more deliberate.',
        scope: 'code',
        added: '2026-08-03',
        root,
      });
    }
    const matches = matchTaste({
      briefText: 'Build the dashboard module deliberately.',
      scope: 'code',
      root,
    });
    assert.equal(matches.length, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fleet prompt composition includes matching taste and omits the section when none match', () => {
  const root = makeRoot();
  const emptyRoot = makeRoot();
  try {
    addTaste({
      verdict: 'keep',
      subject: 'Dashboard typography',
      why: 'The strong hierarchy makes scanning effortless.',
      scope: 'design',
      added: '2026-08-03',
      root,
    });
    const task = {
      display_id: 'CLI-1',
      scope: 'design',
      title: 'Refine the dashboard typography. Done: the hierarchy is clear. Check: node --test test/taste.test.js.',
    };
    const prompt = buildFleetPrompt(task, { worktreePath: root });
    assert.match(prompt, /## the owner's taste\n- The operator's verdict is keep for "Dashboard typography"\./);
    assert.doesNotMatch(buildFleetPrompt(task, { worktreePath: emptyRoot }), /## the owner's taste/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('malformed taste.json degrades to empty without crashing', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'atris', 'taste.json'), '{not json\n', 'utf8');
    assert.deepEqual(listTaste({ root }), []);
    assert.deepEqual(matchTaste({ briefText: 'dashboard typography', scope: 'design', root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const voice = require('../scripts/det/voice');

test('a plain reply passes', () => {
  const reply = 'The build is green again.\n\nRun `atris task reviews` when you are ready.';
  assert.strictEqual(voice.run('scan', reply).text, 'PASS');
});

test('codes, ids, and system nouns fail with named findings', () => {
  const reply = 'Landed CLI-1234 on the mission spine at a6f5ba02 — the verifier is happy.';
  const result = voice.run('scan', reply);
  assert.match(result.text, /^FAIL \(\d+\)/);
  assert.match(result.text, /task-code: "CLI-1234"/);
  assert.match(result.text, /commit-hash: "a6f5ba02"/);
  assert.match(result.text, /system-noun: "verifier"/);
  assert.match(result.text, /em-dash/);
});

test('code fences and inline code stay exempt', () => {
  const reply = 'Run this:\n\n```\ngit rebase CLI-99 — worktree a6f5ba02\n```\n\nThen `atris mission tick CLI-99`.';
  assert.strictEqual(voice.run('scan', reply).text, 'PASS');
});

test('more than three bullets is a bullet stack', () => {
  const reply = '- one\n- two\n- three\n- four\n';
  assert.match(voice.run('scan', reply).text, /bullet-stack: "4 bullets"/);
});

test('json mode returns a machine-readable verdict', () => {
  const verdict = JSON.parse(voice.run('json', 'All done, nothing waits on you.').text);
  assert.deepStrictEqual(verdict, { pass: true, findings: [] });
  const bad = JSON.parse(voice.run('json', 'tick the worktree').text);
  assert.strictEqual(bad.pass, false);
  assert.ok(bad.findings.length >= 1);
});

test('duplicate findings collapse to one', () => {
  const findings = voice.scanReply('worktree worktree worktree');
  assert.strictEqual(findings.length, 1);
});

test('unknown mode errors instead of guessing', () => {
  assert.ok(voice.run('nope', 'text').error);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applySidecarRel } = require('../lib/apply-gate');

test('applySidecarRel builds the briefs path for a kind and id', () => {
  assert.equal(
    applySidecarRel('youtube', 'hint01'),
    'atris/wiki/briefs/youtube-hint01.apply.md',
  );
  assert.equal(
    applySidecarRel('x-search', 'agent-teams'),
    'atris/wiki/briefs/x-search-agent-teams.apply.md',
  );
});

test('applySidecarRel passes compound ids through verbatim', () => {
  assert.equal(
    applySidecarRel('youtube', 'abc123-s2'),
    'atris/wiki/briefs/youtube-abc123-s2.apply.md',
  );
  assert.equal(
    applySidecarRel('digest', '2026-01-15'),
    'atris/wiki/briefs/digest-2026-01-15.apply.md',
  );
});

test('applySidecarRel does not sanitize separators or spaces in id', () => {
  assert.equal(
    applySidecarRel('notes', 'a/b c'),
    'atris/wiki/briefs/notes-a/b c.apply.md',
  );
});

test('applySidecarRel returns a string for empty or missing args', () => {
  assert.equal(applySidecarRel('', ''), 'atris/wiki/briefs/-.apply.md');
  assert.equal(
    applySidecarRel('learn', ''),
    'atris/wiki/briefs/learn-.apply.md',
  );
  assert.equal(
    applySidecarRel(),
    'atris/wiki/briefs/undefined-undefined.apply.md',
  );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { declaredCandidatePathValues } = require('../lib/auto-accept-certified');

test('declaredCandidatePathValues collects paths across metadata, review, and events', () => {
  const task = {
    metadata: {
      files: ['lib/a.js', 'lib/b.js'],
      diff_stats: { paths: 'test/a.test.js\nlib/c.js' },
      result_trace: { changedFiles: ['lib/a.js'] },
    },
    review: {
      result: { touched_files: ['lib/d.js'] },
      result_trace: { artifact_paths: 'docs/x.md, docs/y.md' },
    },
    events: [
      { payload: { result_trace: { files: ['lib/e.js'] } } },
      { payload: { result_trace: { paths: 'lib/e.js' } } },
      { payload: {} },
      null,
    ],
  };
  assert.deepEqual(declaredCandidatePathValues(task), [
    'lib/a.js',
    'lib/b.js',
    'test/a.test.js',
    'lib/c.js',
    'lib/d.js',
    'docs/x.md',
    'docs/y.md',
    'lib/e.js',
  ]);
});

test('declaredCandidatePathValues reads every declared key variant on each source', () => {
  const task = {
    metadata: {
      paths: ['one.js'],
      touched_files: ['two.js'],
      touchedFiles: ['three.js'],
      changed_files: ['four.js'],
      changedFiles: ['five.js'],
      modified_files: ['six.js'],
      modifiedFiles: ['seven.js'],
      artifacts: ['eight.js'],
      artifact_paths: ['nine.js'],
      artifactPaths: ['ten.js'],
      diffStats: { files: ['eleven.js'] },
      git_diff_stats: { files: ['twelve.js'] },
      gitDiffStats: { files: ['thirteen.js'] },
      change_stats: { files: ['fourteen.js'] },
      changeStats: { files: ['fifteen.js'] },
    },
  };
  assert.deepEqual(declaredCandidatePathValues(task), [
    'one.js',
    'two.js',
    'three.js',
    'four.js',
    'five.js',
    'six.js',
    'seven.js',
    'eight.js',
    'nine.js',
    'ten.js',
    'eleven.js',
    'twelve.js',
    'thirteen.js',
    'fourteen.js',
    'fifteen.js',
  ]);
});

test('declaredCandidatePathValues handles strings, objects, and nested arrays', () => {
  const task = {
    metadata: {
      files: [
        '  spaced.js  ,other.js',
        ['nested/one.js', { path: 'obj/path.js' }, { file: 'obj/file.js' }, { filename: 'obj/fname.js' }],
        { path: 7, file: 'fallback/file.js' },
        { name: 'not-a-path' },
        42,
        '',
      ],
      artifacts: 'line1.js\nline2.js\n\n',
    },
  };
  assert.deepEqual(declaredCandidatePathValues(task), [
    'spaced.js',
    'other.js',
    'nested/one.js',
    'obj/path.js',
    'obj/file.js',
    'obj/fname.js',
    'fallback/file.js',
    'line1.js',
    'line2.js',
  ]);
});

test('declaredCandidatePathValues returns an empty list when nothing is declared', () => {
  assert.deepEqual(declaredCandidatePathValues(null), []);
  assert.deepEqual(declaredCandidatePathValues(undefined), []);
  assert.deepEqual(declaredCandidatePathValues('not-a-task'), []);
  assert.deepEqual(declaredCandidatePathValues({}), []);
  assert.deepEqual(declaredCandidatePathValues({ metadata: 'nope', review: 5, events: 'nope' }), []);
  assert.deepEqual(declaredCandidatePathValues({
    metadata: { files: [], result_trace: 'not-an-object' },
    review: { result: { files: null } },
    events: [{ payload: { result_trace: 'not-an-object' } }, 'no-payload'],
  }), []);
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { checkMapRefs } = require('../../lib/map-refs');
const root = path.resolve(__dirname, '../..');
const notes = fs.readFileSync(path.join(root, 'atris/refs/MAP-NOTES.md'), 'utf8');
const result = checkMapRefs(root, notes);
for (const [file, line, text] of [
  ['lib/member-tidy.js', 160, 'const lock = missingFolderLock'],
  ['lib/member-tidy.js', 195, 'const activity = inspectGitActivity'],
  ['lib/member-tidy.js', 199, 'if (!activity.safe || missing)'],
  ['lib/member-tidy.js', 218, 'recordWorktreeRemoval(repoRoot'],
  ['lib/git-activity.js', 7, 'function collectGitLocks'],
]) {
  assert.ok(fs.readFileSync(path.join(root, file), 'utf8').split('\n')[line - 1].trim().startsWith(text));
  assert.ok(result.refs.some(ref => ref.path === file && ref.start === line && ref.status === 'ok'));
  console.log(`${file}:${line}: exact source and map match`);
}

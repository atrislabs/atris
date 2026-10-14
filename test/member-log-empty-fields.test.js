const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendMemberGoalLog, appendProjectLog } = require('../commands/member');

const fields = {
  stale_goals: [],
  blank: '   ',
  newline_only: '\n',
  missing: undefined,
  nothing: null,
  empty: '',
  goals: ['a', 'b'],
  count: 0,
  ok: false,
  note: 'line one\nline two',
};

function assertRows(text) {
  assert.doesNotMatch(text, /- \w+:\s*$/m, 'no row should end with an empty value');
  for (const key of ['stale_goals', 'blank', 'newline_only', 'missing', 'nothing', 'empty']) {
    assert.ok(!text.includes(`- ${key}:`), `${key} should be dropped`);
  }
  assert.match(text, /^- goals: a,b$/m);
  assert.match(text, /^- count: 0$/m);
  assert.match(text, /^- ok: false$/m);
  assert.match(text, /^- note: line one line two$/m);
}

test('appendMemberGoalLog drops fields that render empty', () => {
  const memberDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-log-'));
  const logPath = appendMemberGoalLog(memberDir, 'tester', 'Member wake decision', fields);
  const text = fs.readFileSync(logPath, 'utf8');
  assert.match(text, /^- team: tester$/m);
  assertRows(text);
});

test('appendProjectLog drops fields that render empty', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-project-log-'));
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    const logPath = appendProjectLog('Project log check', fields);
    assertRows(fs.readFileSync(logPath, 'utf8'));
  } finally {
    process.chdir(prev);
  }
});

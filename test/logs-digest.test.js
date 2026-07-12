const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { logsDigest } = require('../commands/log');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-logs-digest-test-'));
}

function captureOutput(fn) {
  const originalLog = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  try {
    fn();
    return output.join('\n');
  } finally {
    console.log = originalLog;
  }
}

test('logs digest prints the workspace journal and existing team logs', () => {
  const dir = makeTempDir();
  try {
    const date = '2026-07-12';
    const workspaceLog = path.join(dir, 'atris', 'logs', '2026', `${date}.md`);
    const teamLog = path.join(dir, 'atris', 'team', 'builder', 'logs', `${date}.md`);
    fs.mkdirSync(path.dirname(workspaceLog), { recursive: true });
    fs.mkdirSync(path.dirname(teamLog), { recursive: true });
    fs.writeFileSync(workspaceLog, '# Workspace\nshipped the digest\n', 'utf8');
    fs.writeFileSync(teamLog, '# Builder\nverified the route\n', 'utf8');

    const output = captureOutput(() => logsDigest(['today', '--date', date], { cwd: dir }));
    assert.match(output, /=== Workspace journal ===/);
    assert.match(output, /shipped the digest/);
    assert.match(output, /=== Team: builder ===/);
    assert.match(output, /verified the route/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logs digest prints the empty message for a missing day', () => {
  const dir = makeTempDir();
  try {
    const output = captureOutput(() => logsDigest(['--date', '2026-07-11'], { cwd: dir }));
    assert.equal(output, 'No logs for 2026-07-11 yet.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logs digest JSON caps team logs and marks truncation', () => {
  const dir = makeTempDir();
  try {
    const date = '2026-07-12';
    const teamLog = path.join(dir, 'atris', 'team', 'builder', 'logs', `${date}.md`);
    fs.mkdirSync(path.dirname(teamLog), { recursive: true });
    fs.writeFileSync(teamLog, Array.from({ length: 81 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8');

    const output = captureOutput(() => logsDigest(['--date', date, '--json'], { cwd: dir }));
    const payload = JSON.parse(output);
    assert.equal(payload.date, date);
    assert.equal(payload.sections[0].lines.length, 81);
    assert.equal(payload.sections[0].lines[80], 'truncated after 80 lines');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('top-level logs route prints the digest instead of navigator output', () => {
  const dir = makeTempDir();
  try {
    const date = '2026-07-12';
    const workspaceLog = path.join(dir, 'atris', 'logs', '2026', `${date}.md`);
    fs.mkdirSync(path.dirname(workspaceLog), { recursive: true });
    fs.writeFileSync(workspaceLog, 'route reached\n', 'utf8');

    const result = spawnSync(process.execPath, [cliPath, 'logs', 'today', '--date', date], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /route reached/);
    assert.doesNotMatch(result.stdout, /navigator|PLAN PROMPT|Unknown command/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

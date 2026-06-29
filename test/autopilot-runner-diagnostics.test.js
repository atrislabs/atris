const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { askModel, proposeCandidateHorizons } = require('../commands/autopilot');

const RUNNER_ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withRunnerEnv(values, fn) {
  const prev = new Map(RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined) process.env[key] = value;
  }
  const restore = () => {
    for (const key of RUNNER_ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function makeWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runner-diagnostics-'));
  const atrisDir = path.join(cwd, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n');

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const logsDir = path.join(atrisDir, 'logs', String(yyyy));
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, `${yyyy}-${mm}-${dd}.md`), [
    `# Log - ${yyyy}-${mm}-${dd}`,
    '',
    '## Notes',
    '',
    '## Inbox',
    '',
  ].join('\n'));

  return cwd;
}

function cleanup(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

test('proposeCandidateHorizons preserves non-zero runner stdout and stderr', async () => {
  const cwd = makeWorkspace();
  try {
    await withRunnerEnv({
      ATRIS_RUNNER_BIN: 'sh',
      ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -c "echo horizon-out; echo horizon-err >&2; exit 7"',
    }, async () => {
      await assert.rejects(
        () => proposeCandidateHorizons(cwd),
        /horizon-proposal runner failed:[\s\S]*stdout:\nhorizon-out[\s\S]*stderr:\nhorizon-err/
      );
    });
  } finally {
    cleanup(cwd);
  }
});

test('askModel preserves non-zero runner stdout and stderr in conservative reason', () => {
  const cwd = makeWorkspace();
  try {
    withRunnerEnv({
      ATRIS_RUNNER_BIN: 'sh',
      ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -c "echo stale-out; echo stale-err >&2; exit 9"',
    }, () => {
      const result = askModel({ title: 'Audit stale runner diagnostics' }, cwd);
      assert.equal(result.fresh, false);
      assert.match(result.reasoning, /stdout:\nstale-out/);
      assert.match(result.reasoning, /stderr:\nstale-err/);
    });
  } finally {
    cleanup(cwd);
  }
});

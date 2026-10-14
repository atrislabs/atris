'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Test Member',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function writeGoal(root, name, goal) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify({
    schema: 'atris.member_goals.v1',
    member: name,
    goals: [
      {
        id: `goal-${name}`,
        status: 'active',
        experiments: [],
        ...goal,
      },
    ],
  }, null, 2));
}

test('member go --dry-run never uses a member name as the objective', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-go-'));
  try {
    const slugs = ['executor', 'navigator', 'improver'];
    for (const slug of slugs) writeMember(root, slug);

    const result = runCli(['member', 'go', '--dry-run', '--json'], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.prompt, 'member go should still produce an objective');

    const memberNames = new Set([...slugs, 'auto-improver']);
    assert.ok(
      !memberNames.has(payload.prompt),
      `objective should be a job, not a member name: ${payload.prompt}`
    );
    if (payload.subagent_shell && payload.subagent_shell.objective) {
      assert.ok(
        !memberNames.has(payload.subagent_shell.objective),
        `subagent objective should be a job, not a member name: ${payload.subagent_shell.objective}`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member go --dry-run uses the member real next job when a goal exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-go-'));
  try {
    for (const slug of ['executor', 'navigator', 'improver']) writeMember(root, slug);
    writeGoal(root, 'navigator', {
      title: 'Map the export pipeline',
      next_push: 'Trace the export call chain',
    });

    const result = runCli(['member', 'go', '--dry-run', '--json'], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.member, 'navigator');
    assert.equal(payload.prompt, 'Trace the export call chain');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

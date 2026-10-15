'use strict';

// A one-on-one is a real conversation with the member, in its own voice, and
// it ends with the member's next step saved as its active goal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

// A stand-in for the chat program: it saves the opening brief it was handed
// and, when told to, plays the member recording its own next step.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const { spawnSync } = require('child_process');
fs.writeFileSync(process.env.FAKE_PROMPT_OUT, process.argv[2] || '');
if (process.env.FAKE_MEMBER_NEXT) {
  const r = spawnSync(process.execPath, [process.env.FAKE_ATRIS_CLI, 'member', 'goal', 'executor', process.env.FAKE_MEMBER_NEXT], { stdio: 'ignore' });
  process.exit(r.status || 0);
}
`;

function withWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-1on1-'));
  const dir = path.join(root, 'atris', 'team', 'executor');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: executor\nrole: Builder\n---\n# executor\n');
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Soul\n\nShipping is the only proof that matters.\n');
  fs.writeFileSync(path.join(dir, 'MISSION.md'), '# Executor Mission\n\n## North Star\n\nSmall verified diffs.\n');
  fs.writeFileSync(path.join(dir, 'logs', '2026-10-14.md'), '## 10:00 · shipped the login fix\n');
  const bin = path.join(root, 'fake-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const promptOut = path.join(root, 'prompt.txt');
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...scrubAgentEnv(),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_PROMPT_OUT: promptOut,
      FAKE_ATRIS_CLI: cliPath,
      ATRIS_NO_UPDATE_CHECK: '1',
      ...extraEnv,
    },
  });
  const goals = () => {
    const file = path.join(dir, 'goals.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).goals : [];
  };
  const prompt = () => fs.readFileSync(promptOut, 'utf8');
  try {
    fn({ root, run, goals, prompt });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the member speaks for itself and records the next step it agreed', () => {
  withWorkspace(({ run, goals, prompt }) => {
    const res = run(['member', '1on1', 'executor', '--yes'], { FAKE_MEMBER_NEXT: 'Ship the login retry test' });
    assert.equal(res.status, 0, res.stderr + res.stdout);

    const brief = prompt();
    assert.match(brief, /You ARE the team member "executor"/);
    assert.match(brief, /first person as executor/);
    assert.match(brief, /atris\/team\/executor\/SOUL\.md/);
    assert.match(brief, /atris\/team\/executor\/MISSION\.md/);
    assert.match(brief, /atris member goal executor "<the next step>"/);
    assert.doesNotMatch(brief, /interview the human ABOUT it/);

    assert.match(res.stdout, /1-on-1 with executor/);
    assert.match(res.stdout, /executor's next step: Ship the login retry test/);
    const active = goals().filter((g) => g.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].title, 'Ship the login retry test');
  });
});

test('a talk that ends without a step takes the next step from --next', () => {
  withWorkspace(({ run, goals }) => {
    const res = run(['member', '1on1', 'executor', '--yes', '--next', 'Write the retry test first']);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /executor's next step: Write the retry test first/);
    assert.equal(goals().find((g) => g.status === 'active').title, 'Write the retry test first');
  });
});

test('re-agreeing the same goal still counts as the next step', () => {
  withWorkspace(({ run }) => {
    assert.equal(run(['member', 'goal', 'executor', 'Keep diffs small']).status, 0);
    const res = run(['member', '1on1', 'executor', '--yes'], { FAKE_MEMBER_NEXT: 'Keep diffs small' });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /executor's next step: Keep diffs small/);
  });
});

test('a talk with no next step says so and fails instead of ending silently', () => {
  withWorkspace(({ run, goals }) => {
    assert.equal(run(['member', 'goal', 'executor', 'An older goal']).status, 0);
    const res = run(['member', '1on1', 'executor', '--yes']);
    assert.equal(res.status, 1, res.stderr + res.stdout);
    assert.match(res.stdout, /ended without a next step for executor/);
    assert.match(res.stdout, /atris member goal executor "\.\.\."/);
    assert.equal(goals().find((g) => g.status === 'active').title, 'An older goal');
  });
});

test('atris interview <member> keeps the review about the member', () => {
  withWorkspace(({ run, prompt }) => {
    const res = run(['interview', 'executor', '--yes']);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(prompt(), /MEMBER RE-INTERVIEW/);
  });
});

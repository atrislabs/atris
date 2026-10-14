'use strict';

// The member feed shows only real work: each row says what changed and how
// it was checked. Wake notices, placeholder goals, empty log headings, and raw
// commands never reach the reader.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-feed-'));
}

function writeMember(root, name, logText) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Builder',
    `description: Serve the team as ${name}.`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  if (logText) fs.writeFileSync(path.join(dir, 'logs', '2026-10-13.md'), logText, 'utf8');
}

const FILLER_LOG = [
  '## 09:00 · Member wake decision',
  '- team: builder',
  '- decision: ask',
  '- next: atris member tick builder --goal "Serve the team as builder."',
  '## 09:05 · Member goal-from-mission blocked',
  '- team: builder',
  '- reason: mission_missing_or_placeholder',
  '## 09:10 · Mission started',
  '- mission: Serve the team as builder.',
  '## 09:15 · scoreboard',
  '## 09:20 · Mission run tick 1',
  '- member: builder',
  '- mission: Serve the team as builder.',
  '- verifier: not_run',
  '- summary: Serve the team as builder.',
  '## 09:25 · Mission run tick 2',
  '- member: builder',
  '- summary: atris member tick builder --goal "do the thing"',
  '## 09:30 · Mission run tick 3',
  '- summary: No changes made',
  '- verifier: not_run',
  '## 09:35 · Mission run tick 4',
  '- summary: Nothing changed this tick because the page was already fixed.',
  '## 09:40 · Mission run tick 5',
  '- summary: no-text',
  '## 09:45 · Mission run tick 6',
  '- summary: Made no changes; waiting on review.',
  '',
].join('\n');

test('member feed prints one line when only filler exists', () => {
  const root = makeProject();
  try {
    writeMember(root, 'builder', FILLER_LOG);
    const res = runCli(['member', 'feed'], root);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), 'no real work yet');

    const json = runCli(['member', 'feed', '--json'], root);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    assert.deepEqual(JSON.parse(json.stdout).items, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member feed keeps real changes and says how each was checked', () => {
  const root = makeProject();
  try {
    writeMember(root, 'builder', FILLER_LOG + [
      '## 10:00 · Mission run tick 3',
      '- member: builder',
      '- mission: Speed up the search page',
      '- verifier: passed',
      '- summary: Cached search results so the page loads in half the time',
      '- next_push: atris member tick builder --goal "more"',
      '## 10:30 · Mission run tick 4',
      '- member: builder',
      '- mission: Fix the signup typo',
      '- verifier: failed',
      '- summary: Fixed the typo on the signup button',
      '## 11:00 · Mission run tick 5',
      '- member: builder',
      '- mission: Tidy the readme',
      '- verifier: not_run',
      '- summary: Rewrote the install section of the readme',
      '- next_push: Add a quickstart example',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), JSON.stringify({
      id: 'mission-2026-10-13-speed-up-search',
      owner: 'builder',
      objective: 'Speed up the search page',
      status: 'complete',
      verifier: 'npm test',
      verifier_result: { passed: true },
    }) + '\n', 'utf8');

    const res = runCli(['member', 'feed'], root);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const out = res.stdout;
    assert.match(out, /builder: Cached search results so the page loads in half the time\n\s+checked: tests passed\n/);
    assert.match(out, /builder: Fixed the typo on the signup button\n\s+check failed, needs another pass\n/);
    assert.match(out, /builder: Rewrote the install section of the readme\n\s+not checked yet · next: Add a quickstart example\n/);
    for (const filler of [/Serve the team as/, /\[logged update\]/, /Member wake decision/, /goal-from-mission blocked/, /atris member tick/, /--goal/, /scoreboard/, /Speed up the search page/]) {
      assert.doesNotMatch(out, filler);
    }
    const rows = out.trim().split('\n').filter((line) => /· builder:/.test(line));
    assert.equal(rows.length, 3, out);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

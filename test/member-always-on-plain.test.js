'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { availableModels } = require('../lib/roster-models');
const { readEngineRegistry } = require('../lib/engine-registry');
const { missionPurpose } = require('../lib/member-core');
const { wakeBootLines } = require('../commands/member');
const { writeSelfNextJob } = require('../lib/member-self-next-job');
const { runCli } = require('./helpers/member-cli');
const { normalizeRosterModel } = require('../lib/model-names');
const { runnerModelFor } = require('../lib/runner-command');

test('the two working models are offered', () => {
  assert.ok(availableModels([{ id: 'claude' }])[0].models.includes('fable 5.2'));
  assert.equal(normalizeRosterModel('claude', 'claude-fable-5-2'), 'claude-fable-5-2');
  assert.equal(runnerModelFor('claude', 'fable 5.2'), 'claude-fable-5-2');
  const root = fs.mkdtempSync(path.join(process.cwd(), '.atris-models-test-'));
  try {
    assert.ok(readEngineRegistry(root).engines.find((engine) => engine.id === 'agy').models.includes('gemini-4-hydrogen'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the roster command accepts both models for a member', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.atris-roster-models-test-'));
  try {
    const memberDir = path.join(root, 'atris', 'team', 'krishna');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: krishna\nrole: builder\n---\n');
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## team\n');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'engines.json'), JSON.stringify({ engines: ['claude', 'agy'].map((id) => ({ id, health: { status: 'ready' } })) }));
    const env = { HOME: root, ATRIS_MACHINE_ROSTER_MD_PATH: path.join(root, 'machine-roster.md') };
    for (const [engine, model] of [['claude', 'claude-fable-5-2'], ['agy', 'gemini-4-hydrogen']]) {
      const result = runCli(['engine', 'roster', 'set', '--member', 'krishna', engine, model], { cwd: root, env });
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8'), new RegExp(model === 'claude-fable-5-2' ? 'fable 5\\.2' : model));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('wake reads a shared mission through a pointer or when the member has none', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.atris-shared-mission-test-'));
  try {
    const memberDir = path.join(root, 'atris', 'team', 'krishna');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'MISSION.md'), '# Mission\n\n## North Star\nHelp people learn.\n\n## Check\n`node --test test/a.test.js`\n\n' + 'A long shared mission says much more than a pointer does. '.repeat(8) + 'The town plan lives in ~/elsewhere/atris/team/x/MISSION.md.\n');
    const missionFile = path.join(memberDir, 'MISSION.md');
    const paths = { memberDir, missionFile };
    const db = { prepare: () => ({ all: () => [] }) };
    fs.writeFileSync(missionFile, 'The shared mission is in atris/MISSION.md.\n');
    assert.equal(missionPurpose(paths).northStar, 'Help people learn.');
    // seen live 2026-11-17: the pointer was a full path, ~/arena/sages/atris/MISSION.md
    fs.writeFileSync(missionFile, `The shared mission is in ${path.join(root, 'atris', 'MISSION.md')}.\n`);
    assert.equal(missionPurpose(paths).northStar, 'Help people learn.');
    fs.writeFileSync(missionFile, 'The shared mission is in atris/MISSION.md.\n');
    assert.equal(writeSelfNextJob(null, db, { root, workspaceRoot: root, member: 'krishna', job: 'build', dryRun: true }).task.metadata.verify, 'node --test test/a.test.js');
    fs.unlinkSync(missionFile);
    assert.equal(missionPurpose(paths).northStar, 'Help people learn.');
    assert.equal(writeSelfNextJob(null, db, { root, workspaceRoot: root, member: 'krishna', job: 'build', dryRun: true }).task.metadata.objective, 'Help people learn.');
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: krishna\nrole: Builder\n---\n');
    const result = runCli(['member', 'wake', 'krishna', '--plan', '--json'], { cwd: root, env: { HOME: root, ATRIS_TASKS_DB: path.join(root, 'tasks.db') } });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(JSON.parse(result.stdout).reason, 'mission_missing_or_placeholder');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('wake speaks plainly while keeping the command', () => {
  const output = wakeBootLines('krishna', {
    decision: 'ask', reason: 'mission_missing_or_placeholder', needs_user: true,
    ask: 'Define atris/team/krishna/MISSION.md with a concrete North Star before this member wakes itself.',
    next_command: 'edit atris/team/krishna/MISSION.md', receipt_path: '/tmp/receipt.json',
    mission: { north_star: null }, evidence: { task_projection: { candidate_count: 1 } },
  }).join('\n');
  assert.doesNotMatch(output, /north star|lane|receipt/i);
  assert.match(output, /edit atris\/team\/krishna\/MISSION.md/);
});

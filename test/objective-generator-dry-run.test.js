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

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-objective-generator-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_OBJECTIVE_GENERATOR_LLM: '0',
      ATRIS_OBJECTIVE_GENERATOR_LLM_JSON: '',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function proposalsPath(root) {
  return path.join(root, 'atris', 'team', 'objective-generator', 'proposals.json');
}

function writeObjectiveGeneratorProject(root) {
  const memberDir = path.join(root, 'atris', 'team', 'objective-generator');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), [
    '---',
    'name: objective-generator',
    'role: Autonomous Objective Setter',
    '---',
    '',
    '# Objective Generator',
    '',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(root, 'atris', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'wiki', '.graph.json'), JSON.stringify({
    schema: 'atris.wiki_graph.v1',
    entities: [
      { type: 'system', name: 'signal-scout' },
      { type: 'concept', name: 'wiki graph' },
    ],
    relationships: [
      { from: 'signal-scout', to: 'wiki graph', type: 'uses' },
    ],
  }, null, 2), 'utf8');
}

test('dry-run wake writes no proposals.json and receipt tells the truth', () => {
  const dir = makeTempDir();
  try {
    writeObjectiveGeneratorProject(dir);

    const wake = runCli(['member', 'wake', 'objective-generator', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.executed, false);
    assert.ok(payload.reason.endsWith('_dry_run'), `expected *_dry_run reason, got ${payload.reason}`);

    assert.ok(!fs.existsSync(proposalsPath(dir)), 'dry run must not write proposals.json');

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.proposals_written, false);
    assert.equal(receipt.reason, payload.reason);
    assert.equal(receipt.task_created, false);
    assert.equal(receipt.proposal.auto_task_eligible, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('execute wake writes proposals.json and marks the receipt written', () => {
  const dir = makeTempDir();
  try {
    writeObjectiveGeneratorProject(dir);

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.executed, true);
    assert.equal(payload.reason, 'heuristic_objective_proposal_written');

    assert.ok(fs.existsSync(proposalsPath(dir)), 'execute run must write proposals.json');

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.proposals_written, true);
    assert.equal(receipt.task_created, false);
    assert.equal(receipt.proposal.auto_task_eligible, false);

    const proposals = JSON.parse(fs.readFileSync(proposalsPath(dir), 'utf8'));
    assert.equal(proposals.status, 'ok');
    assert.equal(proposals.auto_task_eligible, false);
    assert.equal(proposals.created_task, null);
  } finally {
    cleanupTempDir(dir);
  }
});

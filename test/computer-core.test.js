'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const computerCore = require('../lib/computer-core');
const computerCommand = require('../commands/computer');

test('commands/computer re-exports shared computer-core helpers', () => {
  const sharedKeys = [
    'computerLocal',
    'readBusinessBinding',
    'buildComputerCard',
    'extractAttachedWorkspaceMismatch',
    'contextForAttachedWorkspaceMismatch',
    'printRecruitingLocalSyncOutcome',
    'useInteractiveCloudUi',
    'useInteractiveTerminalUi',
    'parseComputerOptions',
    'parseComputerCreateArgs',
    'computerCreateArgsHaveName',
    'normalizeComputerType',
    'formatComputerTypeList',
    'parseComputerDeleteArgs',
    'parseComputerCardArgs',
    'renderComputerCard',
    'renderComputerCardMarkdown',
    'formatLeaseAge',
    'formatWorkspaceRef',
    'workspaceMatchesInput',
    'resolveWorkspaceFromList',
    'workspaceMatchesComputerType',
    'looksLikeWorkspaceId',
    'shellQuote',
    'withoutRecruitingWrapperFlags',
    'formatCloudSelection',
  ];
  for (const key of sharedKeys) {
    assert.equal(typeof computerCore[key], 'function', `expected ${key} on lib/computer-core`);
    assert.equal(computerCommand[key], computerCore[key], `expected commands/computer to re-export ${key}`);
  }
});

test('setupComputerChoices maps business list into selectable targets', () => {
  const choices = computerCore.setupComputerChoices({
    businesses: [
      { id: 'biz-1', name: 'Acme', computer_name: 'Ops' },
      { id: 'biz-2', slug: 'beta-labs' },
    ],
  });
  assert.deepEqual(choices, [
    { label: 'Acme: Ops', target: { type: 'business', id: 'biz-1' } },
    { label: 'beta-labs computer', target: { type: 'business', id: 'biz-2' } },
  ]);
});

test('activeWorker, formatWorkerName, and appendSystemPrompt normalize cloud lane prompts', () => {
  assert.equal(computerCore.activeWorker(), 'claude');
  assert.equal(computerCore.activeWorker('DEFAULT'), 'claude');
  assert.equal(computerCore.activeWorker('OpenAI'), 'openai');
  assert.equal(computerCore.formatWorkerName('openai'), 'OpenAI');
  assert.equal(computerCore.formatWorkerName('claude'), 'Claude');

  const combined = computerCore.appendSystemPrompt('Base prompt', '## Section\nBody');
  assert.equal(combined, 'Base prompt\n\n## Section\nBody');
  assert.equal(computerCore.appendSystemPrompt(combined, '## Section\nBody'), combined);
});

test('codeOpsCloudOptions and recruitingCloudOptions attach workflow contracts idempotently', () => {
  const codeops = computerCore.codeOpsCloudOptions({ systemPrompt: 'Intro' });
  assert.equal(codeops.mode, 'codeops');
  assert.ok(codeops.systemPrompt.includes('## Atris CodeOps Workflow'));

  const recruiting = computerCore.recruitingCloudOptions({ worker: 'openai' });
  assert.equal(recruiting.mode, 'recruiting');
  assert.equal(recruiting.worker, 'openai');
  assert.ok(recruiting.systemPrompt.includes('## Atris Recruiting Workflow'));
});

test('extractRunnerProxyText prefers result, then assistant_text array, then text', () => {
  assert.equal(computerCore.extractRunnerProxyText({ result: ' final answer ' }), 'final answer');
  assert.equal(computerCore.extractRunnerProxyText({ assistant_text: ['part 1 ', 'part 2'] }), 'part 1 part 2');
  assert.equal(computerCore.extractRunnerProxyText({ text: ' fallback ' }), 'fallback');
  assert.equal(computerCore.extractRunnerProxyText({}), '');
});

test('buildComputerCard and computerCard write markdown card in temp workspace', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-computer-core-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.atris'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.atris', 'business.json'),
      JSON.stringify({
        name: 'Test Org',
        slug: 'test-org',
        computer_name: 'Builder Box',
        computer_type: 'codeops',
      }),
      'utf8'
    );
    const card = computerCore.buildComputerCard(tmpDir);
    assert.equal(card.ownerName, 'Test Org');
    assert.equal(card.ownerType, 'business');
    assert.equal(card.computerName, 'Builder Box');
    assert.equal(card.computerType, 'codeops');

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const writtenPath = computerCore.computerCard(['--out', 'card-out.md'], tmpDir);
      assert.equal(writtenPath, path.join(tmpDir, 'card-out.md'));
      const content = fs.readFileSync(writtenPath, 'utf8');
      assert.match(content, /# Atris Computer Card/);
      assert.match(content, /- Owner: Test Org \(business\)/);
    } finally {
      console.log = origLog;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const mcp = import('../mcp/atris-mcp/index.mjs');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mcp-campaign-'));
  return { dir, db: path.join(dir, 'campaigns.db') };
}

async function call(name, args, db) {
  const { handleCampaignTool } = await mcp;
  const before = process.env.ATRIS_CAMPAIGN_DB;
  process.env.ATRIS_CAMPAIGN_DB = db;
  try {
    const result = await handleCampaignTool(name, args);
    return { result, data: JSON.parse(result.content[0].text) };
  } finally {
    if (before === undefined) delete process.env.ATRIS_CAMPAIGN_DB;
    else process.env.ATRIS_CAMPAIGN_DB = before;
  }
}

test('campaign tools map to atris campaign verbs with --json and bounded runs', async () => {
  const { campaignArgs, CAMPAIGN_TOOLS } = await mcp;
  assert.deepEqual(CAMPAIGN_TOOLS.map((t) => t.name), ['campaign_list', 'campaign_show', 'campaign_new', 'campaign_start', 'campaign_run', 'campaign_ask', 'campaign_answer']);
  assert.deepEqual(campaignArgs('campaign_list'), ['campaign', 'list', '--json']);
  assert.deepEqual(campaignArgs('campaign_run', { id: 'cmp-x', max_steps: 500 }), ['campaign', 'run', 'cmp-x', '--max-steps', '20', '--parallel', '3', '--json']);
  assert.deepEqual(campaignArgs('campaign_run', { id: 'cmp-x' }).slice(3, 5), ['--max-steps', '3']);
  assert.deepEqual(campaignArgs('campaign_new', { goal: 'ship it', start: true }), ['campaign', 'new', 'ship it', '--yes', '--json']);
  assert.deepEqual(campaignArgs('campaign_start', { title: 'T', judge: 'npm test', budget: 5, seats: ['builder', 'validator:review'], as: 'builder' }),
    ['campaign', 'start', 'T', '--judge', 'npm test', '--budget', '5', '--seat', 'builder', '--seat', 'validator:review', '--as', 'builder', '--json']);
  assert.match(campaignArgs('campaign_answer', { id: 'cmp-x' }).error, /needs an id, an ask_id, and an answer/);
  assert.match(campaignArgs('campaign_start', { title: 'T', judge: 'x' }).error, /budget/);
});

test('an agent starts, asks, runs to the stop, and cannot answer for the person', async () => {
  const { dir, db } = scratch();
  try {
    const easy = await call('campaign_start', { title: 'Too easy', judge: 'true', budget: 5, cwd: dir }, db);
    assert.equal(easy.result.isError, true);
    assert.match(easy.data.error, /fails first/);

    const started = await call('campaign_start', { title: 'Try it', judge: 'echo "ℹ pass 1"; echo "ℹ fail 2"; exit 1', budget: 5, id: 'cmp-try', cwd: dir }, db);
    assert.equal(started.result.isError, undefined, JSON.stringify(started.data));
    assert.equal(started.data.campaign.answer.text, 'pass 1, fail 2');

    const asked = await call('campaign_ask', { id: 'cmp-try', question: 'deploy to production?', cwd: dir }, db);
    const askId = asked.data.campaign.asks[0].id;

    const ran = await call('campaign_run', { id: 'cmp-try', max_steps: 2, cwd: dir }, db);
    assert.equal(ran.data.reason, 'needs you: 1 open ask');
    assert.equal(ran.data.steps, 0);

    const answered = await call('campaign_answer', { id: 'cmp-try', ask_id: askId, answer: 'yes', cwd: dir }, db);
    assert.equal(answered.data.still_open, true);
    assert.equal(answered.data.person_command, `atris campaign answer cmp-try ${askId} "yes"`);

    const shown = await call('campaign_show', { id: 'cmp-try', cwd: dir }, db);
    assert.equal(shown.data.next.action, 'wait');
    const listed = await call('campaign_list', { cwd: dir }, db);
    assert.deepEqual(listed.data.campaigns.map((c) => c.id), ['cmp-try']);
    const missing = await call('campaign_show', { id: 'cmp-nope', cwd: dir }, db);
    assert.equal(missing.result.isError, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris mcp lists campaign tools and runs them without a design key', async () => {
  const { dir, db } = scratch();
  try {
    const child = spawn(process.execPath, [cliPath, 'mcp'], {
      cwd: dir,
      env: { ...process.env, HOME: dir, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NONINTERACTIVE: '1', ATRIS_TOKEN: '', ATRIS_API_KEY: '', ATRIS_CAMPAIGN_DB: db },
    });
    let stdout = '';
    const done = new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.split('\n').some((line) => { try { return JSON.parse(line).id === 3; } catch { return false; } })) child.stdin.end();
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
      child.on('close', () => { clearTimeout(timer); resolve(); });
    });
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'campaign_list', arguments: {} } });
    await done;
    const messages = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const names = messages.find((m) => m.id === 2).result.tools.map((t) => t.name);
    assert.ok(names.includes('campaign_run') && names.includes('design_search'), names.join(','));
    const listed = messages.find((m) => m.id === 3).result;
    assert.equal(listed.isError, undefined, listed.content[0].text);
    assert.deepEqual(JSON.parse(listed.content[0].text).campaigns, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

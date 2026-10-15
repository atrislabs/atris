'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign, listCampaigns } = require('../lib/campaign-store');
const { judgePrompt, parseDraft } = require('../lib/campaign-new');

const FAILING = 'echo "ℹ pass 1"\necho "ℹ fail 2"\nexit 1';

function reply(script, extra = {}) {
  return JSON.stringify({ title: 'Ship dark mode', judge_script: script, why: 'counts screens with a dark theme', seats: ['builder', 'nobody'], ...extra });
}

// A scratch workspace with one member; the real judge runs inside it.
async function inWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-new-'));
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function run(args, replies) {
  const store = createMemoryStore({ origin: 'laptop' });
  const prompts = [];
  const lines = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => lines.push(String(line));
  console.error = () => {};
  let code;
  try {
    code = await campaignCommand(['new', ...args, '--json'], {
      store,
      actor: 'human:test',
      loopDeps: { ask: async (root, view, prompt) => { prompts.push(prompt); return { ok: true, engine: 'fake', text: replies.shift() || '' }; } },
    });
  } finally {
    console.log = log;
    console.error = error;
  }
  return { code, store, prompts, json: JSON.parse(lines[lines.length - 1]) };
}

test('new drafts a judge, proves it fails today, and starts nothing without --yes', async () => {
  await inWorkspace(async (dir) => {
    const { code, json, store, prompts } = await run(['make every screen support dark mode'], [`Sure:\n${reply(FAILING)}`]);
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(json.action, 'campaign_drafted');
    assert.equal(json.reading.passed, false);
    assert.equal(json.reading.summary, 'pass 1, fail 2');
    assert.deepEqual(json.draft.seats, ['builder']);
    assert.equal(json.draft.budget, 20);
    assert.equal(json.draft.judge, `sh atris/campaigns/${json.draft.id}/judge.sh`);
    const file = path.join(dir, json.draft.judge_file);
    assert.ok(fs.statSync(file).mode & 0o100, 'judge is executable');
    assert.match(fs.readFileSync(file, 'utf8'), /^#!\/bin\/sh\n/);
    assert.match(json.start_command, /^atris campaign start 'Ship dark mode' --judge 'sh atris\/campaigns\/cmp-ship-dark-mode-[0-9a-f]{4}\/judge\.sh' --budget 20 /);
    assert.match(json.start_command, /--seat builder$/);
    assert.equal(listCampaigns(store).length, 0);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Goal: make every screen support dark mode/);
    assert.match(prompts[0], /Members who can work on it: builder/);
    assert.match(prompts[0], /ℹ pass N/);
  });
});

test('new --yes starts the campaign with the reading it already took', async () => {
  await inWorkspace(async () => {
    const { code, json, store } = await run(['make every screen support dark mode', '--yes', '--budget', '7', '--owner', 'builder'], [reply(FAILING)]);
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(json.action, 'campaign_started');
    assert.equal(json.draft.title, 'Ship dark mode');
    const view = getCampaign(store, json.draft.id);
    assert.equal(view.judge, json.draft.judge);
    assert.equal(view.budget.total, 7);
    assert.equal(view.owner, 'builder');
    assert.deepEqual(view.seats.map((s) => s.member), ['builder']);
    assert.equal(store.read(view.id).filter((e) => e.type === 'judge_ran').length, 1);
    assert.equal(json.next.action, 'propose');
  });
});

test('a drafted judge that passes today gets one retry with the reason, then is refused', async () => {
  await inWorkspace(async (dir) => {
    const { code, json, prompts, store } = await run(['make it fast'], [reply('exit 0'), reply('echo ok')]);
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.match(json.error, /already passes \(ok\); a judge must fail first/);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /passed today/);
    assert.equal(listCampaigns(store).length, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'atris', 'campaigns')), [], 'the failed draft is cleaned up');
  });
});

test('a reply that is not a script, or a judge that cannot run, is retried', async () => {
  await inWorkspace(async () => {
    const first = await run(['make it fast'], ['I think you should test it.', reply(FAILING)]);
    assert.equal(first.code, 0, JSON.stringify(first.json));
    assert.match(first.prompts[1], /not one JSON object/);

    const second = await run(['make it fast'], [reply('no-such-command-for-atris-test'), reply(FAILING)]);
    assert.equal(second.code, 0, JSON.stringify(second.json));
    assert.match(second.prompts[1], /could not run/);
  });
});

test('new needs a goal and a real budget', async () => {
  await inWorkspace(async () => {
    assert.equal((await run([], [])).code, 2);
    const bad = await run(['ship it', '--budget', '0'], []);
    assert.equal(bad.code, 2);
    assert.match(bad.json.error, /--budget/);
    assert.equal(bad.prompts.length, 0);
  });
});

test('parseDraft keeps only real scripts and known members', () => {
  assert.equal(parseDraft('no json here', ['builder']), null);
  assert.equal(parseDraft('{"title":"x"}', ['builder']), null);
  assert.equal(parseDraft(JSON.stringify({ judge_script: 'x'.repeat(9000) }), []), null);
  const draft = parseDraft(reply(FAILING, { seats: ['builder', 'builder', 'ghost'] }), ['builder']);
  assert.deepEqual(draft.seats, ['builder']);
  assert.equal(draft.title, 'Ship dark mode');
  assert.doesNotMatch(judgePrompt({ goal: 'g', members: [], hints: [], previous: '' }), /Your last draft/);
});

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
    const dirs = fs.readdirSync(path.join(dir, 'atris', 'campaigns'));
    assert.equal(dirs.length, 1, 'failed drafts remain available for inspection');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'atris', 'campaigns', dirs[0])).sort(), ['judge-2.sh', 'judge.sh']);
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

test('a sentence with no --judge drafts one, the same as campaign new', async () => {
  await inWorkspace(async () => {
    const store = createMemoryStore({ origin: 'laptop' });
    const lines = [];
    const log = console.log;
    const error = console.error;
    console.log = (line) => lines.push(String(line));
    console.error = () => {};
    let code;
    try {
      code = await campaignCommand(['make every screen support dark mode', '--json'], {
        store, actor: 'human:test',
        loopDeps: { ask: async () => ({ ok: true, engine: 'fake', text: reply(FAILING) }) },
      });
    } finally {
      console.log = log;
      console.error = error;
    }
    assert.equal(code, 0);
    assert.equal(JSON.parse(lines[lines.length - 1]).action, 'campaign_drafted');
    assert.equal(listCampaigns(store).length, 0, 'nothing starts without a yes');
  });
});

test('a yes at the terminal starts the drafted campaign; a no starts nothing', async () => {
  for (const answer of [true, false]) {
    await inWorkspace(async () => {
      const store = createMemoryStore({ origin: 'laptop' });
      const questions = [];
      const log = console.log;
      const error = console.error;
      console.log = () => {};
      console.error = () => {};
      let code;
      try {
        code = await campaignCommand(['new', 'make every screen support dark mode'], {
          store, actor: 'human:test',
          loopDeps: {
            ask: async () => ({ ok: true, engine: 'fake', text: reply(FAILING) }),
            confirm: async (question) => { questions.push(question); return answer; },
          },
        });
      } finally {
        console.log = log;
        console.error = error;
      }
      assert.equal(code, 0);
      assert.equal(questions.length, 1);
      assert.match(questions[0], /start it\? \[y\/N\]/);
      assert.equal(listCampaigns(store).length, answer ? 1 : 0);
    });
  }
});


test('existing campaign directory survives a new draft with the same id', async () => {
  await inWorkspace(async (dir) => {
    const campaignDir = path.join(dir, 'atris', 'campaigns', 'cmp-existing');
    fs.mkdirSync(campaignDir, { recursive: true });
    fs.writeFileSync(path.join(campaignDir, 'judge.sh'), 'original judge\n');
    fs.writeFileSync(path.join(campaignDir, 'notes'), 'original notes\n');
    const result = await run(['goal', '--id', 'cmp-existing'], [reply(FAILING)]);
    assert.equal(result.code, 1);
    assert.match(result.json.error, /directory already exists/);
    assert.equal(fs.readFileSync(path.join(campaignDir, 'judge.sh'), 'utf8'), 'original judge\n');
    assert.equal(fs.readFileSync(path.join(campaignDir, 'notes'), 'utf8'), 'original notes\n');
  });
});

test('unsafe campaign id is rejected before asking or running a judge', async () => {
  await inWorkspace(async () => {
    const result = await run(['goal', '--id', 'cmp-x;touch-pwned'], [reply(FAILING)]);
    assert.equal(result.code, 2);
    assert.match(result.json.error, /--id must look/);
    assert.equal(result.prompts.length, 0);
    assert.equal(fs.existsSync('touch-pwned'), false);
  });
});

test('retry leaves a judge edited after the first reading intact', async () => {
  const { draftAndStart } = require('../lib/campaign-new');
  await inWorkspace(async (dir) => {
    let reads = 0;
    let result;
    const code = await draftAndStart(['--id', 'cmp-retry'], {
      asJson: true,
      fail: (message) => assert.fail(message),
      out: (_human, json) => { result = json; },
      judge: async () => {
        if (++reads === 1) {
          fs.writeFileSync(path.join(dir, 'atris/campaigns/cmp-retry/judge.sh'), 'edited while running\n');
          return { passed: true, exit: 0 };
        }
        return { passed: false, exit: 1 };
      },
    }, { root: dir, goal: 'test', ask: async () => ({ engine: 'mock', text: reply(FAILING) }) });
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'atris/campaigns/cmp-retry/judge.sh'), 'utf8'), 'edited while running\n');
    assert.equal(result.draft.judge_file, 'atris/campaigns/cmp-retry/judge-2.sh');
  });
});

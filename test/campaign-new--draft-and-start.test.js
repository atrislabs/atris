'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { draftAndStart } = require('../lib/campaign-new');

// The canned owner-engine reply: one member seat is real, one is not.
function reply(extra = {}) {
  return JSON.stringify({
    title: 'Ship dark mode',
    judge_script: 'exit 1',
    why: 'checks for a dark flag',
    seats: ['builder', 'ghost'],
    ...extra,
  });
}

// A scratch workspace with one member; HOME and ATRIS_* are pointed away from
// the real machine so nothing here can leak out of the temp dir.
async function inSandbox(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-and-start-'));
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (key === 'HOME' || key.startsWith('ATRIS_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.HOME = dir;
  try {
    return await fn(dir);
  } finally {
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    if (!('HOME' in saved)) delete process.env.HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Calls draftAndStart with a stubbed ctx: the judge never really runs, output
// and failures are captured, and console noise is silenced.
async function call(args, { ctx = {}, deps = {} } = {}) {
  const outCalls = [];
  const failCalls = [];
  const printed = { log: [], error: [] };
  const realLog = console.log;
  const realError = console.error;
  console.log = (line) => printed.log.push(String(line));
  console.error = (line) => printed.error.push(String(line));
  const fullCtx = {
    asJson: false,
    judge: async () => ({ passed: false, exit: 1, summary: 'exit 1' }),
    out: (human, json) => outCalls.push({ human, json }),
    fail: (message, code = 2) => { failCalls.push({ message, code }); return code; },
    ...ctx,
  };
  try {
    const code = await draftAndStart(args, fullCtx, deps);
    return { code, outCalls, failCalls, printed };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

test('draftAndStart fails without a goal and never asks the engine', async () => {
  await inSandbox(async () => {
    let asks = 0;
    const { code, failCalls } = await call(['new'], {
      deps: { goal: '   ', ask: async () => { asks += 1; return {}; } },
    });
    assert.equal(code, 2);
    assert.equal(failCalls.length, 1);
    assert.match(failCalls[0].message, /say the goal/);
    assert.equal(asks, 0);
  });
});

test('draftAndStart refuses a budget that is not dollars above zero', async () => {
  await inSandbox(async () => {
    let asks = 0;
    const deps = { goal: 'ship it', ask: async () => { asks += 1; return {}; } };
    for (const bad of ['0', '-3', 'banana']) {
      const { code, failCalls } = await call(['new', '--budget', bad], { deps });
      assert.equal(code, 2);
      assert.match(failCalls[0].message, /--budget must be dollars above 0/);
    }
    assert.equal(asks, 0);
  });
});

test('a draft without --yes writes the judge file and prints the start command', async () => {
  await inSandbox(async (dir) => {
    const asks = [];
    const judgeCalls = [];
    let starts = 0;
    const { code, outCalls } = await call(['new', '--budget', '30', '--owner', 'builder', '--id', 'cmp-dark-mode'], {
      ctx: { judge: async (command, timeout) => { judgeCalls.push({ command, timeout }); return { passed: false, exit: 1, summary: 'exit 1' }; } },
      deps: {
        goal: 'make every screen support dark mode',
        root: dir,
        ask: async (root, view, prompt) => { asks.push({ root, view, prompt }); return { ok: true, engine: 'fake', text: reply() }; },
        start: async () => { starts += 1; return 0; },
      },
    });
    assert.equal(code, 0);
    assert.equal(starts, 0, 'nothing starts without a yes');
    assert.equal(outCalls.length, 1);
    assert.match(outCalls[0].human, /draft for: make every screen support dark mode/);
    assert.match(outCalls[0].human, /start it:/);
    const json = outCalls[0].json;
    assert.equal(json.action, 'campaign_drafted');
    assert.equal(json.draft.id, 'cmp-dark-mode');
    assert.equal(json.draft.judge, 'sh atris/campaigns/cmp-dark-mode/judge.sh');
    assert.deepEqual(json.draft.seats, ['builder'], 'ghost is not a member');
    assert.equal(
      json.start_command,
      "atris campaign start 'Ship dark mode' --judge 'sh atris/campaigns/cmp-dark-mode/judge.sh' --budget 30 --id cmp-dark-mode --owner builder --seat builder",
    );
    assert.deepEqual(judgeCalls, [{ command: 'sh atris/campaigns/cmp-dark-mode/judge.sh', timeout: 600 }]);
    const file = path.join(dir, 'atris', 'campaigns', 'cmp-dark-mode', 'judge.sh');
    assert.match(fs.readFileSync(file, 'utf8'), /^#!\/bin\/sh\nexit 1\n/);
    assert.ok(fs.statSync(file).mode & 0o100, 'judge is executable');
    assert.equal(asks.length, 1);
    assert.equal(asks[0].view.owner, 'builder');
    assert.match(asks[0].prompt, /Goal: make every screen support dark mode/);
  });
});

test('draftAndStart --yes hands start the title, judge, budget, and seats', async () => {
  await inSandbox(async (dir) => {
    const startCalls = [];
    const reading = { passed: false, exit: 1, summary: 'exit 1' };
    const { code, printed } = await call(['new', '--yes', '--id', 'cmp-fixed'], {
      ctx: { judge: async () => reading },
      deps: {
        goal: 'make dark mode',
        root: dir,
        ask: async () => ({ ok: true, engine: 'fake', text: reply() }),
        start: async (startAgs, startCtx) => { startCalls.push({ args: startAgs, ctx: startCtx }); return 7; },
      },
    });
    assert.equal(code, 7, 'the start verb decides the exit code');
    assert.ok(printed.log.some((line) => /draft for: make dark mode/.test(line)), 'the draft is shown before it starts');
    assert.equal(startCalls.length, 1);
    assert.deepEqual(startCalls[0].args, [
      'start', 'Ship dark mode',
      '--judge', 'sh atris/campaigns/cmp-fixed/judge.sh',
      '--budget', '20',
      '--id', 'cmp-fixed',
      '--owner', 'mission-lead',
      '--seat', 'builder',
    ]);
    assert.equal(await startCalls[0].ctx.judge('ignored', 0), reading, 'start reuses the reading already taken');
  });
});

test('the confirm answer decides whether the draft starts', async () => {
  for (const answer of [true, false]) {
    await inSandbox(async (dir) => {
      const questions = [];
      let starts = 0;
      const { code, outCalls } = await call(['new', '--id', 'cmp-confirm'], {
        deps: {
          goal: 'ship it',
          root: dir,
          ask: async () => ({ ok: true, engine: 'fake', text: reply() }),
          confirm: async (question) => { questions.push(question); return answer; },
          start: async () => { starts += 1; return 0; },
        },
      });
      assert.equal(code, 0);
      assert.equal(questions.length, 1);
      assert.match(questions[0], /start it\? \[y\/N\]/);
      assert.equal(starts, answer ? 1 : 0);
      if (!answer) assert.match(outCalls[0].human, /not started\./);
    });
  }
});

test('a drafted judge that already passes gets one retry, then is refused and cleaned up', async () => {
  await inSandbox(async (dir) => {
    const prompts = [];
    let judgeCalls = 0;
    const { code, failCalls } = await call(['new'], {
      ctx: { judge: async () => { judgeCalls += 1; return { passed: true, exit: 0, summary: 'ok' }; } },
      deps: {
        goal: 'make it fast',
        root: dir,
        ask: async (root, view, prompt) => { prompts.push(prompt); return { ok: true, engine: 'fake', text: reply() }; },
        start: async () => 0,
      },
    });
    assert.equal(code, 1);
    assert.equal(judgeCalls, 2);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /passed today/);
    assert.match(failCalls[0].message, /already passes.*judge must fail first/s);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'atris', 'campaigns')), [], 'the failed draft folder is removed');
  });
});

test('an engine reply without a judge script is retried, then refused', async () => {
  await inSandbox(async (dir) => {
    const prompts = [];
    let judgeCalls = 0;
    const { code, failCalls } = await call(['new'], {
      ctx: { judge: async () => { judgeCalls += 1; return {}; } },
      deps: {
        goal: 'make it fast',
        root: dir,
        ask: async (root, view, prompt) => { prompts.push(prompt); return { ok: true, engine: 'fake', text: 'I think you should test it.' }; },
        start: async () => 0,
      },
    });
    assert.equal(code, 1);
    assert.equal(judgeCalls, 0, 'a non-draft never reaches the judge');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /not one JSON object/);
    assert.match(failCalls[0].message, /did not return a judge script/);
  });
});

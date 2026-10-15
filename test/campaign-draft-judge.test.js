'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { draftJudge, draftPrompt, parseDraft } = require('../lib/campaign-draft-judge');

function fakeAsk(text, engine = 'fake') {
  const calls = [];
  const ask = async (root, owner, prompt) => {
    calls.push({ root, owner, prompt });
    return { text, engine, ok: true };
  };
  return { ask, calls };
}

test('the prompt carries the goal and asks for a judge that fails first', () => {
  const prompt = draftPrompt('Make hello.txt say sunrise', '/work');
  assert.match(prompt, /Goal: Make hello.txt say sunrise/);
  assert.match(prompt, /fail right now/);
  assert.match(prompt, /"command"/);
  assert.match(prompt, /"script"/);
});

test('one command comes back as the judge as written', async () => {
  const { ask, calls } = fakeAsk('Sure:\n{"command": "grep -q sunrise /w/hello.txt", "script": "", "explain": "checks hello.txt says sunrise"}');
  const draft = await draftJudge('/root', 'Make /w/hello.txt say sunrise', { ask, owner: 'builder' });
  assert.equal(draft.ok, true);
  assert.equal(draft.judge, 'grep -q sunrise /w/hello.txt');
  assert.equal(draft.script, null);
  assert.equal(draft.explain, 'checks hello.txt says sunrise');
  assert.equal(draft.engine, 'fake');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'builder');
  assert.equal(calls[0].root, '/root');
  assert.match(calls[0].prompt, /Make \/w\/hello.txt say sunrise/);
});

test('owner defaults to mission-lead', async () => {
  const { ask, calls } = fakeAsk('{"command": "false"}');
  await draftJudge('/root', 'goal', { ask });
  assert.equal(calls[0].owner, 'mission-lead');
});

test('a script becomes a runnable bash command that fails before and passes after', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-judge-'));
  const file = path.join(dir, "it's.txt");
  const script = `f="${file}"\n[ -f "$f" ] || exit 1\ngrep -q sunrise "$f"`;
  const { ask } = fakeAsk(JSON.stringify({ command: '', script, explain: 'checks the file' }));
  const draft = await draftJudge('/root', 'goal', { ask });
  assert.equal(draft.ok, true);
  assert.equal(draft.script, script);
  assert.match(draft.judge, /^bash -c '/);
  const run = () => {
    try {
      execFileSync('/bin/sh', ['-c', draft.judge], { stdio: 'ignore' });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.notEqual(run(), 0);
  fs.writeFileSync(file, 'sunrise\n');
  assert.equal(run(), 0);
});

test('a fenced bash block is accepted when the engine skips the JSON', () => {
  const draft = parseDraft('Here you go:\n```bash\ntest -f /tmp/x\n```\n');
  assert.equal(draft.script, 'test -f /tmp/x');
  assert.equal(draft.judge, "bash -c 'test -f /tmp/x'");
});

test('an empty or unusable answer is refused in plain words', async () => {
  for (const text of ['', 'I cannot help', '{"command": "", "script": ""}', JSON.stringify({ script: 'x'.repeat(5000) })]) {
    const { ask } = fakeAsk(text);
    const draft = await draftJudge('/root', 'goal', { ask });
    assert.equal(draft.ok, false, text.slice(0, 40));
    assert.match(draft.reason, /did not answer/);
  }
});

test('no goal means no engine call', async () => {
  const { ask, calls } = fakeAsk('{"command": "false"}');
  const draft = await draftJudge('/root', '   ', { ask });
  assert.equal(draft.ok, false);
  assert.equal(calls.length, 0);
});

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

// Exercise the command handler with real shell judges, including the copied
// draft script path. Only drafting and terminal input are supplied by the test.
async function runCampaign(store, args, deps = {}) {
  const out = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => out.push(String(line));
  console.error = () => {};
  try {
    const code = await campaignCommand(args, {
      store, actor: 'human:tester', interactive: false,
      confirm: async () => false, ...deps,
    });
    return { code, out: out.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

test('a drafted explanation survives script copying and accompanies passed and not yet readings', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-explain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'judge.sh');
  const marker = path.join(dir, 'ready');
  fs.writeFileSync(script, `#!/bin/sh\n[ -f '${marker}' ]\n`, { mode: 0o755 });
  const store = createMemoryStore();
  const explain = 'checks 3 billing cases are ready';
  const started = await runCampaign(store, ['start', 'Ship billing', '--yes', '--id', 'cmp-explain'], {
    draftJudge: async () => ({ ok: true, judge: script, explain }),
    campaignFolder: () => path.join(dir, 'saved'),
  });
  assert.equal(started.code, 0, started.out);
  const event = store.read('cmp-explain').find((event) => event.type === 'campaign_started');
  assert.equal(event.data.explain, explain);
  assert.notEqual(event.data.judge, script, 'the original script was copied');
  const judge = () => runCampaign(store, ['judge', 'cmp-explain']);
  const waiting = await judge();
  assert.equal(waiting.code, 1);
  assert.match(waiting.out, /judge not yet in \d+s: checks 3 billing cases are ready/);
  fs.writeFileSync(marker, 'ready');
  const passed = await judge();
  assert.equal(passed.code, 0);
  assert.match(passed.out, /judge passed in \d+s: checks 3 billing cases are ready/);
  assert.equal(getCampaign(store, 'cmp-explain').answer.text, explain, 'a silent judge saves the explanation, not exit 0');
  const readings = store.read('cmp-explain').filter((event) => event.type === 'judge_ran');
  assert.ok(readings.every((event) => event.data.reading === undefined), 'explanation digits never become numeric readings');

  const changed = await runCampaign(store, ['set-judge', 'cmp-explain', "printf '2 failed\\nreplacement needs work\\n'; exit 1"]);
  assert.equal(changed.code, 0);
  const replacement = await judge();
  assert.match(replacement.out, /judge not yet in \d+s: replacement needs work/);
  assert.doesNotMatch(replacement.out.split('\n')[0], /checks 3 billing/);
});

test('hand-written judges show the last output line, using exit only for empty output', async () => {
  for (const [id, command, message] of [
    ['cmp-written', "printf '2 failed\\nlast useful line\\n'; exit 1", 'last useful line'],
    ['cmp-punctuation', "printf 'earlier words\\n!\\n'; exit 1", '!'],
    ['cmp-empty', 'exit 7', 'exit 7'],
  ]) {
    const store = createMemoryStore();
    const started = await runCampaign(store, ['start', 'Hand written judge', '--judge', command, '--id', id]);
    assert.equal(started.code, 0);
    const result = await runCampaign(store, ['judge', id]);
    assert.equal(result.code, 1);
    assert.equal(result.out.split('\n')[0], `judge not yet in 0s: ${message}`);
  }
});

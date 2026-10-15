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

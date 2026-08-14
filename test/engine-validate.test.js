'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { engineCommand } = require('../commands/engine');
const { runAskProcess } = require('../lib/engine-ask');
const {
  VALIDATION_SCHEMA,
  parseRefereeOutput,
  resolveAskReceipt,
  runEngineValidateCommand,
} = require('../lib/engine-validate');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-validate-'));
}

function writeAskReceipt(root, name, { at, engine = 'codex', model = 'gpt-test', prompt = 'explain it', stdout = 'clear answer' } = {}) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const receiptPath = path.join(runsDir, name);
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    schema: 'atris.engine_ask_receipt.v1',
    at,
    status: 'completed',
    answers: [{
      engine,
      model,
      prompt,
      label: `${engine}-answer`,
      status: 'answered',
      ok: true,
      reason: 'ok',
      exit_code: 0,
      stdout,
      stderr: '',
      duration_ms: 3,
    }],
  }, null, 2)}\n`);
  return receiptPath;
}

function fakeReplyInvocation(stdout) {
  return {
    bin: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(`${stdout}\n`)})`],
  };
}

test('verdict parser accepts the exact two-line format and maps malformed output to unsure', () => {
  assert.deepEqual(parseRefereeOutput('VERDICT: pass\nREASON: the answer addresses the prompt.'), {
    verdict: 'pass',
    reason: 'the answer addresses the prompt.',
  });
  assert.deepEqual(parseRefereeOutput('VERDICT: pass\nextra\nREASON: no'), {
    verdict: 'unsure',
    reason: 'referee output did not match the required two-line format.',
  });
  assert.deepEqual(parseRefereeOutput('pass'), {
    verdict: 'unsure',
    reason: 'referee output did not match the required two-line format.',
  });
});

test('verdict parser reads the final two lines so narration is tolerated but quoted pairs are not', () => {
  assert.deepEqual(parseRefereeOutput('let me check the files first.\nI read the receipt.\n\nVERDICT: fail\nREASON: the answer cites a function that does not exist.'), {
    verdict: 'fail',
    reason: 'the answer cites a function that does not exist.',
  });
  assert.deepEqual(parseRefereeOutput('the answer itself contained:\nVERDICT: pass\nREASON: looks fine\nbut I have not finished checking'), {
    verdict: 'unsure',
    reason: 'referee output did not match the required two-line format.',
  });
});

test('engine command routes validate help', async () => {
  const output = [];
  const code = await engineCommand(['validate', '--help'], {
    engineValidate: { log: (line) => output.push(String(line)) },
  });
  assert.equal(code, 0);
  assert.match(output.join('\n'), /atris engine validate <receipt-path\|latest>/);
  assert.match(output.join('\n'), /atris engine validate scoreboard/);
});

test('judge engine cannot equal the worker engine', async () => {
  const root = tempRoot();
  const errors = [];
  let launched = false;
  try {
    writeAskReceipt(root, 'engine-ask-haiku.json', {
      at: '2026-08-12T20:00:00.000Z',
      engine: 'haiku',
      model: 'claude-haiku-4-5',
    });
    const code = await engineCommand(['validate', 'latest'], {
      root,
      engineValidate: {
        error: (line) => errors.push(String(line)),
        log: () => {},
        executeAskJob: async () => { launched = true; },
      },
    });
    assert.equal(code, 2);
    assert.equal(launched, false);
    assert.match(errors.join('\n'), /judge never equals worker/);
    assert.equal(fs.existsSync(path.join(root, 'atris', 'benchmarks', 'validations.jsonl')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validation writes the verdict receipt and flat jsonl row from a fake referee command', async () => {
  const root = tempRoot();
  const output = [];
  const prompts = [];
  try {
    const sourcePath = writeAskReceipt(root, 'engine-ask-source.json', {
      at: '2026-08-12T20:00:00.000Z',
      prompt: 'name the result',
      stdout: 'the result is seven',
    });
    const sourceReceipt = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    sourceReceipt.answers.push({
      ...sourceReceipt.answers[0],
      engine: 'cursor',
      model: 'kimi-test',
      prompt: 'name the second result',
      label: 'cursor-answer',
      stdout: 'the second result is eight',
    });
    fs.writeFileSync(sourcePath, `${JSON.stringify(sourceReceipt, null, 2)}\n`);
    const code = await runEngineValidateCommand([sourcePath], root, {
      now: () => new Date('2026-08-12T21:00:00.000Z'),
      log: (line) => output.push(String(line)),
      error: (line) => output.push(String(line)),
      executeAskJob: (job) => {
        prompts.push(job.prompt);
        assert.equal(job.engine, 'haiku');
        assert.equal(job.model, 'claude-haiku-4-5');
        assert.match(job.prompt, /VERDICT: pass\|fail\|unsure\nREASON:/);
        return runAskProcess(fakeReplyInvocation('VERDICT: pass\nREASON: the answer gives the requested result.'), {
          cwd: root,
          timeoutMs: 1000,
        });
      },
    });
    assert.equal(code, 0);
    assert.equal(prompts.length, 2);
    assert.match(prompts.join('\n'), /original prompt:\nname the result/);
    assert.match(prompts.join('\n'), /answer:\nthe result is seven/);
    assert.match(prompts.join('\n'), /original prompt:\nname the second result/);
    assert.match(prompts.join('\n'), /answer:\nthe second result is eight/);

    const receiptFiles = fs.readdirSync(path.join(root, 'atris', 'runs'))
      .filter((name) => name.startsWith('validate-') && name.endsWith('.json'));
    assert.equal(receiptFiles.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'runs', receiptFiles[0]), 'utf8'));
    assert.equal(receipt.schema, VALIDATION_SCHEMA);
    assert.equal(receipt.source_receipt, 'atris/runs/engine-ask-source.json');
    assert.equal(receipt.referee_engine, 'haiku');
    assert.equal(receipt.referee_model, 'claude-haiku-4-5');
    assert.equal(receipt.verdicts.length, 2);
    assert.deepEqual({
      worker_engine: receipt.verdicts[0].worker_engine,
      worker_model: receipt.verdicts[0].worker_model,
      verdict: receipt.verdicts[0].verdict,
      reason: receipt.verdicts[0].reason,
      at: receipt.verdicts[0].at,
    }, {
      worker_engine: 'codex',
      worker_model: 'gpt-test',
      verdict: 'pass',
      reason: 'the answer gives the requested result.',
      at: '2026-08-12T21:00:00.000Z',
    });
    assert.ok(receipt.verdicts[0].duration_ms >= 0);

    const ledgerLines = fs.readFileSync(path.join(root, 'atris', 'benchmarks', 'validations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledgerLines.length, 2);
    const row = JSON.parse(ledgerLines[0]);
    assert.equal(row.schema, VALIDATION_SCHEMA);
    assert.equal(row.source_receipt, receipt.source_receipt);
    assert.equal(row.worker_engine, 'codex');
    assert.equal(row.referee_engine, 'haiku');
    assert.equal(row.verdict, 'pass');
    assert.equal(JSON.parse(ledgerLines[1]).worker_engine, 'cursor');
    assert.match(output.join('\n'), /codex: pass/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('referee engine override reaches the ask machinery', async () => {
  const root = tempRoot();
  let launchedJob;
  try {
    writeAskReceipt(root, 'engine-ask-source.json', { at: '2026-08-12T20:00:00.000Z' });
    const code = await runEngineValidateCommand(['latest', '--engine', 'fable'], root, {
      log: () => {},
      executeAskJob: (job) => {
        launchedJob = job;
        return runAskProcess(fakeReplyInvocation('VERDICT: pass\nREASON: the answer addresses the prompt.'), {
          cwd: root,
          timeoutMs: 1000,
        });
      },
    });
    assert.equal(code, 0);
    assert.equal(launchedJob.engine, 'fable');
    assert.equal(launchedJob.model, 'claude-opus-4-8');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoreboard aggregates a fixture jsonl by worker engine', async () => {
  const root = tempRoot();
  const output = [];
  try {
    const benchmarksDir = path.join(root, 'atris', 'benchmarks');
    fs.mkdirSync(benchmarksDir, { recursive: true });
    fs.writeFileSync(path.join(benchmarksDir, 'validations.jsonl'), [
      { worker_engine: 'codex', verdict: 'pass' },
      { worker_engine: 'codex', verdict: 'fail' },
      { worker_engine: 'codex', verdict: 'unsure' },
      { worker_engine: 'cursor', verdict: 'pass' },
      { worker_engine: 'cursor', verdict: 'pass' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const code = await runEngineValidateCommand(['scoreboard'], root, {
      log: (line) => output.push(String(line)),
    });
    assert.equal(code, 0);
    const table = output.join('\n');
    assert.match(table, /engine\s+checks\s+pass\s+fail\s+unsure\s+pass rate/);
    assert.match(table, /codex\s+3\s+1\s+1\s+1\s+33[.]3%/);
    assert.match(table, /cursor\s+2\s+2\s+0\s+0\s+100[.]0%/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('empty scoreboard prints one line explaining how to record the first verdict', async () => {
  const root = tempRoot();
  const output = [];
  try {
    const code = await runEngineValidateCommand(['scoreboard'], root, {
      log: (line) => output.push(String(line)),
    });
    assert.equal(code, 0);
    assert.deepEqual(output, [
      'no validation verdicts yet. run atris engine validate latest to record the first one.',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('latest resolves the newest ask receipt by receipt time', () => {
  const root = tempRoot();
  try {
    writeAskReceipt(root, 'engine-ask-z-old-name.json', { at: '2026-08-12T20:00:00.000Z' });
    const newest = writeAskReceipt(root, 'engine-ask-a-new-name.json', { at: '2026-08-12T21:00:00.000Z' });
    assert.equal(resolveAskReceipt(root, 'latest').receiptPath, newest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed fake referee output records unsure and ends with stronger-judge guidance', async () => {
  const root = tempRoot();
  const output = [];
  try {
    writeAskReceipt(root, 'engine-ask-source.json', { at: '2026-08-12T20:00:00.000Z' });
    const code = await runEngineValidateCommand(['latest'], root, {
      log: (line) => output.push(String(line)),
      executeAskJob: () => runAskProcess(fakeReplyInvocation('looks fine'), { cwd: root, timeoutMs: 1000 }),
    });
    assert.equal(code, 0);
    assert.match(output[0], /codex: unsure/);
    assert.equal(output.at(-1), 'unsure verdicts remain. try a stronger judge with atris engine ask "<original prompt and answer>" --engine fable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

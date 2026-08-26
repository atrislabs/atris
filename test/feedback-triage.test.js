'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TRIAGE_VERDICTS,
  planFeedbackTriage,
  dispatchFeedbackTriage,
  recordFeedbackTriageVerdict,
  triageLedgerPath,
} = require('../lib/feedback-triage');
const { triageFeedback } = require('../commands/feedback');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-feedback-triage-'));
}

function fixtureFeedback() {
  return {
    id: 'feed-12345678',
    message: [
      'Resolved feedback remains visible in the open queue.',
      'Steps to reproduce:',
      '1. Resolve a feedback row.',
      '2. Run atris feedback list.',
      '3. Observe the resolved row in the open queue.',
      'Expected: only open feedback is shown.',
    ].join('\n'),
    context: {
      verify_command: 'node --test test/feedback-triage.test.js',
    },
  };
}

test('a feedback row produces reproduction steps, a verifier, and the three-verdict contract', () => {
  const root = tempRoot();
  try {
    const brief = planFeedbackTriage(fixtureFeedback(), root);
    assert.deepEqual(brief.steps_to_reproduce, [
      'Resolve a feedback row.',
      'Run atris feedback list.',
      'Observe the resolved row in the open queue.',
    ]);
    assert.equal(brief.verify_command, 'node --test test/feedback-triage.test.js');
    assert.deepEqual(brief.allowed_verdicts, TRIAGE_VERDICTS);
    for (const verdict of TRIAGE_VERDICTS) {
      assert.match(brief.prompt, new RegExp(verdict));
      assert.ok(brief.verdict_contract[verdict]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verdict recording appends one row per feedback id', () => {
  const root = tempRoot();
  try {
    const first = recordFeedbackTriageVerdict(fixtureFeedback(), root, {
      verdict: 'reproduced',
      evidence: 'The queue still contains the resolved fixture.\nverdict: reproduced',
      verify_command: 'node --test test/feedback-triage.test.js',
      engine: 'codex',
    }, { now: () => new Date('2026-08-26T17:00:00.000Z') });
    const duplicate = recordFeedbackTriageVerdict(fixtureFeedback(), root, {
      verdict: 'cannot reproduce',
      evidence: 'A later duplicate attempt must not append another row.',
    });

    assert.equal(first.appended, true);
    assert.equal(duplicate.appended, false);
    assert.equal(duplicate.record.verdict, 'reproduced');
    const lines = fs.readFileSync(triageLedgerPath(root), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), first.record);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed feedback and invalid verdicts fail with honest errors', () => {
  const root = tempRoot();
  try {
    assert.throws(() => planFeedbackTriage(null, root), /needs a feedback row object/);
    assert.throws(() => planFeedbackTriage({ message: 'missing id' }, root), /needs a feedback id/);
    assert.throws(() => planFeedbackTriage({ id: 'feed-empty', message: '  ' }, root), /has no report text/);
    assert.throws(
      () => recordFeedbackTriageVerdict(fixtureFeedback(), root, { verdict: 'probably', evidence: 'guess' }),
      /verdict must be one of/
    );
    assert.equal(fs.existsSync(triageLedgerPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch uses the injected engine path and the command uses injected feedback data', async () => {
  const root = tempRoot();
  try {
    const brief = planFeedbackTriage(fixtureFeedback(), root);
    const engineCalls = [];
    const dispatched = await dispatchFeedbackTriage(brief, root, {
      resolveEngine: () => ({ engine: { id: 'codex' } }),
      dispatch: async (jobs, options) => {
        engineCalls.push({ jobs, options });
        return [{
          ...jobs[0],
          ok: true,
          stdout: 'The fixture fails on step 3.\nverdict: reproduced',
          stderr: '',
        }];
      },
    });
    assert.equal(dispatched.verdict, 'reproduced');
    assert.equal(engineCalls.length, 1);
    assert.equal(engineCalls[0].options.root, root);
    assert.match(engineCalls[0].jobs[0].prompt, /Reproduce this feedback before a human reads it/);

    let fetchCalls = 0;
    let dispatchCalls = 0;
    const output = [];
    const commandResult = await triageFeedback('feed-1234', {
      workspace: root,
      token: 'fixture-token',
      dispatch: true,
      fetchFeedbackItems: async () => {
        fetchCalls += 1;
        return [fixtureFeedback()];
      },
      dispatchFeedbackTriage: async () => {
        dispatchCalls += 1;
        return {
          verdict: 'already fixed on master',
          evidence: 'The regression test passes on origin/master.\nverdict: already fixed on master',
          engine: 'codex',
        };
      },
      write: (line) => output.push(line),
    });
    assert.equal(fetchCalls, 1);
    assert.equal(dispatchCalls, 1);
    assert.equal(commandResult.verdict.record.verdict, 'already fixed on master');
    assert.match(output.join('\n'), /steps to reproduce:/);
    assert.match(output.join('\n'), /recorded: \.atris\/state\/feedback-triage\.jsonl/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

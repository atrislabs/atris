'use strict';
require('./helpers/clean-temp');

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-aeo-command-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.ATRIS_BACKEND_ROOT = path.join(scratch, 'missing-backend');
delete process.env.ATRIS_BACKEND_DIR;
delete process.env.ATRIS_AEO_ROOT;

const { run } = require('../commands/aeo');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function workspace() {
  const root = fs.mkdtempSync(path.join(scratch, 'ws-'));
  const proof = path.join(root, 'atris', 'features', 'aeo', 'proof');
  const attempts = path.join(proof, 'live-citation-attempts');
  fs.mkdirSync(attempts, { recursive: true });
  fs.writeFileSync(path.join(attempts, 'broken.json'), '{not json');
  fs.writeFileSync(path.join(attempts, 'notes.txt'), 'ignore me');
  writeJson(path.join(attempts, 'empty.json'), { engine: 'noop' });
  writeJson(path.join(attempts, 'chatgpt.json'), {
    attempted_at: '2026-01-01T00:00:00Z',
    engine: 'chatgpt',
    target_entity: 'Atris',
    target_url_candidates: ['https://atris.ai'],
    attempts: [{
      prompt_id: 'old-prompt',
      exact_prompt: 'old question',
      answer_cites_target_url: false,
      answer_mentions_target_entity: false,
      observed_competitor_or_alternative_entities: [],
    }],
  });
  writeJson(path.join(attempts, 'perplexity.json'), {
    attempted_at: '2026-06-15T08:30:00Z',
    engine: 'Perplexity',
    target_entity: 'Atris',
    target_url_candidates: ['https://atris.ai/aeo'],
    attempts: [
      {
        prompt_id: 'cite-prompt',
        exact_prompt: 'who cites atris',
        answer_evidence_uri: 'note://cite',
        answer_cites_target_url: true,
        answer_mentions_target_entity: true,
        observed_competitor_or_alternative_entities: ['Rival'],
      },
      {
        prompt_id: 'mention-prompt',
        exact_prompt: 'who mentions atris',
        answer_cites_target_url: false,
        answer_mentions_target_entity: true,
        observed_competitor_or_alternative_entities: 'nope',
      },
      null,
    ],
  });
  writeJson(path.join(proof, 'pricing-buyer-packet', 'packet.json'), {
    surface: 'pricing page',
    target_url: 'https://atris.ai/pricing',
    claim_status: 'draft',
    agent_usability: {
      baseline_score: 3,
      proposed_score: 8,
      score_delta: 5,
      movement_verified: false,
      positioning: 'clear offer',
      baseline_friction_points: [
        { severity: 'high', stage: 'discover', missing_artifact: 'llms.txt' },
        null,
        'skip-me',
      ],
      fix_backlog: [
        { priority: 1, stage: 'discover', action: 'add llms.txt' },
      ],
    },
  });
  writeJson(path.join(proof, 'live-citation-operator', 'live-citation-operator.json'), {
    status: 'blocked',
    current_blocker: 'no live key',
  });
  return root;
}

async function capture(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...parts) => { logs.push(parts.map((part) => String(part)).join(' ')); };
  console.error = (...parts) => { errors.push(parts.map((part) => String(part)).join(' ')); };
  process.exit = (code) => {
    const err = new Error(`exit:${code}`);
    err.exitCode = code;
    throw err;
  };
  try {
    await fn();
    return { logs, errors, exitCode: null };
  } catch (err) {
    if (err && typeof err.exitCode === 'number') {
      return { logs, errors, exitCode: err.exitCode };
    }
    throw err;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
}

async function withRoot(root, fn) {
  const prev = process.env.ATRIS_AEO_ROOT;
  process.env.ATRIS_AEO_ROOT = root;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ATRIS_AEO_ROOT;
    else process.env.ATRIS_AEO_ROOT = prev;
  }
}

test.describe('aeo command', { concurrency: 1 }, () => {
  test('help and script usage print the real commands and return', async () => {
    const help = await capture(() => run([]));
    const text = help.logs.join('\n');
    assert.strictEqual(help.exitCode, null);
    assert.ok(text.includes('atris aeo scan <url> [--vs <competitor-url>] [--json]'));
    assert.ok(text.includes('atris aeo draft  "<topic>" [--workspace <slug>] [--queries q1,q2] [--slug X] [--url URL]'));
    assert.ok(text.includes('atris aeo log    [--engine X] [--limit N] [--json]'));
    assert.ok(text.includes('atris aeo packet <slug> [--json]'));
    assert.ok(text.includes('atris aeo discover <source> [--question Q ...] [--canonical-url URL] [--out-dir DIR]'));
    assert.ok(text.includes('atris aeo log --engine perplexity --limit 5'));

    const flagged = await capture(() => run(['--help']));
    assert.strictEqual(flagged.exitCode, null);
    assert.strictEqual(flagged.logs.join('\n'), text);

    const discover = await capture(() => run(['discover']));
    assert.strictEqual(discover.exitCode, null);
    assert.strictEqual(
      discover.logs.join('\n'),
      'Usage: atris aeo discover <source> [--question Q]... [--canonical-url URL] [--out-dir DIR] [--json]'
    );

    const audit = await capture(() => run(['audit', '-h']));
    assert.strictEqual(audit.exitCode, null);
    assert.strictEqual(
      audit.logs.join('\n'),
      'Usage: atris aeo audit <source> [--baseline B] [--canonical-url URL] [--out-dir DIR] [--task T]'
    );
  });

  test('log classifies, filters, and limits citation attempts from the local workspace', async () => {
    const root = workspace();
    const cited = {
      file: 'perplexity.json',
      attempted_at: '2026-06-15T08:30:00Z',
      engine: 'Perplexity',
      prompt_id: 'cite-prompt',
      prompt: 'who cites atris',
      target_entity: 'Atris',
      target_urls: ['https://atris.ai/aeo'],
      answer_evidence_uri: 'note://cite',
      status: 'verified',
      competitors: ['Rival'],
    };
    const mentioned = {
      file: 'perplexity.json',
      attempted_at: '2026-06-15T08:30:00Z',
      engine: 'Perplexity',
      prompt_id: 'mention-prompt',
      prompt: 'who mentions atris',
      target_entity: 'Atris',
      target_urls: ['https://atris.ai/aeo'],
      answer_evidence_uri: '',
      status: 'pending',
      competitors: [],
    };
    const failed = {
      file: 'chatgpt.json',
      attempted_at: '2026-01-01T00:00:00Z',
      engine: 'chatgpt',
      prompt_id: 'old-prompt',
      prompt: 'old question',
      target_entity: 'Atris',
      target_urls: ['https://atris.ai'],
      answer_evidence_uri: '',
      status: 'failed',
      competitors: [],
    };

    const all = await withRoot(root, () => capture(() => run(['log', '--json'])));
    assert.strictEqual(all.exitCode, null);
    assert.deepStrictEqual(JSON.parse(all.logs.join('\n')), [cited, mentioned, failed]);
    assert.ok(all.errors.some((line) => line.includes('malformed JSON') && line.includes('broken.json')));

    const filtered = await withRoot(root, () => capture(() => run([
      'log', '--json', '--engine=perplexity', '--limit', '1',
    ])));
    assert.strictEqual(filtered.exitCode, null);
    assert.deepStrictEqual(JSON.parse(filtered.logs.join('\n')), [cited]);

    const printed = await withRoot(root, () => capture(() => run(['log', '--engine', 'CHATGPT'])));
    const printedText = printed.logs.join('\n');
    assert.strictEqual(printed.exitCode, null);
    assert.ok(printedText.includes('AEO citation log (1 attempt)'));
    assert.ok(printedText.includes('failed=1'));
    assert.ok(printedText.includes('old-prompt'));
    assert.ok(!printedText.includes('cite-prompt'));

    const emptyRoot = fs.mkdtempSync(path.join(scratch, 'empty-'));
    fs.mkdirSync(path.join(emptyRoot, 'atris', 'features', 'aeo'), { recursive: true });
    const empty = await withRoot(emptyRoot, () => capture(() => run(['log'])));
    assert.strictEqual(empty.exitCode, null);
    assert.strictEqual(empty.logs.join('\n'), 'No citation attempts found.');
  });

  test('status, packet, and proofs report the local proof files', async () => {
    const root = workspace();

    const status = await withRoot(root, () => capture(() => run(['status', '--json'])));
    assert.strictEqual(status.exitCode, null);
    const summary = JSON.parse(status.logs.join('\n'));
    assert.strictEqual(summary.backend_root, root);
    assert.strictEqual(summary.proof_dirs, 3);
    assert.deepStrictEqual(summary.citation, {
      total: 3,
      verified: 1,
      pending: 1,
      failed: 1,
      engines: ['Perplexity', 'chatgpt'],
    });
    assert.deepStrictEqual(summary.packets, [{
      slug: 'pricing',
      surface: 'pricing page',
      target_url: 'https://atris.ai/pricing',
      baseline: 3,
      proposed: 8,
      claim_status: 'draft',
    }]);
    assert.strictEqual(summary.operator_status, 'blocked');
    assert.strictEqual(summary.operator_blocker, 'no live key');

    const packet = await withRoot(root, () => capture(() => run(['packet', 'pricing'])));
    const packetText = packet.logs.join('\n');
    assert.strictEqual(packet.exitCode, null);
    assert.ok(packetText.includes('AEO buyer packet, pricing'));
    assert.ok(packetText.includes('surface:        pricing page'));
    assert.ok(packetText.includes('target url:     https://atris.ai/pricing'));
    assert.ok(packetText.includes('claim status:   draft'));
    assert.ok(packetText.includes('positioning:    clear offer'));
    assert.ok(packetText.includes('baseline:       3'));
    assert.ok(packetText.includes('proposed:       8'));
    assert.ok(packetText.includes('delta:          5'));
    assert.ok(packetText.includes('verified:       no'));
    assert.ok(packetText.includes('Baseline friction (1)'));
    assert.ok(packetText.includes('[high] discover: llms.txt'));
    assert.ok(packetText.includes('Fix backlog (1)'));
    assert.ok(packetText.includes('#1 discover: add llms.txt'));
    assert.ok(!packetText.includes('skip-me'));

    const packetJson = await withRoot(root, () => capture(() => run(['packet', 'pricing', '--json'])));
    assert.strictEqual(packetJson.exitCode, null);
    const packetData = JSON.parse(packetJson.logs.join('\n'));
    assert.strictEqual(packetData.claim_status, 'draft');
    assert.strictEqual(packetData.agent_usability.score_delta, 5);

    const proofs = await withRoot(root, () => capture(() => run(['proofs'])));
    const proofText = proofs.logs.join('\n');
    assert.strictEqual(proofs.exitCode, null);
    assert.ok(proofText.includes('AEO proof receipts at '));
    assert.ok(proofText.includes('live-citation-attempts'));
    assert.ok(proofText.includes('4 files'));
    assert.ok(proofText.includes('pricing-buyer-packet'));
    assert.ok(proofText.includes('1 file'));
    assert.ok(proofText.includes('live-citation-operator'));

    const filtered = await withRoot(root, () => capture(() => run(['proofs', '--filter', 'BUYER'])));
    const filteredText = filtered.logs.join('\n');
    assert.strictEqual(filtered.exitCode, null);
    assert.ok(filteredText.includes('pricing-buyer-packet'));
    assert.ok(!filteredText.includes('live-citation-attempts'));
  });

  test('bad arguments exit with the command error and do not read a workspace', async () => {
    const missing = await capture(() => run(['log']));
    assert.strictEqual(missing.exitCode, 1);
    assert.ok(missing.errors.some((line) => line.includes('cannot find local aeo workspace')));

    const limit = await capture(() => run(['log', '--limit', '0']));
    assert.strictEqual(limit.exitCode, 1);
    assert.ok(limit.errors.some((line) => line.includes('Invalid --limit value: "0"')));

    const flag = await capture(() => run(['log', '--limit']));
    assert.strictEqual(flag.exitCode, 1);
    assert.ok(flag.errors.some((line) => line.includes('Flag --limit requires a value.')));

    const extra = await capture(() => run(['log', 'extra']));
    assert.strictEqual(extra.exitCode, 1);
    assert.ok(extra.errors.some((line) => line.includes('Unexpected argument for aeo log: extra')));

    const unknownFlag = await capture(() => run(['status', '--nope']));
    assert.strictEqual(unknownFlag.exitCode, 1);
    assert.ok(unknownFlag.errors.some((line) => line.includes('Unknown flag for aeo status: --nope')));

    const packet = await capture(() => run(['packet']));
    assert.strictEqual(packet.exitCode, 1);
    assert.ok(packet.errors.some((line) => line.includes('Missing slug. Usage: atris aeo packet <slug>')));

    const unknown = await capture(() => run(['nope']));
    assert.strictEqual(unknown.exitCode, 1);
    assert.ok(unknown.errors.some((line) => line.includes('Unknown aeo subcommand: nope')));
    assert.ok(unknown.logs.join('\n').includes('atris aeo status [--json]'));
  });
});

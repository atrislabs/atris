#!/usr/bin/env node
'use strict';

// Blind pairwise judge on a different model (codex), both orders. See README.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const HERE = __dirname;
const OUT = path.join(HERE, process.env.AMB_OUT || 'out');
const PAIRS = [['skill', 'nudge'], ['skill', 'plain'], ['nudge', 'plain']];
// The scratch folder and answer schema are made on first use, so loading
// this file (the gate does) writes nothing.
let scratch = null;
function workdir() {
  if (scratch) return scratch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-judge-'));
  const schema = path.join(dir, 'schema.json');
  fs.writeFileSync(schema, JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['winner', 'x_grew_scope', 'y_grew_scope', 'reason'],
    properties: {
      winner: { type: 'string', enum: ['X', 'Y', 'tie'] },
      x_grew_scope: { type: 'boolean' },
      y_grew_scope: { type: 'boolean' },
      reason: { type: 'string' },
    },
  }));
  scratch = { dir, schema };
  return scratch;
}

function prompt(task, field, x, y) {
  return `You are a top professional in ${field}. Someone asked:

<ask>
${task}
</ask>

Two answers follow. Pick the one that would serve this person better if they acted on it today, judged by what a top professional in ${field} would accept.

Rules:
- Length is not a virtue. Padding, repetition, and generic advice count against an answer.
- Substance counts: correct methods, real checks, concrete next steps, things the person did not think to ask for but needed.
- Mark grew_scope true for an answer that turns the ask into a materially bigger job (new deliverables, a project where a single piece was asked for). Depth inside the same deliverable is not scope growth.
- Say tie only if you truly cannot separate them.

<answer_X>
${x}
</answer_X>

<answer_Y>
${y}
</answer_Y>

Reply with JSON only: winner (X, Y, or tie), x_grew_scope, y_grew_scope, reason (one sentence).`;
}

async function codex(text, tag) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await codexOnce(text, tag); } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 20000 * attempt));
    }
  }
}

function codexOnce(text, tag) {
  const { dir, schema } = workdir();
  const last = path.join(dir, `${tag}.txt`);
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--output-schema', schema, '-o', last, '-'];
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    // Codex calls sometimes hang with no output; cut them off and retry.
    const timer = setTimeout(() => { err += ' timed out'; child.kill('SIGKILL'); }, Number(process.env.AMB_JUDGE_TIMEOUT_MS || 240000));
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end(text);
    child.on('close', (code) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(fs.readFileSync(last, 'utf8'))); } catch (e) { reject(new Error(`codex exit ${code}: ${err.slice(-300)}`)); }
    });
  });
}

// A verdict is valid only for the exact ask and answers it judged.
function verdictKey(rec, a, b) {
  return crypto.createHash('sha256').update(JSON.stringify([prompt('', '', '', ''), rec.task, rec.field, rec.answers[a], rec.answers[b]])).digest('hex').slice(0, 16);
}

async function judgePair(rec, a, b) {
  const [first, second] = await Promise.all([
    codex(prompt(rec.task, rec.field, rec.answers[a], rec.answers[b]), `${rec.id}-${a}-${b}-1`),
    codex(prompt(rec.task, rec.field, rec.answers[b], rec.answers[a]), `${rec.id}-${a}-${b}-2`),
  ]);
  const pick1 = first.winner === 'X' ? a : first.winner === 'Y' ? b : 'tie';
  const pick2 = second.winner === 'X' ? b : second.winner === 'Y' ? a : 'tie';
  return {
    id: rec.id, a, b, key: verdictKey(rec, a, b),
    winner: pick1 === pick2 ? pick1 : 'tie',
    split: pick1 !== pick2,
    grew: { [a]: first.x_grew_scope || second.y_grew_scope, [b]: first.y_grew_scope || second.x_grew_scope },
    reasons: [first.reason, second.reason],
  };
}

// A saved verdict survives only if its own task and pair still hash to its key.
function keepVerdicts(records, saved) {
  const current = new Map(records.flatMap((rec) => PAIRS.map(([a, b]) => [`${rec.id}|${a}|${b}`, verdictKey(rec, a, b)])));
  return saved.filter((v) => current.get(`${v.id}|${v.a}|${v.b}`) === v.key);
}

function loadRecords(dir) {
  return fs.readdirSync(dir).filter((f) => /^[a-z0-9-]+\.json$/.test(f) && f !== 'verdicts.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

async function main() {
  const records = loadRecords(OUT);
  // Resumable: a saved verdict is kept only if it judged these exact answers.
  const saved = path.join(OUT, 'verdicts.json');
  const verdicts = keepVerdicts(records, fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')) : []);
  const done = new Set(verdicts.map((v) => `${v.id}|${v.a}|${v.b}`));
  const jobs = records.flatMap((rec) => PAIRS.filter(([a, b]) => !done.has(`${rec.id}|${a}|${b}`)).map(([a, b]) => () => judgePair(rec, a, b)));
  const workers = Array.from({ length: Number(process.env.AMB_PARALLEL || 3) }, async () => {
    while (jobs.length) {
      const job = jobs.shift();
      try { const v = await job(); verdicts.push(v); fs.writeFileSync(saved, JSON.stringify(verdicts, null, 2)); console.log(`${v.id} ${v.a} vs ${v.b}: ${v.winner}`); } catch (e) { console.error(e.message); process.exitCode = 1; }
    }
  });
  await Promise.all(workers);

  const wc = (s) => s.split(/\s+/).filter(Boolean).length;
  console.log('\nsummary');
  for (const [a, b] of PAIRS) {
    const vs = verdicts.filter((v) => v.a === a && v.b === b);
    const n = (w) => vs.filter((v) => v.winner === w).length;
    console.log(`${a} vs ${b}: ${a} ${n(a)}, ${b} ${n(b)}, tie ${n('tie')} (splits ${vs.filter((v) => v.split).length})`);
  }
  for (const arm of ['plain', 'nudge', 'skill']) {
    const grew = new Set(verdicts.filter((v) => v.grew[arm]).map((v) => v.id)).size;
    const words = records.map((r) => wc(r.answers[arm]));
    const median = words.sort((x, y) => x - y)[Math.floor(words.length / 2)];
    console.log(`${arm}: scope growth flagged on ${grew}/${records.length} tasks, median words ${median}`);
  }
}

if (require.main === module) main();

module.exports = { PAIRS, verdictKey, keepVerdicts, loadRecords };

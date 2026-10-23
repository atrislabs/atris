'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSqliteStore, getCampaign } = require('../lib/campaign-store');
const { captureCodeBaseline, collectCodeProvenance } = require('../lib/mission-code-provenance');
const { latestJudgeOutput } = require('../lib/campaign-reading');
const { proposalPrompt } = require('../lib/campaign-loop');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const quoted = value => "'" + value.replace(/'/g, "'\\''") + "'";
const gradedJudge = summary => `exec ${quoted(process.execPath)} -e ${quoted(
  "console.log('reading: '+require('fs').readFileSync('product.txt','utf8').trim());" +
  `console.log(${JSON.stringify(summary)});process.exit(1)`
)}`;

function campaign(t, score, summary) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-judge-baseline-'));
  const home = process.env.HOME;
  const callerPath = process.env.PATH;
  let calls = 0;
  t.after(() => {
    assert.equal(process.env.HOME, home);
    assert.equal(process.env.PATH, callerPath);
    t.diagnostic(`actual campaign CLI calls: ${calls}; no engine dispatched`);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, ATRIS_TEST_STATE_DIR: path.join(root, '.atris', 'owned-user-state'),
    ATRIS_CAMPAIGN_DB: path.join(root, '.atris', 'state', 'atris.db'),
    ATRIS_RSI_STATE: path.join(root, '.atris', 'state', 'rsi'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.ATRIS_RSI_ATTEMPT_NODE;
  const run = (args, expected = 0, lines = false) => {
    const child = spawnSync(process.execPath, [CLI, 'campaign', ...args, '--as', 'owner', '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    calls++;
    assert.ifError(child.error);
    assert.equal(child.status, expected, child.stderr || child.stdout);
    return lines ? child.stdout.trim().split('\n').map(JSON.parse) : JSON.parse(child.stdout);
  };
  const git = args => {
    const child = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return child.stdout.trim();
  };
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\natris/runs/\natris/campaigns/\n');
  fs.writeFileSync(path.join(root, 'product.txt'), `${score}\n`);
  git(['init', '-q']);
  git(['config', 'user.name', 'Owned Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['add', '.']);
  git(['commit', '-qm', 'owned baseline']);
  const id = 'cmp-baseline';
  const command = gradedJudge(summary);
  const started = run(['start', 'Preserve measured baselines', '--judge', command, '--owner', 'owner',
    '--seat', 'worker', '--budget', '10', '--id', id]);
  assert.equal(started.campaign.last_judge.reading, score, 'the actual initial judge recognizes its explicit score');
  const snapshot = () => {
    const store = createSqliteStore(env.ATRIS_CAMPAIGN_DB);
    try { return { events: store.read(id), view: getCampaign(store, id) }; }
    finally { store.close(); }
  };
  const sourceMission = (missionId, productScore = null) => {
    run(['event', id, 'mission_started', '--data', JSON.stringify({ mission_id: missionId, member: 'worker' })]);
    const baseline = captureCodeBaseline(root);
    assert.equal(baseline.status, 'complete');
    const file = `${missionId}.js`;
    fs.writeFileSync(path.join(root, file), "module.exports = () => 'owned source change';\n");
    if (productScore !== null) fs.writeFileSync(path.join(root, 'product.txt'), `${productScore}\n`);
    const files = [file, ...(productScore === null ? [] : ['product.txt'])];
    git(['add', '--', ...files]);
    git(['commit', '-qm', 'owned source change after reset']);
    const proof = collectCodeProvenance(root, baseline);
    assert.equal(proof.status, 'complete');
    assert.deepEqual(proof.files, files.sort(), 'the mission has a real complete committed source change');
    run(['event', id, 'mission_ended', '--data', JSON.stringify({ mission_id: missionId, outcome: 'kept', cost_usd: 0 })]);
    const judged = run(['judge', id], 1);
    const trace = run(['export', id, '--trace', '--full'], 0, true);
    return { judged, trace, row: trace.find(row => row.action?.mission_id === missionId) };
  };
  return { root, id, command, run, snapshot, sourceMission, git, state: env.ATRIS_RSI_STATE };
}

test('actual same and replacement baselines give new unchanged work zero gain and retain the judge explanation', t => {
  const c = campaign(t, 0.8, 'private baseline diagnostic');
  const product = fs.readFileSync(path.join(c.root, 'product.txt'));
  const stages = [];
  for (const [missionId, command, summary] of [
    ['same', c.command, 'private baseline diagnostic'],
    ['replacement', gradedJudge('private replacement diagnostic'), 'private replacement diagnostic'],
  ]) {
    c.run(['set-judge', c.id, command]);
    const baseline = c.snapshot();
    const baselineRun = baseline.events.filter(event => event.type === 'judge_ran').at(-1);
    const result = c.sourceMission(missionId);
    assert.equal(result.judged.reading.reading, 0.8, 'the real post-work measurement is unchanged');
    stages.push({ baseline, baselineRun, result, summary });
  }
  assert.deepEqual(fs.readFileSync(path.join(c.root, 'product.txt')), product);
  const zeroReport = c.run(['rsi', c.id, '--next', '--no-write']);
  const zeroView = c.snapshot().view;
  const zeroPrompt = proposalPrompt(zeroView, 1, null, zeroReport.rsi.lessons.join('\n'), zeroReport.rsi);
  const genuine = c.sourceMission('genuine', 0.9);
  assert.equal(genuine.judged.reading.reading, 0.9);
  assert.equal(genuine.row.reward, 0.1, 'a real improvement after the new baseline still earns its measured gain');
  const beforeReads = c.snapshot().events;
  const redacted = c.run(['export', c.id, '--trace'], 0, true);
  assert.deepEqual(c.snapshot().events, beforeReads, 'export must preserve stored event records');
  for (const marker of ['private baseline diagnostic', 'private replacement diagnostic']) {
    assert.ok(!JSON.stringify(redacted).includes(marker), 'redacted traces must not expose output tails');
  }
  assert.deepEqual(stages.map(stage => stage.result.row.reward), [0, 0],
    'new missions start after the reset and cannot gain from losing a known baseline score');
  for (const { baseline, baselineRun, result, summary } of stages) {
    assert.equal(baselineRun.data.reading, 0.8);
    assert.equal(baselineRun.data.summary, summary);
    assert.match(baselineRun.data.output_tail, /reading: 0\.8\nprivate .* diagnostic/);
    assert.equal(latestJudgeOutput(baseline.events), baselineRun.data.output_tail);
    assert.ok(proposalPrompt(baseline.view, 1, latestJudgeOutput(baseline.events)).includes(summary),
      'the next planner can read the actual reset explanation');
    assert.equal(result.row.reading_before, 0.8);
    assert.equal(result.row.reading_after, 0.8);
  }
  assert.equal(zeroReport.rsi.total_reward, 0);
  assert.equal(zeroReport.rsi.members[0].judge_passed, 0);
  assert.equal(zeroReport.rsi.members[0].status, 'unproven');
  assert.ok(!zeroReport.rsi.lessons.some(line => line.includes('gained +')));
  assert.equal(zeroReport.next_campaigns[0].lead_member, 'owner');
  assert.doesNotMatch(zeroPrompt, /worker gained \+/);
  assert.equal(fs.existsSync(path.join(c.state, 'attempts.jsonl')), false);
  assert.equal(fs.existsSync(path.join(c.state, 'dreams.jsonl')), false);
  assert.equal(c.git(['status', '--porcelain']), '');
});

for (const [score, summary] of [[0, '9 of 10 live'], [0.8, '2 of 10 live']]) {
  test(`actual reset preserves explicit ${score} over contradictory summary counts`, t => {
    const c = campaign(t, score, summary);
    c.run(['set-judge', c.id, c.command]);
    const baseline = c.snapshot();
    const result = c.sourceMission('unchanged');
    assert.equal(result.judged.reading.reading, score);
    assert.equal(result.row.reward, 0, 'an explicit score has the same meaning before and after reset');
    assert.equal(result.row.reading_before, score);
    assert.equal(result.row.reading_after, score);
    assert.equal(baseline.view.last_judge.reading, score, 'zero is a measured score, not a missing value');
    const report = c.run(['rsi', c.id, '--next', '--no-write']);
    assert.equal(report.rsi.total_reward, 0);
    assert.equal(report.rsi.members[0].judge_passed, 0);
    assert.ok(!report.rsi.lessons.some(line => line.includes('gained +')));
    assert.equal(report.next_campaigns[0].lead_member, 'owner');
  });
}

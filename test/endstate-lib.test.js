'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendResultsRow,
  buildRunId,
  buildWikiArtifact,
  collectChangedFiles,
  compareEndstateArtifacts,
  getArtifactScore,
  getGitHead,
  inferTestResults,
  readLatestArtifact,
  readTextIfExists,
  scoreEndstateArtifact,
  summarizeReview,
  writeArtifact,
} = require('../lib/endstate');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-endstate-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function freshDir() {
  const dir = path.join(TMP, `case-${counter += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fullArtifact(overrides = {}) {
  return {
    run_id: 'run-1',
    track: 'baseline',
    repo_commits: {},
    task_brief: 'ship the thing',
    prompt_context: 'ctx',
    changed_files: [],
    tests: [{ command: 'npm test', status: 'pass' }],
    review: { status: 'pass' },
    wiki: { status: 'updated' },
    elapsed_seconds: 12,
    interventions: { count: 0 },
    ...overrides,
  };
}

test('a complete, reviewed, fully passing artifact scores 100', () => {
  const { total, breakdown } = scoreEndstateArtifact(fullArtifact());
  assert.deepStrictEqual(breakdown, {
    reviewed_completion: 40,
    test_outcome: 25,
    artifact_completeness: 15,
    wiki_memory: 10,
    operator_load: 10,
  });
  assert.strictEqual(total, 100);
});

test('an empty artifact only earns the default wiki and operator-load points', () => {
  const { total, breakdown } = scoreEndstateArtifact({});
  assert.strictEqual(breakdown.reviewed_completion, 0);
  assert.strictEqual(breakdown.test_outcome, 0);
  assert.strictEqual(breakdown.artifact_completeness, 0);
  assert.strictEqual(breakdown.wiki_memory, 10);
  assert.strictEqual(breakdown.operator_load, 10);
  assert.strictEqual(total, 20);
});

test('score ignores not_run tests, rounds the pass ratio, and docks 2 points per intervention', () => {
  const partial = scoreEndstateArtifact(fullArtifact({
    tests: [
      { command: 'a', status: 'pass' },
      { command: 'b', status: 'fail' },
      { command: 'c', status: 'not_run' },
    ],
    interventions: { count: 3 },
  }));
  assert.strictEqual(partial.breakdown.test_outcome, 13);
  assert.strictEqual(partial.breakdown.operator_load, 4);

  const noneRun = scoreEndstateArtifact(fullArtifact({ tests: [{ command: 'a', status: 'not_run' }] }));
  assert.strictEqual(noneRun.breakdown.test_outcome, 0);

  const swamped = scoreEndstateArtifact(fullArtifact({ interventions: { count: 10 } }));
  assert.strictEqual(swamped.breakdown.operator_load, 0);
});

test('a missing wiki earns no memory points and missing fields lower completeness', () => {
  const missingWiki = scoreEndstateArtifact(fullArtifact({ wiki: { status: 'missing' } }));
  assert.strictEqual(missingWiki.breakdown.wiki_memory, 0);
  assert.strictEqual(missingWiki.total, 90);

  const sparse = scoreEndstateArtifact({ run_id: 'x', track: 'stack', tests: [], review: { status: 'draft' }, wiki: { status: 'updated' } });
  assert.strictEqual(sparse.breakdown.artifact_completeness, 7);
  assert.strictEqual(sparse.breakdown.reviewed_completion, 0);
});

test('getArtifactScore prefers a stored numeric score over recomputing', () => {
  assert.strictEqual(getArtifactScore(fullArtifact({ score: 42 })), 42);
  assert.strictEqual(getArtifactScore(fullArtifact({ score: '42' })), 100);
  assert.strictEqual(getArtifactScore(fullArtifact()), 100);
});

test('compareEndstateArtifacts: the stack wins only with a higher score and no lost review', () => {
  const wins = compareEndstateArtifacts(
    { artifact: fullArtifact({ score: 70 }) },
    { artifact: fullArtifact({ score: 80 }) },
  );
  assert.strictEqual(wins.winner, 'stack');
  assert.strictEqual(wins.leader, 'stack');
  assert.strictEqual(wins.baselineScore, 70);
  assert.strictEqual(wins.stackScore, 80);
  assert.match(wins.reason, /Stack leads 80 to 70/);

  const tie = compareEndstateArtifacts(
    { artifact: fullArtifact({ score: 70 }) },
    { artifact: fullArtifact({ score: 70 }) },
  );
  assert.strictEqual(tie.winner, 'none');
  assert.strictEqual(tie.leader, 'tie');
  assert.match(tie.reason, /tied at 70\/100/);

  const behind = compareEndstateArtifacts(
    { artifact: fullArtifact({ score: 90 }) },
    { artifact: fullArtifact({ score: 60 }) },
  );
  assert.strictEqual(behind.winner, 'none');
  assert.strictEqual(behind.leader, 'baseline');
  assert.match(behind.reason, /Baseline leads 90 to 60/);
});

test('compareEndstateArtifacts: a higher score does not win if reviewed completion was lost', () => {
  const result = compareEndstateArtifacts(
    { artifact: fullArtifact({ score: 60, review: { status: 'pass' } }) },
    { artifact: fullArtifact({ score: 75, review: { status: 'draft' } }) },
  );
  assert.strictEqual(result.winner, 'none');
  assert.strictEqual(result.leader, 'stack');
  assert.match(result.reason, /lost reviewed completion/);
});

test('inferTestResults reads status from known test commands only', () => {
  const results = inferTestResults([
    'npm test passed',
    'pytest: 3 failed',
    'cargo test clean',
    'ran npm run lint',
    'edited the README',
    'node --test passed then failed',
  ].join('\n'));

  assert.deepStrictEqual(results, [
    { command: 'npm test passed', status: 'pass' },
    { command: 'pytest: 3 failed', status: 'fail' },
    { command: 'cargo test clean', status: 'pass' },
    { command: 'ran npm run lint', status: 'not_run' },
    { command: 'node --test passed then failed', status: 'fail' },
  ]);
});

test('inferTestResults falls back to one not_run placeholder when nothing matches', () => {
  const expected = [{ command: '(no explicit test command captured)', status: 'not_run' }];
  assert.deepStrictEqual(inferTestResults('just prose here'), expected);
  assert.deepStrictEqual(inferTestResults(''), expected);
  assert.deepStrictEqual(inferTestResults(undefined), expected);
});

test('summarizeReview collapses whitespace and truncates long text to 400 characters', () => {
  assert.strictEqual(summarizeReview('  looks \n\n  good\tto me  '), 'looks good to me');
  assert.strictEqual(summarizeReview('   '), 'no review output captured');
  assert.strictEqual(summarizeReview(null), 'no review output captured');

  const exact = 'a'.repeat(400);
  assert.strictEqual(summarizeReview(exact), exact);

  const long = summarizeReview('b'.repeat(500));
  assert.strictEqual(long.length, 400);
  assert.ok(long.endsWith('...'));
  assert.strictEqual(long.slice(0, 397), 'b'.repeat(397));
});

test('buildWikiArtifact reports missing, not_applicable, or updated', () => {
  assert.deepStrictEqual(buildWikiArtifact(null, null), { status: 'missing' });
  assert.deepStrictEqual(buildWikiArtifact('', ''), { status: 'missing' });
  assert.deepStrictEqual(buildWikiArtifact('same', 'same'), { status: 'not_applicable', before: 'same', after: 'same' });
  assert.deepStrictEqual(buildWikiArtifact('old', 'new'), { status: 'updated', before: 'old', after: 'new' });
  assert.deepStrictEqual(buildWikiArtifact(null, 'fresh'), { status: 'updated', before: '', after: 'fresh' });
});

test('buildRunId is a filename-safe timestamp ending in the track', () => {
  const id = buildRunId('stack');
  assert.match(id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-stack$/);
  assert.ok(!/[:.]/.test(id));
});

test('readTextIfExists returns file text, or null for empty and missing paths', () => {
  const dir = freshDir();
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'hello\n');
  assert.strictEqual(readTextIfExists(file), 'hello\n');
  assert.strictEqual(readTextIfExists(path.join(dir, 'nope.txt')), null);
  assert.strictEqual(readTextIfExists(''), null);
  assert.strictEqual(readTextIfExists(undefined), null);
});

test('git helpers return empty results for a directory that does not exist', () => {
  const missing = path.join(freshDir(), 'not-a-repo');
  assert.strictEqual(getGitHead(missing), null);
  assert.strictEqual(getGitHead(null), null);
  assert.deepStrictEqual(collectChangedFiles(missing, 'aaa', 'bbb', 'repo/'), []);
});

test('writeArtifact creates the artifacts dir and readLatestArtifact returns the newest run', () => {
  const pack = freshDir();
  const older = fullArtifact({ run_id: '2026-01-01T00-00-00-000Z-baseline' });
  const newer = fullArtifact({ run_id: '2026-02-01T00-00-00-000Z-stack', track: 'stack' });

  const newerPath = writeArtifact(pack, newer);
  const olderPath = writeArtifact(pack, older);
  assert.strictEqual(newerPath, path.join(pack, 'artifacts', `${newer.run_id}.json`));
  assert.ok(fs.existsSync(olderPath));

  fs.writeFileSync(path.join(pack, 'artifacts', 'zzz-notes.txt'), 'not json');

  const latest = readLatestArtifact(pack);
  assert.strictEqual(latest.filePath, newerPath);
  assert.deepStrictEqual(latest.artifact, newer);
});

test('readLatestArtifact throws a clear error when there is nothing to read', () => {
  const noDir = freshDir();
  assert.throws(() => readLatestArtifact(noDir), /No artifacts found at .*artifacts/);

  const emptyDir = freshDir();
  fs.mkdirSync(path.join(emptyDir, 'artifacts'));
  fs.writeFileSync(path.join(emptyDir, 'artifacts', 'readme.md'), 'x');
  assert.throws(() => readLatestArtifact(emptyDir), /No artifact JSON files found at/);
});

test('appendResultsRow writes the header once, then one clean tab-separated row per call', () => {
  const dir = freshDir();
  const resultsPath = path.join(dir, 'results.tsv');
  const artifactPath = path.join(dir, 'artifacts', 'run-1.json');
  const artifact = fullArtifact({
    task_brief: 'fix\tthe\nbug',
    notes: 'multi\r\nline note',
    tests: [
      { command: 'a', status: 'pass' },
      { command: 'b', status: 'fail' },
      { command: 'c', status: 'not_run' },
    ],
    interventions: { count: 2 },
  });
  const score = scoreEndstateArtifact(artifact);

  appendResultsRow(resultsPath, artifactPath, artifact, score);
  appendResultsRow(resultsPath, artifactPath, fullArtifact({ review: undefined, tests: [] }), { total: 5 });

  const lines = fs.readFileSync(resultsPath, 'utf8').split('\n');
  assert.strictEqual(lines.pop(), '');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], 'timestamp\ttrack\trepo\ttask\tstatus\tscore\treviewed\ttests\tartifacts\tinterventions\tnotes');

  const first = lines[1].split('\t');
  assert.strictEqual(first.length, 11);
  assert.match(first[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.strictEqual(first[1], 'baseline');
  assert.strictEqual(first[2], 'atris-cli+atrisos-backend');
  assert.strictEqual(first[3], 'fix the bug');
  assert.strictEqual(first[4], 'pass');
  assert.strictEqual(first[5], String(score.total));
  assert.strictEqual(first[6], 'yes');
  assert.strictEqual(first[7], '1/2 pass');
  assert.strictEqual(first[8], path.join('artifacts', 'run-1.json'));
  assert.strictEqual(first[9], '2');
  assert.strictEqual(first[10], 'multi line note');

  const second = lines[2].split('\t');
  assert.strictEqual(second[4], 'draft');
  assert.strictEqual(second[5], '5');
  assert.strictEqual(second[6], 'no');
  assert.strictEqual(second[7], 'not-run');
  assert.strictEqual(second[9], '0');
  assert.strictEqual(second[10], '');
});

test('appendResultsRow restores the header when the results file exists but is blank', () => {
  const dir = freshDir();
  const resultsPath = path.join(dir, 'results.tsv');
  fs.writeFileSync(resultsPath, '  \n');

  appendResultsRow(resultsPath, path.join(dir, 'a.json'), fullArtifact(), { total: 100 });

  const lines = fs.readFileSync(resultsPath, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].startsWith('timestamp\ttrack\t'));
  assert.strictEqual(lines[1].split('\t')[8], 'a.json');
});

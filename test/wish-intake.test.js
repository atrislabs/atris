const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  analyzeWishParts,
  auditWish,
  deriveVerifyPlan,
  inferBudgetTier,
} = require('../lib/wish-audit');
const { isFrontendWish } = require('../lib/wish-design');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const engineRegistryPath = path.join(repoRoot, '.atris', 'state', 'engines.json');
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-intake-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeFakeEngines(dir) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ['codex', 'claude']) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(file, 0o755);
  }
  return binDir;
}

function withProcessEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function withRepoEngineRegistryRestored(fn) {
  const existed = fs.existsSync(engineRegistryPath);
  const previous = existed ? fs.readFileSync(engineRegistryPath, 'utf8') : '';
  try {
    return fn();
  } finally {
    if (existed) fs.writeFileSync(engineRegistryPath, previous, 'utf8');
    else fs.rmSync(engineRegistryPath, { force: true });
  }
}

function auditQuestions(text) {
  const dir = makeTempDir();
  try {
    const fakeBin = makeFakeEngines(dir);
    return withRepoEngineRegistryRestored(() => withProcessEnv({
      PATH: `${fakeBin}:${systemPath}`,
      NODE_NO_WARNINGS: '1',
    }, () => auditWish(text, repoRoot).questions));
  } finally {
    cleanupTempDir(dir);
  }
}

test('wish splitter rejects noun phrases and accepts real multi-part instructions', () => {
  const nullCases = [
    'review and merge the open PR',
    'add drag and drop support to the editor',
    'clean up the copy and paste handling in the chat box',
    'sync data between the backend and frontend services',
    'add a plus sign toggle to the settings page',
    'compare codex and cursor output quality',
    'restyle the buttons, cards and form fields',
    'rename foo to bar and baz to qux',
    'every explanation atris gives me should make sense to an ml researcher and a 2nd grade teacher at the same time',
  ];
  for (const text of nullCases) assert.equal(analyzeWishParts(text, repoRoot), null, text);

  const connector = analyzeWishParts('fix header and also fix the footer', repoRoot);
  assert.equal(connector.length, 2);
  assert.equal(connector[1].text, 'fix the footer');

  const typo = analyzeWishParts('fix the login adn update the docs', repoRoot);
  assert.equal(typo.length, 2);

  const outOfScope = analyzeWishParts('make wish list clearer and gm mode in project obelisk', repoRoot);
  assert.equal(outOfScope.length, 2);
  assert.match(outOfScope[1].waiting_reason, /project obelisk is not in this checkout/);
});

test('frontend classifier uses vetoes before visual and surface positives', () => {
  const negatives = [
    'style the JSON output of the api',
    'color-code the log levels in the terminal',
    'add a page size limit to the api',
    'button up the release process before friday',
    'the landing of the deploy script fails on retry',
    'clean up the code style in lib/tasks.js',
    'fix database sync for invoices',
    'navigate the release backlog',
  ];
  for (const text of negatives) assert.equal(isFrontendWish(text), false, text);

  const positives = [
    'make it feel less cramped',
    'the top bar shouts at me, tone it down',
    'the empty state is sad',
    'everything looks the same, boring',
    'headers are way too big on mobile',
    'app looks like a spreadsheet, make it prettier',
    'update the website copy',
    'build a landing page hero',
    'tighten the CSS button style',
  ];
  for (const text of positives) assert.equal(isFrontendWish(text), true, text);
});

test('wish clarity audit does not ask for concrete fuzzy operator language', () => {
  const clearCases = [
    'make boot 1.5s faster it takes forever right now',
    'Tonight fix the login flow so it stops flaking',
    'Ive been thinking we should fix the nav',
    'make the README clearer',
    'fix teh bug.then update docs',
    'bump the version and publish to npm',
  ];
  for (const text of clearCases) assert.deepEqual(auditQuestions(text), [], text);

  const typoQuestions = auditQuestions('fxi the login flow plz');
  assert.ok(typoQuestions.length > 0);
  assert.equal(typoQuestions.some((question) => /\bpl[sz]\b/i.test(question)), false);

  assert.ok(auditQuestions('fix the thing we talked about').length > 0);
});

test('wish grant does not mine location candidates from a consumed answer', () => {
  if (!hasNodeSqlite()) return;
  const cases = [
    { token: '749-760', answer: 'cloud sync uses 749-760 as a line-number range' },
    { token: 'Refusing', answer: 'cloud sync reports "Refusing" as the error word' },
    { token: 'reference.', answer: 'cloud sync treats reference. as ordinary prose' },
  ];

  for (const scenario of cases) {
    const dir = makeTempDir();
    try {
      prepareWorkspace(dir);
      const fakeBin = makeFakeEngines(dir);
      const env = {
        PATH: `${fakeBin}:${systemPath}`,
        ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      };
      const created = runCli(['wish', 'fix cloud sync'], { cwd: dir, env });
      assert.equal(created.status, 1, `${scenario.token}: ${created.stderr || created.stdout}`);
      assert.match(created.stdout, /Cloud sync could mean/);

      const granted = runCli(['wish', 'grant', '1', scenario.answer], { cwd: dir, env });
      assert.equal(granted.status, 0, `${scenario.token}: ${granted.stderr || granted.stdout}`);
      assert.doesNotMatch(`${granted.stdout}\n${granted.stderr}`, /Which workspace, repo, file, or team member/);

      const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
      const locationQuestions = records.filter((record) => Array.isArray(record.questions)
        && record.questions.some((question) => /Which workspace, repo, file, or team member/.test(String(question))));
      assert.equal(locationQuestions.length, 0, scenario.token);
      assert.equal(records.some((record) => record.answer === scenario.answer), true, scenario.token);
      assert.equal(records.filter((record) => record.status === 'delegated' && record.dispatched_at).length, 1, scenario.token);
    } finally {
      cleanupTempDir(dir);
    }
  }
});

test('wish answer dispatches after one named-input question subject', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const env = {
      PATH: `${fakeBin}:${systemPath}`,
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    };
    const created = runCli(['wish', 'fix GhostStack and DeltaOps output for operators'], { cwd: dir, env });
    assert.equal(created.status, 1, created.stderr || created.stdout);
    assert.match(created.stdout, /Which workspace, repo, file, or team member did you mean by GhostStack\?/);

    const answered = runCli(['wish', 'answer', 'use this checkout'], { cwd: dir, env });
    assert.equal(answered.status, 0, answered.stderr || answered.stdout);
    assert.doesNotMatch(answered.stdout, /Which workspace, repo, file, or team member did you mean by DeltaOps\?/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    const locationQuestions = records.filter((record) => Array.isArray(record.questions)
      && record.questions.some((question) => /Which workspace, repo, file, or team member/.test(String(question))));
    assert.equal(locationQuestions.length, 1);
    assert.equal(records.filter((record) => record.status === 'delegated' && record.dispatched_at).length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish verifier derivation requires test or command deliverables', () => {
  assert.equal(deriveVerifyPlan('make onboarding less of a test of patience').command, '');
  assert.equal(deriveVerifyPlan('the atris cli readme needs a friendlier intro').command, '');
  assert.equal(deriveVerifyPlan('add tets for the parser').command, 'node --test');
  assert.equal(inferBudgetTier('quik fix the typo in the readme'), 'quick');
  assert.equal(inferBudgetTier('qucik fix the typo in the readme'), 'quick');
  assert.equal(inferBudgetTier('smal fix the typo in the readme'), 'quick');
});

test('wish bench round 2 miss cases are pinned', () => {
  assert.equal(analyzeWishParts('polish the header and footer spacing', repoRoot), null);

  assert.equal(isFrontendWish('make the signup flow gorgeous'), true);
  assert.equal(isFrontendWish('our charts look like excel'), true);
  assert.equal(isFrontendWish('too much going on above the fold'), true);
  assert.equal(isFrontendWish('dark mode washes out the cards'), true);
  assert.equal(isFrontendWish('cache the theme config lookup in the server'), false);
  assert.equal(isFrontendWish('screen the webhook payloads for secrets'), false);

  assert.deepEqual(auditQuestions('shave 300ms off boot'), []);
  assert.deepEqual(auditQuestions('Wednesday demo needs the banner gone'), []);
  assert.deepEqual(auditQuestions('Theres a weird gap under the hero'), []);
  assert.ok(auditQuestions('do that thing again').length > 0);
  assert.ok(auditQuestions('make it more like the other one').length > 0);

  assert.equal(deriveVerifyPlan('stress test the intake with weird phrasings').command, 'node --test');
});

test('wish bench round 3 held-out cases are pinned', () => {
  const archived = analyzeWishParts('archive the old blog posts and rebuild the sitemap', repoRoot);
  assert.equal(archived.length, 2);
  assert.equal(archived[0].text, 'archive the old blog posts');
  assert.equal(archived[1].text, 'rebuild the sitemap');

  const upgraded = analyzeWishParts('upgrade node in ci and pin the lockfile', repoRoot);
  assert.equal(upgraded.length, 2);

  const scheduled = analyzeWishParts('write the investor update; schedule the send for friday', repoRoot);
  assert.equal(scheduled.length, 2);

  assert.equal(analyzeWishParts('hook up search and make it fast', repoRoot), null);
  assert.equal(isFrontendWish('compress the card images in the build step'), false);

  const clearCases = [
    'get first paint under 2s',
    'Friday we demo, hide the beta badges',
    'drop v0.9 support quietly',
    'Basically the recap email buries the one number i care about',
  ];
  for (const text of clearCases) assert.deepEqual(auditQuestions(text), [], text);
  const pageQuestions = auditQuestions('the 404 page deserves better');
  assert.equal(pageQuestions.length, 1);
  assert.match(pageQuestions[0], /404 page/);
  assert.match(pageQuestions[0], /I would bet/);

  assert.equal(deriveVerifyPlan('smoke test the publish flow before the tag').command, 'node --test');
});

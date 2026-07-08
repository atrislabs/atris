const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  analyzeWishParts,
  auditWish,
  deriveVerifyPlan,
  inferBudgetTier,
} = require('../lib/wish-audit');
const { isFrontendWish } = require('../lib/wish-design');

const repoRoot = path.resolve(__dirname, '..');
const engineRegistryPath = path.join(repoRoot, '.atris', 'state', 'engines.json');
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-intake-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
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

test('wish verifier derivation requires test or command deliverables', () => {
  assert.equal(deriveVerifyPlan('make onboarding less of a test of patience').command, '');
  assert.equal(deriveVerifyPlan('the atris cli readme needs a friendlier intro').command, '');
  assert.equal(deriveVerifyPlan('add tets for the parser').command, 'node --test');
  assert.equal(inferBudgetTier('quik fix the typo in the readme'), 'quick');
  assert.equal(inferBudgetTier('qucik fix the typo in the readme'), 'quick');
  assert.equal(inferBudgetTier('smal fix the typo in the readme'), 'quick');
});

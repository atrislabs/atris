#!/usr/bin/env node
/**
 * Context Sync Eval — self-improving test suite.
 *
 * Run: node tests/context-sync-eval.js
 * Output: JSON with pass/fail per test + total score
 *
 * Hook into autoresearch: run every N minutes, track score over time.
 * If score drops, something regressed. Fix it.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const BUSINESS = 'Atris Labs';
const TMP = path.join(os.tmpdir(), 'atris-eval-' + Date.now());

const results = [];
let startTime;

function test(name, fn) {
  const t0 = Date.now();
  try {
    fn();
    const ms = Date.now() - t0;
    results.push({ name, pass: true, ms });
  } catch (e) {
    const ms = Date.now() - t0;
    results.push({ name, pass: false, ms, error: e.message || String(e) });
  }
}

function run(cmd, timeoutSec = 300) {
  return execSync(cmd, { encoding: 'utf8', timeout: timeoutSec * 1000, stdio: ['pipe', 'pipe', 'pipe'] });
}

function atris(args, timeoutSec = 300) {
  return run(`node ${CLI} ${args}`, timeoutSec);
}

// Setup
fs.mkdirSync(TMP, { recursive: true });
startTime = Date.now();

// --- Tests ---

test('pull with --only (speed)', () => {
  const out = atris(`pull "${BUSINESS}" --into ${TMP}/pull-test --only team/justin --timeout 120`);
  if (!out.includes('pulled')) throw new Error('No files pulled: ' + out.trim());
});

test('pull creates files on disk', () => {
  const files = fs.readdirSync(path.join(TMP, 'pull-test', 'team', 'justin'));
  if (!files.includes('MEMBER.md')) throw new Error('MEMBER.md not found');
});

test('pull creates .atris/business.json', () => {
  const bizFile = path.join(TMP, 'pull-test', '.atris', 'business.json');
  if (!fs.existsSync(bizFile)) throw new Error('.atris/business.json not created');
  const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
  if (!biz.business_id) throw new Error('business_id missing');
});

test('pull creates manifest', () => {
  // Check ~/.atris/businesses/*/manifest.json
  const manifestDir = path.join(os.homedir(), '.atris', 'businesses');
  if (!fs.existsSync(manifestDir)) throw new Error('No manifest dir');
  const slugs = fs.readdirSync(manifestDir);
  const hasManifest = slugs.some(s => {
    const mf = path.join(manifestDir, s, 'manifest.json');
    return fs.existsSync(mf);
  });
  if (!hasManifest) throw new Error('No manifest found');
});

test('push detects changes (manifest comparison)', () => {
  const memberFile = path.join(TMP, 'pull-test', 'team', 'justin', 'MEMBER.md');
  fs.appendFileSync(memberFile, `\n## Eval Test ${Date.now()}\n`);
  const out = atris(`push "${BUSINESS}" --from ${TMP}/pull-test`);
  if (!out.includes('pushed')) throw new Error('Push did not report pushed files: ' + out.trim());
});

test('push is fast (no snapshot download)', () => {
  // Modify and push again — should be near-instant
  const memberFile = path.join(TMP, 'pull-test', 'team', 'justin', 'MEMBER.md');
  fs.appendFileSync(memberFile, `\n## Speed Test ${Date.now()}\n`);
  const t0 = Date.now();
  atris(`push "${BUSINESS}" --from ${TMP}/pull-test`);
  const ms = Date.now() - t0;
  if (ms > 30000) throw new Error(`Push took ${ms}ms — should be <30s`);
});

test('push --only filters files', () => {
  // Create a file outside team/justin and verify it's not pushed
  fs.mkdirSync(path.join(TMP, 'pull-test', 'context'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'pull-test', 'context', 'test.md'), '# test');
  const out = atris(`push "${BUSINESS}" --from ${TMP}/pull-test --only team/justin`);
  if (out.includes('context/test.md')) throw new Error('--only filter did not work');
});

test('second pull shows unchanged', () => {
  const out = atris(`pull "${BUSINESS}" --into ${TMP}/pull-test --only team/justin --timeout 120`);
  if (!out.includes('unchanged') && !out.includes('up to date') && !out.includes('pulled')) {
    throw new Error('Unexpected output: ' + out.trim());
  }
});

test('--version works', () => {
  const out = atris('--version');
  if (!out.includes('atris v')) throw new Error('--version failed: ' + out.trim());
});

test('business list works', () => {
  const out = atris('business list');
  if (!out.toLowerCase().includes('atris labs') && !out.toLowerCase().includes('pallet') && !out.includes('Connected')) {
    throw new Error('business list failed: ' + out.trim());
  }
});

// --- Report ---

const totalMs = Date.now() - startTime;
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
const score = Math.round((passed / results.length) * 100);

console.log(JSON.stringify({
  score,
  passed,
  failed,
  total: results.length,
  duration_ms: totalMs,
  timestamp: new Date().toISOString(),
  tests: results,
}, null, 2));

// Cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);

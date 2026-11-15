// Agent page measure: runs scripts/agent-page-measure.js on the project settings fixture in real
// headless Chrome. It checks that all three ways (agent page, accessibility tree, raw page) end
// in the same final state, and that the numbers are present. It never checks how big the numbers
// are, so a page that changes size does not break it.
//
// Finds Chrome the way test/agent-page-browser.test.js does. Skips with a clear sentence when no
// Chrome exists, and also when Chrome exists but never opens its debugging port (a slow or broken
// browser on the machine is not a wrong result). Once the browser is up, a wrong result still fails.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { findChrome } = require('../scripts/gm-phone-trace');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'agent-page-measure.js');
const CHROME = process.env.ATRIS_CHROME_PATH || findChrome();

function skipReason() {
  if (!CHROME || !fs.existsSync(CHROME)) {
    return `no Google Chrome found${CHROME ? ` at ${CHROME}` : ' on this machine'}; set ATRIS_CHROME_PATH to run this browser test`;
  }
  if (typeof WebSocket !== 'function') return 'needs Node 22 or newer (built-in WebSocket)';
  return false;
}

const BROWSER = { skip: skipReason(), timeout: 120000 };

// The script's exit code for "Chrome never opened its debugging port". See scripts/agent-page-measure.js.
const BROWSER_DID_NOT_START = 3;

// Runs the script in a throwaway folder. Resolves with the exit code and both streams.
function runScript(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: os.tmpdir(), timeout: 100000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

// Runs the script. When the browser never came up there is nothing to check, so the test is
// skipped with one line saying why and this returns null. Any other result comes back to be checked.
async function runOrSkip(t, args) {
  const run = await runScript(args);
  if (run.code === BROWSER_DID_NOT_START) {
    const why = run.stderr.trim().split('\n').pop();
    t.skip(`the browser did not start on this machine, so nothing was measured (${why})`);
    return null;
  }
  return run;
}

test('all three ways end in the same final state, and the numbers are there', BROWSER, async (t) => {
  const run = await runOrSkip(t, ['--json']);
  if (!run) return;
  assert.equal(run.code, 0, `the script failed: ${run.stderr}\n${run.stdout}`);
  const report = JSON.parse(run.stdout);

  assert.deepEqual(report.ways.map((way) => way.way), ['agent page', 'accessibility tree', 'raw page']);
  assert.equal(report.all_ways_ended_in_the_expected_state, true);

  for (const way of report.ways) {
    assert.equal(way.error, null, `${way.way} finished without an error`);
    assert.equal(way.completed, true, `${way.way} completed the task`);
    assert.deepEqual(way.final_state, report.expected_final_state, `${way.way} ended in the expected state`);
    assert.deepEqual(way.final_state, report.ways[0].final_state, `${way.way} ended where the agent page way did`);

    // Present, whole numbers. Not how big they are.
    for (const field of ['calls', 'page_reads', 'characters_read', 'rough_tokens']) {
      assert.ok(Number.isInteger(way[field]), `${way.way} has a whole number for ${field}`);
    }
    assert.equal(way.rough_tokens, Math.round(way.characters_read / 4), `${way.way} rough tokens are characters divided by 4`);
    assert.equal(way.per_call.length, way.calls, `${way.way} lists each call`);
    assert.equal(
      way.per_call.reduce((sum, call) => sum + call.characters, 0),
      way.characters_read,
      `${way.way} characters add up from its calls`,
    );
  }

  // The same four changes, named by the task: project name, a member's role, a notification, saved.
  const state = report.ways[0].final_state;
  assert.equal(state.project_name, 'Atlas Garden');
  assert.equal(state.ben_role, 'Admin');
  assert.equal(state.weekly_digest, true);
  assert.equal(state.saves, 1);
});

test('the text report says what it measures and that no screenshots are used', BROWSER, async (t) => {
  const run = await runOrSkip(t, []);
  if (!run) return;
  assert.equal(run.code, 0, `the script failed: ${run.stderr}\n${run.stdout}`);
  const lines = run.stdout.split('\n');
  const top = lines.slice(0, 6).join('\n');
  assert.match(top, /fixed plan/, 'the first lines say the plan is fixed');
  assert.match(top, /does not measure a real model's time or cost/);
  assert.match(top, /no screenshots are involved/);
  for (const way of ['agent page', 'accessibility tree', 'raw page']) {
    assert.ok(lines.some((line) => new RegExp(`^${way}\\s+\\d+\\s+\\d+\\s+[\\d,]+\\s+[\\d,]+$`).test(line)), `the table has a row of numbers for ${way}`);
  }
  assert.match(run.stdout, /all three ways ended in the expected state: yes/);
  assert.equal(run.stdout.includes('\u2014'), false, 'the report has no em dashes');
});

test('a task the script does not know is refused with a sentence, before any browser opens', async () => {
  const run = await runScript(['--task', 'nope']);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown task nope; choose one of settings, forms/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBenchCommand } = require('../commands/engine');

function tmpRoot(prefix = 'atris-engine-bench-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return root;
}

function captureOutput(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args) => { stdout += args.join(' ') + '\n'; };
  console.error = (...args) => { stderr += args.join(' ') + '\n'; };
  try {
    const res = fn();
    return { res, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('ranking is by median ascending, failures sorted last', () => {
  const root = tmpRoot();
  const durations = {
    'cursor': [100, 150, 120], // median 120
    'codex': [50, 60, 55], // median 55
    'claude': [], // failure
    'devin': [200, 180, 220], // median 200
  };
  const counts = { cursor: 0, codex: 0, claude: 0, devin: 0 };
  const probe = (name) => {
    const vals = durations[name];
    if (!vals || vals.length === 0) return { pass: false, durationMs: 0 };
    return { pass: true, durationMs: vals[counts[name]++] };
  };

  const installedEngines = ['cursor', 'codex', 'claude', 'devin'];

  const { res, stdout, stderr } = captureOutput(() => {
    return runBenchCommand(['--runs', '3'], root, { probe, installedEngines });
  });

  assert.equal(res, 1, 'exit 1 because claude failed');
  const lines = stdout.split('\n').filter(l => l.trim());
  assert.match(lines[0], /codex.*median 55ms/);
  assert.match(lines[1], /cursor.*median 120ms/);
  assert.match(lines[2], /devin.*median 200ms/);
  assert.match(stderr, /claude.*FAIL/);
});

test('delta line appears when a previous scoreboard file exists', () => {
  const root = tmpRoot();
  
  const stateFile = path.join(root, '.atris', 'state', 'engine-bench.latest.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    at: new Date().toISOString(),
    runs: 3,
    results: [
      { engine: 'codex', passes: 3, runs: 3, medianMs: 100, minMs: 100, maxMs: 100 },
      { engine: 'cursor', passes: 3, runs: 3, medianMs: 200, minMs: 200, maxMs: 200 }
    ]
  }));

  const probe = (name) => {
    if (name === 'codex') return { pass: true, durationMs: 80 }; // faster by 20
    if (name === 'cursor') return { pass: true, durationMs: 250 }; // slower by 50
    return { pass: false, durationMs: 0 };
  };

  const installedEngines = ['codex', 'cursor'];

  const { res, stdout } = captureOutput(() => {
    return runBenchCommand(['--runs', '1'], root, { probe, installedEngines });
  });

  assert.equal(res, 0);
  assert.match(stdout, /codex.*faster by 20ms/);
  assert.match(stdout, /cursor.*slower by 50ms/);
});

test('--json output shape', () => {
  const root = tmpRoot();
  const probe = (name) => ({ pass: true, durationMs: 100 });
  const installedEngines = ['codex'];

  const { res, stdout } = captureOutput(() => {
    return runBenchCommand(['--runs', '2', '--json'], root, { probe, installedEngines });
  });

  assert.equal(res, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.runs, 2);
  assert.equal(parsed.previous, null);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].engine, 'codex');
  assert.equal(parsed.results[0].passes, 2);
  assert.equal(parsed.results[0].medianMs, 100);

  // Run again to see `previous`
  const { stdout: stdout2 } = captureOutput(() => {
    return runBenchCommand(['--runs', '1', '--json'], root, { probe, installedEngines });
  });
  const parsed2 = JSON.parse(stdout2);
  assert.ok(parsed2.previous);
  assert.equal(parsed2.previous.results[0].engine, 'codex');
});

test('exit code 1 when an engine has zero passing runs', () => {
  const root = tmpRoot();
  let calls = 0;
  const probe = (name) => {
    calls++;
    // pass on first call, fail on rest
    if (calls === 1) return { pass: true, durationMs: 10 };
    return { pass: false, durationMs: 0 };
  };
  const installedEngines = ['codex', 'cursor'];

  const { res } = captureOutput(() => {
    return runBenchCommand(['--runs', '1'], root, { probe, installedEngines });
  });

  assert.equal(res, 1); // cursor fails
});

test('unknown engine name errors cleanly', () => {
  const root = tmpRoot();
  const probe = () => ({ pass: true, durationMs: 10 });

  assert.throws(() => {
    runBenchCommand(['unknown-engine-123'], root, { probe, installedEngines: [] });
  }, /Unknown engine "unknown-engine-123"/);
});

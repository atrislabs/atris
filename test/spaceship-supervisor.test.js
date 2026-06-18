'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'spaceship.sh');

// The supervisor's whole reason to exist: it must NOT die on a bad tick the way
// the bare `atris autopilot --duration` loop does, and every meaningful state
// change must surface (here, to the log instead of email, via --no-email).
// We drive it with a stub tick that ships once, idles, then halts twice, then
// idles — and assert it survives and classifies each outcome.
test('spaceship supervisor survives halts and classifies outcomes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spaceship-test-'));
  try {
    // a real git repo so SHIPPED (HEAD moved) detection works
    const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t.com']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed');
    git(['add', '-A']);
    git(['commit', '-qm', 'seed']);

    const counter = path.join(repo, '.tick_count');
    const stub = path.join(repo, 'stub_tick.sh');
    // ship -> idle -> halt -> halt -> idle...
    fs.writeFileSync(stub, [
      '#!/usr/bin/env bash',
      `C="${counter}"`,
      'n=$(( $(cat "$C" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$C"',
      `cd "${repo}"`,
      'case "$n" in',
      '  1) echo "built and reviewed the task"; echo x > "f$n.txt"; git add -A; git commit -qm "ship feature $n"; exit 0;;',
      '  2) echo "I found no work this tick. clean."; exit 0;;',
      '  3) echo "I halted: judge corruption"; exit 1;;',
      '  4) echo "verify failed"; exit 1;;',
      '  *) echo "nothing to do, clean"; exit 0;;',
      'esac',
    ].join('\n'));
    fs.chmodSync(stub, 0o755);

    const out = execFileSync('bash', [
      SCRIPT,
      '--repo', repo,
      '--hours', '0.003',     // ~10s budget
      '--interval', '1',
      '--tick-timeout', '20',
      '--idle-alert', '3',
      '--halt-alert', '2',
      '--tick-cmd', stub,
      '--no-email',
    ], { encoding: 'utf8', timeout: 60000 });

    // 1. it shipped the one real commit
    assert.match(out, /tick 1 SHIPPED/, 'should detect the committed tick as shipped');

    // 2. it SURVIVED both halts — it does not exit on the first one, so a later
    //    idle tick and the final summary must appear after the halts.
    assert.match(out, /tick 3 HALTED/, 'tick 3 should be classified halted');
    assert.match(out, /tick 4 HALTED/, 'tick 4 should be classified halted');
    assert.match(out, /spaceship done/, 'must reach the final summary despite halts (did not die)');

    // 3. it alerts after the halt streak hits the threshold (2)
    assert.match(out, /ticks halted in a row/, 'should fire the halt-streak alert');

    // 4. it alerts after the idle streak hits the threshold (3) — exactly once
    const idleAlerts = (out.match(/backlog looks empty/g) || []).length;
    assert.ok(idleAlerts >= 1, 'should fire the idle-streak alert at least once');
    assert.ok(idleAlerts <= 1, 'idle-streak alert must not duplicate every idle tick');

    // 5. a run-log was written for durable forensics
    const log = path.join(repo, 'atris', '.spaceship', 'run.log');
    assert.ok(fs.existsSync(log), 'run.log should exist');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

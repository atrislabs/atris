const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { readBoard, renderBoard, ago, isAlive, stopMember, memberBoardCommand } = require('../lib/member-board');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

function fakeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-'));
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.log`), lines.map((l) => `${l}\n`).join(''));
  }
  return dir;
}

test('ago reads like a person would say it', () => {
  assert.equal(ago(12_000), '12s ago');
  assert.equal(ago(4 * 60_000 + 5_000), '4m ago');
  assert.equal(ago(3 * 3600_000), '3h ago');
  assert.equal(ago(2 * 86400_000), '2d ago');
});

test('board shows working, quiet, done ok, and done failed from fake logs', () => {
  const longJob = 'Ship the member board so the operator sees every member at a glance today';
  const dir = fakeDir({
    builder: [
      `${at(900)} m-old started: an older job`,
      `${at(890)} m-old finished: ok`,
      `${at(60)} m-1 started: ${longJob}`,
      `${at(30)} m-1 reading lib/a.js`,
      `${at(12)} m-1 editing lib/b.js`,
    ],
    scout: [
      `${at(600)} m-2 started: find stale docs`,
      `${at(300)} m-2 running: rg stale`,
    ],
    shipper: [
      `${at(400)} m-3 started: land the fix`,
      `${at(250)} m-3 running: npm test`,
      `${at(240)} m-3 finished: ok`,
    ],
    breaker: [
      `${at(100)} m-4 started: try the risky thing`,
      `${at(90)} m-4 running: node boom.js`,
      `${at(80)} m-4 finished: failed`,
    ],
    junk: ['not a progress line'],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    const by = Object.fromEntries(rows.map((r) => [r.member, r]));
    assert.deepEqual(rows.map((r) => r.member), ['builder', 'breaker', 'shipper', 'scout']);

    assert.equal(by.builder.state, 'working');
    assert.equal(by.builder.ago, '12s ago');
    assert.equal(by.builder.step, 'editing lib/b.js');
    assert.equal(by.builder.job.length, 50);
    assert.ok(by.builder.job.startsWith('Ship the member board'));

    assert.equal(by.scout.state, 'quiet');
    assert.equal(by.scout.ago, '5m ago');
    assert.equal(by.scout.step, 'running: rg stale');

    assert.equal(by.shipper.state, 'done ok');
    assert.equal(by.shipper.step, 'running: npm test');
    assert.equal(by.breaker.state, 'done failed');

    const screen = renderBoard(rows, dir);
    assert.equal(screen.split('\n').length, 5, 'one header plus one row per member');
    assert.match(screen, /^member\s+state\s+last result\s+alive\s+engine\s+running for\s+ago\s+job\s+last step$/m);
    assert.match(screen, /^scout\s+quiet\s+-\s+-\s+-\s+-\s+5m ago\s+find stale docs\s+running: rg stale$/m);
    assert.match(screen, /^breaker\s+done failed\s+failed \(after 20s\) 1m ago\s+-\s+-\s+-\s+1m ago\s+try the risky thing\s+running: node boom\.js$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed row says why when the finished line gives a reason', () => {
  const dir = fakeDir({
    slow: [`${at(100)} m-5 started: long job`, `${at(80)} m-5 finished: failed (timed out)`],
    broke: [`${at(100)} m-6 started: engine job`, `${at(70)} m-6 finished: failed (engine error)`],
    exit: [`${at(100)} m-7 started: exit job`, `${at(60)} m-7 finished: failed (bad exit 2)`],
    plain: [`${at(100)} m-8 started: old runner`, `${at(50)} m-8 finished: failed`],
    wordy: [`${at(100)} m-9 started: chatty job`, `${at(40)} m-9 finished: failed the engine wrote a very long story about why`],
    fine: [`${at(100)} m-10 started: good job`, `${at(30)} m-10 finished: ok (all green)`],
    bare: [`${at(20)} m-11 finished: failed`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    const by = Object.fromEntries(rows.map((r) => [r.member, r]));
    assert.equal(by.slow.state, 'done failed', 'the state word stays the same for scripts');
    assert.equal(by.slow.last_result_reason, 'timed out');
    assert.equal(by.broke.last_result_reason, 'engine error');
    assert.equal(by.exit.last_result_reason, 'bad exit 2');
    assert.equal(by.plain.last_result_reason, '', 'the written reason field stays empty');
    assert.equal(by.plain.last_result_ran, '50s');
    assert.equal(by.bare.last_result_ran, '', 'no started line, no run length');
    assert.equal(by.wordy.last_result_reason.length, 30);
    assert.equal(by.fine.last_result_reason, '', 'only a failure carries a reason');

    const screen = renderBoard(rows, dir);
    assert.match(screen, /^slow\s+done failed\s+failed \(timed out\) 1m ago\s/m);
    assert.match(screen, /^broke\s+done failed\s+failed \(engine error\) 1m ago\s/m);
    assert.match(screen, /^exit\s+done failed\s+failed \(bad exit 2\) 1m ago\s/m);
    assert.match(screen, /^plain\s+done failed\s+failed \(after 50s\) 50s ago\s/m, 'no reason written: how long it ran');
    assert.match(screen, /^bare\s+done failed\s+failed 20s ago\s/m);
    assert.match(screen, /^fine\s+done ok\s+ok 30s ago\s/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the runner writes why a run failed and the board reads it back', () => {
  const { finishedLine } = require('../lib/member-progress');
  const ends = {
    good: { ok: true, code: 0 },
    slow: { ok: false, timedOut: true, code: 143 },
    halted: { ok: false, aborted: true, code: null, exitSignal: 'SIGTERM' },
    broke: { ok: false, engineError: true, code: 1 },
    locked: { ok: false, signedOut: true, engineError: true, code: 1 },
    exit: { ok: false, code: 2 },
    killed: { ok: false, code: null, exitSignal: 'SIGKILL' },
    plain: { ok: false },
  };
  const dir = fakeDir(Object.fromEntries(Object.entries(ends).map(([name, end]) => (
    [name, [`${at(100)} m-1 started: job`, `${at(60)} m-1 ${finishedLine(end)}`]]
  ))));
  try {
    const by = Object.fromEntries(readBoard({ dir, now: NOW }).map((r) => [r.member, r]));
    assert.equal(by.good.state, 'done ok');
    assert.equal(by.good.last_result_reason, '');
    assert.equal(by.slow.last_result_reason, 'timed out', 'the timeout, not the exit code its kill caused');
    assert.equal(by.halted.last_result_reason, 'stopped');
    assert.equal(by.broke.last_result_reason, 'engine error');
    assert.equal(by.locked.last_result_reason, 'signed out', 'the sign-in, not the engine error it caused');
    assert.equal(by.exit.last_result_reason, 'bad exit 2');
    assert.equal(by.killed.last_result_reason, 'killed by SIGKILL');
    assert.equal(by.plain.last_result_reason, '');
    assert.equal(by.locked.step, '', 'the json keeps the real last step');
    const screen = renderBoard(Object.values(by), dir);
    assert.match(screen, /^locked\s+done failed\s+failed \(signed out\) 1m ago\s.*\s{2}sign in to the engine, then run it again$/m,
      'a signed out row says how to fix it');
    assert.match(screen, /^broke\s+done failed\s+failed \(engine error\) 1m ago\s.*\s{2}-$/m, 'other failures keep their last step');
    const busy = renderBoard([{ ...by.locked, state: 'working', engine: 'claude' }], dir);
    assert.doesNotMatch(busy, /sign in/, 'a busy row is past it');
    assert.match(renderBoard([{ ...by.locked, engine: 'codex' }], dir), /sign in to codex, then run it again$/m);
    const narrow = renderBoard([{ ...by.locked, engine: 'claude' }, by.broke], dir, 0, 60).split('\n');
    assert.equal(narrow[0].trimEnd().split(/\s{2,}/).pop(), 'last step', '"failed" for "done failed" brings the last step back');
    assert.match(narrow[1], /^locked\s+failed\s+signed out\s+1m ago\s+job\s+sign in to claude$/, 'the fix keeps the last step');
    assert.match(narrow[2], /^broke\s+failed\s+engine error\s+1m ago\s+job\s+-$/, 'other rows keep their job');
    assert.ok(narrow.every((l) => l.length <= 60));
    const tight = renderBoard([{ ...by.locked, engine: 'claude' }, by.broke], dir, 0, 50).split('\n');
    assert.match(tight[1], /^locked\s+done failed\s+signed out\s+1m ago\s+sign in$/, 'too tight for the engine name: just "sign in", not cut');
    assert.ok(tight.every((l) => l.length <= 50));
    for (const w of [50, 60, 80, 90, 100, 110, 120, 140]) {
      const at = renderBoard([{ ...by.locked, engine: 'claude', alive: false }, by.broke], dir, 0, w).split('\n')[1];
      assert.match(at, /\s{2}(sign in to claude, then run it again|sign in to claude|sign in)$/, `the fix shrinks, never cut, at ${w} columns: ${at}`);
    }
    const mid = renderBoard([{ ...by.locked, engine: 'claude', alive: false }, by.broke], dir, 0, 80).split('\n');
    assert.match(mid[1], /^locked\s+failed\s+signed out\s.*\s{2}sign in to claude, then run it again$/, '"done" gives up its room before the fix does');
    const roomy = renderBoard([{ ...by.locked, engine: 'claude', alive: false }, by.broke], dir, 0, 95).split('\n');
    assert.match(roomy[1], /^locked\s+done failed\s+signed out\s+1m ago\s+job\s+sign in to claude, then run it again$/,
      'with no live run, alive and engine leave before "done" does, since the fix names the engine');
    const said = [];
    for (let w = 50; w <= 140; w++) {
      const line = renderBoard([{ ...by.locked, engine: 'claude', alive: false }, by.broke], dir, 0, w).split('\n')[1];
      said.push([w, ['sign in to claude, then run it again', 'sign in to claude', 'sign in'].findIndex((fix) => line.endsWith(`  ${fix}`))]);
    }
    for (let i = 1; i < said.length; i++) {
      assert.ok(said[i][1] >= 0 && said[i][1] <= said[i - 1][1], `a wider board never says less: ${said[i - 1][0]} -> ${said[i][0]} columns`);
    }
    for (const name of Object.keys(ends).filter((n) => n !== 'good')) assert.equal(by[name].state, 'done failed', name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a narrow terminal trims job and last step so every line fits', () => {
  const dir = fakeDir({
    builder: [
      `${at(60)} m-1 started: Ship the member board so the operator sees every member at a glance today`,
      `${at(12)} m-1 running: node --test test/member-board.test.js test/member-result.test.js`,
    ],
    breaker: [`${at(100)} m-4 started: risky fix`, `${at(80)} m-4 finished: failed (timed out)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    const wide = renderBoard(rows, dir);
    assert.ok(wide.split('\n').some((l) => l.length > 120), 'the untrimmed board is wider than the terminal');
    assert.match(wide, /operator sees ever\.\.\.\s+running: node --test test\/member-board\.test\.js \.\.\.$/m, 'width 0 keeps the usual 50 characters');

    const narrow = renderBoard(rows, dir, 0, 120);
    for (const l of narrow.split('\n')) assert.ok(l.length <= 120, `fits in 120: ${l.length}`);
    assert.match(narrow, /^member\s+state\s+last result\s+ago\s+job\s+last step$/m, 'columns that are all dashes leave');
    assert.match(narrow, /^builder\s+working\s.*\s+Ship the member [^.]+\.\.\.\s+running: node [^.]+\.\.\.$/m);
    assert.match(narrow, /^breaker\s+done failed\s+timed out\s+1m ago\s+risky fix\s+-$/m,
      'short text stays whole, and a done row says just the reason, since state and ago say the rest');
    assert.match(narrow, /Ship the member board so the opera\.\.\./, 'the room goes to the busy row');
    assert.match(renderBoard(rows.slice(1), dir, 0, 120), /^breaker\s+done failed\s+failed \(timed out\) 1m ago\s/m, 'with room it stays whole');

    const tiny = renderBoard(rows, dir, 0, 80);
    for (const l of tiny.split('\n')) assert.ok(l.length <= 80, `fits in 80: ${l.length}`);
    assert.match(tiny, /^breaker\s+done failed\s+timed out\s+1m ago\s+risky fix/m, 'the reason survives at 80, without the age twice');

    const live = [{ ...rows[0], alive: true, engine: 'claude', running_for: '1m' }, rows[1]];
    assert.match(renderBoard(live, dir, 0, 200), /^member\s+state\s+last result\s+alive\s+engine\s+running for\s+ago\s+job\s+last step$/m,
      'one live run keeps them while the board fits');
    const past = renderBoard(live, dir, 0, 120);
    assert.match(past, /^member\s+state\s+last result\s+run\s+ago\s+job\s+last step$/m, 'wide but past the window: one run column');
    assert.match(past, /^builder\s.*\s+Ship the member board so the op\.\.\.\s+running: node --test test\/member\.\.\.$/m,
      'so the job and live step read further than beside three columns');
    let read = 0;
    for (let w = 90; w <= 180; w++) {
      const line = renderBoard(live, dir, 0, w).split('\n').find((l) => l.startsWith('builder'));
      const step = line.slice(line.lastIndexOf('  ') + 2).replace(/\.\.\.$/, '').length;
      assert.ok(step >= read, `a wider board never shows less of a live step: ${w} columns`);
      read = step;
    }
    const folded = renderBoard(live, dir, 0, 100);
    for (const l of folded.split('\n')) assert.ok(l.length <= 100, `a live run fits in 100: ${l.length}`);
    assert.match(folded, /^member\s+state\s+last result\s+run\s+ago\s+job\s+last step$/m, 'too narrow: one run column');
    assert.match(folded, /^builder\s+working\s+-\s+1m\s+12s ago\s/m, 'a cut live step takes the engine word\'s room');
    assert.match(folded, /^breaker\s+done failed\s+timed out\s+-\s+1m ago\s+risky fix\s+-$/m, 'a done row keeps only the reason');
    const live80 = renderBoard(live, dir, 0, 80);
    for (const l of live80.split('\n')) assert.ok(l.length <= 80, `a live run and a reason fit in 80: ${l.length}`);
    assert.match(live80, /^builder\s+working\s+-\s+1m\s+12s ago\s.*\s+running: nod\.\.\.$/m,
      'the engine word gives way so a live step reads further');
    const brief = [{ ...live[0], step: 'reading a.js' }, rows[1]];
    assert.match(renderBoard(brief, dir, 0, 100), /^builder\s+working\s+-\s+claude 1m\s+12s ago\s.*\s+reading a\.js$/m,
      'a live step already whole keeps the engine word');

    const roomy = renderBoard(rows, dir, 0, 400);
    assert.match(roomy, /^member\s+state\s+last result\s+ago\s+job\s+last step$/m);
    assert.match(roomy, /operator sees ever\.\.\./, 'a wide terminal trims no text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a job that can read whole gets its room before the last step', () => {
  const dir = fakeDir({
    builder: [`${at(900)} m-1 started: fix the login flow`, `${at(800)} m-1 reading lib/a.js`, `${at(300)} m-1 finished: failed (timed out)`],
    scribe: [`${at(700)} m-2 started: write release notes`, `${at(600)} m-2 editing lib/member-board.js`, `${at(400)} m-2 finished: failed (bad exit 2)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    const board = renderBoard(rows, dir, 0, 73);
    assert.ok(board.split('\n').every((line) => line.length <= 73), board);
    assert.match(board, /^scribe\s+done failed\s+bad exit 2\s+6m ago\s+write release notes\s+editin\.\.\.$/m, board);
    assert.match(board, /^builder\s+done failed\s+timed out\s+5m ago\s+fix the login flow\s+readin\.\.\.$/m, board);
    assert.match(renderBoard(rows, dir, 0, 72), /^scribe\s+.*\s+write release notes$/m,
      'no room to keep the last step at its heading width: with no live run, the step leaves rather than cut a whole job');
    const busy = rows.map((r) => (r.member === 'scribe' ? { ...r, state: 'working' } : r));
    assert.match(renderBoard(busy, dir, 0, 73), /^scribe\s+working\s.*\s+write relea\.\.\.\s+editing lib\.\.\.$/m,
      'a live step says what the run is doing now, so the job never cuts it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hidden last step comes back with the cheapest change that makes room', () => {
  const dir = fakeDir({
    builder: [`${at(180)} m-1 started: fix login`, `${at(60)} m-1 editing lib/auth/session.js to refresh tokens`],
    editor: [`${at(2400)} m-3 started: tidy docs`, `${at(2100)} m-3 running: node --test`, `${at(1980)} m-3 finished: failed (bad exit 2)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW }).map((r) => (r.member === 'builder' ? { ...r, alive: true, engine: 'codex', running_for: '3m' } : r));
    const board = (list, w) => {
      const out = renderBoard(list, dir, 0, w);
      assert.ok(out.split('\n').every((line) => line.length <= w), out);
      return out;
    };
    const wide = board(rows, 72);
    assert.match(wide, /^member\s+state\s+last result\s+run\s+ago\s+job\s+last step$/m, wide);
    assert.match(wide, /^builder\s+working\s+-\s+codex 3m\s+1m ago\s+fix login\s+editing \.\.\.$/m, 'first "failed" for "done failed", keeping the engine');
    assert.match(wide, /^editor\s+failed\s+bad exit 2\s/m, wide);
    assert.match(board(rows, 68), /^builder\s+working\s+-\s+3m\s+1m ago\s+fix login\s+editing l\.\.\.$/m, 'then the engine word, keeping the heading');
    const tight = board(rows, 64);
    assert.match(tight, /^member\s+state\s+result\s+run\s+ago\s+job\s+last step$/m, 'then the heading too');
    assert.match(tight, /^builder\s+working\s+-\s+3m\s+1m ago\s+fix login\s+editin\.\.\.$/m, tight);
    const long = rows.map((r) => (r.member === 'builder' ? { ...r, job: 'fix the login flow' } : r));
    assert.match(board(long, 72), /^builder\s+working\s+-\s+codex 3m\s+1m ago\s+fix the login flow$/m,
      'a job that would be cut keeps every word and no last step');
    const done = rows.filter((r) => r.member !== 'builder');
    assert.match(board(done, 58), /^member\s+state\s+last result\s+ago\s+job\s+last step$/m, 'with no live run, the state alone can bring it back');
    assert.match(board(done, 57), /^member\s+state\s+result\s+ago\s+job\s+last step$/m, 'then the heading');
    assert.match(board(done, 56), /^editor\s+done failed\s+bad exit 2\s+\S+ ago\s+tidy docs$/m, 'no room even then: every word stays');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Every width where a row shows less of its job or last step than one column
// narrower: "74 scout job 19->8 step 0->9". A signed out row's fix counts as
// its fix wherever it sits, since with no last step it takes the job cell:
// "83 locked job 0->21 fix 36->17". Pinned below, so a layout change shows
// which widths it fixes or breaks before any other check is edited.
function cliffs(rows, dir, from, to) {
  const seen = (v) => (!v || v === '-' ? 0 : v.replace(/\.\.\.$/, '').length);
  const read = (w) => {
    const [head, ...lines] = renderBoard(rows, dir, 0, w).split('\n');
    const [job, step] = [head.indexOf('job'), head.indexOf('last step')];
    return Object.fromEntries(lines.map((l) => {
      const jobText = job < 0 ? '' : l.slice(job, step < 0 ? undefined : step).trimEnd();
      const stepText = step < 0 ? '' : l.slice(step);
      const fixInJob = step < 0 && jobText.startsWith('sign in');
      return [l.split(' ')[0], [fixInJob ? 0 : seen(jobText), seen(fixInJob ? jobText : stepText)]];
    }));
  };
  const fixRow = new Set(rows.filter((r) => r.state === 'done failed' && r.last_result_reason === 'signed out').map((r) => r.member));
  const out = [];
  let was = read(from);
  for (let w = from + 1; w <= to; w++) {
    const now = read(w);
    for (const [m, [j, s]] of Object.entries(now)) {
      const [pj, ps] = was[m];
      if (j < pj || s < ps) out.push(`${w} ${m} job ${pj}->${j} ${fixRow.has(m) ? 'fix' : 'step'} ${ps}->${s}`);
    }
    was = now;
  }
  return out;
}

test('the widths where a wider board shows less are known', () => {
  const dir = fakeDir({
    builder: [`${at(180)} m-1 started: fix the login flow`, `${at(60)} m-1 editing lib/auth/session.js to refresh tokens`],
    scout: [`${at(1800)} m-2 started: write release notes`, `${at(1500)} m-2 reading CHANGELOG.md and the merged pull requests`, `${at(1200)} m-2 finished: ok`],
    editor: [`${at(2400)} m-3 started: tidy the docs folder`, `${at(2100)} m-3 running: node --test test/docs.test.js`, `${at(1980)} m-3 finished: failed (bad exit 2)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW }).map((r) => (r.member === 'builder' ? { ...r, alive: true, engine: 'codex', running_for: '3m' } : r));
    assert.deepEqual(cliffs(rows, dir, 60, 130), [
      // Open: whole jobs are cut so the last step can return at its smallest.
      '74 builder job 18->8 step 0->9',
      '74 scout job 19->8 step 0->9',
      '74 editor job 16->8 step 0->9',
      // A trade: the live run's engine word comes back, and a finished row's
      // old step gives up the room.
      '121 scout job 19->19 step 49->42',
    ]);
    // With no live run, a finished row's step is old news, so it never cuts
    // a job that reads whole without it, and no width shows less.
    assert.deepEqual(cliffs(rows.filter((r) => r.member !== 'builder'), dir, 60, 130), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stopped run and one that ended with no result never make a wider board show less', () => {
  const dir = fakeDir({
    halted: [`${at(1000)} m-5 started: migrate the billing tables`, `${at(950)} m-5 running: node scripts/migrate.js --dry-run`, `${at(900)} m-5 finished: stopped`],
    gone: [`${at(1100)} m-6 started: [pid 999999 engine codex] rewrite the onboarding emails`, `${at(1050)} m-6 editing templates/welcome.md for the new tone`],
    scout: [`${at(1800)} m-2 started: write release notes`, `${at(1500)} m-2 reading CHANGELOG.md and the merged pull requests`, `${at(1200)} m-2 finished: ok`],
    editor: [`${at(2400)} m-3 started: tidy the docs folder`, `${at(2100)} m-3 running: node --test test/docs.test.js`, `${at(1980)} m-3 finished: failed (bad exit 2)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.equal(rows.find((r) => r.member === 'gone').no_result, true);
    // With no live run, the last step never cuts a job shorter than it reads
    // without the step, whole or not; it used to cut every job to 6 letters
    // at 68 columns, then vanish at 77.
    assert.deepEqual(cliffs(rows, dir, 50, 150), []);
    assert.match(renderBoard(rows, dir, 0, 72), /^gone\s+stopped\s+no result\s+17m ago\s+rewrite the onboarding emails$/m,
      'with no step to make room for, the shorter wording lets every job read whole');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the full missing-result wording never cuts a step a narrower board read more of', () => {
  const rows = [
    { member: 'scout', state: 'working', alive: true, pid: 9, engine: 'claude', running_for: '3m', last_result: '', last_result_reason: '', last_result_ago: '', ago: '5s ago', job: 'fix it', step: 'npm test' },
    { member: 'halt', state: 'stopped', alive: false, pid: 5, engine: 'claude', running_for: '', last_result: 'stopped', last_result_reason: '', last_result_ago: '7m ago', ago: '7m ago', job: 'fix it', step: 'npm test', no_result: false },
    { member: 'gone', state: 'stopped', alive: false, pid: 6, engine: 'codex', running_for: '', last_result: '', last_result_reason: '', last_result_ago: '', ago: '17m ago', job: 'try again on the chat page', step: 'running: npm test -- member-board', no_result: true },
  ];
  let before = 0;
  for (let width = 88; width <= 120; width++) {
    const line = renderBoard(rows, '/progress', 0, width).split('\n')[3];
    assert.ok(line.length <= width, `${width}: ${line}`);
    assert.match(line, /\stry again on the chat page\s/, `${width}: every job reads whole here`);
    const step = line.slice(line.indexOf('running')).replace(/\.\.\.$/, '').length;
    assert.ok(step >= before, `${width}: the step reads less than one column narrower: ${line}`);
    before = step;
  }
  // It used to say "ended, no result" at 92 and cut the step to "runnin...".
  assert.match(renderBoard(rows, '/progress', 0, 92), /^gone\s+stopped\s+no result\s.*running: np\.\.\.$/m);
});

test('beside a live run, a signed out fix never loses its engine one column wider', () => {
  const rows = [
    { member: 'scout', state: 'working', alive: true, pid: 9, engine: 'claude', running_for: '3m', last_result: '', last_result_reason: '', last_result_ago: '', ago: '5s ago', job: 'fix it', step: 'npm test' },
    { member: 'builder', state: 'done failed', alive: false, pid: 5, engine: 'claude', running_for: '', last_result: 'failed', last_result_reason: 'signed out', last_result_ago: '1m ago', ago: '1m ago', job: 'rewrite the onboarding emails for the new plan', step: 'editing lib/onboarding/emails.js' },
  ];
  for (let width = 60; width <= 120; width++) {
    const line = renderBoard(rows, '/progress', 0, width).split('\n')[2];
    assert.ok(line.length <= width, `${width}: ${line}`);
    // The cheap changes, the engine word on the live row among them, come
    // before a fix gives up naming the engine; it used to read "sign in" at
    // 63, 78, and 111.
    assert.match(line, /sign in to claude(?:, then run it again)?$/, `${width}: ${line}`);
  }
});

test('a signed out row costs a wider board only the widths it is known to', () => {
  const dir = fakeDir({
    builder: [`${at(180)} m-1 started: fix the login flow`, `${at(60)} m-1 editing lib/auth/session.js to refresh tokens`],
    scout: [`${at(1800)} m-2 started: write release notes`, `${at(1500)} m-2 reading CHANGELOG.md and the merged pull requests`, `${at(1200)} m-2 finished: ok`],
    editor: [`${at(2400)} m-3 started: tidy the docs folder`, `${at(2100)} m-3 running: node --test test/docs.test.js`, `${at(1980)} m-3 finished: failed (bad exit 2)`],
    locked: [`${at(900)} m-4 started: ship the pricing page`, `${at(850)} m-4 reading pages/pricing.md`, `${at(800)} m-4 finished: failed (signed out)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW }).map((r) => (r.member === 'builder' ? { ...r, alive: true, engine: 'codex', running_for: '3m' }
      : r.member === 'locked' ? { ...r, engine: 'claude' } : r));
    // "done" gave way for the fix at some width, so it stays away while it
    // would cost a job or step; it used to come back at 60, 83, 91, 110. The
    // engine column stays away while it would push the board past the window,
    // as it used to come back at 87 for the signed out row alone.
    assert.deepEqual(cliffs(rows.filter((r) => r.member !== 'builder'), dir, 50, 140), [
      // A trade: the step comes back once the fix there still names the
      // engine, so the job and every finished step read, and the fix gives
      // up only "then run it again". It used to come back at 75 as "sign in".
      '77 locked job 0->21 fix 36->17',
    ]);
    // Open: the same live-run cliff as above, whole jobs or the live step.
    // The step waits until the fix there still names the engine; it used to
    // come back at 74 with just "sign in".
    assert.deepEqual(cliffs(rows, dir, 50, 140), [
      '79 builder job 18->13 step 0->14',
      '79 scout job 19->13 step 0->14',
      '79 editor job 20->13 step 0->14',
    ]);
    assert.match(renderBoard(rows.filter((r) => r.member !== 'builder'), dir, 0, 60), /^scout\s+ok\s+-\s+20m ago\s+write release notes$/m,
      'one column past where the fix needed it, "done" still stays away so no job is cut');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tiny terminal keeps member states and common failure reasons within its width', () => {
  const dir = fakeDir({
    builder: [`${at(100)} m-1 started: build`, `${at(80)} m-1 finished: failed (timed out)`],
    'chat-experience-lead': [`${at(100)} m-2 started: fix`, `${at(70)} m-2 finished: failed (engine error)`],
    breaker: [`${at(100)} m-3 started: check`, `${at(60)} m-3 finished: failed (bad exit 2)`],
    scout: [`${at(50)} m-4 started: search`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    // Until every name fits whole, the result column would only repeat the
    // reasons two columns already say, so it stays away instead of cutting
    // a name: one column wider never reads less of a name.
    for (const width of [31, 32, 38, 42]) {
      const board = renderBoard(rows, dir, 0, width);
      for (const line of board.split('\n')) assert.ok(line.length <= width, `${width}: ${line}`);
      assert.match(board, /^member\s+state$/m, `${width}: ${board}`);
      assert.match(board, /^builder\s+timed out$/m);
      assert.match(board, width >= 42 ? /^chat-experience-lead\s+engine error$/m : /^chat-experien\S*\s+engine error$/m);
      assert.match(board, /^breaker\s+bad exit 2$/m);
      assert.match(board, /^scout\s+working$/m);
    }
    for (const width of [43, 50]) {
      const board = renderBoard(rows, dir, 0, width);
      for (const line of board.split('\n')) assert.ok(line.length <= width, `${width}: ${line}`);
      assert.match(board, /^member\s+state\s+last result$/m);
      assert.match(board, /^builder\s+failed\s+timed out$/m);
      assert.match(board, /^chat-[^\n]*\s+failed\s+engine error$/m);
      assert.match(board, /^breaker\s+failed\s+bad exit 2$/m);
      assert.match(board, /^scout\s+working\s+-$/m);
    }
    // Three columns at 30 would cut names to "chat...", so the state says why.
    assert.equal(renderBoard(rows, dir, 0, 30), [
      'member            state',
      'scout             working',
      'breaker           bad exit 2',
      'chat-experien...  engine error',
      'builder           timed out',
    ].join('\n'));
    assert.match(renderBoard(rows, dir), /done failed\s+failed \(engine error\)/, 'piped output keeps the full view');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('below 30 columns the board keeps whole states and trims only member names', () => {
  const states = ['done failed', 'done ok', 'working', 'quiet', 'stopped', 'asleep', 'asleep after this run'];
  const rows = states.map((state) => ({
    member: 'chat-experience-lead', state, alive: null,
    last_result: 'failed', last_result_reason: 'engine error', last_result_ago: '1m ago',
    ago: '1m ago',
  }));
  rows.push({ ...rows.find((r) => r.state === 'stopped'), last_result: '', last_result_reason: '', no_result: true });
  for (const width of [18, 20, 24, 29]) {
    const lines = renderBoard(rows, '/progress', 0, width).split('\n');
    assert.equal(lines.length, rows.length + 1);
    assert.match(lines[0], /^member\s+state$/);
    assert.ok(lines.every((line) => line.length <= width), `${width}: ${lines.join('\n')}`);
    states.forEach((state, i) => {
      const expected = state === 'done failed' && width >= 20 ? 'engine error'
        : state.replace(/^done /, '').replace('asleep after this run', 'finishing');
      assert.equal(lines[i + 1].split(/\s{2,}/)[1], expected, `${width}: ${state}`);
    });
    assert.equal(lines[rows.length].split(/\s{2,}/)[1], 'no result', `${width}: a run that died reads apart from one stopped by hand`);
  }
  const failed = rows[0];
  const stateAt = (reason, width) => renderBoard([{ ...failed, last_result_reason: reason }], '/progress', 0, width).split('\n')[1].split(/\s{2,}/)[1];
  assert.equal(stateAt('timed out', 18), 'timed out', 'a short reason says why on the smallest board');
  assert.equal(stateAt('bad exit 2', 18), 'bad exit 2');
  assert.equal(stateAt('killed by SIGTERM', 24), 'failed', 'too long to sit beside a whole heading: failed');
  assert.equal(stateAt('killed by SIGTERM', 25), 'killed by SIGTERM');
  assert.equal(stateAt('stopped', 29), 'failed', 'a stop reason never reads like a hand stop');
  assert.equal(stateAt('verifier said no', 29), 'failed', 'a reason that does not say failed keeps the word');
  assert.match(renderBoard(rows, '/progress', 0, 30), /^member\s+state$/m, 'two columns while a result column would cut names to a stub');
  const short = [{ ...rows[0], member: 'builder', last_result_reason: 'timed out' }, { ...rows[0], member: 'odd', last_result_reason: 'verifier said no' }];
  assert.equal(renderBoard(short, '/progress', 0, 30), [
    'member   state   last result',
    'builder  failed  timed out',
    'odd      failed  verifier s...',
  ].join('\n'), 'whole short names keep the result column, cutting only an odd reason');
  const halted = [
    ...short,
    { ...rows[0], member: 'halt', state: 'stopped', last_result: 'stopped', last_result_reason: '' },
    { ...rows[0], member: 'gone', state: 'stopped', last_result: '', last_result_reason: '', no_result: true },
  ];
  assert.deepEqual(renderBoard(halted, '/progress', 0, 30).split('\n').slice(3), [
    'halt     stopped  on purpose',
    'gone     stopped  no result',
  ], 'a stop says how instead of saying stopped twice');
  assert.match(renderBoard(rows, '/progress', 0, 32), /^member\s+state$/m);
  assert.match(renderBoard(rows, '/progress', 0, 33), /^member\s+state\s+last result$/m, 'the result column returns once names keep their room');
});

test('finishing members leave common failure reasons whole at 30 columns', () => {
  const dir = fakeDir({
    builder: [`${at(100)} m-1 started: build`, `${at(80)} m-1 finished: failed (timed out)`],
    'chat-experience-lead': [`${at(100)} m-2 started: fix`, `${at(70)} m-2 finished: failed (engine error)`],
    breaker: [`${at(100)} m-3 started: check`, `${at(60)} m-3 finished: failed (bad exit 2)`],
    scout: [`${at(50)} m-4 started: search`],
  });
  try {
    const rows = readBoard({ dir, now: NOW, asleep: ['scout'] });
    for (const width of [30, 31, 32, 33, 38, 44, 45]) {
      const lines = renderBoard(rows, dir, 0, width).split('\n');
      const three = width >= 45;
      assert.ok(lines.every((line) => line.length <= width), `${width}: ${lines.join('\n')}`);
      assert.match(lines[0], three ? /^member\s+state\s+last result$/ : /^member\s+state$/, `${width}: names never shrink to a stub`);
      assert.match(lines.join('\n'), /^builder\s+(?:failed\s+)?timed out$/m);
      assert.match(lines.join('\n'), /\s(?:failed\s+)?engine error$/m);
      assert.match(lines.join('\n'), /^breaker\s+(?:failed\s+)?bad exit 2$/m);
      assert.match(lines.join('\n'), three ? /^scout\s+finishing\s+-$/m : /^scout\s+finishing$/m);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compact rows keep missing results clear beside a finishing member', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  child.kill('SIGKILL');
  assert.ok(await waitFor(() => !isAlive(child.pid)), 'the real run has ended');
  const dir = fakeDir({
    'chat-experience-lead': [`${at(100)} m-1 started: [pid ${child.pid} engine claude] build`],
    scout: [`${at(50)} m-2 started: search`],
  });
  try {
    const rows = readBoard({ dir, now: NOW, asleep: ['scout'] });
    // Three columns come back at 44, once the short "no result" lets every
    // name read whole; the full wording waits until it costs no name a letter.
    for (const width of [30, 31, 32, 33, 36, 37, 38, 43, 44, 48, 49]) {
      const board = renderBoard(rows, dir, 0, width);
      assert.ok(board.split('\n').every((line) => line.length <= width), `${width}: ${board}`);
      assert.match(board, width >= 44 ? /^chat-experience-lead\s+stopped\s+(?:ended, )?no result$/m : /^chat-\S+\s+no result$/m, `${width}: ${board}`);
      assert.match(board, width >= 44 ? /finishing\s+-$/m : /finishing$/m);
      assert.equal(board.includes('ended, no result'), width >= 49, `${width}: full wording once no name is cut`);
    }
    assert.match(renderBoard(rows, dir), /stopped\s+ended, no result\s/m, 'piped output keeps the full wording');
  } finally {
    killAll(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the full missing-result wording never costs a name a letter', () => {
  const rows = [
    { member: 'odd', state: 'done failed', alive: null, last_result: 'failed', last_result_reason: 'timed out', last_result_ago: '1m ago', ago: '1m ago' },
    { member: 'halted-run-name', state: 'stopped', alive: false, no_result: true, last_result: '', last_result_reason: '', last_result_ago: '', ago: '2m ago' },
    { member: 'builder', state: 'working', alive: null, last_result: 'failed', last_result_reason: 'bad exit 2', last_result_ago: '14m ago', ago: '1m ago' },
  ];
  let before = 0;
  for (let width = 33; width <= 50; width++) {
    const lines = renderBoard(rows, '/progress', 0, width).split('\n');
    assert.match(lines[0], /^member\s+state\s+last result$/, `${width}: ${lines.join('\n')}`);
    const name = lines[2].split(/\s{2,}/)[0];
    const read = name.replace(/\.\.\.$/, '').length;
    assert.ok(read >= before, `${width}: ${name} reads less of the name than one column narrower`);
    assert.equal(lines[2].endsWith('ended, no result'), name === 'halted-run-name' && width >= 42, `${width}: ${lines[2]}`);
    before = read;
  }
  assert.match(renderBoard(rows, '/progress', 0, 35), /^halted-run\.\.\.\s+stopped\s+no result$/m, 'not "halte..." beside the full wording');
});

test('a stopped row shrinks like a done row: how it ended, with the age left to ago', () => {
  const dir = fakeDir({
    builder: [`${at(900)} m-1 started: fix the login flow`, `${at(300)} m-1 finished: failed (timed out)`],
    scout: [`${at(600)} m-3 started: sweep papers`, `${at(500)} m-3 searching arxiv`, `${at(450)} m-3 finished: stopped`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.match(renderBoard(rows, dir), /^scout\s+stopped\s+stopped 7m ago\s/m, 'piped output keeps the full wording');
    for (const width of [60, 80]) {
      const board = renderBoard(rows, dir, 0, width);
      assert.ok(board.split('\n').every((line) => line.length <= width), `${width}: ${board}`);
      assert.match(board, /^scout\s+stopped\s+on purpose\s+7m ago/m, `${width}: ${board}`);
      assert.match(board, /^builder\s+done failed\s+timed out\s+5m ago/m, `${width}: ${board}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy row with an earlier failure shrinks its last result before it overflows', () => {
  const dir = fakeDir({
    'chat-experience-lead': [
      `${at(900)} m-1 started: fix it`,
      `${at(840)} m-1 finished: failed (bad exit 2)`,
      `${at(60)} m-2 started: try again on the chat page`,
      `${at(5)} m-2 running: npm test`,
    ],
    builder: [`${at(100)} m-3 started: build`, `${at(80)} m-3 finished: failed (engine error)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.match(renderBoard(rows, dir, 0, 120), /^chat-experience-lead\s+working\s+failed \(bad exit 2\) 14m ago\s/m, 'room to spare: all of it');
    const mid = renderBoard(rows, dir, 0, 90);
    for (const l of mid.split('\n')) assert.ok(l.length <= 90, `fits in 90: ${l.length}`);
    assert.match(mid, /^chat-experience-lead\s+working\s+failed \(bad exit 2\) 14m\s/m, 'first "ago" goes');
    const tiny = renderBoard(rows, dir, 0, 80);
    for (const l of tiny.split('\n')) assert.ok(l.length <= 80, `fits in 80: ${l.length}`);
    assert.match(tiny, /^chat-experience-lead\s+working\s+bad exit 2\s/m, 'then a reason that says failed on its own stands alone');
    const odd = rows.map((r) => (r.member === 'chat-experience-lead' ? { ...r, last_result_reason: 'verifier said no' } : r));
    assert.match(renderBoard(odd, dir, 0, 80), /^chat-experience-lead\s+working\s+failed 14m\s/m, 'any other reason goes');
    assert.match(tiny, /^builder\s+done failed\s+engine error\s/m, 'a done row keeps its reason');

    const long = [{ ...rows.find((r) => r.member === 'chat-experience-lead'), job: 'try again on the chat page so the operator sees every reply land' }];
    const wide = renderBoard(long, dir, 0, 120);
    for (const l of wide.split('\n')) assert.ok(l.length <= 120, `fits in 120: ${l.length}`);
    assert.match(wide, /^chat-experience-lead\s+working\s+failed \(bad exit 2\) 14m\s{2}/m, 'wide but a long job overflows: "ago" goes, the reason stays');
    assert.match(wide, /try again on the chat page so the \.\.\./, 'the job gets those characters');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy row keeps its earlier failure reason at every width once one shows it', () => {
  const rows = [
    { member: 'chat-experience-lead', state: 'done failed', alive: null, engine: '', last_result: 'failed', last_result_reason: 'timed out', last_result_ago: '1m ago', ago: '1m ago', job: 'build the thing', step: 'ran tests' },
    { member: 'y', state: 'working', alive: null, engine: '', last_result: 'failed', last_result_reason: 'bad exit 2', last_result_ago: '14m ago', ago: '1m ago', job: 'search', step: 'reading' },
  ];
  for (let width = 30; width <= 120; width++) {
    const line = renderBoard(rows, '/progress', 0, width).split('\n')[2];
    assert.match(line, /bad exit 2/, `${width}: ${line}`);
  }
  assert.match(renderBoard(rows, '/progress', 0, 65), /^y\s+working\s+bad exit 2\s+1m ago\s+search$/m, 'not "failed 14m" one column past the compact board');
});

test('a live run with a long name drops last step before it overflows 80', () => {
  const dir = fakeDir({
    'objective-generator': [
      `${at(900)} m-1 started: fix it`,
      `${at(840)} m-1 finished: failed (bad exit 2)`,
      `${at(60)} m-2 started: try again on the chat page`,
      `${at(5)} m-2 running: npm test`,
    ],
    builder: [`${at(100)} m-3 started: build`, `${at(80)} m-3 finished: failed (engine error)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW }).map((r) => (r.member === 'objective-generator'
      ? { ...r, alive: true, engine: 'claude', running_for: '1m' } : r));
    const roomy = renderBoard(rows, dir, 0, 100);
    for (const l of roomy.split('\n')) assert.ok(l.length <= 100, `fits in 100: ${l.length}`);
    assert.match(roomy, /^member\s+state\s+last result\s+run\s+ago\s+job\s+last step$/m, 'room for both: both stay');
    const tiny = renderBoard(rows, dir, 0, 80);
    for (const l of tiny.split('\n')) assert.ok(l.length <= 80, `fits in 80: ${l.length}`);
    assert.match(tiny, /^member\s+state\s+last result\s+run\s+ago\s+job$/m, 'last step leaves');
    assert.match(tiny, /^objective-generator\s+working\s+bad exit 2\s+claude 1m\s+5s ago\s+try again \.\.\.$/m, 'the job gets the room');
    assert.match(tiny, /^builder\s+done failed\s+engine error\s+-\s+1m ago\s+build$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch mode redraws at once when the window is resized', async () => {
  const dir = fakeDir({
    builder: [`${at(60)} m-1 started: Ship the member board so the operator sees every member at a glance`, `${at(5)} m-1 running: npm test`],
  });
  const out = process.stdout;
  const saved = ['isTTY', 'columns', 'rows'].map((k) => [k, Object.getOwnPropertyDescriptor(out, k)]);
  const write = out.write;
  const env = process.env.ATRIS_PROGRESS_DIR;
  const frames = [];
  let done;
  try {
    process.env.ATRIS_PROGRESS_DIR = dir;
    Object.defineProperty(out, 'isTTY', { value: true, configurable: true, writable: true });
    Object.defineProperty(out, 'columns', { value: 120, configurable: true, writable: true });
    Object.defineProperty(out, 'rows', { value: 20, configurable: true, writable: true });
    out.write = (chunk) => { frames.push(String(chunk)); return true; };
    done = memberBoardCommand('--watch');
    out.columns = 50;
    out.emit('resize');
    for (const width of [28, 24, 14, 6, 5]) { out.columns = width; out.emit('resize'); }
    process.emit('SIGINT');
  } finally {
    out.write = write;
    for (const [k, d] of saved) { if (d) Object.defineProperty(out, k, d); else delete out[k]; }
    if (env === undefined) delete process.env.ATRIS_PROGRESS_DIR; else process.env.ATRIS_PROGRESS_DIR = env;
  }
  try {
    await done;
    assert.equal(frames.length, 7, 'one frame at start, six resizes, none after ctrl-c');
    const widest = (f) => Math.max(...f.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map((l) => l.length));
    assert.ok(widest(frames[0]) > 50, 'the first frame used the old width');
    assert.ok(widest(frames[1]) <= 50, `the redraw fits the new width: ${widest(frames[1])}`);
    for (const [i, hint] of ['updates 3s, ctrl-c to stop', 'ctrl-c to stop', 'ctrl-c to stop', 'ctrl-c', ''].entries()) {
      assert.equal(frames[i + 2].split('\n').at(-2), hint, 'the hint shrinks whole on resize');
    }
    assert.equal(out.listenerCount('resize'), 0, 'ctrl-c stops listening for resizes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch mode uses the whole screen in one to three terminal rows', async () => {
  const dir = fakeDir({
    builder: [`${at(100)} m-1 started: job`, `${at(80)} m-1 finished: failed (timed out)`],
    scout: [`${at(100)} m-2 started: job`, `${at(70)} m-2 finished: failed (timed out)`],
  });
  const out = process.stdout;
  const saved = ['isTTY', 'columns', 'rows'].map((k) => [k, Object.getOwnPropertyDescriptor(out, k)]);
  const write = out.write;
  const env = process.env.ATRIS_PROGRESS_DIR;
  const frames = [];
  let done;
  try {
    process.env.ATRIS_PROGRESS_DIR = dir;
    Object.defineProperty(out, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(out, 'columns', { value: 80, configurable: true });
    Object.defineProperty(out, 'rows', { value: 1, configurable: true, writable: true });
    out.write = (chunk) => { frames.push(String(chunk)); return true; };
    done = memberBoardCommand('--watch', '--all');
    for (const height of [2, 3, 6]) { out.rows = height; out.emit('resize'); }
    process.emit('SIGINT');
  } finally {
    out.write = write;
    for (const [k, d] of saved) { if (d) Object.defineProperty(out, k, d); else delete out[k]; }
    if (env === undefined) delete process.env.ATRIS_PROGRESS_DIR; else process.env.ATRIS_PROGRESS_DIR = env;
  }
  try {
    await done;
    assert.equal(frames.length, 4, 'initial draw and three resizes');
    for (let i = 0; i < 3; i++) {
      const frame = frames[i].replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      assert.equal(frame.split('\n').length, i + 1);
      assert.match(frame, /^member\s+state/);
      assert.doesNotMatch(frame, /redraws every/);
      assert.ok(!frame.endsWith('\n'), 'no newline scrolls the bottom row');
      if (i === 1) assert.match(frame, /2 more not shown \(2 failed, all timed out\)/);
      if (i === 2) assert.match(frame, /scout\s+done failed/);
    }
    assert.match(frames[3], /redraws every 3s, ctrl-c to stop\n$/, 'the hint returns after growing');
    assert.equal(out.listenerCount('resize'), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a short window keeps the header and the newest rows, and says how many did not fit', () => {
  const logs = {};
  for (let i = 1; i <= 8; i++) logs[`m${i}`] = [`${at(i * 10)} m-${i} started: job ${i}`, `${at(i * 10 - 5)} m-${i} running: step ${i}`];
  const dir = fakeDir(logs);
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.equal(renderBoard(rows, dir).split('\n').length, 9, 'height 0 shows every row');
    assert.equal(renderBoard(rows, dir, 0, 0, 9), renderBoard(rows, dir), 'a tall enough window changes nothing');

    const lines = renderBoard(rows, dir, 0, 0, 6).split('\n');
    assert.equal(lines.length, 6);
    assert.match(lines[0], /^member\s+state/, 'the header stays');
    assert.deepEqual(lines.slice(1, 4).map((l) => l.split(/\s+/)[0]), ['m1', 'm2', 'm3'], 'the newest rows stay');
    assert.equal(lines[4], '');
    assert.equal(lines[5], '5 more not shown (5 running), the window is too short', 'hidden runs still going say so');

    const both = renderBoard(rows, dir, 2, 0, 6).split('\n');
    assert.equal(both.length, 6);
    assert.equal(both[5], '5 more not shown (5 running), the window is too short. 2 finished over an hour ago, hidden. --all shows them');

    const at80 = renderBoard(rows, dir, 2, 80, 6).split('\n');
    assert.equal(at80.length, 6, 'a narrow footer still takes one line');
    assert.equal(at80[5], '5 hidden (5 running). 2 finished over an hour ago, hidden. --all shows them', 'first the why goes, and a shorter label keeps the running count');
    const at60 = renderBoard(rows, dir, 2, 60, 6).split('\n');
    assert.equal(at60[5], '5 hidden (5 running). 2 older runs hidden, --all shows them', 'then the hidden count shortens');
    const at30 = renderBoard(rows, dir, 2, 30, 6).split('\n');
    assert.equal(at30[5], '5 hidden (5 running). 2 older', 'then the older note shortens instead of being cut');
    assert.equal(renderBoard(rows, dir, 0, 80, 6).split('\n')[5], '5 more not shown (5 running), the window is too short', 'room for the why: it stays');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a short screen names up to three hidden live members, never at the cost of a failure reason', () => {
  const dir = fakeDir({
    busy: [`${at(10)} m-1 started: [pid ${process.pid} engine claude] job`],
    f1: [`${at(80)} m-1 finished: failed (timed out)`],
    f2: [`${at(90)} m-2 finished: failed (bad exit 2)`],
    halt: [`${at(110)} m-4 finished: stopped`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    for (const [width, footer] of [
      [100, '3 more not shown (1 failed, bad exit 2, 1 stopped, busy working), the window is too short'],
      [80, '3 more not shown (1 failed, bad exit 2, 1 stopped, busy working)'],
      [50, '3 more not shown (1 failed, bad exit 2, 1 stopped)'],
      [30, '3 hidden (1 failed, 1 stopped)'],
    ]) {
      const lines = renderBoard(rows, dir, 0, width, 4).split('\n');
      assert.equal(lines[3], footer, `${width}: the name gives way first`);
      assert.ok(lines.every((line) => line.length <= width));
    }
    const two = [...rows, { ...rows.find((r) => r.member === 'busy'), member: 'also' }];
    assert.equal(renderBoard(two, dir, 0, 100, 4).split('\n')[3],
      '4 more not shown (1 failed, bad exit 2, 1 stopped, busy working, also working)', 'two live members are both named');
    const busyRow = rows.find((r) => r.member === 'busy');
    const three = [...two, { ...busyRow, member: 'scout', state: 'quiet' }];
    assert.equal(renderBoard(three, dir, 0, 100, 4).split('\n')[3],
      '5 more not shown (1 failed, bad exit 2, 1 stopped, busy working, also working, scout quiet)', 'each says its own state');
    assert.equal(renderBoard(three, dir, 0, 80, 4).split('\n')[3], '5 more not shown (1 failed, bad exit 2, 1 stopped, 3 running)',
      'all names or none, so no live run looks missing; a count when names do not fit');
    assert.equal(renderBoard(three, dir, 0, 60, 4).split('\n')[3], '5 hidden (1 failed, bad exit 2, 1 stopped, 3 running)',
      'shorter labels make room for the count, never a dropped reason');
    assert.equal(renderBoard(three, dir, 0, 50, 4).split('\n')[3], '5 more not shown (1 failed, bad exit 2, 1 stopped)');
    const four = [...three, { ...busyRow, member: 'extra' }];
    assert.equal(renderBoard(four, dir, 0, 120, 4).split('\n')[3], '6 more not shown (1 failed, bad exit 2, 1 stopped, 4 running), the window is too short',
      'four or more become one count');
    const finishing = rows.map((r) => r.member === 'busy' ? { ...r, state: 'asleep after this run' } : r);
    assert.match(renderBoard(finishing, dir, 0, 80, 4).split('\n')[3], /busy finishing\)$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the older-runs note never pushes a current member off a short screen', () => {
  const dir = fakeDir({
    busy: [`${at(10)} m-1 started: [pid ${process.pid} engine claude] job`],
    broke: [`${at(90)} m-2 started: fix`, `${at(80)} m-2 finished: failed (engine error)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    const names = (lines) => lines.slice(1).map((l) => l.split(/\s+/)[0]).filter((n) => n === 'busy' || n === 'broke');
    const three = renderBoard(rows, dir, 2, 80, 3).split('\n');
    assert.deepEqual(names(three), ['busy', 'broke'], 'both members fit, so both show');
    assert.equal(three.length, 3, 'no room left for the note, so it waits');
    const four = renderBoard(rows, dir, 2, 80, 4).split('\n');
    assert.deepEqual(names(four), ['busy', 'broke']);
    assert.equal(four[3], '2 finished over an hour ago, hidden. --all shows them', 'a spare row carries the note');
    const one = renderBoard(rows.slice(0, 1), dir, 2, 80, 2).split('\n');
    assert.equal(one.length, 2);
    assert.match(one[1], /^busy\s+working/, 'the one live member beats the note');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one to three board lines keep the header without scrolling away failures', () => {
  const dir = fakeDir({
    busy: [`${at(10)} m-1 started: job`],
    broke: [`${at(90)} m-2 started: fix`, `${at(80)} m-2 finished: failed (timed out)`],
    exit: [`${at(100)} m-3 started: fix`, `${at(90)} m-3 finished: failed (bad exit 2)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    for (const hidden of [0, 2]) {
      for (const height of [1, 2, 3]) {
        const lines = renderBoard(rows, dir, hidden, 80, height).split('\n');
        assert.equal(lines.length, height, `fits ${height} lines with ${hidden} older runs`);
        assert.match(lines[0], /^member\s+state/, 'the header stays');
        assert.ok(lines.every((line) => line.length <= 80));
        if (height === 2) assert.match(lines[1], /^3 (?:more not shown|hidden) \(2 failed, timed out and bad exit 2, busy working\)/);
        if (height === 3) {
          assert.match(lines[1], /^broke\s+done failed\s+(?:failed \()?timed out\b/);
          assert.match(lines[2], /^2 more not shown \(1 failed, bad exit 2, busy working\)/);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a short window keeps failed and stopped rows on screen ahead of newer ones', () => {
  const logs = {};
  for (let i = 1; i <= 6; i++) logs[`m${i}`] = [`${at(i * 10)} m-${i} started: job ${i}`, `${at(i * 10 - 5)} m-${i} running: step ${i}`];
  logs.broke = [`${at(900)} m-7 started: old job`, `${at(800)} m-7 finished: failed (engine error)`];
  logs.halted = [`${at(950)} m-8 started: other job`, `${at(850)} m-8 finished: stopped`];
  const dir = fakeDir(logs);
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.deepEqual(rows.slice(-2).map((r) => r.member), ['broke', 'halted'], 'by recency they are last');
    const lines = renderBoard(rows, dir, 0, 0, 7).split('\n');
    assert.equal(lines.length, 7);
    assert.deepEqual(lines.slice(1, 5).map((l) => l.split(/\s+/)[0]), ['m1', 'm2', 'broke', 'halted'],
      'they stay, and rows keep board order');
    assert.match(lines[3], /^broke\s+done failed\s+failed \(engine error\) 13m ago\s/);
    assert.equal(lines[6], '4 more not shown (4 running), the window is too short', 'no failure count when every failure is on screen');

    const tiny = renderBoard(rows, dir, 0, 0, 4).split('\n');
    assert.equal(tiny.length, 4);
    assert.match(tiny[1], /^broke\s+done failed/, 'the newest failure wins the one row');
    assert.equal(tiny[3], '7 more not shown (1 stopped, 6 running), the window is too short');

    const halted = rows.find((r) => r.member === 'halted');
    const withGone = [...rows, { ...halted, member: 'gone', no_result: true }];
    const gone = renderBoard(withGone, dir, 0, 0, 4).split('\n');
    assert.equal(gone[3], '8 more not shown (1 stopped, 1 ended with no result, 6 running), the window is too short',
      'a run that died silently is not counted as a stop');

    // A newer hand stop never takes the one row from an older failure.
    const newer = rows.map((r) => (r.member === 'halted' ? { ...r, at: NOW } : r)).sort((a, b) => b.at - a.at);
    assert.equal(newer[0].member, 'halted', 'the stop is newest');
    const first = renderBoard(newer, dir, 0, 0, 4).split('\n');
    assert.match(first[1], /^broke\s+done failed\s+failed \(engine error\)/, 'the failure wins the one row');
    assert.equal(first[3], '7 more not shown (1 stopped, 6 running), the window is too short');
    const died = renderBoard([{ ...halted, member: 'gone', no_result: true, at: NOW - 1 }, { ...halted, at: NOW }], dir, 0, 0, 4).split('\n');
    assert.match(died[1], /^gone\s+stopped\s+ended, no result/, 'a run that died outranks a newer stop too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('short boards distinguish a hidden busy member earlier failure from a current failure', () => {
  const dir = fakeDir({
    busy: [
      `${at(900)} m-1 started: first job`,
      `${at(800)} m-1 finished: failed (timed out)`,
      `${at(60)} m-2 started: try again`,
      `${at(5)} m-2 running: check the fix`,
    ],
    ok1: [`${at(70)} m-4 finished: ok`],
    ok2: [`${at(75)} m-5 finished: ok`],
    broke: [`${at(90)} m-3 started: other job`, `${at(80)} m-3 finished: failed (engine error)`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.equal(renderBoard(rows, dir, 0, 100, 4).split('\n')[3],
      '3 more not shown (1 with earlier failure, timed out), the window is too short');
    assert.match(renderBoard(rows, dir, 0, 100, 4).split('\n')[1], /^broke\s+done failed/);
    for (const state of ['working', 'quiet', 'asleep after this run']) {
      const changed = rows.map((r) => r.member === 'busy' ? { ...r, state } : r);
      assert.equal(renderBoard(changed, dir, 0, 60, 4).split('\n')[3],
        '3 more not shown (1 with earlier failure, timed out)');
      const tiny = renderBoard(changed, dir, 0, 47, 4).split('\n');
      assert.equal(tiny.length, 4);
      assert.equal(tiny[3], '3 more not shown (1 earlier failure, timed out)');
      assert.equal(renderBoard(changed, dir, 0, 36, 4).split('\n')[3],
        '3 more not shown (1 earlier failure)');
      for (const width of [36, 47]) {
        assert.ok(renderBoard(changed, dir, 0, width, 4).split('\n')[3].length <= width);
      }
    }
    const ok = rows.map((r) => r.member === 'busy' ? { ...r, last_result: 'ok' } : r);
    assert.equal(renderBoard(ok, dir, 0, 100, 4).split('\n')[3], '3 more not shown (busy working), the window is too short',
      'the one live run is named, not counted silently');
    const busy = rows.find((r) => r.member === 'busy');
    const shared = [...rows, { ...busy, member: 'busy2' }];
    assert.match(renderBoard(shared, dir, 0, 100, 4).split('\n')[3], /2 with earlier failure, all timed out/);
    const mixed = [...rows, { ...busy, member: 'busy2', last_result_reason: 'bad exit 2' }];
    assert.match(renderBoard(mixed, dir, 0, 100, 4).split('\n')[3], /2 with earlier failure, timed out and bad exit 2\)/);
    const sleeping = rows.map((r) => r.member === 'busy' ? { ...r, state: 'asleep' } : r);
    assert.doesNotMatch(renderBoard(sleeping, dir, 0, 100, 4), /earlier failure/);
    assert.doesNotMatch(renderBoard(rows, dir), /more not shown/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compact footers drop all before dropping a shared failure reason', () => {
  for (const reason of ['timed out', 'engine error', 'bad exit 2']) {
    const logs = {};
    for (let i = 1; i <= 4; i++) logs[`f${i}`] = [
      `${at(90 + i)} m-${i} started: job`,
      `${at(80 + i)} m-${i} finished: failed (${reason})`,
    ];
    const dir = fakeDir(logs);
    try {
      const rows = readBoard({ dir, now: NOW });
      const footer = `3 more not shown (3 failed, ${reason})`;
      const compact = renderBoard(rows, dir, 0, footer.length, 4).split('\n');
      assert.equal(compact.length, 4);
      assert.equal(compact[3], footer);
      assert.match(renderBoard(rows, dir, 0, 100, 4), new RegExp(`3 failed, all ${reason}`));
      const earlier = rows.map((r, i) => i ? { ...r, state: 'working' } : r);
      const earlierFooter = `3 more not shown (3 earlier failure, ${reason})`;
      assert.equal(renderBoard(earlier, dir, 0, earlierFooter.length, 4).split('\n')[3], earlierFooter);
      for (const [board, label] of [[rows, 'failed'], [earlier, 'earlier failure']]) {
        const tiny = `3 hidden (3 ${label}, ${reason})`;
        const output = renderBoard(board, dir, 0, tiny.length, 4).split('\n');
        assert.equal(output.length, 4);
        assert.equal(output[3], tiny, 'shorten the prefix before dropping the reason');
        assert.doesNotMatch(renderBoard(board, dir, 0, tiny.length - 1, 4).split('\n')[3], new RegExp(reason));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('tiny footers shorten the hidden prefix before cutting failure counts', () => {
  const dir = fakeDir({
    f1: [`${at(80)} m-1 finished: failed (timed out)`],
    f2: [`${at(90)} m-2 finished: failed (engine error)`],
    f3: [`${at(100)} m-3 finished: failed (bad exit 2)`],
    halt: [`${at(110)} m-4 finished: stopped`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.equal(renderBoard(rows, dir, 0, 40, 4).split('\n')[3],
      '3 more not shown (2 failed, 1 stopped)');
    const footer = '3 hidden (2 failed, 1 stopped)';
    assert.equal(renderBoard(rows, dir, 0, footer.length, 4).split('\n')[3], footer);
    assert.equal(renderBoard(rows, dir, 0, footer.length - 1, 4).split('\n')[3],
      '3 hidden (2 failed, ...)', 'drop the whole last count, never half of it');
    const earlier = rows.map((r, i) => i === 1 ? { ...r, state: 'working' } : r);
    const earlierFooter = '3 hidden (1 failed, 1 stopped, 1 earlier failure)';
    assert.equal(renderBoard(earlier, dir, 0, earlierFooter.length, 4).split('\n')[3], earlierFooter);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('narrow footers keep hidden missing-result counts whole', () => {
  const dir = fakeDir(Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [name, [
    `${at(20)} m-1 started: [pid 999999999 engine claude] check the board`,
  ]])));
  try {
    const rows = readBoard({ dir, now: NOW });
    assert.ok(rows.every((r) => r.no_result));
    for (const [width, footer] of [
      [80, '3 more not shown (3 ended with no result), the window is too short'],
      [41, '3 more not shown (3 ended with no result)'],
      [31, '3 more not shown (3 no result)'],
      [22, '3 hidden (3 no result)'],
    ]) {
      const lines = renderBoard(rows, dir, 0, width, 4).split('\n');
      assert.equal(lines[3], footer, `${width}: a whole count and label`);
      assert.equal(lines.length, 4);
      assert.ok(lines.every((line) => line.length <= width));
    }
    const mixed = rows.map((r, i) => i === 1 ? { ...r, no_result: false } : r);
    assert.equal(renderBoard(mixed, dir, 0, 33, 4).split('\n')[3],
      '3 hidden (1 stopped, 2 no result)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the narrowest footers say just the hidden count before cutting a word', () => {
  const base = { alive: null, engine: '', running_for: '', job: 'b', step: 's', ago: '1m ago' };
  const rows = [
    { ...base, member: 'f1', state: 'done failed', last_result: 'failed', last_result_reason: 'timed out', last_result_ago: '1m ago' },
    { ...base, member: 'h1', state: 'stopped', last_result: 'stopped', last_result_reason: '', last_result_ago: '7m ago' },
    { ...base, member: 'g1', state: 'stopped', no_result: true, last_result: '', last_result_reason: '', last_result_ago: '' },
    { ...base, member: 'w1', state: 'working', last_result: 'failed', last_result_reason: 'engine error', last_result_ago: '14m ago' },
    { ...base, member: 'w2', state: 'working', last_result: '', last_result_reason: '', last_result_ago: '' },
  ];
  for (let width = 18; width <= 29; width++) {
    for (let height = 2; height <= 5; height++) {
      const footer = renderBoard(rows, '/progress', 0, width, height).split('\n').pop();
      assert.ok(footer.length <= width, `${width}x${height}: ${footer}`);
      // Whole counts end in ", ...)"; anything else cut would end in "..." alone.
      assert.ok(!/\.\.\.$/.test(footer), `${width}x${height}: cut mid-word: ${footer}`);
    }
  }
  // It used to read "5 hidden (1 fai..." here.
  assert.equal(renderBoard(rows, '/progress', 0, 18, 2).split('\n').pop(), '5 hidden');
  assert.equal(renderBoard(rows, '/progress', 0, 24, 2).split('\n').pop(), '5 hidden (1 failed, ...)');
});

test('a footer drops an earlier failure reason before the reason a run is done failed', () => {
  const base = { alive: null, engine: '', running_for: '', job: 'b', step: 's', ago: '1m ago' };
  const rows = [
    { ...base, member: 'f1', state: 'done failed', last_result: 'failed', last_result_reason: 'timed out', last_result_ago: '1m ago' },
    { ...base, member: 'h1', state: 'stopped', last_result: 'stopped', last_result_reason: '', last_result_ago: '7m ago' },
    { ...base, member: 'g1', state: 'stopped', no_result: true, last_result: '', last_result_reason: '', last_result_ago: '' },
    { ...base, member: 'w1', state: 'working', last_result: 'failed', last_result_reason: 'engine error', last_result_ago: '14m ago' },
    { ...base, member: 'w2', state: 'working', last_result: '', last_result_reason: '', last_result_ago: '' },
  ];
  const footer = (width) => renderBoard(rows, '/progress', 0, width, 2).split('\n').pop();
  // Both used to drop "timed out" at 73 to 86 columns.
  assert.equal(footer(73), '5 hidden (1 failed, timed out, 1 stopped, 1 no result, 1 earlier failure)');
  assert.equal(footer(86), '5 hidden (1 failed, timed out, 1 stopped, 1 no result, 1 earlier failure, w2 working)');
  assert.equal(footer(87), '5 hidden (1 failed, timed out, 1 stopped, 1 no result, 1 earlier failure, engine error)');
  for (let width = 18; width <= 120; width++) {
    if (footer(width).includes('engine error')) assert.ok(footer(width).includes('timed out'), `${width}: ${footer(width)}`);
  }
});

test('every footer reason sits right after the count it explains', () => {
  const base = { alive: null, engine: '', running_for: '', job: 'b', step: 's', ago: '1m ago' };
  const failed = (m, why) => ({ ...base, member: m, state: 'done failed', last_result: 'failed', last_result_reason: why, last_result_ago: '1m ago' });
  const busy = (m, why) => ({ ...base, member: m, state: 'working', last_result: why ? 'failed' : '', last_result_reason: why, last_result_ago: why ? '9m ago' : '' });
  const stopped = { ...base, member: 'h1', state: 'stopped', last_result: 'stopped', last_result_reason: '', last_result_ago: '7m ago' };
  const lost = { ...base, member: 'g1', state: 'stopped', no_result: true, last_result: '', last_result_reason: '', last_result_ago: '' };
  const boards = [
    [failed('f1', 'timed out'), failed('f2', 'engine error'), failed('f3', 'bad exit 2'), stopped, lost],
    [failed('f1', 'signed out'), failed('f2', 'signed out'), failed('f3', 'timed out'), failed('f4', 'timed out'), stopped],
    [stopped, busy('e1', 'timed out'), busy('e2', 'engine error'), busy('e3', 'bad exit 2'), busy('w1', '')],
    [failed('f1', 'timed out'), busy('e1', 'engine error'), busy('e2', 'engine error'), lost, busy('w1', '')],
  ];
  let reasons = 0;
  for (const rows of boards) {
    for (const older of [0, 2]) {
      for (let height = 2; height <= 4; height++) {
        for (let width = 30; width <= 120; width++) {
          const footer = renderBoard(rows, '/progress', older, width, height).split('\n').pop();
          const inside = footer.match(/^\d+ (?:more not shown|hidden) \((.*)\)/);
          if (!inside) continue;
          // A chunk with no count is a reason; it must follow its failure count or the reason before it.
          let prev = '';
          for (const chunk of inside[1].split(', ')) {
            const counted = /^\d/.test(chunk) || chunk === '...' || /^\S+ (?:working|quiet|finishing)$/.test(chunk);
            if (!counted) {
              reasons++;
              assert.ok(/(?:failed|failure)$/.test(prev) || prev === 'reason', `${width}x${height}: "${chunk}" reads as its own count: ${footer}`);
            }
            prev = counted ? chunk : 'reason';
          }
        }
      }
    }
  }
  assert.ok(reasons > 0, 'the boards above put reasons in the footer');
});

test('narrow footers drop whole mixed counts from the end instead of cutting one', () => {
  const dir = fakeDir({
    a: [`${at(20)} m-1 started: [pid ${process.pid} engine claude] check the board`],
    f1: [`${at(80)} m-1 finished: failed (timed out)`],
    f2: [`${at(90)} m-2 finished: failed (bad exit 2)`],
    halt: [`${at(110)} m-4 finished: stopped`],
    gone: [`${at(200)} m-5 started: [pid 999999999 engine claude] check the board`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    for (const [width, footer] of [
      [43, '4 hidden (1 failed, 1 stopped, 1 no result)'],
      [42, '4 hidden (1 failed, 1 stopped, ...)'],
      [34, '4 hidden (1 failed, ...)'],
      [24, '4 hidden (1 failed, ...)'],
    ]) {
      const lines = renderBoard(rows, dir, 0, width, 4).split('\n');
      assert.equal(lines[3], footer, `${width}: every count shown is whole`);
      assert.equal(lines.length, 4);
      assert.ok(lines.every((line) => line.length <= width));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('narrow footers shorten the older-runs note before dropping hidden counts', () => {
  const dir = fakeDir({
    a: [`${at(20)} m-1 started: [pid ${process.pid} engine claude] check the board`],
    f1: [`${at(80)} m-1 finished: failed (timed out)`],
    f2: [`${at(90)} m-2 finished: failed (bad exit 2)`],
    halt: [`${at(110)} m-4 finished: stopped`],
  });
  try {
    const rows = readBoard({ dir, now: NOW });
    for (const [width, footer] of [
      [77, '3 hidden (1 failed, bad exit 2, 1 stopped, a working). 2 older hidden'],
      [57, '3 hidden (1 failed, bad exit 2, 1 stopped, a working)'],
      [46, '3 hidden (1 failed, bad exit 2, 1 stopped)'],
      [39, '3 hidden (1 failed, 1 stopped). 2 older'],
      [30, '3 hidden (1 failed, 1 stopped)'],
      [24, '3 hidden (1 failed, ...)'],
    ]) {
      const lines = renderBoard(rows, dir, 2, width, 4).split('\n');
      assert.equal(lines[lines.length - 1], footer, `${width}: counts before the older note`);
      assert.equal(lines.length, 4);
      assert.ok(lines.every((line) => line.length <= width));
    }
    const done = rows.filter((r) => r.member !== 'a');
    for (const [width, footer] of [
      [92, '2 more not shown (1 failed, bad exit 2, 1 stopped). 2 older runs hidden, --all shows them'],
      [80, '2 hidden (1 failed, bad exit 2, 1 stopped). 2 older, --all shows them'],
      [44, '2 hidden (1 failed, bad exit 2, 1 stopped)'],
    ]) {
      assert.equal(renderBoard(done, dir, 2, width, 3).split('\n').pop(), footer, `${width}: the failure reason outlasts the older note`);
    }
    for (const [width, footer] of [[25, '2 older, --all shows them'], [14, '2 older hidden'], [7, '2 older']]) {
      assert.equal(renderBoard(rows, dir, 2, width).split('\n').pop(), footer, `${width}: the older note alone stays whole`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hidden failures that share a reason say it once in the count', () => {
  const logs = {};
  for (let i = 1; i <= 4; i++) logs[`f${i}`] = [`${at(900 + i)} m-${i} started: job ${i}`, `${at(800 + i)} m-${i} finished: failed (signed out)`];
  logs.halted = [`${at(950)} m-9 started: other job`, `${at(850)} m-9 finished: stopped`];
  const dir = fakeDir(logs);
  try {
    const rows = readBoard({ dir, now: NOW });
    const lines = renderBoard(rows, dir, 0, 0, 4).split('\n');
    assert.match(lines[1], /^f1\s+done failed\s+failed \(signed out\)/);
    assert.equal(lines[3], '4 more not shown (3 failed, all signed out, 1 stopped), the window is too short');
    const narrow = renderBoard(rows, dir, 0, 50, 4).split('\n')[3];
    assert.equal(narrow, '4 more not shown (3 failed, signed out, 1 stopped)', 'drop all to keep the shared reason');
    assert.equal(renderBoard(rows, dir, 0, 45, 4).split('\n')[3], '4 hidden (3 failed, signed out, 1 stopped)',
      'the shorter prefix keeps the reason before it gives way');
    assert.equal(renderBoard(rows, dir, 0, 60, 4).split('\n')[3], '4 more not shown (3 failed, all signed out, 1 stopped)',
      'room for it: the reason stays and only the why goes');

    const mixed = rows.map((r) => (r.member === 'f4' ? { ...r, last_result_reason: 'timed out' } : r));
    assert.equal(renderBoard(mixed, dir, 0, 0, 4).split('\n')[3], '4 more not shown (3 failed, 2 signed out, 1 stopped), the window is too short',
      'mixed reasons: the one most of them share');
    const split = rows.map((r) => (r.member === 'f3' || r.member === 'f4' ? { ...r, last_result_reason: r.member === 'f3' ? 'timed out' : 'bad exit 2' } : r));
    assert.equal(renderBoard(split, dir, 0, 0, 4).split('\n')[3], '4 more not shown (3 failed, signed out, timed out and bad exit 2, 1 stopped), the window is too short',
      'no reason shared by two: each one named');
    assert.equal(renderBoard(split, dir, 0, 50, 4).split('\n')[3], '4 more not shown (3 failed, 1 stopped)',
      'no room for every reason: just the count');
    const tied = [...mixed, { ...mixed.find((r) => r.member === 'f4'), member: 'f5', last_result_reason: 'timed out' }];
    assert.equal(renderBoard(tied, dir, 0, 0, 4).split('\n')[3], '5 more not shown (4 failed, 2 signed out and 2 timed out, 1 stopped), the window is too short',
      'two reasons tied: both named with their counts');
    const partial = split.map((r) => (r.member === 'f4' ? { ...r, last_result_reason: '' } : r));
    assert.equal(renderBoard(partial, dir, 0, 0, 4).split('\n')[3], '4 more not shown (3 failed, 1 stopped), the window is too short',
      'a failure with no written reason: naming the rest would read as all of them');
    const unwritten = rows.map((r) => (r.member.startsWith('f') ? { ...r, last_result_reason: '' } : r));
    assert.equal(renderBoard(unwritten, dir, 0, 0, 4).split('\n')[3], '4 more not shown (3 failed, 1 stopped), the window is too short',
      'no written reason: just the count');
    const one = rows.filter((r) => r.member !== 'f3' && r.member !== 'f4');
    one.push({ ...one.find((r) => r.member === 'halted'), member: 'halted2' });
    assert.equal(renderBoard(one, dir, 0, 0, 4).split('\n')[3], '3 more not shown (1 failed, signed out, 2 stopped), the window is too short',
      'one hidden failure says its own reason');
    const quiet = one.map((r) => (r.member === 'f2' ? { ...r, last_result_reason: '' } : r));
    assert.equal(renderBoard(quiet, dir, 0, 0, 4).split('\n')[3], '3 more not shown (1 failed, 2 stopped), the window is too short',
      'one hidden failure with no written reason: just the count');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('last step skips writes to the member own log', () => {
  const dir = fakeDir({
    architect: [
      `${at(300)} m-5 started: plan the board`,
      `${at(200)} m-5 running: node --test test/member-board.test.js`,
      `${at(100)} m-5 running: mkdir -p atris/team/architect/logs && cat >> atris/team/architect/logs/2026-10-13.md`,
      `${at(50)} m-5 running: cat >> atris/team/architect/logs/2026-10-13.md <<'EOF'`,
    ],
    scribe: [
      `${at(40)} m-6 started: only log today`,
      `${at(30)} m-6 running: cat >> atris/team/scribe/logs/2026-10-13.md`,
    ],
    helper: [
      `${at(40)} m-7 started: write a teammate note`,
      `${at(30)} m-7 running: cat >> atris/team/scribe/logs/2026-10-13.md`,
    ],
  });
  try {
    const by = Object.fromEntries(readBoard({ dir, now: NOW }).map((r) => [r.member, r]));
    assert.equal(by.architect.step, 'running: node --test test/member-board.test.js');
    assert.equal(by.architect.ago, '50s ago', 'the log write still counts as activity');
    assert.match(by.scribe.step, /^running: cat >> atris\/team\/scribe\/logs/, 'falls back when only housekeeping happened');
    assert.match(by.helper.step, /scribe\/logs/, 'another member log is real work');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('members that finished over an hour ago hide unless --all', () => {
  const dir = fakeDir({
    old: [`${at(7200)} m-8 started: yesterday's job`, `${at(3700)} m-8 finished: ok`],
    fresh: [`${at(600)} m-9 started: just landed`, `${at(500)} m-9 finished: failed`],
    stuck: [`${at(9000)} m-10 started: long quiet`, `${at(8000)} m-10 running: npm test`],
  });
  try {
    assert.deepEqual(readBoard({ dir, now: NOW }).map((r) => r.member), ['fresh', 'stuck']);
    assert.deepEqual(readBoard({ dir, now: NOW, all: true }).map((r) => r.member), ['fresh', 'old', 'stuck']);

    const env = { ...process.env, ATRIS_PROGRESS_DIR: dir };
    // Real clock: the fake logs are from 2026-10-13, so every finished member is old.
    const res = spawnSync(process.execPath, [cliPath, 'member', 'board'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /^(old|fresh)\s/m);
    assert.match(res.stdout, /^stuck\s+quiet/m);
    assert.match(res.stdout, /^2 finished over an hour ago, hidden\. --all shows them$/m);

    const all = spawnSync(process.execPath, [cliPath, 'member', 'board', '--all'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /^old\s+done ok/m);
    assert.match(all.stdout, /^fresh\s+done failed/m);
    assert.doesNotMatch(all.stdout, /hidden/);

    const json = spawnSync(process.execPath, [cliPath, 'member', 'board', '--json'], { cwd: dir, env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(json.stdout).members.map((r) => r.member), ['stuck']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('board says nobody is working when every member is hidden', () => {
  assert.equal(renderBoard([], '/x', 3), 'nobody is working right now. 3 finished over an hour ago, hidden. --all shows them');
});

test('atris member board reads ATRIS_PROGRESS_DIR for real', () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const dir = fakeDir({ navigator: [`${recent} m-9 started: map the repo`, `${recent} m-9 reading atris/MAP.md`] });
  try {
    const env = { ...process.env, ATRIS_PROGRESS_DIR: dir };
    const once = spawnSync(process.execPath, [cliPath, 'member', 'board'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(once.status, 0, once.stderr);
    assert.match(once.stdout, /^navigator\s+working\s+-\s+-\s+-\s+-\s+\d+s ago\s+map the repo\s+reading atris\/MAP\.md$/m);

    const watch = spawnSync(process.execPath, [cliPath, 'member', 'board', '--watch'], { cwd: dir, env, encoding: 'utf8', timeout: 3700 });
    assert.equal(watch.signal, 'SIGTERM', 'watch stays open until stopped');
    assert.equal(watch.stdout.split('redraws every 3s').length - 1, 2, 'drew once, then redrew at 3s');
    assert.match(watch.stdout, /\x1b\[2J\x1b\[H/);
    assert.match(watch.stdout, /navigator\s+working/);
    assert.match(watch.stdout, /redraws every 3s/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris member board says so plainly when no member has a log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-empty-'));
  try {
    const res = spawnSync(process.execPath, [cliPath, 'member', 'board'], {
      cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir }, encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), `no member progress yet in ${dir}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('progress lines turn into stream events', () => {
  const { progressEvent } = require('../lib/member-board');
  assert.deepEqual(progressEvent('builder', '2026-10-13T12:00:00.000Z m-1 started: ship the stream'),
    { member: 'builder', mission: 'm-1', at: '2026-10-13T12:00:00.000Z', kind: 'started', text: 'ship the stream' });
  assert.deepEqual(progressEvent('builder', '2026-10-13T12:00:01Z m-1 running: npm test'),
    { member: 'builder', mission: 'm-1', at: '2026-10-13T12:00:01.000Z', kind: 'step', text: 'running: npm test' });
  assert.deepEqual(progressEvent('builder', '2026-10-13T12:00:02.000Z m-1 finished: ok'),
    { member: 'builder', mission: 'm-1', at: '2026-10-13T12:00:02.000Z', kind: 'finished', text: 'ok', ok: true });
  assert.equal(progressEvent('builder', '2026-10-13T12:00:03.000Z m-1 finished: failed').ok, false);
  assert.equal(progressEvent('builder', 'not a progress line'), null);
  assert.equal(progressEvent('builder', 'yesterday m-1 started: x'), null);
});

test('follow emits only new full lines, picks up new members, survives truncation', () => {
  const { followBoard } = require('../lib/member-board');
  const dir = fakeDir({ builder: [`${at(60)} m-1 started: old job`] });
  const events = [];
  const follower = followBoard({ dir, emit: (e) => events.push(e), pollMs: 60_000 });
  try {
    follower.scan();
    assert.deepEqual(events, [], 'lines already on disk belong to the snapshot');

    const log = path.join(dir, 'builder.log');
    fs.appendFileSync(log, `${at(30)} m-1 reading lib/a.js\n${at(20)} m-1 edit`);
    follower.scan();
    assert.deepEqual(events.map((e) => e.text), ['reading lib/a.js'], 'half-written line waits');

    fs.appendFileSync(log, 'ing lib/b.js\n');
    fs.writeFileSync(path.join(dir, 'scout.log'), `${at(10)} m-2 started: find stale docs\njunk line\n`);
    follower.scan();
    assert.deepEqual(events.slice(1).map((e) => [e.member, e.kind, e.text]), [
      ['builder', 'step', 'editing lib/b.js'],
      ['scout', 'started', 'find stale docs'],
    ]);

    fs.writeFileSync(log, `${at(5)} m-3 finished: ok\n`);
    follower.scan();
    assert.deepEqual(events[events.length - 1], {
      member: 'builder', mission: 'm-3', at: at(5), kind: 'finished', text: 'ok', ok: true,
    });
    assert.equal(events.length, 4);
  } finally {
    follower.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris member board --json --follow streams one JSON object per line', async () => {
  const { spawn } = require('node:child_process');
  const recent = new Date(Date.now() - 5_000).toISOString();
  const dir = fakeDir({ navigator: [`${recent} m-9 started: map the repo`] });
  const child = spawn(process.execPath, [cliPath, 'member', 'board', '--json', '--follow'], {
    cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (n) => {
    const until = Date.now() + 8000;
    while (lines().length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return lines();
  };
  try {
    const [snapshot] = await waitFor(1);
    assert.equal(snapshot.kind, 'snapshot');
    assert.equal(snapshot.dir, dir);
    assert.deepEqual(snapshot.members.map((m) => [m.member, m.state]), [['navigator', 'working']]);

    const now = new Date().toISOString();
    fs.appendFileSync(path.join(dir, 'navigator.log'), `${now} m-9 reading atris/MAP.md\n`);
    fs.writeFileSync(path.join(dir, 'scout.log'), `${now} m-10 finished: failed\n`);
    const got = await waitFor(3);
    assert.equal(got.length, 3, out);
    const byMember = Object.fromEntries(got.slice(1).map((e) => [e.member, e]));
    assert.deepEqual(byMember.navigator, { member: 'navigator', mission: 'm-9', at: now, kind: 'step', text: 'reading atris/MAP.md' });
    assert.deepEqual(byMember.scout, { member: 'scout', mission: 'm-10', at: now, kind: 'finished', text: 'failed', ok: false });
    assert.equal(child.exitCode, null, 'still following');
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('follow finishes a line that was half written before it started', () => {
  const { followBoard } = require('../lib/member-board');
  const dir = fakeDir({ builder: [`${at(60)} m-1 started: verify stream`] });
  const log = path.join(dir, 'builder.log');
  fs.appendFileSync(log, `${at(30)} m-1 reading par`);
  fs.writeFileSync(path.join(dir, 'blank.log'), `${at(20)} m-2 no newline yet`);
  const events = [];
  const follower = followBoard({ dir, emit: (e) => events.push(e), pollMs: 60_000 });
  try {
    follower.scan();
    assert.deepEqual(events, [], 'nothing complete yet');
    fs.appendFileSync(log, 'tial at startup\n');
    fs.appendFileSync(path.join(dir, 'blank.log'), ' until now\n');
    follower.scan();
    assert.deepEqual(events.map((e) => [e.member, e.text]), [
      ['blank', 'no newline yet until now'],
      ['builder', 'reading partial at startup'],
    ]);
  } finally {
    follower.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A spawned sleeper stands in for a member's engine run. detached makes it a
// process group leader, the same way the mission runner spawns the engine.
// The sleepers are node processes; stand in for a real engine command line.
// agoSec matches the started line's age, so the run's start time lines up.
const TOKEN = '0123456789abcdef';
const engineAs = (program, agoSec = 60, member = 'builder', token = TOKEN) => {
  const startedAt = Date.now() - agoSec * 1000;
  return {
    readProcess: (pid) => (pid === process.pid
      ? { pgid: -1, command: 'node test', startedAt: Date.now() }
      : { pgid: pid, command: `${program} -p atris-run ${member} ${token}\\012work --model x`, startedAt }),
  };
};
const asEngine = engineAs('claude');

function spawnSleeper(script) {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const ready = new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.trim()); });
  });
  return { child, ready };
}

const waitFor = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (check()) return true;
  return check();
};

const killAll = (pid) => { try { process.kill(-pid, 'SIGKILL'); } catch {} };
const isoAgo = (s) => new Date(Date.now() - s * 1000).toISOString();

test('board shows a live run as alive with its engine, and a dead one as stopped', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({
    builder: [`${isoAgo(90)} m-1 started: [pid ${child.pid} engine claude run ${TOKEN}] ship the board`, `${isoAgo(5)} m-1 reading lib/a.js`],
    legacy: [`${isoAgo(30)} m-2 started: old line with no pid`, `${isoAgo(5)} m-2 reading x`],
  });
  try {
    let by = Object.fromEntries(readBoard({ dir }).map((r) => [r.member, r]));
    assert.equal(by.builder.state, 'working');
    assert.equal(by.builder.alive, true);
    assert.equal(by.builder.engine, 'claude');
    assert.equal(by.builder.running_for, '1m');
    assert.equal(by.builder.job, 'ship the board', 'the run tag stays out of the job column');
    assert.equal(by.legacy.alive, null, 'no pid means the board cannot tell');
    assert.equal(by.legacy.state, 'working');
    assert.match(renderBoard(readBoard({ dir }), dir), /^builder\s+working\s+-\s+yes\s+claude\s+1m\s+\d+s ago\s+ship the board/m);

    child.kill('SIGKILL');
    assert.ok(await waitFor(() => !isAlive(child.pid)), 'sleeper should be gone');
    by = Object.fromEntries(readBoard({ dir }).map((r) => [r.member, r]));
    assert.equal(by.builder.state, 'stopped', 'marked working but the process is gone');
    assert.equal(by.builder.alive, false);
    assert.equal(by.builder.running_for, '');
    assert.equal(by.builder.no_result, true, 'it ended without a finished line');
    assert.equal(by.legacy.no_result, false, 'no pid: the board cannot tell');
    assert.match(renderBoard(readBoard({ dir }), dir), /^builder\s+stopped\s+ended, no result\s+no\s+claude\s+-\s+/m);
    assert.match(renderBoard(readBoard({ dir }), dir, 0, 58), /^builder\s+stopped\s+ended, no result\s/m, 'a job cut either way: the wording stays whole');
    const sixty = renderBoard(readBoard({ dir }), dir, 0, 60);
    assert.match(sixty, /^builder\s+stopped\s+no result\s+\S+ ago\s+ship the board$/m, 'shorter wording lets every job read whole');
    assert.match(sixty, /old line with no pid$/m);
  } finally {
    killAll(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop ends the run and everything it started, then logs finished: stopped', async () => {
  // The sleeper starts its own grandchild, like an engine running a shell command.
  const { child, ready } = spawnSleeper(
    "const c = require('child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)",
  );
  const grandchild = Number(await ready);
  const dir = fakeDir({ builder: [`${isoAgo(125)} m-9 started: [pid ${child.pid} engine claude run ${TOKEN}] long job`, `${isoAgo(3)} m-9 running: npm test`] });
  try {
    assert.ok(isAlive(grandchild));
    const result = await stopMember('builder', { dir, deps: engineAs('claude', 125) });
    assert.equal(result.ok, true);
    assert.equal(result.forced, false);
    assert.equal(result.message, 'stopped builder after 2m of work');
    assert.ok(await waitFor(() => !isAlive(child.pid)), 'member run is gone');
    assert.ok(await waitFor(() => !isAlive(grandchild)), 'what it started is gone too');
    const log = fs.readFileSync(path.join(dir, 'builder.log'), 'utf8');
    assert.match(log.trim().split('\n').pop(), /^\S+ m-9 finished: stopped$/);
    const [row] = readBoard({ dir });
    assert.equal(row.state, 'stopped');
    assert.equal((await stopMember('builder', { dir, deps: asEngine })).message, 'nothing running', 'second stop finds nothing');
  } finally {
    killAll(child.pid);
    try { process.kill(grandchild, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop forces a run that ignores the polite signal', async () => {
  const { child, ready } = spawnSleeper("process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({ stubborn: [`${isoAgo(10)} m-5 started: [pid ${child.pid} engine codex run ${TOKEN}] dig in`] });
  try {
    const result = await stopMember('stubborn', { dir, graceMs: 300, deps: engineAs('/opt/homebrew/bin/codex', 10, 'stubborn') });
    assert.equal(result.ok, true);
    assert.equal(result.forced, true);
    assert.match(result.message, /^stopped stubborn after \d+s of work, it had to be forced$/);
    assert.ok(await waitFor(() => !isAlive(child.pid)));
  } finally {
    killAll(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop says nothing running for unknown, finished, untagged, or dead runs', async () => {
  const dir = fakeDir({
    done: [`${isoAgo(60)} m-1 started: [pid ${process.pid} engine claude] x`, `${isoAgo(30)} m-1 finished: ok`],
    legacy: [`${isoAgo(60)} m-2 started: no pid here`],
    ghost: [`${isoAgo(60)} m-3 started: [pid 2147483646 engine claude] gone`],
  });
  try {
    for (const name of ['nobody', 'done', 'legacy', 'ghost', '', '../done']) {
      assert.equal((await stopMember(name, { dir, deps: asEngine })).message, 'nothing running', name);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'done.log'), 'utf8').includes('stopped'), false);
    const res = spawnSync(process.execPath, [cliPath, 'member', 'stop', 'nobody'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim().split('\n').pop(), 'nothing running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop leaves a reused pid alone when its command is no longer the engine', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({ builder: [`${isoAgo(60)} m-7 started: [pid ${child.pid} engine claude] old job`] });
  try {
    const result = await stopMember('builder', { dir, deps: { readProcess: (pid) => ({ pgid: pid, command: 'node /usr/local/bin/some-other-app', startedAt: Date.now() - 60000 }) } });
    assert.equal(result.message, 'nothing running');
    assert.equal(isAlive(child.pid), true, 'the unrelated process keeps running');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop refuses system pids, its own group, and engines it does not know', async () => {
  const lines = (pid, engine) => [`${isoAgo(20)} m-8 started: [pid ${pid} engine ${engine}] forged`];
  for (const [pid, engine] of [[1, 'launchd'], [1, 'claude'], [process.pid, 'claude'], [4242, 'launchd']]) {
    const dir = fakeDir({ forged: lines(pid, engine) });
    try {
      const deps = { readProcess: (p) => ({ pgid: p, command: `${engine} -p`, startedAt: Date.now() - 20000 }) };
      const result = await stopMember('forged', { dir, graceMs: 50, deps });
      assert.equal(result.message, 'nothing running', `pid ${pid} engine ${engine}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('member stop leaves a same-named engine alone when it started at a different time', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({ builder: [`${isoAgo(600)} m-6 started: [pid ${child.pid} engine claude] long gone`] });
  try {
    const result = await stopMember('builder', { dir, deps: engineAs('claude', 5) });
    assert.equal(result.message, 'nothing running');
    assert.equal(isAlive(child.pid), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop ignores engine names that are object keys', async () => {
  for (const engine of ['constructor', '__proto__', 'toString']) {
    const dir = fakeDir({ odd: [`${isoAgo(20)} m-4 started: [pid 4242 engine ${engine}] odd`] });
    try {
      const result = await stopMember('odd', { dir, deps: engineAs('claude', 20) });
      assert.equal(result.message, 'nothing running', engine);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('member stop needs the run token of that member in the live command', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  try {
    for (const [line, deps, label] of [
      [`started: [pid ${child.pid} engine claude] no token`, engineAs('claude', 20), 'no token in the log'],
      [`started: [pid ${child.pid} engine claude run ${TOKEN}] x`, engineAs('claude', 20, 'someone-else'), 'token belongs to another member'],
      [`started: [pid ${child.pid} engine claude run ${TOKEN}] x`, engineAs('claude', 20, 'builder', 'ffffffffffffffff'), 'different token'],
    ]) {
      const dir = fakeDir({ builder: [`${isoAgo(20)} m-2 ${line}`] });
      try {
        assert.equal((await stopMember('builder', { dir, graceMs: 50, deps })).message, 'nothing running', label);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(isAlive(child.pid), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

test('member stop does not hard-kill a process that replaced the run during the grace wait', async () => {
  const { child, ready } = spawnSleeper("process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  const dir = fakeDir({ builder: [`${isoAgo(20)} m-3 started: [pid ${child.pid} engine claude run ${TOKEN}] x`] });
  let calls = 0;
  const first = engineAs('claude', 20).readProcess;
  const deps = {
    readProcess: (pid) => {
      if (pid === process.pid) return first(pid);
      calls += 1;
      const info = first(pid);
      // After the polite signal, the pid now belongs to a newer process.
      return calls === 1 ? info : { ...info, startedAt: info.startedAt + 10000 };
    },
  };
  try {
    const result = await stopMember('builder', { dir, graceMs: 200, deps });
    assert.equal(result.forced, false);
    assert.equal(isAlive(child.pid), true, 'the replacement was not hard-killed');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('member stop needs the marker to open the prompt, as whole words', async () => {
  const { child, ready } = spawnSleeper("console.log('up'); setInterval(() => {}, 1000)");
  await ready;
  try {
    for (const command of [
      `claude -p hello atris-run builder ${TOKEN}`,
      `claude -p atris-run builder ${TOKEN}ff more`,
      `claude -p atris-run builderx ${TOKEN}`,
      `claude --resume x atris-run builder ${TOKEN}`,
      `claude -p other prompt -p atris-run builder ${TOKEN} more`,
      `node claude -p atris-run builder ${TOKEN} x`,
    ]) {
      const dir = fakeDir({ builder: [`${isoAgo(20)} m-2 started: [pid ${child.pid} engine claude run ${TOKEN}] x`] });
      const deps = { readProcess: (pid) => (pid === process.pid ? { pgid: -1, command: 'node', startedAt: Date.now() } : { pgid: pid, command, startedAt: Date.now() - 20000 }) };
      try {
        assert.equal((await stopMember('builder', { dir, graceMs: 50, deps })).message, 'nothing running', command);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    assert.equal(isAlive(child.pid), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

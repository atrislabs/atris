'use strict';

const test = require('node:test');
const assert = require('node:assert').strict;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeCommand } = require('../commands/write');

// writeCommand reads its workspace from process.cwd(), so each test moves into
// its own temp folder and moves back when it ends.
function inTempWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-write-cmd-'));
  const before = process.cwd();
  process.chdir(root);
  t.after(() => {
    process.chdir(before);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// Runs writeCommand and collects what it prints, so the test can assert on it.
function run(argv) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  try {
    const code = writeCommand(argv);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function sessionFile(root, slug, name) {
  return path.join(root, 'atris', 'writing', slug, name);
}

// Puts words under one beat heading, the way a human types them into draft.md.
function typeUnder(root, slug, heading, words) {
  const file = sessionFile(root, slug, 'draft.md');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(`## ${heading}\n`, `## ${heading}\n${words}\n`));
}

test('start with a topic creates the session files and reports the first question', (t) => {
  const root = inTempWorkspace(t);
  const r = run(['start', 'Quiet Mornings', '--beats', 'Open | Close']);
  assert.equal(r.code, 0);
  assert.match(r.out, /session started: quiet-mornings/);
  assert.match(r.out, /beats: Open .+ Close/);
  assert.match(r.out, /first question: What question does "Open" answer for the reader\?/);

  const plan = fs.readFileSync(sessionFile(root, 'quiet-mornings', 'plan.md'), 'utf8');
  assert.match(plan, /^# plan: Quiet Mornings$/m);
  assert.match(plan, /^- \[ \] 1\. Open$/m);
  assert.match(plan, /^- \[ \] 2\. Close$/m);

  const draft = fs.readFileSync(sessionFile(root, 'quiet-mornings', 'draft.md'), 'utf8');
  assert.match(draft, /^## Open$/m);
  assert.match(draft, /^## Close$/m);
});

test('a bare topic is shorthand for start', (t) => {
  const root = inTempWorkspace(t);
  const r = run(['Bare Topic', '--beats', 'Only']);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(sessionFile(root, 'bare-topic', 'plan.md')));
});

test('start refuses a duplicate session and a missing topic, and writes nothing for either', (t) => {
  const root = inTempWorkspace(t);
  assert.equal(run(['start', 'Twice', '--beats', 'A']).code, 0);

  const again = run(['start', 'Twice']);
  assert.equal(again.code, 2);
  assert.match(again.err, /session already exists: twice/);

  const missing = run(['start']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /usage: atris write start/);

  assert.deepEqual(fs.readdirSync(path.join(root, 'atris', 'writing')), ['twice']);
});

test('status counts empty beats and points at the first one still empty', (t) => {
  inTempWorkspace(t);
  run(['start', 'Status Check', '--beats', 'Open | Close']);
  const r = run(['status']);
  assert.equal(r.code, 0);
  assert.match(r.out, /0 passed · 0 drafted · 0 words/);
  assert.match(r.out, /1\. Open\s+empty/);
  assert.match(r.out, /2\. Close\s+empty/);
  assert.match(r.out, /next: answer "What question does "Open" answer/);
});

test('pass refuses a beat with no words, then passes one that has words', (t) => {
  const root = inTempWorkspace(t);
  run(['start', 'Pass Test', '--beats', 'Open | Close']);

  const blank = run(['pass', '1']);
  assert.equal(blank.code, 2);
  assert.match(blank.err, /beat 1 "Open" has no words yet/);

  typeUnder(root, 'pass-test', 'Open', 'I heard the kettle first.');
  const ok = run(['pass', '1']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /passed: 1\. Open/);
  const plan = fs.readFileSync(sessionFile(root, 'pass-test', 'plan.md'), 'utf8');
  assert.match(plan, /^- \[x\] 1\. Open$/m);

  const bad = run(['pass', 'first']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /usage: atris write pass/);
});

test('review exits 1 on slop and on an empty beat, and exits 0 once the draft is clean', (t) => {
  const root = inTempWorkspace(t);
  run(['start', 'Review Test', '--beats', 'Only | Second']);

  typeUnder(root, 'review-test', 'Only', 'This will seamlessly revolutionize writing.');
  const slop = run(['review', '--json']);
  assert.equal(slop.code, 1);
  const parsed = JSON.parse(slop.out);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.slop.length > 0, 'slop findings are reported');
  assert.equal(parsed.beats[0].state, 'drafted');
  assert.equal(parsed.beats[1].words, 0);

  const file = sessionFile(root, 'review-test', 'draft.md');
  fs.writeFileSync(file, '# Review Test\n\n## Only\nA plain sentence in my own voice.\n\n## Second\n');
  const holes = run(['review']);
  assert.equal(holes.code, 1);
  assert.match(holes.out, /1 beat still empty: Second/);
  assert.match(holes.out, /slop scan clean/);

  typeUnder(root, 'review-test', 'Second', 'Another plain line.');
  const clean = run(['review']);
  assert.equal(clean.code, 0);
  assert.match(clean.out, /slop scan clean/);
});

test('list says so when there are no sessions, and names each one once started', (t) => {
  inTempWorkspace(t);
  const empty = run(['list']);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /no writing sessions yet/);

  run(['start', 'Alpha', '--beats', 'A']);
  run(['start', 'Beta', '--beats', 'B']);
  const r = run(['list']);
  assert.equal(r.code, 0);
  assert.match(r.out, /alpha\s+Alpha/);
  assert.match(r.out, /beta\s+Beta/);
});

test('coach --offline asks the next beat question and reads the dump, without touching the draft', (t) => {
  const root = inTempWorkspace(t);
  run(['start', 'Coach Test', '--beats', 'Open | Close', '--dump', 'Rain hit the tin roof. Nobody woke up.']);
  const draftFile = sessionFile(root, 'coach-test', 'draft.md');
  const draftBefore = fs.readFileSync(draftFile, 'utf8');

  const r = run(['coach', '--offline']);
  assert.equal(r.code, 0);
  assert.match(r.out, /next beat: Open/);
  assert.match(r.out, /question: What question does "Open" answer/);
  assert.match(r.out, /your raw material/);
  assert.match(r.out, /· Rain hit the tin roof\./);
  assert.match(r.out, /· Nobody woke up\./);
  assert.equal(fs.readFileSync(draftFile, 'utf8'), draftBefore);
});

test('coach --offline moves to the next beat once words land under the first', (t) => {
  const root = inTempWorkspace(t);
  run(['start', 'Next Beat', '--beats', 'Open | Close']);
  typeUnder(root, 'next-beat', 'Open', 'I wrote this down.');

  const r = run(['coach', '--offline']);
  assert.equal(r.code, 0);
  assert.match(r.out, /4 words in, 0\/2 beats passed/);
  assert.match(r.out, /you have 4 words down/);
  assert.match(r.out, /next beat: Close/);
});

test('bare write with no sessions prints help, and with a session it coaches', (t) => {
  inTempWorkspace(t);
  const help = run([]);
  assert.equal(help.code, 0);
  assert.match(help.out, /guided writing sessions/);

  run(['start', 'Front Door', '--beats', 'Only']);
  const coached = run(['--offline']);
  assert.equal(coached.code, 0);
  assert.match(coached.out, /coach · Front Door/);
});

test('commands that need a session refuse with exit 2 when there is none', (t) => {
  inTempWorkspace(t);
  for (const argv of [['status'], ['review'], ['pass', '1'], ['coach', '--offline']]) {
    const r = run(argv);
    assert.equal(r.code, 2, `atris write ${argv.join(' ')} should exit 2`);
    assert.match(r.err, /no writing session found/);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scriptCommand, codeName, readAnswer } = require('../commands/script');
const { SCRIPTS_DIR } = require('../lib/script-registry');

const NOW = new Date(2026, 10, 16, 21, 30);

const ANSWERS = {
  readers: 1,
  gift: 'what ten years of night shifts taught me',
  voice: '3',
  rhythm: 'Once a week',
  proud: 1,
  number: '100 readers who are not friends',
  date: 'June 1',
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-script-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeAnswers(dir, answers = ANSWERS) {
  const file = path.join(dir, 'answers.json');
  fs.writeFileSync(file, JSON.stringify(answers));
  return 'answers.json';
}

// Stand-ins for the goal and member commands, so most tests stay on this
// command alone. The full flow test below uses the real ones.
function fakeTeam() {
  const calls = { goals: [], members: [] };
  return {
    calls,
    setGoal: async (sentence) => { calls.goals.push(sentence); return { ok: true, replaced: null }; },
    createMember: async (seat) => { calls.members.push(seat.name); return { ok: true, existed: false }; },
  };
}

async function run(dir, args, extra = {}) {
  const out = [];
  const errs = [];
  const team = extra.team || fakeTeam();
  const code = await scriptCommand(args, {
    cwd: dir,
    log: (line) => out.push(String(line)),
    err: (line) => errs.push(String(line)),
    prompt: extra.prompt === undefined ? null : extra.prompt,
    random: extra.random || (() => 0),
    now: extra.now || (() => NOW),
    sources: extra.sources,
    scriptsDir: extra.scriptsDir,
    setGoal: extra.real ? undefined : team.setGoal,
    createMember: extra.real ? undefined : team.createMember,
  });
  return { code, out: out.join('\n'), errs: errs.join('\n'), team };
}

function sequence(values) {
  const rolls = [...values];
  return () => (rolls.length ? rolls.shift() : 0);
}

function readRun(dir, code) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'storylines', code, 'script.json'), 'utf8'));
}

test('list shows the one finished script', async (t) => {
  const dir = tempDir(t);
  const { code, out } = await run(dir, ['list']);
  assert.equal(code, 0);
  assert.match(out, /newsletter\s+Start a newsletter or blog from nothing\./);
  assert.match(out, /Start one: atris script start newsletter/);
});

test('a second script file shows up in list with no command change, and unfinished ones stay hidden', async (t) => {
  const dir = tempDir(t);
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptsDir);
  const newsletter = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'newsletter.json'), 'utf8'));
  fs.writeFileSync(path.join(scriptsDir, 'newsletter.json'), JSON.stringify(newsletter));
  fs.writeFileSync(path.join(scriptsDir, 'podcast.json'), JSON.stringify({ ...newsletter, id: 'podcast', pitch: 'Start a podcast from nothing.' }));
  fs.writeFileSync(path.join(scriptsDir, 'bakery.json'), JSON.stringify({ ...newsletter, id: 'bakery', ready: false, pitch: 'Open a bakery.' }));
  fs.writeFileSync(path.join(scriptsDir, 'broken.json'), '{ not json');

  const { out } = await run(dir, ['list'], { scriptsDir });
  assert.match(out, /newsletter\s+Start a newsletter/);
  assert.match(out, /podcast\s+Start a podcast from nothing\./);
  assert.doesNotMatch(out, /bakery|broken/);

  const started = await run(dir, ['start', 'podcast', '--yes', '--answers', writeAnswers(dir)], { scriptsDir });
  assert.equal(started.code, 0, started.errs);
  assert.equal(readRun(dir, 'quiet-lantern').script, 'podcast');
});

test('code names are two plain words and steady under a fixed random source', () => {
  assert.equal(codeName(() => 0), 'quiet-lantern');
  assert.equal(codeName(() => 0.99), 'kind-bridge');
  assert.match(codeName(), /^[a-z]+-[a-z]+$/);
});

test('a typed answer is played back facing the person; a goal is never filled in for them', () => {
  const question = { id: 'gift', choices: [{ id: 'a', label: 'Lessons', says: 'lessons' }] };
  assert.equal(readAnswer(question, '1').says, 'lessons');
  assert.equal(readAnswer(question, 'what my nights taught me.').says, 'what your nights taught you');
  assert.equal(readAnswer(question, '   '), null);
  const goal = { id: 'number', goal: 'number' };
  assert.deepEqual(readAnswer(goal, ''), { picked: null, text: '', says: '', set: false });
  assert.equal(readAnswer(goal, 'not sure yet').set, false);
  assert.equal(readAnswer(goal, '7').text, '7');
});

test('the full opening: questions, a fixed line, real goal and team, one small first move', async (t) => {
  const dir = tempDir(t);
  const typed = [
    '2', // readers: people in my line of work
    '', '9', 'what ten years of night shifts taught me', // empty and off-list replies are asked again
    'Like a calm teacher',
    '1',
    'I kept going',
    '100 readers who are not friends',
    'June 1',
    '1', // fix line 1
    'nurses on night shift',
    '', // looks right, set it up
  ];
  const prompts = [];
  const prompt = async (text) => { prompts.push(text); return typed.shift(); };
  const { code, out, errs } = await run(dir, ['start', 'newsletter'], { prompt, real: true, random: sequence([0.15, 0.32]) });
  assert.equal(code, 0, errs);
  assert.equal(typed.length, 0, 'every answer was used');

  // The opening and the questions in the pick-or-type shape.
  assert.match(out, /^\nSteady Ember\nThat is the code name for this run\. It is yours now\./);
  assert.match(out, /● Who do you want to write for\?\n\n {2}1 {2}People one step behind me/);
  assert.match(out, /● What number would tell you this is working\? Say it your way\.\n {2}Not sure yet\? Press enter\./);

  // Playback, shown twice: before and after the fix.
  assert.match(out, /1 {2}You write for people in your line of work\./);
  assert.match(out, /1 {2}You write for nurses on night shift\./);
  assert.match(out, /2 {2}You give them what ten years of night shifts taught you\./);
  assert.match(out, /3 {2}You sound like a calm teacher, once a week\./);
  assert.match(out, /4 {2}You will be proud when you keep going\./);
  assert.match(out, /5 {2}Your goal: 100 readers who are not friends by June 1\./);
  assert.match(out, /Type a number to fix that line, or press enter to set it up\./);

  // The run, the page the game reads, the real project goal and the real team.
  const state = readRun(dir, 'steady-ember');
  assert.equal(state.mission, 'A newsletter that gives nurses on night shift what ten years of night shifts taught you, once a week.');
  assert.deepEqual(state.goal, { number: '100 readers who are not friends', date: 'June 1' });
  assert.equal(state.chapters.length, 5);
  assert.deepEqual(state.chapters.map((chapter) => chapter.title), [
    'Find your voice', 'First issue out', 'First 10 readers who are not friends', 'A steady rhythm for four issues', 'First paid reader',
  ]);
  assert.ok(state.chapters.every((chapter) => chapter.finish_line));
  assert.ok(state.values.will.includes('Write for nurses on night shift, not for everyone.'));
  assert.ok(state.values.will_not.includes('Send anything you did not approve.'));

  const page = fs.readFileSync(path.join(dir, 'atris', 'storylines', 'steady-ember.md'), 'utf8');
  assert.match(page, /^# Storyline: Steady Ember$/m);
  assert.match(page, /script: newsletter · started: 2026-11-16/);
  assert.match(page, /^1\. \*\*Find your voice\*\*\. Finish line: You approved one sample that sounds like you\. ← we are here$/m);
  assert.match(page, /^## Your part$/m);
  assert.doesNotMatch(page, /[—–]/);

  const scoreboard = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'scoreboard.json'), 'utf8'));
  assert.match(scoreboard.goal_text, /^100 readers who are not friends by June 1\. A newsletter that gives nurses/);
  for (const seat of ['editor', 'researcher', 'growth', 'publisher']) {
    const member = fs.readFileSync(path.join(dir, 'atris', 'team', seat, 'MEMBER.md'), 'utf8');
    assert.match(member, new RegExp(`^name: ${seat}$`, 'm'));
  }
  assert.match(fs.readFileSync(path.join(dir, 'atris', 'team', 'editor', 'MEMBER.md'), 'utf8'),
    /^description: Turns your rough lines into issues that still sound like you\.$/m);

  // Everything written is listed, then exactly one small next move.
  assert.match(out, /Your storyline page +atris\/storylines\/steady-ember\.md/);
  assert.match(out, /Your run +atris\/storylines\/steady-ember\/script\.json/);
  assert.match(out, /Project goal +100 readers who are not friends by June 1/);
  assert.match(out, /Their files are in atris\/team\/: editor, researcher, growth, publisher\./);
  assert.match(out, /Your first move, about 5 minutes:\n {2}Name your newsletter\./);
  assert.match(out, /atris script done name-it --by me --proof "the name you picked"$/);
  assert.equal((out.match(/Your first move/g) || []).length, 1);
  assert.doesNotMatch(out, /[—–]|great choice|amazing/i);
});

test('a second start with the same code name refuses and says how to resume', async (t) => {
  const dir = tempDir(t);
  const answers = writeAnswers(dir);
  const first = await run(dir, ['start', 'newsletter', '--name', 'Blue Fox', '--yes', '--answers', answers]);
  assert.equal(first.code, 0, first.errs);
  const before = fs.readFileSync(path.join(dir, 'atris', 'storylines', 'blue-fox', 'script.json'), 'utf8');

  const again = await run(dir, ['start', 'newsletter', '--name', 'blue-fox', '--yes', '--answers', answers]);
  assert.equal(again.code, 1);
  assert.match(again.errs, /Blue Fox is already running here, so I left it as it is\./);
  assert.match(again.errs, /Pick up where you left off: atris script status blue-fox/);
  assert.equal(fs.readFileSync(path.join(dir, 'atris', 'storylines', 'blue-fox', 'script.json'), 'utf8'), before);
  assert.deepEqual(again.team.calls, { goals: [], members: [] });
});

test('a random code name that is taken picks another instead of refusing', async (t) => {
  const dir = tempDir(t);
  const answers = writeAnswers(dir);
  await run(dir, ['start', 'newsletter', '--yes', '--answers', answers]);
  const second = await run(dir, ['start', 'newsletter', '--yes', '--answers', answers], { random: sequence([0, 0, 0, 0, 0.5, 0.5]) });
  assert.equal(second.code, 0, second.errs);
  assert.ok(fs.existsSync(path.join(dir, 'atris', 'storylines', 'clear-orchard', 'script.json')));
  assert.match(second.out, /atris script done name-it --run clear-orchard --by me/);
});

test('a skipped number and date stay not set, and status says so', async (t) => {
  const dir = tempDir(t);
  const answers = writeAnswers(dir, { ...ANSWERS, number: '', date: 'not sure yet' });
  const started = await run(dir, ['start', 'newsletter', '--yes', '--answers', answers]);
  assert.equal(started.code, 0, started.errs);
  assert.match(started.out, /5 {2}Your goal: not set yet\. That is fine for now\./);
  assert.match(started.out, /Your number and date are not set yet\. They are yours to choose, when you know them\./);
  assert.match(started.out, /Project goal +your mission, until you pick a number/);
  assert.deepEqual(readRun(dir, 'quiet-lantern').goal, { number: null, date: null });
  assert.doesNotMatch(started.team.calls.goals[0], /\d/);

  const status = await run(dir, ['status']);
  assert.match(status.out, /Goal +not set yet\. Yours to choose, when you are ready\./);
  assert.match(status.out, /Waiting on you[\s\S]*Your number and date, when you know them\./);
  assert.match(status.out, /atris script goal quiet-lantern --number "\.\.\." --date "\.\.\."/);

  const goal = await run(dir, ['goal', '--number', '50 readers', '--date', 'March']);
  assert.equal(goal.code, 0, goal.errs);
  assert.deepEqual(readRun(dir, 'quiet-lantern').goal, { number: '50 readers', date: 'March' });
  assert.match(goal.team.calls.goals[0], /^50 readers by March\. A newsletter/);
});

test('start with --yes needs answers, and a missing answer is named', async (t) => {
  const dir = tempDir(t);
  const none = await run(dir, ['start', 'newsletter', '--yes']);
  assert.equal(none.code, 1);
  assert.match(none.errs, /--yes needs your answers in a file/);
  const { readers, ...rest } = ANSWERS;
  const missing = await run(dir, ['start', 'newsletter', '--yes', '--answers', writeAnswers(dir, rest)]);
  assert.equal(missing.code, 1);
  assert.match(missing.errs, /The answers file is missing: readers\./);
  const unknown = await run(dir, ['start', 'cookbook']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.errs, /There is no script called cookbook\./);
  const noTerminal = await run(dir, ['start', 'newsletter']);
  assert.equal(noTerminal.code, 1);
  assert.match(noTerminal.errs, /run it in a terminal/);
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'nothing written on a refusal');
});

test('status with zero, one and several runs', async (t) => {
  const dir = tempDir(t);
  const zero = await run(dir, ['status']);
  assert.equal(zero.code, 0);
  assert.match(zero.out, /No runs here yet\.\nStart one: atris script start newsletter/);

  const answers = writeAnswers(dir);
  await run(dir, ['start', 'newsletter', '--name', 'blue fox', '--yes', '--answers', answers]);
  const one = await run(dir, ['status']);
  assert.equal(one.code, 0);
  assert.match(one.out, /^Blue Fox\nStart a newsletter\n/);
  assert.match(one.out, /Mission +A newsletter that gives people one step behind you what ten years of night shifts taught you, once a week\./);
  assert.match(one.out, /Chapter +1 of 5, Find your voice\nFinish line +You approved one sample that sounds like you\./);
  assert.match(one.out, /Next move +Name your newsletter\./);
  assert.match(one.out, /Waiting on you\n {2}Name your newsletter\.\n {2}Write three rough sentences/);

  await run(dir, ['start', 'newsletter', '--name', 'red owl', '--yes', '--answers', answers]);
  const several = await run(dir, ['status']);
  assert.equal(several.code, 0);
  assert.match(several.out, /You have more than one run here:/);
  assert.match(several.out, /blue-fox +chapter 1 of 5, Find your voice/);
  assert.match(several.out, /red-owl +chapter 1 of 5, Find your voice/);
  assert.match(several.out, /Pick one: atris script status blue-fox/);
  const picked = await run(dir, ['status', 'red-owl']);
  assert.match(picked.out, /^Red Owl\n/);
  const json = JSON.parse((await run(dir, ['status', 'red-owl', '--json'])).out);
  assert.equal(json.next.id, 'name-it');
  assert.equal(json.goal.set, true);
});

test('next speaks to the person and to the team; done keeps taste with the person', async (t) => {
  const dir = tempDir(t);
  await run(dir, ['start', 'newsletter', '--yes', '--answers', writeAnswers(dir)]);

  const next = await run(dir, ['next']);
  assert.match(next.out, /^Next, yours, about 5 minutes\n {2}Name your newsletter\./);
  assert.match(next.out, /For the team\n {2}Wait for the name\. It is theirs to pick\./);
  assert.match(next.out, /Only you can mark this one:\n {2}atris script done name-it --by me --proof "the name you picked"/);

  // A taste move is refused without --by me, kindly, and nothing moves.
  const refused = await run(dir, ['done', 'name-it', '--proof', 'Night Notes']);
  assert.equal(refused.code, 1);
  assert.match(refused.errs, /This one is yours to call\. Only you can say it feels right\./);
  assert.equal(readRun(dir, 'quiet-lantern').chapters[0].moves[0].state, 'open');

  // A later chapter waits its turn.
  const early = await run(dir, ['done', 'pick-home']);
  assert.equal(early.code, 1);
  assert.match(early.errs, /That move is in a later chapter, First issue out\. One step at a time\./);

  const named = await run(dir, ['done', 'name-it', '--by', 'me', '--proof', 'Night Notes']);
  assert.equal(named.code, 0, named.errs);
  assert.match(named.out, /^Done: Name your newsletter\./);
  assert.match(named.out, /Next: Write three rough sentences/);
  const file = path.join(dir, 'atris', 'storylines', 'quiet-lantern', 'script.json');
  const before = fs.readFileSync(file, 'utf8');
  const again = await run(dir, ['done', 'name-it', '--by', 'someone-else']);
  assert.deepEqual({ code: again.code, out: again.out, errs: again.errs }, {
    code: 1, out: '', errs: `This move was already finished by me at ${NOW.toISOString()}.`,
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  await run(dir, ['done', 'first-lines', '--by', 'me', '--proof', 'atris/storylines/quiet-lantern/first-lines.md']);
  const teamNext = await run(dir, ['next']);
  assert.match(teamNext.out, /^Next, your editor\n {2}Your editor turns your three sentences/);
  assert.match(teamNext.out, /Brief for editor\n {2}Read atris\/storylines\/quiet-lantern\/first-lines\.md\./);
  assert.match(teamNext.out, /When it is done:\n {2}atris script done voice-sample$/);
  const teamDone = await run(dir, ['done', 'voice-sample']);
  assert.equal(teamDone.code, 0, teamDone.errs);
  assert.equal(readRun(dir, 'quiet-lantern').chapters[0].moves[2].by, 'editor');

  // The chapter closes only with a proof line, and only by the person.
  const noBy = await run(dir, ['done', 'approve-voice', '--proof', 'sample v1']);
  assert.equal(noBy.code, 1);
  const noProof = await run(dir, ['done', 'approve-voice', '--by', 'me']);
  assert.equal(noProof.code, 1);
  assert.match(noProof.errs, /This move closes the chapter, so it needs one line on what was checked\./);
  assert.equal(readRun(dir, 'quiet-lantern').chapters[0].state, 'current');

  const closed = await run(dir, ['done', 'approve-voice', '--by', 'me', '--proof', 'sample v1 approved, it sounds like me']);
  assert.equal(closed.code, 0, closed.errs);
  assert.match(closed.out, /Chapter 1 is done: Find your voice\.\nProof: sample v1 approved, it sounds like me/);
  assert.match(closed.out, /Now chapter 2: First issue out\. Finish line: Your first issue is live and you have the link\./);
  const state = readRun(dir, 'quiet-lantern');
  assert.equal(state.chapters[0].state, 'done');
  assert.equal(state.chapters[0].proof, 'sample v1 approved, it sounds like me');
  assert.equal(state.chapters[1].state, 'current');
  const page = fs.readFileSync(path.join(dir, 'atris', 'storylines', 'quiet-lantern.md'), 'utf8');
  assert.match(page, /^1\. \*\*Find your voice\*\*.* ← done$/m);
  assert.match(page, /^2\. \*\*First issue out\*\*.* ← we are here$/m);

  // Closing a chapter early marks what was left as skipped, never as done.
  await run(dir, ['done', 'send-issue-one', '--by', 'me', '--proof', 'https://example.com/issue-1']);
  const after = readRun(dir, 'quiet-lantern').chapters[1];
  assert.equal(after.state, 'done');
  assert.deepEqual(after.moves.map((move) => move.state), ['skipped', 'skipped', 'skipped', 'done']);
});

test('done with several runs asks which one', async (t) => {
  const dir = tempDir(t);
  const answers = writeAnswers(dir);
  await run(dir, ['start', 'newsletter', '--name', 'blue fox', '--yes', '--answers', answers]);
  await run(dir, ['start', 'newsletter', '--name', 'red owl', '--yes', '--answers', answers]);
  const unsure = await run(dir, ['done', 'name-it', '--by', 'me', '--proof', 'x']);
  assert.equal(unsure.code, 1);
  assert.match(unsure.out, /Pick one: atris script done name-it --run blue-fox/);
  const sure = await run(dir, ['done', 'name-it', '--run', 'red-owl', '--by', 'me', '--proof', 'Owl Post']);
  assert.equal(sure.code, 0, sure.errs);
  assert.equal(readRun(dir, 'red-owl').chapters[0].moves[0].state, 'done');
  assert.equal(readRun(dir, 'blue-fox').chapters[0].moves[0].state, 'open');
});

test('help names every move', async (t) => {
  const dir = tempDir(t);
  const { code, out } = await run(dir, ['--help']);
  assert.equal(code, 0);
  for (const word of ['list', 'start', 'status', 'next', 'done', 'goal', 'card', '--since', '--by me', '--yes --answers']) {
    assert.ok(out.includes(word), `help mentions ${word}`);
  }
});

test('a folder that already has atris/, a goal and an editor keeps them and says what changed', async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'editor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'editor', 'MEMBER.md'), '---\nname: editor\n---\nmine\n');
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'scoreboard.json'), JSON.stringify({ goal: 'ship the app', goal_text: 'Ship the app' }));

  const { code, out, errs } = await run(dir, ['start', 'newsletter', '--yes', '--answers', writeAnswers(dir)], { real: true });
  assert.equal(code, 0, errs);
  assert.equal(fs.readFileSync(path.join(dir, 'atris', 'team', 'editor', 'MEMBER.md'), 'utf8'), '---\nname: editor\n---\nmine\n');
  assert.match(out, /Editor +Turns your rough lines into issues that still sound like you\. {2}\(already on your team\)/);
  assert.match(out, /Their files are in atris\/team\/: researcher, growth, publisher\./);
  assert.match(out, /\(it replaced your old goal: Ship the app\)/);
});

test('an answers file can name choices by their id from the script file', async (t) => {
  const dir = tempDir(t);
  const answers = writeAnswers(dir, {
    readers: 'behind', gift: 'LESSONS', voice: 'friend', rhythm: 'weekly', proud: 'helped', number: '', date: '',
  });
  const { code, out, errs } = await run(dir, ['start', 'newsletter', '--yes', '--answers', answers]);
  assert.equal(code, 0, errs);
  assert.match(out, /1 {2}You write for people one step behind you\./);
  assert.match(out, /2 {2}You give them the lessons you learned the hard way\./);
  assert.match(out, /3 {2}You sound like a friend passing on a tip, once a week\./);
  assert.match(out, /4 {2}You will be proud when a stranger tells you it helped them\./);
  assert.equal(readRun(dir, 'quiet-lantern').answers.readers.picked, 'behind');
});

test('the service script ships, starts and shows its take on each chapter', async (t) => {
  const dir = tempDir(t);
  const listed = await run(dir, ['list']);
  assert.match(listed.out, /service +Get your first paying client from nothing\./);
  const answers = writeAnswers(dir, { skill: 'design', clients: 'local', pain: 'evenings', hours: 'ten', proud: 'stranger', number: '3 paying clients', date: 'March 1' });
  const started = await run(dir, ['start', 'service', '--name', 'First Client', '--yes', '--answers', answers]);
  assert.equal(started.code, 0);
  assert.match(started.out, /You offer design work to small local businesses\./);
  assert.match(started.out, /You take away the job that eats their evenings\./);
  assert.doesNotMatch(started.out, /\{[a-z_]+\}/);
  const status = await run(dir, ['status']);
  assert.match(status.out, /Chapter +1 of 5, One offer/);
  assert.match(status.out, /Our take +Pick the smallest job you could finish in a week\./);
  const page = fs.readFileSync(path.join(dir, 'atris', 'storylines', 'first-client.md'), 'utf8');
  assert.match(page, /Our take: Twenty people you studied/);
  assert.doesNotMatch(page, /\{[a-z_]+\}/);
});

test('no line a client could read in a shipped script says AI, agent or automate, except to forbid it', () => {
  const dirScripts = path.join(__dirname, '..', 'lib', 'scripts');
  for (const name of fs.readdirSync(dirScripts)) {
    const script = JSON.parse(fs.readFileSync(path.join(dirScripts, name), 'utf8'));
    const shown = [script.pitch, script.mission, ...script.values.will, ...script.values.will_not, ...script.your_part,
      ...script.chapters.flatMap((c) => [c.title, c.finish_line, c.take || '', ...c.moves.map((m) => m.you)])];
    for (const line of shown) assert.doesNotMatch(line, /\b(AI|agents?|automat\w*)\b/i, `${name}: ${line}`);
  }
});

// ---------------------------------------------------------------- daily card

const BANNED_WORDS = /\b(AI|agents?|automat\w*)\b/i;

function at(hours) {
  return () => new Date(NOW.getTime() + hours * 60 * 60 * 1000);
}

function writeRun(dir, code, change) {
  const file = path.join(dir, 'atris', 'storylines', code, 'script.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(state);
  fs.writeFileSync(file, JSON.stringify(state));
}

async function started(t, name = 'blue fox') {
  const dir = tempDir(t);
  const result = await run(dir, ['start', 'newsletter', '--name', name, '--yes', '--answers', writeAnswers(dir)]);
  assert.equal(result.code, 0, result.errs);
  return dir;
}

test('card right after start shows Day 1, chapter 1 and the first call', async (t) => {
  const dir = await started(t);
  const card = await run(dir, ['card']);
  assert.equal(card.code, 0, card.errs);
  const lines = card.out.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['Blue Fox', 'Start a newsletter', 'Day 1. Chapter 1 of 5: Find your voice']);
  assert.match(card.out, /\nMoved\nNothing moved since the last card\.\n/);
  assert.match(card.out, /\nYour call, about 5 minutes\n {2}Name your newsletter\. Say three names out loud/);
  assert.match(card.out, /\n {2}Our take: .+\n/);
  assert.match(card.out, /\n {2}atris script done name-it --by me --proof "the name you picked"\n/);
  assert.match(card.out, /\nStrikes: none\n/);
  assert.match(card.out, /\nFinish line: You approved one sample that sounds like you\.$/);
  assert.deepEqual(card.team.calls, { goals: [], members: [] }, 'card sets no goal and makes no member');
});

test('card lists what moved with who did it and the proof, and the next card starts clean', async (t) => {
  const dir = await started(t);
  await run(dir, ['done', 'name-it', '--by', 'me', '--proof', 'Night Notes']);
  await run(dir, ['done', 'first-lines', '--by', 'me']);
  await run(dir, ['done', 'voice-sample'], { now: at(1) });

  const first = await run(dir, ['card'], { now: at(2) });
  assert.match(first.out, /\nMoved\n {2}You: Name your newsletter\n {4}Proof: Night Notes\n {2}You: Write three rough sentences about one thing you wish you knew a year ago\n {2}Editor: Your editor turns your three sentences into a short sample in your voice\n/);
  assert.doesNotMatch(first.out, /Nothing moved/);
  assert.deepEqual(readRun(dir, 'blue-fox').cards, [{ at: at(2)().toISOString(), chapter: 'voice', moved: ['name-it', 'first-lines', 'voice-sample'] }]);

  const second = await run(dir, ['card'], { now: at(3) });
  assert.match(second.out, /\nMoved\nNothing moved since the last card\.\n/);
  assert.equal(readRun(dir, 'blue-fox').cards.length, 2);

  // The next move now belongs to the person again, and one more done shows up alone.
  await run(dir, ['done', 'approve-voice', '--by', 'me', '--proof', 'sample v1'], { now: at(4) });
  const third = await run(dir, ['card'], { now: at(5) });
  assert.match(third.out, /\nMoved\n {2}You: Read the sample\n {4}Proof: sample v1\n/);
  assert.doesNotMatch(third.out, /Night Notes/);
  assert.match(third.out, /Chapter 2 of 5: First issue out/);
});

test('with no card yet only the last 24 hours count, and --since sets its own start', async (t) => {
  const dir = await started(t);
  await run(dir, ['done', 'name-it', '--by', 'me', '--proof', 'Night Notes']);

  const late = await run(dir, ['card'], { now: at(25) });
  assert.match(late.out, /\nMoved\nNothing moved since the last card\.\n/);
  assert.match(late.out, /Day 2\. Chapter 1 of 5/);

  const since = await run(dir, ['card', '--since', new Date(NOW.getTime() - 1000).toISOString()], { now: at(26) });
  assert.match(since.out, /\nMoved\n {2}You: Name your newsletter\n {4}Proof: Night Notes\n/);

  const bad = await run(dir, ['card', '--since', 'last tuesday-ish']);
  assert.equal(bad.code, 1);
  assert.match(bad.errs, /I could not read that time\./);
  const empty = await run(dir, ['card', '--since']);
  assert.equal(empty.code, 1);
  assert.equal(readRun(dir, 'blue-fox').cards.length, 2, 'a refused card is not recorded');
});

test('outbound, inbound and product say not tracked yet, and a real source shows its number', async (t) => {
  const dir = await started(t);
  const bare = await run(dir, ['card']);
  assert.match(bare.out, /^Outbound: not tracked yet$/m);
  assert.match(bare.out, /^Inbound: not tracked yet$/m);
  assert.match(bare.out, /^Product: not tracked yet$/m);

  const fed = await run(dir, ['card'], {
    sources: {
      outbound: () => ({ count: 3 }),
      inbound: async () => ({ count: 0, note: 'two replies waiting' }),
      product: () => { throw new Error('feed is down'); },
    },
  });
  assert.equal(fed.code, 0, fed.errs);
  assert.match(fed.out, /^Outbound: 3$/m);
  assert.match(fed.out, /^Inbound: 0 \(two replies waiting\)$/m);
  assert.match(fed.out, /^Product: not tracked yet$/m, 'a source that fails never becomes a number');

  const junk = await run(dir, ['card'], { sources: { outbound: () => ({ count: 'many' }), inbound: () => ({ count: -1 }), product: () => ({}) } });
  assert.match(junk.out, /^Outbound: not tracked yet$/m);
  assert.match(junk.out, /^Inbound: not tracked yet$/m);
  assert.match(junk.out, /^Product: not tracked yet$/m);
});

test('card --json carries the same content and still records the card', async (t) => {
  const dir = await started(t);
  await run(dir, ['done', 'name-it', '--by', 'me', '--proof', 'Night Notes']);
  const card = await run(dir, ['card', '--json'], { now: at(1), sources: { outbound: () => ({ count: 3, note: 'this week' }) } });
  assert.equal(card.code, 0, card.errs);
  const json = JSON.parse(card.out);
  assert.deepEqual(Object.keys(json), ['code_name', 'title', 'script', 'script_title', 'day', 'chapter', 'since', 'moved',
    'outbound', 'inbound', 'product', 'call', 'strikes', 'finish_line']);
  assert.equal(json.code_name, 'blue-fox');
  assert.equal(json.day, 1);
  assert.deepEqual(json.chapter, { n: 1, of: 5, id: 'voice', title: 'Find your voice' });
  assert.equal(json.since.reason, 'last_24_hours');
  assert.deepEqual(json.moved, [{ id: 'name-it', by: 'You', text: 'Name your newsletter', proof: 'Night Notes' }]);
  assert.deepEqual(json.outbound, { count: 3, note: 'this week' });
  assert.equal(json.inbound, null);
  assert.equal(json.product, null);
  assert.equal(json.call.kind, 'you');
  assert.equal(json.call.move.id, 'first-lines');
  assert.ok(json.call.take);
  assert.match(json.call.done_command, /^atris script done first-lines --by me/);
  assert.deepEqual(json.strikes, []);
  assert.equal(json.finish_line, 'You approved one sample that sounds like you.');
  assert.deepEqual(readRun(dir, 'blue-fox').cards.map((card) => card.moved), [['name-it']]);

  const again = JSON.parse((await run(dir, ['card', '--json'], { now: at(2) })).out);
  assert.deepEqual(again.moved, []);
  assert.equal(again.since.reason, 'last_card');
});

test('when the next move is a teammate\'s, the card says no call is needed', async (t) => {
  const dir = await started(t);
  await run(dir, ['done', 'name-it', '--by', 'me', '--proof', 'Night Notes']);
  await run(dir, ['done', 'first-lines', '--by', 'me']);
  const card = await run(dir, ['card']);
  assert.match(card.out, /\nYour call\n {2}No call needed\. Editor is on: Your editor turns your three sentences into a short sample in your voice\.\n/);
  assert.doesNotMatch(card.out, /Our take|atris script done/);
  const json = JSON.parse((await run(dir, ['card', '--json'])).out);
  assert.equal(json.call.kind, 'team');
  assert.equal(json.call.seat, 'Editor');
});

test('strikes on a move are read and shown, and zero strikes say none', async (t) => {
  const dir = await started(t);
  writeRun(dir, 'blue-fox', (state) => {
    state.chapters[0].moves[0].strikes = 2;
    state.chapters[0].moves[1].strikes = 0;
    state.chapters[0].moves[2].strikes = 'lots';
  });
  const card = await run(dir, ['card']);
  assert.match(card.out, /\nStrikes\n {2}Name your newsletter: 2\n/);
  assert.doesNotMatch(card.out, /Strikes: none|Write three rough sentences: /);
  assert.deepEqual(JSON.parse((await run(dir, ['card', '--json'])).out).strikes, [{ id: 'name-it', text: 'Name your newsletter', count: 2 }]);
});

test('an old run with no cards and no done times does not crash, and counts those moves as earlier', async (t) => {
  const dir = await started(t);
  await run(dir, ['done', 'name-it', '--by', 'me', '--proof', 'Night Notes']);
  writeRun(dir, 'blue-fox', (state) => {
    delete state.cards;
    delete state.started_day;
    for (const chapter of state.chapters) for (const move of chapter.moves) { delete move.done_at; delete move.by; delete move.strikes; }
  });
  const card = await run(dir, ['card']);
  assert.equal(card.code, 0, card.errs);
  assert.match(card.out, /\nDay 1\. Chapter 1 of 5: Find your voice\n/);
  assert.match(card.out, /\nMoved\nNothing moved since the last card\.\n/);
  assert.equal(readRun(dir, 'blue-fox').cards.length, 1);

  // A damaged cards list is set aside instead of crashing.
  writeRun(dir, 'blue-fox', (state) => { state.cards = 'oops'; });
  const damaged = await run(dir, ['card']);
  assert.equal(damaged.code, 0, damaged.errs);
  writeRun(dir, 'blue-fox', (state) => { state.cards = [null, { at: 'never', moved: 3 }, { moved: [] }]; });
  assert.equal((await run(dir, ['card'])).code, 0);
});

test('card with no runs, several runs and an unknown run behaves like status', async (t) => {
  const dir = tempDir(t);
  const none = await run(dir, ['card']);
  assert.equal(none.code, 0);
  assert.match(none.out, /No runs here yet\./);
  const answers = writeAnswers(dir);
  await run(dir, ['start', 'newsletter', '--name', 'blue fox', '--yes', '--answers', answers]);
  await run(dir, ['start', 'newsletter', '--name', 'red owl', '--yes', '--answers', answers]);
  const several = await run(dir, ['card']);
  assert.match(several.out, /Pick one: atris script card blue-fox/);
  assert.equal(fs.existsSync(path.join(dir, 'atris', 'storylines', 'blue-fox', 'script.json')), true);
  assert.equal(readRun(dir, 'blue-fox').cards, undefined, 'no card is recorded until a run is picked');
  const picked = await run(dir, ['card', 'red-owl']);
  assert.match(picked.out, /^Red Owl\n/);
  assert.match(picked.out, /atris script done name-it --run red-owl --by me/);
  const missing = await run(dir, ['card', 'green-cat']);
  assert.equal(missing.code, 1);
  assert.match(missing.errs, /There is no run called green-cat here\./);
});

test('a finished run gets a card that says every chapter is done', async (t) => {
  const dir = await started(t);
  writeRun(dir, 'blue-fox', (state) => {
    for (const chapter of state.chapters) {
      chapter.state = 'done';
      for (const move of chapter.moves) move.state = 'done';
    }
  });
  const card = await run(dir, ['card']);
  assert.equal(card.code, 0, card.errs);
  assert.match(card.out, /\nDay 1\. All 5 chapters are done\n/);
  assert.match(card.out, /No call needed\. Every chapter is done\./);
  assert.doesNotMatch(card.out, /Finish line/);
});

test('no card line says AI, agent or automate, or uses a dash or a comma before and', async (t) => {
  const dir = await started(t);
  const shown = [];
  const sources = { outbound: () => ({ count: 3 }), inbound: () => null, product: () => null };
  for (const step of [[], ['--json']]) shown.push((await run(dir, ['card', ...step], { sources })).out);
  await run(dir, ['done', 'name-it', '--by', 'me', '--proof', 'Night Notes']);
  shown.push((await run(dir, ['card'], { now: at(1) })).out);
  await run(dir, ['done', 'first-lines', '--by', 'me']);
  shown.push((await run(dir, ['card'], { now: at(2) })).out);
  shown.push((await run(dir, ['card', '--since', 'nonsense'])).errs);
  shown.push((await run(dir, ['--help'])).out);
  for (const line of shown.join('\n').split('\n')) {
    assert.doesNotMatch(line, BANNED_WORDS, line);
    assert.doesNotMatch(line, /[—–]|, and\b/, line);
  }
});

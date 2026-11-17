'use strict';

// atris script: a guided zero to one run, like the opening of a game.
//
// A script is a thin guide. It gets to know the person, then sets the project
// goal (goal command), the team seats (member create) and the first moves
// through the things that already exist. Its only own state is one small file
// per run in atris/storylines/<code-name>/script.json, plus the storyline page
// atris/storylines/<code-name>.md that `atris game --storyline` reads.

const fs = require('fs');
const path = require('path');
const { loadScripts, SCRIPTS_DIR } = require('../lib/script-registry');
const { readOrbReply } = require('./business');

const SCHEMA = 'atris.script_run.v1';
const STATE_FILE = 'script.json';
const CODE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FIRST_WORDS = [
  'quiet', 'bright', 'steady', 'brave', 'golden', 'early', 'little', 'open',
  'clear', 'warm', 'swift', 'true', 'north', 'silver', 'green', 'kind',
];
const SECOND_WORDS = [
  'lantern', 'harbor', 'sparrow', 'river', 'compass', 'ember', 'meadow', 'signal',
  'orchard', 'kettle', 'beacon', 'pebble', 'garden', 'comet', 'letter', 'bridge',
];
const SKIP_WORDS = /^(skip|not sure|not sure yet|later|none|no|-)$/i;

// ---------------------------------------------------------------- words

function codeName(random = Math.random) {
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(Math.abs(Number(random()) || 0) * list.length))];
  return `${pick(FIRST_WORDS)}-${pick(SECOND_WORDS)}`;
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function titleOf(code) {
  return String(code).split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function fill(template, vars) {
  return String(template || '').replace(/\{([a-z_]+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole
  ));
}

function ownWords(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
}

// Their words, turned to face them: "what my nights taught me" is played back
// as "what your nights taught you", so the playback reads as being heard.
function toYou(text) {
  const swaps = [
    [/\bI am\b/g, 'you are'], [/\bI was\b/g, 'you were'], [/\bI['\u2019]m\b/g, 'you\'re'],
    [/\bI['\u2019]ve\b/g, 'you\'ve'], [/\bI['\u2019]d\b/g, 'you\'d'], [/\bI['\u2019]ll\b/g, 'you\'ll'],
    [/\bI\b/g, 'you'], [/\bmyself\b/gi, 'yourself'], [/\bmine\b/gi, 'yours'], [/\bmy\b/gi, 'your'], [/\bme\b/gi, 'you'],
  ];
  return swaps.reduce((words, [pattern, swap]) => words.replace(pattern, swap), String(text || ''));
}

function localDay(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function firstSentence(text) {
  const match = String(text || '').match(/^.*?[.?!](?=\s|$)/);
  return match ? match[0] : String(text || '');
}

// ---------------------------------------------------------------- answers

// One reply to one question: a pick from the list or the person's own words.
// Goal questions (the number and the date) are always own words, and an empty
// reply there means "not set yet", never a number we chose for them.
function readAnswer(question, typed) {
  if (question.goal) {
    const words = ownWords(typed);
    if (!words || SKIP_WORDS.test(words)) return { picked: null, text: '', says: '', set: false };
    return { picked: null, text: words, says: words, set: true };
  }
  // A choice can also be named by its id from the script file ("behind"), so
  // a helper driving an answers file gets the choice, not the bare id as words.
  const id = String(typed || '').trim().toLowerCase();
  const byId = id ? (question.choices || []).find((item) => String(item.id).toLowerCase() === id) : null;
  if (byId) return { picked: byId.id, text: '', says: byId.says || byId.label, set: true };
  const reply = readOrbReply(question, typed);
  if (!reply) return null;
  if (reply.picked.length > 0) {
    const choice = question.choices.find((item) => item.id === reply.picked[0]);
    return { picked: choice.id, text: '', says: choice.says || choice.label, set: true };
  }
  const words = ownWords(reply.text);
  return words ? { picked: null, text: words, says: toYou(words), set: true } : null;
}

function answersFromFile(script, raw) {
  const answers = {};
  const missing = [];
  for (const question of script.questions) {
    const value = raw ? raw[question.id] : undefined;
    const typed = value === undefined || value === null ? '' : String(value);
    const answer = readAnswer(question, typed);
    if (!answer) missing.push(question.id);
    else answers[question.id] = answer;
  }
  return { answers, missing };
}

function goalOf(answers) {
  const number = answers.number && answers.number.set ? answers.number.text : null;
  const date = answers.date && answers.date.set ? answers.date.text : null;
  return { number, date };
}

function goalLine(goal) {
  if (goal.number && goal.date) return `Your goal: ${goal.number} by ${goal.date}.`;
  if (goal.number) return `Your goal: ${goal.number}. No date yet.`;
  if (goal.date) return `Your date: ${goal.date}. No number yet.`;
  return 'Your goal: not set yet. That is fine for now.';
}

function goalText(goal) {
  if (goal.number && goal.date) return `${goal.number} by ${goal.date}`;
  if (goal.number) return `${goal.number}, date not set yet`;
  if (goal.date) return `number not set yet, by ${goal.date}`;
  return 'not set yet';
}

function varsFor(script, answers, code, root) {
  const vars = {};
  for (const question of script.questions) vars[question.id] = answers[question.id] ? answers[question.id].says : '';
  vars.goal_line = goalLine(goalOf(answers));
  vars.code_name = code;
  vars.run_dir = rel(root, runDir(root, code));
  return vars;
}

function playbackLines(script, answers, code, root) {
  const vars = varsFor(script, answers, code, root);
  return script.playback.map((item) => fill(item.line, vars));
}

// ---------------------------------------------------------------- files

function storylinesDir(root) { return path.join(root, 'atris', 'storylines'); }
function runDir(root, code) { return path.join(storylinesDir(root), code); }
function statePath(root, code) { return path.join(runDir(root, code), STATE_FILE); }
function pagePath(root, code) { return path.join(storylinesDir(root), `${code}.md`); }
function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

function listRuns(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(storylinesDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const state = JSON.parse(fs.readFileSync(statePath(root, entry.name), 'utf8'));
      if (state && state.schema === SCHEMA) runs.push(state);
    } catch { /* not a script run */ }
  }
  return runs.sort((a, b) => String(a.code_name).localeCompare(String(b.code_name)));
}

// Both texts are made before either file is written, so a page that cannot be
// drawn never leaves a half saved run behind.
function saveRun(root, state, now) {
  state.updated_at = now.toISOString();
  const runText = `${JSON.stringify(state, null, 2)}\n`;
  const pageText = renderPage(state);
  writeAtomic(statePath(root, state.code_name), runText);
  writeAtomic(pagePath(root, state.code_name), pageText);
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------- run state

function currentChapter(state) {
  return state.chapters.find((chapter) => chapter.state !== 'done') || null;
}

function nextMove(state) {
  const chapter = currentChapter(state);
  return chapter ? chapter.moves.find((move) => move.state === 'open') || null : null;
}

function doneCommandFor(move, state, multiple) {
  const parts = [`atris script done ${move.id}`];
  if (multiple) parts.push(`--run ${state.code_name}`);
  if (move.taste) parts.push('--by me');
  if (move.finish || move.taste) parts.push(`--proof "${move.proof_hint || 'what you checked'}"`);
  return parts.join(' ');
}

// The storyline page, in the shape `atris game --storyline` reads.
function renderPage(state) {
  const chapter = currentChapter(state);
  const move = nextMove(state);
  const lines = [
    `# Storyline: ${state.title}`,
    '',
    `script: ${state.script} · started: ${state.started_day || String(state.started_at).slice(0, 10)}`,
    '',
    '## Destination',
    '',
    state.mission,
    '',
    '## Current position',
    '',
    chapter
      ? `- Chapter ${state.chapters.indexOf(chapter) + 1} of ${state.chapters.length}: ${chapter.title}.`
      : `- All ${state.chapters.length} chapters are done.`,
    `- Goal: ${goalText(state.goal)}.`,
    '',
    '## Chapters',
    '',
  ];
  state.chapters.forEach((item, index) => {
    const mark = item === chapter ? ' ← we are here' : item.state === 'done' ? ' ← done' : '';
    lines.push(`${index + 1}. **${item.title}**. Finish line: ${item.finish_line}${mark}`);
    if (item.take) lines.push(`   Our take: ${item.take}`);
    if (item.proof) lines.push(`   Proof: ${item.proof}`);
  });
  lines.push('', '## Current mission', '');
  lines.push(move ? `**${move.you}** ${move.who === 'you' ? 'This one is yours.' : `Seat: ${move.seat}.`}` : '**Every chapter is done.**');
  lines.push('', '## Scoreboard', '', '| Evidence | Now |', '|----------|-----|');
  lines.push(`| Goal | ${goalText(state.goal)} |`);
  lines.push(`| Chapters done | ${state.chapters.filter((item) => item.state === 'done').length} / ${state.chapters.length} |`);
  const thing = state.thing || 'project';
  lines.push('', '## Values', '', `This ${thing} will:`, '');
  const values = state.values || {};
  for (const value of listOf(values.will)) lines.push(`- ${value}`);
  lines.push('', `This ${thing} will not:`, '');
  for (const value of listOf(values.will_not)) lines.push(`- ${value}`);
  lines.push('', '## Your part', '');
  for (const part of listOf(state.your_part)) lines.push(`- ${part}`);
  lines.push('', '## Team', '');
  const team = listOf(state.team);
  if (team.length === 0) lines.push('- No team saved for this run yet.');
  for (const seat of team) lines.push(`- ${seat.name}: ${seat.job}`);
  lines.push('');
  return lines.join('\n');
}

function buildState(script, answers, code, root, now) {
  const vars = varsFor(script, answers, code, root);
  const goal = goalOf(answers);
  const yourPart = [...script.your_part];
  if (!goal.number || !goal.date) yourPart.push('You choose your number and date, when you know them.');
  return {
    schema: SCHEMA,
    code_name: code,
    title: titleOf(code),
    script: script.id,
    script_title: script.title,
    thing: script.thing || 'project',
    started_at: now.toISOString(),
    started_day: localDay(now),
    updated_at: now.toISOString(),
    answers,
    mission: fill(script.mission, vars),
    values: {
      will: script.values.will.map((line) => fill(line, vars)),
      will_not: script.values.will_not.map((line) => fill(line, vars)),
    },
    goal,
    your_part: yourPart,
    team: script.team.map((seat) => ({ name: seat.name, role: seat.role, job: seat.job })),
    chapters: script.chapters.map((chapter, index) => ({
      id: chapter.id,
      title: fill(chapter.title, vars),
      finish_line: fill(chapter.finish_line, vars),
      take: chapter.take ? fill(chapter.take, vars) : null,
      state: index === 0 ? 'current' : 'locked',
      proof: null,
      done_at: null,
      moves: chapter.moves.map((move) => ({
        id: move.id,
        who: move.who === 'team' ? 'team' : 'you',
        seat: move.seat || null,
        taste: Boolean(move.taste),
        finish: Boolean(move.finish),
        minutes: move.minutes || null,
        you: fill(move.you, vars),
        brief: fill(move.brief, vars),
        proof_hint: move.proof_hint || null,
        state: 'open',
        owner: null,
        owned_at: null,
        proof: null,
        by: null,
        done_at: null,
      })),
    })),
    written: [],
  };
}

function refreshChapterStates(state) {
  const current = currentChapter(state);
  for (const chapter of state.chapters) {
    if (chapter.state === 'done') continue;
    chapter.state = chapter === current ? 'current' : 'locked';
  }
}

// ---------------------------------------------------------------- reused commands

// Run another command's own function, keeping its chatter off the screen so
// the person sees one calm list at the end. Returns its exit code and lines.
async function quietly(root, fn) {
  const lines = [];
  const original = { log: console.log, error: console.error, cwd: process.cwd() };
  console.log = (...parts) => lines.push(parts.join(' '));
  console.error = (...parts) => lines.push(parts.join(' '));
  try {
    if (original.cwd !== root) process.chdir(root);
    const code = await fn();
    return { code: typeof code === 'number' ? code : 0, lines };
  } catch (error) {
    lines.push(String(error && error.message || error));
    return { code: 1, lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
    if (process.cwd() !== original.cwd) process.chdir(original.cwd);
  }
}

async function defaultSetGoal(sentence, root) {
  const goal = require('./goal');
  const before = goal.readScoreboard(root);
  const result = await quietly(root, () => goal.run(['set', sentence, '--no-wish'], { cwd: root }));
  return { ok: result.code === 0, replaced: before.goal_text || before.goal || null };
}

async function defaultCreateMember(seat, root) {
  const teamDir = path.join(root, 'atris', 'team');
  if (fs.existsSync(path.join(teamDir, seat.name, 'MEMBER.md')) || fs.existsSync(path.join(teamDir, `${seat.name}.md`))) {
    return { ok: true, existed: true };
  }
  const { memberCommand } = require('./member');
  const result = await quietly(root, () => memberCommand('create', seat.name, `--role=${seat.role}`, `--description=${seat.job}`));
  const made = fs.existsSync(path.join(teamDir, seat.name, 'MEMBER.md'));
  return { ok: result.code === 0 && made, existed: false };
}

// ---------------------------------------------------------------- terminal

function makePrompt() {
  if (!process.stdin.isTTY) return null;
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  let pending = null;
  rl.on('close', () => {
    closed = true;
    if (pending) pending(null);
    pending = null;
  });
  const ask = (text) => new Promise((resolve) => {
    if (closed) return resolve(null);
    pending = resolve;
    rl.question(text, (answer) => { pending = null; resolve(answer); });
  });
  ask.close = () => rl.close();
  return ask;
}

async function askQuestion(question, prompt, log) {
  const choices = question.goal ? [] : question.choices || [];
  log('');
  log(`● ${question.line}`);
  if (choices.length > 0) log('');
  choices.forEach((choice, index) => log(`  ${index + 1}  ${choice.label}`));
  if (question.hint) log(`  ${question.hint}`);
  log('');
  for (;;) {
    const typed = await prompt('› ');
    if (typed === null || typed === undefined) return undefined;
    const answer = readAnswer(question, typed);
    if (answer) return answer;
  }
}

// ---------------------------------------------------------------- args

function parseArgs(args) {
  const out = { positional: [], flags: {} };
  const valued = new Set(['name', 'answers', 'proof', 'by', 'to', 'run', 'number', 'date', 'since']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '-h') { out.flags.help = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = arg.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) out.flags[key] = arg.slice(eq + 1);
      else if (valued.has(key)) {
        const value = args[index + 1];
        out.flags[key] = value === undefined || String(value).startsWith('--') ? '' : String(value);
        if (value !== undefined && !String(value).startsWith('--')) index += 1;
      } else out.flags[key] = true;
      continue;
    }
    out.positional.push(arg);
  }
  return out;
}

function helpLines() {
  return [
    'atris script: go from zero to one with a team beside you.',
    '',
    '  atris script list                     the scripts you can start',
    '  atris script start <script>           begin, with a few questions about you',
    '  atris script status [code-name]       where you are and what waits on you',
    '  atris script next [code-name]         the one next move',
    '  atris script card [code-name]         your daily card: what moved and the one call to make',
    '  atris script done <move> [--proof "what you checked"] [--by me]',
    '  atris script claim <move> --by <seat or me>     take a move, so only one person holds it',
    '  atris script give <move> --to <seat> --by <who holds it>   hand a move on in one step',
    '  atris script goal [code-name] --number "..." --date "..."',
    '',
    'start options:',
    '  --name <two words>     choose your own code name',
    '  --yes --answers <file> run with no questions (a json file of answers)',
    '',
    'card options:',
    '  --since <time>         show what moved since this time, like 2026-11-16T08:00',
    '  --json                 the same card as data',
    '',
    'Moves that need your taste only count with --by me.',
    'One person holds a move at a time. Pass it on with give, never by letting go.',
  ];
}

// ---------------------------------------------------------------- subcommands

function listCommand(ctx) {
  const scripts = loadScripts(ctx.scriptsDir);
  if (scripts.length === 0) {
    ctx.log('No scripts here yet.');
    return 0;
  }
  if (ctx.flags.json) {
    ctx.log(JSON.stringify({ scripts: scripts.map((script) => ({ id: script.id, title: script.title, pitch: script.pitch || '' })) }, null, 2));
    return 0;
  }
  const width = Math.max(...scripts.map((script) => script.id.length)) + 3;
  ctx.log('Scripts you can start');
  ctx.log('');
  for (const script of scripts) ctx.log(`  ${script.id.padEnd(width)}${script.pitch || script.title}`);
  ctx.log('');
  ctx.log(`Start one: atris script start ${scripts[0].id}`);
  return 0;
}

async function startCommand(ctx) {
  const { log, err, root, flags } = ctx;
  const id = ctx.positional[1];
  const scripts = loadScripts(ctx.scriptsDir);
  const script = scripts.find((item) => item.id === id);
  if (!id || !script) {
    err(id ? `There is no script called ${id}.` : 'Pick a script to start.');
    err(`You can start: ${scripts.map((item) => item.id).join(', ') || 'none yet'}`);
    err(`Try: atris script start ${scripts[0] ? scripts[0].id : '<script>'}`);
    return 1;
  }

  let code;
  if (flags.name !== undefined) {
    code = slugify(flags.name);
    if (!code || !CODE_NAME.test(code)) {
      err('That code name will not work. Use plain words, like --name "blue fox".');
      return 1;
    }
  } else {
    code = codeName(ctx.random);
    for (let tries = 0; tries < 50 && (fs.existsSync(runDir(root, code)) || fs.existsSync(pagePath(root, code))); tries += 1) {
      code = codeName(ctx.random);
    }
  }
  if (fs.existsSync(runDir(root, code)) || fs.existsSync(pagePath(root, code))) {
    err(`${titleOf(code)} is already running here, so I left it as it is.`);
    err(`Pick up where you left off: atris script status ${code}`);
    err('Or start a new run with another name: --name "two words"');
    return 1;
  }

  let answers;
  const auto = Boolean(flags.yes);
  if (auto) {
    if (!flags.answers) {
      err('--yes needs your answers in a file: --answers answers.json');
      return 1;
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, flags.answers), 'utf8'));
    } catch (error) {
      err(`I could not read ${flags.answers}. It needs to be a json file of answers.`);
      return 1;
    }
    const result = answersFromFile(script, raw);
    if (result.missing.length > 0) {
      err(`The answers file is missing: ${result.missing.join(', ')}.`);
      return 1;
    }
    answers = result.answers;
  }

  const prompt = auto ? null : ctx.prompt;
  if (!auto && !prompt) {
    err('This one asks you a few questions, so run it in a terminal.');
    err(`For an agent or a test: atris script start ${script.id} --yes --answers answers.json`);
    return 1;
  }

  log('');
  log(titleOf(code));
  log('That is the code name for this run. It is yours now.');

  if (!auto) {
    log('');
    for (const line of script.opening || []) log(line);
    answers = {};
    for (const question of script.questions) {
      const answer = await askQuestion(question, prompt, log);
      if (answer === undefined) {
        log('');
        log('Stopped. Nothing was written. Start again any time.');
        return 1;
      }
      answers[question.id] = answer;
    }
  }

  // Play it back, and let them fix any line before anything is written.
  for (;;) {
    const lines = playbackLines(script, answers, code, root);
    log('');
    log('Here is what I heard:');
    log('');
    lines.forEach((line, index) => log(`  ${index + 1}  ${line}`));
    if (auto) break;
    log('');
    log('Type a number to fix that line, or press enter to set it up.');
    const typed = await prompt('› ');
    if (typed === null || typed === undefined) {
      log('');
      log('Stopped. Nothing was written. Start again any time.');
      return 1;
    }
    const pick = String(typed).trim();
    if (!pick) break;
    const item = /^\d+$/.test(pick) ? script.playback[Number(pick) - 1] : null;
    if (!item) continue;
    for (const questionId of item.asks) {
      const question = script.questions.find((q) => q.id === questionId);
      const answer = await askQuestion(question, prompt, log);
      if (answer === undefined) {
        log('');
        log('Stopped. Nothing was written. Start again any time.');
        return 1;
      }
      answers[questionId] = answer;
    }
  }

  const state = buildState(script, answers, code, root, ctx.now());
  const written = [];
  saveRun(root, state, ctx.now());
  written.push(['Your storyline page', rel(root, pagePath(root, code))]);
  written.push(['Your run', rel(root, statePath(root, code))]);

  const goalSentence = state.goal.number || state.goal.date
    ? `${goalText(state.goal)}. ${state.mission}`
    : state.mission;
  const goalResult = await ctx.setGoal(goalSentence, root);
  const goalShown = state.goal.number || state.goal.date ? goalText(state.goal) : 'your mission, until you pick a number';
  const goalNote = !goalResult || !goalResult.ok
    ? 'not set, something went wrong. Try: atris goal set "..."'
    : goalResult.replaced && goalResult.replaced.toLowerCase() !== goalSentence.toLowerCase()
      ? `${goalShown} (it replaced your old goal: ${goalResult.replaced})`
      : goalShown;

  const seats = [];
  for (const seat of state.team) {
    const result = await ctx.createMember(seat, root);
    seat.status = !result || !result.ok ? 'not made' : result.existed ? 'already on your team' : 'made';
    seats.push(seat);
  }
  state.written = [...written.map(([, file]) => file), ...(goalResult && goalResult.ok ? ['.atris/state/scoreboard.json'] : []),
    ...seats.filter((seat) => seat.status === 'made').map((seat) => `atris/team/${seat.name}/`)];
  saveRun(root, state, ctx.now());

  log('');
  log('Set up:');
  log('');
  for (const [label, file] of written) log(`  ${label.padEnd(21)}${file}`);
  log(`  ${'Project goal'.padEnd(21)}${goalNote}`);
  log('');
  log('Your team:');
  log('');
  for (const seat of seats) {
    const note = seat.status === 'made' ? '' : `  (${seat.status})`;
    log(`  ${seat.role.padEnd(12)}${seat.job}${note}`);
  }
  const made = seats.filter((seat) => seat.status === 'made').map((seat) => seat.name);
  if (made.length > 0) log(`  Their files are in atris/team/: ${made.join(', ')}.`);
  if (!state.goal.number || !state.goal.date) {
    log('');
    log('Your number and date are not set yet. They are yours to choose, when you know them.');
  }

  const move = nextMove(state);
  log('');
  log(`Your first move${move.minutes ? `, about ${move.minutes} minutes` : ''}:`);
  log(`  ${move.you}`);
  log('');
  log('When you have it:');
  log(`  ${doneCommandFor(move, state, listRuns(root).length > 1)}`);
  return 0;
}

function pickRun(ctx, code, again = (name) => `atris script ${ctx.positional[0]} ${name}`) {
  const runs = listRuns(ctx.root);
  if (code) {
    const run = runs.find((item) => item.code_name === code || item.code_name === slugify(code));
    if (run) return { run, runs };
    ctx.err(`There is no run called ${code} here.`);
    if (runs.length > 0) ctx.err(`Runs here: ${runs.map((item) => item.code_name).join(', ')}`);
    return { run: null, runs, code: 1 };
  }
  if (runs.length === 1) return { run: runs[0], runs };
  if (runs.length === 0) {
    ctx.log('No runs here yet.');
    const first = loadScripts(ctx.scriptsDir)[0];
    if (first) ctx.log(`Start one: atris script start ${first.id}`);
    return { run: null, runs, code: 0 };
  }
  ctx.log('You have more than one run here:');
  ctx.log('');
  for (const run of runs) {
    const chapter = currentChapter(run);
    const where = chapter ? `chapter ${run.chapters.indexOf(chapter) + 1} of ${run.chapters.length}, ${chapter.title}` : 'every chapter done';
    ctx.log(`  ${run.code_name.padEnd(20)}${where}`);
  }
  ctx.log('');
  ctx.log(`Pick one: ${again(runs[0].code_name)}`);
  return { run: null, runs, code: 0 };
}

function waitingOnYou(state) {
  const chapter = currentChapter(state);
  const waiting = chapter ? chapter.moves.filter((move) => move.state === 'open' && move.taste).map((move) => firstSentence(move.you)) : [];
  if (!state.goal.number || !state.goal.date) waiting.push('Your number and date, when you know them.');
  return waiting;
}

function statusCommand(ctx) {
  const { run, runs, code } = pickRun(ctx, ctx.positional[1]);
  if (!run) return code;
  const chapter = currentChapter(run);
  const move = nextMove(run);
  const waiting = waitingOnYou(run);
  const holders = openHolders(run);
  if (ctx.flags.json) {
    ctx.log(JSON.stringify({
      code_name: run.code_name,
      script: run.script,
      mission: run.mission,
      goal: { number: run.goal.number, date: run.goal.date, set: Boolean(run.goal.number && run.goal.date) },
      chapter: chapter ? { n: run.chapters.indexOf(chapter) + 1, of: run.chapters.length, title: chapter.title, finish_line: chapter.finish_line, take: chapter.take || null } : null,
      next: move ? { id: move.id, who: move.who, seat: move.seat, taste: move.taste, you: move.you, brief: move.brief } : null,
      waiting_on_you: waiting,
      held: holders.held.map((item) => ({ id: item.id, owner: item.owner, owned_at: item.owned_at || null })),
      nobody_owns: holders.free.map((item) => item.id),
    }, null, 2));
    return 0;
  }
  const row = (label, value) => ctx.log(`${label.padEnd(13)}${value}`);
  ctx.log(run.title);
  ctx.log(run.script_title);
  ctx.log('');
  row('Mission', run.mission);
  row('Goal', run.goal.number || run.goal.date ? goalText(run.goal) : 'not set yet. Yours to choose, when you are ready.');
  ctx.log('');
  if (chapter) {
    row('Chapter', `${run.chapters.indexOf(chapter) + 1} of ${run.chapters.length}, ${chapter.title}`);
    row('Finish line', chapter.finish_line);
    if (chapter.take) row('Our take', chapter.take);
  } else {
    row('Chapter', `all ${run.chapters.length} done`);
  }
  ctx.log('');
  if (move) {
    row('Next move', move.who === 'you' ? move.you : `${move.you} (${move.seat})`);
    ctx.log(`${''.padEnd(13)}${doneCommandFor(move, run, runs.length > 1)}`);
  } else {
    row('Next move', 'none. Every chapter is done.');
  }
  if (waiting.length > 0) {
    ctx.log('');
    ctx.log('Waiting on you');
    for (const line of waiting) ctx.log(`  ${line}`);
    if (!run.goal.number || !run.goal.date) ctx.log(`  atris script goal ${run.code_name} --number "..." --date "..."`);
  }
  const width = Math.max(0, ...[...holders.held, ...holders.free].map((item) => item.id.length)) + 3;
  if (holders.held.length > 0) {
    ctx.log('');
    ctx.log('Who holds what');
    for (const item of holders.held) ctx.log(`  ${item.id.padEnd(width)}${holderName(item.owner)}: ${firstSentence(item.you)}`);
  }
  if (holders.free.length > 0) {
    ctx.log('');
    ctx.log('Nobody owns these yet:');
    for (const item of holders.free) ctx.log(`  ${item.id.padEnd(width)}${firstSentence(item.you)}`);
    ctx.log(`  Take one: atris script claim <move> --by <seat or me>${runs.length > 1 ? ` --run ${run.code_name}` : ''}`);
  }
  return 0;
}

// ---------------------------------------------------------------- owners

// One owner per open move. A move saved before owners existed has no owner
// field at all, and reads the same as a move nobody holds yet. An owner typed
// by hand in another letter case still reads as the seat's proper name.
function ownerOf(run, move) {
  const raw = move && typeof move.owner === 'string' ? move.owner.trim() : '';
  return raw ? readSeat(run, raw) || raw : null;
}

function sameSeat(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function holderName(owner) {
  return owner === 'me' ? 'you' : owner;
}

// An old saved run may have no team list at all. That reads as an empty team.
function seatNames(run) {
  return listOf(run.team).map((seat) => String((seat && seat.name) || '')).filter(Boolean);
}

// "me" or a seat on this run's team, in its proper name, or null when it is neither.
function readSeat(run, value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) return null;
  if (name === 'me') return 'me';
  return seatNames(run).find((seat) => seat.toLowerCase() === name) || null;
}

function notASeat(ctx, run, typed, flag) {
  if (seatNames(run).length === 0) {
    ctx.err(`${typed} is not a seat here. This run has no team saved, so only you can hold a move: ${flag} me`);
  } else {
    ctx.err(`${typed} is not a seat on this team. Pick one of: ${seatChoices(run)}.`);
  }
}

function seatChoices(run) {
  return [...seatNames(run), 'me'].join(', ').replace(/, me$/, ' or me');
}

// Every open move someone holds, in any chapter, and the open moves in the
// current chapter that nobody holds yet.
function openHolders(run) {
  const held = [];
  for (const chapter of run.chapters) {
    for (const move of chapter.moves) if (move.state === 'open' && ownerOf(run, move)) held.push({ ...move, owner: ownerOf(run, move) });
  }
  const chapter = currentChapter(run);
  const free = chapter ? chapter.moves.filter((move) => move.state === 'open' && !ownerOf(run, move)) : [];
  return { held, free };
}

function findMove(run, moveId) {
  for (const chapter of run.chapters) {
    const move = chapter.moves.find((candidate) => candidate.id === moveId);
    if (move) return { move, chapter };
  }
  return { move: null, chapter: null };
}

function laterChapter(ctx, run, chapter) {
  const next = nextMove(run);
  ctx.err(`That move is in a later chapter, ${chapter.title}. One step at a time.`);
  if (next) ctx.err(`Right now: ${next.you}`);
}

// The shared first half of claim and give: the run, the move and a move that
// can still change hands. Returns null after saying why when it cannot.
function movePicked(ctx, verb) {
  const moveId = ctx.positional[1];
  if (!moveId) {
    ctx.err('Which move? See them with: atris script status');
    return null;
  }
  const { run, code } = pickRun(ctx, ctx.flags.run || ctx.positional[2], (name) => `atris script ${verb} ${moveId} --run ${name}`);
  if (!run) {
    ctx.exit = code || 1;
    return null;
  }
  const { move, chapter } = findMove(run, moveId);
  if (!move) {
    ctx.err(`There is no move called ${moveId} in ${run.title}.`);
    ctx.err('See them with: atris script status');
    return null;
  }
  if (move.state === 'done') {
    ctx.err(`This move was already finished by ${move.by || 'someone unknown'} at ${move.done_at || 'an unknown time'}.`);
    return null;
  }
  if (move.state !== 'open') {
    ctx.err('That move was skipped when its chapter closed, so nobody can hold it now.');
    return null;
  }
  if (chapter !== currentChapter(run)) {
    laterChapter(ctx, run, chapter);
    return null;
  }
  return { run, move };
}

function claimCommand(ctx) {
  const picked = movePicked(ctx, 'claim');
  if (!picked) return ctx.exit || 1;
  const { run, move } = picked;
  if (!ctx.flags.by || typeof ctx.flags.by !== 'string') {
    ctx.err(`Say who takes it: atris script claim ${move.id} --by <seat or me>`);
    return 1;
  }
  const who = readSeat(run, ctx.flags.by);
  if (!who) {
    notASeat(ctx, run, ctx.flags.by, '--by');
    return 1;
  }
  const holder = ownerOf(run, move);
  if (holder && sameSeat(holder, who)) {
    ctx.log(`${who === 'me' ? 'You already hold' : `${who} already holds`} this move. Nothing changed.`);
    return 0;
  }
  if (holder) {
    ctx.err(`This move is held by ${holderName(holder)}, who took it at ${move.owned_at || 'an unknown time'}.`);
    ctx.err(`Only the holder can pass it on: atris script give ${move.id} --to ${who} --by ${holder}`);
    return 1;
  }
  if (move.taste && who !== 'me') {
    ctx.err('This one is yours to call, so only you can hold it.');
    ctx.err(`Take it with: atris script claim ${move.id} --by me`);
    return 1;
  }
  const now = ctx.now();
  move.owner = who;
  move.owned_at = now.toISOString();
  saveRun(ctx.root, run, now);
  ctx.log(`Taken: ${firstSentence(move.you)}`);
  ctx.log(`Held by ${holderName(who)} from now on. Nobody else can take it.`);
  return 0;
}

function giveCommand(ctx) {
  const picked = movePicked(ctx, 'give');
  if (!picked) return ctx.exit || 1;
  const { run, move } = picked;
  if (!ctx.flags.to || typeof ctx.flags.to !== 'string' || !ctx.flags.by || typeof ctx.flags.by !== 'string') {
    ctx.err(`Say who gets it and who holds it now: atris script give ${move.id} --to <seat> --by <who holds it>`);
    return 1;
  }
  const to = readSeat(run, ctx.flags.to);
  if (!to) {
    notASeat(ctx, run, ctx.flags.to, '--to');
    return 1;
  }
  const holder = ownerOf(run, move);
  const by = readSeat(run, ctx.flags.by) || String(ctx.flags.by).trim();
  if (!holder) {
    ctx.err('Nobody holds this move yet, so there is nothing to give.');
    ctx.err(`Take it first: atris script claim ${move.id} --by ${to}`);
    return 1;
  }
  if (!sameSeat(by, holder)) {
    ctx.err(`${by} does not hold this move. ${holder === 'me' ? 'You hold' : `${holder} holds`} it, since ${move.owned_at || 'an unknown time'}.`);
    ctx.err('Only the holder can give it.');
    return 1;
  }
  if (sameSeat(to, holder)) {
    ctx.log(`${to === 'me' ? 'You already hold' : `${to} already holds`} this move. Nothing changed.`);
    return 0;
  }
  if (move.taste && to !== 'me') {
    ctx.err('This one is yours to call, so only you can hold it.');
    return 1;
  }
  const now = ctx.now();
  move.owner = to;
  move.owned_at = now.toISOString();
  saveRun(ctx.root, run, now);
  ctx.log(`Given: ${firstSentence(move.you)}`);
  ctx.log(`${to === 'me' ? 'You hold' : `${to} holds`} it now. It was ${holder === 'me' ? 'yours' : `${holder}'s`}.`);
  return 0;
}

function nextCommand(ctx) {
  const { run, runs, code } = pickRun(ctx, ctx.positional[1]);
  if (!run) return code;
  const move = nextMove(run);
  if (!move) {
    ctx.log(`All ${run.chapters.length} chapters of ${run.title} are done. Nothing is next.`);
    return 0;
  }
  if (ctx.flags.json) {
    ctx.log(JSON.stringify({ code_name: run.code_name, ...move, done_command: doneCommandFor(move, run, runs.length > 1) }, null, 2));
    return 0;
  }
  const minutes = move.minutes ? `, about ${move.minutes} minutes` : '';
  ctx.log(move.who === 'you' ? `Next, yours${minutes}` : `Next, your ${move.seat}`);
  ctx.log(`  ${move.you}`);
  ctx.log('');
  ctx.log(move.who === 'you' ? 'For the team' : `Brief for ${move.seat}`);
  ctx.log(`  ${move.brief}`);
  ctx.log('');
  ctx.log(move.taste ? 'Only you can mark this one:' : 'When it is done:');
  ctx.log(`  ${doneCommandFor(move, run, runs.length > 1)}`);
  return 0;
}

function doneCommand(ctx) {
  const moveId = ctx.positional[1];
  if (!moveId) {
    ctx.err('Which move? See it with: atris script next');
    return 1;
  }
  const { run, code } = pickRun(ctx, ctx.flags.run || ctx.positional[2], (name) => `atris script done ${moveId} --run ${name}`);
  if (!run) return code || 1;
  const chapter = currentChapter(run);
  let found = null;
  let foundChapter = null;
  for (const item of run.chapters) {
    const move = item.moves.find((candidate) => candidate.id === moveId);
    if (move) { found = move; foundChapter = item; break; }
  }
  if (!found) {
    ctx.err(`There is no move called ${moveId} in ${run.title}.`);
    ctx.err('See the next one with: atris script next');
    return 1;
  }
  if (found.state === 'done') {
    ctx.err(`This move was already finished by ${found.by || 'someone unknown'} at ${found.done_at || 'an unknown time'}.`);
    return 1;
  }
  if (found.state !== 'open') {
    ctx.log('That one is already behind you.');
    return 0;
  }
  if (foundChapter !== chapter) {
    const move = nextMove(run);
    ctx.err(`That move is in a later chapter, ${foundChapter.title}. One step at a time.`);
    if (move) ctx.err(`Right now: ${move.you}`);
    return 1;
  }
  if (found.taste && String(ctx.flags.by || '').toLowerCase() !== 'me') {
    ctx.err('This one is yours to call. Only you can say it feels right.');
    ctx.err(`When you have, run: ${doneCommandFor(found, run, false)}`);
    return 1;
  }
  // A held move is finished by its holder or by you, nobody else. A move
  // nobody holds works as it always did.
  const holder = ownerOf(run, found);
  const typedBy = typeof ctx.flags.by === 'string' ? ctx.flags.by.trim() : '';
  const finisher = found.taste ? 'me' : typedBy ? readSeat(run, typedBy) || typedBy : holder || found.seat || 'you';
  if (holder && !sameSeat(finisher, holder) && finisher !== 'me') {
    ctx.err(`This move is held by ${holderName(holder)}, since ${found.owned_at || 'an unknown time'}. Only ${holder === 'me' ? 'you' : `${holder} or you`} can finish it.`);
    ctx.err(`To pass it on first: atris script give ${found.id} --to ${finisher} --by ${holder}`);
    return 1;
  }
  const proof = typeof ctx.flags.proof === 'string' ? ctx.flags.proof.replace(/\s+/g, ' ').trim() : '';
  if (found.finish && !proof) {
    ctx.err('This move closes the chapter, so it needs one line on what was checked.');
    ctx.err(`Finish line: ${chapter.finish_line}`);
    ctx.err(`Try: ${doneCommandFor(found, run, false)}`);
    return 1;
  }

  const now = ctx.now();
  found.state = 'done';
  found.proof = proof || null;
  found.by = finisher;
  found.done_at = now.toISOString();
  // The record never shows one holder and a different finisher in silence.
  const finishedOver = holder && !sameSeat(holder, finisher) ? holder : null;
  if (holder) found.owner = finisher;
  if (finishedOver) found.owner_before = finishedOver;
  ctx.log(`Done: ${firstSentence(found.you)}`);
  if (finishedOver) ctx.log(`${finishedOver} was holding it. You finished it instead.`);

  if (found.finish) {
    chapter.state = 'done';
    chapter.proof = proof;
    chapter.done_at = now.toISOString();
    for (const move of chapter.moves) if (move.state === 'open') move.state = 'skipped';
    ctx.log('');
    ctx.log(`Chapter ${run.chapters.indexOf(chapter) + 1} is done: ${chapter.title}.`);
    ctx.log(`Proof: ${proof}`);
  }
  refreshChapterStates(run);
  saveRun(ctx.root, run, now);

  const move = nextMove(run);
  ctx.log('');
  if (!move) {
    ctx.log(`All ${run.chapters.length} chapters are done. You started from nothing and got here.`);
    return 0;
  }
  const next = currentChapter(run);
  if (found.finish) ctx.log(`Now chapter ${run.chapters.indexOf(next) + 1}: ${next.title}. Finish line: ${next.finish_line}`);
  if (found.finish && next.take) ctx.log(`Our take: ${next.take}`);
  ctx.log(`Next: ${move.you}`);
  ctx.log(`  ${doneCommandFor(move, run, listRuns(ctx.root).length > 1)}`);
  return 0;
}

async function goalCommand(ctx) {
  const { run, code } = pickRun(ctx, ctx.positional[1]);
  if (!run) return code || 1;
  const number = typeof ctx.flags.number === 'string' ? ownWords(ctx.flags.number) : null;
  const date = typeof ctx.flags.date === 'string' ? ownWords(ctx.flags.date) : null;
  if (!number && !date) {
    ctx.err('Say your number, your date or both, in your own words:');
    ctx.err(`  atris script goal ${run.code_name} --number "..." --date "..."`);
    return 1;
  }
  if (number) run.goal.number = number;
  if (date) run.goal.date = date;
  if (run.goal.number && run.goal.date) {
    run.your_part = run.your_part.filter((line) => !/number and date/.test(line));
  }
  const result = await ctx.setGoal(`${goalText(run.goal)}. ${run.mission}`, ctx.root);
  saveRun(ctx.root, run, ctx.now());
  ctx.log(`Goal: ${goalText(run.goal)}.`);
  if (!result || !result.ok) ctx.log('The project goal did not update. Try: atris goal set "..."');
  return 0;
}

// ---------------------------------------------------------------- daily card

// Real numbers only. Each source answers {count, note} or null, and null always
// prints "not tracked yet". Nothing here has a real feed yet, so every default
// is null. A real source is plugged in later through deps.sources.
const DEFAULT_SOURCES = {
  outbound: () => null,
  inbound: () => null,
  product: () => null,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function timeOf(value) {
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

// Calendar days, so a run started on Monday night reads Day 2 on Tuesday morning.
function dayNumber(state, now) {
  const parts = (day) => /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  const started = state.started_at && timeOf(state.started_at) !== null ? localDay(new Date(state.started_at)) : null;
  const start = parts(state.started_day) || parts(started);
  if (!start) return null;
  const today = parts(localDay(now));
  const days = Math.round((Date.UTC(+today[1], +today[2] - 1, +today[3]) - Date.UTC(+start[1], +start[2] - 1, +start[3])) / DAY_MS);
  return Math.max(0, days) + 1;
}

function seatLabel(state, who) {
  const name = String(who || '').trim();
  if (!name || /^(me|you)$/i.test(name)) return 'You';
  const seat = (state.team || []).find((item) => item.name === name);
  return seat && seat.role ? seat.role : titleOf(name);
}

function cardsOf(state) {
  return (Array.isArray(state.cards) ? state.cards : []).filter((card) => card && timeOf(card.at) !== null);
}

// What moved: moves marked done after the cut-off. With no --since the cut-off
// is the last card, and a move already shown on a card never shows twice. A
// move done with no saved time cannot be placed, so it counts as before the
// first card.
function movedSince(state, cutoff, skipIds) {
  const moved = [];
  for (const chapter of state.chapters) {
    for (const move of chapter.moves) {
      if (move.state !== 'done' || skipIds.has(move.id)) continue;
      const at = timeOf(move.done_at);
      if (at === null || at < cutoff.at) continue;
      moved.push({ move, at });
    }
  }
  return moved.sort((a, b) => a.at - b.at).map((item) => item.move);
}

async function readSource(source) {
  let value = null;
  try {
    value = typeof source === 'function' ? await source() : null;
  } catch {
    return null;
  }
  if (!value || typeof value.count !== 'number' || !Number.isFinite(value.count) || value.count < 0) return null;
  return { count: value.count, note: typeof value.note === 'string' && value.note.trim() ? value.note.trim() : null };
}

function sourceLine(label, reading) {
  if (!reading) return `${label}: not tracked yet`;
  return `${label}: ${reading.count}${reading.note ? ` (${reading.note})` : ''}`;
}

function strikesOf(state) {
  const found = [];
  for (const chapter of state.chapters) {
    for (const move of chapter.moves) {
      const count = Math.floor(Number(move.strikes));
      if (Number.isFinite(count) && count > 0) found.push({ id: move.id, text: ownWords(firstSentence(move.you)), count });
    }
  }
  return found;
}

async function cardCommand(ctx) {
  const { run, runs, code } = pickRun(ctx, ctx.positional[1]);
  if (!run) return code;
  const now = ctx.now();

  // Where "since" starts.
  let cutoff;
  let skipIds = new Set();
  if (ctx.flags.since !== undefined) {
    const at = typeof ctx.flags.since === 'string' && ctx.flags.since ? timeOf(ctx.flags.since) : null;
    if (at === null) {
      ctx.err('I could not read that time. Try one like: --since 2026-11-16T08:00');
      return 1;
    }
    cutoff = { at, reason: 'since_flag' };
  } else {
    const cards = cardsOf(run);
    if (cards.length > 0) {
      cutoff = { at: Math.max(...cards.map((card) => timeOf(card.at))), reason: 'last_card' };
      skipIds = new Set(cards.flatMap((card) => (Array.isArray(card.moved) ? card.moved : [])));
    } else {
      cutoff = { at: now.getTime() - DAY_MS, reason: 'last_24_hours' };
    }
  }

  const moved = movedSince(run, cutoff, skipIds).map((move) => ({
    id: move.id,
    by: seatLabel(run, move.by || move.seat || 'you'),
    text: ownWords(firstSentence(move.you)),
    proof: move.proof ? String(move.proof) : null,
  }));
  const readings = {
    outbound: await readSource(ctx.sources.outbound),
    inbound: await readSource(ctx.sources.inbound),
    product: await readSource(ctx.sources.product),
  };

  const chapter = currentChapter(run);
  const chapterN = chapter ? run.chapters.indexOf(chapter) + 1 : null;
  const move = nextMove(run);
  const day = dayNumber(run, now);
  const multiple = runs.length > 1;
  let call;
  if (!move) {
    call = { kind: 'none', move: null, take: null, done_command: null };
  } else if (move.who === 'you' || move.taste) {
    call = {
      kind: 'you',
      move: { id: move.id, text: move.you, minutes: move.minutes || null },
      take: chapter.take || null,
      done_command: doneCommandFor(move, run, multiple),
    };
  } else {
    call = {
      kind: 'team',
      move: { id: move.id, text: move.you, seat: move.seat },
      seat: seatLabel(run, move.seat),
      take: null,
      done_command: null,
    };
  }
  const strikes = strikesOf(run);

  // The card is a record: the next one starts where this one ends.
  run.cards = Array.isArray(run.cards) ? run.cards : [];
  run.cards.push({ at: now.toISOString(), chapter: chapter ? chapter.id : null, moved: moved.map((item) => item.id) });
  saveRun(ctx.root, run, now);

  if (ctx.flags.json) {
    ctx.log(JSON.stringify({
      code_name: run.code_name,
      title: run.title,
      script: run.script,
      script_title: run.script_title,
      day,
      chapter: chapter ? { n: chapterN, of: run.chapters.length, id: chapter.id, title: chapter.title } : null,
      since: { at: new Date(cutoff.at).toISOString(), reason: cutoff.reason },
      moved,
      outbound: readings.outbound,
      inbound: readings.inbound,
      product: readings.product,
      call,
      strikes,
      finish_line: chapter ? chapter.finish_line : null,
    }, null, 2));
    return 0;
  }

  ctx.log(run.title);
  ctx.log(run.script_title);
  const where = chapter ? `Chapter ${chapterN} of ${run.chapters.length}: ${chapter.title}` : `All ${run.chapters.length} chapters are done`;
  ctx.log(day === null ? where : `Day ${day}. ${where}`);
  ctx.log('');
  ctx.log('Moved');
  if (moved.length === 0) {
    ctx.log('Nothing moved since the last card.');
  } else {
    for (const item of moved) {
      ctx.log(`  ${item.by}: ${item.text}`);
      if (item.proof) ctx.log(`    Proof: ${item.proof}`);
    }
  }
  ctx.log('');
  ctx.log(sourceLine('Outbound', readings.outbound));
  ctx.log(sourceLine('Inbound', readings.inbound));
  ctx.log(sourceLine('Product', readings.product));
  ctx.log('');
  if (call.kind === 'you') {
    ctx.log(`Your call${call.move.minutes ? `, about ${call.move.minutes} minutes` : ''}`);
    ctx.log(`  ${call.move.text}`);
    if (call.take) ctx.log(`  Our take: ${call.take}`);
    ctx.log(`  ${call.done_command}`);
  } else if (call.kind === 'team') {
    ctx.log('Your call');
    ctx.log(`  No call needed. ${call.seat} is on: ${call.move.text}`);
  } else {
    ctx.log('Your call');
    ctx.log('  No call needed. Every chapter is done.');
  }
  ctx.log('');
  if (strikes.length === 0) {
    ctx.log('Strikes: none');
  } else {
    ctx.log('Strikes');
    for (const item of strikes) ctx.log(`  ${item.text}: ${item.count}`);
  }
  if (chapter) {
    ctx.log('');
    ctx.log(`Finish line: ${chapter.finish_line}`);
  }
  return 0;
}

// ---------------------------------------------------------------- entry

async function scriptCommand(args = [], deps = {}) {
  const parsed = parseArgs(args);
  const cwd = deps.cwd || process.cwd();
  const ownPrompt = deps.prompt === undefined ? makePrompt() : null;
  const ctx = {
    positional: parsed.positional,
    flags: parsed.flags,
    cwd,
    root: cwd,
    log: deps.log || ((line) => console.log(line)),
    err: deps.err || ((line) => console.error(line)),
    prompt: deps.prompt === undefined ? ownPrompt : deps.prompt,
    random: deps.random || Math.random,
    now: deps.now || (() => new Date()),
    scriptsDir: deps.scriptsDir || SCRIPTS_DIR,
    setGoal: deps.setGoal || defaultSetGoal,
    createMember: deps.createMember || defaultCreateMember,
    sources: { ...DEFAULT_SOURCES, ...(deps.sources || {}) },
  };
  try {
    const sub = parsed.positional[0];
    if (parsed.flags.help || sub === 'help') {
      for (const line of helpLines()) ctx.log(line);
      return 0;
    }
    if (!sub || sub === 'list' || sub === 'ls') return listCommand(ctx);
    if (sub === 'start') return await startCommand(ctx);
    if (sub === 'status') return statusCommand(ctx);
    if (sub === 'next') return nextCommand(ctx);
    if (sub === 'done') return doneCommand(ctx);
    if (sub === 'claim') return claimCommand(ctx);
    if (sub === 'give') return giveCommand(ctx);
    if (sub === 'card') return await cardCommand(ctx);
    if (sub === 'goal') return await goalCommand(ctx);
    ctx.err(`atris script has no ${sub}. See: atris script --help`);
    return 1;
  } finally {
    if (ownPrompt && ownPrompt.close) ownPrompt.close();
  }
}

module.exports = {
  scriptCommand,
  codeName,
  readAnswer,
};

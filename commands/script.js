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

function saveRun(root, state, now) {
  state.updated_at = now.toISOString();
  writeAtomic(statePath(root, state.code_name), `${JSON.stringify(state, null, 2)}\n`);
  writeAtomic(pagePath(root, state.code_name), renderPage(state));
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
  for (const value of state.values.will) lines.push(`- ${value}`);
  lines.push('', `This ${thing} will not:`, '');
  for (const value of state.values.will_not) lines.push(`- ${value}`);
  lines.push('', '## Your part', '');
  for (const part of state.your_part) lines.push(`- ${part}`);
  lines.push('', '## Team', '');
  for (const seat of state.team) lines.push(`- ${seat.name}: ${seat.job}`);
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
  const valued = new Set(['name', 'answers', 'proof', 'by', 'run', 'number', 'date']);
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
    '  atris script done <move> [--proof "what you checked"] [--by me]',
    '  atris script goal [code-name] --number "..." --date "..."',
    '',
    'start options:',
    '  --name <two words>     choose your own code name',
    '  --yes --answers <file> run with no questions (a json file of answers)',
    '',
    'Moves that need your taste only count with --by me.',
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
  if (ctx.flags.json) {
    ctx.log(JSON.stringify({
      code_name: run.code_name,
      script: run.script,
      mission: run.mission,
      goal: { number: run.goal.number, date: run.goal.date, set: Boolean(run.goal.number && run.goal.date) },
      chapter: chapter ? { n: run.chapters.indexOf(chapter) + 1, of: run.chapters.length, title: chapter.title, finish_line: chapter.finish_line, take: chapter.take || null } : null,
      next: move ? { id: move.id, who: move.who, seat: move.seat, taste: move.taste, you: move.you, brief: move.brief } : null,
      waiting_on_you: waiting,
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
  if (found.state !== 'open') {
    ctx.log(`That one is already ${found.state === 'done' ? 'done' : 'behind you'}.`);
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
  found.by = found.taste ? 'me' : (ctx.flags.by ? String(ctx.flags.by) : (found.seat || 'you'));
  found.done_at = now.toISOString();
  ctx.log(`Done: ${firstSentence(found.you)}`);

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

'use strict';

// spends: nothing (plain file reads and local feed writes; no model, no network)
//
// atris feed setup: set a project up while the person watches the feed. The
// team first (a card from each teammate as it joins), then a read of the
// project by plain rules (a few cards, each a real finding), then at most
// three questions the read could not answer, one at a time. An answer is
// saved in the project's lessons, where every teammate reads it; a skipped
// question saves nothing. What was posted and asked is kept in
// .atris/state/feed/setup.json, so a second run adds nothing twice.

const fs = require('fs');
const path = require('path');

function core() {
  return require('./feed-core');
}

function team() {
  return require('./feed-team');
}

function room() {
  return require('./feed-room');
}

const SETUP_VERSION = 1;
// The read is capped so a huge project still finishes quickly.
const READ_MAX_FILES = 5000;
const READ_MAX_MS = 2000;
// Files atris itself writes at the top of a project; they say nothing about it.
const ATRIS_TOP_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules']);
const README_MAX_BYTES = 64 * 1024;
const NOTE_MAX = 280; // the room's limit for a member's note
const LESSON_MAX = 160; // the digest's limit for a lesson

const INTROS = {
  scout: "I'm your scout. I look things up and read the project before anyone builds.",
  builder: "I'm your builder. I make small fixes in the code, only after you say yes.",
  editor: "I'm your editor. I read the writing here and suggest clearer words.",
};

const QUESTIONS = {
  purpose: {
    text: 'What is this project for, in one sentence?',
    lesson: "What this project is for, in the owner's words: ",
  },
  audience: {
    text: 'Who is this for? A few words is plenty, like the kind of person or business that uses it.',
    lesson: "Who this project is for, in the owner's words: ",
  },
  done: {
    text: 'What would make this a good week here? Name one thing you want done by Friday.',
    lesson: "Done this week means, in the owner's words: ",
  },
};

const TYPES = {
  nodejs: 'a Node project', python: 'a Python project', ruby: 'a Ruby project', go: 'a Go project',
  rust: 'a Rust project', java: 'a Java project', php: 'a PHP project', elixir: 'an Elixir project',
  d: 'a D project', ios: 'an iPhone or iPad app',
};
const FRAMEWORKS = {
  next: 'Next', nuxt: 'Nuxt', angular: 'Angular', react: 'React', vue: 'Vue', express: 'Express',
  fastify: 'Fastify', django: 'Django', flask: 'Flask', fastapi: 'FastAPI', rails: 'Rails', sinatra: 'Sinatra',
};

// ------------------------------------------------------------- words

function sentenceCount(text) {
  return text.split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean).length;
}

// A card a member may post: plain words, short, one or two sentences.
function fits(text) {
  const clean = core()._internal.oneLine(text);
  return Boolean(clean) && clean.length <= NOTE_MAX && sentenceCount(clean) <= 2 && core()._internal.isPlainWords(clean);
}

function firstFit(...texts) {
  return texts.find((text) => text && fits(text)) || null;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function listWords(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function clipWords(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

// ------------------------------------------------------------- the read

function readSmall(root, rel) {
  try {
    const file = path.join(root, rel);
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size <= README_MAX_BYTES ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

// The framework is named on a card only when the project really depends on
// it: a dependency line, not the word anywhere in the file (detectProjectContext
// matches the bare word, which a description or a comment can carry).
function dependsOn(root, framework) {
  const name = framework.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (['django', 'flask', 'fastapi'].includes(framework)) {
    const line = new RegExp(`^\\s*${name}\\s*(?:[\\[=<>!~;@ ]|$)`, 'im');
    const quoted = new RegExp(`["']${name}\\s*(?:[\\[=<>!~;@ "']|$)`, 'i');
    const keyed = new RegExp(`^\\s*${name}\\s*=`, 'im');
    return line.test(readSmall(root, 'requirements.txt'))
      || quoted.test(readSmall(root, 'pyproject.toml')) || keyed.test(readSmall(root, 'pyproject.toml'));
  }
  if (['rails', 'sinatra'].includes(framework)) {
    return new RegExp(`^\\s*gem\\s+["']${name}["']`, 'm').test(readSmall(root, 'Gemfile'));
  }
  return true; // package.json frameworks are read from its dependencies already
}

function readPackage(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg && typeof pkg === 'object' ? pkg : null;
  } catch {
    return null;
  }
}

function markdownWords(line) {
  return String(line)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The readme's name for the project and its first plain sentence, if any.
function readmeFacts(root, rel) {
  let text = '';
  try {
    const fd = fs.openSync(path.join(root, rel), 'r');
    try {
      const buffer = Buffer.alloc(README_MAX_BYTES);
      text = buffer.subarray(0, fs.readSync(fd, buffer, 0, README_MAX_BYTES, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  let title = null;
  let description = null;
  let fenced = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) { fenced = !fenced; continue; }
    if (fenced || !line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      if (!title) title = markdownWords(heading[1]).replace(/[:.]+$/, '') || null;
      continue;
    }
    if (/^(?:[-*+|<]|!\[|\[!\[|\d+\.\s|={3,}|-{3,})/.test(line)) continue;
    const words = markdownWords(line);
    if (!description && /[A-Za-z]/.test(words) && words.split(' ').length >= 4) {
      description = words.split(/(?<=[.!?])\s+/)[0];
      if (!/[.!?]$/.test(description)) description += '.';
    }
    if (title && description) break;
  }
  if (title && /^readme$/i.test(title)) title = null;
  return { title, description, empty: !text.trim() };
}

// What the read found, as at most four cards, each a real finding. A part
// that found nothing gives no card.
function findings(root, map) {
  const out = [];
  const many = (n) => (map.capped ? `more than ${n}` : String(n));
  const fileWord = (n) => `${many(n)} file${n === 1 && !map.capped ? '' : 's'}`;
  const langs = map.languages.slice(0, 2).map((l) => l.name);
  const pkg = readPackage(root);

  if (map.files > 0) {
    let text = null;
    if (map.type === 'knowledge-base') {
      text = firstFit(`This looks like a set of written notes and documents, with ${fileWord(map.files)} and no code yet.`);
    } else if (TYPES[map.type]) {
      const fw = FRAMEWORKS[map.framework] && dependsOn(root, map.framework) ? ` built with ${FRAMEWORKS[map.framework]}` : '';
      text = firstFit(
        `This looks like ${TYPES[map.type]}${fw}. I counted ${fileWord(map.files)}${langs.length ? `, mostly ${listWords(langs)}` : ''}.`,
        `This looks like ${TYPES[map.type]}${fw}. I counted ${fileWord(map.files)}.`,
      );
    } else if (langs.length) {
      text = firstFit(`This looks like a project written mostly in ${listWords(langs)}. I counted ${fileWord(map.files)}.`);
    } else {
      text = firstFit(`I counted ${fileWord(map.files)} here, but no code I recognize.`);
    }
    if (text) out.push({ key: 'kind', text });
  }

  if (map.readme) {
    const facts = readmeFacts(root, map.readme);
    let text = null;
    if (facts && facts.empty) text = 'I found your readme, but it is empty so far.';
    else if (facts) {
      const description = facts.description ? clipWords(facts.description, 160) : null;
      text = firstFit(
        facts.title && description ? `I read your readme. It calls this ${facts.title} and says: ${description}` : null,
        !facts.title && description ? `I read your readme. It says: ${description}` : null,
        facts.title ? `I read your readme. It calls this ${facts.title}${description ? '.' : ', but does not say yet what it does.'}` : null,
      );
    }
    if (text) out.push({ key: 'readme', text, answers: facts && facts.description ? ['purpose'] : [] });
  }

  const plainName = (name) => {
    const clean = name.replace(/\/$/, '');
    return clean && core()._internal.isPlainWords(clean) ? clean : null;
  };
  const codeDirs = map.codeDirs.map((d) => ({ ...d, name: plainName(d.name) })).filter((d) => d.name);
  const folders = map.topDirs.filter((d) => d.name !== '(top level)').map((d) => ({ ...d, name: plainName(d.name) })).filter((d) => d.name);
  let parts = null;
  if (codeDirs.length >= 2) {
    const shown = codeDirs.slice(0, 4).map((d) => d.name);
    const rest = codeDirs.length - shown.length;
    parts = firstFit(
      `The code is split into ${codeDirs.length} main parts: ${listWords(rest ? [...shown, `${rest} more`] : shown)}. The biggest is ${codeDirs[0].name}, with ${fileWord(codeDirs[0].files)} of code.`,
    );
  } else if (codeDirs.length === 1) {
    parts = firstFit(`Most of the code lives in one folder, ${codeDirs[0].name}, with ${fileWord(codeDirs[0].files)} of code.`);
  } else if (folders.length) {
    const shown = folders.slice(0, 4).map((d) => d.name);
    const rest = folders.length - shown.length;
    parts = firstFit(`The files are grouped into ${plural(folders.length, 'folder')}: ${listWords(rest ? [...shown, `${rest} more`] : shown)}.`);
  }
  if (parts) out.push({ key: 'parts', text: parts });

  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const hasTestScript = typeof scripts.test === 'string' && scripts.test.trim() && !/no test specified/i.test(scripts.test);
  const starter = typeof scripts.start === 'string' && scripts.start.trim() ? 'start' : typeof scripts.dev === 'string' && scripts.dev.trim() ? 'dev' : null;
  const tests = Number.isInteger(map.testCodeFiles) ? map.testCodeFiles : map.testFiles;
  let run = null;
  if (tests && starter) run = `I found ${many(tests)} test file${tests === 1 ? '' : 's'} and a ${starter} script, so I know how to run it and check changes.`;
  else if (tests) run = `I found ${many(tests)} test file${tests === 1 ? '' : 's'}, so there is a way to check changes before they go out.`;
  else if (hasTestScript && starter) run = `Your project has a test script and a ${starter} script, so I know how to run it, though I found no test files yet.`;
  else if (hasTestScript) run = 'Your project has a test script, though I found no test files yet.';
  else if (starter) run = `Your project has a ${starter} script, so I know how to start it.`;
  run = firstFit(run);
  if (run) out.push({ key: 'run', text: run });
  return out;
}

function readProject(root) {
  const started = Date.now();
  const map = require('./try-repo').buildRepoMap(root, {
    maxSymbolFiles: 0, maxFiles: READ_MAX_FILES, maxMs: READ_MAX_MS, skipTop: ATRIS_TOP_FILES,
  });
  return { map, cards: findings(root, map), took_ms: Date.now() - started };
}

// The questions the read could not answer, at most three, in order.
function plannedAsks(root, found) {
  const answered = new Set(found.flatMap((f) => f.answers || []));
  const goal = core()._internal.themeText(root) || '';
  const keys = [];
  if (!answered.has('purpose') && !goal) keys.push('purpose');
  keys.push('audience');
  if (!goal) keys.push('done');
  return keys.slice(0, 3).map((key) => ({ key, question: QUESTIONS[key].text, status: 'pending', card_id: null }));
}

// ------------------------------------------------------------- state

function stateFile(root) {
  return path.join(root, '.atris', 'state', 'feed', 'setup.json');
}

function readState(root) {
  const raw = core()._internal.readJsonFile(stateFile(root));
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    version: SETUP_VERSION,
    ...state,
    cards: state.cards && typeof state.cards === 'object' && !Array.isArray(state.cards) ? state.cards : {},
    asks: Array.isArray(state.asks) ? state.asks : null,
  };
}

// One writer at a time, with the feed's own lock; change returns the result.
function withState(root, change) {
  return core()._internal.withQueueLock(root, () => {
    const state = readState(root);
    const result = change(state);
    state.updated_at = new Date().toISOString();
    core()._internal.writeJsonAtomic(stateFile(root), state);
    return result;
  }, { lockName: 'setup.lock', busy: 'The feed is busy setting up. Try again in a moment.' });
}

// A member's note, posted once for this key. Under the setup lock, so two
// runs never post the same card twice. Board posts are off: setup is local.
function postOnce(root, state, { key, as, text, ask = false, env, deps }) {
  const seen = state.cards[key];
  if (seen) return { id: seen.id, existed: true };
  let id = null;
  try {
    const out = room().say(root, { as, text, ask, env, deps: { ...deps, board: deps.board || (() => {}) } });
    id = out.card.id;
  } catch (error) {
    const known = core().asFeedError(error);
    if (!known) throw error;
    // Already said in the feed lately: counted as posted, never said twice.
    if (known.status !== 409) return { id: null, error: known.message };
  }
  state.cards[key] = { id, at: new Date().toISOString() };
  return { id, existed: false };
}

// Who speaks for the team: the scout when it is on, else the first member on.
function speakerOf(root) {
  const on = core()._internal.teamMembers(root).filter((slug) => team().isOn(root, slug));
  return on.includes('scout') ? 'scout' : on[0] || null;
}

function introOf(root, slug) {
  if (INTROS[slug]) return INTROS[slug];
  const role = (team().listMembers(root).members.find((m) => m.name === slug) || {}).role || '';
  return firstFit(role ? `I'm ${slug}, your ${role.toLowerCase().replace(/[.]+$/, '')}.` : null, `I'm ${slug}, and I just joined the team.`);
}

// Under the lock: post the next question when none is waiting.
function askNext(root, state, ctx) {
  if (!state.asks) return null;
  if (state.asks.some((a) => a.status === 'waiting')) return null;
  const next = state.asks.find((a) => a.status === 'pending');
  if (!next) return null;
  const speaker = speakerOf(root);
  if (!speaker) return null;
  const posted = postOnce(root, state, { key: `ask:${next.key}`, as: speaker, text: next.question, ask: true, env: ctx.env, deps: ctx.deps });
  if (!posted.id) return null;
  next.status = 'waiting';
  next.card_id = posted.id;
  next.at = new Date().toISOString();
  return { key: next.key, card_id: posted.id, text: next.question, member: speaker };
}

function asksView(state) {
  const asks = state.asks || [];
  const waiting = asks.find((a) => a.status === 'waiting');
  return {
    total: asks.length,
    answered: asks.filter((a) => a.status === 'answered').length,
    skipped: asks.filter((a) => a.status === 'skipped').length,
    left: asks.filter((a) => a.status === 'pending' || a.status === 'waiting').length,
    waiting: waiting ? { card_id: waiting.card_id, key: waiting.key, text: waiting.question } : null,
  };
}

// ------------------------------------------------------------- setup

// The whole setup. onStep hears each step as it finishes:
// { type: 'step', kind, text, card_id, member }.
async function setup(folder, options = {}) {
  const c = core();
  const env = options.env || process.env;
  const deps = options.deps || {};
  const onStep = typeof options.onStep === 'function' ? options.onStep : () => {};
  const viewer = c.viewerOf(env);
  if (viewer.agent) throw new c.FeedError(403, `Only a person can set up a project. This is running inside an agent (${viewer.agent}).`);
  const target = path.resolve(String(folder || '.'));
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new c.FeedError(404, `There is no folder at ${target}.`);
  const steps = [];
  const posted = [];
  const ctx = { env, deps };
  const step = (kind, text, extra = {}) => {
    const event = { type: 'step', kind, text, card_id: extra.card_id || null, ...(extra.member ? { member: extra.member } : {}) };
    steps.push(event);
    if (event.card_id) posted.push(event.card_id);
    onStep(event);
    return event;
  };

  let root = null;
  try { root = c._internal.projectRootOf(target); } catch {}
  // A team means a member that is on: an atris folder whose members were
  // never switched on still gets its starter team.
  const hadTeam = Boolean(root) && c._internal.teamMembers(root).some((slug) => team().isOn(root, slug));
  const newProject = !hadTeam;
  let joined = [];

  // 1. The team. A card from each teammate the moment it is made and on.
  if (!hadTeam) {
    const base = root || target;
    try {
      const started = await team().start(base, {
        env, deps, engine: options.engine, ping: false, whenNoneOn: true,
        onStep: (event) => {
          if (event.kind !== 'member') { step('setup', event.text); return; }
          const text = introOf(base, event.member);
          const out = text ? withState(base, (state) => postOnce(base, state, { key: `join:${event.member}`, as: event.member, text, env, deps })) : { id: null };
          step('join', text || event.text, { card_id: out.id, member: event.member });
        },
      });
      joined = started.created;
    } catch (error) {
      const known = c.asFeedError(error);
      // Only a starter team that could not be made is reported and passed;
      // a folder with no atris at all cannot go on.
      if (!known || known.status !== 500 || !fs.existsSync(path.join(base, 'atris'))) throw error;
      step('note', 'The starter team could not be added, so the project was read without new teammates.');
    }
    root = c._internal.projectRootOf(base);
  }
  withState(root, (state) => {
    if (!state.started_at) {
      state.started_at = new Date().toISOString();
      state.new_project = newProject;
    }
  });

  const speaker = speakerOf(root);
  if (!speaker) {
    step('note', 'No teammate is switched on, so nothing could be posted. Switch one on, then run setup again.');
  }

  // 2. The read, by plain rules. Only what was found becomes a card.
  const read = readProject(root);
  if (speaker) {
    for (const finding of read.cards) {
      const out = withState(root, (state) => postOnce(root, state, { key: `find:${finding.key}`, as: speaker, text: finding.text, env, deps }));
      if (out.existed) continue;
      if (out.id) step('finding', finding.text, { card_id: out.id, member: speaker });
      else if (out.error) step('note', `One finding was not posted: ${out.error}`);
    }
  }

  // 3. The questions, planned once, asked one at a time.
  const next = withState(root, (state) => {
    if (!state.asks) state.asks = plannedAsks(root, read.cards);
    return speaker ? askNext(root, state, ctx) : null;
  });
  if (next) step('ask', next.text, { card_id: next.card_id, member: next.member });

  const finished = withState(root, (state) => {
    state.finished_at = new Date().toISOString();
    return state;
  });
  return {
    version: c.FEED_VERSION,
    ok: true,
    done: true,
    folder: root,
    new_project: newProject,
    joined,
    speaker,
    team: team().listMembers(root, { env }).members.filter((m) => m.on).map((m) => m.name),
    steps: steps.map(({ type, ...rest }) => rest),
    cards: posted,
    read: { files: read.map.files, capped: read.map.capped, findings: read.cards.length, took_ms: read.took_ms },
    asks: asksView(finished),
    model_calls: 0,
  };
}

// ------------------------------------------------------------- answers

// The person answered a setup question on its card (lib/feed-room.js reply):
// the answer goes into the project's lessons as the owner's words, and the
// next question is asked. Anything else returns null and changes nothing.
function answered(root, cardId, text, options = {}) {
  if (!fs.existsSync(stateFile(root))) return null;
  const plain = require('./feed-plain-words');
  if (plain.holdsKey(text)) return refused(root, cardId, plain.SECRET_REFUSED);
  const ctx = { env: options.env || process.env, deps: options.deps || {} };
  return withState(root, (state) => {
    const ask = (state.asks || []).find((a) => a.card_id === cardId && a.status === 'waiting');
    if (!ask) return null;
    ask.status = 'answered';
    ask.answered_at = new Date().toISOString();
    const spec = QUESTIONS[ask.key] || { lesson: 'The owner said: ' };
    // The owner's own words, as said: only control characters are taken out.
    const words = core()._internal.oneLine(String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' '));
    let lesson = null;
    let lessonError = null;
    try {
      lesson = require('./feed-digest').addNote(root, {
        text: `${spec.lesson}${clipWords(words, LESSON_MAX - spec.lesson.length)}`,
        scope: 'team',
        owner: true,
        from: `setup question: ${String(ask.question).split(/(?<=[.!?])\s+/)[0]}`,
      });
      ask.lesson_id = lesson.id;
    } catch (error) {
      const known = core().asFeedError(error);
      if (!known) throw error;
      lessonError = known.message;
    }
    const next = askNext(root, state, ctx);
    return { answered: ask.key, lesson, ...(lessonError ? { lesson_error: lessonError } : {}), next, asks: asksView(state) };
  });
}

// An answer refused before anything was saved (a password or key in it):
// nothing is written, the question stays open for the next answer, and the
// reason comes back where a refused lesson always put it. null when the card
// is not a setup question waiting for an answer.
function refused(root, cardId, reason) {
  if (!fs.existsSync(stateFile(root))) return null;
  const state = readState(root);
  if (!(state.asks || []).some((a) => a.card_id === cardId && a.status === 'waiting')) return null;
  return { answered: null, lesson: null, lesson_error: reason, next: null, asks: asksView(state) };
}

// The person skips a question: nothing is saved, and the next one is asked.
function skip(root, cardId, options = {}) {
  const c = core();
  const env = options.env || process.env;
  const viewer = c.viewerOf(env);
  if (viewer.agent) throw new c.FeedError(403, `Only a person can skip a setup question. This is running inside an agent (${viewer.agent}).`);
  if (!fs.existsSync(stateFile(root))) throw new c.FeedError(404, 'This project has not been set up yet. Start with: atris feed setup');
  const out = withState(root, (state) => {
    const ask = (state.asks || []).find((a) => a.status === 'waiting' && (!cardId || a.card_id === cardId));
    if (!ask) return null;
    ask.status = 'skipped';
    ask.skipped_at = new Date().toISOString();
    return { skipped: ask.key, next: askNext(root, state, { env, deps: options.deps || {} }), asks: asksView(state) };
  });
  if (!out) throw new c.FeedError(404, cardId ? 'That card is not a setup question waiting for an answer.' : 'No setup question is waiting.');
  return { version: c.FEED_VERSION, ...out };
}

module.exports = {
  answered,
  refused,
  setup,
  skip,
};

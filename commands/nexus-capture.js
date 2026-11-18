'use strict';

// atris nexus capture: save someone you just met from any messy text, the way the web page
// and the text helper do.
//
// Backend (atrisos-backend routers/nexus_router.py, services/nexus_capture.py):
//   POST /nexus/capture  { name, words, ref, source, company, title, email, linkedin_url, city,
//                          follow_up_on, person_id, new }
//   It needs a name, so this command reads one out of the text (or takes --name). It finds
//   the card by email, LinkedIn, then name, or makes a new one, and keeps the words as a note.
//   When a name could be more than one of your cards it writes nothing and answers with
//   `choices`. This command never guesses between them: on a terminal it asks, anywhere else
//   it prints the choices as one JSON object and exits 3 without saving.
//
// The text travels in the request body, never in a web address. Nothing here writes a name,
// email, company or city anywhere but the screen. The ref is made from the text and the day,
// so running the same command again the same day never saves it twice.

const crypto = require('crypto');
const readline = require('readline');
const model = require('../lib/nexus-model');
const S = require('../lib/nexus-store');
const { storeClient, StoreLocked, StoreError } = require('./nexus-store');

const SUBS = new Set(['capture']);
const HELP = [
  '  atris nexus capture "<any text>"    save someone you just met from pasted text; also reads standard input (pbpaste | atris nexus capture)',
  '    [--name --company --title --email --linkedin --city --follow-up <date>]  a name is read from the text when --name is not given',
  '    if the name could be someone already on your list it asks which; with --json or no terminal it prints the choices and exits 3',
  '    answer with --person <id> or --new (same text, same command)',
];

const VALUE = new Set(['name', 'company', 'title', 'email', 'linkedin', 'city', 'follow-up', 'person']);
const BARE = new Set(['json', 'new']);
const WORDS_MOST = 20000; // what the store takes in one request
const NOTE_MOST = 4000; // what the store keeps as the note
const STDIN_MOST = 1000000; // never read more than this from a pipe
const NAME_MOST = 120;
const ASK_ROUNDS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXIT_NEEDS_CHOICE = 3;

// Strip control characters so a stranger's words cannot move the cursor or recolor the terminal.
const clean = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Flags and words from the raw command line. A flag is only `--word`; anything else is text,
 * so a pasted line that starts with dashes is still text. `--` ends the flags. Unknown flags
 * are refused so a typo never saves anything. The first word equal to `sub` is the command.
 */
function parseFlags(rawArgs, spec, sub) {
  const words = [];
  const flags = {};
  let dropped = false;
  let rest = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = String(rawArgs[i]);
    if (rest) { words.push(arg); continue; }
    if (arg === '--') { rest = true; continue; }
    const m = /^--([a-z][a-z-]*)(=([\s\S]*))?$/.exec(arg);
    if (!m) {
      if (!dropped && arg === sub) { dropped = true; continue; }
      words.push(arg);
      continue;
    }
    const key = m[1];
    if (spec.value.has(key)) {
      if (m[2] !== undefined) flags[key] = m[3];
      else if (i + 1 < rawArgs.length && !/^--[a-z]/.test(String(rawArgs[i + 1]))) flags[key] = String(rawArgs[++i]);
      else return { error: `--${key} needs a value` };
    } else if (spec.bare.has(key)) {
      if (m[2] !== undefined) return { error: `--${key} takes no value` };
      flags[key] = true;
    } else {
      return { error: `atris nexus ${sub} does not take --${key}, so nothing was done. See: atris nexus --help` };
    }
  }
  return { words, flags };
}

// ---- reading a name and keys out of messy text ----

const PARTICLES = new Set(['de', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'van', 'von', 'der', 'den', 'la', 'le', 'bin', 'ibn', 'al', 'el', 'y']);
const NOT_NAMES = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'met', 'meet', 'meeting', 'just', 'finally', 'also', 'great', 'good', 'nice', 'quick', 'talked', 'spoke',
  'follow', 'call', 'note', 'notes', 'remember', 'email', 'text', 'today', 'yesterday', 'tomorrow', 'dinner', 'lunch', 'coffee', 'intro', 'introduced',
  'from', 'at', 'in', 'on', 're', 'fwd', 'hi', 'hello', 'hey', 'dear', 'thanks', 'thank', 'please', 'ask', 'ping', 'dm', 'name', 'contact', 'person',
  'lead', 'new', 'someone', 'friend', 'found', 'saw', 'got', 'had', 'was', 'is', 'we', 'i', 'my', 'our', 'he', 'she', 'they', 'it', 'so', 'and', 'but',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'last', 'next', 'follow-up', 'title', 'company', 'phone', 'email:',
]);
const LEAD = /^(?:(?:just|finally|also)\s+)?(?:met(?:\s+with)?|meeting(?:\s+with)?|talked\s+(?:to|with)|spoke\s+(?:to|with)|chatted\s+(?:to|with)|coffee\s+with|lunch\s+with|dinner\s+with|call\s+with|intro(?:duced)?\s+to|follow\s*up\s+with|ping|email|text|dm|note|name)\b[\s:,\-–—]*(?:(?:with|to)\b\s*)?/i;
const NAME_TOKEN = /^\p{Lu}[\p{L}'’-]*$/u;
// Bounded and anchored on what comes before, so a long pasted run of letters is read in one pass.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,6}\.[A-Za-z]{2,24}/g;
const LINKEDIN = /(?<![a-z0-9.-])(?:https?:\/\/)?(?:[a-z0-9-]{1,30}\.)?linkedin\.com\/in\/[A-Za-z0-9_%.-]{1,200}/gi;
const HONORIFIC = /^(?:dr|mr|mrs|ms|mx|prof|sir)\.?\s+/i;

function tokenOf(raw) {
  let word = raw;
  let stop = false;
  if (/[,;:!?–—|)(]$/.test(word)) { word = word.replace(/[,;:!?–—|)(]+$/, ''); stop = true; }
  if (/\.$/.test(word) && !/^\p{Lu}\.$/u.test(word) && !/^(?:jr|sr)\.$/i.test(word)) { word = word.slice(0, -1); stop = true; }
  return { word, stop };
}

function capitalized(word) {
  if (!NAME_TOKEN.test(word.replace(/\.$/, ''))) return false;
  const bare = word.replace(/[.'’-]/g, '');
  return !(bare.length >= 2 && bare === bare.toUpperCase() && /\p{L}/u.test(bare));
}

/** The first run of capitalized words from `tokens` starting at `from`: { words, bounded }. */
function runFrom(tokens, from) {
  const words = [];
  let bounded = false;
  let caps = 0;
  for (let i = from; i < tokens.length && caps < 4; i++) {
    const { word, stop } = tokenOf(tokens[i]);
    if (!word) { bounded = true; break; }
    if (capitalized(word) && !(words.length === 0 && NOT_NAMES.has(word.toLowerCase()))) {
      words.push(word);
      caps += 1;
    } else if (words.length && PARTICLES.has(word.toLowerCase())) {
      // de, la, van: kept only when a capitalized word follows them.
      let k = i + 1;
      while (k < tokens.length && PARTICLES.has(tokenOf(tokens[k]).word.toLowerCase())) k++;
      if (k >= tokens.length || !capitalized(tokenOf(tokens[k]).word)) break;
      for (let j = i; j < k; j++) words.push(tokenOf(tokens[j]).word);
      i = k - 1;
      continue;
    } else {
      bounded = /^(?:from|at|of|who|works?|is|-|\u2013|\u2014|\(|\|)$/i.test(word);
      break;
    }
    if (stop) { bounded = true; break; }
    if (i + 1 === tokens.length) bounded = true;
  }
  return { words, bounded };
}

/** A name out of the text, or '' when there is none worth guessing. */
function guessName(text, emails) {
  const label = /^\s*(?:full\s+)?name\s*[:\-–—]\s*(.+)$/im.exec(text);
  if (label) {
    const run = runFrom(label[1].trim().split(/\s+/), 0);
    if (run.words.length) return run.words.join(' ');
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const body = line.replace(/^[\s>*•·-]+/, '').replace(/^["'“‘]+/, '').replace(LEAD, '').replace(HONORIFIC, '').trim();
  const tokens = body.split(/\s+/).filter(Boolean);
  const first = runFrom(tokens, 0);
  if (first.words.length >= 2 || (first.words.length === 1 && first.bounded)) return first.words.join(' ');
  for (let at = 1; at < tokens.length; at++) {
    const run = runFrom(tokens, at);
    if (run.words.length >= 2) return run.words.join(' ');
  }
  // Last: one email written like first.last@host.
  if (emails.length === 1) {
    const local = emails[0].split('@')[0];
    const parts = local.split(/[._-]+/).filter((p) => /^[A-Za-z]{2,}$/.test(p));
    if (parts.length >= 2 && parts.length <= 3 && local.length === parts.join('.').length) {
      return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    }
  }
  return '';
}

const distinct = (list) => [...new Set(list.map((item) => item.toLowerCase()))];
const found = (text, pattern) => distinct(text.match(pattern) || []);

// ---- the answer, in words ----

const MATCHED = { email: 'same email', linkedin: 'same LinkedIn', name_and_company: 'same name and company', name: 'same name' };

function savedLines(answer, nameFromText) {
  const who = clean(answer.name) || 'this person';
  const lines = [answer.made
    ? `Saved a new card for ${who}.`
    : `Added to the card for ${who}${MATCHED[answer.matched_by] ? ` (${MATCHED[answer.matched_by]})` : ''}.`];
  if (answer.note_saved) lines.push('Their words are kept as a note.');
  if (answer.follow_up_on) lines.push(`Follow-up ${clean(answer.follow_up_on)}.`);
  if (nameFromText && answer.made) lines.push('The name was read from your text. If that is wrong, run it again with --name "<name>".');
  return lines;
}

function cardLinesFor(ctx, detail, now) {
  const card = detail.card;
  const ties = Array.isArray(detail.ties) ? detail.ties : [];
  const touches = Array.isArray(detail.touches) ? detail.touches : [];
  const people = model.buildPeople(S.cardToList(card, ties, touches, ''), now);
  const row = people.rows.find((r) => r.at === 1);
  const c = ctx.view.card(people, row, now);
  const mine = card.private || {};
  if (mine.next_move) c.move = mine.next_move;
  const lines = ctx.view.cardLines(c);
  const extra = [];
  if (mine.due_on) extra.push(`Follow up: ${model.shortDay(mine.due_on, now)}`);
  const next = lines.findIndex((line) => line.startsWith('Next:'));
  lines.splice(next < 0 ? lines.length : next + 1, 0, ...extra);
  return lines;
}

function choiceLine(choice, n) {
  const role = [clean(choice.title), clean(choice.company)].filter(Boolean).join(' at ');
  return `  ${n}. ${clean(choice.name) || 'Unknown'}${role ? `, ${role}` : ''}`;
}

function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(String(answer || '')); });
    rl.on('close', () => resolve(''));
  });
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > STDIN_MOST) break;
  }
  return text;
}

/** The same text, on the same day, to the same card (or new) always makes the same ref. */
function refFor(name, text, personId, isNew, now) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const raw = ['cli-capture', name.toLowerCase(), text, day, personId || '', isNew ? 'new' : ''].join('\u001f');
  return `cli-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
}

async function run(ctx) {
  const { log, err, now } = ctx;
  const parsed = parseFlags(ctx.rawArgs || [], { value: VALUE, bare: BARE }, 'capture');
  const json = !!(parsed.flags && parsed.flags.json) || (ctx.rawArgs || []).includes('--json');
  const refuse = (message, code = 2, extra = {}) => {
    if (json) log(JSON.stringify({ ok: false, error: message, ...extra }));
    else err(message);
    return code;
  };
  if (parsed.error) return refuse(parsed.error);
  const { flags } = parsed;
  const stdinTTY = ctx.isTTY !== undefined ? !!ctx.isTTY : !!process.stdin.isTTY;
  const interactive = !json && (ctx.isTTY !== undefined ? !!ctx.isTTY : !!(process.stdin.isTTY && process.stdout.isTTY));

  if (flags.person !== undefined && !UUID.test(String(flags.person).trim())) return refuse('--person takes the id of a card on your list, from the choices this command printed.');
  if (flags.person !== undefined && flags.new) return refuse('Use --person or --new, not both.');

  let text = parsed.words.join(' ').trim();
  if (!text) {
    if (stdinTTY) return refuse('atris nexus capture needs the text. Give it after the word capture, or pipe it in: pbpaste | atris nexus capture');
    text = String(await (ctx.stdin || readStdin)()).trim();
  }
  if (!text) return refuse('There was no text to save.');
  const cut = text.length > NOTE_MOST;
  if (text.length > WORDS_MOST) text = text.slice(0, WORDS_MOST);

  const emails = found(text, EMAIL);
  const linkedins = found(text, LINKEDIN);
  const given = (key) => (typeof flags[key] === 'string' ? flags[key].trim() : '');
  const name = clean(given('name') || guessName(text, emails));
  const nameFromText = !given('name');
  if (!name) return refuse('I could not find a name in that text. Add one: atris nexus capture --name "<name>" "<text>"');
  if (name.length > NAME_MOST) return refuse(`That name is too long: ${NAME_MOST} characters at most.`);

  const body = { name, words: text, source: 'command_line' };
  for (const [flag, key] of [['company', 'company'], ['title', 'title'], ['city', 'city']]) if (given(flag)) body[key] = given(flag);
  const email = given('email') || (emails.length === 1 ? emails[0] : '');
  const linkedin = given('linkedin') || (linkedins.length === 1 ? linkedins[0] : '');
  if (email) body.email = email;
  if (linkedin) body.linkedin_url = linkedin;
  if (flags['follow-up'] !== undefined) {
    const day = S.parseDay(flags['follow-up'], now);
    if (!day.ok || !day.day) return refuse(`"${clean(flags['follow-up'])}" is not a date. Use YYYY-MM-DD, today or tomorrow.`);
    body.follow_up_on = day.day;
  }
  let personId = flags.person !== undefined ? String(flags.person).trim().toLowerCase() : '';
  let isNew = !!flags.new;

  let token;
  try {
    ({ token } = await ctx.getToken());
  } catch (error) {
    return refuse(oneLine(error && error.message), 1);
  }
  if (!token) return refuse(ctx.notLoggedIn || 'Sign in first: atris login', 1);
  const client = storeClient(ctx.request, token);
  const out = (data) => log(JSON.stringify(data));

  try {
    let answer;
    for (let round = 0; round < ASK_ROUNDS; round++) {
      const sent = { ...body, ref: refFor(name, text, personId, isNew, now) };
      if (personId) sent.person_id = personId;
      if (isNew) sent.new = true;
      answer = await client.post('/nexus/capture', sent, { retries: 0 });
      const choices = Array.isArray(answer.choices) ? answer.choices.filter((c) => c && UUID.test(String(c.person_id || ''))) : [];
      if (!choices.length) break;

      const shown = choices.map((c, i) => ({ number: i + 1, person_id: c.person_id, name: clean(c.name), title: clean(c.title), company: clean(c.company) }));
      if (!interactive) {
        // Never guess, and never save. One JSON object, whether or not --json was given.
        out({
          ok: false, saved: false, needs_choice: true, name,
          error: 'Nothing was saved: this could be someone already on your list. Run the same command again with --person <person_id>, or --new for someone new.',
          choices: shown,
        });
        return EXIT_NEEDS_CHOICE;
      }
      log(`Nothing saved yet. ${name} could be someone already on your list:`);
      for (const c of shown) log(choiceLine(c, c.number));
      log('  n. Someone new');
      const reply = clean(await (ctx.ask || askLine)('Which one? Number, or n for new (Enter to cancel): ')).toLowerCase();
      if (/^(n|new)$/.test(reply)) { isNew = true; personId = ''; continue; }
      const at = /^\d+$/.test(reply) ? Number(reply) : 0;
      if (at >= 1 && at <= shown.length) { personId = String(shown[at - 1].person_id).toLowerCase(); isNew = false; continue; }
      log('Nothing was saved.');
      return 1;
    }
    if (Array.isArray(answer.choices) && answer.choices.length) {
      return refuse('It is still not clear which card this is, so nothing was saved. Pick one with --person <id>.', 1);
    }
    if (!answer.person_id) return refuse('The people store did not give back a card, so check atris nexus before saving it again.', 1);

    // The card as it stands now, in the same plain style as atris nexus "<name>".
    let detail = null;
    try {
      detail = await client.get(`/nexus/people/${encodeURIComponent(answer.person_id)}`);
    } catch {
      detail = null;
    }
    const shownCard = detail && detail.card ? detail : null;
    if (json) {
      out({ ok: true, saved: true, name_from: nameFromText ? 'text' : 'flag', text_cut: cut, ...answer, card: shownCard ? shownCard.card : null });
      return 0;
    }
    for (const line of savedLines(answer, nameFromText)) log(line);
    if (cut) log(`Only the first ${NOTE_MOST} characters are kept as the note.`);
    if (shownCard) {
      log('');
      for (const line of cardLinesFor(ctx, shownCard, now)) log(line);
    } else {
      log('The card could not be shown just now. See it with: atris nexus "<name>"');
    }
    return 0;
  } catch (error) {
    if (error instanceof StoreLocked) return refuse(error.message, 1, { status: 402 });
    if (error instanceof StoreError) return refuse(error.message, 1);
    return refuse(oneLine(error && error.message) || 'That did not save. Try again in a moment.', 1);
  }
}

function oneLine(message) {
  return String(message == null ? '' : message).replace(/\s+/g, ' ').trim();
}

module.exports = { SUBS, HELP, run, parseFlags, guessName, refFor, clean };

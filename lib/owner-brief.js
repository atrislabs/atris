'use strict';

// The owner's one screen: what is waiting on a person, what landed this week,
// and how each teammate is doing.
//
// Everything here is read, nothing is written. The task store is opened
// read-only, the links come from what jobs saved (a merge commit also uses the
// workspace's own git origin), and no network is touched. Landings, ratings, and
// miss reasons come from lib/gm-season.js, the code atris rating and atris gm run,
// so this screen cannot disagree with them. Every link, title, note, and reason is
// cleaned of secrets before it is returned, so nothing printed from here (the
// screen, the page, the text sent, the json) carries one.

const fs = require('fs');
const { spawnSync } = require('child_process');
const { scrub } = require('../utils/agent-client');
const { SECRET_RULES } = require('./security-scan');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// Needs you prints this many, then "and N more".
const SHOWN = 10;
// A job a person sent back this many times is not getting better on its own.
const SENT_BACK_LIMIT = 2;
const REASON_MAX = 100;

// ---- small helpers -----------------------------------------------------------

function parseJson(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function plain(value) {
  return String(value == null ? '' : value)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// At most `max` characters, cut at a word when there is one near the end.
function clip(value, max) {
  const text = plain(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 3));
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}...`;
}

// Someone else's words, quoted on a line of their own: no quote marks inside, no
// full stop at the end.
function quoted(value, max) {
  return `"${clip(plain(value).replace(/"/g, "'").replace(/[.!?]+$/, ''), max)}"`;
}

// A length of time in words: "40 minutes", "5 hours", "2 days".
function spanWords(ms) {
  const minutes = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (minutes < 60) return minutes <= 1 ? 'a minute' : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour' : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'a day' : `${days} days`;
}

function withMeta(row) {
  return { ...row, metadata: parseJson(row.metadata) };
}

// ---- secrets -----------------------------------------------------------------

// Notes, reasons, titles, names, tags, and links come from jobs and from other people,
// and a token that went through a task command can sit in any of them. The repo has no
// cleaner for free text, so this joins the two pieces it does have: the provider
// patterns the security scan finds secrets with (lib/security-scan.js) and scrub, which
// keeps client secrets and JWTs out of error text (utils/agent-client.js). On top of
// those it covers what people paste in practice: a login inside a link, the query
// string and fragment of a link, a short Bearer token, a private key block, and the
// value of a pair like token=abc, whatever its length (withoutAssignedSecrets).
//
// Two changes to the scan's rules. The scan matches a provider key between word
// boundaries, and a letter, a digit, and an underscore are word characters, so
// worker_ghp_... or xAKIA... gets past it. Here a known provider key is looked for with
// no boundary at either end and the same body length, so it is hidden after any
// character while ordinary words (task-force, ghp_short) still do not match. And the
// scan's assigned-secret rule is left out: withoutAssignedSecrets reads the same pairs
// for more names and in more forms, and reads a quoted value to its real end, where the
// rule stops at an escaped quote and leaves the rest of the value showing.
//
// A note can be as long as someone makes it, and a pattern that starts again at every
// character can take longer than linear time on a long run of the same few characters.
// So the cleaner reads the first CLEAN_MAX characters of a field and no more, cut back to
// the last space (cutAtSpace), and the patterns below are written so that each one looks at
// a character once: a start that cannot begin a match is refused at once, by what is before
// it, rather than tried and backed out of. What it gives back is at most 300 characters, the
// most scrub lets through, and they end at a whole word (scrubbed, below). A field that was
// cut can end in a piece of a key, which no key rule knows: the start of a key at the end of a
// field is hidden (withoutCutKey, below), and a reason the store itself cut at 300 characters is
// read without its last word (reasonOf, below).
const REDACTED = '[redacted]';
const withoutBoundaries = (rule) => (rule.known ? rule.re.source.replace(/^\\b/, '').replace(/\\b$/, '') : rule.re.source);
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // a login in a link, found from the :// outward: whatever stands before a login is the scheme
  [/(?<=:\/\/)[^\s/?#@]+(?=@)/g, REDACTED],
  // a link without its query string and fragment. The query is optional, so a link with none
  // still matches and is used up whole, where a link that fails to match would be tried
  // again from every https:// inside it.
  [/\b(https?:\/\/[^\s?#"'<>]+)(?:[?#][^\s"'<>]*)?/gi, '$1'],
  ...SECRET_RULES
    .filter((rule) => rule.id !== 'assigned-secret')
    .map((rule) => [new RegExp(withoutBoundaries(rule), rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`), REDACTED]),
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, REDACTED],
];

// Names a value is a credential under. A name is cut into words at dashes, underscores,
// digits, and capital letters, so access_token, access-token, accessToken, and
// ACCESS_TOKEN read the same, and whole words only count: monkey, keyboard, author, and
// design are not keys. There are two kinds of name.
//   strong: always a credential. token, secret, password, passwd, pwd, authorization, a
//     run-together spelling that ends in one of them (accesstoken, clientsecret, apikey),
//     and key after a word that makes it a credential (api_key, private_key, x-api-key).
//   weak: auth, key, session, sig, signature. These are also plain words in a sentence
//     ("Fix auth: redirect loop"), so what follows one is judged (looksLikeToken).
const STRONG_NAME_WORD = /^(?:token|secret|password|passwd|pwd|authorization)$|(?:token|secret|password|passwd|pwd|(?:access|auth|refresh|api|client|private|secret)key)$/;
const WEAK_NAME_WORD = /^(?:key|auth|session|sig|signature)$/;
const KEY_QUALIFIER = /^(?:access|auth|refresh|api|client|private|secret)$/;

function secretNameKind(name) {
  const words = String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word, i) => STRONG_NAME_WORD.test(word) || (word === 'key' && KEY_QUALIFIER.test(words[i - 1] || '')))) return 'strong';
  return words.some((word) => WEAK_NAME_WORD.test(word)) ? 'weak' : null;
}

// What follows a weak name in a sentence reads as a token when it has a digit, or is 16
// characters or more with no space in it, or has a key already cut out of it with letters
// or digits still stuck to the end of the marker (a key, then ,def). A token with a known
// shape (a provider key, a JWT, a Bearer value, an atcs_ secret) has already been cut out
// by the patterns, or is cut out by scrub right after, so the key itself never depends on
// this check; what is stuck to it does. A marker does not count toward the length, and a
// marker with nothing but punctuation after it is not a token, so cleaning clean text
// changes nothing.
function looksLikeToken(value) {
  const parts = String(value).replace(/^["']|["']$/g, '').split(REDACTED);
  if (parts.slice(1).some((part) => /[A-Za-z0-9]/.test(part.split(/\s/, 1)[0]))) return true;
  const bare = parts.join('');
  return /[0-9]/.test(bare) || (bare.length >= 16 && !/\s/.test(bare));
}

// The value of a pair like token=abc, password: abc, or "api_key": "abc", when the name
// says it is a credential. Short values are the ones the patterns above cannot tell from
// ordinary words, and the name is all that gives them away. Two forms are told apart.
// Written as a setting (name=value, name := value, name => value, or a json pair with
// the name in quotes), every credential name hides its value whatever its length, since
// links and config text use these forms. Written as a sentence (a bare name: value), a
// weak name hides the value only when it looks like a token, so "Fix auth: redirect
// loop" and "session: rename the button" read as written. A quoted value runs to its
// closing quote, with backslash escapes read, so password="abc\"def" is one value; a quote
// that never closes runs to the end of the text, so a cut or a typo cannot leave the rest
// of a quoted secret showing. Any other value runs to the next space or the end of the
// text, so password=abc,def hides all of abc,def. That can hide a little more than the
// secret, which is the safe side. The run is the same whatever ran before this rule: a key
// an earlier pattern already cut out is part of it like any other characters, so
// password=[redacted],def is hidden to the end of the run, marker included, and nothing
// stuck to a key is left showing. The cost is that a json pair cleaned a second time loses
// the comma after it ("password": [redacted], becomes "password": [redacted]), which hides
// nothing more than was hidden. A pair is looked for anywhere, so one inside a link's
// path (runs/token=abc) is found too, and a name that is not a credential, or a weak one
// left alone, is skipped without using up what follows it (https: comes before the path it
// sits in front of).
function withoutAssignedSecrets(text) {
  const pairs = /([A-Za-z][A-Za-z0-9_-]{0,63})(["']?)\s*(:=|=>|[:=])\s*/g;
  const value = /(?:(?:bearer|basic|digest|token)\s+)?(?:(?<closed>"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')|(?<open>["'][\s\S]*)|(?<run>\S+))/iy;
  // Inside a value that is already hidden, a pair matters only if its own value can run past
  // the end of that one: a quoted value, or one after a word like Bearer, can reach beyond
  // the space that ends the run. Any other value ends where the run it sits in ends.
  const reachesPast = /["']|(?:bearer|basic|digest|token)\s/iy;
  let out = '';
  let from = 0;
  let found;
  while ((found = pairs.exec(text))) {
    const kind = secretNameKind(found[1]);
    if (!kind) continue;
    const start = found.index + found[0].length;
    if (start < from) {
      reachesPast.lastIndex = start;
      if (!reachesPast.test(text)) continue;
    }
    value.lastIndex = start;
    const hit = value.exec(text);
    if (!hit) continue;
    const asSetting = found[2] !== '' || found[3] !== ':';
    // in a sentence, an open quote is judged by its first word: the rest of the text is not the value's
    const { closed, open, run } = hit.groups;
    if (kind === 'weak' && !asSetting && !looksLikeToken(closed || run || open.split(/\s/, 1)[0])) continue;
    const end = start + hit[0].length;
    if (found.index >= from) {
      out += `${text.slice(from, start)}${REDACTED}`;
      from = end;
    } else if (end > from) {
      // the pair began inside a value already hidden and runs past it: one hidden stretch
      from = end;
    }
  }
  return out + text.slice(from);
}

function withoutSecrets(text) {
  let out = String(text == null ? '' : text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return withoutAssignedSecrets(out);
}

// The most of one field the cleaner reads. What it gives back is at most 300 characters (scrubbed,
// below), so this is far more than is ever kept. It only caps the work a very long note can cost.
const CLEAN_MAX = 5000;

// At most `max` characters, cut back to the last space so no word is split. A piece of a
// token is not a token (ghp_ and twelve more characters is under the rule's 36 and would
// print as it is), so the word the cut falls in is dropped whole, and so is a text with no
// space in what is read. A space at the cut means the cut falls between two words.
function cutAtSpace(text, max = CLEAN_MAX) {
  const value = String(text == null ? '' : text);
  if (value.length <= max || /\s/.test(value[max])) return value.slice(0, max);
  let end = max;
  while (end > 0 && !/\s/.test(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

// The start of every kind of key the patterns above find whole. A field that was cut can end in
// the first part of a key: a flight cuts a reason at 300 characters and the store squeezes runs
// of spaces after that, so a cut reason can be far shorter than 300 (a reviewer saved one of 41).
// A piece of a key is under what the key rule needs (ghp_ and ten more characters is under its
// 36), so it would print as it is. But a cut can only leave the start of a key at the end of a
// field, so the last word of a field is hidden from the first key start in it to its end,
// whatever the length of the field, of the word, or of what follows the start (withoutCutKey).
// A key start with a short body anywhere else is left to the key rules, which want the whole
// body. Most starts are not part of any ordinary word, so they count after any character, as a
// whole key does (Workerghp_...). The others also stand inside ordinary words (task-12, MSG.,
// EURASIA, pnpm_store, highs_total, task_live_report, SurveyJob), so they count only at the
// start of a word or after anything that is not a letter or a digit. sk- is the start of
// sk-proj- and sk-ant- too. An npm token is npm_ and letters and digits, so npm_ followed by
// letters or digits and another underscore (npm_config_cache) is a variable name. The atcs_
// secret is here for the same reason; scrub finds it with any body.
//
// A repository, a branch, and a folder are named by people, and a name can begin the way a key
// does (acme/sk-tools). So a start right after a slash does not count. A link is whole as it
// stands: only what comes in front of its path is read, where a login or a Slack webhook address
// would be, and only for the starts in the first list, which no host or name begins with.
const KEY_START = /gh[pour]_|github_pat_|xox[baprs]-|AIza|atcs_|https:\/\/hooks\.slack\.com\/services\//y;
const WORD_KEY_START = /sk-|[rs]k_live_|ghs_|npm_(?![A-Za-z0-9]*_)|SG\.|AKIA|ASIA|eyJ/y;

// The text with its last word cut off from the first key start in it. The last word is the last
// run of characters with no space, and it is looked at once, from its first character. A link is
// whole as it stands, so only the part in front of its first path slash is looked at.
function withoutCutKey(text) {
  const value = String(text == null ? '' : text);
  let end = value.length;
  while (end > 0 && /\s/.test(value[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  const scheme = value.indexOf('://', start);
  const link = scheme >= 0 && scheme < end;
  const slash = link ? value.indexOf('/', scheme + 3) : -1;
  const stop = slash >= 0 && slash < end ? slash : end;
  for (let at = start; at < stop; at += 1) {
    const before = at > start ? value[at - 1] : '';
    if (before === '/' && !link) continue;
    KEY_START.lastIndex = at;
    let found = KEY_START.test(value);
    if (!found && !link && !/[A-Za-z0-9]/.test(before)) {
      WORD_KEY_START.lastIndex = at;
      found = WORD_KEY_START.test(value);
    }
    if (found) return `${value.slice(0, at)}${REDACTED}`;
  }
  return value;
}

// scrub (utils/agent-client.js) keeps the first 300 characters of any text, wherever the 300th
// falls, so a link or a path that stands across it is left as a piece (https://example.org/rep).
// Where a person reads the title, the task codes in front of it are taken out, and then the
// piece is all that shows of it. So the cut is made here, at a word. Each word goes through scrub
// on its own (what scrub hides never spans white space), and words are kept for as long as they
// all fit in 300 characters once hidden. A word that does not fit, or that scrub itself would cut,
// is dropped whole with everything after it, so no word is ever shown in pieces. A text that fits
// once its white space is squeezed comes out exactly as scrub makes it. What withoutSecrets hides
// is hidden before any of this, so a secret that stands across the 300th is its marker, never a
// piece of itself.
const SCRUB_KEEPS = 300;

function scrubbed(text) {
  let out = '';
  for (const [word] of String(text == null ? '' : text).matchAll(/\S+/g)) {
    const shown = scrub(word, []);
    // at 300 scrub may have cut the word; it is whole only if it came back as it went in (a word that
    // hiding changed and left at exactly 300 is dropped too, the safe side)
    if (shown.length >= SCRUB_KEEPS && shown !== word) break;
    const next = out ? `${out} ${shown}` : shown;
    if (next.length > SCRUB_KEEPS) break;
    out = next;
  }
  return out;
}

// Text that is not a field's own words, ready to print: a link, which is whole as it stands, so a
// folder named sk-tools in its path is not the start of a key at the end of anything. The patterns
// run on the first CLEAN_MAX characters at once, so a token is never cut in half by scrub's length
// limit, and by none of ours either: what is cut off is cut at a space (cutAtSpace, scrubbed).
function cleaned(text) {
  return scrubbed(withoutSecrets(cutAtSpace(text)));
}

// A title, a note, a reason, a name, or a tag, ready to print: cleaned as above, and with the start
// of a key at the end of it hidden.
function redacted(text) {
  return scrubbed(withoutCutKey(withoutSecrets(cutAtSpace(text))));
}

// A release reason is kept to 300 characters. The store cuts what a person types and ends it
// with "..." (RELEASE_REASON_MAX in lib/task-db.js), and a flight cuts its own reason at 300
// with nothing added (releaseReason in lib/fleet.js). Whatever stood across that cut is a
// piece of a word now, and a piece of a key is not a key (ghp_ and twelve more characters is
// under the key rule's 36), so it would print as it is. Two rules keep it off the screen. The
// start of a key at the end of any field is hidden at any length (withoutCutKey, above), since
// the store squeezes runs of spaces after a flight has cut and a cut reason can come out far
// shorter than 300. And a reason or a note that is as long as the cut has its last word
// treated as possibly cut, whatever it is: the run is dropped before the text is cleaned, the
// way cutAtSpace drops the word its own cut falls in, which also covers a piece of a secret
// that has no start to know it by (a cut password value, or the middle of a key). The room
// below 300 is for the squeeze. A text over 300 was not cut by the store, and one well under
// it was not cut so close to the end, so both keep their last word unless it starts a key.
const STORE_CUT = 300;
const STORE_CUT_ROOM = 20;

function withoutCutWord(text) {
  const value = String(text == null ? '' : text);
  if (value.length < STORE_CUT - STORE_CUT_ROOM || value.length > STORE_CUT) return value;
  let end = value.length;
  while (end > 0 && /\s/.test(value[end - 1])) end -= 1;
  while (end > 0 && !/\s/.test(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

// A reason or a note read back from the store, ready to print.
function reasonOf(text) {
  return redacted(withoutCutWord(text));
}

// A builder name or a tag, ready to print. Whoever claims a job (task claim --as) or adds
// one (task add --tag) types these, so each can carry a token like any note. Null when
// nothing is left. Names are cleaned where they leave this file; the raw name is still
// what jobs are grouped and compared by.
function nameOf(value) {
  return redacted(plain(value)) || null;
}

// ---- links -------------------------------------------------------------------

// https://github.com/<owner>/<repo> from a git remote in any of its usual forms
// (scp style, https, ssh, git), or null for another host, a local path, or
// anything that does not name exactly one owner and one repo. Credentials in the
// remote are dropped here and never printed.
function githubBaseUrl(remote) {
  const text = plain(remote);
  if (!text) return null;
  const match = text.match(/^(?:[\w.+-]+@)?github\.com:(?!\/)(.+)$/i)
    || text.match(/^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/\s]*@)?github\.com(?::\d+)?\/(.+)$/i);
  if (!match) return null;
  const parts = match[1].replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  const sound = parts.length === 2 && parts.every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..');
  return sound ? `https://github.com/${parts[0]}/${parts[1]}` : null;
}

// The workspace's own origin, read from its git config. This runs git on the
// local repo and nothing else: no gh, no network.
function originBase(workspace) {
  try {
    const res = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: workspace, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return res.status === 0 ? githubBaseUrl(res.stdout) : null;
  } catch {
    return null;
  }
}

// A link, ready to print: kept as it was saved but with nothing in it that could carry
// a secret. The login, query string, and fragment are dropped. What is left goes
// through the same redactor every note and title goes through, and a link it would
// still change (a secret in its path, or a link too long to keep whole) is not printed
// at all. Null for anything that is not a plain http or https link. Every link this
// screen prints is made here, including the ones it builds itself.
function printableLink(value) {
  const text = plain(value);
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  let bare = text.split(/[?#]/)[0];
  try {
    const url = new URL(bare);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      bare = url.href;
    }
  } catch {
    return null;
  }
  return cleaned(bare) === bare ? bare : null;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function commitHash(value) {
  const text = plain(value);
  return /^[0-9a-f]{7,64}$/i.test(text) ? text.toLowerCase() : null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The GitHub home page of the repository a pull request record names, or null. The
// records fleet writes today name none; this is for records that do, as
// "owner/name", a GitHub link or remote, or a repository record.
function recordedRepository(pull) {
  for (const field of [pull.repository, pull.repo]) {
    const text = plain(isObject(field) ? field.full_name || field.nameWithOwner || field.html_url : field);
    const base = /^[\w.-]+\/[\w.-]+$/.test(text) ? githubBaseUrl(`https://github.com/${text}`) : githubBaseUrl(text);
    if (base) return base;
  }
  return null;
}

// The link a pull request record gives: the one it saved, else its number on the
// repository the record names. A number alone is never turned into a link. The
// workspace's own origin is not necessarily where the pull request lives, and a
// guessed link can open somebody else's pull request.
function pullLink(pull) {
  if (!isObject(pull)) return null;
  const saved = printableLink(pull.url);
  if (saved) return saved;
  const number = positiveInt(pull.number);
  const base = number ? recordedRepository(pull) : null;
  return base ? printableLink(`${base}/pull/${number}`) : null;
}

// A pull request record that says it was merged, in the same words the rating
// reads (see hasStructuredMerge in lib/gm-season.js).
function isMergedPull(pull) {
  if (!isObject(pull)) return false;
  return String(pull.state || pull.status || '').toLowerCase() === 'merged'
    || pull.merged === true || Boolean(pull.merged_at) || Boolean(commitHash(pull.merge_commit));
}

// Older records name the merged pull request on `merged_pr`: a record, a link, or
// just its number.
function mergedPullOf(record) {
  if (!isObject(record) || record.merged_pr == null) return null;
  if (isObject(record.merged_pr)) return record.merged_pr;
  const text = plain(record.merged_pr);
  if (printableLink(text)) return { url: text };
  // A link that could not be printed is not a number either: the digits in it can be
  // part of the secret that kept it off the screen.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  const number = positiveInt((text.match(/^\D*(\d+)\D*$/) || [])[1]);
  return number ? { number } : null;
}

// Where to open a landed job: its merged pull request, else its merge commit on the
// workspace's GitHub (`base`). When the pull request has no link to open, its number
// comes back instead, so the screen can say so.
//
// `payload` is the landing's own history entry, and nothing else is read. The job's
// own record is not a source: it names only the latest merge, and reopening a job
// removes its pull request but keeps its merge commit, so for a job that landed twice
// the record points at the first landing. A landing whose entry records nothing (a
// person accepting it, say) gets no link.
function landingLink(payload, base) {
  const pulls = [payload.pull_request, payload.pr].filter(isMergedPull)
    .concat([payload, payload.landing].map(mergedPullOf).filter(Boolean));
  for (const pull of pulls) {
    const link = pullLink(pull);
    if (link) return { link, pull_request: null };
  }
  const records = [payload.landing, payload.pull_request, payload.pr, payload, ...pulls];
  const commit = records
    .map((record) => (isObject(record) ? commitHash(record.merge_commit || record.merge_commit_sha || record.merge_sha) : null))
    .find(Boolean);
  return {
    link: base && commit ? printableLink(`${base}/commit/${commit}`) : null,
    pull_request: pulls.map((pull) => positiveInt(pull.number)).find(Boolean) || null,
  };
}

// ---- the store ---------------------------------------------------------------

function protectedLane(task) {
  // Fleet decides what is protected: staffing, shipping, and this screen ask it.
  return require('./fleet').protectedLaneOfTask(task);
}

// Display refs (CLI-12) the season already worked out for open, claimed, and
// review jobs, so this does not rank the whole task list a second time.
function refsOf(season) {
  const refs = new Map();
  for (const list of [season.open_tasks, season.reviews, season.claims]) {
    for (const row of list || []) {
      const id = row.task_id || row.id;
      if (id && row.ref) refs.set(id, row.ref);
    }
  }
  return refs;
}

function needsItem(fields, ctx) {
  const since = Number(fields.since) || 0;
  return {
    kind: fields.kind,
    id: fields.accept_id || ctx.refs.get(fields.task_id) || fields.task_id || '',
    task_id: fields.task_id || null,
    title: ctx.titleOf(fields.title) || 'untitled',
    why: fields.why,
    link: fields.link || null,
    // The pull request's number, only when it has no link to open.
    pull_request: fields.pull_request || null,
    since,
    age: since ? spanWords(ctx.now - since) : '',
    built_by: nameOf(fields.built_by),
    accept_id: fields.accept_id || null,
  };
}

// Jobs a person sent back from review SENT_BACK_LIMIT times or more that are still
// not finished. Only a send-back from review counts. A reopen says where the job
// was (previous_status): one from review counts, one from finished, failed, or
// archived work does not. A revision says so only when it was made on work already
// accepted as done, and that was not review either.
function sentBackJobs(db, workspace) {
  const rows = db.prepare(`
    SELECT e.task_id AS task_id, e.event_type AS event_type, e.payload AS payload, e.created_at AS created_at
      FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE t.workspace_root = ? AND t.status IN ('open', 'claimed', 'review')
       AND e.event_type IN ('revision_requested', 'reopened')
     ORDER BY e.task_id, e.version`).all(workspace);
  const jobs = new Map();
  for (const row of rows) {
    const payload = parseJson(row.payload);
    const from = plain(payload.previous_status).toLowerCase();
    if (row.event_type === 'reopened' ? from !== 'review' : from && from !== 'review') continue;
    const job = jobs.get(row.task_id) || { times: 0, last_at: 0, note: '' };
    job.times += 1;
    job.last_at = Number(row.created_at);
    job.note = plain(payload.note || payload.reason);
    jobs.set(row.task_id, job);
  }
  for (const [taskId, job] of jobs) {
    if (job.times < SENT_BACK_LIMIT) jobs.delete(taskId);
    else job.note = reasonOf(job.note);
  }
  return jobs;
}

function sentBackWhy(job) {
  return `Sent back ${job.times} times and still not done.${job.note ? ` Last note: ${quoted(job.note, REASON_MAX)}` : ''}`;
}

// What a finished job with an open pull request says to the owner. With no usable
// link it still needs a person, but it is not called ready to merge: there is
// nothing to open, so the line says the link is missing and where to look.
function heldWhy({ builder, link, number, proofLost = false, sentBackTimes = 0 }) {
  const pull = !link && number ? `pull request ${number}` : 'a pull request';
  const opening = builder ? `${builder} finished this and opened ${pull}` : `This is finished and has ${pull} open`;
  const parts = [`${opening}${link ? '' : ', but its link was not saved'}.`];
  if (proofLost) parts.push('Its proof could not be saved, so the job shows as open.');
  parts.push(link ? 'It is waiting for you to merge it.' : 'Find it in the repository.');
  if (sentBackTimes) parts.push(`It was sent back ${sentBackTimes} times before.`);
  return parts.join(' ');
}

// Finished work whose pull request is open: a person has to merge it.
function heldItems(db, workspace, sentBacks, ctx) {
  const rows = db.prepare(`
    SELECT id, title, status, tag, claimed_by, created_at, updated_at, metadata,
           (SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id = tasks.id AND e.event_type = 'proof_ready') AS proof_at
      FROM tasks WHERE workspace_root = ? AND status = 'review'`).all(workspace).map(withMeta);
  const items = [];
  for (const row of rows) {
    const pull = row.metadata.pull_request;
    if (!isObject(pull) || String(pull.state || '').toLowerCase() !== 'open') continue;
    const builder = nameOf(row.claimed_by);
    const earlier = sentBacks.get(row.id);
    const link = pullLink(pull);
    const number = positiveInt(pull.number);
    items.push(needsItem({
      kind: 'held',
      task_id: row.id,
      title: row.title,
      why: heldWhy({ builder, link, number, sentBackTimes: earlier ? earlier.times : 0 }),
      link,
      pull_request: link ? null : number,
      since: row.proof_at || row.updated_at,
      built_by: builder,
    }, ctx));
  }
  return items;
}

// Work a builder finished whose pull request is open but whose proof could not be
// saved. The flight let go of the claim and put the pull request on the release
// entry, so the job is back to open with no pull request on its own record and
// heldItems cannot see it. The release is the only place that knows the link.
//
// `releases` are the plays openReleasePlays found: open jobs whose latest release is
// of this kind and that nobody has claimed, landed, archived, or reopened since, however
// long ago that was. They come from the store itself and not from the rating's 30 days of
// history, so the job stays here until somebody deals with it. Releases of the other kind
// are not listed here (see needsYou).
function unsavedProofItems(db, releases, ctx) {
  const release = db.prepare('SELECT payload FROM task_events WHERE event_id = ?');
  const items = [];
  for (const play of releases) {
    if (play.kind !== 'held') continue;
    const pull = parseJson((release.get(play.event_id) || {}).payload).pull_request;
    const link = pullLink(pull);
    const number = isObject(pull) ? positiveInt(pull.number) : null;
    const builder = nameOf(play.member);
    items.push(needsItem({
      kind: 'held',
      task_id: play.task_id,
      title: play.title,
      why: heldWhy({ builder, link, number, proofLost: true }),
      link,
      pull_request: link ? null : number,
      since: play.at,
      built_by: builder,
    }, ctx));
  }
  return items;
}

// The last thing that happened to each job in the window, not counting a builder
// taking it.
function lastPlays(plays) {
  const last = new Map();
  for (const play of plays) {
    if (play.kind !== 'took') last.set(play.task_id, play);
  }
  return last;
}

// Protected jobs a builder could not take through: it gave up on one (failed), or
// it let go of one (a release whose reason says where it stopped) and nobody has
// picked it up since. A job a builder still holds, or one waiting on a pull
// request, is not here.
function refusedItems(db, workspace, last, ctx) {
  const items = [];
  const failed = db.prepare(`
    SELECT id, title, status, tag, claimed_by, created_at, updated_at, metadata
      FROM tasks WHERE workspace_root = ? AND status = 'failed' AND updated_at >= ?`)
    .all(workspace, ctx.now - ctx.seasonDays * DAY_MS).map(withMeta);
  for (const row of failed) {
    const lane = protectedLane(row);
    if (!lane) continue;
    const builder = nameOf(row.claimed_by);
    items.push(needsItem({
      kind: 'refused',
      task_id: row.id,
      title: row.title,
      why: `${builder || 'A builder'} gave up on this protected ${lane} job, so it needs your call.`,
      since: row.updated_at,
      built_by: builder,
    }, ctx));
  }
  const openTask = db.prepare(`
    SELECT id, title, status, tag, claimed_by, created_at, updated_at, metadata
      FROM tasks WHERE id = ? AND workspace_root = ? AND status = 'open'`);
  // A release older than the job's latest archive or reopen is not counted, as in openReleasePlays:
  // the job was closed and then opened again for new work.
  const renewed = db.prepare(`
    SELECT 1 FROM task_events r
      JOIN task_events later ON later.task_id = r.task_id AND later.version > r.version
     WHERE r.event_id = ? AND later.event_type IN ('archived', 'reopened') LIMIT 1`);
  for (const [taskId, play] of last) {
    if (play.kind !== 'dropped') continue;
    const found = openTask.get(taskId, workspace);
    if (!found || (play.event_id && renewed.get(play.event_id))) continue;
    const row = withMeta(found);
    const lane = protectedLane(row);
    if (!lane) continue;
    const reason = reasonOf(play.reason);
    const builder = nameOf(play.member);
    items.push(needsItem({
      kind: 'refused',
      task_id: row.id,
      title: row.title,
      why: `${builder || 'A builder'} let go of this protected ${lane} job and nobody has taken it since.${reason ? ` Reason given: ${quoted(reason, REASON_MAX)}` : ''}`,
      since: play.at,
      built_by: builder,
    }, ctx));
  }
  return items;
}

function sentBackItems(db, sentBacks, ctx) {
  const row = db.prepare('SELECT id, title, claimed_by FROM tasks WHERE id = ?');
  const items = [];
  for (const [taskId, job] of sentBacks) {
    const found = row.get(taskId);
    if (!found) continue;
    items.push(needsItem({
      kind: 'sent_back',
      task_id: taskId,
      title: found.title,
      why: sentBackWhy(job),
      since: job.last_at,
      built_by: nameOf(found.claimed_by),
    }, ctx));
  }
  return items;
}

// Everything waiting on a person, newest first: finished work to merge (with its
// proof saved or not), protected jobs a builder could not take through, jobs sent
// back again and again, then the decision items brief already showed. A job
// counted twice shows once, as the first of those it fits.
function needsYou(db, workspace, plays, decisions, ctx) {
  const sentBacks = sentBackJobs(db, workspace);
  const last = lastPlays(plays);
  const releases = require('./gm-season').openReleasePlays(db, workspace);
  // A job the build machine could not start (a release of the could_not_start kind) is
  // left out on purpose, whichever way it would get here. Nothing was built, nothing
  // is waiting on a person, and the next run tries the job again. That includes the
  // older waiting list: it lists a job tagged protected or for a person whatever its
  // state, so such a job is dropped from the decisions too.
  const unstarted = new Set(releases.filter((play) => play.kind === 'could_not_start').map((play) => play.task_id));
  const seen = new Set();
  const items = [];
  const add = (item) => {
    if (item.task_id && seen.has(item.task_id)) return;
    if (item.task_id) seen.add(item.task_id);
    items.push(item);
  };
  heldItems(db, workspace, sentBacks, ctx).forEach(add);
  unsavedProofItems(db, releases, ctx).forEach(add);
  refusedItems(db, workspace, last, ctx).forEach(add);
  sentBackItems(db, sentBacks, ctx).forEach(add);
  decisions.filter((decision) => !unstarted.has(decision.task_id))
    .forEach((decision) => add(needsItem({ kind: 'decision', ...decision }, ctx)));
  return items.sort((a, b) => b.since - a.since || a.title.localeCompare(b.title));
}

// Every landing in the last 7 days, newest first, by the rating's own idea of
// landed: one line per landing, with the member who held the job for that landing.
// A job that landed, was reopened, and landed again is two lines. The link is the
// merged pull request, else the merge commit, taken from that landing's own history
// entry and from nowhere else (see landingLink).
function doneThisWeek(db, plays, ctx) {
  const eventPayload = db.prepare('SELECT payload FROM task_events WHERE event_id = ?');
  const landed = plays.filter((play) => play.kind === 'landed' && play.at >= ctx.now - WEEK_MS).sort((a, b) => b.at - a.at);
  return landed.map((play) => {
    const payload = parseJson((eventPayload.get(play.event_id) || {}).payload);
    const { link, pull_request: pullRequest } = landingLink(payload, ctx.base);
    return {
      task_id: play.task_id,
      title: ctx.titleOf(play.title) || 'untitled',
      built_by: nameOf(play.member),
      landed_at: play.at,
      age: spanWords(ctx.now - play.at),
      link,
      pull_request: pullRequest,
    };
  });
}

// One row per teammate who finished a job in the last 30 days: the rating the
// board shows, the same rating a week ago, how many landed, the lane they land
// most in, and their most common miss.
function teamRows(db, plays, earlier, ctx) {
  const { rosterRows, memberRatings, missReasons } = require('./gm-season');
  const rows = rosterRows({ outcomes: plays, limit: Number.MAX_SAFE_INTEGER })
    .filter((row) => row.finished > 0 || row.not_needed > 0 || row.held > 0 || row.could_not_start > 0);
  const then = memberRatings(earlier);
  const tagOf = db.prepare('SELECT tag FROM tasks WHERE id = ?');
  const tagCache = new Map();
  const laneOf = (taskId) => {
    if (!tagCache.has(taskId)) tagCache.set(taskId, plain((tagOf.get(taskId) || {}).tag));
    return tagCache.get(taskId);
  };
  return rows.map((row) => {
    const before = then.get(row.name);
    const ago = before ? before.ovr : null;
    const trend = row.ovr != null && ago != null ? (row.ovr > ago ? 'up' : row.ovr < ago ? 'down' : 'same') : null;
    const lanes = new Map();
    for (const play of plays) {
      if (play.member !== row.name || play.kind !== 'landed') continue;
      const lane = laneOf(play.task_id);
      if (lane) lanes.set(lane, (lanes.get(lane) || 0) + 1);
    }
    const best = [...lanes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const miss = missReasons(plays, row.name, 1)[0];
    return {
      member: nameOf(row.name),
      rating: row.ovr,
      rating_a_week_ago: ago,
      trend,
      change: trend === 'up' || trend === 'down' ? Math.abs(row.ovr - ago) : null,
      landed: row.landed,
      finished: row.finished,
      best_lane: best ? nameOf(best[0]) : null,
      top_miss: miss ? { reason: reasonOf(miss.reason), count: miss.count } : null,
    };
  });
}

function readStore({ target, workspace, now, decisions, titleOf }) {
  const gm = require('./gm-season');
  const season = gm.loadSeason(workspace, { now, days: gm.SEASON_DAYS, dbPath: target, lastSeen: null });
  if (season.error) throw new Error(season.error);
  const plays = season.outcomes;
  const ctx = { now, titleOf, seasonDays: gm.SEASON_DAYS, refs: refsOf(season), base: originBase(workspace) };
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    // The same ratings a week ago, made from what had happened by then, so a later
    // landing or a later "not needed" note cannot change what last week looked like.
    const earlier = gm.outcomesAsOf(db, workspace, now - WEEK_MS);
    return {
      needs_you: needsYou(db, workspace, plays, decisions, ctx),
      done_this_week: doneThisWeek(db, plays, ctx),
      team: teamRows(db, plays, earlier, ctx),
    };
  } finally {
    try { db.close(); } catch { /* nothing to close */ }
  }
}

// What the owner needs, read from the task store and nothing else. `decisions`
// are the items brief has always shown from the task projection file, already in
// plain words ({ task_id, accept_id, title, why, since }). When there is no task
// store yet, only those items and empty lists come back. When it cannot be read,
// the same comes back with `error` saying why. This never throws and never writes.
function buildOwnerBrief(root, { now = Date.now(), decisions = [] } = {}) {
  // A title is somebody's words too, and can carry a link or a token. It is cleaned here and kept
  // to 300 characters at a whole word (scrubbed); where a person reads it, the screen makes it
  // shorter still (see commands/brief.js).
  const titleOf = (title) => plain(redacted(title));
  const only = () => {
    const ctx = { now, titleOf, refs: new Map() };
    return {
      needs_you: decisions.map((decision) => needsItem({ kind: 'decision', ...decision }, ctx)).sort((a, b) => b.since - a.since),
      done_this_week: [],
      team: [],
    };
  };
  try {
    const taskDb = require('./task-db');
    const workspace = taskDb.workspaceRoot(root);
    const target = taskDb.getDbPath();
    if (!fs.existsSync(target)) return only();
    return readStore({ target, workspace, now, decisions, titleOf });
  } catch (err) {
    return { ...only(), error: plain(err && err.message ? err.message : err) || 'unknown error' };
  }
}

// ---- the text ----------------------------------------------------------------

// Titles, notes, and names come from jobs and from other people. Nothing in them
// should be able to move the cursor, clear the screen, or print a long dash.
function safeForTerminal(text) {
  return String(text)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

function ratingCell(row) {
  if (row.rating == null) return 'new';
  if (row.trend === 'up') return `${row.rating} ↑${row.change}`;
  if (row.trend === 'down') return `${row.rating} ↓${row.change}`;
  if (row.trend === 'same') return `${row.rating} =`;
  return String(row.rating);
}

function missCell(row) {
  return row.top_miss ? `${clip(row.top_miss.reason, 40)} (${row.top_miss.count})` : '-';
}

function teamLines(team) {
  if (!team.length) return ['  No one has finished a job here in the last 30 days.'];
  const cells = team.map((row) => [
    clip(row.member, 24),
    ratingCell(row),
    String(row.landed),
    row.best_lane ? clip(row.best_lane, 20) : '-',
    missCell(row),
  ]);
  const head = ['member', 'rating', 'landed', 'best lane', 'top miss'];
  const widths = head.map((title, col) => Math.max(title.length, ...cells.map((row) => [...row[col]].length)));
  const line = (row) => `  ${row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] + 2))).join('')}`.trimEnd();
  return [line(head), ...cells.map(line), '', '  Arrows compare with the same rating a week ago.'];
}

// One idea per line: a reason breaks after each sentence, but never inside
// someone's quoted words.
function sentences(text) {
  const out = [];
  let current = '';
  let inQuote = false;
  const chars = [...plain(text)];
  chars.forEach((ch, index) => {
    if (ch === '"') inQuote = !inQuote;
    current += ch;
    if (!inQuote && /[.!?]/.test(ch) && chars[index + 1] === ' ') {
      out.push(current.trim());
      current = '';
    }
  });
  if (current.trim()) out.push(current.trim());
  return out;
}

function lists(data) {
  return {
    needs: Array.isArray(data.needs_you) ? data.needs_you : [],
    done: Array.isArray(data.done_this_week) ? data.done_this_week : [],
    team: Array.isArray(data.team) ? data.team : [],
    broken: typeof data.owner_error === 'string' && data.owner_error ? data.owner_error : '',
  };
}

function brokenLine(message) {
  return `Could not read the task list here: ${plain(message).replace(/[.!?]+$/, '')}.`;
}

// The whole screen, as plain lines. Needs you is numbered because "a 2" at the
// prompt means the second item here.
function renderOwnerText(data) {
  const { needs, done, team, broken } = lists(data);
  const lines = [];

  lines.push(`Needs you${needs.length ? ` (${needs.length})` : ''}`, '');
  if (broken) {
    lines.push(`  ${brokenLine(broken)}`);
    lines.push(needs.length ? '  Showing only the items from the review list.' : '  Nothing else could be checked.', '');
  } else if (!needs.length) {
    lines.push('  Nothing is waiting on you.', '');
  }
  needs.slice(0, SHOWN).forEach((item, index) => {
    // The lines under an item start where its title does, for one digit or two.
    const head = `${index + 1}. `;
    const under = ' '.repeat(head.length);
    lines.push(`${head}${item.title}`);
    for (const sentence of sentences(item.why)) lines.push(`${under}${sentence}`);
    if (item.age) lines.push(`${under}Waiting ${item.age}.`);
    if (item.link) lines.push(`${under}${item.link}`);
    lines.push('');
  });
  if (needs.length > SHOWN) lines.push(`and ${needs.length - SHOWN} more (atris brief --json lists them all)`, '');

  lines.push(`Done this week${done.length ? ` (${done.length})` : ''}`, '');
  if (broken) lines.push('  Not available.');
  else if (!done.length) lines.push('  Nothing landed in the last 7 days.');
  for (const item of done) {
    lines.push(`- ${item.title}, by ${item.built_by || 'unknown'}, ${item.age} ago`);
    if (item.pull_request) lines.push(`  Pull request ${item.pull_request} has no saved link.`);
    if (item.link) lines.push(`  ${item.link}`);
  }
  lines.push('');

  lines.push('Team (last 30 days)', '');
  if (broken) lines.push('  Not available.');
  else lines.push(...teamLines(team));
  return safeForTerminal(lines.join('\n'));
}

// The same three parts as page blocks, for atris brief --html. A link is shown as
// text under its item, because the page has no clickable rows.
function ownerBlocks(data) {
  const { needs, done, team, broken } = lists(data);
  const needRows = needs.slice(0, SHOWN).map((item, index) => ({
    title: `${index + 1}. ${item.title}`,
    sub: [item.why, item.link].filter(Boolean).join(' '),
    value: item.age || '-',
    valueSub: 'waiting',
    sev: index,
  }));
  if (needs.length > SHOWN) {
    needRows.push({ title: `and ${needs.length - SHOWN} more`, sub: 'atris brief --json lists them all', value: String(needs.length - SHOWN), valueSub: 'more', sev: 2 });
  }
  if (broken) needRows.unshift({ title: 'Could not read the task list here', sub: plain(broken), value: '!', valueSub: 'error', sev: 0 });
  else if (!needRows.length) needRows.push({ title: 'Nothing is waiting on you', sub: '', value: '0', valueSub: 'items', sev: 2 });

  const doneRows = done.map((item, index) => ({
    title: item.title,
    sub: [`by ${item.built_by || 'unknown'}${item.pull_request ? `, pull request ${item.pull_request} has no saved link.` : ''}`, item.link].filter(Boolean).join(' '),
    value: item.age,
    valueSub: 'ago',
    sev: index,
  }));
  if (!doneRows.length) doneRows.push({ title: broken ? 'Not available' : 'Nothing landed in the last 7 days', sub: '', value: '0', valueSub: 'jobs', sev: 2 });

  const teamRows = team.map((row, index) => ({
    title: row.member,
    sub: `landed ${row.landed}, best lane ${row.best_lane || '-'}, top miss ${missCell(row)}`,
    value: ratingCell(row),
    valueSub: 'rating',
    sev: index,
  }));
  if (!teamRows.length) teamRows.push({ title: broken ? 'Not available' : 'No one has finished a job in the last 30 days', sub: '', value: '0', valueSub: 'members', sev: 2 });

  return [
    {
      type: 'panel',
      heading: 'Needs you',
      sub: needs.length ? 'Merge, approve, or send back.' : 'Nothing is waiting.',
      panel: { header: { title: 'Needs you', meta: String(needs.length) }, rows: needRows },
    },
    {
      type: 'panel',
      heading: 'Done this week',
      sub: done.length ? 'Landed in the last 7 days.' : 'Nothing landed.',
      panel: { header: { title: 'Done this week', meta: String(done.length) }, rows: doneRows },
    },
    {
      type: 'panel',
      heading: 'Team',
      sub: 'Last 30 days. Arrows compare with a week ago.',
      panel: { header: { title: 'Team', meta: String(team.length) }, rows: teamRows },
    },
  ];
}

module.exports = {
  CLEAN_MAX,
  SHOWN,
  buildOwnerBrief,
  cutAtSpace,
  githubBaseUrl,
  ownerBlocks,
  printableLink,
  reasonOf,
  redacted,
  renderOwnerText,
};

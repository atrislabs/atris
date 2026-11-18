'use strict';

// atris nexus import <file.csv>: bring a spreadsheet of people from this computer into your
// list. LinkedIn's own Connections.csv works (it has a few note lines before the header row),
// and so does any CSV with a header row: the name, email, company, title, city and LinkedIn
// columns are found from the header words.
//
// This is not `bring-over`. bring-over sends the people file already saved in your Atris
// folder (files/people.json); it never reads a file on this computer and knows nothing of
// CSV. Both end in the same place, POST /nexus/import (atrisos-backend routers/nexus_router.py,
// services/nexus_people.py import_people): a person you already have is only filled in, never
// overwritten, and a repeat of the same file adds no one twice.
//
// The default is a dry run that prints counts only. --yes sends. Nothing here prints or logs
// a name, email, company or city: not the dry run, not the answer (the store's own examples
// of skipped rows carry names, so they are dropped).

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/nexus-store');
const { storeClient, StoreLocked, StoreError } = require('./nexus-store');
const { parseFlags } = require('./nexus-capture');

const SUBS = new Set(['import']);
const HELP = [
  '  atris nexus import <file.csv>       read people from a CSV on this computer (LinkedIn Connections.csv works); a dry run with counts only, --yes sends',
];
const FILE_MOST = 50 * 1024 * 1024;
const SCAN_ROWS = 40; // how far down to look for the header row
const BATCH = 500;
const SEND_MS = 600000;

// Header words, exact after lowercasing and turning punctuation into spaces. The loose match
// (a short header holding the key word) only runs when nothing exact was found.
const WORDS = {
  name: ['name', 'full name', 'fullname', 'contact name', 'person name', 'person', 'contact', 'display name'],
  first: ['first name', 'firstname', 'first', 'given name', 'forename'],
  last: ['last name', 'lastname', 'last', 'surname', 'family name'],
  email: ['email', 'mail', 'e mail', 'email address', 'e mail address', 'work email', 'primary email', 'email 1'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin profile', 'linkedin link', 'profile url', 'profile link', 'url', 'profile'],
  company: ['company', 'company name', 'organization', 'organisation', 'org', 'employer', 'account', 'account name'],
  title: ['position', 'title', 'job title', 'role', 'job', 'headline', 'occupation'],
  city: ['city', 'location', 'town', 'metro', 'locality', 'city state'],
  website: ['website', 'web site', 'site', 'homepage', 'web'],
};
const LOOSE = { email: 'email', linkedin: 'linkedin', company: 'company', title: 'title', city: 'city', website: 'website' };
const ORDER = ['name', 'first', 'last', 'email', 'linkedin', 'company', 'title', 'city', 'website'];

const flat = (value) => String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tidy = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The rows of a CSV. Quotes, doubled quotes, line breaks inside quotes and a byte order mark are handled. */
function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let started = false;
  const src = String(text).replace(/^﻿/, '');
  const endCell = () => { row.push(cell); cell = ''; started = false; };
  const endRow = () => { endCell(); rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += ch;
      started = true;
    }
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

/** Which column holds which field, from one row of header words. Each column is used once. */
function mapHeader(cells) {
  const heads = cells.map(flat);
  const used = new Set();
  const map = {};
  for (const field of ORDER) {
    let at = heads.findIndex((h, i) => !used.has(i) && WORDS[field].includes(h));
    if (at < 0 && LOOSE[field]) {
      at = heads.findIndex((h, i) => !used.has(i) && h && h.split(' ').length <= 4 && h.split(' ').includes(LOOSE[field]));
    }
    if (at >= 0) { map[field] = at; used.add(at); }
  }
  return map;
}

const hasName = (map) => map.name !== undefined || map.first !== undefined;

/** The header row among the first rows (LinkedIn puts note lines above it), with the delimiter that read best. */
function findHeader(text) {
  let best = null;
  for (const delimiter of [',', ';', '\t']) {
    const rows = parseCsv(text, delimiter);
    for (let at = 0; at < Math.min(rows.length, SCAN_ROWS); at++) {
      const map = mapHeader(rows[at]);
      const count = Object.keys(map).length;
      if (!hasName(map) || (count < 2 && at > 0)) continue;
      if (!best || count > best.count) best = { rows, at, map, count, delimiter };
      break;
    }
  }
  return best;
}

const ADDR = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_LIKE = /^(?:https?:\/\/|www\.)\S+$/i;

/** One data row as a person for the store, or null when it has no name. */
function personFrom(row, map) {
  const at = (field) => (map[field] === undefined ? '' : tidy(row[map[field]]));
  const full = at('name') || [at('first'), at('last')].filter(Boolean).join(' ');
  if (!full) return null;
  const node = { t: 'p', n: full };
  const title = at('title');
  const company = at('company');
  const city = at('city');
  const email = at('email');
  if (title) node.title = title;
  if (company) node.co = company;
  if (city) node.city = city;
  if (ADDR.test(email)) node.email = email;
  const links = [at('linkedin'), at('website')].filter((v) => URL_LIKE.test(v) || /linkedin\.com\//i.test(v));
  if (links.length) node.links = links;
  return node;
}

/**
 * Two rows are one person when they share an email or a LinkedIn link. With neither, a name and
 * a company. A name alone is never enough: two people can share one, and the store decides.
 */
function keysOf(node) {
  const keys = [];
  if (node.email) keys.push(`e:${node.email.toLowerCase()}`);
  const li = (node.links || []).find((v) => /linkedin\.com\/in\//i.test(v));
  if (li) keys.push(`l:${li.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?#]/)[0].replace(/\/+$/, '')}`);
  if (!keys.length && node.co) keys.push(`n:${node.n.toLowerCase()}|${node.co.toLowerCase()}`);
  return keys;
}

/** Read a CSV text: counts, the people to send and the columns found. { error } when there is no header row. */
function readPeople(text) {
  const head = findHeader(text);
  if (!head) return { error: 'I could not find a header row with a name column. A header like "Name" or "First Name,Last Name,Email,Company" works.' };
  const data = head.rows.slice(head.at + 1).filter((row) => row.some((cell) => String(cell).trim() !== ''));
  const seen = new Set();
  const people = [];
  let named = 0;
  for (const row of data) {
    const node = personFrom(row, head.map);
    if (!node) continue;
    named += 1;
    const keys = keysOf(node);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    people.push(node);
  }
  const heads = head.rows[head.at];
  const column = (field) => (head.map[field] === undefined ? null : tidy(heads[head.map[field]]));
  const columns = {};
  for (const field of ['name', 'email', 'company', 'title', 'city', 'linkedin', 'website']) {
    const found = field === 'name' && head.map.name === undefined
      ? [column('first'), column('last')].filter(Boolean).join(' + ')
      : column(field);
    if (found) columns[field] = found;
  }
  if (head.map.name === undefined && head.map.first === undefined) delete columns.name;
  return { read: data.length, named, repeats: named - people.length, people, columns, skippedTop: head.at };
}

function expand(file) {
  return file.startsWith('~/') || file === '~' ? path.join(os.homedir(), file.slice(1)) : file;
}

async function run(ctx) {
  const { log, err } = ctx;
  const parsed = parseFlags(ctx.rawArgs || [], { value: new Set(), bare: new Set(['yes', 'dry-run', 'json']) }, 'import');
  const json = !!(parsed.flags && parsed.flags.json) || (ctx.rawArgs || []).includes('--json');
  const refuse = (message, code = 2, extra = {}) => {
    if (json) log(JSON.stringify({ ok: false, error: message, ...extra }));
    else err(message);
    return code;
  };
  if (parsed.error) return refuse(parsed.error);
  const { flags, words } = parsed;
  if (!words.length) return refuse('atris nexus import needs a CSV file, like: atris nexus import Connections.csv');
  if (words.length > 1) return refuse('atris nexus import takes one file. Put the path in quotes if it has spaces.');
  const file = words[0];
  const send = !!flags.yes && !flags['dry-run'];

  let text;
  try {
    const target = expand(file);
    const stat = fs.statSync(target);
    if (!stat.isFile()) return refuse(`${file} is not a file.`);
    if (stat.size > FILE_MOST) return refuse(`${file} is bigger than ${FILE_MOST / 1024 / 1024} MB. Nothing was sent.`);
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    return refuse(error && error.code === 'ENOENT' ? `No file at ${file}.` : `${file} could not be read. Nothing was sent.`);
  }

  const got = readPeople(text);
  if (got.error) return refuse(got.error, 1);
  const base = {
    file, rows_read: got.read, rows_with_name: got.named, would_send: got.people.length,
    repeats_in_file: got.repeats, columns: got.columns,
  };

  if (!send) {
    if (json) { log(JSON.stringify({ ok: true, dry_run: true, sent: false, ...base })); return 0; }
    log(`Read ${S.plural(got.read, 'row', 'rows')} from ${file}.`);
    log(`${got.named} ${got.named === 1 ? 'has' : 'have'} a name.`);
    log(`${S.plural(got.people.length, 'person', 'people')} would be sent${got.repeats ? ` (${S.plural(got.repeats, 'repeat', 'repeats')} within the file left out)` : ''}.`);
    log(`Columns found: ${Object.entries(got.columns).map(([field, header]) => `${field} (${header})`).join(', ')}.`);
    log(got.people.length
      ? `Dry run: nothing was sent. To send them: atris nexus import ${/\s/.test(file) ? `"${file}"` : file} --yes`
      : 'Nothing to send.');
    return 0;
  }

  if (!got.people.length) {
    if (json) log(JSON.stringify({ ok: true, dry_run: false, sent: false, ...base }));
    else log('Nothing to send: no row has a name.');
    return 0;
  }

  let token;
  try {
    ({ token } = await ctx.getToken());
  } catch (error) {
    return refuse(tidy(error && error.message), 1);
  }
  if (!token) return refuse(ctx.notLoggedIn || 'Sign in first: atris login', 1);
  const client = storeClient(ctx.request, token);

  const total = { created: 0, matched: 0, skipped: 0, conflicts: 0 };
  const reasons = {};
  let sent = 0;
  try {
    for (let i = 0; i < got.people.length; i += BATCH) {
      const chunk = got.people.slice(i, i + BATCH);
      const done = await client.post('/nexus/import', { nodes: chunk, edges: [] }, { retries: 0, timeoutMs: SEND_MS });
      sent += chunk.length;
      total.created += Number(done.created) || 0;
      total.matched += Number(done.matched) || 0;
      total.skipped += Number(done.skipped) || 0;
      total.conflicts += Array.isArray(done.conflicts) ? done.conflicts.length : 0;
      for (const [why, n] of Object.entries(done.skipped_reasons && typeof done.skipped_reasons === 'object' ? done.skipped_reasons : {})) {
        reasons[why] = (reasons[why] || 0) + (Number(n) || 0);
      }
    }
  } catch (error) {
    const partial = sent ? ` ${S.plural(sent, 'person was', 'people were')} sent before it stopped. Running the same command again is safe: no one is added twice.` : ' Nothing was sent.';
    if (error instanceof StoreLocked) return refuse(error.message, 1, { status: 402 });
    return refuse(`${error instanceof StoreError ? error.message : 'That did not send.'}${partial}`, 1, { sent });
  }

  if (json) { log(JSON.stringify({ ok: true, dry_run: false, sent: true, ...base, sent_count: sent, ...total, skipped_reasons: reasons })); return 0; }
  const parts = [`${total.created} new`, `${total.matched} already there`];
  if (total.skipped) parts.push(`${total.skipped} skipped`);
  log(`Sent ${S.plural(sent, 'person', 'people')}: ${parts.join(', ')}.`);
  const why = Object.entries(reasons).filter(([, n]) => n > 0).map(([reason, n]) => `${reason} ${n}`);
  if (why.length) log(`Skipped because: ${why.join(', ')}.`);
  if (total.conflicts) log(`${S.plural(total.conflicts, 'person', 'people')} had an email or LinkedIn already on another card and was not merged.`);
  return 0;
}

module.exports = { SUBS, HELP, run, parseCsv, mapHeader, findHeader, readPeople, personFrom };

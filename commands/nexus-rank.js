'use strict';

// atris nexus rank "<list>": a saved list in the order to work it. For each person: the tier and
// why, how many days are left, why now, who decides, whether the email was checked, the way in,
// the stage, and what is still missing. The backend ranks; this only shows.
//
// Backend (atrisos-backend routers/nexus_router.py, under /nexus):
//   GET /lists                    {lists: [{id, name, count}]}
//   GET /lists/{id}/ranked?day=YYYY-MM-DD   {list, as_of, counts: {S, A, B, none}, rows: [...]}, rows already in order;
//                                 day is the local calendar day, as_of the day the service counted from
// An older backend answers 404 for /ranked; that says so in one line.
//
// The facts behind a row are ordinary columns: hook (why now), window_ends, decider, email_status.
// Fill them with atris nexus set, window and decides. Nothing here sends anything or writes anything.

const X = require('./nexus-experiments');
const { localDay } = require('../lib/local-day');

const { clean, plural, quote } = X;
const SUBS = new Set(['rank']);
const HELP = [
  '  atris nexus rank "<list>" [--tier S|A|B|none] [--limit N]   who to work first, why now, days left, who decides and the way in',
  '  atris nexus window "<name>" <YYYY-MM-DD> --source <link>   the day their window closes (clear takes it off)',
  '  atris nexus decides "<name>" "<who>" --source <link>   who makes the call there',
];

const VALUES = new Set(['tier', 'limit']);
const SWITCHES = new Set(['json', 'help']);
const LIMIT_DEFAULT = 25;
const LIMIT_MOST = 500;
const TIERS = ['S', 'A', 'B'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NOT_LIVE = 'Ranking a list needs the newest Atris, and the service you reached does not have it yet. Nothing was changed.';
const EMAIL_WORDS = { own_site: 'seen on their site', secondhand: 'secondhand', unchecked: 'not checked', none: 'no email' };
const MISSING_WORDS = { why_now: 'why now', window: 'a date', decider: 'who decides', email_check: 'a checked email' };

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** "2026-11-23" as "Nov 23"; anything else as given. */
function dayWords(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(day));
  if (!m || !MONTHS[Number(m[2]) - 1]) return clean(day);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** How long is left in plain words. */
function daysWords(window) {
  if (!window || typeof window !== 'object' || window.days_left === null || window.days_left === undefined || !Number.isFinite(Number(window.days_left))) return 'no date';
  const n = Math.trunc(Number(window.days_left));
  if (n === 0) return 'closes today';
  if (n > 0) return `${plural(n, 'day', 'days')} left`;
  return `window closed ${plural(-n, 'day', 'days')} ago`;
}

/** The bare host of a link, without www; empty when it is not a link. */
function host(url) {
  try {
    const u = new URL(clean(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function sourced(fact) {
  if (!fact || typeof fact !== 'object' || !clean(fact.line)) return '';
  const h = host(fact.source_url);
  return `${clean(fact.line)}${h ? ` (${h})` : ''}`;
}

function wayInWords(way) {
  const w = way && typeof way === 'object' ? way : {};
  const through = Array.isArray(w.through) ? w.through.map(clean).filter(Boolean) : [];
  if (w.kind === 'first') return 'you know them';
  if (w.kind === 'intro') return through.length ? `through ${through.join(', then ')}` : 'through someone you know';
  if (w.kind === 'cold') return 'cold';
  return through.length ? `through ${through.join(', then ')}` : 'not known yet';
}

function missingWords(missing) {
  if (!Array.isArray(missing)) return [];
  return missing.map((m) => MISSING_WORDS[m] || clean(m).replace(/_/g, ' ')).filter(Boolean);
}

function tierOf(row) {
  const t = clean(row && row.tier).toUpperCase();
  return TIERS.includes(t) ? t : null;
}

/** The first line: the list, the day, how many and the counts by tier. */
function headLine(data, listName) {
  const list = data.list && typeof data.list === 'object' ? data.list : {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const people = list.people !== undefined ? num(list.people) : rows.length;
  const c = data.counts && typeof data.counts === 'object' ? data.counts : {};
  const parts = TIERS.filter((t) => num(c[t])).map((t) => `${num(c[t])} ${t}`);
  if (num(c.none)) parts.push(`${num(c.none)} need${num(c.none) === 1 ? 's' : ''} a reason`);
  const bits = [clean(list.name) || listName, plural(people, 'person', 'people')];
  if (clean(data.as_of)) bits.push(dayWords(data.as_of));
  bits.push(parts.length ? parts.join(', ') : 'no one ranked yet');
  return bits.join(' · ');
}

/** One person, a few short lines. */
function rowLines(row) {
  const tier = tierOf(row);
  const lines = [`${tier || 'No tier'} · ${daysWords(row.window)}`];
  const work = clean(row.title) && clean(row.company) ? `${clean(row.title)} at ${clean(row.company)}` : clean(row.title) || clean(row.company);
  lines.push(`  ${[clean(row.name) || 'Someone', work, clean(row.city)].filter(Boolean).join(', ')}`);
  if (clean(row.tier_why)) lines.push(`  ${clean(row.tier_why)}`);
  const why = sourced(row.why_now);
  if (why) lines.push(`  why: ${why}`);
  const decides = sourced(row.decider);
  if (decides) lines.push(`  decides: ${decides}`);
  const check = row.email && typeof row.email === 'object' ? row.email.check : null;
  lines.push(`  email: ${EMAIL_WORDS[check] || 'not checked'}`);
  lines.push(`  way in: ${wayInWords(row.way_in)}`);
  if (clean(row.stage)) lines.push(`  stage: ${clean(row.stage)}`);
  if (row.replied_waiting === true) lines.push('  replied, waiting on you');
  const missing = missingWords(row.missing);
  if (missing.length) lines.push(`  missing: ${missing.join(', ')}`);
  return lines;
}

/** The one next thing, chosen simply. */
function nextLine(rows) {
  const waiting = rows.find((r) => (tierOf(r) === 'S' || tierOf(r) === 'A') && r.replied_waiting === true);
  if (waiting) return `Next: ${clean(waiting.name)} replied and is waiting on you. Answer them first.`;
  const top = rows.find((r) => tierOf(r) === 'S');
  if (top) return `Next: work ${clean(top.name)} first, ${daysWords(top.window)}.`;
  const undated = rows.filter((r) => Array.isArray(r.missing) && r.missing.includes('window'));
  if (rows.length && undated.length * 2 > rows.length) {
    return `Next: most of this list has no date. Add one: atris nexus window ${quote(clean(undated[0].name))} <YYYY-MM-DD> --source <link>`;
  }
  if (rows.length) return `Next: work ${clean(rows[0].name)} first.`;
  return '';
}

async function run(ctx) {
  const { log, err } = ctx;
  const raw = ctx.rawArgs || [];
  const json = raw.some((a) => String(a) === '--json');
  const out = (data) => log(JSON.stringify(data));
  const fail = (message, code = 1, extra = {}) => {
    if (json) out({ ok: false, error: clean(message), ...extra });
    else err(clean(message));
    return code;
  };
  const parsed = X.parse(raw, VALUES, SWITCHES);
  if (parsed.error) return fail(parsed.error, 2);
  const { words, flags } = parsed;
  if (flags.help) { log(HELP.join('\n')); return 0; }

  // Refusals that need nothing from the service come first, so they never make a call.
  const query = clean(words.slice(1).join(' '));
  if (!query) return fail('atris nexus rank needs a list, its name or its id. See them: atris nexus lists', 2);
  let tier;
  if (flags.tier !== undefined) {
    const t = clean(flags.tier);
    tier = /^none$/i.test(t) ? 'none' : t.toUpperCase();
    if (tier !== 'none' && !TIERS.includes(tier)) return fail('--tier takes S, A, B or none.', 2);
  }
  const limit = flags.limit !== undefined ? X.whole(flags.limit, 1, LIMIT_MOST) : LIMIT_DEFAULT;
  if (limit === null) return fail(`--limit takes a whole number from 1 to ${LIMIT_MOST}.`, 2);

  let token;
  try {
    ({ token } = await ctx.getToken());
  } catch (error) {
    return fail(error && error.message);
  }
  if (!token) return fail(ctx.notLoggedIn || 'Sign in first: atris login');
  const api = X.serviceApi(ctx.request, token);

  try {
    const lists = await X.myLists(api);
    const found = X.resolveList(lists, query, { json, out, err });
    if (found.stop !== undefined) return found.stop;
    const listName = clean(found.list.name);

    let data;
    try {
      // Days left count from your own calendar day; the service runs on UTC, already tomorrow on a US evening.
      const day = localDay(ctx.now || new Date());
      data = await api.get(`/nexus/lists/${encodeURIComponent(String(found.list.id))}/ranked?day=${day}`, { soon: true });
    } catch (error) {
      if (error instanceof X.NotLive) return fail(NOT_LIVE, 1, { not_live: true });
      throw error;
    }
    if (json) { out(data); return 0; }

    const rows = (Array.isArray(data.rows) ? data.rows : []).filter((r) => r && typeof r === 'object');
    log(headLine(data, listName));
    if (!rows.length) { log(`No one is on ${listName} yet.`); return 0; }

    const chosen = tier ? rows.filter((r) => (tier === 'none' ? tierOf(r) === null : tierOf(r) === tier)) : rows;
    const shown = chosen.slice(0, limit);
    if (!shown.length) log(`No one on ${listName} is ${tier === 'none' ? 'without a tier' : `tier ${tier}`}.`);
    for (const row of shown) {
      log('');
      for (const line of rowLines(row)) log(line);
    }
    if (chosen.length > shown.length) {
      log('');
      log(`${chosen.length - shown.length} more not shown. See them with --limit ${chosen.length}.`);
    }
    const next = nextLine(rows);
    if (next) { log(''); log(next); }
    return 0;
  } catch (error) {
    return fail(error && error.message, 1, error && error.status ? { status: error.status } : {});
  }
}

module.exports = { SUBS, HELP, run, daysWords, host, headLine, rowLines, nextLine };

'use strict';

/**
 * atris business scoreboard <business>
 *
 * One board of normalized units for any business: revenue, payments, orders,
 * visitors, credits, plus custom numbers the owner records by hand. The same
 * numbers render as text here, as JSON, or as an Atris doc with live blocks.
 */

const fs = require('node:fs');
const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { detectBusinessSlug } = require('../lib/business-core');
const { NOT_LOGGED_IN, wantsHelp, wantsJson, tokenFrom, oneLine, printResult } = require('../lib/developer-api');

function showScoreboardHelp(log = console.log) {
  log('usage: atris business scoreboard [business] [--days N] [--json]');
  log('       atris business scoreboard [business] --doc [--out FILE]');
  log('       atris business scoreboard [business] add "Label" [--kind money|count|percent] [--id slug] [--target N]');
  log('       atris business scoreboard [business] set <unit> <value> [--day YYYY-MM-DD]');
  log('       atris business scoreboard [business] layout <unit,unit,...>');
  log('       atris business scoreboard [business] remove <unit>');
  log('revenue, payments, orders, visitors and credits for one business, plus your own numbers.');
  log('  --days   window for the time-boxed units (default 30)');
  log('  --doc    print the board as an Atris doc with metric, gauge and chart blocks');
  log('  --out    write the doc to a file instead of printing it');
  log('  --json   print the full board once as one json object');
  log('the business comes from the folder you are in when you leave it out.');
}

const money = (value) => (Number(value) >= 100
  ? `$${Math.round(Number(value)).toLocaleString('en-US')}`
  : `$${Number(value).toFixed(2)}`);

function formatValue(unit = {}) {
  if (unit.value === null || unit.value === undefined) return 'no data';
  if (unit.kind === 'money') return money(unit.value);
  if (unit.kind === 'percent') return `${Number(unit.value)}%`;
  return Number(unit.value).toLocaleString('en-US');
}

function periodText(unit = {}) {
  const period = String(unit.period || '');
  return period === 'now' ? 'now' : `last ${period.replace(/d$/, '')} days`;
}

/** The board as aligned lines: label, value, period, and a target when one is set. */
function scoreboardText(board = {}) {
  const units = Array.isArray(board.units) ? board.units : [];
  const name = (board.business && (board.business.name || board.business.slug)) || 'business';
  if (!units.length) return `${name}: no units on the board yet. add one: atris business scoreboard add "Leads"`;
  const width = Math.max(...units.map((u) => String(u.label || u.id).length));
  const lines = [`${name}, ${board.days || 30} day window`];
  for (const unit of units) {
    let line = `${String(unit.label || unit.id).padEnd(width)}  ${formatValue(unit).padStart(10)}  ${periodText(unit)}`;
    if (unit.target !== null && unit.target !== undefined && unit.value !== null && unit.value !== undefined) {
      line += `, target ${formatValue({ ...unit, value: unit.target })}`;
    }
    if (unit.note) line += `  (${unit.note})`;
    lines.push(line);
  }
  const custom = units.filter((u) => u.builtin === false).map((u) => u.id);
  if (custom.length) lines.push(`record one: atris business scoreboard set ${custom[0]} <value>`);
  return lines.join('\n');
}

/** Pull `--flag value` pairs out of args; returns {flags, rest}. */
function readFlags(args, names) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (names.includes(arg)) {
      flags[arg.slice(2)] = args[i + 1];
      i += 1;
    } else if (arg !== '--json' && arg !== '--doc') {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

const ACTIONS = new Set(['add', 'set', 'layout', 'remove']);

function failure(result) {
  const status = Number(result && result.status);
  if (status === 401) return NOT_LOGGED_IN;
  if (status === 403) return 'only the owner or an admin of this business can change its scoreboard';
  if (status === 404) return 'no business with that name that you can see. try: atris business list';
  return oneLine(result && (result.errorMessage || result.error)) || `HTTP ${status || '?'}`;
}

async function scoreboardCommand(args = [], deps = {}) {
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  if (wantsHelp(args)) {
    showScoreboardHelp(io.log);
    return 0;
  }
  const json = wantsJson(args);
  const fail = (error, extra = {}) => {
    printResult({ json, ok: false, error, payload: { ok: false, error, ...extra } }, io);
    return 1;
  };

  const { flags, rest } = readFlags(args, ['--days', '--out', '--kind', '--id', '--target', '--day']);
  // The business is the first word unless that word is an action, then it comes from the folder.
  let business = null;
  if (rest.length && !ACTIONS.has(rest[0])) business = rest.shift();
  business = (deps.detectBusinessSlug || detectBusinessSlug)(business);
  if (!business) return fail('say which business: atris business scoreboard sunset-ink');

  const token = tokenFrom((deps.loadCredentials || loadCredentials)());
  if (!token) return fail(NOT_LOGGED_IN);
  const request = deps.apiRequestJson || apiRequestJson;
  const base = `/business/${encodeURIComponent(business)}/scoreboard`;
  const days = flags.days ? Number(flags.days) : 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) return fail('--days takes a whole number from 1 to 365');

  try {
    const action = rest[0];
    if (action === 'add') {
      const label = rest.slice(1).join(' ').trim();
      if (!label) return fail('name the unit: atris business scoreboard add "Shirts printed"');
      const body = { label, kind: flags.kind || 'count' };
      if (flags.id) body.id = flags.id;
      if (flags.target !== undefined) {
        body.target = Number(flags.target);
        if (!Number.isFinite(body.target)) return fail('--target takes a number');
      }
      const result = await request(`${base}/units`, { method: 'POST', token, retries: 0, body });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      const unit = result.data || {};
      printResult({ json, ok: true, text: `added ${unit.label} (${unit.id}). record one: atris business scoreboard set ${unit.id} <value>`, payload: { ok: true, unit } }, io);
      return 0;
    }
    if (action === 'set') {
      const [unit, raw] = rest.slice(1);
      const value = Number(raw);
      if (!unit || raw === undefined) return fail('say the unit and the number: atris business scoreboard set shirts_printed 12');
      if (!Number.isFinite(value)) return fail('the value has to be a number');
      if (flags.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(flags.day))) return fail('write the day as YYYY-MM-DD');
      const body = flags.day ? { value, day: flags.day } : { value };
      const result = await request(`${base}/units/${encodeURIComponent(unit)}/values`, { method: 'POST', token, retries: 0, body });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      const saved = result.data || {};
      printResult({ json, ok: true, text: `${unit} is ${saved.value} for ${saved.day}`, payload: { ok: true, value: saved } }, io);
      return 0;
    }
    if (action === 'layout') {
      const units = rest.slice(1).join(',').split(',').map((s) => s.trim()).filter(Boolean);
      if (!units.length) return fail('list the units in order: atris business scoreboard layout revenue,orders,leads');
      const result = await request(`${base}/layout`, { method: 'PUT', token, body: { units } });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      const layout = (result.data || {}).layout || units;
      printResult({ json, ok: true, text: `board shows ${layout.join(', ')}`, payload: { ok: true, layout } }, io);
      return 0;
    }
    if (action === 'remove') {
      const unit = rest[1];
      if (!unit) return fail('say which unit: atris business scoreboard remove leads');
      const result = await request(`${base}/units/${encodeURIComponent(unit)}`, { method: 'DELETE', token });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      printResult({ json, ok: true, text: `removed ${unit}`, payload: { ok: true, removed: unit } }, io);
      return 0;
    }
    if (rest.length) return fail(`unknown action ${rest[0]}. try: atris business scoreboard --help`);

    if (args.includes('--doc')) {
      const result = await request(`${base}/doc?days=${days}`, { method: 'GET', token });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      const doc = result.text || (typeof result.data === 'string' ? result.data : '');
      if (flags.out) {
        (deps.writeFile || fs.writeFileSync)(flags.out, doc);
        printResult({ json, ok: true, text: `wrote ${flags.out}`, payload: { ok: true, path: flags.out } }, io);
      } else {
        io.log(doc);
      }
      return 0;
    }

    const result = await request(`${base}?days=${days}`, { method: 'GET', token });
    if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
    const board = result.data || {};
    printResult({ json, ok: true, text: scoreboardText(board), payload: { ok: true, ...board } }, io);
    return 0;
  } catch (error) {
    return fail(oneLine(error && error.message));
  }
}

module.exports = { scoreboardCommand, scoreboardText, formatValue, showScoreboardHelp };

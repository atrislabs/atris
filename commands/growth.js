'use strict';

const { spawn } = require('node:child_process');
const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, wantsHelp, wantsJson, tokenFrom, oneLine, printResult } = require('../lib/developer-api');

const PAGE_URL = 'https://atris.ai/dashboard/growth';
const NOT_FOUNDER = 'the growth room is only for the Atris team. sign in with a team account: atris login';

function showGrowthHelp() {
  console.log('usage: atris growth [--json | --open]');
  console.log('       atris growth note "what you did" [--day YYYY-MM-DD]');
  console.log('signups, people, paying, revenue, cli installs and countries, the same numbers as the growth page.');
  console.log('  --open   open the growth page in your browser');
  console.log('  --json   print the full numbers once as one json object');
  console.log('  note     save a dated note that shows on the growth charts');
}

const count = (value) => Number(value || 0).toLocaleString('en-US');

/** "up 50%" against the week before; empty when there is nothing to compare with. */
function change(now, before) {
  const a = Number(now || 0);
  const b = Number(before || 0);
  if (!b) return '';
  const percent = Math.round(((a - b) / b) * 100);
  if (percent === 0) return ', flat';
  return `, ${percent > 0 ? 'up' : 'down'} ${Math.abs(percent)}%`;
}

function shortDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(day || '');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The growth numbers as a few short lines. */
function growthText(data = {}) {
  const totals = data.totals || {};
  const lines = [
    `signups   ${count(totals.signups_today)} today, ${count(totals.signups_7d)} last 7 days${change(totals.signups_7d, totals.signups_prev_7d)}, ${count(totals.signups_30d)} last 30`,
    `people    ${count(totals.people)} total, ${count(totals.paying)} paying`,
    `revenue   $${count(Math.round(Number(totals.mrr_usd || 0)))} a month`,
  ];
  const cli = data.cli_installs;
  if (cli) lines.push(`installs  ${count(cli.last_7d)} last 7 days${change(cli.last_7d, cli.prev_7d)}`);

  const countries = Array.isArray(data.countries) ? data.countries.slice(0, 5) : [];
  lines.push(countries.length
    ? `places    ${countries.map((row) => `${row.country} ${count(row.people)}`).join(', ')}`
    : 'places    none recorded yet');

  const marks = Array.isArray(data.marks) ? data.marks.slice(0, 5) : [];
  if (marks.length) {
    lines.push(`marked    ${marks.map((mark) => (mark.people ? `${mark.label} ${count(mark.people)}` : mark.label)).join(', ')}`);
  }
  const notes = Array.isArray(data.notes) ? data.notes.slice(0, 3) : [];
  notes.forEach((note, index) => {
    lines.push(`${index === 0 ? 'notes   ' : '        '}  ${shortDay(note.day)}  ${oneLine(note.text)}`);
  });
  lines.push(`page      ${PAGE_URL}`);
  return lines.join('\n');
}

function openPage(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(opener, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The address is printed either way.
  }
}

/** Pull `note "text" [--day YYYY-MM-DD]` apart; null text means the note is missing. */
function readNote(args) {
  const rest = args.slice(1).filter((arg) => arg !== '--json');
  const at = rest.indexOf('--day');
  let day;
  if (at !== -1) {
    day = rest[at + 1];
    rest.splice(at, 2);
  }
  return { text: rest.join(' ').trim(), day };
}

function failure(result) {
  const status = Number(result && result.status);
  if (status === 401 || status === 403) return NOT_FOUNDER;
  return oneLine(result && result.error);
}

async function growthCommand(args = [], deps = {}) {
  if (wantsHelp(args)) {
    showGrowthHelp();
    return 0;
  }
  const json = wantsJson(args);
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  const fail = (error, extra = {}) => {
    printResult({ json, ok: false, error, payload: { ok: false, error, ...extra } }, io);
    return 1;
  };

  if (args.includes('--open')) {
    (deps.openPage || openPage)(PAGE_URL);
    printResult({ json, ok: true, text: PAGE_URL, payload: { ok: true, url: PAGE_URL } }, io);
    return 0;
  }

  const token = tokenFrom((deps.loadCredentials || loadCredentials)());
  if (!token) return fail(NOT_LOGGED_IN);
  const request = deps.apiRequestJson || apiRequestJson;

  try {
    if (args[0] === 'note') {
      const { text, day } = readNote(args);
      if (!text) return fail('say what you did: atris growth note "posted the launch video"');
      if (text.length > 280) return fail('keep a note under 280 characters');
      if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return fail('write the day as YYYY-MM-DD');
      const result = await request('/admin/growth/notes', {
        method: 'POST',
        token,
        retries: 0, // a retry could save the same note twice
        body: day ? { text, day } : { text },
      });
      if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
      const saved = result.data || {};
      printResult({
        json,
        ok: true,
        text: `noted for ${shortDay(saved.day || day)}: ${oneLine(saved.text || text)}`,
        payload: { ok: true, note: saved },
      }, io);
      return 0;
    }

    const result = await request('/admin/growth/overview?days=28', { method: 'GET', token });
    if (!result || !result.ok) return fail(failure(result), { status: result && result.status });
    const data = result.data || {};
    printResult({ json, ok: true, text: growthText(data), payload: { ok: true, ...data } }, io);
    return 0;
  } catch (error) {
    return fail(oneLine(error && error.message));
  }
}

module.exports = { growthCommand, growthText, showGrowthHelp };

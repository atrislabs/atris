'use strict';

// atris newsletter: readers, issues and a dry run from the terminal, over the
// backend's /api/newsletters routes. The real send is a person's action: the
// server refuses it for helpers and API keys, and this command says so plainly
// when that happens. Even for a person it needs --yes.

const fs = require('fs');
const { apiRequestJson } = require('../utils/api');
const { ensureFreshCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, tokenFrom, oneLine } = require('../lib/developer-api');

const USAGE = [
  'atris newsletter: your newsletter readers, issues and sends',
  '  atris newsletter list                              your newsletters (--business <id> for a business\'s)',
  '  atris newsletter readers add <email...> --permission [--name "<name>"] [--file readers.csv]',
  '                                                     add readers who asked to get it; --file takes one per line or CSV',
  '  atris newsletter readers list [--status active|unsubscribed|bounced] [--limit 50] [--offset 0]',
  '  atris newsletter issue new "<title>" [--body "<markdown>" | --file issue.md]',
  '  atris newsletter issue preview <issue> [--html]    exactly what a reader gets (plain text unless --html)',
  '  atris newsletter send <issue> --dry-run            who it would reach; sends nothing',
  '  atris newsletter send <issue> --yes                send it (a person\'s own login only)',
  '  every command takes --newsletter <id>; with just one newsletter it is picked for you',
  '  --json prints the server\'s answer for helpers',
];

const PERSON_ONLY = 'Sending is a person\'s action. Open the issue on atris.ai and press send, or run this from your own signed-in terminal with --yes.';
const VALUE_FLAGS = new Set(['--newsletter', '--business', '--name', '--file', '--status', '--limit', '--offset', '--body']);

function parse(args) {
  const words = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (VALUE_FLAGS.has(a)) { flags[a.slice(2)] = args[i + 1]; i += 1; continue; }
    if (a.startsWith('--')) { flags[a.slice(2)] = true; continue; }
    words.push(a);
  }
  return { words, flags };
}

async function defaultToken() {
  const creds = await ensureFreshCredentials(apiRequestJson);
  return { token: tokenFrom(creds) };
}

async function newsletterCommand(args = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const err = deps.err || ((line) => console.error(line));
  const request = deps.apiRequestJson || apiRequestJson;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const { words, flags } = parse(args);
  const json = Boolean(flags.json);

  if (!words.length || flags.help || words[0] === 'help') {
    USAGE.forEach((line) => log(line));
    return 0;
  }

  let token;
  try {
    ({ token } = await (deps.getToken || defaultToken)());
  } catch {
    token = '';
  }
  if (!token) { err(NOT_LOGGED_IN); return 1; }

  const call = async (method, pathname, body) => {
    const result = await request(pathname, { method, token, ...(body === undefined ? {} : { body }) });
    return result;
  };
  const failed = (result) => {
    err(oneLine(result && (result.data || result.error)) || 'That did not work. Try again in a moment.');
    return 1;
  };
  const show = (data, lines) => {
    if (json) log(JSON.stringify(data));
    else lines.forEach((line) => log(line));
    return 0;
  };

  const [cmd, sub] = words;

  // Checks that need no server, before any call.
  if (cmd === 'readers' && sub === 'add' && !flags.permission) {
    err('Add --permission to confirm these people asked to get this newsletter.');
    return 1;
  }
  if (cmd === 'send' && words[1] && !flags['dry-run'] && !flags.yes) {
    err('Nothing was sent. Run with --dry-run to see who it would reach, or --yes to send it.');
    return 1;
  }

  if (cmd === 'list') {
    const q = flags.business ? `?business_id=${encodeURIComponent(flags.business)}` : '';
    const result = await call('GET', `/newsletters${q}`);
    if (!result.ok) return failed(result);
    const rows = (result.data && result.data.newsletters) || [];
    return show(result.data, rows.length
      ? rows.map((n) => `${n.id}  ${n.name}${n.postal_address ? '' : '  (no mailing address yet)'}`)
      : ['No newsletters yet.']);
  }

  // Everything else acts on one newsletter.
  let newsletterId = flags.newsletter;
  if (!newsletterId) {
    const q = flags.business ? `?business_id=${encodeURIComponent(flags.business)}` : '';
    const result = await call('GET', `/newsletters${q}`);
    if (!result.ok) return failed(result);
    const rows = (result.data && result.data.newsletters) || [];
    if (rows.length !== 1) {
      err(rows.length ? 'You have more than one newsletter. Pick one with --newsletter <id> (atris newsletter list).'
        : 'No newsletter yet. Make one on atris.ai first.');
      return 1;
    }
    newsletterId = rows[0].id;
  }
  const base = `/newsletters/${encodeURIComponent(newsletterId)}`;

  if (cmd === 'readers' && sub === 'add') {
    let text = words.slice(2).join('\n');
    if (typeof flags.file === 'string') {
      try {
        text = [text, readFile(flags.file)].filter(Boolean).join('\n');
      } catch {
        err(`Could not read ${flags.file}.`);
        return 1;
      }
    }
    if (!text.trim()) { err('Give at least one email address.'); return 1; }
    const body = { text, permission: true };
    if (typeof flags.name === 'string' && words.length === 3 && !flags.file) {
      body.rows = [{ email: words[2], name: flags.name }];
      delete body.text;
    }
    const result = await call('POST', `${base}/readers/bulk`, body);
    if (!result.ok) return failed(result);
    const d = result.data || {};
    const parts = [`Added ${d.added || 0}.`];
    if (d.already_on_list) parts.push(`${d.already_on_list} already on the list.`);
    if (d.repeated_in_paste) parts.push(`${d.repeated_in_paste} repeated.`);
    if (d.invalid) parts.push(`${d.invalid} not a valid address.`);
    return show(d, [parts.join(' ')]);
  }

  if (cmd === 'readers' && sub === 'list') {
    const params = new URLSearchParams();
    if (flags.status) params.set('status', flags.status);
    if (flags.limit) params.set('limit', flags.limit);
    if (flags.offset) params.set('offset', flags.offset);
    const q = params.toString() ? `?${params}` : '';
    const result = await call('GET', `${base}/readers${q}`);
    if (!result.ok) return failed(result);
    const d = result.data || {};
    const rows = d.readers || [];
    return show(d, [
      ...rows.map((r) => `${r.email}${r.name ? `  ${r.name}` : ''}  ${r.status}${r.confirmed ? '' : ' (not confirmed)'}`),
      `${rows.length} of ${d.total || 0}`,
    ]);
  }

  if (cmd === 'issue' && sub === 'new') {
    const title = words[2];
    if (!title) { err('Give the issue a title: atris newsletter issue new "<title>"'); return 1; }
    let bodyMd = typeof flags.body === 'string' ? flags.body : '';
    if (typeof flags.file === 'string') {
      try {
        bodyMd = readFile(flags.file);
      } catch {
        err(`Could not read ${flags.file}.`);
        return 1;
      }
    }
    const result = await call('POST', `${base}/issues`, { title, body_md: bodyMd });
    if (!result.ok) return failed(result);
    const d = result.data || {};
    return show(d, [`Draft saved: ${d.id}  ${d.title}`]);
  }

  if (cmd === 'issue' && sub === 'preview') {
    const issue = words[2];
    if (!issue) { err('Which issue? atris newsletter issue preview <issue>'); return 1; }
    const result = await call('GET', `${base}/issues/${encodeURIComponent(issue)}/preview`);
    if (!result.ok) return failed(result);
    const d = result.data || {};
    const lines = [`Subject: ${d.subject}`, `From: ${d.from || '(no sending inbox set)'}`, '', flags.html ? d.html : d.text];
    (d.problems || []).forEach((p) => lines.push(`Before sending: ${p}`));
    return show(d, lines);
  }

  if (cmd === 'send') {
    const issue = words[1];
    if (!issue) { err('Which issue? atris newsletter send <issue> --dry-run'); return 1; }
    const dryRun = Boolean(flags['dry-run']);
    const result = await call('POST', `${base}/issues/${encodeURIComponent(issue)}/send`, { dry_run: dryRun });
    if (!result.ok) {
      if (Number(result.status) === 403 && !dryRun) { err(PERSON_ONLY); return 1; }
      return failed(result);
    }
    const d = result.data || {};
    const lines = [d.message || ''];
    if (dryRun) {
      (d.readers || []).slice(0, 20).forEach((r) => lines.push(`  ${r.email}`));
      if ((d.readers || []).length > 20) lines.push(`  and ${(d.readers || []).length - 20} more`);
      (d.problems || []).forEach((p) => lines.push(`Before sending: ${p}`));
    }
    return show(d, lines);
  }

  err(`Unknown: atris newsletter ${words.join(' ')}`);
  USAGE.forEach((line) => err(line));
  return 1;
}

module.exports = { newsletterCommand, PERSON_ONLY, USAGE };

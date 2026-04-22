/**
 * Errors command for Atris CLI — admin dashboard over atris_error_events.
 *
 * Usage:
 *   atris errors                      List errors from last 24h, grouped by signature
 *   atris errors --hours 72           Widen the window (max 720h / 30d)
 *   atris errors --limit 1000         Raise the raw-event cap for grouping
 *   atris errors show <id>            Full detail (stack trace, message) for one event
 *
 * Requires admin role on the user row.
 */

const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

function getToken() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return creds.token;
}

function extractFlag(args, ...names) {
  const remaining = [];
  let value = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(0, eq) : a;
    if (names.includes(key)) {
      value = eq >= 0 ? a.slice(eq + 1) : args[++i];
    } else {
      remaining.push(a);
    }
  }
  return [value, remaining];
}

async function listErrors(args) {
  const [hoursArg, r1] = extractFlag(args, '--hours', '-H');
  const [limitArg, r2] = extractFlag(r1, '--limit', '-L');
  const hours = hoursArg ? parseInt(hoursArg, 10) : 24;
  const limit = limitArg ? parseInt(limitArg, 10) : 500;

  const token = getToken();
  const result = await apiRequestJson(`/errors?hours=${hours}&limit=${limit}`, {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to fetch errors'}`);
    process.exit(1);
  }

  const data = result.data || {};
  const groups = data.groups || [];

  if (groups.length === 0) {
    console.log(`No errors in the last ${hours}h. Clean.`);
    return;
  }

  console.log(
    `Errors — last ${data.window_hours}h — ` +
      `${data.total_events} events across ${data.unique_signatures} signatures\n`,
  );

  groups.forEach((g, idx) => {
    const s = g.sample || {};
    const shortId = (s.id || '').substring(0, 8);
    const last = s.created_at ? s.created_at.substring(0, 16).replace('T', ' ') : '';
    const status = s.status_code ? ` [${s.status_code}]` : '';
    const msg = (s.message || '').replace(/\s+/g, ' ').substring(0, 140);

    console.log(`${idx + 1}. x${g.count}  ${g.signature}${status}`);
    if (last) console.log(`   last: ${last} UTC  latest id: ${shortId}`);
    if (msg) console.log(`   "${msg}"`);
    console.log('');
  });

  console.log(
    `Run \`atris errors show <id>\` for full stack trace of a specific event.`,
  );
}

async function showError(errorId) {
  if (!errorId) {
    console.error('Usage: atris errors show <id>');
    console.error('(id must be a full UUID — get one from `atris errors` output)');
    process.exit(1);
  }

  const token = getToken();
  const result = await apiRequestJson(`/errors/${encodeURIComponent(errorId)}`, {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to fetch error'}`);
    process.exit(1);
  }

  const e = result.data || {};
  console.log(`Error ${e.id || errorId}`);
  console.log(`  type:    ${e.error_type || '?'}`);
  console.log(`  method:  ${e.request_method || '?'}`);
  console.log(`  path:    ${e.request_path || '?'}`);
  console.log(`  status:  ${e.status_code || '?'}`);
  console.log(`  when:    ${e.created_at || '?'}`);
  console.log(`  source:  ${e.source || '?'}`);
  if (e.user_id) console.log(`  user:    ${e.user_id}`);
  console.log('');
  console.log('Message:');
  console.log('  ' + (e.message || '(none)').split('\n').join('\n  '));
  console.log('');
  if (e.stack_trace) {
    console.log('Stack trace:');
    console.log('  ' + e.stack_trace.split('\n').join('\n  '));
  }
}

function printHelp() {
  console.log('');
  console.log('Usage:');
  console.log('  atris errors                         List errors from last 24h, grouped');
  console.log('  atris errors --hours 72              Widen the window (max 720h / 30d)');
  console.log('  atris errors --limit 1000            Raise the raw-event cap');
  console.log('  atris errors show <full-uuid>        Full detail for one event');
  console.log('');
  console.log('Admin role required.');
  console.log('');
}

async function errorsCommand() {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }

  if (sub === 'show') {
    await showError(args[1]);
    return;
  }

  await listErrors(args);
}

module.exports = { errorsCommand };

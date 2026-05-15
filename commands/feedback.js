/**
 * Feedback command for Atris CLI
 *
 * Usage:
 *   atris feedback "message here"              Submit feedback
 *   atris feedback submit "message here"       Submit feedback
 *   atris feedback                              List feedback
 *   atris feedback list                         List feedback
 *   atris feedback resolve <id> "<resolution>"  Mark resolved (admin)
 *   atris feedback close <id>                   Close as wontfix (admin)
 *   atris feedback delete <id>                  Delete feedback (admin)
 *
 * IDs may be the first 8 chars of the UUID — the CLI resolves the prefix
 * against the live list before making the write request.
 */

const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

const KNOWN_FEEDBACK_COMMANDS = new Set([
  'list',
  'submit',
  'resolve',
  'close',
  'delete',
  'help',
  '--help',
  '-h',
]);

function getAuth() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return { token: creds.token, email: creds.email || 'unknown' };
}

async function submitFeedback(message, opts = {}) {
  if (!message) {
    console.error('Usage: atris feedback "your message here" [--business <slug|id>]');
    process.exit(1);
  }

  const { token } = getAuth();
  // Only attach business_id when the user explicitly asked for it via --business.
  // Auto-scoping to "first business in businesses.json" silently hid feedback
  // from every other workspace the user belongs to.
  const businessId = opts.businessId || null;

  const body = {
    message,
    source: 'cli',
  };
  if (businessId) {
    body.business_id = businessId;
  }

  const result = await apiRequestJson('/feedback', {
    method: 'POST',
    token,
    body,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to submit feedback'}`);
    process.exit(1);
  }

  console.log('Feedback submitted.');
  if (result.data?.feedback_id) {
    console.log(`  ID: ${result.data.feedback_id}`);
  }
}

async function fetchFeedbackItems({ token, businessId, limit = 100, status = null } = {}) {
  let url = `/feedback?limit=${limit}`;
  if (businessId) url += `&business_id=${businessId}`;
  if (status) url += `&status=${encodeURIComponent(status)}`;

  const result = await apiRequestJson(url, { method: 'GET', token });
  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to fetch feedback'}`);
    process.exit(1);
  }
  return result.data?.feedback || [];
}

async function listFeedback() {
  const { token } = getAuth();
  // Do NOT auto-scope by business: admins expect to see the full queue.
  // The API already scopes non-admins to their own businesses server-side.
  const items = await fetchFeedbackItems({ token, limit: 20 });

  if (items.length === 0) {
    console.log('No feedback found.');
    return;
  }

  console.log(`Feedback Queue (${items.length} item${items.length !== 1 ? 's' : ''})\n`);

  items.forEach((item, idx) => {
    const status = (item.status || 'open').toUpperCase();
    const shortId = (item.id || '').substring(0, 8);
    const msg = item.message || '';
    const preview = msg.length > 120 ? msg.substring(0, 120) + '...' : msg;
    const date = item.created_at
      ? new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
    const fromEmail = item.context?.user_email || item.user_id || '';

    console.log(`${idx + 1}. [${status}] id:${shortId}${date ? '  ' + date : ''}`);
    console.log(`   "${preview}"`);
    if (fromEmail) console.log(`   from: ${fromEmail}`);
    if (item.resolution) console.log(`   resolution: ${item.resolution}`);
    console.log('');
  });
}

/**
 * Resolve a short ID prefix (or full UUID) to the full UUID by scanning
 * the list endpoint. Returns null if no unique match found.
 */
async function resolveIdPrefix(prefix, { token, businessId }) {
  if (!prefix) return { error: 'ID required' };
  // If it looks like a full UUID, trust it
  if (prefix.length >= 32) return { id: prefix };

  const items = await fetchFeedbackItems({ token, businessId, limit: 200 });
  const matches = items.filter(it => (it.id || '').startsWith(prefix));

  if (matches.length === 0) return { error: `No feedback matches id prefix "${prefix}"` };
  if (matches.length > 1) {
    return {
      error: `Ambiguous id "${prefix}" — matches ${matches.length} items. Use a longer prefix.`,
    };
  }
  return { id: matches[0].id, item: matches[0] };
}

async function resolveFeedback(idPrefix, resolution) {
  if (!idPrefix || !resolution) {
    console.error('Usage: atris feedback resolve <id> "<resolution>"');
    process.exit(1);
  }
  const { token } = getAuth();

  const lookup = await resolveIdPrefix(idPrefix, { token });
  if (lookup.error) {
    console.error(`Error: ${lookup.error}`);
    process.exit(1);
  }

  const result = await apiRequestJson(`/feedback/${lookup.id}`, {
    method: 'PATCH',
    token,
    body: { status: 'resolved', resolution },
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to resolve feedback'}`);
    process.exit(1);
  }
  console.log(`Resolved ${lookup.id.substring(0, 8)}: ${resolution}`);
}

async function closeFeedback(idPrefix) {
  if (!idPrefix) {
    console.error('Usage: atris feedback close <id>');
    process.exit(1);
  }
  const { token } = getAuth();

  const lookup = await resolveIdPrefix(idPrefix, { token });
  if (lookup.error) {
    console.error(`Error: ${lookup.error}`);
    process.exit(1);
  }

  const result = await apiRequestJson(`/feedback/${lookup.id}`, {
    method: 'PATCH',
    token,
    body: { status: 'closed' },
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to close feedback'}`);
    process.exit(1);
  }
  console.log(`Closed ${lookup.id.substring(0, 8)}`);
}

async function deleteFeedback(idPrefix) {
  if (!idPrefix) {
    console.error('Usage: atris feedback delete <id>');
    process.exit(1);
  }
  const { token } = getAuth();

  const lookup = await resolveIdPrefix(idPrefix, { token });
  if (lookup.error) {
    console.error(`Error: ${lookup.error}`);
    process.exit(1);
  }

  const result = await apiRequestJson(`/feedback/${lookup.id}`, {
    method: 'DELETE',
    token,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to delete feedback'}`);
    process.exit(1);
  }
  console.log(`Deleted ${lookup.id.substring(0, 8)}`);
}

function printHelp(write = console.log) {
  write('');
  write('Usage:');
  write('  atris feedback "message"               Submit quoted feedback (global)');
  write('  atris feedback submit "message"        Submit feedback (global)');
  write('  atris feedback submit "msg" --business <slug>');
  write('  atris feedback                         List feedback');
  write('  atris feedback list                    List feedback');
  write('  atris feedback resolve <id> "<note>"   Mark resolved (admin)');
  write('  atris feedback close <id>              Close as wontfix (admin)');
  write('  atris feedback delete <id>             Delete feedback (admin)');
  write('');
  write('IDs may be the first 8 chars of the UUID.');
  write('Business slugs come from ~/.atris/businesses.json (e.g. acme, atris-labs).');
  write('');
}

function resolveBusinessArg(value) {
  if (!value) return null;
  // Full UUID — trust it
  if (/^[0-9a-f-]{32,}$/i.test(value)) return value;
  // Otherwise treat as slug and look up in ~/.atris/businesses.json
  const home = require('os').homedir();
  const file = path.join(home, '.atris', 'businesses.json');
  if (!fs.existsSync(file)) return null;
  try {
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hit = map[value] || Object.values(map).find(b => b.slug === value);
    return hit ? hit.business_id : null;
  } catch {
    return null;
  }
}

function extractFlag(args, ...names) {
  // Returns [value, remainingArgs]. Supports "--flag val" and "--flag=val".
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

function directFeedbackMessage(args) {
  if (args.length !== 1) return null;
  const message = String(args[0] || '').trim();
  if (!message || KNOWN_FEEDBACK_COMMANDS.has(message)) return null;
  // The direct form is intentionally only for quoted prose. Otherwise tokens
  // like "show <id>" or "bogus-subcommand" look like commands and must fail.
  return /\s/.test(message) ? message : null;
}

function rejectUnknownFeedbackCommand(subcommand) {
  console.error(`Unknown feedback command: ${subcommand || '(empty)'}`);
  printHelp(console.error);
  process.exit(1);
}

async function feedbackCommand() {
  const rawArgs = process.argv.slice(3);
  const [businessArg, args] = extractFlag(rawArgs, '--business', '-b');
  const businessId = resolveBusinessArg(businessArg);
  if (businessArg && !businessId) {
    console.error(`Error: unknown business "${businessArg}". Check ~/.atris/businesses.json`);
    process.exit(1);
  }

  const subcommand = args[0];

  if (!subcommand || subcommand === 'list') {
    await listFeedback();
    return;
  }

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printHelp();
    return;
  }

  if (subcommand === 'submit') {
    const message = args.slice(1).join(' ');
    await submitFeedback(message, { businessId });
    return;
  }

  if (subcommand === 'resolve') {
    const id = args[1];
    const resolution = args.slice(2).join(' ');
    await resolveFeedback(id, resolution);
    return;
  }

  if (subcommand === 'close') {
    await closeFeedback(args[1]);
    return;
  }

  if (subcommand === 'delete') {
    await deleteFeedback(args[1]);
    return;
  }

  const message = directFeedbackMessage(args);
  if (message) {
    await submitFeedback(message, { businessId });
    return;
  }

  rejectUnknownFeedbackCommand(subcommand);
}

module.exports = { feedbackCommand };

/**
 * Feedback command for Atris CLI
 *
 * Usage:
 *   atris feedback "message here"              Submit feedback
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

function getAuth() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return { token: creds.token, email: creds.email || 'unknown' };
}

function getBusinessId() {
  // 1. Check .atris/business.json in current directory
  const bizFile = path.join(process.cwd(), '.atris', 'business.json');
  if (fs.existsSync(bizFile)) {
    try {
      const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
      if (biz.business_id) return biz.business_id;
    } catch {}
  }

  // 2. Check ~/.atris/businesses.json (first connected business)
  const home = require('os').homedir();
  const globalBizFile = path.join(home, '.atris', 'businesses.json');
  if (fs.existsSync(globalBizFile)) {
    try {
      const businesses = JSON.parse(fs.readFileSync(globalBizFile, 'utf8'));
      const slugs = Object.keys(businesses);
      if (slugs.length > 0 && businesses[slugs[0]].business_id) {
        return businesses[slugs[0]].business_id;
      }
    } catch {}
  }

  return null;
}

async function submitFeedback(message) {
  if (!message) {
    console.error('Usage: atris feedback "your message here"');
    process.exit(1);
  }

  const { token } = getAuth();
  const businessId = getBusinessId();

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

function printHelp() {
  console.log('');
  console.log('Usage:');
  console.log('  atris feedback "message"               Submit feedback');
  console.log('  atris feedback                         List feedback');
  console.log('  atris feedback list                    List feedback');
  console.log('  atris feedback resolve <id> "<note>"   Mark resolved (admin)');
  console.log('  atris feedback close <id>              Close as wontfix (admin)');
  console.log('  atris feedback delete <id>             Delete feedback (admin)');
  console.log('');
  console.log('IDs may be the first 8 chars of the UUID.');
  console.log('');
}

async function feedbackCommand() {
  const subcommand = process.argv[3];

  if (!subcommand || subcommand === 'list') {
    await listFeedback();
    return;
  }

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printHelp();
    return;
  }

  if (subcommand === 'resolve') {
    const id = process.argv[4];
    const resolution = process.argv.slice(5).join(' ');
    await resolveFeedback(id, resolution);
    return;
  }

  if (subcommand === 'close') {
    await closeFeedback(process.argv[4]);
    return;
  }

  if (subcommand === 'delete') {
    await deleteFeedback(process.argv[4]);
    return;
  }

  // Everything else is a feedback message
  const message = process.argv.slice(3).join(' ');
  await submitFeedback(message);
}

module.exports = { feedbackCommand };

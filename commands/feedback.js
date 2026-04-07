/**
 * Feedback command for Atris CLI
 *
 * Usage:
 *   atris feedback "message here"  - Submit feedback
 *   atris feedback                 - List your feedback
 *   atris feedback list            - List your feedback
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

async function listFeedback() {
  const { token } = getAuth();
  const businessId = getBusinessId();

  let url = '/feedback?limit=20';
  if (businessId) {
    url += `&business_id=${businessId}`;
  }

  const result = await apiRequestJson(url, {
    method: 'GET',
    token,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error || 'Failed to fetch feedback'}`);
    process.exit(1);
  }

  const items = result.data?.feedback || [];

  if (items.length === 0) {
    console.log('No feedback found.');
    return;
  }

  console.log(`${items.length} feedback item${items.length !== 1 ? 's' : ''}:\n`);

  for (const item of items) {
    const date = item.created_at
      ? new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    const status = item.status || 'open';
    const msg = item.message || '';
    const preview = msg.length > 80 ? msg.substring(0, 80) + '...' : msg;

    console.log(`  [${status}] ${preview}`);
    if (date || item.id) {
      const parts = [];
      if (date) parts.push(date);
      if (item.id) parts.push(item.id.substring(0, 8));
      console.log(`         ${parts.join('  ')}`);
    }
    console.log('');
  }
}

async function feedbackCommand() {
  const subcommand = process.argv[3];

  if (!subcommand || subcommand === 'list') {
    await listFeedback();
  } else if (subcommand === '--help' || subcommand === '-h') {
    console.log('');
    console.log('Usage:');
    console.log('  atris feedback "message"   Submit feedback');
    console.log('  atris feedback             List your feedback');
    console.log('  atris feedback list        List your feedback');
    console.log('');
  } else {
    // Everything else is a feedback message
    const message = process.argv.slice(3).join(' ');
    await submitFeedback(message);
  }
}

module.exports = { feedbackCommand };

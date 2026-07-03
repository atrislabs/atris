'use strict';

// Feed: the business group feed from the terminal — read receipts, post receipts.
// Auth: existing atris login. Business: nearest .atris/business.json above cwd.

const fs = require('fs');
const path = require('path');
const { ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

function showHelp() {
  console.log('');
  console.log('Usage: atris feed [list] [n] [--author <name>] [--since <7d|24h>] [--full] [--json]');
  console.log('       atris feed post "<content>"');
  console.log('');
  console.log('Description:');
  console.log('  Read and write the business group feed (the same feed as the web GM dashboard).');
  console.log('  Posts should be receipts and state changes only: what shipped, what blocked, what changed.');
  console.log('');
  console.log('Options:');
  console.log('  --author <name>   Only posts whose author matches (name, email prefix, or id prefix).');
  console.log('  --since <window>  Only posts newer than e.g. 7d, 48h.');
  console.log('  --full            Print full post bodies instead of one line each.');
  console.log('  --json            Machine-readable output.');
  console.log('  --help, -h        Show this help.');
  console.log('');
}

function findBusiness(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const file = path.join(dir, '.atris', 'business.json');
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed.business_id) return { businessId: parsed.business_id, name: parsed.name || parsed.slug, root: dir };
      } catch { /* fall through to parent dirs */ }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function loadAuthorAliases(workspaceRoot) {
  const file = path.join(workspaceRoot, '.atris', 'feed_authors.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function parseSince(raw) {
  const match = /^(\d+)([dh])$/.exec(String(raw || '').trim());
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const ms = match[2] === 'd' ? amount * 24 * 3600 * 1000 : amount * 3600 * 1000;
  return Date.now() - ms;
}

function authorLabel(post, aliases, selfId, selfEmail) {
  if (post.post_type === 'agent_post') return post.agent_name || post.author_display_name || 'agent';
  if (post.author_display_name) return post.author_display_name;
  const id = post.author_id || '';
  if (aliases[id]) return aliases[id];
  if (selfId && id === selfId) return (selfEmail || 'me').split('@')[0];
  return id ? id.slice(0, 8) : '?';
}

async function fetchPosts(businessId, token, want) {
  const pageSize = 100;
  let all = [];
  for (let offset = 0; all.length < want; offset += pageSize) {
    const res = await apiRequestJson(
      `/business/${businessId}/feed?limit=${pageSize}&offset=${offset}`,
      { token, timeoutMs: 20000 }
    );
    if (res.statusCode && res.statusCode >= 400) {
      throw new Error(`Feed fetch failed (${res.statusCode}): ${JSON.stringify(res.data)}`);
    }
    const page = Array.isArray(res.data?.posts) ? res.data.posts : Array.isArray(res.data) ? res.data : [];
    all = all.concat(page);
    if (page.length < pageSize) break;
  }
  return all;
}

async function feedCommand(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return 0;
  }

  const business = findBusiness(process.cwd());
  if (!business) {
    console.error('✗ No .atris/business.json found above this directory. Run from a bound workspace.');
    return 1;
  }

  const auth = await ensureValidCredentials(apiRequestJson);
  if (auth.error || !auth.credentials?.token) {
    console.error(`✗ Not logged in (${auth.error || 'no token'}). Run: atris login`);
    return 1;
  }
  const token = auth.credentials.token;
  const selfId = auth.credentials.user_id || auth.user?.id || null;
  const selfEmail = auth.credentials.email || auth.user?.email || null;

  const positional = args.filter((a) => !a.startsWith('--'));
  const sub = positional[0] || 'list';

  if (sub === 'post') {
    const content = positional.slice(1).join(' ').trim();
    if (!content) {
      console.error('✗ Nothing to post. Usage: atris feed post "<content>"');
      return 1;
    }
    const res = await apiRequestJson(`/business/${business.businessId}/feed`, {
      method: 'POST',
      token,
      body: { content: content.slice(0, 10000) },
      timeoutMs: 20000,
    });
    if (!res.data?.id) {
      console.error(`✗ Post failed: ${JSON.stringify(res.data)}`);
      return 1;
    }
    console.log(`✓ Posted to ${business.name || 'business'} feed (${res.data.id})`);
    return 0;
  }

  if (sub !== 'list') {
    console.error(`✗ Unknown subcommand: ${sub}`);
    showHelp();
    return 1;
  }

  const countArg = parseInt(positional[1], 10);
  const count = Number.isFinite(countArg) ? Math.max(1, Math.min(300, countArg)) : 15;
  const authorFlag = args.includes('--author') ? String(args[args.indexOf('--author') + 1] || '').toLowerCase() : null;
  const sinceFlag = args.includes('--since') ? parseSince(args[args.indexOf('--since') + 1]) : null;
  if (args.includes('--since') && sinceFlag === null) {
    console.error('✗ Bad --since window. Use forms like 7d or 48h.');
    return 1;
  }
  const full = args.includes('--full');
  const json = args.includes('--json');

  const aliases = loadAuthorAliases(business.root);
  // Over-fetch when filtering so the filtered result can still reach `count`.
  const fetchWant = authorFlag || sinceFlag ? 300 : count;
  let posts = await fetchPosts(business.businessId, token, fetchWant);

  if (sinceFlag) posts = posts.filter((p) => Date.parse(p.created_at) >= sinceFlag);
  if (authorFlag) {
    posts = posts.filter((p) => {
      const label = authorLabel(p, aliases, selfId, selfEmail).toLowerCase();
      return label.includes(authorFlag) || String(p.author_id || '').startsWith(authorFlag);
    });
  }
  posts = posts.slice(0, count);

  if (json) {
    console.log(JSON.stringify(posts.map((p) => ({
      id: p.id,
      author: authorLabel(p, aliases, selfId, selfEmail),
      type: p.post_type,
      created_at: p.created_at,
      content: p.content,
    })), null, 2));
    return 0;
  }

  if (!posts.length) {
    console.log('No posts matched.');
    return 0;
  }

  for (const p of posts) {
    const when = String(p.created_at || '').slice(0, 16).replace('T', ' ');
    const who = authorLabel(p, aliases, selfId, selfEmail);
    if (full) {
      console.log(`─── ${who} — ${when}`);
      console.log(String(p.content || '').trim());
      console.log('');
    } else {
      const oneLine = String(p.content || '').replace(/\s+/g, ' ').slice(0, 120);
      console.log(`[${when}] ${who}: ${oneLine}`);
    }
  }
  return 0;
}

module.exports = { feedCommand };

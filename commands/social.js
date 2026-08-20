/**
 * Social commands for Atris CLI — find people, add friends, send messages.
 *
 * Usage:
 *   atris social                       My social overview (stats, unread, suggestions)
 *   atris people <query>               Search for people on Atris
 *   atris follow <who>                 Follow someone (username, email, or name)
 *   atris unfollow <who>               Unfollow someone
 *   atris friends                      Mutual follows (your friends)
 *   atris friends followers            People who follow you
 *   atris friends following            People you follow
 *   atris msg <who> <text...>          Send a direct message
 *   atris msg <who>                    Read the conversation (marks it read)
 *   atris inbox                        Your conversations, unread first
 *   atris invite                       Create an invite link to share
 *
 * <who> resolution: exact UUID passes through; anything else is searched and
 * matched by username, then email, then name. Ambiguous matches list the
 * candidates instead of guessing.
 */

const { loadCredentials } = require('../utils/auth');
const { apiRequestJson, getAppBaseUrl } = require('../utils/api');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getToken() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return creds.token;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function apiErrorMessage(res, fallback) {
  const detail = res && res.data && (res.data.detail || res.data.error);
  if (typeof detail === 'string') return detail;
  if (detail && detail.error && detail.error.message) return detail.error.message;
  if (detail && detail.message) return detail.message;
  return fallback;
}

async function api(pathname, options = {}) {
  const token = getToken();
  const res = await apiRequestJson(pathname, { ...options, token });
  if (res.status === 401) {
    fail('Session expired. Run: atris login');
  }
  return res;
}

function displayName(user) {
  const name = user.name || user.display_name || null;
  const handle = user.username ? `@${user.username}` : null;
  if (name && handle) return `${name} (${handle})`;
  return name || handle || user.email || user.id;
}

function userLine(user) {
  const marks = [];
  if (user.is_mutual) marks.push('friends');
  else if (user.is_following) marks.push('following');
  const suffix = marks.length ? `  · ${marks.join(', ')}` : '';
  const bio = user.bio ? `\n      ${String(user.bio).slice(0, 100)}` : '';
  return `  ${displayName(user)}${suffix}${bio}`;
}

async function searchUsers(query) {
  const res = await api(`/social/search?q=${encodeURIComponent(query)}`);
  if (res.status !== 200) {
    fail(apiErrorMessage(res, `Search failed (${res.status})`));
  }
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Turn a username/email/name/UUID into a single user object (or exit with
 * candidates listed). Never guesses between multiple plausible people.
 */
async function resolveUser(who) {
  if (UUID_RE.test(who)) {
    return { id: who };
  }
  const query = who.replace(/^@/, '');
  const results = await searchUsers(query);
  if (results.length === 0) {
    fail(`No one found matching "${who}". Try: atris people <name>`);
  }
  const q = query.toLowerCase();
  const exact = results.filter(
    (u) =>
      (u.username && u.username.toLowerCase() === q) ||
      (u.email && u.email.toLowerCase() === q) ||
      (u.name && u.name.toLowerCase() === q)
  );
  const pool = exact.length > 0 ? exact : results;
  if (pool.length === 1) return pool[0];
  console.error(`"${who}" matches ${pool.length} people:`);
  for (const u of pool.slice(0, 8)) console.error(userLine(u));
  fail('Be more specific (use the @username).');
}

async function overview() {
  const [stats, unread, suggested] = await Promise.all([
    api('/social/stats'),
    api('/dm/unread'),
    api('/social/suggested?limit=5'),
  ]);

  if (stats.status === 200) {
    const s = stats.data || {};
    console.log(`Followers ${s.followers_count ?? s.followers ?? 0} · Following ${s.following_count ?? s.following ?? 0} · Friends ${s.mutuals_count ?? s.mutuals ?? '-'}`);
  }
  if (unread.status === 200 && unread.data) {
    const n = unread.data.total_unread || 0;
    console.log(n > 0 ? `Unread messages: ${n}  → atris inbox` : 'No unread messages');
  }
  const sugg = suggested.status === 200 && Array.isArray(suggested.data) ? suggested.data : [];
  if (sugg.length > 0) {
    console.log('\nPeople you may know:');
    for (const u of sugg) console.log(userLine(u));
    console.log('\nAdd one: atris follow <name>');
  }
  console.log('\nInvite a friend: atris invite');
}

async function people(query) {
  if (!query) fail('Usage: atris people <name or email>');
  const results = await searchUsers(query);
  if (results.length === 0) {
    console.log(`No one found for "${query}". Invite them: atris invite`);
    return;
  }
  console.log(`Found ${results.length}:`);
  for (const u of results) console.log(userLine(u));
}

async function follow(who, remove = false) {
  if (!who) fail(`Usage: atris ${remove ? 'unfollow' : 'follow'} <who>`);
  const user = await resolveUser(who);
  const res = await api(`/social/follow/${user.id}`, { method: remove ? 'DELETE' : 'POST' });
  if (res.status >= 400) {
    fail(apiErrorMessage(res, `Request failed (${res.status})`));
  }
  const label = displayName(user);
  if (remove) {
    console.log(`Unfollowed ${label}.`);
    return;
  }
  const check = await api(`/social/check/${user.id}`);
  const mutual = check.status === 200 && check.data && check.data.is_mutual;
  console.log(mutual
    ? `You and ${label} are now friends (you follow each other).`
    : `Now following ${label}. When they follow back, you're friends.`);
}

async function friends(kind) {
  const path =
    kind === 'followers' ? '/social/followers'
      : kind === 'following' ? '/social/following'
        : '/social/mutuals';
  const res = await api(path);
  if (res.status !== 200) fail(apiErrorMessage(res, `Request failed (${res.status})`));
  const list = Array.isArray(res.data) ? res.data : [];
  const label =
    kind === 'followers' ? 'Followers' : kind === 'following' ? 'Following' : 'Friends';
  if (list.length === 0) {
    console.log(kind
      ? `${label}: none yet.`
      : 'No friends yet. Find people: atris people <name> · Invite: atris invite');
    return;
  }
  console.log(`${label} (${list.length}):`);
  for (const u of list) console.log(userLine(u));
}

async function getConversationWith(who) {
  const user = await resolveUser(who);
  if (!UUID_RE.test(user.id)) fail('Could not resolve that user.');
  const res = await api('/dm/conversations', {
    method: 'POST',
    body: { user_id: user.id },
  });
  if (res.status >= 400) {
    fail(apiErrorMessage(res, `Could not open conversation (${res.status})`));
  }
  return { conversation: res.data, user };
}

async function message(who, text) {
  if (!who) fail('Usage: atris msg <who> [message]');
  const { conversation } = await getConversationWith(who);
  const other = displayName(conversation.other_user || {});

  if (!text) {
    const msgs = await api(`/dm/conversations/${conversation.id}/messages?limit=30`);
    if (msgs.status !== 200) fail(apiErrorMessage(msgs, 'Could not load messages'));
    const list = (msgs.data && msgs.data.messages) || [];
    if (list.length === 0) {
      console.log(`No messages with ${other} yet. Send one: atris msg ${who} "hello"`);
      return;
    }
    console.log(`Conversation with ${other}:\n`);
    for (const m of list) {
      const when = new Date(m.created_at).toLocaleString();
      console.log(`  ${m.is_mine ? 'you' : other} · ${when}`);
      console.log(`  ${m.content}\n`);
    }
    await api(`/dm/conversations/${conversation.id}/read`, { method: 'POST' });
    return;
  }

  const res = await api(`/dm/conversations/${conversation.id}/messages`, {
    method: 'POST',
    body: { content: text, content_type: 'text' },
  });
  if (res.status >= 400) fail(apiErrorMessage(res, `Send failed (${res.status})`));
  console.log(`Sent to ${other}.`);
}

async function inbox() {
  const res = await api('/dm/conversations');
  if (res.status !== 200) fail(apiErrorMessage(res, `Request failed (${res.status})`));
  const convs = (res.data && res.data.conversations) || [];
  if (convs.length === 0) {
    console.log('No conversations yet. Start one: atris msg <who> "hello"');
    return;
  }
  convs.sort((a, b) => (b.unread_count || 0) - (a.unread_count || 0));
  console.log(`Conversations (${convs.length}):\n`);
  for (const c of convs) {
    const other = displayName(c.other_user || {});
    const unread = c.unread_count > 0 ? `  · ${c.unread_count} unread` : '';
    const preview = c.last_message_preview ? `\n      ${c.last_message_preview.slice(0, 80)}` : '';
    console.log(`  ${other}${unread}${preview}`);
  }
  console.log('\nRead one: atris msg <who>');
}

async function invite() {
  const res = await api('/invites', {
    method: 'POST',
    body: { resource_type: 'atris_plain' },
  });
  if (res.status >= 400) fail(apiErrorMessage(res, `Could not create invite (${res.status})`));
  const data = res.data || {};
  const url = data.share_url || `${getAppBaseUrl()}/invite/${data.invite_code}`;
  console.log('Invite link (share it with anyone):\n');
  console.log(`  ${url}\n`);
  console.log('When they sign up through it, find them with: atris people <their name>');
}

function printHelp() {
  console.log(`atris social — people, friends, and messages on Atris

  atris social                 Your overview
  atris people <query>         Find people
  atris follow <who>           Add a friend (follow)
  atris unfollow <who>         Unfollow
  atris friends                Your friends (mutual follows)
  atris friends followers      Who follows you
  atris friends following      Who you follow
  atris msg <who> <text>       Send a message
  atris msg <who>              Read the conversation
  atris inbox                  All conversations
  atris invite                 Create a signup link to share`);
}

async function socialCommand(argv) {
  const args = argv || process.argv.slice(3);
  const sub = args[0];
  switch (sub) {
    case undefined:
      return overview();
    case 'help':
    case '--help':
    case '-h':
      return printHelp();
    case 'find':
    case 'people':
    case 'search':
      return people(args.slice(1).join(' '));
    case 'add':
    case 'follow':
      return follow(args.slice(1).join(' '));
    case 'remove':
    case 'unfollow':
      return follow(args.slice(1).join(' '), true);
    case 'friends':
      return friends(args[1]);
    case 'followers':
    case 'following':
      return friends(sub);
    case 'msg':
    case 'message':
    case 'dm':
      return message(args[1], args.slice(2).join(' '));
    case 'inbox':
      return inbox();
    case 'invite':
      return invite();
    default:
      printHelp();
      process.exit(1);
  }
}

// Top-level aliases: `atris people x`, `atris follow x`, `atris msg x hi`, ...
async function peopleCommand() { return people(process.argv.slice(3).join(' ')); }
async function followCommand() { return follow(process.argv.slice(3).join(' ')); }
async function unfollowCommand() { return follow(process.argv.slice(3).join(' '), true); }
async function friendsCommand() { return friends(process.argv[3]); }
async function msgCommand() { return message(process.argv[3], process.argv.slice(4).join(' ')); }
async function inboxCommand() { return inbox(); }
async function inviteCommand() { return invite(); }

module.exports = {
  socialCommand,
  peopleCommand,
  followCommand,
  unfollowCommand,
  friendsCommand,
  msgCommand,
  inboxCommand,
  inviteCommand,
};

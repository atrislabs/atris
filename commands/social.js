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
const { isHelpToken, argsWantHelp } = require('../lib/noninteractive');

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

function showUsageAndExit(usage) {
  console.error(usage);
  process.exit(2);
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
  if (!query || isHelpToken(query)) {
    showUsageAndExit('Usage: atris people <name or email>');
  }
  const results = await searchUsers(query);
  if (results.length === 0) {
    console.log(`No one found for "${query}". Invite them: atris invite`);
    return;
  }
  console.log(`Found ${results.length}:`);
  for (const u of results) console.log(userLine(u));
}

async function follow(who, remove = false) {
  if (!who || isHelpToken(who)) {
    showUsageAndExit(`Usage: atris ${remove ? 'unfollow' : 'follow'} <who>`);
  }
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
  if (isHelpToken(kind)) {
    showUsageAndExit('Usage: atris friends [followers|following]');
  }
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
  if (!who || isHelpToken(who) || isHelpToken(text)) {
    showUsageAndExit('Usage: atris msg <who> [message]');
  }
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

function parseInviteFlags(args) {
  const flags = {};
  const rest = [];
  const known = {
    '--for': 'name', '--email': 'email', '--company': 'company', '--business': 'company',
    '--role': 'role', '--why': 'why', '--use': 'use', '--agent': 'agent', '--pack': 'pack',
    '--days': 'days',
  };
  for (let i = 0; i < args.length; i++) {
    const key = known[args[i]];
    if (key) {
      flags[key] = args[i + 1] || '';
      i++;
    } else if (args[i] === '--any-email') {
      flags.anyEmail = true;
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

async function pickSourceAgent(nameFilter) {
  const res = await api('/agent/my-agents');
  const agents = (res.data && res.data.my_agents) || [];
  if (agents.length === 0) {
    fail('You have no agents to clone for a personalized invite. Create one first, or drop the personal flags for a plain link.');
  }
  if (nameFilter) {
    const q = nameFilter.toLowerCase();
    const match = agents.find((a) => (a.name || '').toLowerCase() === q)
      || agents.find((a) => (a.name || '').toLowerCase().includes(q))
      || (UUID_RE.test(nameFilter) ? { id: nameFilter, name: nameFilter } : null);
    if (!match) {
      console.error(`No agent matching "${nameFilter}". Your agents:`);
      for (const a of agents) console.error(`  ${a.name}`);
      process.exit(1);
    }
    return match;
  }
  return agents[0];
}

async function inviteWizard() {
  const { promptUser } = require('../utils/auth');
  console.log('Personalized invite. Enter to skip any question.\n');
  const flags = {};
  flags.name = (await promptUser('Who is it for? (name): ')).trim();
  if (!flags.name) {
    console.log('\nNo name given, making a plain shareable link instead.');
    return {};
  }
  flags.email = (await promptUser('Their email (locks the invite to them): ')).trim();
  flags.company = (await promptUser('Their business (name or kind, e.g. "Rivera HVAC"): ')).trim();
  flags.use = (await promptUser('What should their agent help with?: ')).trim();
  flags.why = (await promptUser('Why are you reaching out? (private context): ')).trim();
  const pack = (await promptUser('Pack to include [atris]: ')).trim();
  flags.pack = pack || 'atris';
  console.log('');
  return flags;
}

async function invite(argv) {
  const argvList = Array.isArray(argv) ? argv : [];
  if (argsWantHelp(argvList)) {
    printHelp();
    process.exit(2);
  }
  let { flags } = parseInviteFlags(argvList);
  if (Object.keys(flags).length === 0 && process.stdout.isTTY && process.stdin.isTTY) {
    flags = await inviteWizard();
  }
  const personal = flags.name || flags.email || flags.company || flags.why || flags.use;

  // Plain link (optionally carrying a pack the claimer's CLI auto-installs).
  if (!personal) {
    const body = { resource_type: 'atris_plain' };
    if (flags.pack) {
      body.pre_config = { metadata: { pack_slug: flags.pack } };
    }
    const res = await api('/invites', { method: 'POST', body });
    if (res.status >= 400) fail(apiErrorMessage(res, `Could not create invite (${res.status})`));
    const data = res.data || {};
    const url = data.share_url || `${getAppBaseUrl()}/invite/${data.invite_code}`;
    console.log('Invite link (share it with anyone):\n');
    console.log(`  ${url}\n`);
    if (flags.pack) {
      console.log(`Comes with the "${flags.pack}" pack. In a terminal they run: atris join ${data.invite_code}`);
    } else {
      console.log('When they sign up through it, find them with: atris people <their name>');
    }
    return;
  }

  // Personalized invite: clones one of your agents for them, writes the letter
  // and an email draft, optionally locks the claim to their email.
  const agent = await pickSourceAgent(flags.agent);
  const body = {
    source_agent_id: agent.id,
    target_name: flags.name || null,
    target_email: flags.email || null,
    target_company: flags.company || null,
    target_role: flags.role || null,
    target_context: flags.why || null,
    use_case: flags.use || null,
    restrict_to_email: !flags.anyEmail,
    expires_days: flags.days ? Math.max(1, Math.min(90, parseInt(flags.days, 10) || 14)) : 14,
  };
  if (flags.pack) body.pack_slug = flags.pack;

  console.log(`Building a personalized invite (cloning "${agent.name}")...`);
  const res = await api('/invites/personalize', { method: 'POST', body, timeoutMs: 90000 });
  if (res.status === 402) fail('Personalized invites need a paid plan.');
  if (res.status >= 400) fail(apiErrorMessage(res, `Could not create invite (${res.status})`));
  const data = res.data || {};

  console.log(`\nInvite for ${flags.name || flags.email}${flags.pack ? ` · pack: ${flags.pack}` : ''}`);
  console.log(`\n  ${data.share_url}\n`);
  if (data.email_subject || data.email_body) {
    console.log('Email draft:\n');
    if (data.email_subject) console.log(`  Subject: ${data.email_subject}\n`);
    for (const line of String(data.email_body || '').split('\n')) console.log(`  ${line}`);
    console.log('');
  }
  if (flags.email && !flags.anyEmail) {
    console.log(`Locked to ${flags.email}. They must sign up with that address.`);
  }
  console.log(`Terminal path for them: atris join ${data.invite_code}`);
}

async function join(code, rest = []) {
  if (isHelpToken(code) || argsWantHelp(rest)) {
    showUsageAndExit('Usage: atris join <invite-code or invite link> [--handle <yourhandle>]');
  }
  if (!code) fail('Usage: atris join <invite-code or invite link> [--handle <yourhandle>]');
  const cleaned = String(code).trim().split('/').filter(Boolean).pop().toUpperCase();

  // Public preview first, so this works before login.
  const { apiRequestJson } = require('../utils/api');
  const preview = await apiRequestJson(`/invites/${encodeURIComponent(cleaned)}`);
  if (preview.status === 404) fail('That invite does not exist or has expired.');
  if (preview.status >= 400) fail(apiErrorMessage(preview, `Could not load invite (${preview.status})`));
  const inv = preview.data || {};

  const from = inv.inviter_display_name || 'someone on Atris';
  console.log(`Invite from ${from}${inv.resource_name ? ` · ${inv.resource_name}` : ''}`);
  if (inv.preview && inv.preview.letter) {
    console.log('');
    const shareUrl = `${getAppBaseUrl()}/invite/${cleaned}`;
    const letter = String(inv.preview.letter).replace(/\{invite_url\}/g, shareUrl);
    for (const line of letter.split('\n')) console.log(`  ${line}`);
  }
  console.log('');
  if (!inv.can_claim) fail('This invite has no claims left.');

  // No account yet? Create one right here — signup is browser-free
  // (commands/signup.js), so a headless terminal can claim in one run.
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    let handle = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--handle' && rest[i + 1]) handle = String(rest[i + 1]).trim().toLowerCase();
    }
    if (!handle && process.stdout.isTTY && process.stdin.isTTY) {
      const { promptUser } = require('../utils/auth');
      console.log('You need an Atris account to accept it. Let\'s make one now, no browser needed.');
      handle = (await promptUser('Pick a handle (3-30 chars, a-z and 0-9): ')).trim().toLowerCase();
    }
    if (!handle) {
      console.log('You need an Atris account to accept it. No browser needed:');
      console.log(`  atris join ${cleaned} --handle <yourhandle>`);
      console.log(`Or sign up in a browser: ${getAppBaseUrl()}/invite/${cleaned}`);
      return;
    }
    const { signupCommand } = require('./signup');
    const signupExit = await signupCommand([handle]);
    if (signupExit !== 0) fail('Account creation failed, so the invite was not claimed. Fix the handle and rerun.');
    console.log('');
  }

  const { randomUUID } = require('crypto');
  const res = await api(`/invites/${encodeURIComponent(cleaned)}/claim`, {
    method: 'POST',
    body: { metadata: { source: 'cli' } },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  if (res.status >= 400) fail(apiErrorMessage(res, `Could not claim invite (${res.status})`));
  const claim = res.data || {};
  if (claim.status === 'claimed' || claim.status === 'already_claimed' || claim.status === 'already_member') {
    console.log(claim.status === 'claimed' ? `You're in. Connected through ${from}'s invite.` : 'Already claimed. You are in.');
  } else {
    fail(`Invite could not be claimed (${claim.status}).`);
  }

  // A business on the invite gets its own local folder; the pack lands inside
  // it. That folder is the workspace, and one command later takes it cloud.
  let workDir = null;
  if (inv.business) {
    const fs = require('fs');
    const path = require('path');
    const slug = String(inv.business).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'business';
    workDir = path.resolve(process.cwd(), slug);
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
    console.log(`\nBusiness workspace: ${slug}/`);
  }

  if (inv.pack) {
    console.log(`\nThis invite comes with the "${inv.pack}" pack. Installing...`);
    const { spawnSync } = require('child_process');
    const packArgs = [require('path').join(__dirname, '..', 'bin', 'atris.js'), 'pack', 'install', inv.pack];
    const result = spawnSync(process.execPath, packArgs, {
      stdio: 'inherit',
      cwd: workDir || process.cwd(),
    });
    if (result.status !== 0) {
      console.log(`Install did not finish. Retry with: atris pack install ${inv.pack}`);
    }
  }

  console.log('\nNext:');
  if (workDir) {
    const rel = require('path').basename(workDir);
    console.log(`  cd ${rel}                     your business workspace`);
    console.log(`  atris business init "${inv.business}"   take this folder to the cloud when ready`);
  }
  console.log('  atris social            your overview');
  console.log('  atris people <name>     find your inviter and follow back');
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
  atris invite                 Guided personalized invite (just answer questions)
  atris invite --pack <slug>   Plain link that also installs a pack on claim
  atris invite --for "Name" --email a@b.com --business "Their Co" --use "..." [--why "..."] [--agent <name>] [--pack <slug>]
                               Personalized invite: clones your agent for them,
                               writes the letter + email draft, locks to their email
  atris join <code|link>       Accept an invite; installs the pack and, for
                               business invites, scaffolds the business folder`);
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
      if (argsWantHelp(args.slice(1))) showUsageAndExit('Usage: atris friends [followers|following]');
      return friends(args[1]);
    case 'followers':
    case 'following':
      return friends(sub);
    case 'msg':
    case 'message':
    case 'dm':
      return message(args[1], args.slice(2).join(' '));
    case 'inbox':
      if (argsWantHelp(args.slice(1))) showUsageAndExit('Usage: atris inbox');
      return inbox();
    case 'invite':
      return invite(args.slice(1));
    case 'join':
      return join(args[1], args.slice(2));
    default:
      printHelp();
      process.exit(1);
  }
}

// Top-level aliases: `atris people x`, `atris follow x`, `atris msg x hi`, ...
async function peopleCommand() {
  const args = process.argv.slice(3);
  if (argsWantHelp(args)) showUsageAndExit('Usage: atris people <name or email>');
  return people(args.join(' '));
}
async function followCommand() {
  const args = process.argv.slice(3);
  if (argsWantHelp(args)) showUsageAndExit('Usage: atris follow <who>');
  return follow(args.join(' '));
}
async function unfollowCommand() {
  const args = process.argv.slice(3);
  if (argsWantHelp(args)) showUsageAndExit('Usage: atris unfollow <who>');
  return follow(args.join(' '), true);
}
async function friendsCommand() {
  const args = process.argv.slice(3);
  if (argsWantHelp(args)) showUsageAndExit('Usage: atris friends [followers|following]');
  return friends(args[0]);
}
async function msgCommand() {
  const args = process.argv.slice(3);
  if (argsWantHelp(args)) showUsageAndExit('Usage: atris msg <who> [message]');
  return message(args[0], args.slice(1).join(' '));
}
async function inboxCommand() {
  const args = process.argv.slice(3);
  if (argsWantHelp(args)) showUsageAndExit('Usage: atris inbox');
  return inbox();
}
async function inviteCommand() { return invite(process.argv.slice(3)); }
async function joinCommand() {
  const args = process.argv.slice(3);
  if (argsWantHelp(args)) showUsageAndExit('Usage: atris join <invite-code or invite link> [--handle <yourhandle>]');
  return join(args[0], args.slice(1));
}

module.exports = {
  socialCommand,
  peopleCommand,
  followCommand,
  unfollowCommand,
  friendsCommand,
  msgCommand,
  inboxCommand,
  inviteCommand,
  joinCommand,
};

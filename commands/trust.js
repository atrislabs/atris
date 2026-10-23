/**
 * Trust commands for Atris CLI, see who trusts an account and vouch for people.
 *
 * Usage:
 *   atris trust                  Your own trust
 *   atris trust <handle>         Someone else's trust, and what you share
 *   atris trust vouch <handle>   Vouch for someone (the same as following them)
 *   atris trust unvouch <handle> Take a vouch back
 *
 * <handle> can be @handle, handle, a user id, or an email. A leading @ is
 * stripped before it is sent.
 *
 * Backend: GET /api/trust/me, GET /api/trust/{handle_or_id},
 * POST and DELETE /api/trust/vouch/{handle_or_id}.
 */

const { isHelpToken, argsWantHelp } = require('../lib/noninteractive');
const { cleanTarget, targetLabel, createIo, call, reportError } = require('./pay');

function splitFlags(args) {
  const list = Array.isArray(args) ? args : [];
  return {
    json: list.includes('--json'),
    rest: list.filter((a) => a !== '--json'),
  };
}

function yesNo(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return null;
}

function trustLines(view, isMe) {
  const v = view || {};
  const name = v.handle ? `@${String(v.handle).replace(/^@+/, '')}` : (v.user_id || 'this account');
  const friends = Number(v.friends) || 0;
  const lines = [isMe ? `${name} (you)` : name];
  lines.push(`  Trust score ${v.trust_score ?? 0}, from ${friends} ${friends === 1 ? 'friend' : 'friends'}`);
  const trusted = yesNo(v.trusted_with_me);
  if (trusted) lines.push(`  Trusted with you: ${trusted}`);
  if (v.shared_friends !== null && v.shared_friends !== undefined) {
    lines.push(`  Friends you share: ${v.shared_friends}`);
  }
  return lines;
}

async function view(io, who, json) {
  const isMe = !who;
  const path = isMe ? '/trust/me' : `/trust/${encodeURIComponent(cleanTarget(who))}`;
  const res = await call(io, path);
  if (!res.ok) return reportError(io, res, `Could not load trust (${res.status})`);
  if (json) {
    io.log(JSON.stringify(res.data || {}, null, 2));
    return 0;
  }
  for (const line of trustLines(res.data, isMe)) io.log(line);
  if (isMe && !(Number(res.data && res.data.friends) > 0)) {
    io.log('\nTrust grows when people vouch for you. Find people: atris people <name>');
  }
  return 0;
}

async function vouch(io, who, remove, json) {
  const verb = remove ? 'unvouch' : 'vouch';
  const target = cleanTarget(who);
  if (!target || isHelpToken(target)) {
    io.error(`Usage: atris trust ${verb} <handle>`);
    return 2;
  }
  const res = await call(io, `/trust/vouch/${encodeURIComponent(target)}`, {
    method: remove ? 'DELETE' : 'POST',
  });
  if (!res.ok) return reportError(io, res, `Could not ${verb} (${res.status})`);
  if (json) {
    io.log(JSON.stringify(res.data || {}, null, 2));
    return 0;
  }
  const label = targetLabel(who);
  if (remove) {
    io.log(`You took back your vouch for ${label}.`);
  } else if (res.data && res.data.is_mutual) {
    io.log(`You vouched for ${label}. You vouch for each other now.`);
  } else {
    io.log(`You vouched for ${label}.`);
  }
  return 0;
}

function printHelp(log = console.log) {
  log(`atris trust, who trusts an account and who you vouch for

  atris trust                    Your trust
  atris trust <handle>           Their trust, and the friends you share
  atris trust vouch <handle>     Vouch for someone (same as following them)
  atris trust unvouch <handle>   Take your vouch back

  <handle> is @handle, a user id, or an email.
  Trust score is how many friends an account has (people who follow each other).
  Add --json for the raw answer.
  Pay someone: atris pay <handle> <amount>`);
}

async function trustCommand(argv, ioOverrides) {
  const io = createIo(ioOverrides);
  const { json, rest } = splitFlags(argv || process.argv.slice(3));
  const sub = rest[0];
  if (isHelpToken(sub) || argsWantHelp(rest)) {
    printHelp(io.log);
    return 0;
  }
  if (sub === 'vouch') return vouch(io, rest[1], false, json);
  if (sub === 'unvouch') return vouch(io, rest[1], true, json);
  return view(io, sub, json);
}

module.exports = { trustCommand, trustLines };

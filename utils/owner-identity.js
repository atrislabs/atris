'use strict';

const os = require('os');
const { spawnSync } = require('child_process');
const { loadCredentials, profileNameFromEmail } = require('./auth');

let cachedIdentity = null;

function localUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || null;
  }
}

function gitUserName() {
  const result = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function buildOwnerIdentity(credentials, username) {
  const inheritedNames = String(process.env.ATRIS_OWNER_NAMES || '').split(',').map((name) => name.trim()).filter(Boolean);
  const emailName = profileNameFromEmail(credentials?.email);
  const configured = process.env.ATRIS_OPERATOR;
  const fullName = credentials?.name || credentials?.full_name || credentials?.user_metadata?.full_name;
  const loggedIn = Boolean(emailName || credentials?.username || credentials?.user_id || fullName);
  const gitName = loggedIn ? null : gitUserName();
  const gitFirstName = gitName ? gitName.split(/\s+/)[0] : null;
  // Keep an existing local claim alias when it begins with the signed-in account name.
  const localAlias = username && emailName?.length >= 4 && String(username).toLowerCase().startsWith(emailName)
    ? username : null;
  const values = [
    ...inheritedNames, emailName, configured, credentials?.username, credentials?.user_id, fullName,
    fullName?.replace(/\s+/g, ''), localAlias, gitName, gitName?.replace(/\s+/g, ''),
    gitFirstName, loggedIn ? null : username,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const slug = inheritedNames[0] || emailName || configured || gitFirstName || (loggedIn ? null : username);
  return { slug: slug ? String(slug).toLowerCase() : null, names: values };
}

function ownerIdentity(credentials, username) {
  if (arguments.length > 0) return buildOwnerIdentity(credentials, username === undefined ? localUsername() : username);
  if (!cachedIdentity) cachedIdentity = buildOwnerIdentity(loadCredentials(), localUsername());
  return cachedIdentity;
}

function resetOwnerIdentityCache() {
  cachedIdentity = null;
}

function isOwner(value) {
  const candidate = String(value || '').trim().toLowerCase();
  if (['you', 'me', 'operator', 'human', 'owner'].includes(candidate)) return true;
  const identity = ownerIdentity();
  return identity.names.includes(candidate);
}

module.exports = { ownerIdentity, isOwner, resetOwnerIdentityCache };

'use strict';

// atris join --name <name> [--business <id>] [--mission "<text>"]
// Makes this session a named agent that lives on a home computer
// (POST /join-as-agent). The agent key goes in the same slot `atris login
// --agent` uses, and the joined agent is remembered next to it so
// `atris night` and `atris morning` act for it by default.
// Without --mission, the agent's purpose line from this project's own
// atris/team/<name>/MISSION.md (its North Star) is shown and used as the mission.
//
// `atris join <invite-code>` (accepting an invite) still lives in
// commands/social.js; bin/atris.js routes here only when --name is given.

const path = require('path');
const { parseFlags, wantsHelp, resolveBusinessId, errorText, cleanText } = require('../lib/night-shift');

const NOT_LOGGED_IN = 'not logged in. run: atris login';

function showJoinAgentHelp(log = console.log) {
  log('usage: atris join --name <name> [--business <id>] [--mission "<text>"]');
  log('');
  log('Make this session a named agent that lives on a computer. With --business');
  log('it joins that business\'s computer; without it, your personal computer.');
  log('Running it again with the same name gives back the same agent.');
  log('');
  log('  --name <name>       The agent\'s name');
  log('  --business <id>     The business it belongs to (id or connected slug)');
  log('  --mission "<text>"  What the agent is for, in one line. Without it, the');
  log('                      North Star in atris/team/<name>/MISSION.md is used if there');
  log('                      is one. --mission "" sends no mission at all.');
  log('');
  log('To accept an invite instead: atris join <invite-code>');
}

// True when `atris join ...` means "join as an agent" rather than "accept an invite".
function isAgentJoin(args = []) {
  return Array.isArray(args) && args.some((arg) => arg === '--name' || String(arg).startsWith('--name='));
}

function homeLabel(data, businessInput) {
  const home = data && data.home;
  if (home && typeof home === 'object') {
    const name = home.business_name || home.name || home.label;
    if (name) return String(name);
  }
  if (businessInput) return String(businessInput);
  if (typeof home === 'string' && home.trim() && !/^(self|personal)$/i.test(home.trim())) return home.trim();
  return 'your personal computer';
}

function tokenExpiry(token, decode) {
  const claims = decode(token);
  if (claims && typeof claims.exp === 'number') return new Date(claims.exp * 1000).toISOString();
  return null;
}

// Store the agent key where `atris login --agent` keeps scoped keys, plus the
// joined agent itself. Returns a short note when it could not be saved.
function storeJoinedAgent(creds, token, joined, deps = {}) {
  if (!creds || creds.source) {
    // Env tokens, placed key files, and agent clients are not ours to rewrite.
    return 'The agent key was not saved because this terminal signs in with a key from outside. Keep it in ATRIS_TOKEN to act as the agent.';
  }
  const authUtils = require('../utils/auth');
  const decode = deps.decodeJwtClaims || authUtils.decodeJwtClaims;
  const persist = deps.persistMintedAgentToken || require('./auth').persistMintedAgentToken;
  const claims = decode(token) || {};
  try {
    persist({ ...creds, joined_agent: joined }, token, {
      scopes: Array.isArray(claims.scopes) ? claims.scopes : [],
      expiresAt: tokenExpiry(token, decode),
    });
    return null;
  } catch (error) {
    return `The agent key was not saved: ${String(error && error.message || error)}`;
  }
}

const MAX_MISSION = 300;

// The one purpose line this project already keeps for an agent of this name:
// the North Star in atris/team/<name>/MISSION.md. Null unless it is a real
// line, not the placeholder a new member file starts with.
function purposeFromFolder(name, cwd) {
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  const memberDir = path.join(cwd, 'atris', 'team', slug);
  const { missionPurpose } = require('../lib/member-core');
  const purpose = missionPurpose({ memberDir, missionFile: path.join(memberDir, 'MISSION.md') });
  const line = purpose.meaningful ? cleanText(purpose.northStar, MAX_MISSION) : '';
  return line.length >= 8 ? { file: `atris/team/${slug}/MISSION.md`, line } : null;
}

async function joinAgentCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  if (wantsHelp(args)) {
    showJoinAgentHelp(log);
    return 0;
  }

  const { flags } = parseFlags(args, ['--name', '--business', '--mission'], []);
  const name = String(flags.name || '').trim();
  if (!name) {
    err('Give the agent a name. Example: atris join --name scout');
    return 1;
  }

  const load = deps.loadCredentials || require('../utils/auth').loadCredentials;
  const request = deps.apiRequestJson || require('../utils/api').apiRequestJson;
  const creds = await load(request);
  const token = creds && typeof creds.token === 'string' ? creds.token.trim() : '';
  if (!token) {
    err(NOT_LOGGED_IN);
    return 1;
  }

  const businessId = flags.business ? resolveBusinessId(flags.business, deps) : null;
  const body = { business_id: businessId, name };
  let mission = String(flags.mission || '').trim();
  if (flags.mission === undefined) {
    const purpose = purposeFromFolder(name, deps.cwd || process.cwd());
    if (purpose) {
      mission = purpose.line;
      log(`Using the purpose line in ${purpose.file} as the mission:`);
      log(`  "${purpose.line}"`);
      log('Sending Atris only the name, the business and that one line, nothing else from your folder.');
      log('To send your own instead: --mission "<text>". To send none: --mission "".');
    }
  }
  if (mission) body.mission = mission;

  const result = await request('/join-as-agent', { method: 'POST', token, body, retries: 0 });
  if (!result || !result.ok) {
    err(`Could not join: ${errorText(result)}`);
    return 1;
  }
  const data = result.data || {};
  if (!data.agent_id || !data.token) {
    err('Atris did not return an agent and key, so nothing was joined.');
    return 1;
  }

  const joined = {
    agent_id: data.agent_id,
    name,
    business_id: businessId,
    home: data.home == null ? null : data.home,
    joined_at: deps.now ? deps.now() : new Date().toISOString(),
  };
  const note = storeJoinedAgent(creds, data.token, joined, deps);

  log(`Joined ${homeLabel(data, flags.business)} as ${name}. This session now acts as that agent.`);
  log(`Agent ${data.agent_id}.`);
  if (note) err(note);
  return 0;
}

module.exports = { joinAgentCommand, isAgentJoin, showJoinAgentHelp, storeJoinedAgent, purposeFromFolder };

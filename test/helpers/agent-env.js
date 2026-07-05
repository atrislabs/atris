'use strict';

const { AGENT_ENV_MARKERS } = require('../../commands/task');

// Tests that spawn the CLI inherit the parent env. When an agent (Claude
// Code, Codex, Cursor, Devin) runs npm test, its session marker flips the
// CLI into agent proof-only mode and human-flow assertions fail with
// phantom errors. Scrub the markers so tests behave the same for humans
// and agents; tests that exercise proof-only mode set markers explicitly.
// Player identity vars leak from the developer shell the same way: a set
// ATRIS_PROFILE wins over the USER a test passes in (commands/play.js
// activeAccountCandidate), so play/xp tests fail only on machines with a
// profile exported. Tests that exercise identity set these explicitly.
const PLAYER_IDENTITY_VARS = ['ATRIS_PROFILE', 'ATRIS_PLAYER', 'ATRIS_USERNAME'];

function scrubAgentEnv(base = process.env) {
  const env = { ...base };
  for (const marker of AGENT_ENV_MARKERS) delete env[marker];
  delete env.ATRIS_AGENT_PROOF_ONLY;
  for (const key of PLAYER_IDENTITY_VARS) delete env[key];
  return env;
}

module.exports = { scrubAgentEnv, AGENT_ENV_MARKERS };

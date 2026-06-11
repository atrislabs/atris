'use strict';

const { AGENT_ENV_MARKERS } = require('../../commands/task');

// Tests that spawn the CLI inherit the parent env. When an agent (Claude
// Code, Codex, Cursor, Devin) runs npm test, its session marker flips the
// CLI into agent proof-only mode and human-flow assertions fail with
// phantom errors. Scrub the markers so tests behave the same for humans
// and agents; tests that exercise proof-only mode set markers explicitly.
function scrubAgentEnv(base = process.env) {
  const env = { ...base };
  for (const marker of AGENT_ENV_MARKERS) delete env[marker];
  delete env.ATRIS_AGENT_PROOF_ONLY;
  return env;
}

module.exports = { scrubAgentEnv, AGENT_ENV_MARKERS };

'use strict';

// Compact mission --json keeps tick payloads to ids + next_command.
// Tests that read mission/tick/verifier fields need the full dump.
function withMissionFullJson(args) {
  if (!Array.isArray(args) || args[0] !== 'mission') return args;
  if (!args.includes('--json') || args.includes('--full')) return args;
  if (args[1] !== 'tick') return args;
  return [...args, '--full'];
}

function jsonErrorDetail(payload) {
  return payload && (payload.detail || payload.error);
}

module.exports = {
  withMissionFullJson,
  jsonErrorDetail,
};

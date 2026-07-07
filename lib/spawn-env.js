'use strict';

const path = require('path');

// Autonomously launched runtimes (cron, launchd, pulse ticks) carry a minimal
// PATH without node's directory, so any shell command that may invoke
// `node ...` fails only in the one environment nobody is watching. Three
// subsystems hit this on 2026-07-07 alone (experiment applies, atris2 relayed
// ops, always-on mission verifiers). Prepend the directory of the node that
// runs this CLI before spawning shell commands from autonomous paths.
function envWithNodeDir(base = process.env) {
  const nodeDir = path.dirname(process.execPath);
  const basePath = String(base.PATH || '');
  if (basePath.split(path.delimiter).includes(nodeDir)) return base;
  return { ...base, PATH: `${nodeDir}${path.delimiter}${basePath}` };
}

module.exports = { envWithNodeDir };

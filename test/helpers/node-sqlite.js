'use strict';

const { spawnSync } = require('node:child_process');

const availability = new Map();

function hasNodeSqlite(envOverrides) {
  const env = envOverrides === undefined ? process.env : { ...process.env, ...envOverrides };
  const key = JSON.stringify([
    process.execPath,
    process.cwd(),
    Object.keys(env).sort().map(name => [name, env[name]]),
  ]);
  if (availability.has(key)) return availability.get(key);

  const options = { encoding: 'utf8' };
  if (envOverrides !== undefined) options.env = env;
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], options);
  const supported = result.status === 0;
  // A process that could not finish may recover on the next call.
  if (!result.error && !result.signal && Number.isInteger(result.status)) {
    availability.set(key, supported);
  }
  return supported;
}

module.exports = { hasNodeSqlite };

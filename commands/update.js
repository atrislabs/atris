const path = require('path');
const { spawnSync } = require('child_process');
const {
  isGitCheckout,
  getNpmSelfUpdateCommand,
  getNpmSelfUpdateSpawnArgs,
} = require('../utils/update-check');

const DEFAULT_PACKAGE_ROOT = path.join(__dirname, '..');

function updateSelf(options = {}) {
  const packageRoot = options.packageRoot || DEFAULT_PACKAGE_ROOT;
  const spawnImpl = options.spawnSync || spawnSync;
  const log = options.log || console.log;
  const errorLog = options.errorLog || console.error;

  if (isGitCheckout(packageRoot)) {
    errorLog('this atris install is a git checkout; use git to update the cli, not atris update --self.');
    return { ok: false, reason: 'git-checkout' };
  }

  const { command, args } = getNpmSelfUpdateSpawnArgs();
  log('installing latest atris from npm...');

  const result = spawnImpl(command, args, {
    stdio: options.stdio || 'inherit',
    shell: options.shell !== undefined ? options.shell : true,
  });

  if (result.status === 0) {
    log('atris updated successfully.');
    log('run `atris update` in your projects to sync local files.');
    return { ok: true };
  }

  errorLog('update failed. try running manually:');
  errorLog(`  ${getNpmSelfUpdateCommand()}`);
  return { ok: false, reason: 'install-failed', status: result.status };
}

module.exports = {
  updateSelf,
  DEFAULT_PACKAGE_ROOT,
};

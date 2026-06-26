const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRemoteAtrisBootstrapCommand } = require('../lib/runtime-bootstrap');

test('remote runtime bootstrap falls back to a workspace npm prefix', () => {
  const command = buildRemoteAtrisBootstrapCommand({
    boundary: 'computer-wake',
    businessSlug: 'example-co',
    businessId: 'biz-1',
    workspaceId: 'ws-1',
  });

  assert.match(command, /LOCAL_NPM_PREFIX="\$WORKSPACE\/\.atris-npm"/);
  assert.match(command, /LOCAL_ATRIS_BIN="\$LOCAL_NPM_PREFIX\/node_modules\/\.bin\/atris"/);
  assert.match(command, /export PATH="\$LOCAL_NPM_PREFIX\/node_modules\/\.bin:\/home\/atris\/bin:\$PATH"/);
  assert.match(command, /npm install --prefix "\$LOCAL_NPM_PREFIX" atris@latest/);
  assert.match(command, /RECOVERY_COMMAND="npm install --prefix \/workspace\/\.atris-npm atris@latest && \/workspace\/\.atris-npm\/node_modules\/\.bin\/atris update"/);
});

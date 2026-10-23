'use strict';

// buildGatewaySupervisorScript returns the source of the detached supervisor that
// lib/fleet.js writes to disk. These tests only read the returned string: they never
// run it, so no gateway starts and no child process is spawned.

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { buildGatewaySupervisorScript } = require('../lib/secret-gateway');

const GATEWAY_PATH = '/fixed/install/lib/secret-gateway.js';

test('embeds the gateway module path and the sandbox-pids helper as require calls', () => {
  const src = buildGatewaySupervisorScript(GATEWAY_PATH);

  assert.equal(typeof src, 'string');
  assert.ok(src.startsWith("'use strict';\n"));
  assert.ok(src.includes(`const sg = require(${JSON.stringify(GATEWAY_PATH)});`));
  assert.ok(src.includes(
    `const sandboxPids = require(${JSON.stringify(require.resolve('../lib/sandbox-pids'))});`,
  ));
  assert.ok(src.endsWith("main().catch(() => { writeExit(1); });\n"));
});

test('a gateway path with quotes and backslashes stays one literal and still compiles', () => {
  const tricky = "/tmp/it's a \\ \"odd\" path/secret-gateway.js";
  const src = buildGatewaySupervisorScript(tricky);

  // Compile only. vm.Script parses the source without running it.
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'supervisor.js' }));

  const match = src.match(/const sg = require\((".*")\);/);
  assert.ok(match, 'sg require line is present');
  assert.equal(JSON.parse(match[1]), tricky);
});

test('an empty gateway path is embedded as an empty string without validation', () => {
  const src = buildGatewaySupervisorScript('');

  assert.ok(src.includes('const sg = require("");'));
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'supervisor.js' }));
});

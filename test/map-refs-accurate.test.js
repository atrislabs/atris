'use strict';

// Loud guard for a lesson that has burned this repo twice: MAP.md file:line
// references that point at code which moved or was deleted. The healer in
// commands/clean.js already knows how to find broken refs; autopilot only
// surfaces them as a soft suggestion on a tick. This test makes the same
// signal fail `npm test` the moment MAP.md drifts, so a stale reference can
// never merge unnoticed. (mission: hardest standing lessons -> automatic checks)

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { healBrokenMapRefs } = require('../commands/clean.js');

test("atris/MAP.md has no broken file:line references", () => {
  const cwd = path.join(__dirname, '..');
  const atrisDir = path.join(cwd, 'atris');
  const { unhealable } = healBrokenMapRefs(cwd, atrisDir, true); // dry-run, never writes

  const detail = unhealable
    .map((r) => `  ${r.file}:${r.line} — ${r.reason}`)
    .join('\n');

  assert.strictEqual(
    unhealable.length,
    0,
    `MAP.md points at code that moved or was deleted (${unhealable.length} broken ref` +
      `${unhealable.length === 1 ? '' : 's'}). Run \`atris clean\` to auto-heal drift, ` +
      `then fix the rest by hand:\n${detail}`
  );
});

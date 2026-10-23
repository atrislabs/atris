'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

test('reports the exact remap when an engine owner falls back without a task signal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-owner-fallback-'));
  try {
    assert.deepStrictEqual(resolveFunctionalOwner({ requestedOwner: 'codex', root }), {
      owner: 'architect',
      reason: 'engine_owner_resolved_to_factory_owner',
      requested_owner: 'codex',
      executed_by: 'codex',
      proposed_member: 'feature-owner',
      remap_reason: '"codex" could not be kept as owner; using architect. Override: atris mission start "<objective>" --owner <existing-member> --verify "..."',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

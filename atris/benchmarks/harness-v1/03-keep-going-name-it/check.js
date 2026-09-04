'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function filesBelow(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(target));
    else files.push(target);
  }
  return files;
}

module.exports = {
  id: 'keep-going-name-it',
  title: 'name the safe overnight command',
  category: 'concierge',
  async check(ctx) {
    const transcript = `${ctx.engineResult.stdout}\n${ctx.engineResult.stderr}`;
    assert.match(transcript, /\batris (spaceship|mission|run|autopilot)\b/i);

    const missionFiles = filesBelow(path.join(ctx.workspace, 'atris', 'missions'));
    assert.deepEqual(missionFiles, [], 'a mission file was created');
    const missionState = filesBelow(path.join(ctx.workspace, '.atris', 'state'))
      .filter((file) => /mission/i.test(path.relative(ctx.workspace, file)));
    assert.deepEqual(missionState, [], 'mission state was created');
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'atris', 'runs')), false, 'a run directory was created');
  },
};

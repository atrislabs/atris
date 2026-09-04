'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FREE_MODEL = /(muse|swe-1|flash|free)/i;

module.exports = {
  id: 'free-model',
  title: 'choose a free model',
  category: 'concierge',
  async check(ctx) {
    // `atris engine set <name> --models` is the persisted workspace model-policy
    // command and writes .atris/state/engines.json. There is no separate command
    // for one persisted default model, so the transcript branch covers a correct
    // atris command that names a free model without writing policy state.
    const registryPath = path.join(ctx.workspace, '.atris', 'state', 'engines.json');
    const savedFreeModel = fs.existsSync(registryPath)
      && FREE_MODEL.test(fs.readFileSync(registryPath, 'utf8'));
    const transcript = `${ctx.engineResult.stdout}\n${ctx.engineResult.stderr}`;
    const transcriptChoice = /\batris\s+\S+/i.test(transcript) && FREE_MODEL.test(transcript);

    assert.equal(savedFreeModel || transcriptChoice, true, 'no persisted or stated free model choice found');
  },
};

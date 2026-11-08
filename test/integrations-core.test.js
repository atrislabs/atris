const test = require('node:test');
const assert = require('node:assert/strict');
const integrationsCore = require('../lib/integrations-core');
const integrationsCommand = require('../commands/integrations');

test('integrations-core exports shared Gmail, Google, Calendar, Slack, and iMessage helpers', () => {
  assert.equal(typeof integrationsCore.gmailTriageVerdict, 'function');
  assert.equal(typeof integrationsCore.parseGmailArgs, 'function');
  assert.equal(typeof integrationsCore.parseCalendarSearchArgs, 'function');
  assert.equal(typeof integrationsCore.filterCalendarEventsForSearch, 'function');
  assert.equal(typeof integrationsCore.normalizeImessageHandle, 'function');
  assert.equal(typeof integrationsCore.scoreImessageContact, 'function');
  assert.equal(integrationsCommand.gmailTriageVerdict, integrationsCore.gmailTriageVerdict);
  assert.equal(integrationsCommand.parseCalendarSearchArgs, integrationsCore.parseCalendarSearchArgs);
  assert.equal(integrationsCommand.filterCalendarEventsForSearch, integrationsCore.filterCalendarEventsForSearch);
});

test('integrations-core normalizes iMessage handles and scores contact matches', () => {
  assert.equal(integrationsCore.normalizeImessageHandle('(415) 555-2671'), '+14155552671');
  assert.equal(integrationsCore.normalizeImessageHandle('14155552671'), '+14155552671');
  assert.equal(integrationsCore.normalizeImessageHandle('alex@example.com'), 'alex@example.com');
  assert.equal(integrationsCore.scoreImessageContact('Alex Rivera', { name: 'Alex Rivera' }), 95);
  assert.equal(integrationsCore.scoreImessageContact('Alex', { name: 'Alex Rivera' }), 80);
  assert.equal(integrationsCore.scoreImessageContact('me', { name: 'Anyone' }, true), 100);
});

test('integrations-core parses Slack limits and strips --limit flags', () => {
  assert.equal(integrationsCore.parseLimit(['--limit', '35']), 35);
  assert.equal(integrationsCore.parseLimit(['-n', '500']), 100);
  assert.equal(integrationsCore.parseLimit([]), 20);
  assert.deepEqual(integrationsCore.argsWithoutLimit(['hello', '--limit', '10', 'world']), ['hello', 'world']);
});

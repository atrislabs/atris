'use strict';

async function send(channel, text) {
  const { getAuthToken, apiRequestJson } = require('./integrations-core');
  const token = await getAuthToken();
  return apiRequestJson('/integrations/slack/me/send', { method: 'POST', token, body: { channel, text } });
}
module.exports = { send };

require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

test('review manifest numbers the first slide from one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-number-'));
  const savedHome = process.env.HOME;
  const originalGet = https.get;
  process.env.HOME = tmp;
  try {
    const { reviewDeck } = require('../lib/deck-review');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    https.get = (url, callback) => {
      callback({
        statusCode: 200,
        headers: {},
        pipe(destination) {
          destination.end(png);
          return destination;
        },
      });
      return { on() {} };
    };
    const { manifestPath } = await reviewDeck({
      presentationId: 'numbered-deck',
      spec: { slides: [{ type: 'title', headline: 'Opening' }] },
      outRoot: tmp,
      token: 'fixture-token',
      api: async (method, route) => {
        if (method === 'GET' && route === '/presentations/numbered-deck') {
          return { slides: [{ objectId: 'opening-slide' }] };
        }
        if (method === 'GET' && route.includes('/thumbnail')) {
          return { contentUrl: 'https://example.com/opening.png' };
        }
        throw new Error(`unexpected request: ${method} ${route}`);
      },
    });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.slides[0].index, 1);
  } finally {
    https.get = originalGet;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

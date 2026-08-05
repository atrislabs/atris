'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collectPages,
  MAX_FILE_BYTES,
  MAX_FILES,
  registerSubdomain,
  renderApiKey,
  run,
  validateSlug,
} = require('../commands/site-deploy');

function scratch(t, prefix = 'atris-site-deploy-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function response(status, data = null) {
  return {
    status,
    body: data === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data)),
  };
}

test('validateSlug accepts safe names and rejects malformed or reserved names', () => {
  assert.equal(validateSlug('my-site-2'), null);
  assert.match(validateSlug('My-Site'), /lowercase/);
  assert.match(validateSlug('-my-site'), /no hyphen/);
  assert.match(validateSlug('my-site-'), /no hyphen/);
  assert.match(validateSlug('api'), /reserved/);
});

test('collectPages includes supported files and explains every skip', (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>');
  fs.writeFileSync(path.join(dir, 'pixel.png'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(dir, 'notes.md'), '# ignored');
  fs.writeFileSync(path.join(dir, '.secret'), 'ignored');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'bundle.js'), 'ignored');
  const logs = [];

  const pages = collectPages(dir, { log: (line) => logs.push(line) });

  assert.deepEqual(pages.map((page) => page.path), ['index.html', 'pixel.png']);
  assert.equal(pages[0].content_type, 'text/html');
  assert.equal(pages[0].is_base64, false);
  assert.equal(pages[1].is_base64, true);
  assert.equal(pages[1].size, 3);
  assert.ok(logs.some((line) => line.includes('.secret') && line.includes('dotfiles')));
  assert.ok(logs.some((line) => line.includes('node_modules/') && line.includes('ignored directory')));
  assert.ok(logs.some((line) => line.includes('notes.md') && line.includes('unsupported')));
});

test('collectPages enforces the file size and count caps with skip reasons', (t) => {
  const dir = scratch(t);
  for (let i = 0; i <= MAX_FILES; i += 1) {
    fs.writeFileSync(path.join(dir, `file-${String(i).padStart(3, '0')}.js`), 'x');
  }
  fs.writeFileSync(path.join(dir, 'oversized.png'), Buffer.alloc(MAX_FILE_BYTES + 1));
  const logs = [];

  const pages = collectPages(dir, { log: (line) => logs.push(line) });

  assert.equal(pages.length, MAX_FILES);
  assert.ok(logs.some((line) => line.includes('file limit of 200 reached')));
  assert.ok(logs.some((line) => line.includes('oversized.png') && line.includes('larger than 2.0 mb')));
});

test('dry run prints the plan without loading credentials or making requests', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{}');
  const logs = [];
  let credentialsLoaded = false;
  let requested = false;

  const code = await run([dir, '--name', 'smoke-test', '--dry-run'], {
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
    loadCredentials: () => { credentialsLoaded = true; return { token: 'secret' }; },
    httpRequest: async () => { requested = true; return response(200); },
  });

  assert.equal(code, 0);
  assert.equal(credentialsLoaded, false);
  assert.equal(requested, false);
  assert.ok(logs.some((line) => line.includes('would publish index.html')));
  assert.ok(logs.some((line) => line.includes('https://smoke-test.atris.ai')));
  assert.ok(logs.some((line) => line.includes('no network calls made')));
});

test('fullstack preflight rejects a directory without package.json', async (t) => {
  const dir = scratch(t);
  const logs = [];

  const code = await run([dir, '--fullstack', '--name', 'missing-package'], {
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
  });

  assert.equal(code, 2);
  assert.ok(logs.some((line) => line.includes('add package.json with a "start" script')));
});

test('fullstack preflight rejects package.json without a start script', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node build.js' } }));
  const logs = [];

  const code = await run([dir, '--fullstack', '--name', 'missing-start'], {
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
  });

  assert.equal(code, 2);
  assert.ok(logs.some((line) => line.includes('add "scripts": { "start": "node server.js" }')));
});

test('fullstack dry run prints the repository and render plan with zero network calls', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { start: 'node server.js', build: 'node build.js' },
  }));
  const logs = [];
  let credentialsLoaded = false;
  let commandRun = false;
  let requested = false;

  const code = await run([dir, '--fullstack', '--name', 'fullstack-smoke', '--dry-run'], {
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
    loadCredentials: () => { credentialsLoaded = true; return { token: 'secret' }; },
    spawnSync: () => { commandRun = true; return { status: 0, stdout: '', stderr: '' }; },
    httpRequest: async () => { requested = true; return response(200); },
  });

  const output = logs.join('\n');
  assert.equal(code, 0);
  assert.equal(credentialsLoaded, false);
  assert.equal(commandRun, false);
  assert.equal(requested, false);
  assert.match(output, /repository atrislabs\/atris-app-fullstack-smoke \(private\)/);
  assert.match(output, /runtime node/);
  assert.match(output, /plan starter/);
  assert.match(output, /region oregon/);
  assert.match(output, /build npm install && npm run build/);
  assert.match(output, /render target https:\/\/atris-app-fullstack-smoke\.onrender\.com/);
  assert.match(output, /target https:\/\/fullstack-smoke\.atris\.ai/);
  assert.match(output, /no network calls made/);
});

test('fullstack deploy creates render config and tolerates an unknown proxy_target field', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { start: 'node server.js', build: 'node build.js' },
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), 'console.log("server")');
  const logs = [];
  const calls = [];

  const code = await run([dir, '--fullstack', '--name', 'wired-app'], {
    renderApiKey: 'render-secret',
    loadCredentials: () => ({ token: 'user-token' }),
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
    spawnSync: (command, args) => ({
      status: command === 'git' && args[0] === 'diff' ? 1 : 0,
      stdout: '',
      stderr: '',
    }),
    sleep: async () => {},
    httpRequest: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/services?name=')) return response(200, []);
      if (url.endsWith('/services/srv-culkutq3esus73cvqcg0') && options.method === 'GET') {
        return response(200, { id: 'srv-backend', ownerId: 'tea-atris' });
      }
      if (url === 'https://api.render.com/v1/services' && options.method === 'POST') {
        return response(201, {
          id: 'srv-app',
          name: 'atris-app-wired-app',
          serviceDetails: { url: 'https://atris-app-wired-app.onrender.com' },
        });
      }
      if (url.endsWith('/services/srv-app/deploys?limit=1')) {
        return response(200, [{ deploy: { id: 'dep-app', status: 'live' } }]);
      }
      if (url === 'https://api.atris.ai/api/sites' && options.method === 'POST') return response(201, {});
      if (url.endsWith('/api/sites/wired-app') && options.method === 'PATCH') {
        return response(422, { detail: [{ loc: ['body', 'proxy_target'], msg: 'Extra inputs are not permitted' }] });
      }
      if (url.endsWith('/custom-domains')) return response(201, {});
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  });

  const renderCreate = calls.find((call) => call.url === 'https://api.render.com/v1/services' && call.options.method === 'POST');
  const renderBody = JSON.parse(renderCreate.options.body);
  assert.equal(code, 0);
  assert.deepEqual(renderBody, {
    type: 'web_service',
    name: 'atris-app-wired-app',
    ownerId: 'tea-atris',
    repo: 'https://github.com/atrislabs/atris-app-wired-app',
    branch: 'main',
    autoDeploy: 'yes',
    serviceDetails: {
      runtime: 'node',
      plan: 'starter',
      region: 'oregon',
      envSpecificDetails: {
        buildCommand: 'npm install && npm run build',
        startCommand: 'npm start',
      },
    },
  });
  assert.ok(logs.some((line) => line.includes('render deploy status: live')));
  assert.ok(logs.some((line) => line.includes('PATCH https://api.atris.ai/api/sites/wired-app')));
  assert.ok(logs.some((line) => line.includes('{"proxy_target":"atris-app-wired-app.onrender.com"}')));
  assert.ok(logs.some((line) => line.includes('render infrastructure is ready')));
  assert.ok(!logs.join('\n').includes('render-secret'));
  assert.ok(!logs.join('\n').includes('user-token'));
});

test('deploy creates the site and bulk upserts pages with the exact body', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');
  const home = scratch(t, 'atris-site-home-');
  const calls = [];
  const logs = [];

  const code = await run([dir, '--name', 'exact-body', '--api-base', 'http://localhost:9876'], {
    homedir: () => home,
    loadCredentials: () => ({ token: 'user-token' }),
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
    httpRequest: async (url, options) => {
      calls.push({ url, options });
      return response(options.method === 'POST' ? 201 : 200, {});
    },
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://localhost:9876/api/sites');
  assert.deepEqual(JSON.parse(calls[0].options.body), { slug: 'exact-body' });
  assert.equal(calls[1].url, 'http://localhost:9876/api/sites/exact-body/pages');
  assert.deepEqual(JSON.parse(calls[1].options.body), [{
    path: 'index.html',
    content: 'hello',
    content_type: 'text/html',
    is_base64: false,
  }]);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer user-token');
  assert.ok(logs.some((line) => line.includes('live at https://exact-body.atris.ai')));
});

test('spa deploy patches an existing site and uploads in batches of fifty', async (t) => {
  const dir = scratch(t);
  for (let i = 0; i < 51; i += 1) {
    fs.writeFileSync(path.join(dir, `file-${String(i).padStart(2, '0')}.js`), String(i));
  }
  const home = scratch(t, 'atris-site-home-');
  const calls = [];

  const code = await run([dir, '--name', 'spa-site', '--spa'], {
    homedir: () => home,
    loadCredentials: () => ({ token: 'user-token' }),
    log: () => {},
    error: () => {},
    httpRequest: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') return response(409, { detail: 'exists' });
      return response(200, {});
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.options.method), ['POST', 'PATCH', 'PUT', 'PUT']);
  assert.deepEqual(JSON.parse(calls[0].options.body), { slug: 'spa-site', spa: true });
  assert.deepEqual(JSON.parse(calls[1].options.body), { spa: true });
  assert.equal(JSON.parse(calls[2].options.body).length, 50);
  assert.equal(JSON.parse(calls[3].options.body).length, 1);
});

test('deploy registers the subdomain before a failed page upload and prints a concise error', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), 'page payload sentinel');
  const calls = [];
  const logs = [];
  const errors = [];

  const code = await run([dir, '--name', 'upload-failure'], {
    renderApiKey: 'render-secret',
    loadCredentials: () => ({ token: 'user-token' }),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    httpRequest: async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://api.atris.ai/api/sites') return response(201, {});
      if (url.endsWith('/custom-domains')) return response(201, { id: 'cd-upload-failure' });
      if (url.endsWith('/custom-domains/cd-upload-failure/verify')) return response(200, {});
      if (url.endsWith('/api/sites/upload-failure/pages')) {
        return response(422, {
          detail: [{
            loc: ['body'],
            msg: 'Input should be a valid list',
            input: { pages: ['page payload sentinel'] },
          }],
        });
      }
      throw new Error(`unexpected request: ${options.method} ${url}`);
    },
  });

  assert.equal(code, 1);
  assert.deepEqual(calls.map((call) => call.options.method), ['POST', 'POST', 'POST', 'PUT']);
  assert.ok(logs.some((line) => line.includes('registered subdomain upload-failure.atris.ai')));
  assert.match(errors.join('\n'), /failed \(422\): body: Input should be a valid list/);
  assert.ok(!errors.join('\n').includes('page payload sentinel'));
});

test('spa deploy warns and retries creation when the server rejects the spa field', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');
  const home = scratch(t, 'atris-site-home-');
  const calls = [];
  const logs = [];

  const code = await run([dir, '--name', 'spa-fallback', '--spa'], {
    homedir: () => home,
    loadCredentials: () => ({ token: 'user-token' }),
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
    httpRequest: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response(422, { detail: 'unknown field spa' });
      return response(options.method === 'POST' ? 201 : 200, {});
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.options.method), ['POST', 'POST', 'PUT']);
  assert.deepEqual(JSON.parse(calls[0].options.body), { slug: 'spa-fallback', spa: true });
  assert.deepEqual(JSON.parse(calls[1].options.body), { slug: 'spa-fallback' });
  assert.ok(logs.some((line) => line.includes('warning: spa routing was not accepted')));
});

test('render registration reads the nested key and verifies the returned domain id', async (t) => {
  const home = scratch(t, 'atris-render-home-');
  fs.mkdirSync(path.join(home, '.render'));
  fs.writeFileSync(path.join(home, '.render', 'cli.yaml'), 'api:\n  key: "render-secret"\n');
  const calls = [];
  const logs = [];

  await registerSubdomain('render-site', {
    homedir: () => home,
    log: (line) => logs.push(line),
    httpRequest: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/verify')) return response(200, {});
      return response(201, { id: 'cd-123' });
    },
  });

  assert.equal(renderApiKey('api:\n  key: plain-key\n'), 'plain-key');
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'render-site.atris.ai' });
  assert.ok(calls[1].url.endsWith('/custom-domains/cd-123/verify'));
  assert.equal(calls[0].options.headers.Authorization, 'Bearer render-secret');
  assert.ok(!logs.join('\n').includes('render-secret'));

  const failureLogs = [];
  await registerSubdomain('render-site', {
    homedir: () => home,
    log: (line) => failureLogs.push(line),
    httpRequest: async () => { throw new Error('failure containing render-secret'); },
  });
  assert.ok(failureLogs.some((line) => line.includes('[redacted]')));
  assert.ok(!failureLogs.join('\n').includes('render-secret'));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
const user = { id: 'user-sync', email: 'sync@example.test', provider: 'email' };
const memberContent = '---\nname: navigator\nagent-id: agent-sync\n---\n\n# Navigator\n';
const cloudContent = '# Cloud note\n';
const localContent = '# Local note\n';

// Generated, unsigned fixtures only. Assertions report booleans so even a
// regression cannot print a credential in the test runner's diagnostics.
function fakeJwt(exp) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ exp, nonce: randomBytes(12).toString('hex') })).toString('base64url'),
    randomBytes(12).toString('hex'),
  ].join('.');
}

function runCli(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('sync CLI timed out'));
    }, 15000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('could not start sync CLI'));
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, output });
    });
  });
}

const commands = [
  { name: 'journal pull', args: ['pull'], resource: '/agents/agent-sync/journal/' },
  { name: 'business pull', args: ['pull', 'sync-co'], resource: '/snapshot' },
  { name: 'business push', args: ['push', 'sync-co', '--from', '.', '--force', '--yes'], resource: '/sync' },
  { name: 'member push', args: ['member', 'push', 'navigator'], resource: '/agent/import-member' },
  { name: 'member pull', args: ['member', 'pull', 'navigator'], resource: '/agent/agent-sync/export-member' },
];

const scenarios = [
  { name: 'renews an expired access token', expired: true },
  { name: 'renews after the server rejects the access token', rejected: true },
  { name: 'asks for login when refresh fails', expired: true, refreshFails: true },
  { name: 'tries refresh first when expires_at is past', storedExpiry: true },
  { name: 'asks for login when a past expires_at cannot be renewed', storedExpiry: true, refreshFails: true },
  { name: 'asks for login when a past expires_at has no refresh token', storedExpiry: true, noRefresh: true },
  { name: 'keeps a valid token and profile unchanged', valid: true },
];

for (const command of commands) {
  for (const scenario of scenarios) {
    test(`${command.name}: ${scenario.name}`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-auth-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      const memberDir = path.join(workspace, 'atris', 'team', 'navigator');
      const profilePath = path.join(home, '.atris', 'profiles', 'sync-test.json');
      const globalPath = path.join(home, '.atris', 'credentials.json');
      fs.mkdirSync(path.dirname(profilePath), { recursive: true });
      fs.mkdirSync(memberDir, { recursive: true });
      fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), memberContent);
      fs.writeFileSync(path.join(workspace, 'atris', '.config'), JSON.stringify({ agent_id: 'agent-sync' }));
      fs.writeFileSync(path.join(workspace, 'atris', 'now.md'), localContent);

      const now = Math.floor(Date.now() / 1000);
      const originalToken = fakeJwt(scenario.expired ? now - 3600 : now + 3600);
      const renewedToken = fakeJwt(now + 7200);
      const originalRefresh = randomBytes(24).toString('hex');
      const renewedRefresh = randomBytes(24).toString('hex');
      const globalToken = fakeJwt(now + 3600);
      const credentials = {
        token: originalToken, refresh_token: scenario.noRefresh ? null : originalRefresh,
        email: user.email, user_id: user.id, provider: user.provider,
        expires_at: new Date((now + (scenario.storedExpiry ? -3600 : 3600)) * 1000).toISOString(),
      };
      const originalProfile = JSON.stringify(credentials);
      const originalGlobal = JSON.stringify({ token: globalToken });
      fs.writeFileSync(profilePath, originalProfile);
      fs.writeFileSync(globalPath, originalGlobal);

      const requests = [];
      let refreshBodyValid = true;
      let validateBodyValid = true;
      let resourceAuthValid = true;
      let pushedLocalContent = false;
      const expectedToken = scenario.valid ? originalToken : renewedToken;
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/api/, '');
          requests.push(pathname);
          const raw = Buffer.concat(chunks).toString();
          let body;
          try { body = JSON.parse(raw); } catch { body = null; }
          const reply = (status, data, type = 'application/json') => {
            res.writeHead(status, { 'Content-Type': type });
            res.end(type === 'application/json' ? JSON.stringify(data) : data);
          };
          if (pathname === '/auth/refresh') {
            refreshBodyValid &&= body?.refresh_token === originalRefresh;
            if (scenario.refreshFails) return reply(401, { detail: 'Refresh rejected' });
            return reply(200, { access_token: renewedToken, refresh_token: renewedRefresh, user });
          }
          if (pathname === '/auth/validate') {
            validateBodyValid &&= req.headers.authorization === `Bearer ${body?.token}`;
            const accepted = body?.token === renewedToken || (scenario.valid && body?.token === originalToken);
            return accepted ? reply(200, { valid: true, user }) : reply(401, { detail: 'Token expired' });
          }
          const authorized = req.headers.authorization === `Bearer ${expectedToken}`;
          resourceAuthValid &&= authorized;
          if (!authorized) return reply(401, { detail: 'Token expired' });

          if (pathname === '/business/') {
            return reply(200, [{ id: 'biz-sync', workspace_id: 'workspace-sync', slug: 'sync-co', name: 'Sync Co' }]);
          }
          if (pathname.endsWith('/snapshot')) {
            return reply(200, { files: [{
              path: 'atris/now.md', content: cloudContent,
              hash: createHash('sha256').update(cloudContent).digest('hex'),
            }] });
          }
          if (pathname.endsWith('/sync')) {
            pushedLocalContent = body?.files?.some(file => file.path === 'atris/now.md' && file.content === localContent);
            return reply(200, { results: (body?.files || []).map(file => ({ path: file.path, status: 'written' })) });
          }
          if (pathname === '/agent/import-member') {
            pushedLocalContent = raw === memberContent;
            return reply(200, { agent_id: 'agent-sync' });
          }
          if (pathname === '/agent/agent-sync/export-member') return reply(200, memberContent, 'text/markdown');
          if (pathname === '/agent/agent-sync/export-journal') return reply(200, { files: [] });
          if (pathname.startsWith('/agents/agent-sync/journal/')) return reply(200, { content: cloudContent });
          if (pathname === '/atris-sync/telemetry') return reply(200, {});
          return reply(404, { detail: 'Unexpected test endpoint' });
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise(resolve => server.close(resolve)));

      const env = scrubAgentEnv();
      // Remove inherited login, backend, and state overrides before selecting
      // this fixture. No real credentials or services are used by these tests.
      for (const key of Object.keys(env)) {
        if (key.startsWith('ATRIS_')) delete env[key];
      }
      Object.assign(env, {
        HOME: home, ATRIS_PROFILE: 'sync-test',
        ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`,
        ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1',
      });
      const result = await runCli(command.args, workspace, env);
      for (const value of [originalToken, renewedToken, originalRefresh, renewedRefresh, globalToken]) {
        assert.ok(!result.output.includes(value), 'CLI output must not contain credentials');
      }
      assert.equal(result.signal, null);
      assert.ok(refreshBodyValid, 'refresh must use the selected profile');
      assert.ok(validateBodyValid, 'validation must use the same credential in its header and body');
      assert.ok(resourceAuthValid, 'sync must use the validated or renewed access token');
      assert.ok(fs.readFileSync(globalPath, 'utf8') === originalGlobal, 'global login must stay unchanged');

      if (scenario.refreshFails || scenario.noRefresh) {
        assert.equal(result.status, 1);
        assert.ok(result.output.includes('Session expired. Run: atris login'), 'failed renewal must explain how to log in');
        assert.equal(requests.includes('/auth/refresh'), !scenario.noRefresh, 'renewal requires a refresh token');
        assert.ok(requests.every(p => p.startsWith('/auth/')), 'failed renewal must stop before sync');
        assert.ok(fs.readFileSync(profilePath, 'utf8') === originalProfile, 'failed renewal must keep the profile');
        assert.ok(fs.readFileSync(path.join(workspace, 'atris', 'now.md'), 'utf8') === localContent);
        return;
      }

      assert.equal(result.status, 0, 'sync must succeed');
      assert.ok(requests.some(p => p.includes(command.resource)), 'the requested sync operation must reach the API');
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      if (scenario.valid) {
        assert.ok(!requests.includes('/auth/refresh'), 'valid credentials must not refresh');
        assert.ok(fs.readFileSync(profilePath, 'utf8') === originalProfile, 'valid profile must stay unchanged');
      } else {
        assert.equal(requests.filter(p => p === '/auth/refresh').length, 1);
        assert.ok(profile.token === renewedToken, 'renewed access token must persist to the selected profile');
        assert.ok(profile.refresh_token === renewedRefresh, 'rotated refresh token must persist to the selected profile');
        assert.ok(!('source_profile' in profile), 'source metadata must stay out of the profile file');
      }
      if (scenario.storedExpiry) assert.equal(requests[0], '/auth/refresh', 'past expires_at must refresh before validation or sync');
      if (scenario.rejected) assert.equal(requests[0], '/auth/validate', 'server rejection must trigger the fallback refresh');
      if (command.name.endsWith('push')) assert.ok(pushedLocalContent, 'push must send the original local content');
      if (command.name === 'business pull') {
        assert.ok(fs.readFileSync(path.join(workspace, 'sync-co', 'atris', 'now.md'), 'utf8') === cloudContent);
      }
      if (command.name === 'journal pull') {
        const logsDir = path.join(workspace, 'atris', 'logs');
        const journals = fs.readdirSync(logsDir, { recursive: true }).filter(file => file.endsWith('.md'));
        assert.equal(journals.length, 3, 'journal pull must write all three requested days');
        assert.ok(journals.every(file => fs.readFileSync(path.join(logsDir, file), 'utf8') === cloudContent));
      }
      if (command.name === 'member pull') {
        assert.ok(fs.readFileSync(path.join(memberDir, 'MEMBER.md'), 'utf8') === memberContent);
      }
    });
  }
}

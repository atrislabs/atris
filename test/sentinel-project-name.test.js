'use strict';

// One folder, one project name on the dashboard: every Sentinel upload path
// names a repo the same way (git remote repo name, else folder name).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const events = require('../lib/sentinel-events');
const guard = require('../lib/sentinel-guard');
const agents = require('../lib/sentinel-agents');
const watch = require('../lib/sentinel-watch');
const audit = require('../lib/security-audit');
const cloud = require('../lib/sentinel-cloud');

function makeRepo(remote) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-name-'));
  const root = path.join(parent, 'local-folder');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'run.js'), "const { execSync } = require('child_process');\nmodule.exports = (t) => execSync(`echo ${t}`);\n");
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root });
  git('init', '-q');
  if (remote) git('remote', 'add', 'origin', remote);
  git('add', '.');
  git('commit', '-qm', 'init');
  return { parent, root };
}

// Every path that puts a project name into an upload, for one folder.
async function namesFrom(root, home) {
  const env = { HOME: home };
  const names = {};
  names.events = events.repoName(root);
  names.guard_from_subfolder = guard.projectName(path.join(root, 'lib'));
  names.agents = agents.toEvents({ root, findings: [{ severity: 'high', title: 'A secret key is pasted into one of your agent files.', fix: '', fingerprint: 'f-000000000001' }] })[0].repo;
  names.watch = watch.toEvents({ root, affected: [{ severity: 'high', ecosystem: 'npm', name: 'left-pad', version: '1.0.0', fixed: '1.0.1', advisories: [] }] })[0].repo;
  guard.recordBlock({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, cwd: path.join(root, 'lib') }, guard.decide({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } }, { env }), { env });
  names.guard_queue = JSON.parse(fs.readFileSync(events.queuePath(env), 'utf8').trim().split('\n').pop()).repo;
  const run = await audit.runAudit({ root, profile: 'quick', planOnly: true });
  names.review = run.meta.repo;
  names.review_upload = cloud.buildUploadBody(run.dir).repo;
  return names;
}

async function check(remote, expected) {
  const { parent, root } = makeRepo(remote);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-name-home-'));
  const prev = process.env.ATRIS_SECURITY_AUDIT_HOME;
  process.env.ATRIS_SECURITY_AUDIT_HOME = path.join(home, 'audits');
  try {
    const names = await namesFrom(root, home);
    for (const [where, name] of Object.entries(names)) assert.strictEqual(name, expected, `${where} named it ${name}`);
  } finally {
    if (prev === undefined) delete process.env.ATRIS_SECURITY_AUDIT_HOME; else process.env.ATRIS_SECURITY_AUDIT_HOME = prev;
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('with a git remote every sentinel upload names the project after the remote repo', () => check('git@github.com:acme/widget-api.git', 'widget-api'));

test('an https remote gives the same name', () => check('https://github.com/acme/widget-api.git', 'widget-api'));

test('without a remote every sentinel upload uses the folder name', () => check(null, 'local-folder'));

test('a remote name that is not a plain name is sent as project', () => check('https://example.com/acme/bad%20name', 'project'));

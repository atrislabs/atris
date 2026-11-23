'use strict';

// sentinel agents, machine setup area: synced folders, delete guards that
// live only in a shell alias, and cloud logins that default to production.
// A fake home folder; nothing on this machine is read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agents = require('../lib/sentinel-agents');

function fakeHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-setup-home-')));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function setupRules(result) {
  return result.findings.filter((f) => f.area === 'setup').map((f) => f.rule).sort();
}

test('a project inside iCloud Drive is flagged, one outside is not', () => {
  const home = fakeHome();
  try {
    const synced = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'app');
    const plain = path.join(home, 'code', 'app');
    fs.mkdirSync(synced, { recursive: true });
    fs.mkdirSync(plain, { recursive: true });
    assert.deepStrictEqual(setupRules(agents.runAgentCheck(synced, { homeDir: home })), ['synced-folder']);
    assert.deepStrictEqual(setupRules(agents.runAgentCheck(plain, { homeDir: home })), []);
    const r = agents.runAgentCheck(synced, { homeDir: home });
    assert.strictEqual(r.areas.setup.grade, 'warn');
    assert.ok(!agents.renderReport(r).includes(':0'), 'a whole-folder finding prints no line number');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a symlink into Dropbox counts as synced', () => {
  const home = fakeHome();
  try {
    const real = path.join(home, 'Dropbox', 'app');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(home, 'app-link');
    fs.symlinkSync(real, link);
    assert.deepStrictEqual(setupRules(agents.runAgentCheck(link, { homeDir: home })), ['synced-folder']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('with --home: an rm alias and a production default context are flagged, by name only', () => {
  const home = fakeHome();
  try {
    const project = path.join(home, 'code', 'app');
    fs.mkdirSync(project, { recursive: true });
    write(path.join(home, '.zshrc'), 'export PATH=$PATH:/x\nalias rm="trash"\nalias ll="ls -l"\n');
    write(path.join(home, '.kube', 'config'), 'apiVersion: v1\ncurrent-context: acme-prod-us\nusers:\n- name: x\n  user:\n    token: abc123secretvalue\n');
    write(path.join(home, '.config', 'gcloud', 'configurations', 'config_default'), '[core]\nproject = acme-staging\n');
    const r = agents.runAgentCheck(project, { home: true, homeDir: home });
    assert.deepStrictEqual(setupRules(r), ['alias-only-guard', 'prod-default-context']);
    const kube = r.findings.find((f) => f.rule === 'prod-default-context');
    assert.strictEqual(kube.file, '~/.kube/config');
    assert.strictEqual(kube.line, 2);
    assert.ok(!JSON.stringify(r).includes('abc123secretvalue'), 'a token in the kube config never appears');
    assert.ok(!r.findings.some((f) => f.area === 'secrets'), 'shell and cloud files are not judged as agent files');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('without --home the machine files are not read', () => {
  const home = fakeHome();
  try {
    const project = path.join(home, 'code', 'app');
    fs.mkdirSync(project, { recursive: true });
    write(path.join(home, '.zshrc'), 'alias rm="trash"\n');
    write(path.join(home, '.kube', 'config'), 'current-context: production\n');
    assert.deepStrictEqual(setupRules(agents.runAgentCheck(project, { homeDir: home })), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('names that only contain the letters prod are not production', () => {
  const home = fakeHome();
  try {
    const project = path.join(home, 'code', 'app');
    fs.mkdirSync(project, { recursive: true });
    write(path.join(home, '.kube', 'config'), 'current-context: product-dev\n');
    write(path.join(home, '.config', 'gcloud', 'configurations', 'config_default'), '[core]\nproject = prodigy-test\n');
    assert.deepStrictEqual(setupRules(agents.runAgentCheck(project, { home: true, homeDir: home })), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

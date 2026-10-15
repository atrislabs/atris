#!/usr/bin/env node
// The judge for "Campaigns live in the cloud, web, and iOS". It passes only
// when a person can see and answer a campaign from every surface:
//
//   backend  the production API lists this person's campaigns
//   synced   a campaign started on this computer is in that list
//   web      the web app serves its campaigns API (exists = 401 or 200, not 404)
//   ios      terrace's merged code has the campaigns screen and builds
//
//   node scripts/campaign-live-check.js [--json] [--skip-ios-build] [--campaign <id>]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const WEB = process.env.ATRIS_WEB_URL || 'https://atris.ai';
function siblings() {
  const repo = path.resolve(__dirname, '..');
  const { mainCheckoutRoot } = require('../lib/engine-registry');
  return path.dirname(mainCheckoutRoot(repo) || repo);
}

const TERRACE = process.env.ATRIS_TERRACE_REPO || path.join(siblings(), 'terrace');

function get(url, token) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', (error) => resolve({ status: 0, body: error.message }));
  });
}

function token() {
  try {
    const { loadCredentials } = require('../utils/auth');
    const credentials = loadCredentials();
    return credentials && credentials.token ? credentials.token : '';
  } catch {
    return '';
  }
}

function apiBase() {
  try {
    return require('../utils/api').getApiBaseUrl();
  } catch {
    return 'https://api.atris.ai/api';
  }
}

async function checkBackend(campaignId) {
  const auth = token();
  if (!auth) return [{ name: 'backend', pass: false, detail: 'not logged in here: run atris login' }, { name: 'synced', pass: false, detail: 'needs the backend check' }];
  const res = await get(`${apiBase()}/campaigns`, auth);
  let body = null;
  try { body = JSON.parse(res.body); } catch {}
  const listed = res.status === 200 && body && body.ok && Array.isArray(body.campaigns);
  const backend = { name: 'backend', pass: Boolean(listed), detail: listed ? `${body.campaigns.length} campaigns listed` : `GET /campaigns answered ${res.status}` };
  const found = listed && body.campaigns.some((c) => c.id === campaignId);
  const synced = { name: 'synced', pass: Boolean(found), detail: found ? `${campaignId} is in the cloud` : `${campaignId} is not in the cloud yet (atris campaign sync ${campaignId})` };
  return [backend, synced];
}

async function checkWeb() {
  const res = await get(`${WEB}/api/campaigns`);
  const live = res.status === 200 || res.status === 401;
  return { name: 'web', pass: live, detail: live ? `${WEB}/api/campaigns is served (${res.status})` : `${WEB}/api/campaigns answered ${res.status}` };
}

function checkIos(skipBuild) {
  if (!fs.existsSync(path.join(TERRACE, '.git'))) return { name: 'ios', pass: false, detail: `no terrace checkout at ${TERRACE}` };
  const git = (args) => spawnSync('git', ['-C', TERRACE, ...args], { encoding: 'utf8', timeout: 120000 });
  if (git(['fetch', '--quiet', 'origin', 'master']).status !== 0) return { name: 'ios', pass: false, detail: 'could not fetch terrace origin/master' };
  const files = git(['ls-tree', '-r', '--name-only', 'FETCH_HEAD', 'votd']).stdout.split('\n');
  const screen = files.find((f) => /Campaigns?(Store|View|Page|List)\.swift$/.test(f) && !/CampaignView\.swift$/.test(f));
  if (!screen) return { name: 'ios', pass: false, detail: 'terrace master has no campaigns screen yet' };
  if (skipBuild) return { name: 'ios', pass: true, detail: `${screen} is merged (build skipped)` };
  const dir = path.join(fs.realpathSync(os.tmpdir()), `terrace-judge-${process.pid}`);
  if (git(['worktree', 'add', '--detach', '--quiet', dir, 'FETCH_HEAD']).status !== 0) return { name: 'ios', pass: false, detail: 'could not check out terrace master' };
  try {
    const build = spawnSync('xcodebuild', ['-project', 'votd.xcodeproj', '-scheme', 'votd', '-destination', 'generic/platform=iOS', '-quiet', 'CODE_SIGNING_ALLOWED=NO', 'build'], { cwd: dir, encoding: 'utf8', timeout: 20 * 60 * 1000 });
    return { name: 'ios', pass: build.status === 0, detail: build.status === 0 ? `${screen} is merged and terrace builds` : `terrace master does not build: ${String(build.stderr || build.stdout).trim().split('\n').slice(-1)[0]}` };
  } finally {
    git(['worktree', 'remove', '--force', dir]);
  }
}

async function main(argv) {
  const json = argv.includes('--json');
  const at = argv.indexOf('--campaign');
  const campaignId = at >= 0 ? argv[at + 1] : 'cmp-campaigns-live';
  const results = [...await checkBackend(campaignId), await checkWeb(), checkIos(argv.includes('--skip-ios-build'))];
  const passing = results.filter((r) => r.pass).length;
  if (json) console.log(JSON.stringify({ passed: passing === results.length, results }, null, 2));
  else {
    for (const r of results) console.log(`${r.name.padEnd(8)} ${r.pass ? 'pass' : 'fail'}  ${r.detail}`);
    console.log(`${passing} of ${results.length} live`);
  }
  return passing === results.length ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { main };

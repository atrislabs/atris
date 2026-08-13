'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');

const RUNNER_VERSION = '2.336.0';
const GITHUB_API_VERSION = '2026-03-10';

function runnerAssetName(platform, arch, version = RUNNER_VERSION) {
  const platformNames = { darwin: 'osx', linux: 'linux' };
  const archNames = { x64: 'x64', arm64: 'arm64' };
  const runnerPlatform = platformNames[platform];
  const runnerArch = archNames[arch];
  if (!runnerPlatform || !runnerArch) {
    throw new Error(`unsupported runner platform: ${platform}/${arch}`);
  }
  return `actions-runner-${runnerPlatform}-${runnerArch}-${version}.tar.gz`;
}

function parseRepo(value) {
  if (typeof value !== 'string') throw new Error('--repo owner/name is required');
  const parts = value.trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('--repo must use owner/name');
  }
  const [owner, repo] = parts;
  const validOwner = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
  const validRepo = /^[a-z0-9_.-]{1,100}$/i;
  if (!validOwner.test(owner) || !validRepo.test(repo) || repo === '.' || repo === '..') {
    throw new Error('--repo must use a valid owner/name');
  }
  return { owner, repo, slug: `${owner}/${repo}` };
}

function parseRunnerArgs(argv) {
  const options = { label: null, once: false };
  let repoValue = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      if (repoValue !== null) throw new Error('--repo may only be set once');
      repoValue = argv[index + 1];
      if (!repoValue || repoValue.startsWith('--')) throw new Error('--repo owner/name is required');
      index += 1;
    } else if (arg === '--label') {
      if (options.label !== null) throw new Error('--label may only be set once');
      options.label = argv[index + 1];
      if (!options.label || options.label.startsWith('--')) throw new Error('--label name is required');
      if (!/^[a-z0-9_.-]+$/i.test(options.label)) {
        throw new Error('--label must contain only letters, numbers, dots, underscores, or hyphens');
      }
      index += 1;
    } else if (arg === '--once') {
      if (options.once) throw new Error('--once may only be set once');
      options.once = true;
    } else {
      throw new Error(`unknown ci runner option: ${arg}`);
    }
  }

  return { repo: parseRepo(repoValue), label: options.label, once: options.once };
}

function buildJitConfigRequest(repo, label, runnerName) {
  const labels = label && label !== 'atris' ? ['atris', label] : ['atris'];
  return {
    path: `/repos/${repo.owner}/${repo.repo}/actions/runners/generate-jitconfig`,
    body: {
      name: runnerName,
      runner_group_id: 1,
      labels,
      work_folder: '_work',
    },
  };
}

function resolveGithubToken(env = process.env, run = spawnSync) {
  const envToken = String(env.GITHUB_TOKEN || '').trim();
  if (envToken) return envToken;
  const result = run('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const ghToken = result && result.status === 0 ? String(result.stdout || '').trim() : '';
  if (ghToken) return ghToken;
  throw new Error('github token required: set GITHUB_TOKEN or run gh auth login');
}

function requestJson(options, body, request = https.request) {
  return new Promise((resolve, reject) => {
    const req = request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          reject(new Error('github returned an unreadable response'));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = String(parsed.message || `github request failed with status ${response.statusCode}`)
            .replace(/\s+/g, ' ')
            .trim();
          reject(new Error(message.toLowerCase()));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function generateJitConfig(token, repo, label, runnerName, request = https.request) {
  const spec = buildJitConfigRequest(repo, label, runnerName);
  const body = JSON.stringify(spec.body);
  const response = await requestJson({
    hostname: 'api.github.com',
    path: spec.path,
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'atris-ci-runner',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  }, body, request);
  if (!response.encoded_jit_config) throw new Error('github did not return a runner configuration');
  return response.encoded_jit_config;
}

function downloadFile(url, destination, get = https.get, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { 'User-Agent': 'atris-ci-runner' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft === 0) {
          reject(new Error('runner download followed too many redirects'));
          return;
        }
        const nextUrl = new URL(response.headers.location, url);
        if (nextUrl.protocol !== 'https:') {
          reject(new Error('runner download redirected outside https'));
          return;
        }
        downloadFile(nextUrl.toString(), destination, get, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`runner download failed with status ${response.statusCode}`));
        return;
      }
      const output = fs.createWriteStream(destination);
      output.on('error', reject);
      response.on('error', reject);
      output.on('finish', () => output.close(resolve));
      response.pipe(output);
    });
    request.on('error', reject);
  });
}

async function ensureRunner(options = {}) {
  const version = options.version || RUNNER_VERSION;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const home = options.home || os.homedir();
  const log = options.log || console.log;
  const asset = runnerAssetName(platform, arch, version);
  const runnerPlatform = platform === 'darwin' ? 'osx' : platform;
  const runnerDir = path.join(home, '.atris', 'ci', version, `${runnerPlatform}-${arch}`);
  const runScript = path.join(runnerDir, 'run.sh');
  if (fs.existsSync(runScript)) return runnerDir;

  const cacheDir = path.join(home, '.atris', 'ci');
  const archive = path.join(cacheDir, asset);
  fs.mkdirSync(runnerDir, { recursive: true });
  if (!fs.existsSync(archive)) {
    const partial = `${archive}.download-${process.pid}`;
    log(`downloading github actions runner ${version}`);
    try {
      await (options.download || downloadFile)(
        `https://github.com/actions/runner/releases/download/v${version}/${asset}`,
        partial,
      );
      fs.renameSync(partial, archive);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      throw error;
    }
  }

  const extract = (options.spawnSync || spawnSync)('tar', ['-xzf', archive, '-C', runnerDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (extract.error || extract.status !== 0) {
    const detail = String(extract.stderr || extract.error?.message || 'tar failed').replace(/\s+/g, ' ').trim();
    throw new Error(`could not extract github actions runner: ${detail.toLowerCase()}`);
  }
  if (!fs.existsSync(runScript)) throw new Error('github actions runner archive did not contain run.sh');
  fs.chmodSync(runScript, 0o755);
  return runnerDir;
}

function runWorker(runnerDir, jitConfig, start = spawn) {
  return new Promise((resolve, reject) => {
    const child = start('./run.sh', ['--jitconfig', jitConfig], {
      cwd: runnerDir,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else if (signal) {
        reject(new Error(`github actions runner stopped with signal ${signal}`));
      } else {
        reject(new Error(`github actions runner exited with code ${code}`));
      }
    });
  });
}

async function runJobLoop(options, dependencies = {}) {
  const mint = dependencies.generateJitConfig || generateJitConfig;
  const startWorker = dependencies.runWorker || runWorker;
  const shouldContinue = dependencies.shouldContinue || ((state) => !state.once);
  const log = dependencies.log || console.log;
  let completedJobs = 0;

  while (true) {
    const runnerName = `${options.runnerName}-${completedJobs + 1}`;
    const jitConfig = await mint(options.token, options.repo, options.label, runnerName);
    log(`worker ready, waiting for jobs on ${options.repo.slug}`);
    await startWorker(options.runnerDir, jitConfig);
    completedJobs += 1;
    if (!shouldContinue({ once: options.once, completedJobs })) return completedJobs;
  }
}

async function runCiRunner(options, dependencies = {}) {
  const token = (dependencies.resolveGithubToken || resolveGithubToken)();
  const runnerDir = await (dependencies.ensureRunner || ensureRunner)({ log: dependencies.log });
  const host = String((dependencies.hostname || os.hostname)()).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return runJobLoop({
    ...options,
    token,
    runnerDir,
    runnerName: `atris-${host || 'worker'}-${process.pid}`,
  }, dependencies);
}

module.exports = {
  buildJitConfigRequest,
  parseRunnerArgs,
  runCiRunner,
  runJobLoop,
  runnerAssetName,
};

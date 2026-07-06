'use strict';

/**
 * atris study — on-demand learning feed + tutor-loop routing.
 *
 *   atris study <topic…> [--personal]
 *
 * Runs learning-feed ingest in the fixed backend repo, ensures the local feed
 * server is up, opens the feed in the browser, and prints tutor-loop guidance
 * for language topics.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const BACKEND_ROOT = '/Users/keshavrao/arena/atrisos-backend';
const FEED_URL = 'http://localhost:8777';
const FEED_STATS_URL = `${FEED_URL}/api/stats`;
const FEED_PORT = 8777;
const PROBE_TIMEOUT_MS = 2000;
const SERVER_WAIT_MS = 8000;
const SERVER_POLL_MS = 400;

const LANGUAGE_TOPICS = new Set([
  'spanish', 'french', 'italian', 'portuguese', 'german',
  'japanese', 'mandarin', 'chinese', 'korean', 'hindi',
]);

function showHelp() {
  console.log(`\n  atris study — learn a topic on demand (learning feed + tutor loop)\n
  Usage:
    atris study <topic…> [--personal]

  Adds the topic to your local learning feed, ingests fresh cards, starts the
  feed server if needed, and opens http://localhost:8777 in your browser.

  --personal   also scan workspace briefs for personal-edge cards

  Examples:
    atris study spanish
    atris study "ai research" --personal
    atris study biology-of-disease
`);
}

function parseArgs(argv = []) {
  const opts = { personal: false, help: false };
  const topicParts = [];

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--personal') {
      opts.personal = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    topicParts.push(arg);
  }

  opts.topic = topicParts.join(' ').trim();
  return opts;
}

function requireBackend() {
  if (!fs.existsSync(BACKEND_ROOT)) {
    console.error(`✗ Backend repo not found: ${BACKEND_ROOT}`);
    process.exit(1);
  }
  const venvPython = path.join(BACKEND_ROOT, 'venv/bin/python');
  if (!fs.existsSync(venvPython)) {
    console.error(`✗ Backend venv not found: ${venvPython}`);
    console.error('  Create the venv in atrisos-backend before running atris study.');
    process.exit(1);
  }
  return venvPython;
}

function detectLanguage(topic) {
  const normalized = String(topic || '').toLowerCase().trim();
  if (LANGUAGE_TOPICS.has(normalized)) return normalized;
  for (const word of normalized.split(/\s+/)) {
    if (LANGUAGE_TOPICS.has(word)) return word;
  }
  return null;
}

function printTutorLoopBlock(backendRoot, language) {
  const tutorDb = path.join(backendRoot, 'experiments/tutor-loop/tutor.db');
  const hasDb = fs.existsSync(tutorDb);

  console.log('\n── Tutor loop (production drills) ──');
  if (!hasDb) {
    console.log('  Init (run once from backend repo):');
    console.log('    venv/bin/python experiments/tutor-loop/tutor.py init');
  } else {
    console.log('  Tutor DB ready: experiments/tutor-loop/tutor.db');
  }

  console.log('\n  Daily flow:');
  console.log('    venv/bin/python experiments/tutor-loop/tutor.py tick');
  console.log('    venv/bin/python experiments/tutor-loop/tutor.py reply "<your answers>"');
  console.log('    venv/bin/python experiments/tutor-loop/tutor.py receipt');
  console.log('\n  Scan (iMessage replies):');
  console.log('    venv/bin/python experiments/tutor-loop/tutor.py scan');

  if (language !== 'spanish') {
    console.log('\n  curriculum not yet built — spanish ships today');
  }
  console.log('');
}

function probeFeedStats(timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(FEED_STATS_URL, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnFeedServer(venvPython, backendRoot) {
  const logDir = path.join(backendRoot, 'atris/logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'learning-feed.server.log');
  const logFd = fs.openSync(logPath, 'a');

  const proc = spawn(venvPython, ['experiments/learning-feed/app.py'], {
    cwd: backendRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  proc.unref();
  fs.closeSync(logFd);
  console.log(`  Feed server starting (log: atris/logs/learning-feed.server.log)`);
  return proc.pid;
}

async function ensureFeedServer(venvPython, backendRoot) {
  if (await probeFeedStats()) {
    console.log('  Feed server already running.');
    return;
  }

  spawnFeedServer(venvPython, backendRoot);
  const deadline = Date.now() + SERVER_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(SERVER_POLL_MS);
    if (await probeFeedStats()) {
      console.log(`  Feed server ready on port ${FEED_PORT}.`);
      return;
    }
  }
  console.error(`✗ Feed server did not respond on port ${FEED_PORT} within ${SERVER_WAIT_MS / 1000}s.`);
  console.error(`  Check atris/logs/learning-feed.server.log in the backend repo.`);
  process.exit(1);
}

function runIngest(venvPython, backendRoot, topic, personal) {
  return new Promise((resolve, reject) => {
    const args = ['experiments/learning-feed/ingest.py', 'learn', topic];
    if (personal) args.push('--personal');

    console.log(`\n  Ingest: venv/bin/python ${args.join(' ')}\n`);
    const proc = spawn(venvPython, args, {
      cwd: backendRoot,
      stdio: 'inherit',
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ingest.py learn exited with code ${code}`));
    });
  });
}

function openFeed() {
  if (process.platform === 'darwin') {
    spawnSync('open', [FEED_URL], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', FEED_URL], { stdio: 'ignore' });
  } else {
    spawnSync('xdg-open', [FEED_URL], { stdio: 'ignore' });
  }
  console.log(`\n  Opened ${FEED_URL}`);
}

async function run(argv = []) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    showHelp();
    return 1;
  }

  if (opts.help || !opts.topic) {
    showHelp();
    return 0;
  }

  const venvPython = requireBackend();
  const language = detectLanguage(opts.topic);

  if (language) {
    printTutorLoopBlock(BACKEND_ROOT, language);
  }

  try {
    await runIngest(venvPython, BACKEND_ROOT, opts.topic, opts.personal);
  } catch (err) {
    console.error(`\n✗ ${err.message || err}`);
    return 1;
  }

  await ensureFeedServer(venvPython, BACKEND_ROOT);
  openFeed();
  return 0;
}

module.exports = { run, parseArgs, detectLanguage, showHelp, BACKEND_ROOT };

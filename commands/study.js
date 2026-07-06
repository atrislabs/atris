'use strict';

/**
 * atris study — on-demand learning feed + tutor-loop routing + waiting-room cards.
 *
 *   atris study <topic…> [--personal]
 *   atris study --while "<cmd>" [topic…] [--personal]
 *
 * Runs learning-feed ingest in the fixed backend repo, ensures the local feed
 * server is up, opens the feed in the browser, and prints tutor-loop guidance
 * for language topics. --while serves terminal cards while a shell command runs.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const BACKEND_ROOT = '/Users/keshavrao/arena/atrisos-backend';
const FEED_URL = 'http://localhost:8777';
const FEED_STATS_URL = `${FEED_URL}/api/stats`;
const FEED_NEXT_URL = `${FEED_URL}/api/next`;
const FEED_ANSWER_URL = `${FEED_URL}/api/answer`;
const FEED_PORT = 8777;
const PROBE_TIMEOUT_MS = 2000;
const SERVER_WAIT_MS = 8000;
const SERVER_POLL_MS = 400;
const CARD_WRAP_COLS = 60;
const NAME_TAG = 'Atris ▸';

const LANGUAGE_TOPICS = new Set([
  'spanish', 'french', 'italian', 'portuguese', 'german',
  'japanese', 'mandarin', 'chinese', 'korean', 'hindi',
]);

function showHelp() {
  console.log(`\n  atris study — learn a topic on demand (learning feed + tutor loop)\n
  Usage:
    atris study <topic…> [--personal]
    atris study --while "<cmd>" [topic…] [--personal]

  Adds the topic to your local learning feed, ingests fresh cards, starts the
  feed server if needed, and opens http://localhost:8777 in your browser.

  --while "<cmd>"   run a shell command while serving learning cards in the
                    terminal; on exit replays captured stdout/stderr and exits
                    with the child's code. Cards use dialogue beats (Atris ▸,
                    claim, why; probes: question → space reveal → c/w grade).
                    Space advances. q stops cards and live-streams build output.
                    Ctrl+C kills the child and replays output so far (exit 130).
                    Non-TTY stdin = plain passthrough (no cards). If the feed
                    server is down, the command still runs — cards are skipped.

  --personal   also scan workspace briefs for personal-edge cards

  Examples:
    atris study spanish
    atris study "ai research" --personal
    atris study --while "npm run build"
    atris study --while "npm run build" spanish
`);
}

function parseArgs(argv = []) {
  const opts = { personal: false, help: false, whileCmd: null };
  const topicParts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--while') {
      i += 1;
      if (i >= argv.length) throw new Error('--while requires a command string');
      opts.whileCmd = argv[i];
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

function httpGetJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function httpPostJson(url, payload, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.write(data);
    req.end();
  });
}

function spawnFeedServer(venvPython, backendRoot, quiet = false) {
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
  if (!quiet) {
    console.log('  Feed server starting (log: atris/logs/learning-feed.server.log)');
  }
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
  console.error('  Check atris/logs/learning-feed.server.log in the backend repo.');
  process.exit(1);
}

async function tryEnsureFeedServerSilent(venvPython, backendRoot) {
  if (await probeFeedStats()) return true;

  try {
    spawnFeedServer(venvPython, backendRoot, true);
  } catch {
    return false;
  }

  const deadline = Date.now() + SERVER_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(SERVER_POLL_MS);
    if (await probeFeedStats()) return true;
  }
  return false;
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

function wrapText(text, width = CARD_WRAP_COLS) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const next = `${line} ${words[i]}`;
    if (next.length <= width) {
      line = next;
    } else {
      lines.push(line);
      line = words[i];
    }
  }
  lines.push(line);
  return lines;
}

function restoreTty() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

function replayCaptured(chunks) {
  for (const chunk of chunks) {
    if (chunk.stream === 'stderr') {
      process.stderr.write(chunk.data);
    } else {
      process.stdout.write(chunk.data);
    }
  }
}

function createWhileChild(cmd) {
  const chunks = [];
  let exitCode = 0;
  let running = true;
  let liveStream = false;
  let replayIndex = 0;

  const child = spawn(cmd, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  function append(stream, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    chunks.push({ stream, data: buf });
    if (liveStream) {
      if (stream === 'stderr') process.stderr.write(buf);
      else process.stdout.write(buf);
    }
  }

  child.stdout.on('data', (data) => append('stdout', data));
  child.stderr.on('data', (data) => append('stderr', data));

  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      running = false;
      exitCode = code == null ? 1 : code;
      resolve(exitCode);
    });
    child.on('error', () => {
      running = false;
      exitCode = 1;
      resolve(exitCode);
    });
  });

  function startLiveStream() {
    liveStream = true;
    while (replayIndex < chunks.length) {
      const chunk = chunks[replayIndex];
      if (chunk.stream === 'stderr') process.stderr.write(chunk.data);
      else process.stdout.write(chunk.data);
      replayIndex += 1;
    }
  }

  function killProcessGroup() {
    if (!child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }

  return {
    child,
    chunks,
    done,
    get running() { return running; },
    get exitCode() { return exitCode; },
    startLiveStream,
    killProcessGroup,
  };
}

async function fetchNextCard() {
  return httpGetJson(FEED_NEXT_URL, 3000);
}

async function postCardAnswer(cardId, action, dwellMs) {
  await httpPostJson(FEED_ANSWER_URL, {
    card_id: cardId == null ? null : cardId,
    action,
    dwell_ms: Math.max(0, Math.round(dwellMs || 0)),
  });
}

async function fetchFeedStats() {
  return httpGetJson(FEED_STATS_URL, 3000);
}

function renderCardScreen(lines) {
  process.stdout.write('\x1b[2J\x1b[H');
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

function cardLines(card, beat) {
  const lines = [NAME_TAG, ''];
  const isProbe = card.type === 'probe';

  if (isProbe && beat === 0) {
    lines.push(...wrapText('Remember this?'));
    lines.push('');
    lines.push('  space → reveal   q → show build output');
    return lines;
  }

  const claim = card.claim || '';
  const why = card.why || '';
  lines.push(...wrapText(claim));

  if (beat >= 1 || !isProbe) {
    lines.push('');
    lines.push(...wrapText(why));
  }

  lines.push('');
  if (isProbe && beat >= 1) {
    lines.push('  c correct · w wrong · space → next');
  } else if (isProbe) {
    lines.push('  space → reveal');
  } else if (beat === 0) {
    lines.push('  space → why');
  } else {
    lines.push('  space → next card · q → show build output');
  }

  return lines;
}

function waitForKeyOnce() {
  return new Promise((resolve) => {
    const onData = (buf) => {
      process.stdin.removeListener('data', onData);
      resolve(buf);
    };
    process.stdin.on('data', onData);
  });
}

async function waitForKeyOrChildDone(childState) {
  return Promise.race([
    waitForKeyOnce(),
    childState.done.then(() => ({ childDone: true })),
  ]);
}

async function runCardLoop(childState) {
  let cardsShown = 0;
  let currentCard = null;
  let beat = 0;
  let cardStart = Date.now();
  let cardsActive = true;

  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    while (childState.running && cardsActive) {
      if (!currentCard) {
        const next = await fetchNextCard();
        if (!next || !next.type) {
          await sleep(400);
          continue;
        }
        currentCard = next;
        beat = 0;
        cardStart = Date.now();
        cardsShown += 1;
      }

      renderCardScreen(cardLines(currentCard, beat));

      const input = await waitForKeyOrChildDone(childState);
      if (input && input.childDone) break;

      const keyBuf = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''));
      const byte = keyBuf[0];

      if (byte === 3) {
        restoreTty();
        childState.killProcessGroup();
        await sleep(100);
        replayCaptured(childState.chunks);
        process.exit(130);
      }

      const key = String.fromCharCode(byte).toLowerCase();

      if (key === 'q') {
        cardsActive = false;
        childState.startLiveStream();
        break;
      }

      const isProbe = currentCard.type === 'probe';

      if (key === 'c' && isProbe && beat >= 1) {
        await postCardAnswer(currentCard.card_id, 'correct', Date.now() - cardStart);
        currentCard = null;
        continue;
      }

      if (key === 'w' && isProbe && beat >= 1) {
        await postCardAnswer(currentCard.card_id, 'wrong', Date.now() - cardStart);
        currentCard = null;
        continue;
      }

      if (key !== ' ' && key !== '\r' && key !== '\n') continue;

      if (isProbe && beat === 0) {
        beat = 1;
        await postCardAnswer(currentCard.card_id, 'reveal', Date.now() - cardStart);
        continue;
      }

      if (isProbe && beat >= 1) {
        currentCard = null;
        continue;
      }

      if (beat === 0) {
        beat = 1;
        continue;
      }

      if (currentCard.card_id && currentCard.type !== 'progress' && currentCard.type !== 'deepdive') {
        await postCardAnswer(currentCard.card_id, 'skip', Date.now() - cardStart);
      }
      currentCard = null;
    }
  } finally {
    restoreTty();
  }

  if (!cardsActive && childState.running) {
    await childState.done;
  }

  return cardsShown;
}

async function printSessionLine(exitCode, cardsShown, statsAvailable) {
  let locked = 0;
  let retention = 0;
  if (statsAvailable) {
    const stats = await fetchFeedStats();
    if (stats) {
      locked = Number(stats.locked_total || 0);
      retention = Number(stats.retention_percent || 0);
    }
  }
  const cardPart = `${cardsShown} card${cardsShown === 1 ? '' : 's'}`;
  if (statsAvailable) {
    console.log(`done · exit ${exitCode} · ${cardPart} · ${locked} locked in · ${retention}% retention`);
  } else {
    console.log(`done · exit ${exitCode} · ${cardPart}`);
  }
}

async function runWhileCapture(cmd, { cards = false, statsAvailable = false } = {}) {
  const childState = createWhileChild(cmd);
  let cardsShown = 0;

  if (cards) {
    cardsShown = await runCardLoop(childState);
  } else {
    await childState.done;
  }

  restoreTty();
  await printSessionLine(childState.exitCode, cardsShown, statsAvailable);
  replayCaptured(childState.chunks);
  return childState.exitCode;
}

async function runWhileMode(opts) {
  const cmd = opts.whileCmd;
  const topic = opts.topic;

  if (topic) {
    const venvPython = requireBackend();
    const language = detectLanguage(topic);
    if (language) printTutorLoopBlock(BACKEND_ROOT, language);
    try {
      await runIngest(venvPython, BACKEND_ROOT, topic, opts.personal);
    } catch (err) {
      console.error(`\n✗ ${err.message || err}`);
    }
  }

  if (!process.stdin.isTTY) {
    return runWhileCapture(cmd, { cards: false, statsAvailable: false });
  }

  let statsAvailable = false;
  let useCards = false;

  if (fs.existsSync(BACKEND_ROOT) && fs.existsSync(path.join(BACKEND_ROOT, 'venv/bin/python'))) {
    const venvPython = path.join(BACKEND_ROOT, 'venv/bin/python');
    statsAvailable = await tryEnsureFeedServerSilent(venvPython, BACKEND_ROOT);
    useCards = statsAvailable;
  }

  return runWhileCapture(cmd, { cards: useCards, statsAvailable });
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

  if (opts.help) {
    showHelp();
    return 0;
  }

  if (opts.whileCmd) {
    if (!opts.whileCmd.trim()) {
      console.error('✗ --while requires a non-empty command string');
      showHelp();
      return 1;
    }
    return runWhileMode(opts);
  }

  if (!opts.topic) {
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

module.exports = {
  run,
  parseArgs,
  detectLanguage,
  showHelp,
  BACKEND_ROOT,
  wrapText,
  createWhileChild,
};

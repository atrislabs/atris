const { apiRequestJson } = require('../utils/api');
const { ensureValidCredentials } = require('../utils/auth');
const { spawnSync } = require('child_process');
const https = require('https');

const DEFAULT_QUERY = 'Extract main topics, key insights, and actionable takeaways.';
const DEFAULT_TIMEOUT_MS = 300000;
const LOCAL_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;
const LOCAL_TRANSCRIPT_MAX_CHARS = 250000;
const ALLOWED_CAPTION_HOST_SUFFIXES = [
  'youtube.com',
  'googlevideo.com',
  'youtubei.googleapis.com',
];

function showYoutubeHelp(output = console.log, commandName = 'atris youtube') {
  output('');
  output(`Usage: ${commandName} process <youtube-url> [options]`);
  output(`       ${commandName} <youtube-url> [options]`);
  output('');
  output('Process a YouTube video through Atris using transcript-first analysis.');
  output('');
  output('Options:');
  output('  --query, -q <text>  Focus question for the analysis');
  output('  --agent <id>        Agent id to store knowledge against');
  output('  --store             Save as agent knowledge (requires --agent)');
  output('  --timeout <sec>     Request timeout in seconds (default: 300)');
  output('  --json              Print the raw JSON response');
  output('  -h, --help          This help');
  output('');
  output('Examples:');
  output(`  ${commandName} https://www.youtube.com/watch?v=VIDEO_ID`);
  output(`  ${commandName} process https://youtu.be/VIDEO_ID --query "Key takeaways"`);
  output('');
}

function readValue(args, index, name) {
  if (index >= args.length - 1 || String(args[index + 1]).startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function parseTimeoutMs(raw) {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  return Math.round(seconds * 1000);
}

function parseYoutubeArgs(argv = []) {
  const args = [...argv];
  const options = {
    help: false,
    json: false,
    youtubeUrl: null,
    query: DEFAULT_QUERY,
    agentId: null,
    storeAsKnowledge: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0])) {
    options.help = true;
    return options;
  }

  if (['process', 'analyze', 'watch'].includes(args[0])) {
    args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--store' || arg === '--store-as-knowledge') {
      options.storeAsKnowledge = true;
    } else if (arg === '--query' || arg === '-q') {
      options.query = readValue(args, i, arg);
      i++;
    } else if (arg.startsWith('--query=')) {
      options.query = arg.slice('--query='.length);
    } else if (arg === '--agent' || arg === '--agent-id') {
      options.agentId = readValue(args, i, arg);
      i++;
    } else if (arg.startsWith('--agent=')) {
      options.agentId = arg.slice('--agent='.length);
    } else if (arg === '--timeout') {
      options.timeoutMs = parseTimeoutMs(readValue(args, i, arg));
      i++;
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = parseTimeoutMs(arg.slice('--timeout='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.youtubeUrl) {
      options.youtubeUrl = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.youtubeUrl) throw new Error('Missing YouTube URL. Run "atris youtube --help".');
  if (options.storeAsKnowledge && !options.agentId) {
    throw new Error('--store requires --agent <id>');
  }
  return options;
}

function buildYoutubePayload(options) {
  const payload = {
    youtube_url: options.youtubeUrl,
    query: options.query || DEFAULT_QUERY,
  };
  if (options.agentId) payload.agent_id = options.agentId;
  if (options.storeAsKnowledge) payload.store_as_knowledge = true;
  if (options.localTranscript?.transcriptText) {
    payload.transcript_text = options.localTranscript.transcriptText;
    if (options.localTranscript.language) payload.transcript_language = options.localTranscript.language;
    if (options.localTranscript.durationSeconds) payload.duration_seconds = options.localTranscript.durationSeconds;
  }
  if (options.cacheTranscript !== undefined) {
    payload.cache_transcript = Boolean(options.cacheTranscript);
  }
  return payload;
}

function resultErrorText(result) {
  const raw = result?.error || result?.text || 'unknown error';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function shouldRetryWithLocalTranscript(result) {
  if (!result || result.ok) return false;
  if (result.status === 502) return true;
  if (result.status !== 400) return false;
  return /YouTube video is not publicly accessible|oEmbed|metadata lookup failed/i.test(resultErrorText(result));
}

function youtubeFailureError(result) {
  const hint = result.status === 401
    ? ' Run "atris login --force".'
    : result.status === 402
      ? ' Check Atris credits.'
      : '';
  return new Error(`YouTube processing failed (${result.status}): ${resultErrorText(result)}.${hint}`);
}

function captionHostAllowed(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return ALLOWED_CAPTION_HOST_SUFFIXES.some((suffix) => (
      hostname === suffix || hostname.endsWith(`.${suffix}`)
    ));
  } catch {
    return false;
  }
}

function chooseCaptionTrack(info = {}) {
  const preferred = ['en', 'en-orig', 'en-US', 'en-GB'];
  const chooseFrom = (trackSets = {}) => {
    for (const language of preferred) {
      for (const track of trackSets[language] || []) {
        if (track?.url && ['json3', 'vtt', 'srv3', 'ttml'].includes(track.ext)) return { language, track };
      }
    }
    for (const [language, tracks] of Object.entries(trackSets)) {
      for (const track of tracks || []) {
        if (track?.url) return { language, track };
      }
    }
    return null;
  };

  return chooseFrom(info.subtitles) || chooseFrom(info.automatic_captions);
}

function fetchCaptionText(urlString, redirects = 0) {
  if (!captionHostAllowed(urlString)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const req = https.get(urlString, { timeout: 30000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        const nextUrl = new URL(res.headers.location, urlString).toString();
        resolve(fetchCaptionText(nextUrl, redirects + 1));
        return;
      }

      if (res.statusCode !== 200 || !captionHostAllowed(res.responseUrl || urlString)) {
        res.resume();
        resolve(null);
        return;
      }

      const contentLength = Number(res.headers['content-length'] || 0);
      if (contentLength > LOCAL_TRANSCRIPT_MAX_BYTES) {
        res.resume();
        resolve(null);
        return;
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > LOCAL_TRANSCRIPT_MAX_BYTES) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function parseCaptionText(raw) {
  const trimmed = String(raw || '').trimStart();
  if (!trimmed) return '';

  if (trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed);
      const segments = [];
      for (const event of payload.events || []) {
        const text = (event.segs || [])
          .map((piece) => piece.utf8 || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text) continue;
        if (segments[segments.length - 1] === text) continue;
        segments.push(text);
      }
      return segments.join(' ');
    } catch {
      return '';
    }
  }

  const segments = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (/^(WEBVTT|Kind:|Language:|NOTE|STYLE|REGION)/.test(stripped)) continue;
    if (stripped.includes('-->')) continue;
    if (/^\d+$/.test(stripped)) continue;
    if (stripped.includes('<c>') || stripped.includes('</c>')) continue;
    const text = stripped.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (segments[segments.length - 1] === text) continue;
    segments.push(text);
  }
  return segments.join(' ');
}

async function extractLocalTranscript(youtubeUrl, deps = {}) {
  if (process.env.ATRIS_YOUTUBE_LOCAL_TRANSCRIPT === '0') return null;
  const runner = deps.spawnSync || spawnSync;
  const result = runner('yt-dlp', ['-J', '--skip-download', '--no-warnings', youtubeUrl], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) return null;

  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const selected = chooseCaptionTrack(info);
  if (!selected?.track?.url) return null;
  const rawCaption = await (deps.fetchCaptionText || fetchCaptionText)(selected.track.url);
  const transcript = parseCaptionText(rawCaption);
  if (!transcript) return null;

  return {
    transcriptText: transcript.slice(0, LOCAL_TRANSCRIPT_MAX_CHARS),
    language: selected.language || 'unknown',
    durationSeconds: Number(info.duration || 0) || undefined,
  };
}

async function processYoutube(options, deps = {}) {
  const apiFn = deps.apiRequestJson || apiRequestJson;
  const ensureFn = deps.ensureValidCredentials || ensureValidCredentials;
  const ensured = await ensureFn(apiFn);
  const creds = ensured && ensured.credentials;
  if (!creds?.token) {
    const detail = ensured?.detail || ensured?.error;
    throw new Error(detail ? `Authentication failed: ${detail}. Run "atris login".` : 'Not logged in. Run "atris login".');
  }

  const localExtractor = deps.extractLocalTranscript || extractLocalTranscript;
  let localTranscript = null;
  try {
    localTranscript = await localExtractor(options.youtubeUrl, deps);
  } catch {
    localTranscript = null;
  }

  if (localTranscript?.transcriptText) {
    const transcriptResult = await apiFn('/agent/process_youtube', {
      method: 'POST',
      token: creds.token,
      timeoutMs: options.timeoutMs,
      retries: 0,
      body: buildYoutubePayload({ ...options, localTranscript, cacheTranscript: false }),
    });

    if (transcriptResult.ok) {
      return transcriptResult.data;
    }

    if (transcriptResult.status === 401 || transcriptResult.status === 402 || transcriptResult.status === 400) {
      throw youtubeFailureError(transcriptResult);
    }
  }

  const result = await apiFn('/agent/process_youtube', {
    method: 'POST',
    token: creds.token,
    timeoutMs: options.timeoutMs,
    retries: 0,
    body: buildYoutubePayload(options),
  });

  if (!result.ok) {
    throw youtubeFailureError(result);
  }

  return result.data;
}

function formatYoutubeResult(data) {
  const lines = [];
  const metadata = data?.metadata || {};
  lines.push(data?.message || 'YouTube video processed successfully');
  if (metadata.title) lines.push(`Title: ${metadata.title}`);
  if (metadata.channel) lines.push(`Channel: ${metadata.channel}`);
  if (data?.credits_used !== undefined || data?.credits_remaining !== undefined) {
    const used = data.credits_used !== undefined ? data.credits_used : '?';
    const remaining = data.credits_remaining !== undefined ? data.credits_remaining : '?';
    lines.push(`Credits: ${used} used, ${remaining} remaining`);
  }
  const analysis = data?.video_analysis || data?.analysis || data?.result;
  if (analysis) {
    lines.push('');
    lines.push(String(analysis).trim());
  }
  return lines.join('\n');
}

async function youtubeCommand(argv = process.argv.slice(3), deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const options = parseYoutubeArgs(argv);
  if (options.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }
  const data = await processYoutube(options, deps);
  output(options.json ? JSON.stringify(data, null, 2) : formatYoutubeResult(data));
  return 0;
}

module.exports = {
  DEFAULT_QUERY,
  DEFAULT_TIMEOUT_MS,
  showYoutubeHelp,
  parseYoutubeArgs,
  buildYoutubePayload,
  extractLocalTranscript,
  processYoutube,
  shouldRetryWithLocalTranscript,
  formatYoutubeResult,
  youtubeCommand,
};

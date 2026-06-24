const { apiRequestJson } = require('../utils/api');
const { ensureValidCredentials } = require('../utils/auth');

const DEFAULT_QUERY = 'Extract main topics, key insights, and actionable takeaways.';
const DEFAULT_TIMEOUT_MS = 300000;

function showYoutubeHelp(output = console.log, commandName = 'atris youtube') {
  output('');
  output(`Usage: ${commandName} process <youtube-url> [options]`);
  output(`       ${commandName} <youtube-url> [options]`);
  output('');
  output('Process a YouTube video through Atris using Gemini native video analysis.');
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
  return payload;
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

  const result = await apiFn('/agent/process_youtube', {
    method: 'POST',
    token: creds.token,
    timeoutMs: options.timeoutMs,
    body: buildYoutubePayload(options),
  });

  if (!result.ok) {
    const hint = result.status === 401
      ? ' Run "atris login --force".'
      : result.status === 402
        ? ' Check Atris credits.'
        : '';
    throw new Error(`YouTube processing failed (${result.status}): ${result.error || result.text || 'unknown error'}.${hint}`);
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
  processYoutube,
  formatYoutubeResult,
  youtubeCommand,
};

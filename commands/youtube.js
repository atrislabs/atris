const { apiRequestJson } = require('../utils/api');
const { ensureBilledCommandAuth } = require('./auth');
const applyGate = require('../lib/apply-gate');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DEFAULT_CLAUDE_RUNNER_MODEL } = require('../lib/runner-command');
const {
  DEFAULT_QUERY,
  DEFAULT_TIMEOUT_MS,
  YTNOTES_USAGE,
  YTNOTES_HINT,
  DIGEST_ENGINE_TIMEOUT_MS,
  APPLY_NEXT_MESSAGE,
  PROCESS_APPLY_MESSAGE,
  DEFAULT_SEARCH_LIMIT,
  PAID_SEARCH_TIMEOUT_MS,
  PAID_SEARCH_COST_HINT,
  YTSEARCH_USAGE,
  LOCAL_SEARCH_RATE_LIMIT_MESSAGE,
  LOCAL_SEARCH_CACHE_NOTE,
  PAID_SEARCH_FRESH_CACHE_REFUSE,
  YTTEACH_USAGE,
  TEACH_THIN_REFUSE,
  TEACH_RESUME_NEXT,
  TEACH_WATCH_TICK_NEXT,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
  parseYoutubeArgs,
  buildYoutubePayload,
  extractLocalTranscript,
  parseYtDlpInfoJson,
  shouldRetryWithLocalTranscript,
  formatYoutubeResult,
  youtubeFailureError,
  ensureProcessApply,
  processExperimentSlug,
  processApplyRel,
  mintRichProcess,
  videoIdFromUrl,
  dateStamp,
  fileBriefFromNotes,
  readNotesText,
  keptPrintedNotes,
  notesLessonFromText,
  notesExperimentSlug,
  applySidecarRel,
  ensureNotesApply,
  unsaveYoutubeNotes,
  parseDigestArgs,
  collectVideoBriefs,
  buildDigestPrompt,
  appendDigestJournal,
  digestExperimentSlug,
  digestApplyRel,
  saveRichDigest,
  ensureDigestApply,
  normalizeWatchChannel,
  channelVideosUrl,
  resolveWatchStatePath,
  loadWatchState,
  saveWatchState,
  stampNow,
  parseFlatPlaylist,
  defaultChannelFetcher,
  defaultNotesRunner,
  channelSeenMap,
  markSeen,
  firstRichWatchLesson,
  watchExperimentSlug,
  watchApplyRel,
  saveRichWatch,
  ensureWatchApply,
  printWatchTickNext,
  printWatchAddNext,
  printWatchSearchNext,
  isPlaylistUrl,
  parseNotesArgs,
  notesWorkDir,
  expandNotesTargets,
  runYoutubeNotesBatch,
  runSingleYoutubeNotes,
  parseSearchArgs,
  parseSearchStdout,
  formatSearchResults,
  printYoutubeTeachNext,
  printSearchOutcome,
  readFreshLocalSearchCache,
  paidSearchPayload,
  paidSearchVideos,
  paidSearchCredits,
  formatCreditsLines,
  formatPaidSearchResults,
  youtubeSearchFailureError,
  searchExperimentSlug,
  searchApplyRel,
  searchApplyNow,
  gateSearchLearner,
  searchRowsFromResult,
  finishSuccessfulSearch,
  defaultSearchRunner,
  searchRunnerDetail,
  isLocalSearchRateLimited,
  searchRunnerStatus,
  waitLocalSearchBackoff,
  isMissingSearchBinary,
  parseTeachArgs,
  parseCaptionCues,
  normalizeChapters,
  sliceCuesForChapter,
  teachLessonFromCues,
  formatTeachLesson,
  extractTeachNumbers,
  extractTeachMechanisms,
  extractTeachSource,
  readLocalCaptionText,
  oneTeachCheck,
  learnerCheckFromLesson,
  scoreLearnerNeedles,
  printLearnerCheckGate,
  proveSavedLearnerBaseline,
  isThinTeachLesson,
  teachExperimentSlug,
  readTeachOwedStore,
  rememberTeachOwed,
  previousTeachUnlocked,
  printTeachWatchTickNext,
  printTeachOwed,
  applyTeachRecap,
  applyTeachNext,
  applyTeachResume,
  fileTeachExperiment,
  fileTeachBrief,
  ensureTeachApply,
} = require('../lib/youtube-core');

function showYoutubeHelp(output = console.log, commandName = 'atris youtube') {
  output('');
  output(`Usage: ${commandName} search "<query>" [--limit N] [--json]`);
  output(`       ${commandName} search --paid "<query>" [--limit N] [--json]`);
  output(`       ${commandName} notes <youtube-url> [youtube-url-or-playlist...] [engine] [--save]`);
  output(`       ${commandName} teach <youtube-url> [--section N] [--save] [--recap TEXT] [--skip]`);
  output(`       ${commandName} teach owed [--json]`);
  output(`       ${commandName} teach next [--json]`);
  output(`       ${commandName} unsave <url-or-id>`);
  output(`       ${commandName} process <youtube-url> [options]`);
  output(`       ${commandName} digest [--days N]`);
  output(`       ${commandName} watch add <channel-url-or-@handle>`);
  output(`       ${commandName} watch list`);
  output(`       ${commandName} watch remove <number>`);
  output(`       ${commandName} watch tick`);
  output(`       ${commandName} bench [--quick] [--case <name>]`);
  output(`       ${commandName} <youtube-url> [options]`);
  output('');
  output('search = free local discovery (ytsearch / yt-dlp), returns youtu.be links; rich free search writes one apply and a failing keep/revert pack; thin hands off to teach');
  output('search --paid = 5 credits, watch permalinks + titles from Atris; rich paid search writes one apply and a failing keep/revert pack; thin hands off to teach');
  output('notes = free local notes to stdout; ephemeral unless --save; hands off to teach');
  output('teach = one chapter from local captions; bare teach resumes unpaid checks, then the next chapter after recap or skip');
  output('rich ephemeral notes/teach print one apply next-step and one failing check (no files)');
  output('process = 5 credits cloud knowledge (needs a filled Apply); rich process writes one apply and a failing keep/revert pack');
  output('digest = one decision page from this week\'s video briefs; rich digest writes one apply and a failing keep/revert pack');
  output('watch = subscribed channels turn into briefs without a human; add hands off to tick; tick hands off to teach when it briefed');
  output('bench = run notes on real videos, uncached, and grade what a user gets; --quick runs the short video and the stranger checks');
  output('Process a YouTube video through Atris using timestamped transcript-first analysis.');
  output('Falls back to cloud video processing when local captions are unavailable.');
  output('');
  output('Options:');
  output('  --limit <n>         Max search results (default: 5)');
  output('  --paid              Bill 5 credits for watch permalinks (search only)');
  output('  --save              File brief, journal, apply; rich notes/teach mint a keep/revert experiment');
  output('  --section <n>       Chapter to teach, 1-based (teach only, default: 1)');
  output('  --recap <text>      Unlock the next teach section with the unpaid check');
  output('  --skip              Unlock the next teach section without answering');
  output('  owed                Print the unpaid teach check (no network)');
  output('  next                Next unlocked chapter (no url, no billing)');
  output('  --unsave            Delete filed brief, apply stub, and matching notes/teach experiment packs (no paid calls)');
  output('  --query, -q <text>  Focus question for the analysis');
  output('  --agent <id>        Agent id to store knowledge against');
  output('  --store             Save as agent knowledge (requires --agent)');
  output('  --timeout <sec>     Request timeout in seconds (default: 300)');
  output('  --json              Print the raw JSON response');
  output('  -h, --help          This help');
  output('');
  output('Default output contract:');
  output('  metadata -> timestamped outline -> claims -> examples -> takeaways -> Atris implications -> next actions');
  output('');
  output('Examples:');
  output(`  ${commandName} search "MCP agents 2026"`);
  output(`  ${commandName} search "MCP agents" --limit 10`);
  output(`  ${commandName} search --paid "MCP agents 2026"`);
  output(`  ${commandName} notes https://www.youtube.com/watch?v=VIDEO_ID`);
  output(`  ${commandName} notes https://www.youtube.com/watch?v=VIDEO_ID --save`);
  output(`  ${commandName} teach "https://www.youtube.com/watch?v=VIDEO_ID"`);
  output(`  ${commandName} teach "https://www.youtube.com/watch?v=VIDEO_ID" --section 2`);
  output(`  ${commandName} teach next`);
  output(`  ${commandName} notes --unsave VIDEO_ID`);
  output(`  ${commandName} unsave VIDEO_ID`);
  output(`  ${commandName} notes https://www.youtube.com/watch?v=VIDEO_ID https://youtu.be/OTHER_ID`);
  output(`  ${commandName} notes https://www.youtube.com/playlist?list=PLAYLIST_ID`);
  output(`  ${commandName} https://www.youtube.com/watch?v=VIDEO_ID`);
  output(`  ${commandName} process https://youtu.be/VIDEO_ID --query "Key takeaways"`);
  output(`  ${commandName} digest`);
  output(`  ${commandName} digest --days 14`);
  output(`  ${commandName} watch add @veritasium`);
  output(`  ${commandName} watch tick`);
  output('');
}

async function processYoutube(options, deps = {}) {
  const applyStatus = (deps.ensureProcessApply || ensureProcessApply)({
    cwd: deps.cwd || process.cwd(),
    url: options.youtubeUrl,
    now: deps.now,
    output: deps.output,
  });
  if (applyStatus !== 0) {
    const err = new Error(PROCESS_APPLY_MESSAGE);
    err.exitCode = applyStatus;
    err.applyRequired = true;
    throw err;
  }

  const apiFn = deps.apiRequestJson || apiRequestJson;
  const ensureBilled = deps.ensureBilledCommandAuth || ensureBilledCommandAuth;
  let auth = await ensureBilled('youtube', deps);
  if (!auth?.ok || !auth.token) {
    throw new Error(auth?.error || 'not signed in. run atris login first.');
  }

  const requestYoutube = async (body) => {
    let result = await apiFn('/agent/process_youtube', {
      method: 'POST',
      token: auth.token,
      timeoutMs: options.timeoutMs,
      retries: 0,
      body,
    });
    if (!result.ok && result.status === 401 && !auth.minted) {
      const remint = await ensureBilled('youtube', { ...deps, forceMint: true });
      if (remint?.ok && remint.token) {
        if (!options.json) {
          const print = typeof deps.output === 'function' ? deps.output : () => {};
          for (const line of formatCreditsLines(paidSearchCredits(result.data))) {
            print(line);
          }
        }
        auth = remint;
        result = await apiFn('/agent/process_youtube', {
          method: 'POST',
          token: auth.token,
          timeoutMs: options.timeoutMs,
          retries: 0,
          body,
        });
      }
    }
    return result;
  };

  const localExtractor = deps.extractLocalTranscript || extractLocalTranscript;
  let localTranscript = null;
  try {
    localTranscript = await localExtractor(options.youtubeUrl, {
      ...deps,
      workDir: deps.workDir || notesWorkDir(deps),
    });
  } catch {
    localTranscript = null;
  }

  if (localTranscript?.transcriptText) {
    const transcriptResult = await requestYoutube(
      buildYoutubePayload({ ...options, localTranscript, cacheTranscript: false }),
    );

    if (transcriptResult.ok) {
      return transcriptResult.data;
    }

    if (transcriptResult.status === 401 || transcriptResult.status === 402 || transcriptResult.status === 400) {
      throw youtubeFailureError(transcriptResult);
    }
    if (!options.json) {
      const print = typeof deps.output === 'function' ? deps.output : () => {};
      for (const line of formatCreditsLines(paidSearchCredits(transcriptResult.data))) {
        print(line);
      }
    }
  }

  const result = await requestYoutube(buildYoutubePayload(options));

  if (!result.ok) {
    throw youtubeFailureError(result);
  }

  return result.data;
}

function runYoutubeUnsave(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const parsed = parseNotesArgs(['--unsave', ...args]);
  if (parsed.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }
  if (!parsed.urls.length) {
    output('usage: atris youtube unsave <url-or-id>');
    return 2;
  }
  let code = 0;
  for (const target of parsed.urls) {
    const status = unsaveYoutubeNotes(target, deps);
    if (status !== 0) code = status;
  }
  if (code === 0 && parsed.json !== true && deps.json !== true) {
    printWatchSearchNext(output);
  }
  return code;
}

function defaultDigestRunner(prompt, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  // Machine memory and load at both ends of the launch, so one killed with
  // SIGKILL says whether the machine was short on memory.
  const endResource = require('../lib/engine-resource').startEngineRun(deps.cwd || process.cwd(), { engine: 'claude', task: 'youtube digest' });
  const result = spawn('claude', ['-p', prompt, '--model', DEFAULT_CLAUDE_RUNNER_MODEL], {
    encoding: 'utf8',
    timeout: DIGEST_ENGINE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  // spawnSync does not throw, so a failure is passed in the thrown shape.
  const failed = !result || result.error || result.signal || result.status !== 0;
  const end = endResource(failed ? {
    code: result && result.error && result.error.code,
    signal: result && result.signal,
    stderr: result && result.stderr,
    message: result && result.error ? result.error.message : `claude exited ${result && result.status}`,
  } : null);
  return end && end.cause && result && !(result.error && result.error.code === 'ETIMEDOUT') ? { ...result, cause: end.cause } : result;
}

function invokeDigestEngine(prompt, deps = {}) {
  const runner = deps.runner || ((nextPrompt) => defaultDigestRunner(nextPrompt, deps));
  const result = runner(prompt, deps);
  if (typeof result === 'string') return result.trim();
  if (result && result.signal && !result.error) {
    throw new Error(`digest engine stopped by ${result.signal}${result.cause ? `; ${result.cause}` : ''}`);
  }
  if (!result || result.error || (result.status != null && result.status !== 0)) {
    const detail = String(result?.stderr || result?.error?.message || 'digest engine failed').trim();
    throw new Error(detail || 'digest engine failed');
  }
  return String(result.stdout || '').trim();
}

function runYoutubeDigest(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  let options;
  try {
    options = parseDigestArgs(args);
  } catch (err) {
    output(err.message);
    return 2;
  }
  if (options.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }

  const cwd = deps.cwd || process.cwd();
  const now = deps.now || new Date();
  const briefs = collectVideoBriefs({ cwd, now, days: options.days });
  if (!briefs.length) {
    output(`no video briefs in the last ${options.days} days`);
    printWatchSearchNext(output);
    return 0;
  }

  const prompt = buildDigestPrompt(briefs);
  let text;
  try {
    text = invokeDigestEngine(prompt, { ...deps, cwd });
  } catch (err) {
    output(err.message || 'digest engine failed');
    return 1;
  }
  if (!text) {
    output('digest engine returned no text');
    return 1;
  }

  const date = dateStamp(now);
  const relDigest = `atris/wiki/briefs/digest-${date}.md`;
  const header = [
    `date: ${date}`,
    `window: ${options.days} days`,
    `sources: ${briefs.map((row) => row.relPath).join(', ')}`,
  ].join('\n');
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, relDigest), `${header}\n\n${text}\n`);
  appendDigestJournal({ cwd, date, relDigest });
  output(`digest filed: ${relDigest} (${briefs.length} briefs)`);
  const lesson = notesLessonFromText(text);
  if (isThinTeachLesson(lesson)) {
    printLearnerCheckGate(output, lesson, { includeCheck: true });
    printWatchTickNext(output);
    return 0;
  }

  const saved = saveRichDigest({ cwd, date, lesson, source: relDigest });
  const ensureApply = deps.ensureApply || ensureDigestApply;
  const applyCode = ensureApply({
    cwd,
    date,
    packRel: saved.packRel,
    now,
    output,
    source: relDigest,
  });
  if (deps.ensureApply) return applyCode;
  const baseline = proveSavedLearnerBaseline({
    cwd,
    applyRel: digestApplyRel(date),
    lesson,
    output,
  });
  if (baseline !== 0) return baseline;
  return applyCode;
}

function addWatchChannel(channelInput, deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  if (!channelInput) {
    output('usage: atris youtube watch add <channel-url-or-@handle>');
    return 2;
  }

  let channel;
  try {
    channel = normalizeWatchChannel(channelInput);
  } catch (err) {
    output(err.message);
    return 2;
  }

  const statePath = resolveWatchStatePath(deps);
  const state = loadWatchState(statePath);
  if (state.channels.some((row) => row.channel === channel)) {
    output(`already watching ${channel}`);
    printWatchTickNext(output);
    return 0;
  }

  state.channels.push({
    channel,
    added: stampNow(deps.now),
  });
  saveWatchState(statePath, state);
  output(`watching ${channel}`);
  printWatchTickNext(output);
  return 0;
}

function listWatchChannels(deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const state = loadWatchState(resolveWatchStatePath(deps));
  if (!state.channels.length) {
    output('no channels watched');
    printWatchAddNext(output);
    return 0;
  }

  state.channels.forEach((row, index) => {
    const count = Object.keys(channelSeenMap(state, row.channel)).length;
    output(`${index + 1}. ${row.channel} (${count} seen)`);
  });
  printWatchTickNext(output);
  return 0;
}

function removeWatchChannel(rawNumber, deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const index = Number(rawNumber);
  const statePath = resolveWatchStatePath(deps);
  const state = loadWatchState(statePath);
  if (!Number.isInteger(index) || index < 1 || index > state.channels.length) {
    output('usage: atris youtube watch remove <number>');
    return 2;
  }

  const [removed] = state.channels.splice(index - 1, 1);
  saveWatchState(statePath, state);
  output(`removed ${removed.channel}`);
  if (!state.channels.length) {
    printWatchAddNext(output);
  } else {
    printWatchTickNext(output);
  }
  return 0;
}

async function tickWatch(deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const statePath = resolveWatchStatePath(deps);
  const fetcher = deps.fetcher || ((videosUrl) => defaultChannelFetcher(videosUrl, deps));
  const runner = deps.runner || ((url) => defaultNotesRunner(url, deps));
  const briefFiler = deps.briefFiler || fileBriefFromNotes;
  const cwd = deps.cwd || process.cwd();
  const workDir = deps.workDir || path.join(process.env.TMPDIR || '/tmp', 'ytnotes');
  const timestamp = stampNow(deps.now);
  const now = deps.now || timestamp;

  const state = loadWatchState(statePath);
  let totalNew = 0;
  let totalBriefed = 0;
  let firstBriefedUrl = null;
  const briefedUrls = [];

  for (const row of state.channels) {
    const videosUrl = channelVideosUrl(row.channel);
    let videos;
    try {
      videos = await Promise.resolve(fetcher(videosUrl, row));
    } catch {
      output(`warning: channel ${row.channel} fetch failed`);
      continue;
    }
    if (!Array.isArray(videos)) {
      output(`warning: channel ${row.channel} fetch failed`);
      continue;
    }

    const localSeen = channelSeenMap(state, row.channel);
    const isFresh = !state.seeded[row.channel];
    const unseen = videos.filter((video) => video?.id && !localSeen[video.id] && !state.seen[video.id]);
    const newest = videos[0];
    const toBrief = isFresh
      ? (newest?.id ? [newest] : [])
      : unseen;

    if (isFresh) {
      state.seeded[row.channel] = true;
      for (const video of videos) {
        if (video?.id) markSeen(state, row.channel, video.id, timestamp);
      }
    }

    let briefed = 0;
    for (const video of toBrief) {
      if (!video?.id) continue;
      const url = `https://www.youtube.com/watch?v=${video.id}`;
      try {
        runner(url, deps);
      } catch {
        // notes failure must not stop the rest of the tick
      }
      try {
        briefFiler({ cwd, url, workDir, now });
      } catch {
        // brief filing must never break the watch tick
      }
      markSeen(state, row.channel, video.id, timestamp);
      briefed += 1;
      briefedUrls.push(url);
      if (!firstBriefedUrl) firstBriefedUrl = url;
    }

    if (!isFresh) {
      for (const video of unseen) {
        if (video?.id) markSeen(state, row.channel, video.id, timestamp);
      }
    }

    const newCount = isFresh ? (newest?.id ? 1 : 0) : unseen.length;
    output(`channel ${row.channel}: ${newCount} new, ${briefed} briefed`);
    totalNew += newCount;
    totalBriefed += briefed;
    saveWatchState(statePath, state);
  }

  output(`total: ${totalNew} new, ${totalBriefed} briefed`);
  saveWatchState(statePath, state);
  if (totalBriefed > 0) {
    const rich = firstRichWatchLesson(briefedUrls, workDir);
    if (rich) {
      const saved = saveRichWatch({ cwd, url: rich.url, lesson: rich.lesson });
      const ensureApply = deps.ensureApply || ensureWatchApply;
      const applyCode = ensureApply({
        cwd,
        url: rich.url,
        packRel: saved.packRel,
        now,
        output,
        source: rich.url,
      });
      if (deps.ensureApply) return applyCode;
      const id = videoIdFromUrl(rich.url);
      const baseline = proveSavedLearnerBaseline({
        cwd,
        applyRel: id ? watchApplyRel(id) : null,
        lesson: rich.lesson,
        output,
      });
      if (baseline !== 0) return baseline;
      return applyCode;
    }
    if (firstBriefedUrl) {
      const lesson = notesLessonFromText(readNotesText({ url: firstBriefedUrl, workDir }));
      printLearnerCheckGate(output, lesson, { includeCheck: true });
      printYoutubeTeachNext(firstBriefedUrl, {}, output);
      return 0;
    }
    printYoutubeTeachNext(firstBriefedUrl, {}, output);
    return 0;
  }
  if (!state.channels.length) printWatchAddNext(output);
  else printWatchSearchNext(output);
  return 0;
}

async function watchCommand(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  const sub = args[0];
  if (!sub || ['help', '--help', '-h'].includes(sub)) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return sub ? 0 : 2;
  }
  if (sub === 'add') return addWatchChannel(args[1], deps);
  if (sub === 'list') return listWatchChannels(deps);
  if (sub === 'remove') return removeWatchChannel(args[1], deps);
  if (sub === 'tick') return tickWatch(deps);
  output(`unknown watch command: ${sub}`);
  return 2;
}

function runYoutubeNotes(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.error(line));
  const parsed = parseNotesArgs(args);
  if (parsed.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }
  if (parsed.unsave) {
    return runYoutubeUnsave(args, deps);
  }
  if (!parsed.urls.length) {
    output(YTNOTES_USAGE);
    output(YTNOTES_HINT);
    return 2;
  }
  const nextDeps = { ...deps, save: parsed.save, json: parsed.json };
  if (parsed.urls.length === 1 && !isPlaylistUrl(parsed.urls[0])) {
    return runSingleYoutubeNotes(parsed.urls[0], parsed.engine, nextDeps);
  }
  return runYoutubeNotesBatch(parsed, nextDeps);
}

function showYoutubeSearchHelp(output = console.log, commandName = 'atris youtube') {
  output('');
  output(`Usage: ${commandName} search "<query>" [--limit N] [--json]`);
  output(`       ${commandName} search --paid "<query>" [--limit N] [--json]`);
  output('');
  output('Free local discovery. Uses ytsearch on PATH when present, else the');
  output('bundled scripts/det/ytsearch, else yt-dlp ytsearchN with the same print contract.');
  output('Does not bill credits. A thin hit prints check: fill this and one next: atris youtube teach <first-url>.');
  output('A rich hit writes one apply and a failing keep/revert pack (score 0).');
  output('');
  output(`--paid buys watch permalinks from Atris (${PAID_SEARCH_COST_HINT}).`);
  output('Requires login. Same auth path as atris youtube process.');
  output('A rich hit writes one apply and a failing keep/revert pack (score 0).');
  output('A thin hit prints check: fill this and one next: atris youtube teach <first-url>.');
  output('Empty or failed paid search prints credits refunded only when the server marks a refund.');
  output('');
  output('Options:');
  output(`  --limit <n>         Max results (default: ${DEFAULT_SEARCH_LIMIT})`);
  output('  --paid              Bill credits for watch permalinks + titles');
  output('  --json              Print JSON rows instead of pipe lines');
  output('  -h, --help          This help');
  output('');
  output('Each free line:');
  output('  title | channel | duration | views | upload_date | https://youtu.be/ID');
  output('');
  output('Each paid line:');
  output('  title | https://www.youtube.com/watch?v=ID');
  output('');
  output('Examples:');
  output(`  ${commandName} search "MCP agents 2026"`);
  output(`  ${commandName} search "MCP agents" --limit 10`);
  output(`  ${commandName} search "MCP agents" --json`);
  output(`  ${commandName} search --paid "MCP agents 2026"`);
  output(`  ${commandName} search --paid "MCP agents" --limit 10`);
  output('');
}

async function requestPaidYoutubeSearch(options, deps = {}) {
  const apiFn = deps.apiRequestJson || apiRequestJson;
  const ensureBilled = deps.ensureBilledCommandAuth || ensureBilledCommandAuth;
  let auth = await ensureBilled('youtube', deps);
  if (!auth?.ok || !auth.token) {
    throw new Error(auth?.error || 'not signed in. run atris login first.');
  }

  const body = paidSearchPayload(options);
  const call = (token) => apiFn('/youtube/search', {
    method: 'POST',
    token,
    timeoutMs: options.timeoutMs || PAID_SEARCH_TIMEOUT_MS,
    retries: 0,
    body,
  });

  let result = await call(auth.token);
  if (!result.ok && result.status === 401 && !auth.minted) {
    const remint = await ensureBilled('youtube', { ...deps, forceMint: true });
    if (remint?.ok && remint.token) {
      if (!options.json) {
        const print = typeof deps.output === 'function' ? deps.output : () => {};
        for (const line of formatCreditsLines(paidSearchCredits(result.data))) {
          print(line);
        }
      }
      auth = remint;
      result = await call(auth.token);
    }
  }

  if (!result.ok) {
    throw youtubeSearchFailureError(result);
  }
  return result.data;
}

async function runPaidYoutubeSearch(options, deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  if (readFreshLocalSearchCache(options.query, deps)) {
    output(PAID_SEARCH_FRESH_CACHE_REFUSE);
    return 2;
  }
  const data = await requestPaidYoutubeSearch(options, deps);
  if (options.json) {
    output(JSON.stringify(data, null, 2));
    return 0;
  }

  const videos = paidSearchVideos(data);
  const rendered = formatPaidSearchResults(data);
  if (!videos.length) {
    output(rendered ? `no videos found\n${rendered}` : 'no videos found');
    printWatchTickNext(output);
    return 2;
  }
  output(rendered);
  return gateSearchLearner(videos, options, output, deps);
}

async function runYoutubeSearch(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  let options;
  try {
    options = parseSearchArgs(args);
  } catch (err) {
    output(err.message);
    output(YTSEARCH_USAGE);
    return 2;
  }

  if (options.help) {
    showYoutubeSearchHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }

  if (options.paid) {
    try {
      return await runPaidYoutubeSearch(options, deps);
    } catch (err) {
      output(err.message);
      return 1;
    }
  }

  const runner = deps.runner || ((query, limit) => defaultSearchRunner(query, limit, deps));
  let result;
  try {
    result = await Promise.resolve(runner(options.query, options.limit, deps));
  } catch (err) {
    output(String(err.message || err));
    return 1;
  }

  if (isMissingSearchBinary(result)) {
    output('ytsearch and yt-dlp not found. Install yt-dlp or put ytsearch on PATH.');
    return 2;
  }

  let rows = searchRowsFromResult(result);
  if (rows.length) return finishSuccessfulSearch(rows, options, output, deps);

  let status = searchRunnerStatus(result);
  if (status != null && status !== 0 && isLocalSearchRateLimited(result)) {
    await waitLocalSearchBackoff(deps);
    try {
      result = await Promise.resolve(runner(options.query, options.limit, deps));
    } catch (err) {
      output(String(err.message || err));
      return 1;
    }
    if (isMissingSearchBinary(result)) {
      output('ytsearch and yt-dlp not found. Install yt-dlp or put ytsearch on PATH.');
      return 2;
    }
    rows = searchRowsFromResult(result);
    if (rows.length) return finishSuccessfulSearch(rows, options, output, deps);
    status = searchRunnerStatus(result);
    if (status != null && status !== 0 && isLocalSearchRateLimited(result)) {
      const cached = readFreshLocalSearchCache(options.query, deps);
      if (cached) {
        const cachedRows = cached.rows.slice(0, options.limit);
        const code = printSearchOutcome(cachedRows, options, output, deps);
        output(LOCAL_SEARCH_CACHE_NOTE);
        return code;
      }
      output(LOCAL_SEARCH_RATE_LIMIT_MESSAGE);
      return status == null ? 1 : status;
    }
  }

  if (status != null && status !== 0) {
    const detail = searchRunnerDetail(result);
    output(detail || 'search failed');
    return status == null ? 1 : status;
  }

  output('no videos found');
  if (!options.json) printWatchTickNext(output);
  return 2;
}

async function runYoutubeTeach(args = [], deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  let parsed;
  try {
    parsed = parseTeachArgs(args);
  } catch (err) {
    output(err.message || YTTEACH_USAGE);
    return 2;
  }
  if (parsed.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }

  const owedDeps = { ...deps, cwd: deps.cwd || process.cwd() };
  if (parsed.owed) {
    if (!parsed.resume) return printTeachOwed(parsed, owedDeps, output);
    const resumeCode = applyTeachResume(parsed, owedDeps, output);
    if (resumeCode !== 0) return resumeCode;
    if (!parsed.url) return 0;
  }
  if (parsed.recap != null || parsed.skip) {
    const recapCode = applyTeachRecap(parsed, owedDeps, output);
    if (recapCode !== 0) return recapCode;
    if (!parsed.url || parsed.section <= 1) return 0;
  }
  if (parsed.next) {
    const nextCode = applyTeachNext(parsed, owedDeps, output);
    if (nextCode !== 0) return nextCode;
    if (!parsed.url) return 0;
  }

  if (!parsed.url) {
    output('Missing YouTube URL. Run "atris youtube teach --help".');
    return 2;
  }

  if (parsed.section > 1) {
    const owed = readTeachOwedStore(owedDeps)[videoIdFromUrl(parsed.url) || ''];
    if (!previousTeachUnlocked(owed, parsed.section)) {
      if (!parsed.json && owed && owed.check) output(owed.check);
      return 2;
    }
  }

  const source = await (deps.extractTeachSource || extractTeachSource)(parsed.url, {
    ...deps,
    workDir: deps.workDir || notesWorkDir(deps),
  });
  if (!source || !Array.isArray(source.cues) || !source.cues.length) {
    output('no english captions for this url. teach stays local and will not call process.');
    return 2;
  }

  const chapters = normalizeChapters(source.chapters, source.durationSeconds);
  if (parsed.section > chapters.length) {
    output(`section ${parsed.section} is past ${chapters.length} chapters. try --section ${chapters.length}`);
    return 2;
  }

  const chapter = chapters[parsed.section - 1];
  const cues = sliceCuesForChapter(source.cues, chapter);
  const lesson = teachLessonFromCues({
    url: parsed.url,
    section: parsed.section,
    chapters,
    chapter,
    cues,
    title: source.title,
  });
  output(lesson.text);
  rememberTeachOwed(owedDeps, {
    url: parsed.url,
    section: parsed.section,
    lesson,
    total: chapters.length,
  });

  if (!parsed.save) {
    if (!isThinTeachLesson(lesson)) applyGate.hintEphemeralApply(output, 'teach');
    printLearnerCheckGate(output, lesson, { includeCheck: true, json: parsed.json === true });
    printTeachWatchTickNext(parsed, lesson, chapters.length, output);
    return 0;
  }
  if (isThinTeachLesson(lesson)) {
    output(TEACH_THIN_REFUSE);
    printTeachWatchTickNext(parsed, lesson, chapters.length, output);
    return 2;
  }

  const cwd = deps.cwd || process.cwd();
  fileTeachBrief({
    cwd,
    url: parsed.url,
    section: parsed.section,
    lesson: lesson.text,
    now: deps.now,
  });
  const packRel = fileTeachExperiment({
    cwd,
    url: parsed.url,
    section: parsed.section,
    lesson,
  });
  const ensureApply = deps.ensureApply || ensureTeachApply;
  const applyCode = ensureApply({
    cwd,
    url: parsed.url,
    section: parsed.section,
    packRel,
    now: deps.now,
    output,
  });
  if (deps.ensureApply) return applyCode;
  const id = videoIdFromUrl(parsed.url);
  const baseline = proveSavedLearnerBaseline({
    cwd,
    applyRel: id ? applySidecarRel(`${id}-s${parsed.section}`) : null,
    lesson,
    output,
    json: parsed.json === true,
  });
  if (baseline !== 0) return baseline;
  return applyCode;
}

// Bench the notes feature end to end. The script prints its own lines.
function runYoutubeBench(argv, deps = {}) {
  const run = (deps.spawnSync || spawnSync)(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'det', 'ytrail-bench.js'), ...argv],
    { stdio: 'inherit' },
  );
  if (run.error) {
    (deps.output || console.error)(`bench did not start: ${run.error.message}`);
    return 1;
  }
  return typeof run.status === 'number' ? run.status : 1;
}

async function youtubeCommand(argv = process.argv.slice(3), deps = {}) {
  const output = deps.output || ((line = '') => console.log(line));
  if (argv[0] === 'search') {
    const code = await runYoutubeSearch(argv.slice(1), { ...deps, output });
    if (!deps.output && !deps.spawnSync && !deps.runner && !deps.apiRequestJson && !deps.ensureValidCredentials && !deps.ensureBilledCommandAuth) {
      process.exit(code);
    }
    return code;
  }
  if (argv[0] === 'unsave') {
    const code = runYoutubeUnsave(argv.slice(1), deps);
    if (!deps.output && !deps.spawnSync && !deps.runner && !deps.expander) process.exit(code);
    return code;
  }
  if (argv[0] === 'notes') {
    const code = runYoutubeNotes(argv.slice(1), deps);
    if (!deps.output && !deps.spawnSync && !deps.runner && !deps.expander) process.exit(code);
    return code;
  }
  if (argv[0] === 'teach') {
    const code = await runYoutubeTeach(argv.slice(1), { ...deps, output });
    if (!deps.output && !deps.extractTeachSource && !deps.spawnSync && !deps.runner) process.exit(code);
    return code;
  }
  if (argv[0] === 'digest') {
    const code = runYoutubeDigest(argv.slice(1), { ...deps, output });
    if (!deps.output && !deps.runner) process.exit(code);
    return code;
  }
  if (argv[0] === 'bench') {
    const code = runYoutubeBench(argv.slice(1), deps);
    if (!deps.output && !deps.spawnSync) process.exit(code);
    return code;
  }
  if (argv[0] === 'watch') {
    const code = await watchCommand(argv.slice(1), { ...deps, output });
    if (!deps.output && !deps.fetcher && !deps.runner && !deps.briefFiler) process.exit(code);
    return code;
  }
  const options = parseYoutubeArgs(argv);
  if (options.help) {
    showYoutubeHelp(output, deps.commandName || 'atris youtube');
    return 0;
  }
  let status = 0;
  try {
    const data = await processYoutube(options, deps);
    if (options.json) {
      output(JSON.stringify(data, null, 2));
    } else {
      output(formatYoutubeResult(data));
      const mintCode = mintRichProcess({
        cwd: deps.cwd || process.cwd(),
        url: options.youtubeUrl,
        data,
        now: deps.now,
        output,
        ensureApply: deps.ensureApply,
      });
      if (mintCode !== 0) status = mintCode;
    }
  } catch (err) {
    if (!err.applyRequired) output(err.message);
    status = Number.isInteger(err.exitCode) ? err.exitCode : 1;
  }
  if (!deps.output && !deps.apiRequestJson && !deps.ensureValidCredentials && !deps.ensureBilledCommandAuth && !deps.extractLocalTranscript) {
    process.exit(status);
  }
  return status;
}

module.exports = {
  DEFAULT_QUERY,
  searchApplyNow,
  DEFAULT_TIMEOUT_MS,
  parseYoutubeArgs,
  buildYoutubePayload,
  extractLocalTranscript,
  parseYtDlpInfoJson,
  processYoutube,
  shouldRetryWithLocalTranscript,
  formatYoutubeResult,
  fileBriefFromNotes,
  keptPrintedNotes,
  ensureNotesApply,
  unsaveYoutubeNotes,
  APPLY_NEXT_MESSAGE,
  PROCESS_APPLY_MESSAGE,
  isPlaylistUrl,
  parseNotesArgs,
  expandNotesTargets,
  runYoutubeNotesBatch,
  parseDigestArgs,
  collectVideoBriefs,
  buildDigestPrompt,
  normalizeWatchChannel,
  channelVideosUrl,
  parseFlatPlaylist,
  loadWatchState,
  watchCommand,
  parseSearchArgs,
  parseSearchStdout,
  formatSearchResults,
  parseTeachArgs,
  parseCaptionCues,
  normalizeChapters,
  sliceCuesForChapter,
  formatTeachLesson,
  extractTeachNumbers,
  extractTeachMechanisms,
  extractTeachSource,
  readLocalCaptionText,
  oneTeachCheck,
  learnerCheckFromLesson,
  scoreLearnerNeedles,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
  printLearnerCheckGate,
  proveSavedLearnerBaseline,
  isThinTeachLesson,
  TEACH_THIN_REFUSE,
  TEACH_RESUME_NEXT,
  TEACH_WATCH_TICK_NEXT,
  teachExperimentSlug,
  notesExperimentSlug,
  digestExperimentSlug,
  watchExperimentSlug,
  processExperimentSlug,
  processApplyRel,
  searchExperimentSlug,
  searchApplyRel,
  firstRichWatchLesson,
  fileTeachExperiment,
  runYoutubeBench,
  youtubeCommand,
};

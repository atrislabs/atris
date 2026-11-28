'use strict';

// atris swarm: thin 1-lead + N-worker coordination over Git + Swarlo SQL + atris/team/.

const fs = require('fs');
const { workspaceRoot } = require('../lib/workspace-root');
const swarmLib = require('../lib/swarm');
const comms = require('../lib/swarm-comms');

const VALUE_FLAGS = new Set([
  '--lead', '--workers', '--team', '--role', '--channel', '--hub', '--server',
  '--engine', '--campaign', '--as', '--reason', '--stale-minutes',
  '--depends-on', '--priority', '--to', '--tasks', '--file', '--verify', '--idempotency-key',
  '--tier', '--task-key', '--evidence', '--tried', '--limit', '--scorer', '--every', '--max-cycles',
  '--exec', '--max-repeat-errors', '--parallel', '--max-ticks',
]);

function parseArgs(args = []) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--') {
      positional.push(...args.slice(i + 1).map(String));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else if (VALUE_FLAGS.has(token)) {
        flags[token.slice(2)] = args[i + 1] !== undefined ? String(args[i + 1]) : '';
        i += 1;
      } else {
        flags[token.slice(2)] = true;
      }
      continue;
    }
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

const FLEET_PASSTHROUGH = new Set([
  'launched', 'roster', 'members', 'who', 'post', 'say', 'task', 'claim', 'done', 'prune', 'tail', 'verify',
]);

function showHelp(log = console.log) {
  log('');
  log('atris swarm: natural 1-lead + N-worker swarm over Git, Swarlo, and atris/team/');
  log('');
  log('  atris swarm "<anything>"             plain English: LLM reads team + MAP + wiki, picks seats (or solo), executes parallel waves');
  log('  atris swarm up <23 min | 1 hr>       run a timed swarm loop (auto-staffs if none active; member names go to fleet up)');
  log('    [--mission] [--exec "<cmd>"] [--verify "<cmd>"] [--dispatch] [--parallel N] [--in-place]');
  log('    [--stop-on-empty] [--watch-only] [--every 10m] [--max-cycles N] [--max-ticks 4] [--max-repeat-errors 2]');
  log('    [--diagnose] [--recover] [--once] [--apply-dream] [--no-apply-dream] [--no-dream]');
  log('  atris swarm                          show active swarm, frozen modules, and hub health');
  log('  atris swarm start "<goal>"           explicitly register lead + N workers and post the lead brief');
  log('    [--lead coordinator] [--workers 2] [--team a,b] [--role builder]');
  log('    [--channel general] [--campaign <id>] [--engine <profile>] [--dry-run] [--json]');
  log('  atris swarm expand <N | member...>   add workers to the active swarm');
  log('    [--role builder] [--engine <profile>] [--dry-run] [--json]');
  log('  atris swarm freeze <path...>         lock solved modules so workers stop modifying them');
  log('  atris swarm freeze --check           exit 1 if any frozen module changed since freeze');
  log('  atris swarm unfreeze <path...>       remove paths from the freeze list');
  log('  atris swarm plan <key> "<text>"      lead posts a task (or --tasks <json> / --file <path>) with --depends-on');
  log('  atris swarm pull --as <worker>       atomically claim the next unblocked task from Swarlo');
  log('  atris swarm report <key> <done|failed|blocked> "<text>" --as <worker> [--verify "<cmd>"] [--next]');
  log('                                       run freeze + bare verify gates, report result, optionally claim next');
  log('  atris swarm brief "<task>"           compressed briefing: Swarlo TF-IDF board + MEMORY_CORE + MAP + frozen paths');
  log('  atris swarm route "<intent>"         3-tier routing (coordinator / strategist / human) + trace log');
  log('  atris swarm escalate "<intent>" --tried "<what failed>" [--evidence <paths>]');
  log('                                       upward context funnel to #escalations without raw transcripts');
  log('  atris swarm watch [--stale-minutes 10] [--expire] [--reallocate] [--json]');
  log('                                       out-of-band stall, idle, and frozen-module check');
  log('  atris swarm down [member...]         deactivate swarm or standby members');
  log('  atris swarm launched|post|task|claim|done|members|prune');
  log('                                       shared board verbs (same as atris fleet)');
  log('');
  log('swarm (attack) and fleet (standby) share every verb over Swarlo and atris/team/.');
  log('');
}

function printNaturalResult(res, log) {
  if (!res.ok && res.error) {
    log(`swarm failed: ${res.error}`);
    return;
  }
  const p = res.plan;
  if (res.needs_human_yes) {
    log(`paused (tier ${p.tier} needs your yes): ${p.objective}`);
    log(`  why:    ${p.reason}`);
    log(`  next:   re-run with --yes if you want to proceed`);
    return;
  }
  const seats = p.solo ? `${p.lead} (solo)` : `${p.lead} + ${p.workers.join(', ')}`;
  log(`swarm ${res.dry_run ? 'planned' : 'started'} (${p.planner}${p.planner_engine ? `/${p.planner_engine}` : ''}): ${p.objective}`);
  log(`  seats:  ${seats}`);
  if (p.duration_label) log(`  clock:  ${p.duration_label}`);
  if (p.context_paths.length) log(`  files:  ${p.context_paths.join(', ')}`);
  if (p.tasks.length) log(`  tasks:  ${p.tasks.map((t) => t.task_key).join(', ')}`);
  log(`  why:    ${p.reason}`);
  if (res.loop) {
    const workPart = res.loop.executed_count
      ? `, executed ${res.loop.executed_count} (${res.loop.succeeded_count} ok, ${res.loop.failed_count} failed)`
      : '';
    log(`  loop:   ${res.loop.cycles} cycle(s)${workPart}, stop=${res.loop.stop_reason}, log=${res.loop.loop_log}`);
    if (res.loop.dream) {
      log(`  dream:  ${res.loop.dream.applied ? 'applied' : 'dry-run'} (${res.loop.dream.memory_core_count} core rules, ${res.loop.dream.poisoned_count} flagged)`);
    }
  }
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function printStartOrExpand(verb, res, log) {
  if (!res.ok && res.error) {
    log(`swarm ${verb} failed: ${res.error}`);
    return;
  }
  const s = res.swarm;
  if (verb === 'start') {
    log(`swarm ${res.dry_run ? 'planned' : 'started'}: ${s.objective}`);
    log(`  lead:    ${s.lead}`);
    log(`  workers: ${s.workers.join(', ') || 'none'}`);
    log(`  hub:     ${s.hub} (${s.server}) #${s.channel}${res.hub_reachable ? '' : ' [offline, local state saved]'}`);
    if (res.announced) log('  brief:   posted to Swarlo');
  } else {
    log(`swarm ${res.dry_run ? 'would add' : 'added'}: ${res.added.map((m) => m.member).join(', ')}`);
    log(`  workers: ${s.workers.join(', ')}`);
  }
  for (const m of (verb === 'start' ? s.members : res.added)) {
    if (m.error) log(`  x ${m.member} (${m.role}) failed at ${m.stage}: ${m.error}`);
    else log(`  + ${m.member} (${m.role}) on ${m.engine} [${m.stage}]`);
  }
}

function printWatch(res, log) {
  const s = res.swarm;
  if (!s) {
    log('no active swarm in this workspace.');
  } else {
    log(`swarm: ${s.objective}`);
    log(`  lead:    ${s.lead}`);
    log(`  workers: ${(s.workers || []).join(', ') || 'none'}`);
    log(`  hub:     ${res.hub.hub} (${res.hub.server}) ${res.hub.reachable ? 'online' : 'offline'}`);
  }
  const frozenPaths = (res.frozen && res.frozen.paths) || [];
  log(`  frozen:  ${frozenPaths.length ? frozenPaths.join(', ') : 'none'}`);
  if (res.campaigns && res.campaigns.length) {
    log(`  campaigns: ${res.campaigns.map((c) => `${c.id} (${c.state})`).join(', ')}`);
  }
  if (res.hub.liveness) {
    const l = res.hub.liveness;
    log(`  health:  ${(l.alive || []).length} alive, ${(l.dying || []).length} dying, ${(l.dead || []).length} dead, ${(l.orphaned_claims || []).length} orphaned claims`);
    if (Array.isArray(l.expired_on_sweep) && l.expired_on_sweep.length) {
      log(`  expired: ${l.expired_on_sweep.join(', ')}`);
    }
  }
  if (res.alerts.length) {
    log('  alerts:');
    for (const alert of res.alerts) log(`    - ${alert}`);
  } else {
    log('  alerts:  none');
  }
}

async function swarmCommand(args = [], options = {}) {
  const log = options.log || console.log;
  const { positional, flags } = parseArgs(args);
  const sub = String(positional[0] || 'status').toLowerCase();
  const asJson = Boolean(flags.json);

  if (flags.help || sub === 'help') {
    showHelp(log);
    return 0;
  }

  if (FLEET_PASSTHROUGH.has(sub) && !options.fromFleet) {
    const { fleet } = require('./fleet');
    const prevCode = process.exitCode;
    process.exitCode = 0;
    await fleet(args, { fromSwarm: true });
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = prevCode;
    return code;
  }

  const root = options.root || workspaceRoot(process.cwd());
  const deps = options.deps || {};

  if (sub === 'up' || sub === 'run') {
    const tail = positional.slice(1);
    const duration = comms.parseDurationTokens(tail);
    if (sub === 'up' && !duration && !options.fromFleet) {
      const { fleet } = require('./fleet');
      const prevCode = process.exitCode;
      process.exitCode = 0;
      await fleet(args, { fromSwarm: true });
      const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
      process.exitCode = prevCode;
      return code;
    }
    const extraPrompt = duration
      ? (duration.consumed > 0 ? tail.slice(duration.consumed).join(' ').trim() : String(duration.remainder || '').trim())
      : tail.join(' ').trim();
    const everyParsed = flags.every ? comms.parseDurationTokens([flags.every]) : null;
    const applyDreamOpt = flags['no-apply-dream'] ? false : (flags['apply-dream'] ? true : undefined);
    const loopExecOpts = {
      exec: flags.exec || '',
      verify: flags.verify || '',
      dispatch: Boolean(flags.dispatch),
      mission: flags['no-mission'] ? false : (flags.mission ? true : undefined),
      parallel: flags.parallel ? Number(flags.parallel) : undefined,
      maxTicks: flags['max-ticks'] ? Number(flags['max-ticks']) : undefined,
      inPlace: Boolean(flags['in-place']),
      watchOnly: Boolean(flags['watch-only']),
      stopOnEmpty: flags['no-stop-on-empty'] ? false : (flags['stop-on-empty'] ? true : undefined),
      maxRepeatErrors: flags['max-repeat-errors'] ? Number(flags['max-repeat-errors']) : undefined,
      diagnose: Boolean(flags.diagnose || flags.recover),
      recover: Boolean(flags.recover),
      expire: flags['no-expire'] ? false : true,
      reallocate: flags['no-reallocate'] ? false : true,
    };
    if (extraPrompt || !swarmLib.loadSwarmState(root)) {
      const res = await comms.runNaturalSwarm(root, extraPrompt, {
        explicitDuration: duration || { ms: 3600 * 1000, label: '1h', consumed: 0 },
        intervalMs: everyParsed ? everyParsed.ms : undefined,
        maxCycles: flags['max-cycles'] ? Number(flags['max-cycles']) : undefined,
        once: Boolean(flags.once),
        ...loopExecOpts,
        dream: flags['no-dream'] ? false : true,
        applyDream: applyDreamOpt,
        staleMinutes: flags['stale-minutes'] ? Number(flags['stale-minutes']) : 10,
        channel: flags.channel || '',
        hub: flags.hub || '',
        server: flags.server || '',
        engine: flags.engine || '',
        dryRun: Boolean(flags['dry-run']),
        offline: Boolean(flags.offline),
        yes: Boolean(flags.yes),
        json: asJson,
        home: options.home,
        log,
      }, deps);
      if (asJson) log(JSON.stringify(res, null, 2));
      else printNaturalResult(res, log);
      return res.exitCode;
    }
    const res = await comms.runSwarmUpLoop(root, {
      durationMs: duration ? duration.ms : 3600 * 1000,
      label: duration ? duration.label : '1h',
      intervalMs: everyParsed ? everyParsed.ms : undefined,
      maxCycles: flags['max-cycles'] ? Number(flags['max-cycles']) : undefined,
      once: Boolean(flags.once),
      ...loopExecOpts,
      dream: flags['no-dream'] ? false : true,
      applyDream: applyDreamOpt,
      staleMinutes: flags['stale-minutes'] ? Number(flags['stale-minutes']) : 10,
      expire: flags['no-expire'] ? false : true,
      reallocate: flags['no-reallocate'] ? false : true,
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      engine: flags.engine || '',
      dryRun: Boolean(flags['dry-run']),
      json: asJson,
      home: options.home,
      log,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else {
      const workPart = res.executed_count ? `, executed ${res.executed_count} (${res.succeeded_count} ok, ${res.failed_count} failed)` : '';
      log(`swarm up finished (${res.cycles} cycle(s), ${res.duration_label}${workPart}, stop=${res.stop_reason}). log: ${res.loop_log}`);
      if (res.dream) {
        log(`  dream:  ${res.dream.applied ? 'applied' : 'dry-run'} (${res.dream.memory_core_count} core rules, ${res.dream.poisoned_count} flagged)`);
      }
    }
    return res.exitCode;
  }

  if (sub === 'brief') {
    const task = positional.slice(1).join(' ').trim();
    const res = await comms.buildSwarmBrief(root, {
      task,
      as: flags.as || '',
      limit: flags.limit ? Number(flags.limit) : 10,
      scorer: flags.scorer || 'tfidf',
      hub: flags.hub || '',
      server: flags.server || '',
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else if (!res.ok) log(`swarm brief failed: ${res.error}`);
    else {
      log(`brief (${res.scorer}): ${res.task}`);
      log(`  board hits:  ${res.board_posts.length}${res.hub_reachable ? '' : ' (hub offline)'}`);
      for (const p of res.board_posts.slice(0, 5)) log(`    - [${p.member_name || p.member_id}] ${String(p.content || '').slice(0, 100)}`);
      if (res.memory_core.length) {
        log(`  core rules:  ${res.memory_core.length}`);
        for (const m of res.memory_core) log(`    ${m}`);
      }
      if (res.map_routes.length) {
        log(`  map routes:  ${res.map_routes.length}`);
        for (const r of res.map_routes) log(`    ${r}`);
      }
      if (res.frozen_paths.length) log(`  frozen:      ${res.frozen_paths.join(', ')}`);
    }
    return res.exitCode;
  }

  if (sub === 'route') {
    const intent = positional.slice(1).join(' ').trim();
    const res = await comms.routeIntent(root, {
      intent,
      tier: flags.tier ? Number(flags.tier) : null,
      to: flags.to || '',
      as: flags.as || '',
      taskKey: flags['task-key'] || '',
      evidence: flags.evidence ? splitCsv(flags.evidence) : [],
      tried: flags.tried || '',
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      dryRun: Boolean(flags['dry-run']),
      offline: Boolean(flags.offline),
      engine: flags.engine || '',
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else if (!res.ok) log(`swarm route failed: ${res.error}`);
    else log(`routed tier ${res.tier} -> ${res.seat} (${res.engine}) in #${res.channel}${res.posted ? ' [posted]' : ' [local]'}.`);
    return res.exitCode;
  }

  if (sub === 'escalate') {
    const intent = positional.slice(1).join(' ').trim();
    const res = await comms.escalateIntent(root, {
      intent,
      tier: flags.tier ? Number(flags.tier) : null,
      as: flags.as || '',
      taskKey: flags['task-key'] || '',
      evidence: flags.evidence ? splitCsv(flags.evidence) : [],
      tried: flags.tried || '',
      hub: flags.hub || '',
      server: flags.server || '',
      dryRun: Boolean(flags['dry-run']),
      offline: Boolean(flags.offline),
      engine: flags.engine || '',
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else if (!res.ok) log(`swarm escalate failed: ${res.error}`);
    else log(`escalated tier ${res.tier} -> ${res.seat} in #${res.channel}${res.posted ? ' [posted]' : ' [local]'}.`);
    return res.exitCode;
  }

  if (sub === 'start') {
    const objective = positional.slice(1).join(' ').trim();
    const res = await swarmLib.startSwarm(root, {
      objective,
      lead: flags.lead || '',
      workers: flags.workers ? Number(flags.workers) : undefined,
      team: flags.team ? splitCsv(flags.team) : [],
      role: flags.role || '',
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      engine: flags.engine || '',
      campaign: flags.campaign || '',
      dryRun: Boolean(flags['dry-run']),
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else printStartOrExpand('start', res, log);
    return res.exitCode;
  }

  if (sub === 'expand' || sub === 'scale') {
    const rest = positional.slice(1);
    let count = 0;
    let members = [];
    if (rest.length === 1 && /^\d+$/.test(rest[0])) {
      count = Number(rest[0]);
    } else if (rest.length > 0) {
      members = rest.flatMap((token) => splitCsv(token));
    } else {
      count = 1;
    }
    const res = await swarmLib.expandSwarm(root, {
      count,
      members,
      role: flags.role || '',
      engine: flags.engine || '',
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      dryRun: Boolean(flags['dry-run']),
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else printStartOrExpand('expand', res, log);
    return res.exitCode;
  }

  if (sub === 'freeze' || sub === 'unfreeze') {
    const paths = positional.slice(1);
    const res = await swarmLib.freezeModules(root, paths, {
      check: Boolean(flags.check),
      unfreeze: sub === 'unfreeze',
      as: flags.as || '',
      reason: flags.reason || '',
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      dryRun: Boolean(flags['dry-run']),
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else if (!res.ok && res.error) log(`swarm freeze failed: ${res.error}`);
    else if (res.action === 'check') {
      if (res.changed.length) log(`frozen modules modified: ${res.changed.join(', ')}`);
      else log(`frozen modules clean (${res.paths.length} locked).`);
    } else if (res.action === 'list') {
      const list = (res.frozen && res.frozen.paths) || [];
      log(list.length ? `frozen modules: ${list.join(', ')}` : 'no frozen modules.');
    } else if (res.action === 'unfreeze') {
      log(`unfroze: ${res.removed.join(', ')}. remaining: ${res.paths.join(', ') || 'none'}`);
    } else {
      log(`froze ${(res.frozen && res.frozen.paths || []).join(', ')}${res.hub_notified ? ' (posted to Swarlo)' : ''}.`);
    }
    return res.exitCode;
  }

  if (sub === 'plan' || sub === 'decompose') {
    let tasks = [];
    if (flags.tasks || flags.file) {
      try {
        const raw = flags.file ? fs.readFileSync(flags.file, 'utf8') : String(flags.tasks);
        const parsed = JSON.parse(raw);
        tasks = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.tasks) ? parsed.tasks : []);
      } catch (err) {
        const out = { ok: false, exitCode: 2, error: `invalid tasks input: ${err.message}` };
        if (asJson) log(JSON.stringify(out, null, 2));
        else log(`swarm plan failed: ${out.error}`);
        return 2;
      }
    } else if (positional.length >= 3) {
      tasks = [{
        task_key: positional[1],
        content: positional.slice(2).join(' ').trim(),
        depends_on: flags['depends-on'] ? splitCsv(flags['depends-on']) : [],
        priority: flags.priority ? Number(flags.priority) : 0,
        to: flags.to || '',
      }];
    }
    const res = await swarmLib.planSwarmTasks(root, {
      as: flags.as || '',
      tasks,
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else if (!res.ok && res.error) log(`swarm plan failed: ${res.error}`);
    else log(`planned ${res.planned} task(s) in #${res.channel}${res.failed ? ` (${res.failed} failed)` : ''}.`);
    return res.exitCode;
  }

  if (sub === 'pull') {
    const res = await swarmLib.pullSwarmTask(root, {
      as: flags.as || positional[1] || '',
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else if (!res.ok && res.error) log(`swarm pull failed: ${res.error}`);
    else if (res.claimed) log(`claimed ${res.task.task_key} as ${res.member}: ${res.task.content}`);
    else log(`no claimable task for ${res.member}${res.blocked.length ? ` (${res.blocked.length} blocked on deps)` : ''}.`);
    return res.exitCode;
  }

  if (sub === 'report') {
    const taskKey = positional[1] || '';
    const status = positional[2] || 'done';
    const content = positional.slice(3).join(' ').trim();
    const res = await swarmLib.reportSwarmTask(root, {
      taskKey,
      status,
      content,
      as: flags.as || '',
      verify: flags.verify || '',
      next: Boolean(flags.next),
      idempotencyKey: flags['idempotency-key'] || '',
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else if (!res.ok) log(`swarm report blocked: ${res.error}`);
    else log(`reported ${res.task_key} ${res.status} as ${res.member}${res.next_task ? ` -> next claimed: ${res.next_task.task_key}` : ''}.`);
    return res.exitCode;
  }

  if (sub === 'watch' || sub === 'status' || sub === 'st') {
    const res = await swarmLib.watchSwarm(root, {
      staleMinutes: flags['stale-minutes'] ? Number(flags['stale-minutes']) : 10,
      expire: Boolean(flags.expire),
      reallocate: Boolean(flags.reallocate),
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else printWatch(res, log);
    return res.exitCode;
  }

  if (sub === 'down' || sub === 'stop') {
    const members = positional.slice(1);
    if (!swarmLib.loadSwarmState(root) && members.length && !options.root && !options.fromFleet) {
      const { fleet } = require('./fleet');
      const prevCode = process.exitCode;
      process.exitCode = 0;
      const idx = args.findIndex((a) => String(a).toLowerCase() === sub);
      const forwarded = idx >= 0 ? [...args.slice(0, idx), 'down', ...args.slice(idx + 1)] : ['down', ...args];
      await fleet(forwarded, { fromSwarm: true });
      const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
      process.exitCode = prevCode;
      return code;
    }
    const res = await swarmLib.downSwarm(root, {
      members,
      channel: flags.channel || '',
      hub: flags.hub || '',
      server: flags.server || '',
      home: options.home,
    }, deps);
    if (asJson) log(JSON.stringify(res, null, 2));
    else log(res.stopped.length ? `stopped swarm members: ${res.stopped.join(', ')}` : (res.note || 'no swarm members stopped.'));
    return res.exitCode;
  }

  // Natural-language front door: anything not matching a fixed verb
  // (`atris swarm "fix auth for 23 min"` or `atris swarm 23 min`) is handed
  // directly to the LLM planner over team + workspace context.
  const leadingDuration = comms.parseDurationTokens(positional);
  const rawInput = leadingDuration
    ? (leadingDuration.consumed > 0
      ? positional.slice(leadingDuration.consumed).join(' ').trim()
      : String(leadingDuration.remainder || '').trim())
    : positional.join(' ').trim();
  const everyParsed = flags.every ? comms.parseDurationTokens([flags.every]) : null;
  const applyDreamOpt = flags['no-apply-dream'] ? false : (flags['apply-dream'] ? true : undefined);
  const res = await comms.runNaturalSwarm(root, rawInput, {
    explicitDuration: leadingDuration,
    intervalMs: everyParsed ? everyParsed.ms : undefined,
    maxCycles: flags['max-cycles'] ? Number(flags['max-cycles']) : undefined,
    once: Boolean(flags.once),
    exec: flags.exec || '',
    verify: flags.verify || '',
    dispatch: Boolean(flags.dispatch),
    mission: flags['no-mission'] ? false : (flags.mission ? true : undefined),
    parallel: flags.parallel ? Number(flags.parallel) : undefined,
    maxTicks: flags['max-ticks'] ? Number(flags['max-ticks']) : undefined,
    inPlace: Boolean(flags['in-place']),
    watchOnly: Boolean(flags['watch-only']),
    stopOnEmpty: flags['no-stop-on-empty'] ? false : (flags['stop-on-empty'] ? true : undefined),
    maxRepeatErrors: flags['max-repeat-errors'] ? Number(flags['max-repeat-errors']) : undefined,
    diagnose: Boolean(flags.diagnose || flags.recover),
    recover: Boolean(flags.recover),
    expire: flags['no-expire'] ? false : true,
    reallocate: flags['no-reallocate'] ? false : true,
    dream: flags['no-dream'] ? false : true,
    applyDream: applyDreamOpt,
    staleMinutes: flags['stale-minutes'] ? Number(flags['stale-minutes']) : 10,
    channel: flags.channel || '',
    hub: flags.hub || '',
    server: flags.server || '',
    engine: flags.engine || '',
    dryRun: Boolean(flags['dry-run']),
    offline: Boolean(flags.offline),
    yes: Boolean(flags.yes),
    json: asJson,
    home: options.home,
    log,
  }, deps);
  if (asJson) log(JSON.stringify(res, null, 2));
  else printNaturalResult(res, log);
  return res.exitCode;
}

module.exports = { swarmCommand };

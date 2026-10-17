// Campaign recursive self-improvement (rsi): distills mission traces into
// per-member reading gains, reward-per-dollar stats, and plain-language
// lessons that feed the next round's planner.

'use strict';

const fs = require('fs');
const path = require('path');
const { buildTrace } = require('./campaign-trace');
const { compareEvents } = require('./campaign-core');
const { getCampaign, listCampaigns, openCampaignStore } = require('./campaign-store');
const rsiRecord = require('./rsi-record');
const { verifyCodeProvenance } = require('./mission-code-provenance');

function round(value, places = 4) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function fmt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(round(value, 4)) : 'n/a';
}

function clip(text, max = 90) {
  const value = String(text || '').replace(/\u2014/g, ', ').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function dedupeLessons(lines) {
  const seen = new Set();
  const out = [];
  for (const raw of lines || []) {
    const line = String(raw || '').replace(/\u2014/g, ', ').trim();
    if (!line.startsWith('- ')) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function aggregateMembers(missions, failureOrder = missions) {
  const byMember = new Map();
  for (const m of missions) {
    const name = m.member || 'unknown';
    if (!byMember.has(name)) {
      byMember.set(name, {
        member: name,
        missions: 0,
        kept: 0,
        failed: 0,
        reverted: 0,
        judge_passed: 0,
        repeat_failures: 0,
         failure_streak: 0,
        reward: 0,
        reward_micros: 0,
        cost_usd: 0,
        wasted_cost_usd: 0,
        reward_per_dollar: null,
        zero_reward_kept: 0,
      });
    }
    const entry = byMember.get(name);
    entry.missions += 1;
    const cost = typeof m.cost_usd === 'number' && Number.isFinite(m.cost_usd) ? m.cost_usd : 0;
    entry.cost_usd = round(entry.cost_usd + cost, 4);
    if (m.outcome === 'kept') {
      entry.kept += 1;
    } else if (m.outcome) {
      entry.failed += 1;
      if (m.outcome === 'reverted') entry.reverted += 1;
      entry.wasted_cost_usd = round(entry.wasted_cost_usd + cost, 4);
    }
    if (typeof m.reward === 'number' && Number.isFinite(m.reward)) {
      entry.reward_micros += Math.round(m.reward * 1000000);
      if (m.reward > 0) entry.judge_passed += 1;
    }
    if (m.outcome === 'kept' && m.reward !== null && m.reward <= 0) {
      entry.zero_reward_kept += 1;
    }
  }
  for (const m of failureOrder) {
    const entry = byMember.get(m.member || 'unknown');
    if (m.outcome === 'kept') entry.failure_streak = 0;
    else if (m.outcome) {
      entry.failure_streak += 1;
      if (entry.failure_streak >= 2) entry.repeat_failures += 1;
    }
  }
  const members = [...byMember.values()].map((entry) => {
    const { failure_streak, reward_micros, ...clean } = entry;
    // Trace shares have six decimals; round the complete member sum only once.
    clean.reward = Math.round(reward_micros / 100) / 10000;
    const ovr = computeMemberOverall(clean);
    return {
      ...clean,
      reward_per_dollar: clean.cost_usd > 0 ? round(clean.reward / clean.cost_usd, 4) : null,
      overall: ovr.overall,
      status: ovr.status,
      note: ovr.note,
    };
  });
  members.sort((a, b) => ((b.overall || 0) - (a.overall || 0)) || (b.reward - a.reward) || (b.kept - a.kept) || a.member.localeCompare(b.member));
  return members;
}

// Compute a deterministic 0-99 overall rating from four observable signals:
// follow-through, result quality, learning after a miss, and retry cost discipline.
function computeMemberOverall(stats = {}) {
  const missions = Number(stats.missions || 0);
  if (missions <= 0) {
    return { overall: null, status: 'unproven', note: 'no missions yet' };
  }
  const kept = Number(stats.kept || 0);
  const reverted = Number(stats.reverted || 0);
  const judgePassed = Number(
    stats.judgePassed !== undefined
      ? stats.judgePassed
      : stats.judge_passed !== undefined
        ? stats.judge_passed
        : 0
  );
  const repeatFailures = Number(
    stats.repeatFailures !== undefined
      ? stats.repeatFailures
      : stats.repeat_failures !== undefined
        ? stats.repeat_failures
        : Math.max(0, missions - kept - 1)
  );
  const wastedCostUsd = Number(
    stats.wastedCostUsd !== undefined
      ? stats.wastedCostUsd
      : stats.wasted_cost_usd !== undefined
        ? stats.wasted_cost_usd
        : 0
  );

  const keptRatio = kept / missions;
  const followThrough = keptRatio * 24 + Math.min(6, kept * 1.2);
  const qualityRatio = Math.min(1, (judgePassed / Math.max(1, missions)) * 1.2 + keptRatio * 0.25);
  const quality = qualityRatio * 20;
  const learning = Math.max(-12, 12 - repeatFailures * 1.4 - reverted * 2.5);
  const costDiscipline = Math.max(-10, 8 - wastedCostUsd * 0.9);

  let score = Math.round(35 + followThrough + quality + learning + costDiscipline);
  score = Math.max(40, Math.min(99, score));

  // Proof integrity caps: unproven volume cannot cross 89; repeat misses cannot cross 84.
  if (kept === 0) score = Math.min(score, 58);
  else if (kept < 3) score = Math.min(score, 89);
  else if (kept < 5 || repeatFailures > 0 || wastedCostUsd > 0) score = Math.min(score, 96);
  if (repeatFailures >= 5) score = Math.min(score, 68);
  // A completed job is follow-through. It is not evidence of improvement
  // until an outside judge measures a gain.
  if (judgePassed <= 0) score = Math.min(score, 75);

  let note = `${kept}/${missions} kept`;
  if (repeatFailures >= 2) {
    note = `${repeatFailures} repeat misses`;
  } else if (wastedCostUsd >= 2) {
    note = `$${wastedCostUsd.toFixed(2)} wasted on failed runs`;
  } else if (kept < 3) {
    note = `early form (${kept}/${missions} kept)`;
  } else if (kept === missions && judgePassed > 0) {
    note = 'clean first-try wins';
  } else if (keptRatio >= 0.8) {
    note = 'steady follow-through';
  }
  if (kept > 0 && judgePassed <= 0) note = 'no judge progress yet';

  return {
    overall: score,
    status: judgePassed <= 0 ? 'unproven' : kept < 3 ? 'proving' : score >= 90 ? 'elite' : score >= 75 ? 'solid' : 'thrashing',
    note,
  };
}

function summarizeTrace(events) {
  const trace = buildTrace(Array.isArray(events) ? events : [], { redact: false });
  if (trace.error) return { error: trace.error };

  const campaign_id = trace.header.campaign_id;
  const title = trace.header.title || trace.header.campaign_id;
  const state = trace.header.final.state;
  const reading = trace.header.final.reading;
  const spent_usd = Number((trace.header.final.budget && trace.header.final.budget.spent) || 0);

  const missions = trace.rows.map((row) => ({
    campaign_id: row.campaign_id,
    mission_id: row.action.mission_id,
    member: row.action.member || 'unknown',
    engine: row.action.engine || null,
    execution_engines: row.execution_engines,
    receipt_path: row.receipt_path,
    started_at: row.started_at,
    finished_at: row.at,
    objective: row.action.objective || null,
    outcome: row.outcome || null,
    cost_usd: typeof row.cost_usd === 'number' ? row.cost_usd : 0,
    reading_before: row.reading_before,
    reading_after: row.reading_after,
    reward: typeof row.reward === 'number' ? row.reward : null,
  }));

  const total_reward = round(
    missions.reduce((sum, m) => sum + (typeof m.reward === 'number' ? m.reward : 0), 0),
    4
  );
  const reward_per_dollar = spent_usd > 0 ? round(total_reward / spent_usd, 4) : null;
  const members = aggregateMembers(missions);

  const rawLessons = [];
  for (const m of missions) {
    if (typeof m.reward === 'number' && m.reward > 0) {
      rawLessons.push(
        `- ${m.member} gained +${round(m.reward, 4)} reading (${fmt(m.reading_before)} to ${fmt(m.reading_after)}) for $${m.cost_usd.toFixed(2)} on ${m.campaign_id}: ${clip(m.objective || m.mission_id, 90)}`
      );
    }
    if (m.outcome === 'kept' && m.reward !== null && m.reward <= 0) {
      rawLessons.push(
        `- ${m.member} finished ${m.mission_id} on ${m.campaign_id} with ${m.reward === 0 ? 'no reading gain' : `reading change ${round(m.reward, 4)}`}; tie verify directly to a failing judge check`
      );
    }
    if (m.outcome && m.outcome !== 'kept') {
      rawLessons.push(
        `- ${m.member} had ${m.mission_id} end ${m.outcome} on ${m.campaign_id}; keep scope to one checkable slice`
      );
    }
  }

  const top = members.find((m) => m.reward > 0);
  if (top) {
    rawLessons.push(
      `- top member by reading gain: ${top.member} (+${round(top.reward, 4)} reading across ${top.kept}/${top.missions} kept, $${top.cost_usd.toFixed(2)} spent)`
    );
  }

  return {
    campaign_id,
    title,
    state,
    reading,
    spent_usd,
    total_reward,
    reward_per_dollar,
    missions,
    members,
    lessons: dedupeLessons(rawLessons),
  };
}

function summarizeStoreRsi(store, campaignId = null) {
  const resolvedStore = typeof store === 'string' ? openCampaignStore(store) : store;
  const views = campaignId
    ? [getCampaign(resolvedStore, campaignId)].filter(Boolean)
    : listCampaigns(resolvedStore);

  const summaries = [];
  for (const v of views) {
    if (!v || v.error || !v.id) continue;
    const events = resolvedStore.read(v.id);
    if (!events || !events.length) continue;
    const summary = summarizeTrace(events);
    if (!summary.error) summaries.push(summary);
  }

  const campaigns_count = summaries.length;
  const completed_count = summaries.filter((s) => s.state === 'done').length;
  const total_reward = round(summaries.reduce((sum, s) => sum + s.total_reward, 0), 4);
  const total_spent_usd = round(summaries.reduce((sum, s) => sum + s.spent_usd, 0), 4);
  const reward_per_dollar = total_spent_usd > 0 ? round(total_reward / total_spent_usd, 4) : null;
  const allMissions = summaries.flatMap((s) => s.missions);
  // Only streaks change order; totals and the public list use the original list.
  // Campaign IDs break cross-campaign ties; stable sorting keeps local order.
  const failureOrder = allMissions.slice().sort((a, b) => compareEvents(
    { at: a.finished_at, origin: a.campaign_id, seq: 0, id: '' },
    { at: b.finished_at, origin: b.campaign_id, seq: 0, id: '' }
  ));
  const mergedMembers = aggregateMembers(allMissions, failureOrder);
  const dedupedLessons = dedupeLessons(summaries.flatMap((s) => s.lessons));

  return {
    campaigns_count,
    completed_count,
    total_reward,
    total_spent_usd,
    reward_per_dollar,
    campaigns: summaries,
    members: mergedMembers,
    missions: allMissions,
    lessons: dedupedLessons,
  };
}

function appendDedupeLessons(filePath, headerText, lessons) {
  const clean = dedupeLessons(lessons);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, headerText);
  }
  if (!clean.length) return;
  const existing = fs.readFileSync(filePath, 'utf8');
  const known = new Set(
    existing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.toLowerCase())
  );
  const fresh = clean.filter((line) => !known.has(line.toLowerCase()));
  if (!fresh.length) return;
  const prefix = existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(filePath, `${prefix}${fresh.join('\n')}\n`);
}

// These rows feed code-revision learning, which treats a file list as complete.
// A campaign's measured gain alone says nothing about files or the runner that
// actually executed. Keep those gains in the campaign view when proof is absent.
function campaignCodeEvidence(root, mission) {
  const engines = mission.execution_engines;
  const supported = new Set(['codex', 'devin', 'cursor', 'agy', 'claude']);
  if (!Array.isArray(engines) || !engines.length || !engines.every((engine) => supported.has(engine))) return null;
  if (new Set(engines).size !== 1) return null;
  const receiptPath = mission.receipt_path;
  if (typeof receiptPath !== 'string' || !receiptPath) return null;
  try {
    const runs = fs.realpathSync(path.join(root, 'atris', 'runs'));
    const file = fs.realpathSync(path.resolve(root, receiptPath));
    if (!file.startsWith(runs + path.sep)) return null;
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (receipt.schema !== 'atris.mission_receipt.v1' || receipt.mission_id !== mission.mission_id) return null;
    const proof = receipt.code_provenance;
    if (!verifyCodeProvenance(root, proof).ok || !proof.files.length) return null;
    const opened = Date.parse(mission.started_at);
    const finished = Date.parse(receipt.at);
    const ended = Date.parse(mission.finished_at);
    if (![opened, finished, ended].every(Number.isFinite) || finished < opened || finished > ended) return null;
    return {
      engine: engines[0], files: proof.files, baseCommit: proof.base_commit,
      openedAt: mission.started_at, finishedAt: receipt.at,
    };
  } catch {
    return null;
  }
}

function syncCampaignAttempts(root, rsi) {
  try {
    const nodes = rsiRecord.latestNodes(root).filter((n) => n && n.lane === 'campaign');
    const unfinished = new Map(nodes
      .filter((n) => n.outcome && n.outcome.status === 'running' && n.context && n.context.ground)
      .map((n) => [n.context.ground, n]));
    const existing = new Map(
      nodes
        .filter((n) => n.outcome && n.outcome.status !== 'running' && n.context && n.context.ground)
        .map((n) => [n.context.ground, n])
    );
    for (const c of rsi.campaigns || []) {
      for (const m of c.missions || []) {
        if (m.outcome !== 'kept' && m.outcome !== 'reverted') continue;
        // The before snapshot runs while the next judge is still due. Wait
        // for its measured reward so deduplication cannot freeze skipped proof.
        if (typeof m.reward !== 'number' || !Number.isFinite(m.reward)) continue;
        const evidence = campaignCodeEvidence(root, m);
        if (!evidence) continue;
        const ground = `${c.campaign_id}/${m.mission_id}`;
        const recorded = existing.get(ground);
        if (recorded && recorded.outcome.verify !== 'skipped') continue;
        const judge =
          m.reading_after === 1 || (m.reward !== null && m.reward > 0)
            ? true
            : m.outcome === 'reverted' && m.reading_after !== null
              ? false
              : null;
        const files = evidence.files;
        const rewardTag = m.reward !== null ? ` (reward ${m.reward >= 0 ? '+' : ''}${m.reward})` : '';
        const reason = `${m.member} on ${c.campaign_id}: ${String(m.objective || '').slice(0, 60)}${rewardTag}`;
        // Keep this mapping here: older installed recorders expose only the
        // open/finish protocol, and mapping must succeed before opening a node.
        const outcome = {
          status: m.outcome === 'kept' ? 'shipped' : files.length ? 'failed' : 'nothing',
          verify: judge === true ? 'pass' : judge === false ? 'fail' : 'skipped',
          reason,
        };
        // Older snapshots finished before the judge ran. Refresh only when
        // the judge supplies proof, keeping the original attempt identity.
        if (recorded && outcome.verify === 'skipped') continue;
        const pending = recorded || unfinished.get(ground);
        if (pending && (!pending.action || pending.action.engine !== evidence.engine || pending.action.policy_id !== 'p-0000')) continue;
        // This is observed history, not a policy choice made now. Record the
        // real code completion time so later human corrections remain visible.
        const node = rsiRecord.recordObservedAttempt(root, {
          lane: 'campaign', ground, ...evidence, ...(pending ? { nodeId: pending.id } : {}),
          outcome: { ...outcome, files, cost_usd: typeof m.cost_usd === 'number' ? m.cost_usd : null },
        });
        if (node) existing.set(ground, { ...pending, id: node, outcome });
      }
    }
  } catch {
    // Best-effort ledger sync
  }
}

function writeRsiSnapshot(root, store, campaignId = null) {
  const activeStore = store || openCampaignStore(root);
  const rsi = summarizeStoreRsi(activeStore, campaignId);

  const stateFile = path.join(root, '.atris', 'state', 'campaign-rsi.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ updated_at: new Date().toISOString(), ...rsi }, null, 2) + '\n');

  const globalLessonsFile = path.join(root, 'atris', 'campaigns', 'lessons.md');
  appendDedupeLessons(
    globalLessonsFile,
    '# Campaign RSI Lessons\n\nDistilled from campaign traces across rounds.\n',
    rsi.lessons
  );

  for (const c of rsi.campaigns) {
    if (!campaignId && (!c.lessons || !c.lessons.length)) continue;
    const cid = c.campaign_id;
    const campaignLessonsFile = path.join(root, 'atris', 'campaigns', cid, 'lessons.md');
    appendDedupeLessons(
      campaignLessonsFile,
      `# Lessons: ${c.title}\n\nDistilled from campaign traces across rounds.\n`,
      c.lessons
    );
    const progressFile = path.join(root, 'atris', 'campaigns', cid, 'progress.md');
    const kept = (c.missions || []).filter((m) => m.outcome === 'kept').length;
    const failed = (c.missions || []).filter((m) => m.outcome && m.outcome !== 'kept').length;
    const progressLines = [
      `# Progress: ${c.title}`,
      '',
      `- state: ${c.state} (reading ${c.reading !== null && c.reading !== undefined ? c.reading : 'n/a'})`,
      `- tried: ${c.missions.length} mission${c.missions.length === 1 ? '' : 's'} (${kept} kept, ${failed} failed)`,
      `- members: ${(c.members || []).map((m) => `${m.member} ${m.overall !== null ? `${m.overall} ovr` : 'unproven'}`).join(', ') || 'none yet'}`,
      '',
      '## Learned',
      ...((c.lessons && c.lessons.length) ? c.lessons : ['- none yet']),
      '',
    ];
    fs.writeFileSync(progressFile, progressLines.join('\n'));
  }

  const scoreboardFile = path.join(root, 'atris', 'campaigns', 'scoreboard.md');
  fs.mkdirSync(path.dirname(scoreboardFile), { recursive: true });
  const scoreboardLines = [
    '# Campaign Scoreboard',
    '',
    `- campaigns: ${rsi.campaigns_count} (${rsi.completed_count} done)`,
    `- total reading gain: +${rsi.total_reward}`,
    `- total spent: $${rsi.total_spent_usd.toFixed(2)}`,
    '',
    '## Member Overall Ratings',
    ...((rsi.members && rsi.members.length)
      ? rsi.members.map((m) => `- ${m.member}: ${m.overall !== null ? `${m.overall} ovr` : 'unproven'} (${m.status || 'proving'}) · ${m.kept}/${m.missions} kept · +${m.reward} reading · $${m.cost_usd.toFixed(2)} · ${m.note || ''}`)
      : ['- none yet']),
    '',
    '## Latest Lessons',
    ...((rsi.lessons && rsi.lessons.length) ? rsi.lessons.slice(-10) : ['- none yet']),
    '',
  ];
  fs.writeFileSync(scoreboardFile, scoreboardLines.join('\n'));

  const membersDir = path.join(root, 'atris', 'campaigns', 'members');
  fs.mkdirSync(membersDir, { recursive: true });
  for (const m of rsi.members || []) {
    if (!m || !m.member) continue;
    const memberFile = path.join(membersDir, `${m.member}.md`);
    const memberMissions = (rsi.missions || []).filter((row) => row && row.member === m.member);
    const memberLessons = (rsi.lessons || []).filter((line) => line.toLowerCase().includes(m.member.toLowerCase()));
    const cardLines = [
      `# Member Card: ${m.member}`,
      '',
      `- overall: ${m.overall !== null ? `${m.overall} ovr` : 'unproven'} (${m.status || 'proving'})`,
      `- form: ${m.note || 'unproven'}`,
      `- record: ${m.kept}/${m.missions} kept (${m.failed || 0} failed, ${m.repeat_failures || 0} repeat misses)`,
      `- reading gain: +${m.reward}`,
      `- cost: $${m.cost_usd.toFixed(2)} ($${(m.wasted_cost_usd || 0).toFixed(2)} on failed runs)`,
      '',
      '## Recent Missions',
      ...(memberMissions.length
        ? memberMissions.slice(-8).map((row) => `- ${row.mission_id}: ${row.outcome || row.status}${typeof row.reward === 'number' ? ` · reward ${row.reward >= 0 ? '+' : ''}${row.reward}` : ''}`)
        : ['- none yet']),
      '',
      '## Lessons',
      ...(memberLessons.length ? memberLessons.slice(-6) : ['- none yet']),
      '',
    ];
    fs.writeFileSync(memberFile, cardLines.join('\n'));
  }

  syncCampaignAttempts(root, rsi);

  return rsi;
}

function formatRsiReport(rsi) {
  const lines = [
    `campaign rsi: ${rsi.campaigns_count} campaign${rsi.campaigns_count === 1 ? '' : 's'} (${rsi.completed_count} done) · +${rsi.total_reward} reading · $${rsi.total_spent_usd.toFixed(2)} spent`,
    'members:',
  ];
  if (rsi.members && rsi.members.length) {
    for (const m of rsi.members) {
      const ovrText = typeof m.overall === 'number' ? `${m.overall} ovr` : 'unproven';
      const noteText = m.note ? ` · ${m.note}` : '';
      lines.push(
        `  ${m.member.padEnd(16)} ${ovrText} · +${m.reward} reading · ${m.kept}/${m.missions} kept · $${m.cost_usd.toFixed(2)}${noteText}`
      );
    }
  } else {
    lines.push('  none yet');
  }
  lines.push('lessons:');
  const topLessons = (rsi.lessons || []).slice(-8);
  if (topLessons.length) {
    for (const lesson of topLessons) {
      lines.push(`  ${lesson}`);
    }
  } else {
    lines.push('  - none yet');
  }
  return lines.join('\n');
}

function missionRewardMap(events) {
  const map = new Map();
  if (!events) return map;
  const summary = Array.isArray(events) ? summarizeTrace(events) : events;
  if (!summary || summary.error || !Array.isArray(summary.missions)) return map;
  for (const m of summary.missions) {
    map.set(m.mission_id, {
      reward: m.reward,
      reading_before: m.reading_before,
      reading_after: m.reading_after,
    });
  }
  return map;
}

function selectNextCampaigns(store, rsiSummary = null) {
  const { listCampaigns } = require('./campaign-store');
  const { rankCampaignMembers } = require('./campaign-loop');
  const rsi = rsiSummary || summarizeStoreRsi(store);
  const topStoreMember = (rsi.members && rsi.members[0] && rsi.members[0].member) || 'executor';
  const activeStates = new Set(['queued', 'running', 'resting']);
  const open = listCampaigns(store).filter((v) => v && !v.error && activeStates.has(v.state));
  const rows = open.map((v) => {
    const trace = summarizeTrace(store.read(v.id));
    const reading = typeof trace.reading === 'number'
      ? trace.reading
      : (v.last_judge && typeof v.last_judge.reading === 'number' ? v.last_judge.reading : 0);
    const ranked = rankCampaignMembers(v, rsi);
    const benched = ranked.filter((r) => r.benched).map((r) => r.member);
    const warm = ranked.find((r) => !r.benched) || ranked[0] || { member: v.owner, overall: 75 };
    const failedCount = (v.missions || []).filter((m) => m.status === 'ended' && m.outcome !== 'kept').length;
    const recommendation = warm.overall < 65
      ? `add seat ${topStoreMember} (top ovr) to replace cold lineup (${ranked.map((r) => `${r.member} ${r.overall} ovr`).join(', ')})`
      : benched.length
        ? `bench ${benched.join(', ')}; route next mission to ${warm.member} (${warm.overall} ovr)`
        : `run next round with ${warm.member} (${warm.overall} ovr)`;
    return {
      id: v.id,
      title: v.title,
      state: v.state,
      reading: Math.round(reading * 10000) / 10000,
      failed_missions: failedCount,
      lead_member: warm.member,
      lead_overall: warm.overall,
      benched_members: benched,
      recommendation,
    };
  });
  return rows.sort((a, b) => {
    if (b.reading !== a.reading) return b.reading - a.reading;
    return a.failed_missions - b.failed_missions;
  });
}

function formatNextCampaigns(list) {
  if (!Array.isArray(list) || !list.length) {
    return 'next campaigns: none open (all campaigns done or paused)';
  }
  const lines = [`next campaigns: ${list.length} open`];
  for (const item of list) {
    lines.push(`  ${item.id} (${item.state} · reading ${item.reading}) -> ${item.recommendation}`);
  }
  return lines.join('\n');
}

async function runOvernightRsi(root, options = {}) {
  const { openCampaignStore } = require('./campaign-store');
  const store = options.store || openCampaignStore(root);
  const rounds = options.rounds === undefined ? 1 : Number(options.rounds);
  const dryRun = Boolean(options.dryRun);
  const stepFn = typeof options.stepCampaign === 'function' ? options.stepCampaign : null;
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('rounds must be a positive whole number');
  if (!dryRun && !stepFn) throw new Error('overnight rsi needs a campaign runner');
  const rsiDir = path.join(root, '.atris', 'state', 'rsi');
  fs.mkdirSync(rsiDir, { recursive: true });
  const logFile = path.join(rsiDir, 'overnight.jsonl');
  const cycles = [];
  const visited = new Set();
  const stopped = new Set();
  for (let i = 1; i <= rounds; i += 1) {
    const before = writeRsiSnapshot(root, store);
    const queue = selectNextCampaigns(store, before)
      .filter((item) => (!options.campaignId || item.id === options.campaignId) && !stopped.has(item.id));
    if (!queue.length) break;
    if (queue.every((item) => visited.has(item.id))) visited.clear();
    const topStoreMember = (before.members && before.members[0] && before.members[0].member) || 'executor';
    const top = queue.find((item) => !visited.has(item.id));
    visited.add(top.id);
    const autoSeated = [];
    let step = null;
    if (!dryRun) {
      // The command calls this only after taking the selected campaign's lock.
      const prepare = () => {
        if (top.lead_overall < 65 && top.lead_member !== topStoreMember) {
          store.append({
            campaign_id: top.id,
            type: 'seat_filled',
            actor: 'auto-improver',
            data: { member: topStoreMember, role: 'cli' },
          });
          autoSeated.push(`${top.id}:${topStoreMember}`);
        }
      };
      try {
        step = await stepFn(top.id, top, prepare);
        if (!step || typeof step !== 'object') step = { ok: false, error: 'campaign runner returned no result' };
        else step = { ok: true, ...step };
      } catch (error) {
        step = { ok: false, error: String(error.message || error) };
      }
      if (!step.ok || step.stop) stopped.add(top.id);
    }
    const after = writeRsiSnapshot(root, store);
    const receipt = {
      at: new Date().toISOString(),
      cycle: i,
      dry_run: dryRun,
      campaigns_open: queue.length,
      top_campaign: top ? top.id : null,
      lead_member: top ? top.lead_member : null,
      lead_overall: top ? top.lead_overall : null,
      auto_seated: autoSeated,
      recommendation: top ? top.recommendation : 'all campaigns done',
      step,
      total_reward: after.total_reward,
      completed_count: after.completed_count,
    };
    fs.appendFileSync(logFile, `${JSON.stringify(receipt)}\n`);
    cycles.push(receipt);
  }
  const finalRsi = summarizeStoreRsi(store);
  return {
    ok: cycles.every((cycle) => !cycle.step || cycle.step.ok),
    rounds: cycles.length,
    cycles,
    next_campaigns: selectNextCampaigns(store, finalRsi),
    rsi: finalRsi,
  };
}

function formatOvernightRsi(result) {
  const lines = [
    `overnight rsi: ${result.rounds} cycle${result.rounds === 1 ? '' : 's'} · +${result.rsi.total_reward} reading · ${result.rsi.completed_count}/${result.rsi.campaigns_count} done`,
  ];
  for (const c of result.cycles) {
    const outcome = c.dry_run ? 'preview' : !c.step || !c.step.ok
      ? `failed: ${(c.step && (c.step.error || c.step.reason)) || 'no result'}`
      : c.step.stop ? `stopped: ${c.step.reason}` : `did: ${c.step.did || 'campaign step'}`;
    lines.push(`  cycle ${c.cycle}: ${c.top_campaign || 'no open campaign'} · ${outcome}`);
  }
  lines.push(formatNextCampaigns(result.next_campaigns));
  return lines.join('\n');
}

module.exports = {
  computeMemberOverall,
  formatNextCampaigns,
  formatOvernightRsi,
  formatRsiReport,
  missionRewardMap,
  runOvernightRsi,
  selectNextCampaigns,
  summarizeStoreRsi,
  summarizeTrace,
  writeRsiSnapshot,
};

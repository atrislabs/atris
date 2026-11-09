'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasFlag, readFlag } = require('../lib/arg-parser');
const { stampLatestOpenBriefForWorktree } = require('../lib/brief-ledger');
const { installKeep, removeKeep } = require('../lib/campaign-keep');
const { isConductorUntracked } = require('../lib/conductor-artifacts');
const space = require('../lib/worktree-space');
const worktreeCore = require('../lib/worktree-core');

const {
  ATRIS_BIN,
  RESCUE_IDLE_MS,
  finishShippedCopy,
  formatKib,
  SWEEP_IDLE_MS,
  SWEEP_EVERY_HOURS,
  SWEEP_KEPT_LABELS,
  assertOneLapProofTree,
  baseBranchName,
  branchName,
  cleanupWorktrees,
  collidingFlights,
  createAgentWorktree,
  createDetachedShipBranch,
  createOrFindPr,
  currentBranch,
  defaultMainlineBase,
  defaultShipTarget,
  defaultStartBase,
  defaultSweepWorkspace,
  deniedLaneForShip,
  describeFlightAge,
  detachedShipBranch,
  findPrimaryRoot,
  flightStampMs,
  gitFailureDetail,
  gitNetworkEnvironment,
  inFlightAgentFlights,
  listActiveProcessPaths,
  listWorktrees,
  lowDiskRefusal,
  mergePrWithRetry,
  newStatusRows,
  normalizeTargetRef,
  parseAgentFlightName,
  parseProcessArgPaths,
  parseWorktrees,
  plural,
  prMergeRef,
  protectedPushRefusal,
  readOneLapProofBinding,
  reapPushedCopy,
  reapShippedCopy,
  recordWorktreeRemoval,
  refreshMovedMapRefs,
  refreshRemoteRef,
  repoRoot,
  restoreRegeneratedAdapterChurn,
  runCommand,
  runGit,
  runShipHealthCheck,
  scheduleShippedCopyRemoval,
  shipMergeRecord,
  shippedCopyRemovalPlan,
  slugify,
  statusCounts,
  statusSnapshot,
  swarloClaim,
  sweepSchedulePlan,
  sweepWorkspace,
  taskTokens,
  unstageConductorArtifacts,
  worktreeHasActiveProcess,
} = worktreeCore;

function printStatus() {
  const root = repoRoot();
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  for (const wt of worktrees) {
    const counts = statusCounts(wt.path);
    const tags = [];
    if (wt.path === primary) tags.push('primary');
    if (path.resolve(wt.path) === path.resolve(root)) tags.push('current');
    const tagText = tags.length ? ` [${tags.join(' ')}]` : '';
    if (!counts) {
      console.log(`${wt.path}${tagText} branch=${wt.branch} missing=true`);
      continue;
    }
    console.log(`${wt.path}${tagText} branch=${wt.branch} staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
  }
}

function startWorktree(args) {
  const root = repoRoot();
  const member = readFlag(args, '--member');
  const agent = readFlag(args, '--agent');
  const owner = member || agent;
  const task = readFlag(args, '--task');
  if (!owner || !task) {
    console.error('Usage: atris worktree start --member <member>|--agent <name> --task "<short task>" [--former-task "<older name of the task>"] [--claim] [--force] [--no-deps]');
    return 2;
  }
  const formerTask = readFlag(args, '--former-task');
  const memberFile = member ? path.join(root, 'atris', 'team', member, 'MEMBER.md') : '';
  if (memberFile && !fs.existsSync(memberFile)) {
    console.error(`warning: no member persona at ${path.relative(root, memberFile)}`);
  }

  const force = hasFlag(args, '--force');
  const now = new Date();
  const flights = inFlightAgentFlights({ root, now });
  const active = flights.filter((flight) => flight.kind === 'worktree');
  const repoName = path.basename(findPrimaryRoot(root));
  console.log(`flights: ${active.length} active agent ${active.length === 1 ? 'worktree' : 'worktrees'} for ${repoName}`);
  const collisions = collidingFlights(flights, slugify(task, 'task', 36));
  if (collisions.length) {
    const label = force ? 'warning' : 'refusing';
    for (const flight of collisions) {
      console.error(`${label}: overlapping flight ${flight.name} (${describeFlightAge(flight, now.getTime())})`);
    }
    console.error(`${label}: another flight may already be doing this work`);
    if (!force) {
      console.error('refusing: pass --force to start anyway');
      return 2;
    }
  }

  let created;
  try {
    created = createAgentWorktree({
      root,
      member,
      agent,
      task,
      formerTasks: formerTask ? [formerTask] : [],
      branch: readFlag(args, '--branch'),
      path: readFlag(args, '--path'),
      base: readFlag(args, '--base') || readFlag(args, '--target'),
      ...(hasFlag(args, '--no-deps') ? { deps: false } : {}),
    });
  } catch (e) {
    console.error(`refusing: ${e.message}`);
    return 2;
  }
  const { path: target, branch, base } = created;

  if (created.reapedBeforeStart.length) {
    console.log(`cleanup: reaped ${created.reapedBeforeStart.length} completed ${created.reapedBeforeStart.length === 1 ? 'worktree' : 'worktrees'}`);
  }
  if (created.cachePrunedBeforeStart.length) {
    console.log(`cleanup: pruned ${created.cachePrunedBeforeStart.length} generated ${created.cachePrunedBeforeStart.length === 1 ? 'cache' : 'caches'}`);
  }
  if (created.space && created.space.removed.length) {
    const count = created.space.removed.length;
    console.log(`space: disk was low, removed ${count} finished build ${count === 1 ? 'copy' : 'copies'} across the workspace; ${space.formatGb(created.space.free)} free now`);
  } else if (created.space && created.space.free !== null && created.space.free < created.space.reapBelow) {
    console.log(`space: ${space.formatGb(created.space.free)} free; no finished build copies were safe to remove`);
  }
  if (created.deps && created.deps.status === 'cloned') {
    console.log(`deps: cloned node_modules from a matching install in ${(created.deps.ms / 1000).toFixed(1)}s; skip npm ci`);
  } else if (created.deps && created.deps.reason !== 'no package-lock.json') {
    console.log(`deps: ${created.deps.reason}`);
  }

  const counts = statusCounts(root);
  if (counts && (counts.staged || counts.unstaged || counts.untracked)) {
    console.log(`note: primary checkout is dirty staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
  }
  console.log(`path: ${target}`);
  console.log(`branch: ${branch}`);
  console.log(`${member ? 'member' : 'agent'}: ${owner}`);
  if (hasFlag(args, '--claim')) {
    const channel = readFlag(args, '--swarlo-channel', 'general');
    const taskKey = readFlag(args, '--swarlo-task-key') || `${slugify(owner, 'agent', 24)}-${slugify(task, 'task', 36)}`;
    const content = readFlag(args, '--swarlo-content') || `${owner} owns ${task} in ${target}`;
    console.log(`swarlo_channel: ${channel}`);
    console.log(`swarlo_claim: ${swarloClaim(target, { channel, taskKey, content })}`);
  }
  console.log(`base: ${base}`);
  console.log(`next: cd ${target}`);
  return 0;
}

function shipHelp() {
  console.log('Usage: atris worktree ship --message "<commit>" --verify "<cmd>" [--merge] [--target <ref>] [--local]');
  console.log('');
  console.log('  --target <ref>  override the default landing target (default: branch atris-base, else origin default branch)');
  console.log('  --local         merge into the local primary checkout instead of pushing and opening a PR');
  console.log('  protected-lane tasks (billing, money, deploy, feedback, ...) can be pushed for review without --merge;');
  console.log('  landing one with --merge or --local needs --allow-denied-lane on written order');
  console.log('  --no-map-refresh  skip the automatic refresh of moved map line references');
  console.log('  --keep-copy     keep this build copy; by default it is removed once the work lands or is pushed');
  console.log('  unstaged regenerated adapter files are skipped unless staged first or named in --message');
  console.log('  recommended flight verify: npm run test:fast && node --test <focused files>');
}

function shipWorktree(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    shipHelp();
    return 0;
  }
  const root = repoRoot();
  const dryRun = hasFlag(args, '--dry-run');
  const noPr = hasFlag(args, '--no-pr');
  const localMode = hasFlag(args, '--local') || hasFlag(args, '--local-merge');
  const merge = hasFlag(args, '--merge');
  const keepCopy = hasFlag(args, '--keep-copy');
  const message = readFlag(args, '--message') || readFlag(args, '-m');
  const verify = readFlag(args, '--verify');
  let branch = currentBranch(root);
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  const targetRef = normalizeTargetRef(root, readFlag(args, '--target') || defaultShipTarget(root));

  if (!branch && path.resolve(root) === path.resolve(primary)) {
    console.error('blocked: detached head on the primary checkout');
    return 2;
  }
  if (!branch) {
    branch = detachedShipBranch(root);
    if (!createDetachedShipBranch(root, branch)) return 2;
  }
  if (branch === 'master' || branch === 'main') {
    console.error('blocked: ship from a feature worktree branch, not master/main');
    return 2;
  }
  if (path.resolve(root) === path.resolve(primary) && !hasFlag(args, '--allow-primary')) {
    console.error('blocked: ship from an isolated worktree, not the primary checkout');
    return 2;
  }
  if (!hasFlag(args, '--allow-denied-lane')) {
    const denied = deniedLaneForShip(root, branch, message);
    if (denied && (merge || localMode)) {
      console.error(`blocked: this branch carries ${denied.taskId} which sits in the protected ${denied.tag} lane; a human lands it (or pass --allow-denied-lane on written order)`);
      return 2;
    }
    const refusal = denied ? protectedPushRefusal(root, branch) : '';
    if (refusal) {
      console.error(refusal);
      return 2;
    }
  }

  let oneLapProof = null;
  try {
    oneLapProof = readOneLapProofBinding(root, branch);
  } catch (error) {
    console.error(`blocked: ${error.message}`);
    return 3;
  }
  const proofTreeMatches = (source) => {
    try {
      assertOneLapProofTree(root, oneLapProof, source);
      return true;
    } catch (error) {
      console.error(`blocked: ${error.message}`);
      return false;
    }
  };

  refreshRemoteRef(root, targetRef);
  const skippedAdapters = restoreRegeneratedAdapterChurn(root, message, { dryRun });
  const ignoredUnstagedFiles = dryRun ? new Set(skippedAdapters) : new Set();
  const counts = statusCounts(root, { ignoredUnstagedFiles, ignoreUntracked: isConductorUntracked })
    || { staged: 0, unstaged: 0, untracked: 0 };
  const dirty = counts.staged || counts.unstaged || counts.untracked;
  if (dirty && !message) {
    console.error('blocked: --message is required when there are local changes to commit');
    return 2;
  }

  if (dirty) {
    console.log(`commit: ${message}`);
    if (!dryRun) {
      runGit(['add', '-A'], { cwd: root });
      unstageConductorArtifacts(root);
      if (!proofTreeMatches('index')) return 3;
      runGit(['commit', '-m', message], { cwd: root });
      if (!proofTreeMatches('head')) return 3;
    }
  } else {
    console.log('commit: skipped (no local changes)');
    if (!dryRun && !proofTreeMatches('head')) return 3;
  }

  if (dryRun) {
    console.log('map: skipped (dry-run)');
  } else {
    refreshMovedMapRefs(root, args);
  }

  if (verify) {
    const beforeVerify = dryRun ? [] : statusSnapshot(root);
    console.log(`verify: ${verify}`);
    if (!dryRun) runCommand(verify, { cwd: root });
    const afterVerifyRows = dryRun ? [] : statusSnapshot(root);
    const verifyDelta = newStatusRows(beforeVerify, afterVerifyRows);
    const afterVerify = dryRun
      ? { staged: 0, unstaged: 0, untracked: 0 }
      : statusCounts(root, { ignoreUntracked: isConductorUntracked })
        || { staged: 0, unstaged: 0, untracked: 0 };
    if (!dryRun && (afterVerify.staged || afterVerify.unstaged || afterVerify.untracked)) {
      console.error(
        `blocked: verifier left checkout dirty staged=${afterVerify.staged} ` +
          `unstaged=${afterVerify.unstaged} untracked=${afterVerify.untracked}`
      );
      if (verifyDelta.length) {
        console.error(`new after verify: ${verifyDelta.slice(0, 8).join(', ')}`);
      }
      return 3;
    }
    if (!dryRun && !proofTreeMatches('head')) return 3;
  } else {
    console.log('verify: skipped (no --verify)');
  }

  const mergeCheck = dryRun
    ? { status: 0, stdout: 'dry-run' }
    : runGit(['merge-tree', '--write-tree', targetRef, 'HEAD'], { cwd: root, check: false });
  if (mergeCheck.status !== 0) {
    console.error(`blocked: branch does not merge cleanly into ${targetRef}`);
    console.error((mergeCheck.stderr || mergeCheck.stdout || '').trim());
    return 3;
  }
  console.log(`merge_check: ${targetRef} clean`);

  let landedOn = '';
  if (localMode) {
    console.log('push: skipped (local mode)');
    if (merge) {
      console.log('merge: requested (local mode)');
      if (!dryRun) {
        const targetBranch = baseBranchName(targetRef);
        const primaryBranch = currentBranch(primary);
        if (primaryBranch !== targetBranch) {
          const switched = runGit(['switch', targetBranch], { cwd: primary, check: false });
          if (switched.status !== 0) {
            throw new Error((switched.stderr || switched.stdout || `git switch ${targetBranch} failed`).trim());
          }
        }
        const primaryCounts = statusCounts(primary, { ignoreUntracked: isConductorUntracked }) || { staged: 0, unstaged: 0, untracked: 0 };
        if (primaryCounts.staged || primaryCounts.unstaged || primaryCounts.untracked) {
          throw new Error(
            `primary checkout dirty staged=${primaryCounts.staged} ` +
            `unstaged=${primaryCounts.unstaged} untracked=${primaryCounts.untracked}`
          );
        }
        runGit(['merge', '--no-ff', branch, '-m', `Merge ${branch}`], { cwd: primary });
        console.log('merge: merged (local mode)');
        landedOn = `refs/heads/${targetBranch}`;
      }
    }
    console.log('pr: skipped (local mode)');
    if (merge && !dryRun) runShipHealthCheck(primary || root);
    if (landedOn) finishShippedCopy({ root, primary, branch, landedOn, keep: keepCopy });
    console.log('done: worktree shipped');
    return 0;
  }

  console.log(`push: origin ${branch}`);
  if (!dryRun) runGit(['push', '-u', 'origin', branch], { cwd: root });

  if (!noPr || merge) {
    const title = message || branch;
    const pr = createOrFindPr(root, branch, targetRef, title, dryRun);
    console.log(`pr: ${pr}`);
    if (merge) {
      console.log('merge: requested');
      if (!dryRun) {
        const mergeRef = prMergeRef(pr);
        const mergeArgs = ['pr', 'merge'];
        if (mergeRef) mergeArgs.push(mergeRef);
        mergeArgs.push('--merge');
        const merged = mergePrWithRetry(mergeArgs, root);
        if (merged.status !== 0) throw new Error((merged.stderr || merged.stdout || 'gh pr merge failed').trim());
        if (/already merged/i.test(`${merged.stdout}${merged.stderr}`)) {
          throw new Error(`gh pr merge reported the PR was already merged (stale PR reused): ${(merged.stdout || merged.stderr).trim()}`);
        }
        const confirmation = spawnSync('gh', ['pr', 'view', mergeRef, '--json', 'state,mergedAt,number,url,mergeCommit'], { cwd: root, encoding: 'utf8' });
        if (confirmation.status !== 0) {
          throw new Error('could not confirm the merge; the source branch was kept');
        }
        let state;
        try { state = JSON.parse(confirmation.stdout); } catch {
          throw new Error('could not read the merge result; the source branch was kept');
        }
        if (state.state === 'OPEN' && !state.mergedAt) {
          console.log('merge: pending; kept the source branch while required checks finish');
          finishShippedCopy({ root, primary, branch, keep: keepCopy });
          return 0;
        }
        if (state.state !== 'MERGED' || !state.mergedAt) {
          throw new Error('the change was not merged; the source branch was kept');
        }
        console.log('merge: merged');
        const record = shipMergeRecord(state);
        if (record) console.log(`merge: record ${JSON.stringify(record)}`);
        landedOn = targetRef;
        const deleted = runGit(['push', 'origin', '--delete', branch], { cwd: root, check: false });
        if (deleted.status === 0) {
          console.log(`merge: remote branch deleted ${branch}`);
        } else {
          const deleteOutput = (deleted.stderr || deleted.stdout || 'remote branch delete failed').trim();
          console.log(`merge: remote branch delete skipped: ${deleteOutput}`);
        }
      }
    }
  } else {
    console.log('pr: skipped (--no-pr)');
  }

  try {
    stampLatestOpenBriefForWorktree(root, {
      result: 'pass',
      note: `worktree ship completed into ${targetRef}`,
    }, { worktree: root });
  } catch {}
  if (merge && !dryRun) runShipHealthCheck(primary || root);
  if (!dryRun) finishShippedCopy({ root, primary, branch, landedOn, keep: keepCopy });
  console.log('done: worktree shipped');
  return 0;
}

function reapShipped() {
  const target = process.env.ATRIS_REAP_WORKTREE || '';
  if (!target) {
    console.error('reap-shipped: ATRIS_REAP_WORKTREE is not set');
    return 2;
  }
  const base = process.env.ATRIS_REAP_BASE || '';
  const result = base
    ? reapShippedCopy({ root: process.cwd(), target, base })
    : reapPushedCopy({ primary: process.cwd(), target, branch: process.env.ATRIS_REAP_BRANCH || '' });
  console.log(`reap-shipped: ${result.removed ? 'removed' : 'kept'} ${target} (${result.reason})`);
  return result.removed ? 0 : 1;
}

function guard(args) {
  const root = repoRoot();
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  if (path.resolve(root) === path.resolve(primary) && !hasFlag(args, '--allow-primary')) {
    console.error('blocked: this is the primary checkout; create an agent worktree first');
    console.error('run: atris worktree start --member <member>|--agent <name> --task "<short task>" --claim');
    return 2;
  }
  const counts = statusCounts(root, { ignoreUntracked: isConductorUntracked });
  if (counts && (counts.staged || counts.unstaged || counts.untracked) && !hasFlag(args, '--allow-dirty')) {
    console.error(`blocked: checkout is dirty staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
    return 3;
  }
  console.log('atris worktree guard: ok');
  return 0;
}

function prune(args) {
  const cmd = ['worktree', 'prune', '--verbose'];
  if (!hasFlag(args, '--apply')) cmd.push('--dry-run');
  const result = runGit(cmd, { cwd: repoRoot(), check: false });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  console.log(output || (hasFlag(args, '--apply') ? 'no stale worktree registrations removed' : 'no stale worktree registrations found'));
  return result.status || 0;
}

function sweepSchedule(args, workspace) {
  const everyHours = Number(readFlag(args, '--every', String(SWEEP_EVERY_HOURS)));
  if (!Number.isFinite(everyHours) || everyHours <= 0) {
    console.error('Usage: atris worktree sweep --install [--every <hours>] [--workspace <dir>]');
    return 2;
  }
  const plan = sweepSchedulePlan({ workspace, everyHours });
  if (hasFlag(args, '--uninstall')) {
    const removed = removeKeep(plan);
    if (!removed.ok) {
      console.error(`refusing: ${removed.error}`);
      return 1;
    }
    console.log(`sweep timer: ${removed.removed === false ? 'was not on' : 'off'} for ${workspace}`);
    return 0;
  }
  if (space.isAgentCopyPath(ATRIS_BIN) || space.isScratchPath(ATRIS_BIN)) {
    console.error(`refusing: this atris runs from ${path.dirname(path.dirname(ATRIS_BIN))}, a folder that gets removed; install the timer from a lasting atris install`);
    return 2;
  }
  const installed = installKeep(plan);
  if (!installed.ok) {
    console.error(`refusing: ${installed.error}`);
    return 1;
  }
  console.log(`sweep timer: on for ${workspace}, every ${everyHours} ${everyHours === 1 ? 'hour' : 'hours'}`);
  console.log(`log: ${plan.log_path}`);
  return 0;
}

function sweep(args) {
  const workspace = path.resolve(readFlag(args, '--workspace') || defaultSweepWorkspace());
  if (hasFlag(args, '--install') || hasFlag(args, '--uninstall')) return sweepSchedule(args, workspace);
  const idleHours = Number(readFlag(args, '--idle-hours', String(SWEEP_IDLE_MS / 3600000)));
  if (!Number.isFinite(idleHours) || idleHours < 0) {
    console.error('Usage: atris worktree sweep [--apply] [--json] [--workspace <dir>] [--idle-hours <n>]');
    return 2;
  }
  const rescueDays = hasFlag(args, '--no-rescue') ? 0
    : Number(readFlag(args, '--rescue-after-days', process.env.ATRIS_WORKTREE_RESCUE_DAYS || String(RESCUE_IDLE_MS / 86400000)));
  if (!Number.isFinite(rescueDays) || rescueDays < 0) {
    console.error('Usage: atris worktree sweep [--apply] [--json] [--workspace <dir>] [--idle-hours <n>] [--rescue-after-days <n>] [--no-rescue]');
    return 2;
  }
  const apply = hasFlag(args, '--apply');
  const report = sweepWorkspace({ workspace, apply, idleMs: idleHours * 3600000, rescueIdleMs: rescueDays * 86400000 });
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({ ok: !report.error, ...report }, null, 2));
    return report.error ? 1 : 0;
  }
  console.log(`sweep: ${apply ? 'applied' : 'dry run'} in ${workspace}, ${space.formatGb(report.before)} free`);
  if (report.error) {
    console.error(`refusing: ${report.error}`);
    return 1;
  }
  let removedTotal = 0;
  let clearedTotal = 0;
  let reviewTotal = 0;
  for (const repo of report.repos) {
    if (repo.error || repo.skipped) {
      console.log(`${repo.name}: skipped (${repo.error || repo.skipped})`);
      continue;
    }
    const saved = apply ? repo.rescued : repo.rescueCandidates;
    const savedSet = new Set(saved);
    const gone = (apply ? repo.removed : repo.candidates).filter((item) => !savedSet.has(item));
    const cleared = apply ? repo.cachePruned : repo.cacheCandidates.filter((item) => item.reason === 'generated_webpack_cache');
    removedTotal += gone.length + saved.length;
    clearedTotal += cleared.length;
    reviewTotal += repo.cacheCandidates.filter((item) => item.reason === 'manual_review_required').length;
    const counts = {};
    for (const item of repo.kept) {
      const label = SWEEP_KEPT_LABELS[item.reason] || item.reason;
      counts[label] = (counts[label] || 0) + 1;
    }
    const keptText = Object.entries(counts).map(([label, count]) => `${count} ${label}`).join(', ');
    console.log(`${repo.name}: ${apply ? 'removed' : 'would remove'} ${plural(gone.length, 'finished copy', 'finished copies')}, ${apply ? 'cleared' : 'would clear'} ${plural(cleared.length, 'webpack cache', 'webpack caches')}; kept ${repo.kept.length}${keptText ? ` (${keptText})` : ''}`);
    if (saved.length) console.log(`  ${apply ? 'saved and removed' : 'would save and remove'} ${plural(saved.length, 'abandoned copy', 'abandoned copies')}`);
    for (const item of saved) {
      const what = item.reason === 'pushed_branch' ? 'already on origin' : `${plural(item.changed_files || 0, 'changed file', 'changed files')}, idle ${item.idle_days} days`;
      console.log(`  ${apply ? 'saved' : 'save'}: ${item.path} -> origin/${item.rescue_branch} (${what}, ${formatKib(item.size_kib)})`);
    }
    for (const item of gone) console.log(`  ${apply ? 'removed' : 'remove'}: ${item.path}`);
    for (const item of repo.kept.filter((entry) => entry.reason === 'rescue_push_failed')) {
      console.log(`  kept: ${item.path} (could not push its work to origin/${item.rescue_branch}: ${item.error})`);
    }
    for (const item of cleared) console.log(`  ${apply ? 'cleared' : 'clear'}: ${item.path}`);
  }
  if (reviewTotal) console.log(`review: ${plural(reviewTotal, 'other build folder waits', 'other build folders wait')} for a person; \`atris worktree cleanup\` in each repo lists them`);
  if (apply) {
    console.log(`free: ${space.formatGb(report.before)} before, ${space.formatGb(report.after)} after`);
  } else if (removedTotal || clearedTotal) {
    console.log('next: atris worktree sweep --apply');
  }
  return 0;
}

function cleanup(args) {
  const asJson = hasFlag(args, '--json');
  const result = cleanupWorktrees({
    root: repoRoot(),
    base: readFlag(args, '--base'),
    apply: hasFlag(args, '--apply'),
  });
  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return 0;
  }
  const action = result.apply ? 'removed' : 'candidate';
  console.log(`cleanup: ${result.apply ? 'applied' : 'dry-run'} base=${result.base}`);
  console.log(`${action}s: ${result.apply ? result.removed.length : result.candidates.length}`);
  for (const item of result.apply ? result.removed : result.candidates) {
    console.log(`${action}: ${item.path} branch=${item.branch} reason=${item.reason}`);
  }
  const review = result.cacheCandidates.filter((item) => item.reason === 'manual_review_required');
  const safe = result.apply ? result.cachePruned : result.cacheCandidates.filter((item) => item.reason === 'generated_webpack_cache');
  console.log(`cache ${result.apply ? 'removed' : 'candidate'}s: ${safe.length}`);
  for (const item of safe) console.log(`cache: ${item.path} size_kib=${item.kib}`);
  console.log(`cache review needed: ${review.length}`);
  for (const item of review) {
    console.log(`review: ${item.path} reason=${item.reason}`);
  }
  console.log(`kept: ${result.kept.length}`);
  if (!result.apply && result.candidates.length) console.log('next: atris worktree cleanup --apply');
  return 0;
}

function guide() {
  console.log('Atris worktree agent recipe');
  console.log('');
  console.log('Default: stay in the current checkout for small, clean, single-agent fixes.');
  console.log('Use a worktree for dirty launchers, parallel agents, risky edits, releases, or long proof runs.');
  console.log('');
  console.log('1. Start isolated work when needed:');
  console.log('   atris worktree start --member <member> --task "<task>" --claim');
  console.log('   atris worktree start --agent <agent> --task "<task>"');
  console.log('');
  console.log('2. Move into the printed path:');
  console.log('   cd <printed path>');
  console.log('   atris worktree guard');
  console.log('');
  console.log('3. Tie work to mission/member state when relevant:');
  console.log('   atris mission start "<objective>" --owner <member> --verify "<cmd>"');
  console.log('   atris member goal-from-mission <member>');
  console.log('   atris member tick <member>');
  console.log('   atris mission tick <id> --verify --complete-on-pass');
  console.log('');
  console.log('4. Ship only from the isolated worktree:');
  console.log('   atris worktree ship --message "<commit>" --verify "<cmd>" --merge [--target <ref>]');
  console.log('   --target <ref> overrides the default landing target (default: branch atris-base, else origin default branch)');
  console.log('   recommended verify: npm run test:fast && node --test <focused files>');
  console.log('');
  console.log('5. Cleanup is part of creation, shipping, and the sweep; run it directly any time:');
  console.log('   atris worktree cleanup');
  console.log('   atris worktree cleanup --apply');
  console.log('   atris worktree sweep --apply              every repo in the workspace');
  console.log('   atris worktree sweep --install            run the sweep every 3 hours');
  console.log('');
  console.log('Notes: start uses the current upstream/default remote base, not dirty local HEAD.');
  console.log('Start reaps completed checkouts first. Cleanup preserves branches, source changes, and files git ignores, skips live work, and prunes only verified webpack caches.');
  console.log('Start clones node_modules from a matching install when package-lock.json matches; skip npm ci when it prints "deps: cloned".');
  console.log('Below 25 GB free, start reaps finished copies in every repo; below 10 GB it refuses (ATRIS_WORKTREE_REAP_BELOW_GB, ATRIS_WORKTREE_MIN_FREE_GB).');
  console.log('A shipped copy is removed as soon as its work is merged or on origin and nothing else runs in it; if something does, a merged copy goes once it has been quiet for 10 minutes (--keep-copy or ATRIS_WORKTREE_KEEP_AFTER_SHIP=1 keeps it).');
  console.log('The sweep saves an abandoned copy (idle 7 days, nothing running in it) to a commit on its branch, pushes it, and removes the copy only after origin has it. Rescues are logged in .atris/state/worktree_removals.jsonl.');
  console.log('Use `atris worktree status` to see all worktrees and dirty counts.');
  return 0;
}

function help() {
  console.log('Usage: atris worktree <guide|start|ship|status|guard|prune|cleanup|sweep>');
  console.log('');
  console.log('  atris worktree guide');
  console.log('  atris worktree start --member <member>|--agent <name> --task "<task>" [--former-task "<older name>"] [--claim] [--force] [--no-deps]');
  console.log('    --force         start even when another recent flight shares a task word');
  console.log('    --former-task   the task\'s older name; a branch left unfinished under it is named, never resumed');
  console.log('    --no-deps       do not clone node_modules from a matching install');
  console.log('  atris worktree ship --message "<commit>" --verify "<cmd>" [--merge] [--target <ref>] [--local]');
  console.log('    --target <ref>  override the default landing target (default: branch atris-base, else origin default branch)');
  console.log('    --local         merge into the local primary checkout instead of pushing and opening a PR');
  console.log('    --no-map-refresh  skip the automatic refresh of moved map line references');
  console.log('    --keep-copy     keep this build copy after it ships');
  console.log('    recommended verify: npm run test:fast && node --test <focused files>');
  console.log('  atris worktree status');
  console.log('  atris worktree guard [--allow-primary] [--allow-dirty]');
  console.log('  atris worktree prune [--apply]');
  console.log('  atris worktree cleanup [--apply] [--json] [--base origin/master]  reap completed checkouts and verified webpack caches');
  console.log('  atris worktree sweep [--apply] [--json] [--workspace <dir>] [--idle-hours 2] [--rescue-after-days 7] [--no-rescue]');
  console.log('    removes merged, idle copies in every repo; saves abandoned copies to their branch on origin, then removes them');
  console.log('  atris worktree sweep --install [--every 3] | --uninstall  run the sweep on a timer');
}

function worktreeCommand(args = []) {
  const sub = args[0] || 'status';
  const rest = args.slice(1);
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    help();
    return 0;
  }
  if (sub === 'guide' || sub === 'recipe') return guide();
  if (sub === 'start') return startWorktree(rest);
  if (sub === 'ship') return shipWorktree(rest);
  if (sub === 'status') {
    printStatus();
    return 0;
  }
  if (sub === 'guard') return guard(rest);
  if (sub === 'prune') return prune(rest);
  if (sub === 'cleanup' || sub === 'clean') return cleanup(rest);
  if (sub === 'sweep') return sweep(rest);
  if (sub === 'reap-shipped') return reapShipped();
  help();
  return 2;
}

module.exports = {
  ...worktreeCore,
  branchName,
  collidingFlights,
  mergePrWithRetry,
  createAgentWorktree,
  lowDiskRefusal,
  deniedLaneForShip,
  protectedPushRefusal,
  createOrFindPr,
  cleanupWorktrees,
  reapShippedCopy,
  scheduleShippedCopyRemoval,
  shippedCopyRemovalPlan,
  sweepSchedulePlan,
  sweepWorkspace,
  defaultMainlineBase,
  defaultStartBase,
  gitFailureDetail,
  gitNetworkEnvironment,
  describeFlightAge,
  flightStampMs,
  listActiveProcessPaths,
  listWorktrees,
  parseAgentFlightName,
  parseProcessArgPaths,
  parseWorktrees,
  normalizeTargetRef,
  recordWorktreeRemoval,
  refreshMovedMapRefs,
  slugify,
  taskTokens,
  statusCounts,
  swarloClaim,
  runShipHealthCheck,
  worktreeCommand,
  worktreeHasActiveProcess,
};

'use strict';

// judge != worker: the builder of a task cannot be the actor whose review
// pass certifies or lands it. This module is the single home for actor
// identity rules; task-db, auto-accept, and the task CLI all lean on it.
// Level 1 trust: normalized string identity + builder exclusion + reserved
// system names + roster validation (warn by default). It stops accidental
// and lazy self-judging and makes deliberate spoofing auditable; signed
// events (level 2) are a follow-up, not this file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const functionalOwner = require('./functional-owner');

// System actors written by the machinery itself; a human or agent may never
// claim/ready/review under these names.
const RESERVED_ACTORS = new Set(['autoland-verifier', 'auto-accept-certified']);

function normalizeActor(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function envActor() {
  return normalizeActor(process.env.ATRIS_AGENT_ID || process.env.USER || '');
}

// Builder identity, oldest signal wins: explicit stamp, then who claimed it,
// then whoever sent the first proof.
function taskBuilder(task) {
  if (!task || typeof task !== 'object') return null;
  const metadata = task.metadata || {};
  const stamped = normalizeActor(metadata.built_by);
  if (stamped) return stamped;
  const claimed = normalizeActor(task.claimed_by);
  if (claimed) return claimed;
  for (const event of task.events || []) {
    if (event && event.event_type === 'proof_ready') {
      const actor = normalizeActor(event.actor || (event.payload && event.payload.actor));
      if (actor) return actor;
    }
  }
  return null;
}

function reviewEventActors(task) {
  const actors = new Set();
  for (const event of (task && task.events) || []) {
    if (!event || !['proof_ready', 'reviewed'].includes(event.event_type)) continue;
    const actor = normalizeActor(event.actor || (event.payload && event.payload.actor));
    if (actor) actors.add(actor);
  }
  return actors;
}

// Actors who reviewed the task and are not its builder.
function independentReviewActors(task) {
  const builder = taskBuilder(task);
  const actors = reviewEventActors(task);
  if (builder) actors.delete(builder);
  return actors;
}

// True when at least one review pass came from someone other than the
// builder. When the builder cannot be resolved at all, fall back to
// requiring two distinct actors — independence cannot be proven from one.
function hasIndependentReview(task) {
  const builder = taskBuilder(task);
  if (!builder) return reviewEventActors(task).size >= 2;
  return independentReviewActors(task).size >= 1;
}

function isReservedActor(actor) {
  return RESERVED_ACTORS.has(normalizeActor(actor));
}

function rosterActors(root) {
  const actors = new Set(functionalOwner.listWorkspaceMemberSlugs(root));
  for (const id of ['atris-2-fast', 'atris2', 'atris2-fast', 'claude', 'codex', 'codex-executor', 'cursor', 'devin', 'executor', 'openclaw', 'windsurf']) {
    actors.add(id);
  }
  try {
    const user = normalizeActor(os.userInfo().username);
    if (user) actors.add(user);
  } catch (_) { /* identity lookup can fail in stripped containers */ }
  const envUser = normalizeActor(process.env.USER);
  if (envUser) actors.add(envUser);
  const agentId = normalizeActor(process.env.ATRIS_AGENT_ID);
  if (agentId) actors.add(agentId);
  try {
    const policyPath = path.join(root || process.cwd(), '.atris', 'policy', 'autoland.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const enabledBy = normalizeActor(policy.enabled_by);
    if (enabledBy) actors.add(enabledBy);
  } catch (_) { /* no policy is fine */ }
  return actors;
}

// off | warn | enforce. Env wins, then .atris/review-policy.json, then off.
// Off by default on purpose: ad-hoc --as names are everywhere in scripts and
// fixtures, and a warning that fires on legitimate flows teaches everyone to
// ignore warnings (the cry-wolf lesson). Reserved-actor rejection and
// builder-exclusion do not depend on this mode and are always enforced.
function actorValidationMode(root) {
  const env = String(process.env.ATRIS_ACTOR_VALIDATION || '').toLowerCase();
  if (['off', 'warn', 'enforce'].includes(env)) return env;
  try {
    const policyPath = path.join(root || process.cwd(), '.atris', 'review-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const mode = String(policy.actor_validation || '').toLowerCase();
    if (['off', 'warn', 'enforce'].includes(mode)) return mode;
  } catch (_) { /* no policy is fine */ }
  return 'off';
}

// Reserved names are rejected in every mode; unknown names pass in warn mode
// (with ok true + reason so callers can print) and fail in enforce mode.
function validateActor(actor, { root } = {}) {
  const normalized = normalizeActor(actor);
  if (!normalized) return { ok: true, mode: 'off', actor: normalized };
  if (isReservedActor(normalized)) {
    return { ok: false, mode: 'enforce', actor: normalized, reason: 'reserved_actor' };
  }
  const mode = actorValidationMode(root);
  if (mode === 'off') return { ok: true, mode, actor: normalized };
  if (rosterActors(root).has(normalized)) return { ok: true, mode, actor: normalized };
  if (mode === 'enforce') return { ok: false, mode, actor: normalized, reason: 'actor_not_on_roster' };
  return { ok: true, mode, actor: normalized, reason: 'actor_not_on_roster' };
}

module.exports = {
  RESERVED_ACTORS,
  normalizeActor,
  envActor,
  taskBuilder,
  reviewEventActors,
  independentReviewActors,
  hasIndependentReview,
  isReservedActor,
  rosterActors,
  actorValidationMode,
  validateActor,
};

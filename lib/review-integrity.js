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

// The names the fleet claims and files proof under (fleet-codex, fleet-claude,
// ...). An engine, not a person: its word can never confirm a job was not needed.
function isFleetEngineActor(actor) {
  return normalizeActor(actor).startsWith('fleet-');
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

// Everyone who ever built the task: the stamped builder, the current claimant, whoever any claim
// event on file names, and whoever handed work in on it (the proof_ready events that carry a
// handed_in_by mark; a review pass leaves none) together with the others that hand-in names as
// having built the work with it (its built_with list: a flight that ran for a member hands in under
// the member's name, and the engines that ran are named there). Authorship is cumulative and nothing clears it, so
// sending a job back, letting the claim go or reopening it never makes a past builder look
// independent again. The system's own names (RESERVED_ACTORS) record passes and checks, never
// builds, so an event under one of them makes no author. `task.events` is whatever the caller has
// of the job's history; a caller with the whole history (the store's authorsOfTask) gets the whole
// answer.
function taskAuthors(task) {
  const authors = new Set();
  if (!task || typeof task !== 'object') return authors;
  const add = (value, { fromEvent = false } = {}) => {
    const name = normalizeActor(value);
    if (name && !(fromEvent && RESERVED_ACTORS.has(name))) authors.add(name);
  };
  const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  add(metadata.built_by);
  add(task.claimed_by);
  const events = Array.isArray(task.events) ? task.events : [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (event.event_type === 'claimed') add(payload.claimed_by || event.actor, { fromEvent: true });
    else if (event.event_type === 'proof_ready') {
      add(payload.handed_in_by, { fromEvent: true });
      // A list of names, not a string to split; anything in it that is not a name is no author.
      if (Array.isArray(payload.built_with)) {
        for (const name of payload.built_with) if (typeof name === 'string') add(name, { fromEvent: true });
      }
    }
  }
  return authors;
}

// Whether this actor ever built the task (see taskAuthors), or is the builder the older rules
// resolve for a row with no other record (taskBuilder).
function isTaskAuthor(task, actor) {
  const name = normalizeActor(actor);
  if (!name || !task || typeof task !== 'object') return false;
  return taskAuthors(task).has(name) || taskBuilder(task) === name;
}

// Actors who reviewed the task and never built any of it.
function independentReviewActors(task) {
  const builder = taskBuilder(task);
  const actors = reviewEventActors(task);
  if (builder) actors.delete(builder);
  for (const author of taskAuthors(task)) actors.delete(author);
  return actors;
}

// True when at least one review pass came from someone who never built any of the task. When
// nobody can be resolved as its builder at all, fall back to requiring two distinct actors.
// Independence cannot be proven from one.
function hasIndependentReview(task) {
  const builder = taskBuilder(task);
  if (!builder && taskAuthors(task).size === 0) return reviewEventActors(task).size >= 2;
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
  normalizeActor,
  isFleetEngineActor,
  taskBuilder,
  taskAuthors,
  isTaskAuthor,
  reviewEventActors,
  independentReviewActors,
  hasIndependentReview,
  isReservedActor,
  rosterActors,
  actorValidationMode,
  validateActor,
};

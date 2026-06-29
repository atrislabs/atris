'use strict';

const fs = require('fs');
const path = require('path');
const escapeRegExp = require('./escape-regexp');

const ENGINE_OWNER_IDS = new Set([
  'atris-2-fast',
  'atris2',
  'atris2-fast',
  'claude',
  'codex',
  'codex-executor',
  'cursor',
  'devin',
  'executor',
  'openclaw',
  'windsurf',
]);

const FUNCTIONAL_MEMBER_TOPICS = [
  {
    owner: 'task-planner',
    terms: ['task', 'plan', 'planner', 'planning', 'preview', 'landing', 'queue', 'backlog', 'owner', 'assignment', 'routing'],
  },
  {
    owner: 'architect',
    terms: ['member', 'team', 'factory', 'architecture', 'workflow', 'role', 'permission', 'policy', 'contract'],
  },
  {
    owner: 'mission-lead',
    terms: ['mission', 'overnight', '24/7', 'autonomy', 'always-on', 'loop', 'heartbeat', 'cadence', 'lease', 'goal'],
  },
  {
    owner: 'validator',
    terms: ['proof', 'review', 'verify', 'verifier', 'validation', 'test', 'check', 'inspect'],
  },
  {
    owner: 'launcher',
    terms: ['release', 'launch', 'publish', 'ship', 'dmg', 'zip', 'post'],
  },
  {
    owner: 'researcher',
    terms: ['research', 'paper', 'source', 'market', 'investigate'],
  },
  {
    owner: 'wiki-miner',
    terms: ['wiki', 'knowledge', 'map', 'docs', 'documentation', 'journal'],
  },
  {
    owner: 'navigator',
    terms: ['navigation', 'where', 'find', 'locate', 'map'],
  },
  {
    owner: 'improver',
    terms: ['improve', 'cleanup', 'clean', 'maintenance', 'tidy', 'stale'],
  },
  {
    owner: 'signal-scout',
    terms: ['signal', 'signals', 'error', 'failure', 'pattern', 'alert', 'watch', 'log', 'logs', 'infer'],
  },
];

function normalizeOwnerSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isEngineOwner(value) {
  return ENGINE_OWNER_IDS.has(normalizeOwnerSlug(value));
}

function listWorkspaceMemberSlugs(root) {
  const teamDir = path.join(root || process.cwd(), 'atris', 'team');
  try {
    return new Set(fs.readdirSync(teamDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => name !== '_template')
      .filter(name => fs.existsSync(path.join(teamDir, name, 'MEMBER.md')))
      .map(normalizeOwnerSlug));
  } catch (_) {
    return new Set();
  }
}

function firstAvailableFunctionalOwner(candidates, existingMembers) {
  for (const candidate of candidates) {
    const owner = normalizeOwnerSlug(candidate);
    if (!owner) continue;
    if (existingMembers.size === 0 || existingMembers.has(owner)) return owner;
  }
  return null;
}

function ownerTermScore(text, term, weight = 1) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(term || '').toLowerCase();
  if (!haystack || !needle) return 0;
  if (/^[a-z0-9-]+$/.test(needle)) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, 'i');
    return re.test(haystack) ? weight : 0;
  }
  return haystack.includes(needle) ? weight : 0;
}

function proposedMemberSlugFromTask({ title, tag }) {
  const source = normalizeOwnerSlug(tag && tag !== true ? tag : title);
  const core = source
    .split('-')
    .filter(part => part && !['add', 'build', 'create', 'design', 'fix', 'make', 'replace', 'ship', 'the', 'with'].includes(part))
    .slice(0, 3)
    .join('-');
  return `${core || 'feature'}-owner`;
}

function resolveFunctionalOwner({ requestedOwner, title, tag, note, goal, root, fallbackOwners } = {}) {
  const requested = normalizeOwnerSlug(requestedOwner);
  const existingMembers = listWorkspaceMemberSlugs(root);
  const highSignalText = [title, note, goal].filter(Boolean).join(' ').toLowerCase();
  const tagText = tag && tag !== true ? String(tag).toLowerCase() : '';
  const text = [highSignalText, tagText].filter(Boolean).join(' ');

  if (requested && !isEngineOwner(requested)) {
    return {
      owner: requested,
      reason: 'explicit_functional_owner',
      requested_owner: requested,
    };
  }

  const exact = firstAvailableFunctionalOwner(
    FUNCTIONAL_MEMBER_TOPICS.filter(topic => text.includes(topic.owner)).map(topic => topic.owner),
    existingMembers
  );
  if (exact) {
    return {
      owner: exact,
      reason: requested ? 'engine_owner_resolved_by_exact_member' : 'inferred_exact_member',
      requested_owner: requested || null,
      executed_by: requested && isEngineOwner(requested) ? requested : null,
    };
  }

  const scored = FUNCTIONAL_MEMBER_TOPICS
    .map(topic => ({
      owner: topic.owner,
      score: topic.terms.reduce((sum, term) => (
        sum
        + ownerTermScore(highSignalText, term, 3)
        + ownerTermScore(tagText, term, 1)
      ), 0),
    }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score);
  const inferred = firstAvailableFunctionalOwner(scored.map(row => row.owner), existingMembers);
  if (inferred) {
    return {
      owner: inferred,
      reason: requested ? 'engine_owner_resolved_by_task_signal' : 'inferred_by_task_signal',
      requested_owner: requested || null,
      executed_by: requested && isEngineOwner(requested) ? requested : null,
    };
  }

  const fallback = firstAvailableFunctionalOwner(fallbackOwners || ['architect', 'task-planner', 'mission-lead', 'validator'], existingMembers)
    || Array.from(existingMembers).find(owner => !isEngineOwner(owner))
    || 'architect';
  return {
    owner: fallback,
    reason: requested ? 'engine_owner_resolved_to_factory_owner' : 'missing_functional_owner_fit',
    requested_owner: requested || null,
    executed_by: requested && isEngineOwner(requested) ? requested : null,
    proposed_member: proposedMemberSlugFromTask({ title, tag }),
  };
}

module.exports = {
  ENGINE_OWNER_IDS,
  FUNCTIONAL_MEMBER_TOPICS,
  normalizeOwnerSlug,
  isEngineOwner,
  listWorkspaceMemberSlugs,
  proposedMemberSlugFromTask,
  resolveFunctionalOwner,
};

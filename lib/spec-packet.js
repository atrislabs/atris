'use strict';

const { EFFORT_LEVELS, classifyTaskEffort, effectiveEffortForEngine } = require('./effort-router');

const FORBIDDEN_PREFIXES = Object.freeze(['.atris/']);
const FORBIDDEN_FILES = Object.freeze(['atris/TODO.md']);

function normalizeRepoPath(filePath) {
  if (typeof filePath !== 'string') return '';
  return filePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(\.\/)+/, '');
}

function isForbiddenPath(filePath) {
  const value = normalizeRepoPath(filePath);
  return FORBIDDEN_FILES.includes(value) || value === '.atris' || FORBIDDEN_PREFIXES.some((prefix) => value.startsWith(prefix)) || value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.split('/').includes('..');
}

function hasPipedVerify(command) {
  return typeof command === 'string' && /(^|[^|])\|(?!\|)/.test(command);
}

function lines(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}

function compileSpecPacket(input = {}) {
  const { goal, title = '', files = [], contract = [], verify = '', antiGoals = [], commitMessage = '', engine = '', job = 'build', effort = null } = input || {};
  const cleanGoal = typeof goal === 'string' ? goal.trim() : '';
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanVerify = typeof verify === 'string' ? verify.trim() : '';
  const cleanEngine = typeof engine === 'string' ? engine.trim() : '';
  const cleanJob = typeof job === 'string' ? job.trim() : '';
  const contractLines = lines(contract);
  const antiGoalLines = lines(antiGoals);
  const errors = [];
  const cleanFiles = [];
  if (!cleanGoal) errors.push('goal is required');
  if (!Array.isArray(files) || !files.length) errors.push('files in scope is required');
  else for (const file of files) {
    const normalized = normalizeRepoPath(file);
    if (!normalized || isForbiddenPath(normalized)) errors.push(`forbidden or unsafe path: ${normalized}`);
    else if (!cleanFiles.includes(normalized)) cleanFiles.push(normalized);
  }
  if (!cleanVerify) errors.push('bare verify command is required');
  else if (hasPipedVerify(cleanVerify)) errors.push('verify command must run bare, never piped');
  const explicit = effort != null && effort !== '';
  const normalizedEffort = String(effort == null ? '' : effort).trim().toLowerCase();
  if (explicit && !EFFORT_LEVELS.includes(normalizedEffort)) errors.push(`invalid effort: ${effort}`);
  if (errors.length) return { ok: false, errors, packet: null, prompt: '' };
  const classified = classifyTaskEffort({ title: cleanTitle || cleanGoal, description: contractLines.join('\n'), job: cleanJob, engine: cleanEngine }, { job: cleanJob });
  const chosenEffort = explicit ? (cleanEngine ? effectiveEffortForEngine(cleanEngine, normalizedEffort) || null : normalizedEffort) : classified.effort;
  const packet = { goal: cleanGoal, title: cleanTitle || cleanGoal, files: cleanFiles, contract: contractLines, antiGoals: antiGoalLines, verify: cleanVerify, commitMessage: typeof commitMessage === 'string' ? commitMessage.trim() : '', job: cleanJob, engine: cleanEngine, effort: chosenEffort, weightClass: classified.weightClass || classified.weight_class, span: classified.span, reason: explicit ? 'explicit effort pin' : classified.reason };
  const sections = [`## Goal\n\n${packet.goal}`, `## Files in scope\n\n${cleanFiles.map((file) => `- ${file}`).join('\n')}`];
  if (contractLines.length) sections.push(`## Exact contract\n\n${contractLines.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  sections.push(`## Do not touch\n\n${[...antiGoalLines, ...FORBIDDEN_PREFIXES, ...FORBIDDEN_FILES].map((item) => `- ${item}`).join('\n')}`, `## Verify (run bare, never piped)\n\n\`\`\`bash\n${cleanVerify}\n\`\`\``, `## Routing\n\nweight_class: ${packet.weightClass}\neffort: ${packet.effort || 'default'}\nspan: ${packet.span || 'bounded'}`);
  return { ok: true, errors: [], packet, prompt: sections.join('\n\n') };
}

function checkScopeDrift(changedFiles = [], allowedFiles = [], options = {}) {
  const normalizeList = (items) => [...new Set((Array.isArray(items) ? items : []).map(normalizeRepoPath).filter(Boolean))];
  const changed = normalizeList(changedFiles);
  const allowed = normalizeList(allowedFiles);
  const allowedSet = new Set(allowed);
  const changedSet = new Set(changed);
  const forbidden = changed.filter(isForbiddenPath);
  const inScope = changed.filter((file) => allowedSet.has(file) && !isForbiddenPath(file));
  const unexpected = changed.filter((file) => !allowedSet.has(file) && !isForbiddenPath(file));
  const missing = allowed.filter((file) => !changedSet.has(file));
  return { ok: !unexpected.length && !forbidden.length && (!options.requireAll || !missing.length), inScope, unexpected, forbidden, missing };
}

function parseSpecPacketPrompt(markdown = '') {
  const text = typeof markdown === 'string' ? markdown : '';
  const section = (name) => {
    const heading = `## ${name}`;
    const start = text.split('\n').findIndex((line) => line.trim() === heading);
    if (start < 0) return '';
    return text.split('\n').slice(start + 1).join('\n').split(/^## /m)[0].trim();
  };
  const fileSection = section('Files in scope');
  const verifySection = section('Verify (run bare, never piped)');
  const fence = verifySection.match(/```[^\n]*\n([\s\S]*?)\n```/);
  return { goal: section('Goal'), files: fileSection.split('\n').filter((line) => /^-\s+/.test(line)).map((line) => normalizeRepoPath(line.replace(/^-\s+/, ''))).filter(Boolean), verify: fence ? fence[1].trim() : '' };
}

module.exports = { FORBIDDEN_PREFIXES, FORBIDDEN_FILES, normalizeRepoPath, isForbiddenPath, hasPipedVerify, compileSpecPacket, checkScopeDrift, parseSpecPacketPrompt };

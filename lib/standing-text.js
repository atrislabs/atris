'use strict';

// Authority follows authorship. Every unattended run of a member reads its
// standing mission (atris/team/<member>/MISSION.md) as the owner's word, and
// that text decides whether the run may land. Agents edit those files too:
// 147 of 208 saves that touched one, across 24 projects, carried an agent's
// mark. So an agent could rewrite "never merge" into "publish and merge every
// tick" and the next run acted on it as the owner's word (reproduced
// 2026-11-19 with the real CLI).
//
// The words that carry the owner's authority are only words the owner stands
// behind: text that was there before this rule, or text a person confirmed on
// its Element card. The member's file and the shared atris/MISSION.md are
// confirmed one file at a time. Any other text still runs ordinary work, under a fixed
// seal where anything that goes out or lands on master waits for the owner's
// yes (lib/yes-lock.js). Like the yes locks, the record lives outside the
// workspace and is not a sandbox: Atris only adds to it on a person's decide.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function recordFile() {
  return path.join(require('./state-home').atrisHome(), 'state', 'standing-text.json');
}

// One project across all its work copies: the git folder they share. A
// folder with no git above it is its own project. Inside git, a lookup that
// fails gives no key, so nothing is seeded and nothing counts as confirmed.
function projectKey(root) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  let dir = path.resolve(root);
  while (!fs.existsSync(path.join(dir, '.git'))) {
    if (dir === path.dirname(dir)) return real(root);
    dir = path.dirname(dir);
  }
  const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  const common = res.status === 0 ? String(res.stdout || '').trim() : '';
  return common ? real(common) : null;
}

const shaOf = (text) => crypto.createHash('sha256').update(text).digest('hex');
const SHARED = 'atris/MISSION.md';

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// The standing words a member's runs read: its own MISSION.md and the
// project's shared atris/MISSION.md. Each file is confirmed on its own, by
// its exact text, so nothing here depends on what the words say.
function standingPieces(owner, root) {
  const dir = require('./mission-core').memberDir(owner, root) || path.join(root, 'atris', 'team', owner);
  return [[owner, readText(path.join(dir, 'MISSION.md'))], [SHARED, readText(path.join(root, 'atris', 'MISSION.md'))]]
    .filter(([, text]) => text)
    .map(([key, text]) => ({ key, text, sha: shaOf(text) }));
}

// The record, or null when it cannot be read: then nothing counts as
// confirmed and nothing is written over it. No file yet is an empty record.
function readRecord() {
  let text;
  try { text = fs.readFileSync(recordFile(), 'utf8'); } catch (error) { return error.code === 'ENOENT' ? {} : null; }
  try {
    const saved = JSON.parse(text);
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
  } catch { return null; }
}

function writeRecord(record) {
  const file = recordFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// The project's confirmed texts. The first time a project is seen, every
// standing mission already in it counts as the owner's: it was there before
// this rule.
function projectRecord(root) {
  const record = readRecord();
  const key = record && projectKey(root);
  if (!key) return null;
  if (!record[key]) {
    const trusted = {};
    let names = [];
    try { names = fs.readdirSync(path.join(root, 'atris', 'team')); } catch {}
    for (const piece of names.flatMap((name) => standingPieces(name, root))) trusted[piece.key] = [piece.sha];
    const shared = readText(path.join(root, 'atris', 'MISSION.md'));
    if (shared) trusted[SHARED] = [shaOf(shared)];
    record[key] = { seeded_at: new Date().toISOString(), trusted };
    writeRecord(record);
  }
  return { record, key, project: record[key] };
}

// Whether the owner stands behind every standing word the member's runs read
// now, and which pieces still wait. An unreadable record confirms nothing.
function standingConfirmed(owner, root) {
  const pieces = standingPieces(owner, root);
  if (!pieces.length) return { confirmed: true, missing: [] };
  const found = projectRecord(root);
  if (!found) return { confirmed: false, unreadable: true, missing: pieces };
  const trusted = found.project.trusted || {};
  const missing = pieces.filter((piece) => !(trusted[piece.key] || []).includes(piece.sha));
  return { confirmed: !missing.length, missing };
}

const lockDir = () => path.join(require('./state-home').atrisHome(), 'state');
const isTrusted = (project, piece) => ((project.trusted || {})[piece.key] || []).includes(piece.sha);

// The person's yes on the card: that exact text now carries the owner's word,
// and yes cards from runs held only by words now confirmed stop waiting.
function confirmStanding(root, key, sha) {
  const found = projectRecord(root);
  if (!found) throw new Error('the record of confirmed missions could not be read, so nothing was confirmed');
  const trusted = found.project.trusted || (found.project.trusted = {});
  trusted[key] = [...new Set([...(trusted[key] || []), sha])];
  const held = found.project.held || {};
  for (const [missionId, pieces] of Object.entries(held)) {
    if (!pieces.every((piece) => isTrusted(found.project, piece))) continue;
    require('./yes-lock').clearFixedSeal(lockDir(), missionId, 'unconfirmed');
    delete held[missionId];
  }
  writeRecord(found.record);
}

// One Element card per text: the words, and a yes that confirms exactly them.
function askToConfirm(root, piece) {
  const taskDb = require('./task-db');
  return taskDb.addTask(taskDb.open(), {
    title: piece.key === SHARED ? 'Confirm the shared standing mission' : `Confirm ${piece.key}'s standing mission`,
    tag: 'needs-human',
    workspaceRoot: taskDb.workspaceRoot(root),
    sourceKey: `standing-mission:${piece.key}:${piece.sha.slice(0, 16)}`,
    metadata: {
      objective: piece.text,
      why_it_matters: 'You have not confirmed these words. Until you do, runs that read them ask before anything goes out or lands on master.',
      standing_mission: { key: piece.key, sha: piece.sha },
    },
  });
}

// The seal an unattended tick runs under when its member's standing words
// are not all confirmed, or null when they are. Says so once per text, with
// a card per text. Once confirmed, yes cards an earlier tick left go away.
function unconfirmedSeal(mission, root, stateDir) {
  const owner = String((mission && mission.owner) || '').trim();
  if (!owner || !/^[a-zA-Z0-9._-]+$/.test(owner)) return null;
  const standing = standingConfirmed(owner, root);
  const yesLock = require('./yes-lock');
  if (standing.confirmed) {
    yesLock.clearFixedSeal(stateDir, mission.id, 'unconfirmed');
    return null;
  }
  const seal = yesLock.unconfirmedSeal();
  if (!yesLock.sealFromState(stateDir, mission.id).length) {
    yesLock.writeYesLocks(stateDir, mission.id, { seal, owner });
    const found = projectRecord(root);
    if (found) {
      (found.project.held || (found.project.held = {}))[mission.id] = standing.missing.map(({ key, sha }) => ({ key, sha }));
      writeRecord(found.record);
    }
  }
  if (standing.unreadable) {
    process.stderr.write(`could not read which standing missions you confirmed, so ${owner}'s run asks before anything goes out or lands on master.\n`);
    return seal;
  }
  const cards = standing.missing.map((piece) => { try { return askToConfirm(root, piece); } catch { return null; } });
  if (cards.some((card) => !card || card.inserted)) {
    const where = cards.every(Boolean) ? 'Confirm them on the card in atris feed.' : 'Its card could not be written.';
    process.stderr.write(`${owner}'s standing mission has words you have not confirmed, so this run asks before anything goes out or lands on master. ${where}\n`);
  }
  return seal;
}

module.exports = { confirmStanding, standingConfirmed, unconfirmedSeal };

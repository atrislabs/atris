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
// its Element card. Any other text still runs ordinary work, under a fixed
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

function missionText(owner, root) {
  return require('./member-save-work').memberStandingMission(owner, root);
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
    for (const name of names) {
      const text = missionText(name, root);
      if (text) trusted[name] = [shaOf(text)];
    }
    record[key] = { seeded_at: new Date().toISOString(), trusted };
    writeRecord(record);
  }
  return { record, key, project: record[key] };
}

// Whether the owner stands behind the member's standing mission as it reads now.
function standingConfirmed(owner, root) {
  const text = missionText(owner, root);
  if (!text) return { confirmed: true, text: '', sha: null };
  const sha = shaOf(text);
  const found = projectRecord(root);
  const list = found && found.project.trusted && found.project.trusted[owner];
  return { confirmed: Array.isArray(list) && list.includes(sha), text, sha };
}

// The person's yes on the card: that exact text now carries the owner's word.
function confirmStanding(root, owner, sha) {
  const found = projectRecord(root);
  if (!found) throw new Error('the record of confirmed missions could not be read, so nothing was confirmed');
  const trusted = found.project.trusted || (found.project.trusted = {});
  trusted[owner] = [...new Set([...(trusted[owner] || []), sha])];
  writeRecord(found.record);
}

// One Element card per text: the words, and a yes that confirms exactly them.
function askToConfirm(root, owner, sha, text) {
  const taskDb = require('./task-db');
  return taskDb.addTask(taskDb.open(), {
    title: `Confirm ${owner}'s standing mission`,
    tag: 'needs-human',
    workspaceRoot: taskDb.workspaceRoot(root),
    sourceKey: `standing-mission:${owner}:${sha.slice(0, 16)}`,
    metadata: {
      objective: text,
      why_it_matters: `An agent changed ${owner}'s standing mission. Until you confirm these words, ${owner}'s runs ask before anything goes out or lands on master.`,
      standing_mission: { member: owner, sha },
    },
  });
}

// The seal an unattended tick runs under when its member's standing mission
// is not confirmed, or null when it is. Says so once per text, with the card.
// Once confirmed, yes cards an earlier tick left under that seal go away.
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
  if (!yesLock.sealFromState(stateDir, mission.id).length) yesLock.writeYesLocks(stateDir, mission.id, { seal, owner });
  let card = null;
  try { card = standing.sha ? askToConfirm(root, owner, standing.sha, standing.text) : null; } catch {}
  if (!card || card.inserted) {
    process.stderr.write(`${owner}'s standing mission was changed by an agent and you have not confirmed it, so this run asks before anything goes out or lands on master. ${card ? 'Confirm it on its card in atris feed.' : 'Its card could not be written.'}\n`);
  }
  return seal;
}

module.exports = { confirmStanding, standingConfirmed, unconfirmedSeal };

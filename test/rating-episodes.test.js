'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadSeason } = require('../lib/gm-season');
const { ratingCommand } = require('../commands/rating');

test('real event history scores one result per claim, handoffs, expiry dates, and structured merges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rating-episodes-'));
  const dbPath = path.join(dir, 'tasks.db');
  const db = new DatabaseSync(dbPath);
  const now = Date.now(), day = 86400000;
  try {
    db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,status TEXT,tag TEXT,workspace_root TEXT,claimed_by TEXT,claimed_at INTEGER,created_at INTEGER,updated_at INTEGER,metadata TEXT);
      CREATE TABLE task_events (event_id TEXT PRIMARY KEY,task_id TEXT,version INTEGER,workspace_root TEXT,actor TEXT,event_type TEXT,payload TEXT,created_at INTEGER)`);
    const t = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)');
    const e = db.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let id = 0;
    function task(name, events) {
      t.run(name, name, 'archived', dir, now - 40 * day, now, '{}');
      events.forEach(([type, actor, payload, at], i) => e.run(String(++id), name, i + 1, dir, actor, type, JSON.stringify(payload), at));
    }
    const at = now - day;
    task('handoff', [['claimed','alpha',{},at], ['claim_released','alpha',{reason:'handoff'},at+1], ['claimed','beta',{},at+2], ['proof_ready','beta',{landing:{merge_commit:'abcdef123456'}},at+3], ['archived','auto',{reason:'old'},at+4]]);
    task('repeat', [['claimed','alpha',{},at], ['revision_requested','reviewer',{reason:'redo'},at+1], ['reopened','reviewer',{reason:'redo'},at+2], ['archived','auto',{reason:'old'},at+3]]);
    task('old-expiry', [['claimed','alpha',{},now-40*day], ['claim_expired','auto',{claimed_by:'alpha',lease_until:now-35*day,reason:'lease'},at]]);
    task('iso-expiry', [['claimed','alpha',{},now-40*day], ['claim_expired','auto',{claimed_by:'alpha',lease_until:new Date(now-35*day).toISOString(),reason:'lease'},at]]);
    task('new-expiry', [['claimed','alpha',{},at], ['claim_expired','auto',{claimed_by:'alpha',lease_until:at+10,reason:'lease'},at+20], ['archived','auto',{reason:'old'},at+30]]);
    task('merged-pr', [['claimed','beta',{},at], ['landing','beta',{pull_request:{number:42,state:'merged'}},at+1], ['archived','auto',{reason:'old'},at+2]]);
    task('fallback-expiry', [['claimed','beta',{},at], ['claim_expired','auto',{claimed_by:'beta',reason:'expired'},at+5]]);
    task('text', [['claimed','beta',{},at], ['proof_ready','beta',{proof:'merged PR 123 at abcdef123456'},at+1], ['archived','auto',{reason:'no proof'},at+2]]);
    task('slow', [['claimed','alpha',{},at], ['claim_released','alpha',{reason:'slow'},at+1], ['claimed','beta',{},at+120002]]);
    task('same', [['claimed','alpha',{},at], ['claim_released','alpha',{reason:'same'},at+1], ['claimed','alpha',{},at+2]]);
    db.close();
    const season = loadSeason(dir, {dbPath, now, lastSeen:null});
    assert.equal(season.error, undefined);
    const finished = season.outcomes.filter(x => x.kind !== 'took');
    const results = name => finished.filter(x => x.task_id === name);
    assert.deepEqual(results('handoff').map(x => [x.member,x.kind]), [['beta','landed']]);
    assert.deepEqual(results('repeat').map(x => x.kind), ['sent_back']);
    assert.equal(results('old-expiry').length, 0);
    assert.equal(results('iso-expiry').length, 0);
    const wider = loadSeason(dir, {dbPath, now, days: 40, lastSeen:null});
    assert.equal(wider.outcomes.find(x => x.task_id === 'iso-expiry' && x.kind === 'dropped').at, now - 35 * day);
    assert.deepEqual(results('new-expiry').map(x => [x.member,x.at,x.reason]), [['alpha',at+10,'lease']]);
    assert.equal(results('merged-pr')[0].kind, 'landed');
    assert.equal(results('fallback-expiry')[0].at, at+5);
    assert.deepEqual(results('text').map(x => x.kind), ['abandoned']);
    assert.equal(results('slow')[0].kind, 'dropped');
    assert.equal(results('same')[0].kind, 'dropped');
    let output = '';
    assert.equal(ratingCommand(['alpha'], {root:dir,season,lineup:null,write:s => output += s}), 0);
    assert.match(output, /top miss reasons:/);
    assert.match(output, /1: lease/);
    assert.equal((output.match(/  1: /g) || []).length, 3);
    let json = '';
    ratingCommand(['alpha','--json'], {root:dir,season,lineup:null,write:s => json += s});
    assert.equal(JSON.parse(json).member.miss_reasons.length, 3);
  } finally { try { db.close(); } catch {} fs.rmSync(dir, {recursive:true,force:true}); }
});

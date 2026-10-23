'use strict';

// Protected lanes inside a campaign. A mission that touches billing, security,
// deploys, or customers pauses before its first tick (missionProtectedLaneHold).
// Inside a campaign that pause becomes an ask; a person answering yes approves
// that one lane for that one campaign. The approval lives in the campaign's own
// event log, where only a person's answer closes an ask.

const { isHumanActor } = require('./campaign-schema');

const LANE_ASK_KIND = 'protected_lane';
const YES = /^\s*(y|yes|ok|okay|approve|approved|allow|go|sure)\b/i;
const PAUSE_LINE = /paused: protected-lane-([a-z]+)/i;

// The lane a paused `atris mission run` reported, or null.
function pausedLane(output) {
  const match = String(output || '').match(PAUSE_LINE);
  return match ? match[1].toLowerCase() : null;
}

// Lanes a person approved, from a campaign's events.
function approvedLanes(events) {
  const asked = new Map();
  const lanes = new Set();
  for (const event of events || []) {
    const data = event && event.data ? event.data : {};
    if (event.type === 'ask_opened' && data.kind === LANE_ASK_KIND && data.lane) asked.set(data.ask_id, data.lane);
    if (event.type === 'ask_answered' && asked.has(data.ask_id) && isHumanActor(event.actor) && YES.test(String(data.answer || ''))) {
      lanes.add(asked.get(data.ask_id));
    }
  }
  return lanes;
}

// Lanes with an open ask in this campaign.
function openLaneAsks(events) {
  const open = new Map();
  for (const event of events || []) {
    const data = event && event.data ? event.data : {};
    if (event.type === 'ask_opened' && data.kind === LANE_ASK_KIND && data.lane) open.set(data.ask_id, data.lane);
    if (event.type === 'ask_answered') open.delete(data.ask_id);
  }
  return new Set(open.values());
}

// True when this campaign already has an open ask for the lane, so the loop asks once.
function laneAskOpen(events, lane) {
  return openLaneAsks(events).has(lane);
}

function laneQuestion(lane, member, objective) {
  const what = String(objective || '').replace(/\s+/g, ' ').trim();
  const short = what.length > 140 ? `${what.slice(0, 139)}…` : what;
  return `${member}'s mission touches ${lane}: "${short}". Missions that touch ${lane} wait for you. Let this campaign work on ${lane}? Answer yes to allow it.`;
}

module.exports = { LANE_ASK_KIND, pausedLane, approvedLanes, laneAskOpen, laneQuestion, openLaneAsks };

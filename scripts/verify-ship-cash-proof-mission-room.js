#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const reportPath = path.join(root, 'atris/reports/2026-06-30-ship-cash-proof-mission-room.md');
const roomReceiptPath = path.join(root, 'atris/runs/mission-room-2026-06-30T11-03-17-311Z-ship-cash-proof-mission-room.json');

function fail(message) {
  console.error(`SHIP CASH PROOF MISSION ROOM VERIFY FAILED: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(reportPath)) fail('missing cash proof packet');
if (!fs.existsSync(roomReceiptPath)) fail('missing Mission Room receipt');

const body = fs.readFileSync(reportPath, 'utf8');
const required = [
  'Ship Cash Proof Mission Room',
  'Mission: mission-2026-06-30-ship-cash-proof-mission-room-349f1394',
  'Task: CLI-567',
  'approve, revise, or stop',
  'atris/runs/mission-room-2026-06-30T11-03-17-311Z-ship-cash-proof-mission-room.json',
  'one-screen Mission Room proof',
  'What You Are Looking At',
  'What Keshav Approves',
  'What Does Not Happen',
  'Buyer-Readable Core',
  'This is not cash collected.',
  'No real-world send.',
  'No invented price.',
  'No DoorDash collection work.',
  'No claim that cash was collected.',
  'Timeline',
  'Messy pressure captured',
  'Product wedge reused',
  'Room generated',
  'Proof attached',
  'Boundary set',
  'Next goal',
  'node scripts/verify-ship-cash-proof-mission-room.js',
];

for (const phrase of required) {
  if (!body.includes(phrase)) fail(`missing phrase: ${phrase}`);
}

const numberedTimeline = body.match(/^\d+\. /gm) || [];
if (numberedTimeline.length < 5) fail('mission timeline needs at least 5 numbered steps');

let receipt;
try {
  receipt = JSON.parse(fs.readFileSync(roomReceiptPath, 'utf8'));
} catch (error) {
  fail(`Mission Room receipt is not JSON: ${error.message}`);
}

if (receipt.schema !== 'atris.mission_room_receipt.v1') fail('bad Mission Room receipt schema');
if (receipt.room?.name !== 'Ship Cash Proof Mission Room') fail(`receipt room name mismatch: ${receipt.room?.name || 'missing'}`);
if (receipt.room?.approval_packet?.status !== 'awaiting_operator_approval') fail('receipt must preserve operator approval gate');
if (!Array.isArray(receipt.room?.timeline_preview?.items) || receipt.room.timeline_preview.items.length < 5) {
  fail('receipt missing human timeline preview');
}

console.log('Ship Cash Proof Mission Room landing');
console.log('Changed: one-screen Mission Room cash proof is ready for approve/revise/stop.');
console.log('How I checked: verified the landing and the linked Mission Room receipt.');
console.log(`What I tested: ${numberedTimeline.length} timeline items; receipt room ${receipt.room.name}; approval gate ${receipt.room.approval_packet.status}.`);
console.log('Decision: approve before writing the buyer send draft; no send happens here.');
console.log('Receipt: atris/reports/2026-06-30-ship-cash-proof-mission-room.md');

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildMissionRoom,
  writeMissionRoomReceipt,
  missionRoomLines,
} = require('../lib/mission-room');

test('buildMissionRoom validates input and builds approval-gated and trusted rooms', () => {
  assert.throws(
    () => buildMissionRoom('   '),
    (err) => err && err.code === 'MISSION_ROOM_INPUT_REQUIRED',
    'should throw MISSION_ROOM_INPUT_REQUIRED on blank input'
  );

  const rawInput = 'Decide next useful mission for customer onboarding and cash proof';
  const approvalRoom = buildMissionRoom(rawInput, { owner: 'agent-1' });

  assert.strictEqual(approvalRoom.schema, 'atris.mission_room.v1');
  assert.strictEqual(approvalRoom.name, 'Decide Next Useful Mission Room');
  assert.strictEqual(approvalRoom.owner, 'agent-1');
  assert.strictEqual(approvalRoom.execution_mode, 'approval_gated');
  assert.strictEqual(approvalRoom.chat_zone.status, 'clarifying');
  assert.strictEqual(approvalRoom.approval_packet.status, 'awaiting_operator_approval');
  assert.strictEqual(approvalRoom.receipt_slug, 'decide-next-useful-mission-room');
  assert.strictEqual(approvalRoom.clarifying_questions.length, 3);
  assert.strictEqual(typeof approvalRoom.source.input_hash, 'string');
  assert.ok(approvalRoom.timeline_preview.items.length >= 5);

  const trustedRoom = buildMissionRoom('cut runway with product-led cash proof', {
    trustedRun: true,
    owner: 'builder',
  });
  assert.strictEqual(trustedRoom.name, 'Ship Product-Led Cash Proof Mission Room');
  assert.strictEqual(trustedRoom.execution_mode, 'trusted_run');
  assert.strictEqual(trustedRoom.chat_zone.status, 'ready_to_run');
  assert.strictEqual(trustedRoom.approval_packet.status, 'trusted_auto_run');
  assert.strictEqual(trustedRoom.result.status, 'ready_to_run');
});

test('writeMissionRoomReceipt writes receipt and updates thinking memory inside temp root', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-room-test-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpDir;

  try {
    const fixedDate = new Date('2026-10-23T12:00:00.000Z');
    const room = buildMissionRoom('need cash proof for buyer revenue', {
      root: tmpDir,
      owner: 'lead',
    });

    const result = writeMissionRoomReceipt(room, {
      root: tmpDir,
      at: fixedDate,
    });

    assert.strictEqual(result.receipt.schema, 'atris.mission_room_receipt.v1');
    assert.strictEqual(result.receipt.at, fixedDate.toISOString());
    assert.ok(fs.existsSync(result.absolutePath), 'receipt file should exist on disk');

    const fileContent = JSON.parse(fs.readFileSync(result.absolutePath, 'utf8'));
    assert.strictEqual(fileContent.schema, 'atris.mission_room_receipt.v1');
    assert.strictEqual(fileContent.room.name, room.name);
    assert.strictEqual(fileContent.room.owner, 'lead');

    const thinkingPath = path.join(tmpDir, 'atris', 'thinking.md');
    assert.ok(fs.existsSync(thinkingPath), 'thinking.md should be created');
    const thinkingText = fs.readFileSync(thinkingPath, 'utf8');
    assert.ok(thinkingText.includes('<!-- ATRIS_MISSION_ROOM_SIGNALS:START -->'));
    assert.ok(thinkingText.includes(room.name));

    const lines = missionRoomLines(result.room, result.relativePath);
    assert.ok(Array.isArray(lines));
    assert.strictEqual(lines[0], 'Mission Room');
    assert.ok(lines.some((line) => line.includes(`Mission: ${room.name}`)));
    assert.ok(lines.some((line) => line.includes(`Receipt: ${result.relativePath}`)));
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

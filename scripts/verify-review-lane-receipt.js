#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const receiptPath = process.argv[2] || 'atris/runs/mission-mission-2026-06-29-review-proof-ready-cli-547-a-219ec15f-2026-06-30T03-48-04-401Z.json';
const absolutePath = path.resolve(process.cwd(), receiptPath);

function fail(message) {
  console.error(`REVIEW LANE VERIFY FAILED: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(absolutePath)) {
  fail(`missing receipt ${receiptPath}`);
}

const receipt = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
if (receipt.schema !== 'atris.mission_receipt.v1') {
  fail(`unexpected schema ${receipt.schema}`);
}
if (receipt.mission_id !== 'mission-2026-06-29-review-proof-ready-cli-547-a-219ec15f') {
  fail(`unexpected mission ${receipt.mission_id}`);
}
if (receipt.result?.passed !== true) {
  fail('receipt result did not pass');
}
if (receipt.result?.verifier_result?.passed !== true) {
  fail('review-lane verifier did not pass');
}
if (!receipt.result?.verifier_result?.stdout?.includes('"human_accept": false')) {
  fail('receipt does not prove human accept stayed disabled');
}

console.log('REVIEW LANE RECEIPT VERIFIED');
console.log(`receipt=${receiptPath}`);
console.log(`verifier=${receipt.verifier}`);

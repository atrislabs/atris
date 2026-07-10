# Validation - Self-driving mission

> **Role:** Feature contract gate
> **Executor:** Validator Agent
> **Rule:** If any step fails, the feature packet is incomplete.

---

## 1. Static Contract Check

- [ ] Run the exact command from the repository root:

```bash
node -e "const fs=require('fs'); const d='atris/features/self-driving-mission'; const files=['idea.md','build.md','validate.md']; for (const f of files) { if (!fs.existsSync(d+'/'+f)) throw new Error('missing '+f); } const idea=fs.readFileSync(d+'/idea.md','utf8'); const build=fs.readFileSync(d+'/build.md','utf8'); for (const term of ['## Problem Statement','## ASCII Visualization','## Autonomy Ladder','## Driving Contract','## Success Criteria','## Nearest-neighbor Blend']) { if (!idea.includes(term)) throw new Error('idea missing '+term); } for (const term of ['## Files Touched','## Build Steps','## Testing Strategy','## Error Cases','## Rollback Plan']) { if (!build.includes(term)) throw new Error('build missing '+term); } console.log('self-driving mission contract: pass');"
```

- **Expect:** `self-driving mission contract: pass` and exit code 0.

---

## 2. Structure Search

- [ ] Run:

```bash
rg -n "destination|engine broker|replan|restaff|hard gate|arrival receipt|verified time-to-arrival" atris/features/self-driving-mission
```

- **Expect:** Matches in `idea.md` and `build.md` covering the destination, routing, recovery, human boundary, arrival proof, and optimization metric.

---

## 3. Build-phase Runtime Gate

When implementation begins, run this bare command with no pipe:

```bash
node --test test/self-driving-mission.test.js test/mission-status.test.js test/fleet.test.js test/radar.test.js test/engine.test.js
```

- **Expect:** Exit code 0.
- **Required simulation:** one destination reaches verified arrival after an injected primary-engine failure, with completed proof preserved and a different eligible engine recorded for recovery.

---

## 4. Safety Regression

- [ ] Destination changes require operator approval.
- [ ] Money, outbound communication, secrets, destructive actions, and irreversible changes park at a human hard gate.
- [ ] Overlapping-file or dependency-linked legs never run concurrently.
- [ ] A mission cannot claim arrival while any required leg lacks a passing verifier receipt.
- [ ] Emergency stop preserves worktrees, current position, receipts, and a resumable next maneuver.

---

## 5. Performance Benchmark

Run the same pinned destination, repository snapshot, budget, and acceptance bar twice:

1. A fixed single-engine baseline.
2. The self-driving broker with the installed engine roster.

Record verified time-to-arrival, accepted completion, estimated spend, bounces, recoveries, and human interventions. The first release passes only if it lowers verified time-to-arrival without reducing accepted quality or weakening a hard gate.

---

**Status:** Packet Verified; Runtime Pending

# Morning report, math night 2026-07-22

## Waiting on you

1. Review the Seymour note. It claims the exhaustive record for the second neighborhood conjecture doubled from 7 to 14 vertices, 15 with one short lemma, backed by 57 machine-checked DRAT proofs; the draft PDF is at atris/team/researcher/math-night-2026-07-22/seymour-note/main.pdf and every proof receipt sits next to it.
2. Decide whether the note goes to an outside mathematician for review or gets posted as is. The machine parts are checked; the two short human arguments (the shard-covering argument and Lemma T) have been reviewed by no one, which is the only real submission risk.
3. Decide whether to archive the proof artifacts before cleanup. They are about 30GB, almost all Seymour DRAT files, sitting in a session temp folder that will eventually be wiped; without them the note's proofs are no longer independently re-checkable.
4. Close the mission when satisfied. It is verified and ready: `atris mission complete mission-2026-07-23-overnight-math-fleet-harvest-51db0080 --proof "atris/runs/mission-mission-2026-07-23-overnight-math-fleet-harvest-51db0080-2026-07-23T05-44-58-354Z.json"`

## What the night produced

Ten open conjectures attacked across eight rounds, zero refuted, five verification frontiers extended past their published records, everything committed at 555002f.

- Seymour is now certified through 14 vertices (57 of 57 DRAT proofs verified) and closed at 15 via an independent theorem; all 16-vertex shards are solver-UNSAT but the final 4.2GB proof check is still running, so 16 is not yet claimable and we are saying so.
- The Ramsey R(5,5) exclusion theorem is now fully machine-checked: no counterexample coloring has any of four symmetry types, hence no vertex-transitive counterexample exists, and the overnight audit closed its last gap by re-proving all three SAT classes with two independent encoders plus verified DRAT proofs.
- Hajos closed both remaining sweeps: all 3,459,386 8-regular graphs on 14 vertices and all 805,579 10-regular graphs on 15 vertices decompose within the conjectured bound, with class totals matching OEIS exactly.
- Erdos-Gyarfas closed the 36-vertex girth-7 class: all 95,079,083 graphs contain a cycle of length 8 or 16, zero exceptions.
- Four of the eleven giant circulant weighing systems finished exhaustively empty, about 92 billion search nodes with per-shard ledgers.
- The dawn certifier re-ran every checkable receipt first hand (hashes, DRAT re-verifications, the full 45-receipt scan) and found zero proof failures anywhere all night.

One incident, handled: session teardown silently killed the big background proof checks twice, at 07:40 and again at the certifier's forced close. I caught it at 07:53, relaunched all three in detached sessions that teardown cannot reach, and verified them alive; the relauncher script is saved and idempotent.

## Next moves

- Researcher: harvest the in-flight runs as they land (the two Seymour proof checks, the 17 and 18 vertex solvers, the two Ramsey symmetry classes, the EG shard receipt); the exact certification recipe is already written in artifacts/DAWN_PATROL_STATUS.md.
- You or an outside reviewer: read the two human lemmas in the Seymour note before anything is submitted; that is the last unreviewed link in the chain.
- Task-planner: decide the fate of the two orphan lanes, the 7 remaining CW giants and the Gallai perturbation sweep, either a dedicated lane or an explicit drop.

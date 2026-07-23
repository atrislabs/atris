# Excluded automorphism cycle types for a hypothetical (5,5)-Ramsey coloring of K_43

Status: round-7 closing pass, 2026-07-23 07:45 CEST. The round-6 hardening
result stands: |H|=42/21/14 UNSATs each proven twice, with retained,
drat-trim-verified DRAT proofs (see table). Round-7 events, reported exactly:
- The 07:07 audit-grade CaDiCaL+DRAT run on |H|=7 DIED without a result at
  ~07:12 (process gone, empty .res/.time, DRAT truncated at 78 MB) - killed by
  session teardown, not by the instance. The partial DRAT was discarded.
  RELAUNCHED detached at 07:42 (nice 15, 3h wall cap) -> round4/multsym_H7.res.
- pysat mult_sym PID 60307 (|H|=7) was KILLED at 07:41 after 7h35m with no
  result: final status UNDECIDED for that process (round2/multsym.log ends at
  "129 orbit vars, 273696 distinct clauses", no verdict line). Its queued
  |H|=6/3/2 instances were NOT REACHED; the cadical lane supersedes it.
- |H|=6 CaDiCaL+DRAT launched detached at 07:42 (nice 15, 90-min wall cap)
  -> round4/multsym_H6.res.
- inv_sat 21 (PID 17558) and ball_sat 20 (PID 17559): still RUNNING at 6h20m,
  no output since entering the solver -> UNDECIDED as of this pass; left
  running (under the 8h usefulness bar).
Next harvester: read round4/multsym_H7.res and round4/multsym_H6.res (empty
file = capped/killed = UNDECIDED; "s UNSATISFIABLE" = drat-trim the matching
.drat before belief; drat-trim binary: scratchpad seymour-r4/drat-trim/),
and final-status PIDs 17558/17559.

Claim class: computational theorems, each an exact UNSAT/exhaust with the stated
evidence file. "Excluded" means: no 2-coloring of E(K_43) avoiding monochromatic
K5 in both colors admits a nontrivial automorphism of that cycle type.

Solver trust, strengthened in round 6 for the three multiplier classes:
- Encoding independently re-derived (round4/mult_sym_drat.py: different subgroup
  generator selection than round2/mult_sym.py; in-encoder Burnside assert on
  orbit counts). Var/clause counts match round 2 exactly (22/20,878; 43/87,310;
  66/135,072).
- Solved by the CaDiCaL 3.0.1 binary (separate from round 2's pysat Cadical195)
  with DRAT proof logging ON; all three proofs verified end-to-end by drat-trim
  (built from source by the seymour lane): "s VERIFIED", exit 0.
- Pipeline SAT-ability control: the K6-relaxation of the |H|=42 instance
  (112,728 clauses) returned SAT in 0.12 s and the model was checked against
  every clause by an independent script (112,728/112,728 satisfied). The
  pipeline is not vacuously UNSAT.
The (43) row rests on the pure-C circulant exhaust (no SAT solver involved).
Remaining rows/claims still rest on pysat Cadical195 without retained proofs,
as noted per-row. Verifier discipline: any SAT model must pass verify.py
(brute-force all 962,598 5-subsets) + list_k5.py before belief; no SAT model
for the (5,5;43) instances ever appeared, so nothing needed verification.

## Combined theorem (as proven at round-6 close)

No (5,5;43) Ramsey coloring admits a nontrivial automorphism of any of the
following cycle types:

| cycle type | method | result | evidence |
|---|---|---|---|
| (43) | full exhaust of all 2^21 circulant colorings (C, bitmask DFS over difference sets) | 0 valid colorings; min mono-K5 count over all = 43 | circ_out.txt, circ.c |
| (42,1) | multiplier-orbit SAT, |H|=42 (22 orbit vars, 20 878 clauses) | UNSAT, twice: pysat Cadical195 (round 2, exact) + CaDiCaL 3.0.1 with DRAT proof, verified by drat-trim (0.05 s) | round2/multsym.log; round4/multsym_H42.{cnf,drat,res,dratcheck} |
| (21^2,1) | multiplier-orbit SAT, |H|=21 (43 orbit vars, 87 310 clauses) | UNSAT, twice: pysat (round 2) + CaDiCaL 3.0.1 with DRAT proof, verified by drat-trim (1.6 s) | round2/multsym.log; round4/multsym_H21.{cnf,drat,res,dratcheck} |
| (14^3,1) | multiplier-orbit SAT, |H|=14 (66 orbit vars, 135 072 clauses) | UNSAT, twice: pysat (round 2) + CaDiCaL 3.0.1 with DRAT proof, verified by drat-trim (3.8 s) | round2/multsym.log; round4/multsym_H14.{cnf,drat,res,dratcheck} |

Corollary: no vertex-transitive counterexample exists (43 is prime, so a
vertex-transitive coloring is circulant = cycle type (43)).

Conjugacy argument (why one permutation per class suffices): any automorphism
of order d fixing one vertex and acting with orbits of size d on the rest is
conjugate in S_43 to multiplication by an element of order d in Z_43^*
(d | 42), and relabeling vertices preserves the (5,5) property. Orbit counts
22/43/66 match the Burnside counts independently (asserted inside
round4/mult_sym_drat.py at generation time; see also round3/STATE.md).
For involutions, (2^k,1^(43-2k)) is conjugate to (0 1)(2 3)...(2k-2 2k-1).

## Still open at round-7 close (exact statuses, 2026-07-23 07:45 CEST)

| cycle type / claim | method | status |
|---|---|---|
| (7^6,1) | mult_sym |H|=7, 129 orbit vars, 273 696 clauses, exact solve | UNDECIDED. pysat PID 60307 killed at 7h35m with no result; first CaDiCaL+DRAT attempt (07:07) died at ~5 min with no result (session teardown). Fresh CaDiCaL 3.0.1 + DRAT run launched 07:42, detached, 3h wall cap -> harvest round4/multsym_H7.res |
| (6^7,1) | multsym_H6.cnf (154 vars, 319 144 clauses), CaDiCaL 3.0.1 + DRAT | IN FLIGHT since 07:42, detached, 90-min wall cap -> harvest round4/multsym_H6.res |
| (3^14,1), (2^21,1) via mult_sym | DRAT-ready CNF pre-generated for H3 only: round4/multsym_H3.cnf (301 vars, 641 186 clauses); no H2 CNF generated | NOT LAUNCHED (machine load: 5-min load avg ~51 on 10 cores at launch time; budget was one extra solver, spent on H6 + the H7 relaunch) |
| (2^21,1) via inv_sat (independent 2nd code; must agree with mult_sym |H|=2) | 462 orbit vars, 962 808 clauses, exact solve | RUNNING 6h20m (PID 17558), no result -> UNDECIDED at this pass |

## Locality theorems around the best circulant (red diffs {1,4,5,6,7,8,9,12,14,17})

These are not cycle-type exclusions; they bound where a counterexample can live
relative to the incumbent (903-edge Hamming cube). All rest on pysat
Cadical195, no proofs retained (cores/UNSATs reproduced on restart where noted):

- cube_sat levels 1-4 (free = top 20/40/80/160 K5-priority edges): all UNSAT,
  ~6-8 s each. REPRODUCED exactly on restart (round3/cube.log and
  round3/cube_restart.log agree level-by-level, incl. core sizes
  224/255/438/409). Level 5 (free=569): UNDECIDED at conflict budget 3 000 000
  (t=4070 s); process finished, "no solution".
- ball_sat radius r=20 (true Hamming ball, seqcounter cardinality, 36 183 card
  clauses): RUNNING 6h20m (PID 17559), no result -> UNDECIDED at round-7 pass.
- round2 sat_ladder seeds 11/21/22/99 (2-mono-K5 tabu incumbents): level-1
  free=237 all UNSAT (t=36-74 s, cores 397-414 edges); level-2 (free=634-651)
  all UNDECIDED at conflict budget 3 000 000 (t=6706-7666 s); processes
  finished, "no solution" (round2/ladder_*.log).

## Heuristic non-evidence (for completeness)

- tabu C hunters (5400 s, seeds 32/41/42): best 118-123 mono K5s from
  circulant-adjacent starts; the original round-1 tabu holds the global best of
  exactly 2 mono K5s (best_tabu_99.txt, verified by verify.py). No SAT hit,
  no counterexample. Round-2 restarts (seeds 41/42, logs tabu_41/42.log)
  likewise never reached 0.

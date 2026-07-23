# round 3 state (written 2026-07-23 00:42 CEST)

## proven so far (all UNSAT = definitive exclusions, modulo solver trust)
- All 2^21 circulant colorings of K_43: min mono-K5 = 43 (circ_out.txt).
  Excludes any counterexample with an automorphism of order 43 (cycle type (43)).
- mult_sym (round2/multsym.log): |H|=42, 21, 14 all UNSAT.
  By conjugacy this excludes automorphism cycle types (42,1), (21^2,1), (14^3,1).
  Orbit counts 22/43/66/129 independently verified by Burnside count.
- cube_sat (round3/cube.log): no (5,5;43) coloring agrees with best_circulant
  (red diffs {1,4,5,6,7,8,9,12,14,17}) outside the top-20/40/80/160
  K5-priority edges (levels 1-4 all UNSAT, 8s each). Core-guided growth
  continuing past 160.
- round2 sat_ladders (seeds 11/21/22/99): level-1 free=237 UNSAT,
  cores ~400 edges; still climbing.

## running (check ps aux | grep -E "mult_sym|sat_ladder|ball_sat|cube_sat|inv_sat")
- mult_sym.py PID 60307: mid |H|=7 (129 vars); then 6, 3, 2 (budget 1e8 for m<=3).
  Predicted orbit vars: |H|=6 -> 154, |H|=3 -> 301, |H|=2 -> 462.
- inv_sat.py 21 (round3): involution class (2^21,1^1), 462 orbit vars,
  962808 clauses. Same conjugacy class as mult_sym |H|=2 -> results MUST agree
  (two-code cross-check). If UNSAT, also run k=20, 19: inv_sat.py 20 etc.
  (k<19 approaches the full problem, likely intractable).
- ball_sat.py 20 (round3): true Hamming-ball radius 20 around best_circulant
  (seqcounter card encoding). If UNSAT, escalate r=40, 80.
- cube_sat.py (round3, prefix circball): core-guided after schedule.
- tabu C hunters (5400s, end ~01:35): best 123 mono K5s, nowhere near 0.

## deliverable shape if all pending come back UNSAT
Theorem (computational): no (5,5)-Ramsey coloring of K_43 admits a nontrivial
automorphism of any of these cycle types: (43), (42,1), (21^2,1), (14^3,1),
(7^6,1), (6^7,1), (3^14,1), (2^21,1) [+ (2^20,1^3), (2^19,1^5) if inv k=20/19
finish]. Corollary: no vertex-transitive counterexample (43 prime => 43-cycle).
Plus locality: no counterexample within the proven subcubes/ball of the best
circulant.

## verification discipline
- verify.py (parent dir) is the trusted verifier; list_k5.py is an independent
  second implementation. Any SAT model MUST pass both before claiming.
- counterexample_found=true only after verify.py PASS and a second independent
  derivation agrees.

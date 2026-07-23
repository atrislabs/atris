# Erdos-Gyarfas n=36 girth>=7 exhaustion — final results (2026-07-23)

Conjecture tested (Erdos-Gyarfas): every graph with minimum degree >= 3
contains a cycle whose length is a power of 2. A cubic counterexample of
girth >= 7 on 36 vertices would need to avoid C4, C8, C16, C32.

Pipeline: snarkhunter-64 `36 7 s o g m <res> 8` (8 shards, res 0..7) piped
into filter.c (exact DFS cycle-length decision with BFS-distance pruning,
checks C4/C8/C16/C32). Survivors to surv36g7_<res>.g6, stats to
stats36g7_<res>.log.

## Coverage
- total generated across shards: 11,057,343 + 11,518,401 + 10,931,495 +
  10,884,399 + 10,945,277 + 13,092,438 + 12,711,999 + 13,937,731
  = 95,079,083 — matches OEIS A014375(18) = 95079083 (connected cubic
  graphs on 36 vertices with girth >= 7) exactly.
- all 8 shards completed ("All done" + CPU time in gen36g7_<res>.log).

## Result
- survivors (no C4/C8/C16/C32): 0. All surv36g7_*.g6 empty. No counterexample.
- near miss: exactly 1 graph (shard 5) has no C8 but contains a C16
  (noC4C8=1, noC4C8C16=0). Recovered by re-running shard 5 through
  filter_c8dump (see c8free36_s5.g6) and independently re-verified with
  verify.py's exact detector.

## Filter validation
- cls_c.txt vs cls_py.txt: 6,168 graphs, filter.c classifications byte-identical
  to verify.py (pure-python exact detector).
- fresh n=36 spot check: 120 graphs from shard 3 (sample36.g6), filter -v vs
  crosscheck.py byte-identical (sample36_c.txt == sample36_py.txt); all 120
  contain both a C8 and a C16.

Together with earlier rounds: n=30 girth>=6 (122,090,544 = A014374(15), zero
C8-free survivors beyond the 3 verified C16-containing near misses) and
n=34 girth>=7 (1,782,840 = A014375(17), zero C8-free graphs) are also
exhausted with no counterexample.

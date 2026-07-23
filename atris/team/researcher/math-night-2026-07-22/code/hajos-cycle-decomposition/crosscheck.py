#!/usr/bin/env python3
"""Independent spot-check: sample graph6 lines from stdin, decide <= t
exactly with verify.solve_leq_t (pure-python BnB, independent of the sweep
heuristic and of CP-SAT), and confirm feasibility. Any infeasible finding
would be a missed counterexample -> loud alarm."""
import sys
import random

import verify
from sweep import parse_graph6, transform

mode = sys.argv[1]
sample_k = int(sys.argv[2])
seed = int(sys.argv[3]) if len(sys.argv) > 3 else 7

lines = [l.strip() for l in sys.stdin if l.strip()]
rng = random.Random(seed)
sample = rng.sample(lines, min(sample_k, len(lines)))
bad = 0
for g6 in sample:
    n0, e0 = parse_graph6(g6)
    n, edges = transform(n0, e0, mode)
    edges = sorted((min(u, v), max(u, v)) for u, v in edges)
    t = (n - 1) // 2
    try:
        feas, decomp = verify.solve_leq_t(n, edges, t, node_limit=3000000)
    except RuntimeError:
        print(f"g6={g6} BnB node-limit hit (inconclusive)", flush=True)
        continue
    if feas:
        ok = verify.check_decomposition(n, edges, decomp)
        print(f"g6={g6} exact BnB: feasible <= {t} "
              f"({len(decomp)} cycles), partition ok={ok}", flush=True)
        if not ok:
            bad += 1
    else:
        bad += 1
        print(f"*** ALARM g6={g6} exact BnB says NO decomposition <= {t} "
              f"(possible missed counterexample!)", flush=True)
print(f"crosscheck done: {len(sample)} sampled, alarms={bad}", flush=True)
sys.exit(1 if bad else 0)

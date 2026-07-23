#!/usr/bin/env python3
"""Core-guided SAT repair ladder for a near-miss (5,5;43) coloring.

Full instance: one var per edge (903), two 10-literal clauses per 5-subset
(1,925,196 clauses). The incumbent coloring is imposed via ASSUMPTIONS on a
"frozen" edge set (everything except an initial free set). On UNSAT, the
solver's final conflict core (over assumptions) tells us which frozen edges
block the repair; we unfreeze those and retry. Free set grows until SAT,
time limit, or free-set cap.

usage: python3 sat_ladder.py cert.txt out_prefix [max_seconds] [cap] [budget]
On SAT: writes <out_prefix>_solution.txt, prints SOLVED.
Every UNSAT level is a definitive proof for that frozen set.
"""
import sys, time
from itertools import combinations
from pysat.solvers import Cadical195

n = 43
cert = sys.argv[1]
prefix = sys.argv[2]
max_seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 3600
cap = int(sys.argv[4]) if len(sys.argv) > 4 else 903
budget = int(sys.argv[5]) if len(sys.argv) > 5 else 3 * 10**6

bits = [c for c in open(cert).read() if c in "01"]
assert len(bits) == n * (n - 1) // 2

var = {}
val = {}
k = 0
for i in range(n):
    for j in range(i + 1, n):
        var[(i, j)] = len(var) + 1
        val[(i, j)] = bits[k] == "1"
        k += 1
edge_of_var = {v: e for e, v in var.items()}

# violating K5s -> initial free set = all edges touching their vertices
viol = []
for S in combinations(range(n), 5):
    pairs = [val[e] for e in combinations(S, 2)]
    if all(pairs) or not any(pairs):
        viol.append(S)
print(f"[{prefix}] {len(viol)} mono K5s in seed: {viol}", flush=True)
core_verts = sorted({v for S in viol for v in S})
free = {e for e in var if e[0] in core_verts or e[1] in core_verts}

print(f"[{prefix}] building {2 * 962598} clauses...", flush=True)
cls = []
for S in combinations(range(n), 5):
    pv = [var[e] for e in combinations(S, 2)]
    cls.append([-v for v in pv])
    cls.append(pv)

t0 = time.time()
with Cadical195(bootstrap_with=cls) as s:
    del cls
    # phase-seed toward the incumbent
    s.set_phases([var[e] if val[e] else -var[e] for e in var])
    level = 0
    while True:
        level += 1
        elapsed = time.time() - t0
        if elapsed > max_seconds:
            print(f"[{prefix}] TIME LIMIT at level {level}, "
                  f"free={len(free)}", flush=True)
            break
        assumps = [var[e] if val[e] else -var[e]
                   for e in var if e not in free]
        s.conf_budget(budget)
        res = s.solve_limited(assumptions=assumps)
        print(f"[{prefix}] level {level}: free={len(free)} "
              f"result={res} t={time.time()-t0:.0f}s", flush=True)
        if res is True:
            model = set(l for l in s.get_model() if l > 0)
            out = "".join("1" if var[(i, j)] in model else "0"
                          for i in range(n) for j in range(i + 1, n))
            open(f"{prefix}_solution.txt", "w").write(out + "\n")
            print(f"[{prefix}] SOLVED -- wrote {prefix}_solution.txt",
                  flush=True)
            sys.exit(0)
        elif res is False:
            core = s.get_core() or []
            core_edges = {edge_of_var[abs(l)] for l in core}
            print(f"[{prefix}]   UNSAT, core has {len(core_edges)} frozen "
                  f"edges", flush=True)
            if not core_edges:
                print(f"[{prefix}] empty core: UNSAT independent of frozen "
                      f"edges?! (should be impossible)", flush=True)
                break
            free |= core_edges
            if len(free) > cap:
                print(f"[{prefix}] free-set cap {cap} exceeded, stop",
                      flush=True)
                break
        else:
            print(f"[{prefix}] UNDECIDED at free={len(free)} within "
                  f"budget {budget}", flush=True)
            break
print(f"[{prefix}] done, no solution", flush=True)
sys.exit(1)

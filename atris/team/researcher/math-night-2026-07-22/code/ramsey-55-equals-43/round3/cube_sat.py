#!/usr/bin/env python3
"""Prioritized-subcube core-guided ladder around the best circulant.

Like round2/sat_ladder.py but the initial free set is chosen by K5-orbit
priority (edges in the most violating K5s first), growing through explicit
levels 20/40/80/160 before switching to core-guided growth. Each UNSAT level
is a definitive proof: no (5,5;43) coloring agrees with the incumbent
outside the free set.

usage: python3 cube_sat.py cert.txt prefix [max_seconds] [cap] [budget]
"""
import sys, time
from itertools import combinations
from pysat.solvers import Cadical195

n = 43
cert = sys.argv[1]
prefix = sys.argv[2]
max_seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 14400
cap = int(sys.argv[4]) if len(sys.argv) > 4 else 903
budget = int(sys.argv[5]) if len(sys.argv) > 5 else 5 * 10**6

bits = [c for c in open(cert).read() if c in "01"]
assert len(bits) == n * (n - 1) // 2

var, val = {}, {}
k = 0
for i in range(n):
    for j in range(i + 1, n):
        var[(i, j)] = len(var) + 1
        val[(i, j)] = bits[k] == "1"
        k += 1
edge_of_var = {v: e for e, v in var.items()}

# score edges by how many violating (mono) K5s they lie in
score = {e: 0 for e in var}
viol = 0
for S in combinations(range(n), 5):
    pairs = list(combinations(S, 2))
    vv = [val[e] for e in pairs]
    if all(vv) or not any(vv):
        viol += 1
        for e in pairs:
            score[e] += 1
print(f"[{prefix}] {viol} mono K5s in incumbent", flush=True)
ranked = sorted(var, key=lambda e: (-score[e], e))
print(f"[{prefix}] top scores: {[score[e] for e in ranked[:5]]} ... "
      f"nonzero={sum(1 for e in ranked if score[e] > 0)}", flush=True)

print(f"[{prefix}] building {2 * 962598} clauses...", flush=True)
cls = []
for S in combinations(range(n), 5):
    pv = [var[e] for e in combinations(S, 2)]
    cls.append([-v for v in pv])
    cls.append(pv)

schedule = [20, 40, 80, 160]
t0 = time.time()
with Cadical195(bootstrap_with=cls) as s:
    del cls
    s.set_phases([var[e] if val[e] else -var[e] for e in var])
    free = set()
    level = 0
    while True:
        level += 1
        if schedule:
            free |= set(ranked[:schedule.pop(0)])
        elapsed = time.time() - t0
        if elapsed > max_seconds:
            print(f"[{prefix}] TIME LIMIT at level {level}, free={len(free)}",
                  flush=True)
            break
        assumps = [var[e] if val[e] else -var[e]
                   for e in var if e not in free]
        s.conf_budget(budget)
        res = s.solve_limited(assumptions=assumps)
        print(f"[{prefix}] level {level}: free={len(free)} result={res} "
              f"t={time.time()-t0:.0f}s", flush=True)
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
            if not schedule:
                if not core_edges:
                    print(f"[{prefix}] empty core -- stop", flush=True)
                    break
                free |= core_edges
            if len(free) > cap:
                print(f"[{prefix}] free-set cap {cap} exceeded, stop",
                      flush=True)
                break
        else:
            print(f"[{prefix}] UNDECIDED at free={len(free)} within budget "
                  f"{budget}", flush=True)
            if not schedule:
                break
print(f"[{prefix}] done, no solution", flush=True)
sys.exit(1)

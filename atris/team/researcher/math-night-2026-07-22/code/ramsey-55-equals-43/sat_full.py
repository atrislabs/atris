#!/usr/bin/env python3
"""Full SAT instance for a (5,5;43) coloring, phases seeded from a near-miss.

903 vars, 2 * C(43,5) = 1,925,196 ten-literal clauses. Phase-seeds the solver
with the given certificate so CDCL searches near the incumbent first.

usage: python3 sat_full.py seed_cert.txt [conflict_budget]
"""
import sys
from itertools import combinations
from pysat.solvers import Cadical195

n = 43
bits = [c for c in open(sys.argv[1]).read() if c in "01"]
budget = int(sys.argv[2]) if len(sys.argv) > 2 else 5 * 10**6
var = {}
k = 0
phase = []
for i in range(n):
    for j in range(i + 1, n):
        var[(i, j)] = len(var) + 1
        phase.append(var[(i, j)] if bits[k] == "1" else -var[(i, j)])
        k += 1
cls = []
for S in combinations(range(n), 5):
    pv = [var[e] for e in combinations(S, 2)]
    cls.append([-v for v in pv])
    cls.append(pv)
print(f"vars={len(var)} clauses={len(cls)}")
with Cadical195(bootstrap_with=cls) as s:
    s.set_phases(phase)
    s.conf_budget(budget)
    res = s.solve_limited()
    print(f"solver result: {res}")
    if res is True:
        model = set(l for l in s.get_model() if l > 0)
        out = "".join("1" if var[(i, j)] in model else "0"
                      for i in range(n) for j in range(i + 1, n))
        open("certificate.txt", "w").write(out + "\n")
        print("SOLVED -- wrote certificate.txt")

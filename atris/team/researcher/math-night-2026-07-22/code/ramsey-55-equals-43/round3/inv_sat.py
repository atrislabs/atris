#!/usr/bin/env python3
"""Exhaust involution-symmetric 2-colorings of K_43 for a (5,5;43) witness.

Any involution in S_43 with k transpositions is conjugate to
sigma_k = (0 1)(2 3)...(2k-2 2k-1), fixing vertices 2k..42. Since relabeling
vertices preserves the (5,5) property, UNSAT for sigma_k excludes ALL
counterexamples admitting an automorphism of cycle type (2^k, 1^(43-2k)).

Edge orbits under sigma_k become SAT vars; clauses forbid mono K5s in both
colors. Exact solve unless a conflict budget is given.

usage: python3 inv_sat.py k [budget_conflicts]
"""
import sys, time
from itertools import combinations
from pysat.solvers import Cadical195

n = 43
k = int(sys.argv[1])
budget = int(sys.argv[2]) if len(sys.argv) > 2 else 0
assert 1 <= k <= 21

perm = list(range(n))
for i in range(k):
    perm[2 * i], perm[2 * i + 1] = 2 * i + 1, 2 * i

orbit_id = {}
norb = 0
for i in range(n):
    for j in range(i + 1, n):
        if (i, j) in orbit_id:
            continue
        norb += 1
        orbit_id[(i, j)] = norb
        a, b = perm[i], perm[j]
        orbit_id[(min(a, b), max(a, b))] = norb

cls = set()
for S in combinations(range(n), 5):
    ov = sorted({orbit_id[e] for e in combinations(S, 2)})
    cls.add(tuple(-v for v in ov))
    cls.add(tuple(ov))
print(f"[inv k={k}] cycle type (2^{k},1^{n-2*k}): {norb} orbit vars, "
      f"{len(cls)} distinct clauses", flush=True)

t0 = time.time()
with Cadical195(bootstrap_with=[list(c) for c in cls]) as s:
    if budget > 0:
        s.conf_budget(budget)
        res = s.solve_limited()
    else:
        res = s.solve()
    dt = time.time() - t0
    print(f"[inv k={k}] result={res} t={dt:.0f}s", flush=True)
    if res is True:
        model = set(l for l in s.get_model() if l > 0)
        out = "".join("1" if orbit_id[(i, j)] in model else "0"
                      for i in range(n) for j in range(i + 1, n))
        fn = f"inv_k{k}_solution.txt"
        open(fn, "w").write(out + "\n")
        print(f"[inv k={k}] SOLVED -- wrote {fn}", flush=True)
        sys.exit(0)
    elif res is False:
        print(f"[inv k={k}] UNSAT: no (5,5;43) coloring admits an "
              f"automorphism of cycle type (2^{k},1^{n-2*k})", flush=True)
        sys.exit(1)
    print(f"[inv k={k}] UNDECIDED within budget {budget}", flush=True)
    sys.exit(2)

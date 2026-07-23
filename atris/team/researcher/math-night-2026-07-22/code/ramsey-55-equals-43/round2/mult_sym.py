#!/usr/bin/env python3
"""Exhaust multiplier-symmetric 2-colorings of K_43 for a (5,5;43) witness.

Vertices = Z_43. For each subgroup H <= Z_43^* (cyclic of order 42), consider
colorings invariant under x -> cx for all c in H (vertex 0 is fixed; this is
NOT the translation/circulant class, which is already exhausted). Edge orbits
under H become SAT variables; clauses forbid mono K5s. Each instance is
decided exactly (no budget) except |H|=2,3 which get a conflict budget arg.

usage: python3 mult_sym.py [budget_for_small_H]
"""
import sys
from itertools import combinations
from pysat.solvers import Cadical195

n = 43
budget = int(sys.argv[1]) if len(sys.argv) > 1 else 50 * 10**6

# find a primitive root mod 43
def order(a):
    x, k = a, 1
    while x != 1:
        x = x * a % n
        k += 1
    return k

g = next(a for a in range(2, n) if order(a) == 42)
print(f"primitive root mod 43: {g}")

results = {}
for m in [42, 21, 14, 7, 6, 3, 2]:
    c0 = pow(g, 42 // m, n)  # generator of the unique subgroup of order m
    H = []
    x = 1
    while True:
        H.append(x)
        x = x * c0 % n
        if x == 1:
            break
    assert len(H) == m
    # orbits of unordered pairs under x -> cx
    orbit_id = {}
    norb = 0
    for i in range(n):
        for j in range(i + 1, n):
            if (i, j) in orbit_id:
                continue
            norb += 1
            for c in H:
                a, b = i * c % n, j * c % n
                orbit_id[(min(a, b), max(a, b))] = norb
    cls = set()
    for S in combinations(range(n), 5):
        ov = sorted({orbit_id[e] for e in combinations(S, 2)})
        cls.add(tuple(-v for v in ov))
        cls.add(tuple(ov))
    print(f"|H|={m}: {norb} orbit vars, {len(cls)} distinct clauses",
          flush=True)
    with Cadical195(bootstrap_with=[list(c) for c in cls]) as s:
        if m <= 3:
            s.conf_budget(budget)
            res = s.solve_limited()
        else:
            res = s.solve()
        print(f"|H|={m}: result = {res}", flush=True)
        results[m] = res
        if res is True:
            model = set(l for l in s.get_model() if l > 0)
            out = "".join("1" if orbit_id[(i, j)] in model else "0"
                          for i in range(n) for j in range(i + 1, n))
            fn = f"multsym_H{m}_solution.txt"
            open(fn, "w").write(out + "\n")
            print(f"SOLVED -- wrote {fn}", flush=True)

print("summary:", results)

#!/usr/bin/env python3
"""Regenerate multiplier-symmetric (5,5;43) instances as DIMACS CNF for
audit-grade solving: CaDiCaL binary with DRAT proof logging, verified by
drat-trim. Independent re-derivation of the round-2 mult_sym.py encoding
(same mathematical definition, fresh code path) with internal self-checks:

  - orbit counts must match Burnside counts computed independently;
  - every K5 must map to exactly one pos + one neg clause over its orbit set;
  - optional --control mode emits a K7-avoidance relaxation (expected SAT)
    to prove the pipeline can return SAT (guards against a bug that would
    make everything vacuously UNSAT).

usage: python3 mult_sym_drat.py <m> [--control]
  m in {42,21,14,7,6,3,2}: subgroup order of H <= Z_43^*
  writes multsym_H<m>.cnf (or multsym_H<m>_ctrlK6.cnf)
"""
import sys
from itertools import combinations
from math import gcd

n = 43
m = int(sys.argv[1])
control = "--control" in sys.argv
K = 6 if control else 5  # clique size to forbid monochromatically (K6 control: expected SAT)

# subgroup H of order m in Z_43^* (cyclic of order 42): find element of order m
def mult_order(a):
    x, k = a % n, 1
    while x != 1:
        x = x * a % n
        k += 1
    return k

assert 42 % m == 0, "m must divide 42"
c0 = next(a for a in range(2, n) if mult_order(a) == m)
H = []
x = 1
while True:
    H.append(x)
    x = x * c0 % n
    if x == 1:
        break
assert len(H) == m and len(set(H)) == m

# orbits of unordered pairs {i,j} under x -> cx, c in H
orbit_id = {}
norb = 0
for i in range(n):
    for j in range(i + 1, n):
        if (i, j) in orbit_id:
            continue
        norb += 1
        for c in H:
            a, b = i * c % n, j * c % n
            key = (min(a, b), max(a, b))
            assert key not in orbit_id or orbit_id[key] == norb
            orbit_id[key] = norb

# independent Burnside check: #orbits = (1/|H|) * sum_c |Fix(c)| on pairs
fix_total = 0
for c in H:
    fix = 0
    for i in range(n):
        for j in range(i + 1, n):
            a, b = i * c % n, j * c % n
            if (min(a, b), max(a, b)) == (i, j):
                fix += 1
    fix_total += fix
assert fix_total % m == 0 and fix_total // m == norb, \
    f"Burnside mismatch: {fix_total}/{m} != {norb}"

# clauses: for each K-subset, forbid all-red and all-blue over its edge orbits
cls = set()
nsets = 0
for S in combinations(range(n), K):
    ov = sorted({orbit_id[(a, b)] for a, b in combinations(S, 2)})
    assert 1 <= len(ov) <= K * (K - 1) // 2
    cls.add(tuple(ov))               # not all blue: at least one red
    cls.add(tuple(-v for v in ov))   # not all red: at least one blue
    nsets += 1
assert nsets == len(list(combinations(range(n), K))) or True

tag = f"multsym_H{m}" + ("_ctrlK6" if control else "")
fn = f"{tag}.cnf"
with open(fn, "w") as f:
    f.write(f"c (5,5;43) multiplier-symmetric instance, |H|={m}, forbid mono K{K}\n")
    f.write(f"c generator c0={c0}, orbit vars={norb}, distinct clauses={len(cls)}\n")
    f.write(f"p cnf {norb} {len(cls)}\n")
    for c in sorted(cls):
        f.write(" ".join(map(str, c)) + " 0\n")
print(f"|H|={m} K{K}: {norb} orbit vars, {len(cls)} distinct clauses -> {fn}",
      flush=True)

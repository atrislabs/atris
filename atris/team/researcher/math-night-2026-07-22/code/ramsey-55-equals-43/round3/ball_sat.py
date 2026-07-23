#!/usr/bin/env python3
"""Hamming-ball SAT around an incumbent 43-vertex coloring.

Full instance: 903 edge vars, 2 clauses per 5-subset (1,925,196 clauses),
PLUS a cardinality constraint: at most r edges may differ from the incumbent.
UNSAT at radius r is a definitive theorem: no (5,5;43) coloring exists within
Hamming distance r of the incumbent (over the 903-edge hypercube).

usage: python3 ball_sat.py cert.txt r [budget_conflicts]
Exit: writes ball_r<r>_solution.txt and prints SOLVED on SAT.
"""
import sys, time
from itertools import combinations
from pysat.card import CardEnc, EncType
from pysat.solvers import Cadical195

n = 43
cert = sys.argv[1]
r = int(sys.argv[2])
budget = int(sys.argv[3]) if len(sys.argv) > 3 else 0  # 0 = no budget

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

print(f"[ball r={r}] building K5 clauses...", flush=True)
cls = []
for S in combinations(range(n), 5):
    pv = [var[e] for e in combinations(S, 2)]
    cls.append([-v for v in pv])
    cls.append(pv)

# differs-literal for each edge: true iff assignment != incumbent
diff_lits = [-var[e] if val[e] else var[e] for e in var]
card = CardEnc.atmost(lits=diff_lits, bound=r, top_id=len(var),
                      encoding=EncType.seqcounter)
print(f"[ball r={r}] card encoding: {len(card.clauses)} clauses, "
      f"top var {card.nv}", flush=True)

t0 = time.time()
with Cadical195(bootstrap_with=cls) as s:
    del cls
    for c in card.clauses:
        s.add_clause(c)
    s.set_phases([var[e] if val[e] else -var[e] for e in var])
    if budget > 0:
        s.conf_budget(budget)
        res = s.solve_limited()
    else:
        res = s.solve()
    dt = time.time() - t0
    print(f"[ball r={r}] result={res} t={dt:.0f}s", flush=True)
    if res is True:
        model = set(l for l in s.get_model() if l > 0)
        out = "".join("1" if var[(i, j)] in model else "0"
                      for i in range(n) for j in range(i + 1, n))
        fn = f"ball_r{r}_solution.txt"
        open(fn, "w").write(out + "\n")
        ndiff = sum(1 for e in var
                    if (var[e] in model) != val[e])
        print(f"[ball r={r}] SOLVED -- wrote {fn} (hamming dist {ndiff})",
              flush=True)
        sys.exit(0)
    elif res is False:
        print(f"[ball r={r}] UNSAT: no (5,5;43) coloring within hamming "
              f"distance {r} of {cert}", flush=True)
        sys.exit(1)
    else:
        print(f"[ball r={r}] UNDECIDED within budget {budget}", flush=True)
        sys.exit(2)

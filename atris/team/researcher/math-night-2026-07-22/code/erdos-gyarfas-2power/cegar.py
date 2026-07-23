#!/usr/bin/env python3
"""CEGAR / lazy-constraint SAT lane for Erdos-Gyarfas at fixed n (cubic).

Search: does there exist a cubic graph on n vertices with NO cycle of
length 4, 8, or 16 (all powers of 2 that are <= n for n < 32)?

Encoding: e[i][j] booleans, i<j.
  - every vertex has degree exactly 3 (cardinality, seqcounter)
  - every 4-cycle of K_n excluded upfront (C(n,4)*3 clauses)
  - light symmetry breaking: vertex 0 adjacent to 1,2,3
  - lazily: solve -> decode graph -> enumerate ALL 8-cycles and 16-cycles
    -> add one blocking clause per cycle -> repeat.
Complete: if UNSAT, no such cubic graph on n vertices exists (a proof);
if SAT with zero offending cycles, counterexample found.
In practice expected not to converge overnight; progress logged per iter.
"""
import sys, time, itertools
from pysat.solvers import Cadical195
from pysat.card import CardEnc, EncType
from pysat.formula import IDPool

n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
max_iters = int(sys.argv[2]) if len(sys.argv) > 2 else 100000
budget_s = float(sys.argv[3]) if len(sys.argv) > 3 else 1500.0

pool = IDPool()
def E(i, j):
    if i > j: i, j = j, i
    return pool.id(('e', i, j))

cnf = []
# degree exactly 3
for v in range(n):
    lits = [E(v, w) for w in range(n) if w != v]
    enc = CardEnc.equals(lits=lits, bound=3, vpool=pool, encoding=EncType.seqcounter)
    cnf.extend(enc.clauses)
# no 4-cycles: for each 4-subset {a<b<c<d} the three cyclic pairings
for a, b, c, d in itertools.combinations(range(n), 4):
    for (p, q, r, s) in ((a, b, c, d), (a, b, d, c), (a, c, b, d)):
        cnf.append([-E(p, q), -E(q, r), -E(r, s), -E(s, p)])
# symmetry breaking: vertex 0 ~ 1,2,3
for w in (1, 2, 3):
    cnf.append([E(0, w)])

# exact enumeration of all simple cycles of length L (from verify.py logic)
def all_cycles(adj, L):
    out = []
    verts = range(n)
    for s0 in verts:
        path = [s0]; onpath = {s0}
        iters = [iter(sorted(adj[s0]))]
        while iters:
            depth = len(path) - 1
            try:
                w = next(iters[-1])
            except StopIteration:
                iters.pop(); onpath.discard(path.pop()); continue
            if w < s0: continue
            rem = L - depth - 1
            if w == s0:
                if rem == 0 and path[1] < path[-1]:  # each cycle once per direction
                    out.append(list(path))
                continue
            if w in onpath or rem == 0: continue
            path.append(w); onpath.add(w)
            iters.append(iter(sorted(adj[w])))
    return out

solver = Cadical195(bootstrap_with=cnf)
t0 = time.time()
it = 0
blocked = 0
while it < max_iters and time.time() - t0 < budget_s:
    it += 1
    if not solver.solve():
        print(f"UNSAT after {it} iterations, {blocked} blocking clauses, "
              f"{time.time()-t0:.1f}s -- PROOF: no cubic graph on {n} vertices "
              f"avoids C4, C8, C16", flush=True)
        sys.exit(10)
    model = set(l for l in solver.get_model() if l > 0)
    adj = {v: set() for v in range(n)}
    for i in range(n):
        for j in range(i + 1, n):
            if E(i, j) in model:
                adj[i].add(j); adj[j].add(i)
    bad = []
    for L in (8, 16):
        bad.extend(all_cycles(adj, L))
    if not bad:
        print(f"SAT-COUNTEREXAMPLE at iter {it}! writing cegar_hit_n{n}.txt", flush=True)
        with open(f"cegar_hit_n{n}.txt", "w") as f:
            for v in range(n):
                f.write(f"{v}: {' '.join(map(str, sorted(adj[v])))}\n")
        sys.exit(20)
    for cyc in bad:
        L = len(cyc)
        clause = [-E(cyc[k], cyc[(k + 1) % L]) for k in range(L)]
        solver.add_clause(clause)
        blocked += 1
    if it % 25 == 0 or it <= 3:
        n8 = sum(1 for c in bad if len(c) == 8)
        n16 = len(bad) - n8
        print(f"iter {it}: model had {n8} C8s + {n16} C16s; total blocked={blocked} "
              f"elapsed={time.time()-t0:.0f}s", flush=True)
print(f"BUDGET-EXHAUSTED after {it} iterations, {blocked} blocking clauses, "
      f"{time.time()-t0:.1f}s (inconclusive)", flush=True)

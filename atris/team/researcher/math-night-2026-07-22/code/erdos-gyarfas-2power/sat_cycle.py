#!/usr/bin/env python3
"""Independent exact check: does graph G contain a simple cycle of length L?

SAT encoding (positional): boolean x[p][v] = "position p of the cycle is
vertex v", p = 0..L-1.
  - exactly one vertex per position
  - at most one position per vertex  (simple cycle)
  - consecutive positions (cyclically) must be adjacent in G
  - symmetry breaking: fix nothing (kept simple, solver handles it)
SAT  => cycle of length exactly L exists (model decoded and re-verified).
UNSAT => no such cycle.

Usage: sat_cycle.py <graphfile> <L>     (prints SAT/UNSAT [+ cycle])
       sat_cycle.py <graphfile> all     (checks all powers of 2 <= n; prints
                                         verdict in verify.py-compatible form)
"""
import sys
from pysat.solvers import Cadical195
from pysat.card import CardEnc, EncType
from pysat.formula import IDPool


def read_graph(path):
    adj = {}
    with open(path) as f:
        for line in f:
            line = line.split('#')[0].strip()
            if not line:
                continue
            head, rest = line.split(':', 1)
            v = int(head)
            adj.setdefault(v, set())
            for tok in rest.split():
                w = int(tok)
                adj[v].add(w)
                adj.setdefault(w, set()).add(v)
    return adj


def has_cycle_sat(adj, L):
    verts = sorted(adj)
    n = len(verts)
    idx = {v: i for i, v in enumerate(verts)}
    pool = IDPool()

    def X(p, i):
        return pool.id(('x', p, i))

    cnf = []
    # exactly one vertex per position
    for p in range(L):
        lits = [X(p, i) for i in range(n)]
        cnf.append(lits)
        enc = CardEnc.atmost(lits=lits, bound=1, vpool=pool,
                             encoding=EncType.pairwise)
        cnf.extend(enc.clauses)
    # at most one position per vertex
    for i in range(n):
        lits = [X(p, i) for p in range(L)]
        enc = CardEnc.atmost(lits=lits, bound=1, vpool=pool,
                             encoding=EncType.pairwise)
        cnf.extend(enc.clauses)
    # adjacency between consecutive positions
    nonadj = [[j for j in range(n)
               if j != i and verts[j] not in adj[verts[i]]]
              for i in range(n)]
    for p in range(L):
        q = (p + 1) % L
        for i in range(n):
            xi = X(p, i)
            cnf.append([-xi, -X(q, i)])  # can't repeat (redundant but helps)
            for j in nonadj[i]:
                cnf.append([-xi, -X(q, j)])
    with Cadical195(bootstrap_with=cnf) as s:
        if not s.solve():
            return False, None
        model = set(l for l in s.get_model() if l > 0)
        cyc = []
        for p in range(L):
            for i in range(n):
                if X(p, i) in model:
                    cyc.append(verts[i])
                    break
        # re-verify the decoded cycle independently
        assert len(cyc) == L and len(set(cyc)) == L, "decode error"
        for p in range(L):
            assert cyc[(p + 1) % L] in adj[cyc[p]], "non-edge in decoded cycle"
        return True, cyc


def main():
    adj = read_graph(sys.argv[1])
    n = len(adj)
    arg = sys.argv[2]
    if arg == 'all':
        mindeg = min(len(adj[v]) for v in adj)
        print(f"n={n} mindeg={mindeg}")
        ok = mindeg >= 3
        L = 4
        while L <= n:
            found, cyc = has_cycle_sat(adj, L)
            print(f"  C{L}: {'FOUND ' + str(cyc) if found else 'UNSAT (none)'}")
            if found:
                ok = False
            L *= 2
        print("PASS: valid counterexample (SAT method)" if ok
              else "FAIL: not a counterexample (SAT method)")
    else:
        L = int(arg)
        found, cyc = has_cycle_sat(adj, L)
        print(f"C{L}:", "FOUND", cyc) if found else print(f"C{L}: UNSAT")


if __name__ == "__main__":
    main()

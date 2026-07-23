#!/usr/bin/env python3
"""SAT search for a counterexample to Seymour's second neighborhood conjecture
on exactly n vertices.

Encoding (sound and complete for "counterexample on n labeled vertices"):
  x_{uv}  : arc u->v.  Orientation: ~x_{uv} | ~x_{vu}.
  y_{vw}  : w is (at least) in N++(v).  Forced up by
            (x_{vu} & x_{uw} & ~x_{vw}) -> y_{vw}   for all u.
            (spurious extra y=1 only makes the instance harder, so SAT
             models are genuine counterexamples and UNSAT is genuine.)
  Per v   : |N++(v)| <= |N+(v)| - 1 encoded as
            sum_w y_{vw} + sum_u (~x_{vu}) <= n-2   (totalizer).
  Optional --mindeg k adds out-degree >= k for every vertex.

SAT -> writes cert_n<k>.txt; UNSAT -> no counterexample on exactly n vertices
(and since any counterexample induces nothing smaller automatically, the sweep
n=8..N rules out all counterexamples up to N vertices).
"""
import sys, time, itertools
from pysat.formula import IDPool, CNF
from pysat.card import CardEnc, EncType
from pysat.solvers import Solver


def build(n, mindeg=1):
    pool = IDPool()
    x = lambda u, v: pool.id(('x', u, v))
    y = lambda v, w: pool.id(('y', v, w))
    cnf = CNF()
    V = range(n)
    # orientation
    for u in V:
        for v in V:
            if u < v:
                cnf.append([-x(u, v), -x(v, u)])
    # y forced up by 2-paths
    for v in V:
        for w in V:
            if w == v:
                continue
            for u in V:
                if u == v or u == w:
                    continue
                cnf.append([-x(v, u), -x(u, w), x(v, w), y(v, w)])
    # cardinality: sum_w y_vw + sum_u ~x_vu <= n-2  (i.e. |N++| <= |N+|-1)
    for v in V:
        lits = [y(v, w) for w in V if w != v] + [-x(v, u) for u in V if u != v]
        enc = CardEnc.atmost(lits=lits, bound=n - 2, vpool=pool, encoding=EncType.totalizer)
        cnf.extend(enc.clauses)
    # min out-degree (>=1 required for any counterexample; higher = conditional prune)
    if mindeg >= 1:
        for v in V:
            negs = [-x(v, u) for u in V if u != v]
            enc = CardEnc.atmost(lits=negs, bound=n - 1 - mindeg, vpool=pool, encoding=EncType.totalizer)
            cnf.extend(enc.clauses)
    return cnf, pool


def add_symbreak(cnf, pool, n):
    """Partial lex-leader: for each adjacent transposition s=(q,q+1), enforce
    A <=lex A o s over row-major cell order. Any lex-leader of an isomorphism
    class satisfies these, so UNSAT remains sound."""
    x = lambda u, v: pool.id(('x', u, v))
    for q in range(n - 1):
        r = q + 1
        sig = lambda v: r if v == q else (q if v == r else v)
        cells = [(i, j) for i in range(n) for j in range(n) if i != j]
        e_prev = None
        for t, (i, j) in enumerate(cells):
            a = x(i, j)
            b = x(sig(i), sig(j))
            if a == b:
                continue
            if e_prev is None:
                cnf.append([-a, b])
            else:
                cnf.append([-e_prev, -a, b])
            e = pool.id(('e', q, t))
            # e <-> e_prev & (a<->b)
            if e_prev is None:
                cnf.append([-e, -a, b]); cnf.append([-e, a, -b])
                cnf.append([e, a, b]); cnf.append([e, -a, -b])
            else:
                cnf.append([-e, e_prev])
                cnf.append([-e, -a, b]); cnf.append([-e, a, -b])
                cnf.append([e, -e_prev, a, b]); cnf.append([e, -e_prev, -a, -b])
            e_prev = e


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    n = int(args[0])
    mindeg = int(args[1]) if len(args) > 1 else 1
    solver_name = args[2] if len(args) > 2 else 'cadical195'
    symbreak = '--symbreak' in sys.argv
    t0 = time.time()
    cnf, pool = build(n, mindeg)
    if symbreak:
        add_symbreak(cnf, pool, n)
    print(f"n={n} mindeg={mindeg}: {cnf.nv} vars, {len(cnf.clauses)} clauses "
          f"(build {time.time()-t0:.1f}s)", flush=True)
    with Solver(name=solver_name, bootstrap_with=cnf.clauses) as s:
        sat = s.solve()
        dt = time.time() - t0
        if not sat:
            print(f"n={n}: UNSAT ({dt:.1f}s) -- no counterexample on {n} vertices "
                  f"with min out-degree >= {mindeg}", flush=True)
            return 20
        model = set(l for l in s.get_model() if l > 0)
        A = [[0] * n for _ in range(n)]
        for u in range(n):
            for v in range(n):
                if u != v and pool.id(('x', u, v)) in model:
                    A[u][v] = 1
        path = f"cert_n{n}.txt"
        with open(path, 'w') as f:
            f.write('\n'.join(''.join(map(str, r)) for r in A) + '\n')
        print(f"n={n}: SAT ({dt:.1f}s) -- candidate written to {path}", flush=True)
        return 10


if __name__ == '__main__':
    sys.exit(main())

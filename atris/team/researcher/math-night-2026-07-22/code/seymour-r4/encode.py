#!/usr/bin/env python3
"""Round-4 audited DIMACS encoder for Seymour second-neighborhood counterexample
on exactly n labeled vertices.

Encoding (re-derived in round-4 audit, 2026-07-23):
  x_{uv}: arc u->v. Orientation clause (~x_uv | ~x_vu) forbids 2-cycles.
  y_{vw}: upper indicator for w in N++(v), forced up by
          (x_vu & x_uw & ~x_vw) -> y_vw  for every intermediate u.
          Spurious y=1 only tightens; so every real counterexample yields a
          model (set y = exact N++ indicator), hence UNSAT => no counterexample.
  Per v:  sum_w y_vw + sum_u ~x_vu <= n-2   <=>  |N++(v)| <= |N+(v)| - 1.
  --mindeg k: out-degree >= k for all v. SOUND for k<=3 by the audited lemma:
          any counterexample has min out-degree >= 3 (sink => good vertex;
          outdeg 1: |N++(v)| = outdeg(head) >= 1; outdeg 2 forces a digon).
  --exactdeg0 d: vertex 0 has out-degree exactly d (shard: v0 = min-outdeg
          vertex, relabeled to 0; combine with --mindeg d).
  --pin-nbhd: N+(0) = {1..d} (unit clauses), requires --exactdeg0.
  --sb-mode full|stab|twoblock|none:
          full     = lex-leader vs all adjacent transpositions (only sound
                     WITHOUT exactdeg0/pin).
          stab     = transpositions among 1..n-1 (sound with exactdeg0).
          twoblock = transpositions within {1..d} and {d+1..n-1} (sound with
                     pin-nbhd).
  --slack: positive control: relax bound to n-1 (<= |N+|), must be SAT (C3).

Output: DIMACS to --out FILE. Solve with:  cadical FILE proof.drat
Check:  drat-trim FILE proof.drat
"""
import sys, argparse
from pysat.formula import IDPool, CNF
from pysat.card import CardEnc, EncType


def build(n, mindeg, exactdeg0, pin_nbhd, sb_mode, slack):
    pool = IDPool()
    x = lambda u, v: pool.id(('x', u, v))
    y = lambda v, w: pool.id(('y', v, w))
    cnf = CNF()
    V = range(n)
    # pre-register x and y vars so numbering is stable
    for u in V:
        for v in V:
            if u != v:
                x(u, v)
    for u in V:
        for v in V:
            if u != v:
                y(u, v)
    # orientation: no 2-cycles
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
    # violation at every vertex: |N++| <= |N+| - 1  (or <= |N+| with --slack)
    bound = n - 1 if slack else n - 2
    for v in V:
        lits = [y(v, w) for w in V if w != v] + [-x(v, u) for u in V if u != v]
        enc = CardEnc.atmost(lits=lits, bound=bound, vpool=pool, encoding=EncType.totalizer)
        cnf.extend(enc.clauses)
    # min out-degree
    if mindeg >= 1:
        for v in V:
            negs = [-x(v, u) for u in V if u != v]
            enc = CardEnc.atmost(lits=negs, bound=n - 1 - mindeg, vpool=pool, encoding=EncType.totalizer)
            cnf.extend(enc.clauses)
    # shard: vertex 0 out-degree exactly exactdeg0 (upper side; lower from mindeg)
    if exactdeg0 is not None:
        lits0 = [x(0, u) for u in V if u != 0]
        enc = CardEnc.atmost(lits=lits0, bound=exactdeg0, vpool=pool, encoding=EncType.totalizer)
        cnf.extend(enc.clauses)
        if mindeg < exactdeg0:
            enc = CardEnc.atleast(lits=lits0, bound=exactdeg0, vpool=pool, encoding=EncType.totalizer)
            cnf.extend(enc.clauses)
    if pin_nbhd:
        assert exactdeg0 is not None
        for j in range(1, n):
            cnf.append([x(0, j)] if j <= exactdeg0 else [-x(0, j)])
    # symmetry breaking: lex-leader A <=lex A o s for adjacent transpositions s
    if sb_mode != 'none':
        if sb_mode == 'full':
            qs = list(range(n - 1))
        elif sb_mode == 'stab':
            qs = list(range(1, n - 1))
        elif sb_mode == 'twoblock':
            d = exactdeg0
            qs = list(range(1, d)) + list(range(d + 1, n - 1))
        else:
            raise ValueError(sb_mode)
        for q in qs:
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
                if e_prev is None:
                    cnf.append([-e, -a, b]); cnf.append([-e, a, -b])
                    cnf.append([e, a, b]); cnf.append([e, -a, -b])
                else:
                    cnf.append([-e, e_prev])
                    cnf.append([-e, -a, b]); cnf.append([-e, a, -b])
                    cnf.append([e, -e_prev, a, b]); cnf.append([e, -e_prev, -a, -b])
                e_prev = e
    return cnf, pool


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('n', type=int)
    ap.add_argument('--mindeg', type=int, default=1)
    ap.add_argument('--exactdeg0', type=int, default=None)
    ap.add_argument('--pin-nbhd', action='store_true')
    ap.add_argument('--sb-mode', default='none', choices=['none', 'full', 'stab', 'twoblock'])
    ap.add_argument('--slack', action='store_true')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    cnf, pool = build(a.n, a.mindeg, a.exactdeg0, a.pin_nbhd, a.sb_mode, a.slack)
    cnf.to_file(a.out)
    print(f"n={a.n} mindeg={a.mindeg} exactdeg0={a.exactdeg0} pin={a.pin_nbhd} "
          f"sb={a.sb_mode} slack={a.slack}: {cnf.nv} vars {len(cnf.clauses)} clauses -> {a.out}")


if __name__ == '__main__':
    main()

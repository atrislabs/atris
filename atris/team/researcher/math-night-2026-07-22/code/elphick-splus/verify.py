#!/usr/bin/env python3
"""Standalone verifier for the Elphick-Farber-Goldberg-Wocjan conjecture
s+(G) >= n-1 and s-(G) >= n-1 for connected graphs.

Certificate file format: plain text adjacency matrix, one row per line,
entries 0/1 separated by spaces (or nothing). Lines starting with '#' ignored.

Prints PASS if the certificate is a valid counterexample:
  - graph is simple, symmetric, connected, and
  - s+(G) < n-1 (strictly, certified exactly) OR s-(G) < n-1 (same).
Prints FAIL otherwise, with all computed quantities.

Exact certification: characteristic polynomial over ZZ via sympy,
real roots as CRootOf, each refined to a rational isolating interval of
width < 10^-40; s+ and s- are then bounded above/below with exact
Fraction interval arithmetic. Strict inequality s+ < n-1 is claimed only
when the exact UPPER bound of s+ is < n-1 (a rational comparison).
"""
import sys
from fractions import Fraction

import numpy as np


def read_adj(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            line = line.replace(',', ' ')
            if ' ' in line:
                row = [int(x) for x in line.split()]
            else:
                row = [int(c) for c in line]
            rows.append(row)
    n = len(rows)
    if n == 0 or any(len(r) != n for r in rows):
        raise ValueError('not a square 0/1 matrix')
    A = np.array(rows, dtype=np.int64)
    if not np.array_equal(A, A.T):
        raise ValueError('matrix not symmetric')
    if np.any(np.diag(A) != 0):
        raise ValueError('nonzero diagonal (loops)')
    if not np.all((A == 0) | (A == 1)):
        raise ValueError('entries not 0/1')
    return A


def connected_bfs(A):
    n = A.shape[0]
    seen = [False] * n
    stack = [0]
    seen[0] = True
    cnt = 1
    while stack:
        v = stack.pop()
        for u in np.nonzero(A[v])[0]:
            if not seen[u]:
                seen[u] = True
                cnt += 1
                stack.append(int(u))
    return cnt == n


def numeric_s(A):
    ev = np.linalg.eigvalsh(A.astype(float))
    sp = float(np.sum(ev[ev > 1e-9] ** 2))
    sm = float(np.sum(ev[ev < -1e-9] ** 2))
    return sp, sm, ev


def exact_bounds(A):
    """Return ((sp_lo, sp_hi), (sm_lo, sm_hi)) as exact Fractions."""
    import sympy
    n = A.shape[0]
    M = sympy.Matrix(A.tolist())
    lam = sympy.Symbol('lambda')
    p = sympy.Poly(M.charpoly(lam).as_expr(), lam, domain='ZZ')
    tol = Fraction(1, 10 ** 40)
    # collect (lo, hi, multiplicity) rational intervals, one per eigenvalue
    intervals = []
    _, factors = p.factor_list()
    for f, mult in factors:
        d = f.degree()
        if d == 1:
            a1, a0 = f.all_coeffs()
            r = Fraction(int(-a0), int(a1))
            intervals.append((r, r, mult))
        else:
            # symmetric integer matrix => all roots of every factor are real
            for i in range(d):
                root = sympy.CRootOf(f, i)
                c = Fraction(root.eval_rational(sympy.Rational(1, 10 ** 40)))
                intervals.append((c - tol, c + tol, mult))
    total = sum(m for _, _, m in intervals)
    assert total == n, f'expected {n} real eigenvalues, isolated {total}'
    sp_lo = sp_hi = Fraction(0)
    sm_lo = sm_hi = Fraction(0)
    for lo, hi, mult in intervals:
        lo, hi = lo * 1, hi * 1
        # interval [lo, hi] contains the eigenvalue exactly; weight by mult
        if lo > 0:
            sp_lo += mult * lo * lo
            sp_hi += mult * hi * hi
        elif hi < 0:
            sm_lo += mult * hi * hi
            sm_hi += mult * lo * lo
        else:
            # sign ambiguous within tol: contributes at most max(lo^2, hi^2)
            sp_hi += mult * max(lo * lo, hi * hi)
            sm_hi += mult * max(lo * lo, hi * hi)
    return (sp_lo, sp_hi), (sm_lo, sm_hi)


def main():
    if len(sys.argv) != 2:
        print('usage: verify.py certificate.txt')
        sys.exit(2)
    A = read_adj(sys.argv[1])
    n = A.shape[0]
    m = int(A.sum()) // 2
    print(f'n = {n}, edges = {m}')
    if n < 2:
        print('FAIL: need n >= 2')
        sys.exit(1)
    if not connected_bfs(A):
        print('FAIL: graph is not connected')
        sys.exit(1)
    print('connected: yes (BFS)')
    sp, sm, ev = numeric_s(A)
    print(f'numeric s+ = {sp:.12f}, s- = {sm:.12f}, n-1 = {n-1}')
    print(f'numeric margins: s+-(n-1) = {sp-(n-1):.12f}, s--(n-1) = {sm-(n-1):.12f}')
    if sp >= n - 1 - 1e-7 and sm >= n - 1 - 1e-7:
        print('FAIL: numerically both s+ and s- are >= n-1 (no violation)')
        sys.exit(1)
    (sp_lo, sp_hi), (sm_lo, sm_hi) = exact_bounds(A)
    print(f'exact s+ in [{float(sp_lo):.15f}, {float(sp_hi):.15f}]')
    print(f'exact s- in [{float(sm_lo):.15f}, {float(sm_hi):.15f}]')
    target = Fraction(n - 1)
    if sp_hi < target:
        print(f'PASS: certified s+(G) < n-1 exactly '
              f'(s+ <= {float(sp_hi)} < {n-1})')
        sys.exit(0)
    if sm_hi < target:
        print(f'PASS: certified s-(G) < n-1 exactly '
              f'(s- <= {float(sm_hi)} < {n-1})')
        sys.exit(0)
    print('FAIL: exact certification did not confirm strict violation')
    sys.exit(1)


if __name__ == '__main__':
    main()

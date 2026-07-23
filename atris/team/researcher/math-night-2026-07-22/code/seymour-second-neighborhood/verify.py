#!/usr/bin/env python3
"""Standalone verifier for candidate counterexamples to Seymour's Second
Neighborhood Conjecture.

Certificate format: text file containing an n x n 0/1 adjacency matrix,
one row per line, entries either contiguous digits ("0110") or separated
by spaces/commas. Lines starting with '#' and blank lines are ignored.

A[i][j] = 1 means arc i -> j.

Checks, directly from the conjecture statement (no search code imported):
  1. Matrix is square, 0/1, zero diagonal (no loops).
  2. No 2-cycles: not (A[i][j] and A[j][i]).
  3. For every vertex v:
       N+(v)  = { u : A[v][u] = 1 }
       N++(v) = { w : w != v, w not in N+(v), exists u in N+(v) with A[u][w]=1 }
     i.e. vertices at directed distance exactly 2 from v.
  4. Certificate PASSES iff |N++(v)| < |N+(v)| for ALL v (a counterexample).
     If some vertex has |N++(v)| >= |N+(v)| the conjecture holds there -> FAIL.

Pure Python, no dependencies.
"""
import sys


def load(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            line = line.replace(',', ' ')
            if ' ' in line:
                rows.append([int(t) for t in line.split()])
            else:
                rows.append([int(c) for c in line])
    return rows


def main():
    if len(sys.argv) != 2:
        print("usage: verify.py <certificate-file>")
        sys.exit(2)
    A = load(sys.argv[1])
    n = len(A)
    if n == 0 or any(len(r) != n for r in A):
        print("FAIL: matrix is not square (n=%d, row lengths %s)" % (n, sorted({len(r) for r in A})))
        sys.exit(1)
    for i in range(n):
        for j in range(n):
            if A[i][j] not in (0, 1):
                print("FAIL: non-0/1 entry A[%d][%d]=%r" % (i, j, A[i][j]))
                sys.exit(1)
    for i in range(n):
        if A[i][i] != 0:
            print("FAIL: loop at vertex %d" % i)
            sys.exit(1)
    for i in range(n):
        for j in range(i + 1, n):
            if A[i][j] == 1 and A[j][i] == 1:
                print("FAIL: 2-cycle between %d and %d (not an oriented graph)" % (i, j))
                sys.exit(1)

    all_violate = True
    witness = None
    print("vertex |  |N+|  |N++|  N++<N+ ?")
    for v in range(n):
        Nplus = {u for u in range(n) if A[v][u]}
        Npp = set()
        for u in Nplus:
            for w in range(n):
                if A[u][w] and w != v and w not in Nplus:
                    Npp.add(w)
        ok = len(Npp) < len(Nplus)
        print("%6d | %5d  %5d   %s" % (v, len(Nplus), len(Npp), "yes" if ok else "NO"))
        if not ok:
            all_violate = False
            if witness is None:
                witness = (v, len(Nplus), len(Npp))

    if all_violate:
        print("PASS: valid counterexample on %d vertices -- every vertex has |N++(v)| < |N+(v)|." % n)
        sys.exit(0)
    else:
        v, dp, dpp = witness
        print("FAIL: not a counterexample. Vertex %d has |N+|=%d, |N++|=%d (conjecture holds there)." % (v, dp, dpp))
        sys.exit(1)


if __name__ == "__main__":
    main()

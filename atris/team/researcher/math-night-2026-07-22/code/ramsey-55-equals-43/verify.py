#!/usr/bin/env python3
"""Standalone verifier for a claimed disproof of R(5,5) = 43.

A valid disproof certificate is a 43-vertex graph G (red edges; complement =
blue edges) such that G contains no K_5 and its complement contains no K_5
(i.e. G has no independent set of size 5).

Certificate format: a 903-character 0/1 string (whitespace/newlines ignored),
the upper triangle of the 43x43 adjacency matrix in row-major order:
bit index runs over pairs (i,j) with 0 <= i < j <= 42, i outer, j inner.

Usage:
    python3 verify.py certificate.txt      # verify a candidate
    python3 verify.py --selftest           # sanity checks on known instances

Prints PASS if the certificate disproves R(5,5)=43 (no mono K5 in either
color), FAIL otherwise, with exact counts. Implementation is a direct
brute-force loop over all C(43,5) = 962,598 five-vertex subsets, checking
each of the 10 pairs. Independent of any search code.
"""
import sys
from itertools import combinations


def parse_certificate(text, n=43):
    bits = [c for c in text if c in "01"]
    need = n * (n - 1) // 2
    if len(bits) != need:
        raise ValueError(f"expected {need} bits, got {len(bits)}")
    adj = [[False] * n for _ in range(n)]
    k = 0
    for i in range(n):
        for j in range(i + 1, n):
            adj[i][j] = adj[j][i] = (bits[k] == "1")
            k += 1
    return adj


def count_mono_k(adj, n, k):
    """Return (num_red_Kk, num_blue_Kk) by direct enumeration of all
    k-subsets, checking every pair. Deliberately naive and direct."""
    red = 0
    blue = 0
    verts = range(n)
    for S in combinations(verts, k):
        all_red = True
        all_blue = True
        for a, b in combinations(S, 2):
            if adj[a][b]:
                all_blue = False
            else:
                all_red = False
            if not all_red and not all_blue:
                break
        if all_red:
            red += 1
        elif all_blue:
            blue += 1
    return red, blue


def verify_file(path):
    with open(path) as f:
        adj = parse_certificate(f.read(), 43)
    red, blue = count_mono_k(adj, 43, 5)
    edges = sum(adj[i][j] for i in range(43) for j in range(i + 1, 43))
    print(f"n = 43, edges in red graph = {edges}")
    print(f"red K5 count  (K5 in G)          = {red}")
    print(f"blue K5 count (independent 5-set) = {blue}")
    if red == 0 and blue == 0:
        print("PASS: valid (5,5;43) Ramsey coloring -- R(5,5) >= 44, "
              "conjecture R(5,5)=43 DISPROVED by this certificate")
        return True
    print(f"FAIL: {red + blue} monochromatic K5(s) present -- "
          "certificate does NOT disprove the conjecture")
    return False


def selftest():
    ok = True
    # 1. Paley graph on 17 vertices: known witness for R(4,4) > 17.
    #    Same core routine, k=4: must find zero mono K4.
    n = 17
    qr = {(x * x) % n for x in range(1, n)}
    adj = [[(i - j) % n in qr for j in range(n)] for i in range(n)]
    for i in range(n):
        adj[i][i] = False
    r, b = count_mono_k(adj, n, 4)
    print(f"[selftest] Paley(17), k=4: red K4 = {r}, blue K4 = {b} "
          f"(expected 0, 0) -> {'ok' if (r, b) == (0, 0) else 'BROKEN'}")
    ok &= (r, b) == (0, 0)
    # 1b. Paley(17) with k=3 must FIND mono triangles (R(3,3)=6 <= 17),
    #     proving the counter actually detects cliques.
    r3, b3 = count_mono_k(adj, n, 3)
    print(f"[selftest] Paley(17), k=3: red K3 = {r3}, blue K3 = {b3} "
          f"(expected >0, >0) -> {'ok' if r3 > 0 and b3 > 0 else 'BROKEN'}")
    ok &= r3 > 0 and b3 > 0
    # 2. Deterministic pseudo-random 43-vertex coloring: conjecture-consistent
    #    behavior is that mono K5s exist (they essentially always do).
    import random
    rng = random.Random(12345)
    n = 43
    adj = [[False] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            adj[i][j] = adj[j][i] = rng.random() < 0.5
    r, b = count_mono_k(adj, n, 5)
    print(f"[selftest] random K43 coloring: red K5 = {r}, blue K5 = {b} "
          f"(expected >0) -> {'ok' if r + b > 0 else 'BROKEN'}")
    ok &= r + b > 0
    print("[selftest]", "ALL OK" if ok else "SELFTEST FAILED")
    return ok


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == "--selftest":
        sys.exit(0 if selftest() else 1)
    sys.exit(0 if verify_file(sys.argv[1]) else 1)

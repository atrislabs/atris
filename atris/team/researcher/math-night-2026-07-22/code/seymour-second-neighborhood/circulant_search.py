#!/usr/bin/env python3
"""Exhaustive search over circulant oriented graphs on Z_n.

Vertex-transitive, so a counterexample needs the single condition
  |((S+S) mod n) \ (S u {0})| < |S|
for a connection set S in {1..n-1} with S disjoint from -S (orientation).

Enumerate by choosing, for each pair {d, n-d}, one of: neither, d, n-d.
Bitmask arithmetic; prints best (smallest margin) per n.
"""
import sys

def run(n):
    pairs = []
    for d in range(1, n // 2 + (n % 2)):
        if d != (n - d) % n:
            pairs.append((d, n - d))
    # if n even, d = n/2 satisfies -d = d, excluded by orientation
    k = len(pairs)
    best = None
    full = (1 << n) - 1
    # precompute rotations
    for code in range(3 ** k):
        S = 0
        c = code
        for (a, b) in pairs:
            r = c % 3
            c //= 3
            if r == 1:
                S |= 1 << a
            elif r == 2:
                S |= 1 << b
        if S == 0:
            continue
        # sumset via shifts
        T = 0
        s = S
        while s:
            d = (s & -s).bit_length() - 1
            s &= s - 1
            T |= ((S << d) | (S >> (n - d))) & full
        outside = T & ~(S | 1) & full
        margin = bin(outside).count('1') - bin(S).count('1')  # want < 0
        if best is None or margin < best[0]:
            best = (margin, S)
    m, S = best
    Sset = sorted(d for d in range(n) if S >> d & 1)
    status = "COUNTEREXAMPLE!" if m < 0 else "no"
    print(f"n={n}: best margin |N++|-|N+| = {m:+d} at S={Sset} {status}", flush=True)
    return m, Sset

if __name__ == '__main__':
    lo, hi = int(sys.argv[1]), int(sys.argv[2])
    found = False
    for n in range(lo, hi + 1):
        m, S = run(n)
        if m < 0:
            found = True
            print("FOUND circulant counterexample: n=%d S=%s" % (n, S))
    if not found:
        print("no circulant counterexample in range")

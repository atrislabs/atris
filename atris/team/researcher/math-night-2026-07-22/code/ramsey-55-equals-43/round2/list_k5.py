#!/usr/bin/env python3
"""Fast independent mono-K5 lister for 43-vertex 2-colorings.

Independent implementation from ../verify.py (bitset recursion vs naive
subset loop). Prints every monochromatic K5 in each color plus counts.

usage: python3 list_k5.py cert.txt [cert2.txt ...]
"""
import sys

N = 43


def load(path):
    bits = [c for c in open(path).read() if c in "01"]
    assert len(bits) == N * (N - 1) // 2, f"{path}: {len(bits)} bits"
    red = [0] * N  # adjacency bitmasks, red = '1'
    blue = [0] * N
    k = 0
    for i in range(N):
        for j in range(i + 1, N):
            if bits[k] == "1":
                red[i] |= 1 << j
                red[j] |= 1 << i
            else:
                blue[i] |= 1 << j
                blue[j] |= 1 << i
            k += 1
    return red, blue


def cliques5(adj):
    """All 5-cliques via bitset intersection recursion."""
    out = []

    def rec(chosen, cand):
        if len(chosen) == 4:
            m = cand
            while m:
                v = (m & -m).bit_length() - 1
                out.append(tuple(chosen + [v]))
                m &= m - 1
            return
        m = cand
        while m:
            v = (m & -m).bit_length() - 1
            m &= m - 1
            rec(chosen + [v], m & adj[v])

    full = (1 << N) - 1
    for v in range(N):
        higher = full & ~((1 << (v + 1)) - 1)
        rec([v], higher & adj[v])
    return out


if __name__ == "__main__":
    for path in sys.argv[1:]:
        red, blue = load(path)
        r = cliques5(red)
        b = cliques5(blue)
        print(f"{path}: red K5 = {len(r)}, blue K5 = {len(b)}, "
              f"total = {len(r) + len(b)}")
        for c in r:
            print("  RED ", c)
        for c in b:
            print("  BLUE", c)

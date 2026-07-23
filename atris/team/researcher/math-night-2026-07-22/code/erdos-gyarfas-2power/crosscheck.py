#!/usr/bin/env python3
"""Cross-validate filter.c classification against verify.py's exact detector.

Reads graph6 lines on stdin. For each graph prints "g6 hasC4 hasC8 hasC16"
using verify.py's has_cycle_of_length (the trusted verifier).
"""
import sys
from verify import has_cycle_of_length


def g6_to_adj(line):
    s = line.strip()
    if s.startswith('>>graph6<<'):
        s = s[10:]
    data = [ord(c) - 63 for c in s]
    n = data[0]
    adj = {v: set() for v in range(n)}
    bits = []
    for c in data[1:]:
        for k in range(5, -1, -1):
            bits.append((c >> k) & 1)
    idx = 0
    for j in range(1, n):
        for i in range(j):
            if bits[idx]:
                adj[i].add(j)
                adj[j].add(i)
            idx += 1
    return adj, n


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    adj, n = g6_to_adj(line)
    c4 = has_cycle_of_length(adj, 4)[0]
    c8 = has_cycle_of_length(adj, 8)[0]
    c16 = has_cycle_of_length(adj, 16)[0] if n >= 16 else False
    print(f"{line} {int(c4)} {int(c8)} {int(c16)}")

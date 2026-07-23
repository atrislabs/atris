#!/usr/bin/env python3
"""Standalone verifier for the Erdos-Gyarfas conjecture (power-of-2 cycles).

A valid counterexample certificate is a finite simple graph with
  (a) minimum degree >= 3, and
  (b) NO cycle of length 2^j for any j >= 2 (lengths 4, 8, 16, 32, 64, ...
      up to n, since a simple cycle has length <= n).

Input format (adjacency list), one line per vertex:
    <v>: <u1> <u2> <u3> ...
Vertices are arbitrary integer labels. Lines starting with '#' ignored.
Also accepts a plain edge list ("u v" per line).

Prints PASS if the graph is a valid counterexample, FAIL otherwise,
with all computed quantities. Pure python, no imports beyond stdlib.

Exactness: cycle-of-length-L existence is decided by exhaustive DFS over
simple paths, canonicalized so the start vertex is the minimum vertex of
the cycle, with BFS-distance pruning (prune when the remaining number of
steps is smaller than the distance back to the start). This is an exact
decision procedure: pruning only removes branches that provably cannot
close into a cycle of the required length.
"""
import sys
from collections import deque


def read_graph(path):
    adj = {}
    edges = set()

    def add_edge(a, b):
        if a == b:
            raise ValueError(f"self-loop at {a}")
        e = (min(a, b), max(a, b))
        edges.add(e)
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)

    with open(path) as f:
        for line in f:
            line = line.split('#')[0].strip()
            if not line:
                continue
            if ':' in line:
                head, rest = line.split(':', 1)
                v = int(head.strip())
                adj.setdefault(v, set())
                for tok in rest.split():
                    add_edge(v, int(tok))
            else:
                toks = line.split()
                if len(toks) == 2:
                    add_edge(int(toks[0]), int(toks[1]))
                else:
                    raise ValueError(f"bad line: {line!r}")
    return adj, edges


def bfs_dist(adj, allowed, src):
    dist = {src: 0}
    q = deque([src])
    while q:
        v = q.popleft()
        for w in adj[v]:
            if w in allowed and w not in dist:
                dist[w] = dist[v] + 1
                q.append(w)
    return dist


def has_cycle_of_length(adj, L):
    """Exact: does the graph contain a simple cycle with exactly L edges?"""
    verts = sorted(adj)
    for s in verts:
        # canonical: s is the minimum-labelled vertex of the cycle
        allowed = set(v for v in verts if v >= s)
        if len(allowed) < L:
            break
        dist = bfs_dist(adj, allowed, s)
        # iterative DFS over simple paths from s using only vertices >= s
        # stack entries: (vertex, iterator over neighbors, )
        path = [s]
        onpath = {s}
        iters = [iter(sorted(adj[s]))]
        while iters:
            depth = len(path) - 1  # edges used so far
            try:
                w = next(iters[-1])
            except StopIteration:
                iters.pop()
                onpath.discard(path.pop())
                continue
            if w < s:
                continue
            rem = L - depth - 1  # edges remaining after stepping to w
            if w == s:
                if rem == 0:
                    return True, list(path)
                continue
            if w in onpath:
                continue
            if rem == 0:
                continue
            d = dist.get(w)
            if d is None or d > rem:
                continue
            path.append(w)
            onpath.add(w)
            iters.append(iter(sorted(adj[w])))
    return False, None


def main():
    if len(sys.argv) != 2:
        print("usage: verify.py <certificate-file>")
        sys.exit(2)
    adj, edges = read_graph(sys.argv[1])
    n = len(adj)
    m = len(edges)
    degs = {v: len(adj[v]) for v in adj}
    mindeg = min(degs.values()) if degs else 0
    print(f"vertices: {n}")
    print(f"edges:    {m}")
    print(f"min degree: {mindeg}  (max degree: {max(degs.values()) if degs else 0})")

    ok = True
    if mindeg < 3:
        bad = sorted(v for v in degs if degs[v] < 3)[:10]
        print(f"FAIL-CONDITION: min degree < 3 (e.g. vertices {bad})")
        ok = False

    L = 4
    powers = []
    while L <= n:
        powers.append(L)
        L *= 2
    print(f"powers of 2 to check (<= n): {powers}")
    for L in powers:
        found, cyc = has_cycle_of_length(adj, L)
        if found:
            # sanity-check the returned cycle
            assert len(cyc) == L and len(set(cyc)) == L
            for i in range(L):
                assert cyc[(i + 1) % L] in adj[cyc[i]]
            print(f"  C{L}: FOUND  cycle = {cyc}")
            ok = False
        else:
            print(f"  C{L}: none (exact search)")

    if ok:
        print("PASS: valid counterexample to Erdos-Gyarfas "
              "(min degree >= 3, no cycle of length 2^j, j >= 2)")
    else:
        print("FAIL: not a counterexample (conjecture holds on this graph)")


if __name__ == "__main__":
    main()

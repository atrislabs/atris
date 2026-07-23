#!/usr/bin/env python3
"""Circulant sweep with budgeted DFS + SAT fallback for slow-UNSAT cases.

Checks all connected circulants C_n(a,b) (degree 3-4) for n in [lo, hi]
for power-of-2 cycles. Prints HIT if a graph has none (=counterexample).

Usage: python3 search3.py <lo> <hi>
"""
import sys
from collections import deque
from sat_cycle import has_cycle_sat


def circulant(n, conns):
    adj = [set() for _ in range(n)]
    for i in range(n):
        for s in conns:
            adj[i].add((i + s) % n)
            adj[i].add((i - s) % n)
        adj[i].discard(i)
    return [sorted(x) for x in adj]


def is_connected(adj, n):
    seen = [False] * n
    seen[0] = True
    q = deque([0])
    c = 1
    while q:
        v = q.popleft()
        for w in adj[v]:
            if not seen[w]:
                seen[w] = True
                c += 1
                q.append(w)
    return c == n


def bfs_dist(adj, n, allowed_min, src):
    dist = [-1] * n
    dist[src] = 0
    q = deque([src])
    while q:
        v = q.popleft()
        for w in adj[v]:
            if w >= allowed_min and dist[w] == -1:
                dist[w] = dist[v] + 1
                q.append(w)
    return dist


def has_cycle_budget(adj, n, L, budget):
    """Return True/False/None (None = budget exhausted, inconclusive)."""
    nodes = 0
    onpath = [False] * n
    for s in range(n):
        dist = bfs_dist(adj, n, s, s)
        path = [s]
        onpath[s] = True
        iters = [iter(adj[s])]
        while iters:
            depth = len(path) - 1
            advanced = False
            for w in iters[-1]:
                nodes += 1
                if nodes > budget:
                    for v in path:
                        onpath[v] = False
                    return None
                if w < s:
                    continue
                rem = L - depth - 1
                if w == s:
                    if rem == 0:
                        for v in path:
                            onpath[v] = False
                        return True
                    continue
                if onpath[w]:
                    continue
                if rem == 0:
                    continue
                d = dist[w]
                if d == -1 or d > rem:
                    continue
                path.append(w)
                onpath[w] = True
                iters.append(iter(adj[w]))
                advanced = True
                break
            if not advanced:
                iters.pop()
                onpath[path.pop()] = False
    return False


def check_graph(adj, n, tag):
    """Full power-of-2 check; returns True iff NO power-of-2 cycle."""
    L = 4
    while L <= n:
        r = has_cycle_budget(adj, n, L, 2_000_000)
        if r is None:
            amap = {v: set(adj[v]) for v in range(n)}
            r, _ = has_cycle_sat(amap, L)
            print(f"    [{tag}] C{L} resolved by SAT: {r}", flush=True)
        if r:
            return False
        L *= 2
    return True


def main():
    lo, hi = int(sys.argv[1]), int(sys.argv[2])
    for n in range(lo, hi + 1):
        conn_sets = []
        for a in range(1, n // 2 + 1):
            for b in range(a + 1, n // 2 + 1):
                conn_sets.append((a, b))
        if n % 2 == 0:
            pass  # (a, n//2) pairs already included above when b == n//2
        cnt = 0
        for conns in conn_sets:
            adj = circulant(n, conns)
            if min(len(x) for x in adj) < 3 or not is_connected(adj, n):
                continue
            cnt += 1
            if check_graph(adj, n, f"C_{n}{conns}"):
                print(f"HIT CIRC n={n} conns={conns}", flush=True)
                with open(f"hit_CIRC_{n}_{conns[0]}_{conns[1]}.txt", 'w') as f:
                    for v in range(n):
                        f.write(f"{v}: " + " ".join(map(str, adj[v])) + "\n")
        print(f"n={n} done ({cnt} graphs)", flush=True)


if __name__ == "__main__":
    main()

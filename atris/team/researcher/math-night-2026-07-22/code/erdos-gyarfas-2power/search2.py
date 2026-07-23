#!/usr/bin/env python3
"""Targeted annealer: min-degree-3 graphs with no C4/C8/C16 (and C32 if n>=32).

Moves are 2-opt edge swaps biased toward edges on offending power-of-2 cycles.
Degree sequence fixed: all 3s (+ one 4 if n odd, sum parity).

Usage: python3 search2.py <n> <seconds> <seed>
"""
import random
import sys
import time
from collections import deque


def bfs_dist_arr(adj, n, allowed_min, src):
    dist = [-1] * n
    dist[src] = 0
    q = deque([src])
    while q:
        v = q.popleft()
        dv = dist[v]
        for w in adj[v]:
            if w >= allowed_min and dist[w] == -1:
                dist[w] = dv + 1
                q.append(w)
    return dist


def count_collect(adj, n, L, cap, keep=8):
    """Count simple cycles of length L (each counted twice, once per direction),
    early-exit at cap. Also return up to `keep` sample cycles."""
    total = 0
    samples = []
    onpath = [False] * n
    for s in range(n):
        dist = bfs_dist_arr(adj, n, s, s)
        path = [s]
        onpath[s] = True
        iters = [iter(adj[s])]
        while iters:
            depth = len(path) - 1
            advanced = False
            for w in iters[-1]:
                if w < s:
                    continue
                rem = L - depth - 1
                if w == s:
                    if rem == 0:
                        total += 1
                        if len(samples) < keep:
                            samples.append(list(path))
                        if total >= cap:
                            for v in path:
                                onpath[v] = False
                            return total, samples
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
    return total, samples


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


def random_graph_degseq(degs, rng):
    n = len(degs)
    while True:
        stubs = [v for v in range(n) for _ in range(degs[v])]
        rng.shuffle(stubs)
        edges = set()
        ok = True
        for i in range(0, len(stubs), 2):
            a, b = stubs[i], stubs[i + 1]
            if a == b or (min(a, b), max(a, b)) in edges:
                ok = False
                break
            edges.add((min(a, b), max(a, b)))
        if not ok:
            continue
        adj = [[] for _ in range(n)]
        for a, b in edges:
            adj[a].append(b)
            adj[b].append(a)
        if is_connected(adj, n):
            return [sorted(x) for x in adj]


import os
CAPS = {4: 100, 8: 100, 16: 3000, 32: 3000}
W = {4: int(os.environ.get('W4', 10 ** 8)),
     8: int(os.environ.get('W8', 10 ** 6)),
     16: 1, 32: 1}


def cost_fn(adj, n, deep):
    """deep: include L=32 when n>=32 and earlier levels are zero."""
    cost = 0
    parts = {}
    bad_edges = []
    levels = [4, 8, 16] + ([32] if (deep and n >= 32) else [])
    for L in levels:
        c, samples = count_collect(adj, n, L, CAPS[L])
        parts[L] = c
        cost += W[L] * c
        if c > 0 and not bad_edges:
            for cyc in samples:
                for i in range(len(cyc)):
                    a, b = cyc[i], cyc[(i + 1) % len(cyc)]
                    bad_edges.append((min(a, b), max(a, b)))
        if L == 4 and c > 0:
            break  # C4s present: don't pay for deeper counts
        if L == 8 and c > 6:
            break  # deep in C8 territory: skip deep counts
    return cost, parts, bad_edges


def edge_swap_biased(adj, n, rng, bad_edges):
    edges = [(a, b) for a in range(n) for b in adj[a] if a < b]
    for _ in range(120):
        if bad_edges and rng.random() < 0.85:
            e1 = rng.choice(bad_edges)
        else:
            e1 = rng.choice(edges)
        e2 = rng.choice(edges)
        a, b = e1
        c, d = e2
        if len({a, b, c, d}) < 4:
            continue
        if rng.random() < 0.5:
            a, b = b, a
        if c in adj[a] or d in adj[b]:
            continue
        new = [list(x) for x in adj]
        new[a].remove(b); new[b].remove(a)
        new[c].remove(d); new[d].remove(c)
        new[a].append(c); new[c].append(a)
        new[b].append(d); new[d].append(b)
        new = [sorted(x) for x in new]
        if is_connected(new, n):
            return new
    return None


def save_cert(adj, n, path):
    with open(path, 'w') as f:
        for v in range(n):
            f.write(f"{v}: " + " ".join(map(str, sorted(adj[v]))) + "\n")


def main():
    n = int(sys.argv[1])
    seconds = float(sys.argv[2])
    seed = int(sys.argv[3])
    rng = random.Random(seed)
    degs = [3] * n
    if (3 * n) % 2 == 1:
        degs[0] = 4
    deep = n >= 32
    adj = random_graph_degseq(degs, rng)
    cost, parts, bad = cost_fn(adj, n, deep)
    best = cost
    best_parts = dict(parts)
    best_adj = [list(x) for x in adj]
    t0 = time.time()
    it = 0
    stuck = 0
    while time.time() - t0 < seconds:
        it += 1
        T = max(0.5, 200.0 * (0.9995 ** (it % 20000)))
        cand = edge_swap_biased(adj, n, rng, bad)
        if cand is None:
            continue
        ccost, cparts, cbad = cost_fn(cand, n, deep)
        if ccost <= cost or rng.random() < 2.718 ** (-(ccost - cost) / T):
            adj, cost, parts, bad = cand, ccost, cparts, cbad
            if cost < best:
                best, best_parts = cost, dict(parts)
                best_adj = [list(x) for x in adj]
                print(f"[n={n} s={seed} it={it} t={time.time()-t0:.0f}s] "
                      f"best={best} parts={parts}", flush=True)
                if best == 0:
                    fn = f"COUNTEREXAMPLE_n{n}_seed{seed}.txt"
                    save_cert(adj, n, fn)
                    print("!!! candidate saved:", fn, flush=True)
                    return
                if parts.get(4) == 0 and parts.get(8) == 0 and parts.get(16, 99) <= 6:
                    save_cert(adj, n, f"near_n{n}_s{seed}_c16_{parts[16]}.txt")
        stuck += 1
        if cost < best * 1.001:
            stuck = 0
        if stuck > 30000:
            adj = random_graph_degseq(degs, rng)
            cost, parts, bad = cost_fn(adj, n, deep)
            stuck = 0
    save_cert(best_adj, n, f"best_n{n}_s{seed}.txt")
    print(f"[n={n} s={seed}] done {it} iters, best={best} parts={best_parts} "
          f"(saved best_n{n}_s{seed}.txt)", flush=True)


if __name__ == "__main__":
    main()

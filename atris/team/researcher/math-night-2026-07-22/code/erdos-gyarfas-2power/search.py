#!/usr/bin/env python3
"""Search for a counterexample to the Erdos-Gyarfas power-of-2-cycle conjecture.

Modes:
  sweep    - structured families: generalized Petersen GP(m,k), circulants C_n(S)
  anneal   - simulated annealing over cubic graphs on n vertices:
             stage A: kill all C4 and C8; stage B: minimize #C16 keeping A,
             full power-of-2 check whenever cost hits new lows.
Usage:
  python3 search.py sweep
  python3 search.py anneal <n> <seconds> [seed]
"""
import random
import sys
import time
from collections import deque

POW2 = [4, 8, 16, 32, 64]


# ---------- core cycle machinery (mirrors verify.py logic, tuned for speed) ----

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


def count_cycles_len(adj, n, L, cap):
    """Count simple cycles of length exactly L, stopping early at cap.
    Each cycle counted twice (two directions) unless we hit cap; the value is
    only used as a monotone cost signal. Exact-zero iff no such cycle."""
    total = 0
    onpath = [False] * n
    for s in range(n):
        dist = bfs_dist_arr(adj, n, s, s)
        path = [s]
        onpath[s] = True
        iters = [iter(adj[s])]
        while iters:
            depth = len(path) - 1
            it = iters[-1]
            advanced = False
            for w in it:
                if w < s:
                    continue
                rem = L - depth - 1
                if w == s:
                    if rem == 0:
                        total += 1
                        if total >= cap:
                            # unwind
                            for v in path:
                                onpath[v] = False
                            return total
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
    return total


def has_cycle_len(adj, n, L):
    return count_cycles_len(adj, n, L, 1) > 0


def full_pow2_check(adj, n):
    """Return list of (L, present) for all powers of 2 <= n."""
    out = []
    for L in POW2:
        if L > n:
            break
        out.append((L, has_cycle_len(adj, n, L)))
    return out


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


def save_cert(adj, n, path):
    with open(path, 'w') as f:
        for v in range(n):
            f.write(f"{v}: " + " ".join(map(str, sorted(adj[v]))) + "\n")


# ---------- structured families ------------------------------------------------

def gp_graph(m, k):
    n = 2 * m
    adj = [[] for _ in range(n)]

    def add(a, b):
        adj[a].append(b)
        adj[b].append(a)
    for i in range(m):
        add(i, (i + 1) % m)          # outer cycle
        add(i, m + i)                # spokes
        add(m + i, m + (i + k) % m)  # inner star (dedup below)
    # dedup inner edges (each added twice when 2k ≡ 0 mod m is not an issue;
    # generic add duplicates for inner star)
    adj2 = [sorted(set(x)) for x in adj]
    return adj2, n


def circulant(n, conns):
    adj = [set() for _ in range(n)]
    for i in range(n):
        for s in conns:
            adj[i].add((i + s) % n)
            adj[i].add((i - s) % n)
        adj[i].discard(i)
    return [sorted(x) for x in adj], n


def sweep():
    hits = []
    tested = 0
    # generalized Petersen
    for m in range(3, 31):
        for k in range(1, m // 2 + 1):
            adj, n = gp_graph(m, k)
            if min(len(a) for a in adj) < 3:
                continue
            tested += 1
            res = full_pow2_check(adj, n)
            if all(not p for _, p in res):
                hits.append(("GP", m, k))
                save_cert(adj, n, f"hit_GP_{m}_{k}.txt")
                print("HIT GP", m, k, flush=True)
    print(f"GP sweep done ({tested} graphs)", flush=True)
    # circulants, degree 3 and 4
    tested = 0
    for n in range(17, 61):
        conn_sets = []
        if n % 2 == 0:
            for a in range(1, n // 2):
                conn_sets.append((a, n // 2))  # degree 3
        for a in range(1, n // 2 + 1):
            for b in range(a + 1, n // 2 + 1):
                conn_sets.append((a, b))       # degree 4 (or 3 if b=n/2)
        for conns in conn_sets:
            adj, _ = circulant(n, conns)
            if min(len(a) for a in adj) < 3 or not is_connected(adj, n):
                continue
            tested += 1
            res = full_pow2_check(adj, n)
            if all(not p for _, p in res):
                hits.append(("CIRC", n, conns))
                save_cert(adj, n, f"hit_CIRC_{n}_{'_'.join(map(str, conns))}.txt")
                print("HIT CIRC", n, conns, flush=True)
        print(f"circulants n={n} done", flush=True)
    print("sweep hits:", hits, flush=True)


# ---------- annealing over cubic graphs ---------------------------------------

def random_cubic(n, rng):
    """Random cubic graph via pairing model, retry until simple+connected."""
    while True:
        stubs = [v for v in range(n) for _ in range(3)]
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


def edge_swap(adj, n, rng):
    """2-opt rewiring: pick edges (a,b),(c,d) -> (a,c),(b,d) or (a,d),(b,c)."""
    edges = [(a, b) for a in range(n) for b in adj[a] if a < b]
    for _ in range(100):
        (a, b), (c, d) = rng.sample(edges, 2)
        if len({a, b, c, d}) < 4:
            continue
        if rng.random() < 0.5:
            a, b = b, a
        # new edges (a,c),(b,d)
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


CAP16 = 60


def cost_fn(adj, n):
    c4 = count_cycles_len(adj, n, 4, 200)
    c8 = count_cycles_len(adj, n, 8, 200) if c4 < 200 else 200
    base = 10000 * c4 + 500 * c8
    if c4 == 0 and c8 == 0:
        c16 = count_cycles_len(adj, n, 16, CAP16)
        return base + c16, (c4, c8, c16)
    return base + 10 ** 6, (c4, c8, None)


def anneal(n, seconds, seed):
    rng = random.Random(seed)
    adj = random_cubic(n, rng)
    cost, parts = cost_fn(adj, n)
    best = cost
    best_parts = parts
    t0 = time.time()
    T = 3000.0
    it = 0
    checked_full = set()
    while time.time() - t0 < seconds:
        it += 1
        T = max(2.0, 3000.0 * (0.9997 ** it))
        cand = edge_swap(adj, n, rng)
        if cand is None:
            continue
        ccost, cparts = cost_fn(cand, n)
        if ccost <= cost or rng.random() < 2.718 ** (-(ccost - cost) / T):
            adj, cost, parts = cand, ccost, cparts
            if cost < best:
                best, best_parts = cost, parts
                print(f"[n={n} seed={seed} it={it} t={time.time()-t0:.0f}s] "
                      f"best={best} parts={parts}", flush=True)
                if parts[0] == 0 and parts[1] == 0:
                    key = tuple(tuple(x) for x in adj)
                    if key not in checked_full:
                        checked_full.add(key)
                        res = full_pow2_check(adj, n)
                        print(f"    full check: {res}", flush=True)
                        if all(not p for _, p in res):
                            fn = f"COUNTEREXAMPLE_n{n}_seed{seed}.txt"
                            save_cert(adj, n, fn)
                            print("!!! COUNTEREXAMPLE SAVED:", fn, flush=True)
                            return
                    if parts[2] is not None and parts[2] <= 4:
                        save_cert(adj, n, f"near_n{n}_seed{seed}_c16_{parts[2]}.txt")
        # restart if stuck badly
        if it % 4000 == 0 and best >= 10 ** 6:
            adj = random_cubic(n, rng)
            cost, parts = cost_fn(adj, n)
    print(f"[n={n} seed={seed}] done: {it} iters, best={best} parts={best_parts}",
          flush=True)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "sweep":
        sweep()
    elif mode == "anneal":
        n = int(sys.argv[2])
        seconds = float(sys.argv[3])
        seed = int(sys.argv[4]) if len(sys.argv) > 4 else 0
        anneal(n, seconds, seed)

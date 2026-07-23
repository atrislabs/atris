#!/usr/bin/env python3
"""Search for a counterexample to Vizing's conjecture.

Strategy (informed by known reductions):
- The conjecture is proven when either factor has gamma <= 3, and for
  chordal / claw-free factors. A minimal counterexample factor is
  domination-edge-critical. So: build a pool of connected graphs with
  gamma >= 4, n = 10..14, pushed to edge-criticality (add edges until
  any further edge drops gamma), plus structured graphs (circulants).
- For each pair (G,H) in the pool, ask CP-SAT the DECISION question:
  does G box H have a dominating set of size <= gamma(G)*gamma(H) - 1 ?
  Any YES is a counterexample. Also compute exact product gamma on a
  sample to track the minimum ratio seen.
"""
import random, sys, time, json, itertools
from itertools import combinations
from ortools.sat.python import cp_model

random.seed(int(sys.argv[1]) if len(sys.argv) > 1 else 12345)


# ---------- basic graph utilities on (n, frozenset of edge pairs) ----------

def nbhd_masks(n, edges):
    N = [1 << v for v in range(n)]
    for a, b in edges:
        N[a] |= 1 << b
        N[b] |= 1 << a
    return N


def gamma_exact(n, edges, cap=8):
    N = nbhd_masks(n, edges)
    full = (1 << n) - 1
    # greedy upper bound to limit combos
    for k in range(1, cap + 1):
        for S in combinations(range(n), k):
            m = 0
            for v in S:
                m |= N[v]
                if m == full:
                    break
            if m == full:
                return k
    return cap + 1  # gamma > cap


def connected(n, edges):
    if n == 0:
        return False
    adj = [[] for _ in range(n)]
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)
    seen = {0}
    st = [0]
    while st:
        v = st.pop()
        for u in adj[v]:
            if u not in seen:
                seen.add(u)
                st.append(u)
    return len(seen) == n


def random_connected_graph(n, p):
    while True:
        edges = set()
        for a in range(n):
            for b in range(a + 1, n):
                if random.random() < p:
                    edges.add((a, b))
        if connected(n, edges):
            return edges


def make_edge_critical(n, edges, g):
    """Add edges (random order) while gamma stays g. Result: adding ANY
    further edge drops gamma -> domination-edge-critical with gamma g."""
    edges = set(edges)
    non = [(a, b) for a in range(n) for b in range(a + 1, n) if (a, b) not in edges]
    random.shuffle(non)
    changed = True
    while changed:
        changed = False
        for e in list(non):
            trial = edges | {e}
            if gamma_exact(n, trial, cap=g) == g:
                edges = trial
                non.remove(e)
                changed = True
    return frozenset(edges)


def circulant(n, S):
    return frozenset((min(a, (a + s) % n), max(a, (a + s) % n))
                     for a in range(n) for s in S)


# ---------- product + CP-SAT ----------

def box_product(nG, eG, nH, eH):
    n = nG * nH
    edges = []
    for g in range(nG):
        for a, b in eH:
            edges.append((g * nH + a, g * nH + b))
    for h in range(nH):
        for a, b in eG:
            edges.append((a * nH + h, b * nH + h))
    return n, edges


def domset_decision(n, edges, bound, timeout=60):
    """Return True/False/None(timeout): exists dominating set of size <= bound?"""
    adj = [set([v]) for v in range(n)]
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    m = cp_model.CpModel()
    x = [m.NewBoolVar(f'x{v}') for v in range(n)]
    for v in range(n):
        m.AddAtLeastOne([x[u] for u in adj[v]])
    m.Add(sum(x) <= bound)
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = timeout
    s.parameters.num_search_workers = 8
    st = s.Solve(m)
    if st == cp_model.OPTIMAL or st == cp_model.FEASIBLE:
        return True, [v for v in range(n) if s.Value(x[v])]
    if st == cp_model.INFEASIBLE:
        return False, None
    return None, None


def gamma_product_exact(nG, eG, nH, eH, timeout=120, known_lb=None):
    n, edges = box_product(nG, eG, nH, eH)
    adj = [set([v]) for v in range(n)]
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    m = cp_model.CpModel()
    x = [m.NewBoolVar(f'x{v}') for v in range(n)]
    for v in range(n):
        m.AddAtLeastOne([x[u] for u in adj[v]])
    if known_lb is not None:
        m.Add(sum(x) >= known_lb)
    m.Minimize(sum(x))
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = timeout
    s.parameters.num_search_workers = 8
    st = s.Solve(m)
    if st == cp_model.OPTIMAL:
        return int(s.ObjectiveValue())
    return None


# ---------- pool construction ----------

def build_pool(target=40, time_budget=300):
    pool = []  # (n, edges, gamma, tag)
    t0 = time.time()
    # structured: cycles and circulants with gamma >= 4
    for n in range(10, 15):
        for S in [(1,), (1, 2), (1, 3), (1, 4), (2, 3), (1, 5), (2, 5), (3, 4)]:
            if max(S) > n // 2:
                continue
            e = circulant(n, S)
            if not connected(n, e):
                continue
            g = gamma_exact(n, e, cap=6)
            if 4 <= g <= 6:
                pool.append((n, e, g, f'circ{n}{S}'))
    # random -> criticalized
    tries = 0
    while len(pool) < target and time.time() - t0 < time_budget:
        tries += 1
        n = random.choice([10, 11, 12, 13, 14])
        p = random.uniform(0.10, 0.30)
        e = frozenset(random_connected_graph(n, p))
        g = gamma_exact(n, e, cap=5)
        if g < 4 or g > 5:
            continue
        ec = make_edge_critical(n, e, g)
        g2 = gamma_exact(n, ec, cap=5)
        assert g2 == g
        if ec not in [x[1] for x in pool]:
            pool.append((n, ec, g, f'randcrit{n}g{g}#{tries}'))
    return pool


def main():
    t0 = time.time()
    pool = build_pool(target=int(sys.argv[2]) if len(sys.argv) > 2 else 40,
                      time_budget=float(sys.argv[3]) if len(sys.argv) > 3 else 240)
    print(f'pool: {len(pool)} graphs with gamma>=4 '
          f'({time.time()-t0:.0f}s)', flush=True)
    for n, e, g, tag in pool:
        print(f'  {tag}: n={n} m={len(e)} gamma={g}', flush=True)

    best = []  # (ratio, tagG, tagH, gG, gH, gP)
    results = []
    pairs = []
    for i in range(len(pool)):
        for j in range(i, len(pool)):
            pairs.append((i, j))
    random.shuffle(pairs)
    print(f'testing {len(pairs)} pairs', flush=True)

    limit = float(sys.argv[4]) if len(sys.argv) > 4 else 1500
    n_holds = 0
    timeouts = []
    for cnt, (i, j) in enumerate(pairs):
        nG, eG, gG, tG = pool[i]
        nH, eH, gH, tH = pool[j]
        if nG * nH > 225:
            continue
        bound = gG * gH - 1
        nP, eP = box_product(nG, eG, nH, eH)
        t1 = time.time()
        feas, sol = domset_decision(nP, eP, bound, timeout=20)
        dt = time.time() - t1
        if feas is True:
            print('!!! COUNTEREXAMPLE CANDIDATE:', tG, tH, gG, gH,
                  'domset size <=', bound, flush=True)
            with open('CANDIDATE.json', 'w') as f:
                json.dump({'G': [nG, sorted(map(list, eG))],
                           'H': [nH, sorted(map(list, eH))],
                           'gG': gG, 'gH': gH, 'sol': sol}, f)
            return
        elif feas is False:
            n_holds += 1
        else:
            timeouts.append((i, j))
            print(f'  timeout on {tG} x {tH} (bound {bound})', flush=True)
        if (cnt + 1) % 50 == 0:
            print(f'  ... {cnt+1}/{len(pairs)} decided, {n_holds} hold, '
                  f'{len(timeouts)} timeouts, {time.time()-t0:.0f}s', flush=True)
        if time.time() - t0 > limit:
            print(f'time limit; decided {cnt+1} pairs', flush=True)
            break

    # revisit timeouts with more time
    for i, j in timeouts:
        nG, eG, gG, tG = pool[i]
        nH, eH, gH, tH = pool[j]
        nP, eP = box_product(nG, eG, nH, eH)
        feas, sol = domset_decision(nP, eP, gG * gH - 1, timeout=300)
        print(f'  revisit {tG} x {tH}: feasible={feas}', flush=True)
        if feas is True:
            with open('CANDIDATE.json', 'w') as f:
                json.dump({'G': [nG, sorted(map(list, eG))],
                           'H': [nH, sorted(map(list, eH))],
                           'gG': gG, 'gH': gH, 'sol': sol}, f)
            return

    # exact ratio stats on a sample of pairs
    sample = pairs[:min(30, len(pairs))]
    for i, j in sample:
        nG, eG, gG, tG = pool[i]
        nH, eH, gH, tH = pool[j]
        if nG * nH > 225:
            continue
        gP = gamma_product_exact(nG, eG, nH, eH, timeout=60, known_lb=gG * gH)
        if gP is not None:
            r = gP / (gG * gH)
            results.append((r, tG, tH, gG, gH, gP))
    with open('results.json', 'w') as f:
        json.dump([{'ratio': r, 'G': a, 'H': b, 'gG': g1, 'gH': g2, 'gP': gp}
                   for r, a, b, g1, g2, gp in sorted(results)[:50]], f, indent=1)
    print(f'done. {n_holds} pairs conjecture holds (proved), '
          f'{len(timeouts)} initial timeouts. tightest exact pairs:')
    for r, a, b, g1, g2, gp in sorted(results)[:10]:
        print(f'  ratio={r:.4f}  {a} x {b}  gamma={g1},{g2} product={gp}')


if __name__ == '__main__':
    main()

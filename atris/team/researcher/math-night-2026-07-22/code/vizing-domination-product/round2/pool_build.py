"""Build factor pool maximizing integrality gap gamma - gamma_f, gamma>=4.

Families: circulants (all small connection sets), generalized Petersen,
Kneser-like, hill-climbed random graphs. Keep top-K by gap (tiebreak ratio).
Output: pool.json
"""
import json, random, sys, time
from itertools import combinations
from lib import (circulant, gen_petersen, kneser, random_graph, gamma_exact,
                 gamma_f_lp, graph_key, is_connected)

MAXN = 16          # factor size cap (product <= 256 for 16x16)
MIN_GAMMA = 4      # Vizing proven for gamma<=3 (Sun 2004)
TOPK = 30

t0 = time.time()
cands = {}

def consider(name, n, edges):
    if n > MAXN or not edges or not is_connected(n, edges):
        return
    key = graph_key(n, edges)
    if key in cands:
        return
    g = gamma_exact(n, edges, cap=8)
    if g < MIN_GAMMA or g > 8:
        return
    gf, _ = gamma_f_lp(n, edges)
    gap = g - gf
    if gap < 0.2:      # need real integrality gap in both factors
        return
    cands[key] = dict(name=name, n=n, edges=[list(e) for e in edges],
                      gamma=g, gamma_f=round(gf, 6), gap=round(gap, 6),
                      ratio=round(g / gf, 6))

# --- circulants: all connection sets S subset {1..n//2}, |S|<=3 ---
for n in range(10, MAXN + 1):
    half = n // 2
    for r in range(1, 4):
        for S in combinations(range(1, half + 1), r):
            consider(f'circ{n}{S}', *circulant(n, S))

# --- generalized Petersen GP(n,k), 2n<=16 -> n<=8 ---
for n in range(5, 9):
    for k in range(1, (n - 1) // 2 + 1):
        consider(f'GP({n},{k})', *gen_petersen(n, k))

# --- Kneser K(n,k) with <=16 vertices ---
for (n, k) in [(5, 2), (6, 2)]:
    nn, ee = kneser(n, k)
    if nn <= MAXN:
        consider(f'K({n},{k})', nn, ee)

print(f'structured: {len(cands)} candidates, {time.time()-t0:.0f}s', flush=True)

# --- hill-climb random graphs on gap ---
rng = random.Random(20260722)

def score(n, edges):
    g = gamma_exact(n, edges, cap=8)
    if g < MIN_GAMMA or g > 8 or not is_connected(n, edges):
        return None, None, -1
    gf, _ = gamma_f_lp(n, edges)
    return g, gf, g - gf

for restart in range(60):
    n = rng.choice([11, 12, 13, 14, 15, 16])
    m = rng.randint(int(1.3 * n), int(2.4 * n))
    _, edges = random_graph(n, m, rng)
    g, gf, sc = score(n, edges)
    if sc < 0:
        continue
    all_e = [(a, b) for a in range(n) for b in range(a + 1, n)]
    eset = set(edges)
    for it in range(250):
        e = rng.choice(all_e)
        trial = set(eset)
        if e in trial:
            trial.discard(e)
        else:
            trial.add(e)
        te = sorted(trial)
        g2, gf2, sc2 = score(n, te)
        if sc2 > sc + 1e-9:
            eset, sc, g, gf = trial, sc2, g2, gf2
    if sc >= 0.5:
        consider(f'hill{n}#{restart}', n, sorted(eset))
    if restart % 10 == 9:
        print(f'  restart {restart+1}/60 done, pool={len(cands)}, {time.time()-t0:.0f}s', flush=True)

pool = sorted(cands.values(), key=lambda d: (-d['gap'], -d['ratio']))[:TOPK]
json.dump(pool, open('pool.json', 'w'), indent=1)
print(f'\npool: kept top {len(pool)} by gap ({time.time()-t0:.0f}s total)')
for p in pool:
    print(f"  {p['name']:<22} n={p['n']:<3} gamma={p['gamma']} gamma_f={p['gamma_f']:<9} gap={p['gap']:<8} ratio={p['ratio']}")

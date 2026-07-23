"""Wave 2: hill-climb G (self-pair GxG) to maximize the pair-survival slack
    slack = gamma(G)^2 - gamma_f(G box G)
A counterexample self-pair NEEDS slack >= 1 (since gamma >= gamma_f on the
product). Wave-1 showed every gap-ranked pool pair has slack <= 0: the product
LP bound alone proves Vizing there. So search directly on the real obstacle.

Moves: edge add/remove. Score lexicographic: (gamma>=4, slack, factor gap).
Any G reaching slack >= 1 is dumped to survivors2.json for SAT decision.
"""
import json, random, time
from fractions import Fraction
from lib import (gamma_exact, gamma_f_lp, certified_lb, box_product,
                 is_connected, random_graph)

rng = random.Random(99)
t0 = time.time()
survivors = []
best_overall = None

def evaluate(n, edges):
    if not is_connected(n, edges):
        return None
    g = gamma_exact(n, edges, cap=7)
    if g < 4 or g > 7:
        return None
    gf, _ = gamma_f_lp(n, edges)
    if g - gf < 0.15:          # both-factor gap requirement (self-pair)
        return None
    nP, eP = box_product(n, edges, n, edges)
    lp, duals = gamma_f_lp(nP, eP)
    cert = certified_lb(nP, eP, duals)
    slack = Fraction(g * g) - cert
    return dict(g=g, gf=gf, slack=float(slack), cert=cert, n=n,
                edges=sorted(edges))

for restart in range(14):
    n = rng.choice([12, 13, 14])
    m = rng.randint(int(1.4 * n), int(2.6 * n))
    _, edges = random_graph(n, m, rng)
    cur = evaluate(n, sorted(edges))
    tries = 0
    while cur is None and tries < 40:
        _, edges = random_graph(n, rng.randint(int(1.4*n), int(2.6*n)), rng)
        cur = evaluate(n, sorted(edges))
        tries += 1
    if cur is None:
        continue
    eset = set(map(tuple, cur['edges']))
    all_e = [(a, b) for a in range(n) for b in range(a + 1, n)]
    stall = 0
    for it in range(120):
        e = rng.choice(all_e)
        trial = set(eset)
        trial.symmetric_difference_update([e])
        nxt = evaluate(n, sorted(trial))
        if nxt and (nxt['slack'], nxt['g'] - nxt['gf']) > (cur['slack'], cur['g'] - cur['gf']):
            cur, eset, stall = nxt, trial, 0
        else:
            stall += 1
            if stall > 50:
                break
    if best_overall is None or cur['slack'] > best_overall['slack']:
        best_overall = cur
    print(f"restart {restart}: n={n} gamma={cur['g']} gf={cur['gf']:.3f} "
          f"slack={cur['slack']:.3f}  ({time.time()-t0:.0f}s)", flush=True)
    if cur['slack'] >= 1:
        survivors.append(cur)

print(f"\nbest slack overall: {best_overall['slack']:.3f} "
      f"(gamma={best_overall['g']}, n={best_overall['n']})")
if survivors:
    for s in survivors:
        s['cert'] = str(s['cert'])
    json.dump(survivors, open('survivors2.json', 'w'), indent=1)
    print(f'{len(survivors)} slack>=1 survivors written to survivors2.json')
else:
    print('no graph reached slack >= 1: LP bound kills every self-pair searched')
json.dump({'best': {k: (str(v) if isinstance(v, Fraction) else v)
                    for k, v in best_overall.items()}},
          open('wave2_best.json', 'w'), indent=1)

"""Wave 3: asymmetric climb. Fix G = best gap-per-size factors; hill-climb H
on slack(G,H) = gamma(G)*gamma(H) - cert(gamma_f(G box H)), requiring
gamma(H)>=4. Gap constraint relaxed to >0 only at report time (climber may
cross low-gap regions). Survivor = slack >= 1 AND both gaps > 0.
"""
import json, random, time
from fractions import Fraction
from lib import (gamma_exact, gamma_f_lp, certified_lb, box_product,
                 is_connected, random_graph)

rng = random.Random(777)
t0 = time.time()
pool = json.load(open('pool.json'))
fixedGs = [p for p in pool if p['name'] in ('circ12(1, 4)', 'circ13(1, 5)', 'GP(7,2)')]
survivors = []
best = (-99, None)

for G in fixedGs:
    eG = [tuple(x) for x in G['edges']]
    for restart in range(6):
        n = rng.choice([12, 13])
        _, edges = random_graph(n, rng.randint(int(1.5*n), int(2.6*n)), rng)

        def ev(es):
            if not is_connected(n, es):
                return None
            g = gamma_exact(n, es, cap=7)
            if g < 4 or g > 7:
                return None
            gf, _ = gamma_f_lp(n, es)
            nP, eP = box_product(G['n'], eG, n, es)
            lp, duals = gamma_f_lp(nP, eP)
            cert = certified_lb(nP, eP, duals)
            slack = float(Fraction(G['gamma'] * g) - cert)
            return dict(g=g, gf=gf, slack=slack, edges=sorted(es))

        cur = ev(sorted(edges))
        tries = 0
        while cur is None and tries < 30:
            _, edges = random_graph(n, rng.randint(int(1.5*n), int(2.6*n)), rng)
            cur = ev(sorted(edges))
            tries += 1
        if cur is None:
            continue
        eset = set(map(tuple, cur['edges']))
        all_e = [(a, b) for a in range(n) for b in range(a+1, n)]
        stall = 0
        for it in range(100):
            e = rng.choice(all_e)
            trial = set(eset); trial.symmetric_difference_update([e])
            nxt = ev(sorted(trial))
            if nxt and nxt['slack'] > cur['slack'] + 1e-9:
                cur, eset, stall = nxt, trial, 0
            else:
                stall += 1
                if stall > 45:
                    break
        tag = (cur['slack'], f"{G['name']} x climbed(n={n},g={cur['g']},gf={cur['gf']:.3f})")
        if tag[0] > best[0]:
            best = tag
        print(f"G={G['name']:<14} restart {restart}: H(n={n}) gamma={cur['g']} "
              f"gf={cur['gf']:.3f} slack={cur['slack']:.3f} ({time.time()-t0:.0f}s)", flush=True)
        if cur['slack'] >= 1 and cur['g'] - cur['gf'] > 1e-9:
            survivors.append(dict(G=G['name'], H=cur))

print(f"\nbest slack: {best[0]:.3f}  [{best[1]}]")
if survivors:
    json.dump(survivors, open('survivors3.json', 'w'), indent=1, default=str)
    print(f'{len(survivors)} survivors -> survivors3.json')
else:
    print('no asymmetric pair reached slack >= 1')

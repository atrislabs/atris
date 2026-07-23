#!/usr/bin/env python3
"""
Round 2: randomized + hill-climb search, fitness = SAT effort
(Glucose3 accumulated conflicts+propagations over the lazy-subtour loop).
UNSAT = counterexample. Sizes 66-120.
"""
import os, random, sys, time
from itertools import combinations
from pysat.solvers import Glucose3
import search  # expansion machinery

HERE = os.path.dirname(os.path.abspath(__file__))

def sat_fitness(rot):
    """Return (verdict, fitness). verdict in {'HAM','NONHAM'}."""
    n = len(rot)
    adj = {v: set(nb) for v, nb in enumerate(rot)}
    edges = sorted(set(tuple(sorted((v, w))) for v in adj for w in adj[v]))
    evar = {e: i+1 for i, e in enumerate(edges)}
    cnf = []
    for v in range(n):
        inc = [evar[tuple(sorted((v, w)))] for w in adj[v]]
        for a, b in combinations(inc, 2): cnf.append([a, b])
        cnf.append([-x for x in inc])
    s = Glucose3(bootstrap_with=cnf)
    rounds = 0
    while True:
        if not s.solve():
            st = s.accum_stats()
            return 'NONHAM', st.get('conflicts', 0) + 200*rounds
        rounds += 1
        model = set(l for l in s.get_model() if l > 0)
        chosen = [e for e in edges if evar[e] in model]
        nbr = {v: [] for v in range(n)}
        for a, b in chosen: nbr[a].append(b); nbr[b].append(a)
        seen = set(); cycles = []
        for v in range(n):
            if v in seen: continue
            cyc = [v]; seen.add(v); prev, cur = None, v
            while True:
                nxt = [w for w in nbr[cur] if w != prev][0]
                if nxt == v: break
                cyc.append(nxt); seen.add(nxt); prev, cur = cur, nxt
            cycles.append(cyc)
        if len(cycles) == 1:
            st = s.accum_stats()
            return 'HAM', st.get('conflicts', 0) + st.get('decisions', 0)//10 + 200*rounds
        cyc = min(cycles, key=len)
        s.add_clause([-evar[tuple(sorted((cyc[i], cyc[(i+1) % len(cyc)])))]
                      for i in range(len(cyc))])

def main():
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 777
    rng = random.Random(seed)
    time_budget = float(sys.argv[1]) if len(sys.argv) > 1 else 3600
    t0 = time.time()
    seeds = search.plantri_seeds(20, 120)
    seeds += search.plantri_seeds(22, 120, f"{rng.randrange(100)}/100")
    print(f"{len(seeds)} seeds", flush=True)
    pop = []
    best_ever = 0
    checked = 0
    gen = 0
    while time.time() - t0 < time_budget:
        gen += 1
        batch = []
        for _ in range(20):
            if pop and rng.random() < 0.7:
                base = rng.choice(pop)[1]
            else:
                base = rng.choice(seeds)
            r = [list(x) for x in base]
            if len(r) + 4 > 120:
                base = rng.choice(seeds)   # at cap: restart from a fresh seed
                r = [list(x) for x in base]
            tgt = min(120, len(r) + rng.choice([4, 8, 12, 20, 32]))
            tgt = max(tgt, 66)
            guard = 0
            while len(r) < tgt and guard < 600:
                guard += 1
                r2 = search.expand(r, rng)
                if r2 is not None: r = r2
            if 66 <= len(r) and len(r) > len(base):
                batch.append(r)
        for rot in batch:
            verdict, fit = sat_fitness(rot)
            checked += 1
            if verdict == 'NONHAM':
                ok, msg = search.check_class(rot)
                path = os.path.join(HERE, f"s2candidate_{len(rot)}_{int(time.time())}.txt")
                search.save_certificate(rot, path)
                print(f"!!! NONHAM n={len(rot)} class={ok}({msg}) -> {path}", flush=True)
                if ok:
                    search.save_certificate(rot, os.path.join(HERE, "certificate.txt"))
                    print("CERTIFICATE SAVED", flush=True)
                    return
            pop.append((fit, rot))
            if fit > best_ever:
                best_ever = fit
        pop.sort(key=lambda t: -t[0])
        pop = pop[:25]
        if gen % 10 == 0:
            print(f"gen {gen}: checked={checked} elapsed={int(time.time()-t0)}s "
                  f"top={[(p[0], len(p[1])) for p in pop[:5]]}", flush=True)
    print(f"done: checked={checked}, all HAM, best fitness {best_ever}", flush=True)
    for i, (fit, rot) in enumerate(pop[:8]):
        search.save_certificate(rot, os.path.join(HERE, f"s2hard_{i}_n{len(rot)}_f{fit}.txt"))

if __name__ == "__main__":
    main()

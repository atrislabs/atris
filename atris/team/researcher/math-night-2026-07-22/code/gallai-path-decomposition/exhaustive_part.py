import sys
# wrapper: pass res/mod to geng for parallel partitioning
import exhaustive
import subprocess, time, random
from math import ceil
import networkx as nx
from search import decide_cpsat, graph_summary, edges_str, save_certificate

n = int(sys.argv[1]); res = sys.argv[2]; maxsec = int(sys.argv[3])
t = ceil(n/2); rng = random.Random(42)
cmd = ['geng','-c','-q','-d2',str(n), res]
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, bufsize=1<<20)
total=kept=greedy_ok=sat_solved=0; t0=time.time()
for line in proc.stdout:
    total += 1
    if time.time()-t0 > maxsec:
        print(f"TIME LIMIT after {total}", flush=True); proc.kill(); break
    G = nx.from_graph6_bytes(line.strip().encode())
    degs = dict(G.degree())
    if max(degs.values()) < 6: continue
    ev = [v for v in G.nodes() if degs[v]%2==0]
    H = G.subgraph(ev)
    if H.number_of_edges() == H.number_of_nodes() - nx.number_connected_components(H): continue
    if nx.check_planarity(G)[0]: continue
    kept += 1
    if exhaustive.greedy_decompose(G, t, tries=25, rng=rng):
        greedy_ok += 1
    else:
        sat_solved += 1
        try:
            r = decide_cpsat(G, t, time_limit=120)
        except TimeoutError:
            print(f"SAT TIMEOUT: {edges_str(G)}", flush=True); continue
        if r is None:
            print(f"*** COUNTEREXAMPLE *** {graph_summary(G)}", flush=True)
            print(f"edges: {edges_str(G)}", flush=True)
            save_certificate(G, f"certificate_n{n}_{res.replace('/','_')}.txt")
    if kept % 20000 == 0:
        print(f"progress {res}: total={total} kept={kept} greedy_ok={greedy_ok} sat={sat_solved} ({time.time()-t0:.0f}s)", flush=True)
print(f"DONE {res}: scanned={total} kept={kept} greedy_ok={greedy_ok} exact={sat_solved} ({time.time()-t0:.0f}s)", flush=True)

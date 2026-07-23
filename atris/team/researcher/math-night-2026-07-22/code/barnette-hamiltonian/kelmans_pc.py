import sys, verify
from kelmans import faces, ham_with
from itertools import combinations
from forced import read_pc
tot=0; fails=0; g=0
for n, adj in read_pc(sys.argv[1]):
    fs = faces(adj, n)
    for face in fs:
        L=len(face)
        fedges=[tuple(sorted((face[i],face[(i+1)%L]))) for i in range(L)]
        for e1,e2 in combinations(fedges,2):
            for a,b in ((e1,e2),(e2,e1)):
                tot+=1
                if not ham_with(n,adj,[a],[b]):
                    fails+=1
                    print(f"KELMANS FAILURE graph#{g}: in={a} out={b}", flush=True)
    g+=1
    if g%50==0: print(f"...{g} graphs, {tot} pairs, {fails} failures", flush=True)
print(f"DONE {g} graphs {tot} pairs {fails} failures")

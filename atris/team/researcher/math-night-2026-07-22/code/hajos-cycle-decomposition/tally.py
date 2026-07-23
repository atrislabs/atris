import ast, glob, sys
pat = sys.argv[1]
tot=0; esc=0; unk=0; H={}
files=sorted(glob.glob(pat))
done=0
for f in files:
    for line in open(f):
        if "DONE" in line:
            done+=1
            tot+=int(line.split("total=")[1].split()[0])
            esc+=int(line.split("escal=")[1].split()[0])
            unk+=int(line.split("unknown=")[1].split()[0])
            h=ast.literal_eval(line.split("hist=")[1].rsplit(" elapsed")[0])
            for k,v in h.items(): H[k]=H.get(k,0)+v
print(f"files={len(files)} done_shards={done} total={tot} escal={esc} unknown={unk}")
print("hist=", dict(sorted(H.items(), key=str)))

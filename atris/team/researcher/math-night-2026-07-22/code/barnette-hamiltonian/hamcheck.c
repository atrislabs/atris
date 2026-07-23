/* hamcheck: read planar_code graphs from stdin, test Hamiltonicity by DFS
 * with forced-edge + connectivity-ish pruning and a node budget.
 * Graphs not proven Hamiltonian within budget are written (planar_code) to
 * the survivors file given as argv[1]. Prints stats at end.
 * cc -O3 -o hamcheck hamcheck.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAXN 256
static int n, deg[MAXN], adj[MAXN][3];
static unsigned char raw[8192]; static int rawlen;
static long long budget, nodes;
static int inpath[MAXN], path_[MAXN], plen;

static int dfs(int v){
    if (++nodes > budget) return -1; /* budget exceeded */
    if (plen == n) {
        for (int i=0;i<3;i++) if (adj[v][i]==0) return 1;
        return 0;
    }
    int r0 = 0;
    for (int i=0;i<3;i++){
        int w = adj[v][i];
        if (inpath[w]) continue;
        /* prune: if some unvisited vertex besides w has all nbrs visited (and not start-adjacent enough) */
        inpath[w]=1; path_[plen++]=w;
        /* cheap prune: any unvisited u with fewer than 2 unvisited-or-endpoint nbrs is dead
           (skip full scan for speed; scan only neighbours of w) */
        int ok=1;
        for (int j=0;j<3 && ok;j++){
            int u = adj[w][j];
            if (inpath[u] || u==0) continue;
            int freecnt=0;
            for (int k=0;k<3;k++){
                int x=adj[u][k];
                if (!inpath[x] || x==w || x==0) freecnt++;
            }
            if (freecnt < 2) ok=0;
        }
        if (ok){
            int r = dfs(w);
            if (r) { inpath[w]=0; plen--; return r; }
        }
        inpath[w]=0; plen--;
        (void)r0;
    }
    return 0;
}

static int read_graph(FILE *f){
    int c = getc(f);
    if (c == EOF) return 0;
    if (c == '>') { /* header >>planar_code<< */
        static char hdr[64]; hdr[0]='>'; int i=1;
        while (i<20){ int d=getc(f); hdr[i++]=(char)d; if (d=='<'){ int e=getc(f); hdr[i++]=(char)e; if(e=='<') break; } }
        c = getc(f);
        if (c==EOF) return 0;
    }
    rawlen=0; raw[rawlen++]=(unsigned char)c;
    n = c;
    if (n<=0 || n>=MAXN){ fprintf(stderr,"bad n=%d\n",n); exit(1);}
    for (int v=0; v<n; v++){
        deg[v]=0;
        while (1){
            int w = getc(f);
            if (w==EOF){ fprintf(stderr,"eof mid-graph\n"); exit(1);}
            raw[rawlen++]=(unsigned char)w;
            if (w==0) break;
            if (deg[v]<3) adj[v][deg[v]]=w-1;
            deg[v]++;
        }
        if (deg[v]!=3){ fprintf(stderr,"non-cubic vertex deg=%d\n",deg[v]); exit(1);}
    }
    return 1;
}

int main(int argc, char**argv){
    if (argc<2){ fprintf(stderr,"usage: hamcheck survivors.pc [budget]\n"); return 2;}
    FILE *surv = fopen(argv[1],"ab");
    budget = argc>2 ? atoll(argv[2]) : 2000000LL;
    long long total=0, ham=0, timeout=0, nonham=0;
    while (read_graph(stdin)){
        total++;
        memset(inpath,0,sizeof(int)*n);
        inpath[0]=1; path_[0]=0; plen=1; nodes=0;
        int r = dfs(0);
        if (r==1) ham++;
        else {
            if (r==-1) timeout++; else nonham++;
            fwrite(raw,1,rawlen,surv);
            fflush(surv);
            fprintf(stderr,"SURVIVOR n=%d (%s) total_so_far=%lld\n", n, r==-1?"budget":"NONHAM-claimed", total);
        }
    }
    fclose(surv);
    printf("total=%lld hamiltonian=%lld budget_exceeded=%lld claimed_nonham=%lld\n", total, ham, timeout, nonham);
    return 0;
}

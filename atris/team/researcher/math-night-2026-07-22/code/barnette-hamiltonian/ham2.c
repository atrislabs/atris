/* ham2: exact Hamiltonicity decision for cubic graphs from planar_code stdin.
 * Edge-state propagation search:
 *   states: UNK/IN/OUT per edge; each vertex ends with exactly 2 IN.
 *   propagation: vertex counting rules + no-premature-cycle rule.
 *   branch: unknown edge at a path endpoint; IN first.
 * Non-Hamiltonian graphs (search exhausted, no HC) -> written to survivors file
 * and flagged; budget exceeded -> also survivors (distinguished).
 * cc -O3 -o ham2 ham2.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAXN 256
#define MAXM (3*MAXN/2)

static int n, m;
static int adj[MAXN][3], eother[MAXN][3], eid_[MAXN][3];
static int e_u[MAXM], e_v[MAXM];
static unsigned char raw[8192]; static int rawlen;

typedef struct {
    unsigned char est[MAXM];   /* 0 unk 1 in 2 out */
    unsigned char vin[MAXN], vout[MAXN];
    short oend[MAXN];          /* other endpoint of path containing v (valid when vin[v]<2) */
    short plen[MAXN];          /* edge-count of path, stored at its endpoints */
    short incount;
} State;

static long long nodes, budget;
static int found_ham;

/* forced queue */
static int fq[4*MAXM], fqs[4*MAXM]; static int fqh, fqt;

static int set_edge(State *st, int e, int val);

static int check_vertex(State *st, int v){
    int need = 2 - st->vin[v];
    int avail = 3 - st->vin[v] - st->vout[v];
    if (need > avail) return 0;
    if (need == avail && need > 0){
        for (int i=0;i<3;i++){
            int e = eid_[v][i];
            if (st->est[e]==0){ fq[fqt]=e; fqs[fqt]=1; fqt++; }
        }
    }
    return 1;
}

static int set_edge(State *st, int e, int val){
    if (st->est[e]==val) return 1;
    if (st->est[e]!=0) return 0;
    int u = e_u[e], v = e_v[e];
    if (val==1){
        if (st->vin[u]>=2 || st->vin[v]>=2) return 0;
        int au = st->oend[u], av = st->oend[v];
        if (au == v){ /* closing the path containing both u and v as its two ends */
            if (st->plen[u] == n-1){ st->est[e]=1; st->incount++; found_ham=1; return 1; }
            return 0;
        }
        int L = st->plen[au] + st->plen[av] + 1;
        st->est[e]=1; st->incount++;
        st->vin[u]++; st->vin[v]++;
        st->oend[au]=av; st->oend[av]=au;
        st->plen[au]=L; st->plen[av]=L;
        if (!check_vertex(st,u) || !check_vertex(st,v)) return 0;
        /* anti-closure: unknown edge joining the two new ends must be OUT unless it completes HC */
        if (L < n-1){
            for (int i=0;i<3;i++){
                if (adj[au][i]==av){
                    int e2 = eid_[au][i];
                    if (st->est[e2]==0){ fq[fqt]=e2; fqs[fqt]=2; fqt++; }
                }
            }
        }
    } else {
        st->est[e]=2;
        st->vout[u]++; st->vout[v]++;
        if (!check_vertex(st,u) || !check_vertex(st,v)) return 0;
    }
    return 1;
}

static int propagate(State *st){
    while (fqh < fqt){
        int e = fq[fqh], s = fqs[fqh]; fqh++;
        if (!set_edge(st, e, s)) return 0;
        if (found_ham) return 1;
    }
    return 1;
}

static int solve(State *st){
    if (++nodes > budget) return -1;
    if (found_ham) return 1;
    /* pick branch edge: prefer unknown edge at vertex with vin==1 */
    int be = -1;
    for (int v=0; v<n && be<0; v++){
        if (st->vin[v]==1){
            for (int i=0;i<3;i++){
                int e=eid_[v][i];
                if (st->est[e]==0){ be=e; break; }
            }
        }
    }
    if (be<0){
        for (int e=0;e<m;e++) if (st->est[e]==0){ be=e; break; }
    }
    if (be<0){
        /* all edges decided, no HC closed => 2-factor with subcycles impossible here:
           actually incount==n would have set found_ham; so this is a dead end */
        return 0;
    }
    for (int val=1; val<=2; val++){
        State cp = *st;
        fqh=fqt=0;
        if (set_edge(&cp, be, val) && (found_ham || propagate(&cp))){
            if (found_ham) return 1;
            int r = solve(&cp);
            if (r) return r;
        }
        found_ham = 0; /* reset if a failed branch set it spuriously (it can't, but safe) */
    }
    return 0;
}

static int read_graph(FILE *f){
    int c = getc(f);
    if (c == EOF) return 0;
    if (c == '>') {
        int prev=0;
        while (1){ int d=getc(f); if(d==EOF) return 0; if (prev=='<' && d=='<') break; prev=d; }
        c = getc(f);
        if (c==EOF) return 0;
    }
    rawlen=0; raw[rawlen++]=(unsigned char)c;
    n = c;
    if (n<=0 || n>=MAXN){ fprintf(stderr,"bad n=%d\n",n); exit(1);}
    int deg[MAXN];
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
    /* build edge ids */
    m=0;
    for (int v=0; v<n; v++)
        for (int i=0;i<3;i++){
            int w=adj[v][i];
            if (v<w){ e_u[m]=v; e_v[m]=w; eid_[v][i]=m; m++; }
        }
    for (int v=0; v<n; v++)
        for (int i=0;i<3;i++){
            int w=adj[v][i];
            if (v>w){
                for (int e=0;e<m;e++) if (e_u[e]==w && e_v[e]==v){ eid_[v][i]=e; break; }
            }
        }
    return 1;
}

int main(int argc, char**argv){
    if (argc<2){ fprintf(stderr,"usage: ham2 survivors.pc [budget] [--exact-only]\n"); return 2;}
    FILE *surv = fopen(argv[1],"ab");
    budget = argc>2 ? atoll(argv[2]) : 50000000LL;
    int verbose = (argc>3 && strcmp(argv[3],"verbose")==0);
    long long total=0, ham=0, timeout=0, nonham=0;
    long long maxnodes=0; int argmax_n=0;
    while (read_graph(stdin)){
        total++;
        State st;
        memset(st.est,0,m);
        memset(st.vin,0,n); memset(st.vout,0,n);
        for (int v=0;v<n;v++){ st.oend[v]=v; st.plen[v]=0; }
        st.incount=0;
        found_ham=0; nodes=0; fqh=fqt=0;
        int r = solve(&st);
        if (nodes>maxnodes){ maxnodes=nodes; argmax_n=n; }
        if (verbose){ printf("G %lld n=%d verdict=%s nodes=%lld\n", total, n, r==1?"HAM":(r==-1?"BUDGET":"NONHAM"), nodes); fflush(stdout); }
        if (r==1) ham++;
        else {
            if (r==-1){ timeout++; fprintf(stderr,"BUDGET n=%d idx=%lld\n", n, total); }
            else { nonham++; fprintf(stderr,"NONHAMILTONIAN n=%d idx=%lld\n", n, total); }
            fwrite(raw,1,rawlen,surv);
            fflush(surv);
        }
    }
    fclose(surv);
    printf("total=%lld ham=%lld budget_exceeded=%lld NONHAM=%lld maxnodes=%lld (n=%d)\n",
           total, ham, timeout, nonham, maxnodes, argmax_n);
    return 0;
}

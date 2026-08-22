from tg import *
def A(i): return '0x'+format(i,'040x')
SEED=A(1)
def cell(depth=3,socks=0):
    o={}; chain=[SEED]+[A(400+i) for i in range(depth)]
    for i in range(len(chain)-1): o[chain[i]]={chain[i+1]:50*S}
    for j in range(6): o[SEED][A(500+j)]=50*S
    for j in range(6): o[A(500+j)]={A(500+(j+1)%6):50*S}
    a=chain[-1]; ss=[A(700+i) for i in range(socks)]
    o.setdefault(a,{})
    for s in ss: o[a][s]=50*S; o[s]={a:50*S}
    return o,a,ss
def chain_reach(dec,damp):
    o={}; ch=[SEED]+[A(300+i) for i in range(14)]
    for i in range(len(ch)-1): o[ch[i]]={ch[i+1]:50*S}
    sc=calculate(graph_nodes(o),o,Cfg(trust_share=1.0,trust_multiplier=1.0,trust_decay=dec,damping=damp,seeds={SEED},f15=True))
    # last hop still holding >= 0.1% of standing
    last=0
    for d in range(1,15):
        if pct(sc.get(ch[d],0))>=0.1: last=d
    return last
def founder_floor(dec,damp,nseeds=1):
    """a fully repudiated seed's permanent share"""
    o={}; seeds={A(1+i) for i in range(nseeds)}; mem=[A(100+i) for i in range(40)]
    for j,s in enumerate(sorted(seeds)): o[s]={mem[j]:50*S}
    for i,m in enumerate(mem): o[m]={mem[(i+1)%40]:50*S, mem[(i+2)%40]:50*S}
    sc=calculate(graph_nodes(o),o,Cfg(trust_share=1.0,trust_multiplier=1.0,trust_decay=dec,damping=damp,seeds=seeds,f15=True))
    return pct(sum(sc[s] for s in seeds))

print("Parameter trade-off, trust_share = 1, multiplier = 1, F15 on")
print(f"  {'damping':>8} {'decay':>6} | {'sock cell gain':>14} {'reach (hops >0.1%)':>19} {'un-vouched seed floor':>22}")
for damp in [0.85,0.75,0.65]:
    for dec in [0.6,0.7,0.8,0.9]:
        cfg=Cfg(trust_share=1.0,trust_multiplier=1.0,trust_decay=dec,damping=damp,seeds={SEED},f15=True)
        o,a,_=cell(3,0); base=pct(calculate(graph_nodes(o),o,cfg)[a])
        o,a,ss=cell(3,1); sc=calculate(graph_nodes(o),o,cfg)
        gain=(pct(sc.get(a,0)+sum(sc.get(x,0) for x in ss)))/base
        print(f"  {damp:>8.2f} {dec:>6.2f} | {gain:>13.2f}x {chain_reach(dec,damp):>19} {founder_floor(dec,damp):>21.1f}%")

from tg import *
def A(i): return '0x'+format(i,'040x')

def honest_community(h=10, seed_at=1):
    """seed vouches for h members; members vouch for each other in a ring."""
    out={}
    seed=A(seed_at)
    mem=[A(100+i) for i in range(h)]
    out[seed]={m:50*S for m in mem}
    for i,m in enumerate(mem):
        out[m]={mem[(i+1)%h]:50*S, seed:50*S}
    return out, seed, mem

def add_socks(out, n, base=900000):
    """n socks, each attesting to the next in a ring — reachable from nobody."""
    socks=[A(base+i) for i in range(n)]
    for i,s in enumerate(socks):
        out[s]={socks[(i+1)%n]:50*S}
    return socks

print("P14 — outsider bloc share, shipped params (d=.85, mult=2, decay=.8)")
print(f"{'socks':>7} {'ts=1.0':>10} {'ts=0.15':>10} {'ts=0.15+F15':>13} {'ts=0.5':>10}")
for n in [0,10,50,200,1000]:
    row=[]
    for ts,f15 in [(1.0,False),(0.15,False),(0.15,True),(0.5,False)]:
        out,seed,mem = honest_community()
        socks = add_socks(out,n) if n else []
        cfg=Cfg(trust_share=ts, seeds={seed}, f15=f15)
        sc=calculate(graph_nodes(out), out, cfg)
        row.append(pct(sum(sc.get(s,0) for s in socks)))
    print(f"{n:>7} {row[0]:>9.2f}% {row[1]:>9.2f}% {row[2]:>12.2f}% {row[3]:>9.2f}%")

print()
print("  cost to the attacker: 1 attestation per sock, zero social contact.")

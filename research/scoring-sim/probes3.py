from tg import *
def A(i): return '0x'+format(i,'040x')

print("F5d's bootstrap cliff: a brand-new network where nobody has vouched for the founder yet")
SEED=A(1)
out={SEED:{A(200):50*S, A(201):50*S, A(202):50*S}}
out[A(200)]={A(201):50*S}; out[A(201)]={A(202):50*S}; out[A(202)]={A(200):50*S}
socks=[A(900+i) for i in range(200)]
for i,s in enumerate(socks): out[s]={socks[(i+1)%200]:50*S}
for label,kw in [("today (unconditional prior)", dict()),
                 ("F15 only",                    dict(f15=True)),
                 ("F5d as written (uniform fallback)", dict(f5d=True)),
                 ("F5d + F15 together",          dict(f5d=True,f15=True))]:
    cfg=Cfg(trust_share=1.0, trust_multiplier=1.0, seeds={SEED}, **kw)
    sc=calculate(graph_nodes(out),out,cfg)
    print(f"  {label:<36} sock bloc = {pct(sum(sc.get(s,0) for s in socks)):6.2f}%  founder = {pct(sc.get(SEED,0)):6.2f}%")
print("  => F5d alone REOPENS the gate at genesis. It is only safe stacked on F15.")

print("\nHow many seeds? (a fully repudiated seed's permanent floor, trust_share = 1)")
def repud(nseeds, n=40):
    out={}; seeds={A(1+i) for i in range(nseeds)}; mem=[A(100+i) for i in range(n)]
    for j,s in enumerate(sorted(seeds)): out[s]={mem[j]:50*S}
    for i,m in enumerate(mem): out[m]={mem[(i+1)%n]:50*S, mem[(i+2)%n]:50*S}
    return out, seeds
for k in [1,2,3,5,9]:
    o,seeds=repud(k)
    sc=calculate(graph_nodes(o),o,Cfg(trust_share=1.0,trust_multiplier=1.0,seeds=seeds))
    one=sorted(seeds)[0]
    rank=sorted(sc.items(),key=lambda kv:-kv[1]).index((one,sc[one]))+1
    print(f"  {k} seed(s): each un-vouched seed holds {pct(sc[one]):6.3f}%  (rank {rank})   all seeds = {pct(sum(sc[s] for s in seeds)):.2f}%")

print("\nWhat trust_decay buys: reach vs. dilution (chain of 12 from the seed, trust_share=1)")
o={}; chain=[A(1)]+[A(300+i) for i in range(12)]
for i in range(len(chain)-1): o[chain[i]]={chain[i+1]:50*S}
for dec in [0.5,0.8,0.9,0.95,1.0]:
    sc=calculate(graph_nodes(o),o,Cfg(trust_share=1.0,trust_multiplier=1.0,trust_decay=dec,seeds={A(1)}))
    tail=[f"{pct(sc[chain[d]]):.3f}" for d in (1,4,8,12)]
    print(f"  decay={dec:<5} d1={tail[0]:>7}%  d4={tail[1]:>7}%  d8={tail[2]:>7}%  d12={tail[3]:>7}%")

print("\nMultiplier: what does it actually buy at the shipped default?")
o={A(1):{A(200):50*S,A(201):50*S}, A(200):{A(201):50*S,A(1):50*S}, A(201):{A(200):50*S,A(1):50*S}}
for m in [1.0,1.17,2.0,4.0]:
    sc,it,conv=calculate(graph_nodes(o),o,Cfg(trust_share=1.0,trust_multiplier=m,seeds={A(1)}),return_iters=True)
    scf=calculate(graph_nodes(o),o,Cfg(trust_share=1.0,trust_multiplier=m,seeds={A(1)},fix_multiplier=True))
    print(f"  mult={m:<5} seed={pct(sc[A(1)]):6.3f}% (iters {it:>3}, converged {conv})   conservation-fixed seed={pct(scf[A(1)]):6.3f}%")

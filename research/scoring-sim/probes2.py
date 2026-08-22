from tg import *
def A(i): return '0x'+format(i,'040x')
SEED=A(1)

def world(depth=3, socks=0, reciprocal=True):
    out={}; chain=[SEED]+[A(400+i) for i in range(depth)]
    for i in range(len(chain)-1): out[chain[i]]={chain[i+1]:50*S}
    for j in range(6): out[SEED][A(500+j)]=50*S
    for j in range(6): out[A(500+j)]={A(500+(j+1)%6):50*S}
    actor=chain[-1]; ss=[A(700+i) for i in range(socks)]
    out.setdefault(actor,{})
    for s in ss:
        out[actor][s]=50*S
        if reciprocal: out[s]={actor:50*S}
    return out, actor, ss

cfg=Cfg(trust_share=1.0, trust_multiplier=1.0, seeds={SEED}, f15=True)
print("Is P4 about the NUMBER of identities, or about closing the loop?")
base=pct(calculate(graph_nodes(world(3,0)[0]),world(3,0)[0],cfg)[world(3,0)[1]])
print(f"  actor alone: {base:.4f}%")
for recip in [True,False]:
    for k in [1,2,5,20]:
        o,a,ss=world(3,k,recip)
        sc=calculate(graph_nodes(o),o,cfg)
        bloc=pct(sc.get(a,0)+sum(sc.get(x,0) for x in ss))
        print(f"  {k:>2} socks, vouch back = {str(recip):<5} -> bloc {bloc:6.3f}%  ({bloc/base:.2f}x)")

print("\n  => the gain is the RETURN PATH, not the head-count. One reciprocal edge captures it all;")
print("     socks that do not vouch back are a pure loss. Same root cause as P5.")

print("\nSeed-divisor bug: is it real, and where?")
o={SEED:{A(200):50*S,A(201):50*S}, A(200):{A(201):50*S,SEED:50*S}, A(201):{A(200):50*S}}
for ts in [1.0, 0.5, 0.15]:
    a=calculate(graph_nodes(o),o,Cfg(trust_share=ts,trust_multiplier=1.0,seeds={SEED}))
    b=calculate(graph_nodes(o),o,Cfg(trust_share=ts,trust_multiplier=1.0,seeds={SEED,A(0xdead),A(0xbeef)}))
    c=calculate(graph_nodes(o),o,Cfg(trust_share=ts,trust_multiplier=1.0,seeds={SEED,A(0xdead),A(0xbeef)},fix_seed_divisor=True))
    print(f"  trust_share={ts:<5} 1 seed {pct(a[SEED]):6.3f}%   +2 absent {pct(b[SEED]):6.3f}%   fixed {pct(c[SEED]):6.3f}%")
print("  => a no-op at trust_share = 1 (the final normalise cancels it); real only below 1.")

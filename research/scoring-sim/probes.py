from tg import *
def A(i): return '0x'+format(i,'040x')
SEED=A(1)

def repudiated_seed(n=30):
    """A seed nobody vouches for, in a community that vouches among itself."""
    out={}; mem=[A(100+i) for i in range(n)]
    out[SEED]={mem[0]:50*S}                     # seed vouched for member 0 once
    for i,m in enumerate(mem):
        out[m]={mem[(i+1)%n]:50*S, mem[(i+2)%n]:50*S}   # nobody points back at the seed
    return out, mem

print("P2 — the seed floor, at trust_share = 1 (a seed NOBODY vouches for)")
print(f"  {'community':>10} {'seed share':>12} {'rank':>6} {'w/ F5d':>9} {'rank':>6}")
for n in [10,30,100,300]:
    row=[]
    for f5d in [False,True]:
        out,mem=repudiated_seed(n)
        cfg=Cfg(trust_share=1.0, trust_multiplier=1.0, seeds={SEED}, f5d=f5d)
        sc=calculate(graph_nodes(out),out,cfg)
        rank=sorted(sc.items(), key=lambda kv:-kv[1]).index((SEED,sc[SEED]))+1
        row += [pct(sc[SEED]), rank]
    print(f"  {n:>10} {row[0]:>11.3f}% {row[1]:>6} {row[2]:>8.3f}% {row[3]:>6}")

print("\n  invariant to community size = the floor is topology+damping, not size.")

print("\nP5 — is it cheaper to endorse a dead end than the most-trusted account?")
def base_world():
    out={SEED:{A(200):50*S, A(201):50*S, A(202):50*S}}
    out[A(200)]={A(201):50*S, SEED:50*S}
    out[A(201)]={A(202):50*S, SEED:50*S}
    out[A(202)]={A(200):50*S}
    return out
ACTOR=A(300)
for label, extra in [("abstains (vouches for nobody)", {}),
                     ("endorses a dead-end sock",      {A(999):50*S}),
                     ("endorses the top account",      {A(201):50*S})]:
    out=base_world(); out[SEED][ACTOR]=50*S
    out[ACTOR]=dict(extra) if extra else {}
    if not out[ACTOR]: del out[ACTOR]
    cfg=Cfg(trust_share=1.0, trust_multiplier=1.0, seeds={SEED})
    sc=calculate(graph_nodes(out),out,cfg)
    print(f"  {label:<32} actor = {pct(sc[ACTOR]):6.3f}%")

print("\nP4 — does minting socks pay, INSIDE the gate (trust_share = 1, F15 on)?")
def inside(depth, socks):
    out={}; chain=[SEED]+[A(400+i) for i in range(depth)]
    for i in range(len(chain)-1): out[chain[i]]={chain[i+1]:50*S}
    out.setdefault(SEED,{})
    for j in range(6): out[SEED][A(500+j)]=50*S      # honest bystanders
    for j in range(6): out[A(500+j)]={A(500+(j+1)%6):50*S}
    actor=chain[-1]
    ss=[A(700+i) for i in range(socks)]
    out.setdefault(actor,{})
    for s in ss:
        out[actor][s]=50*S
        out[s]={actor:50*S}                            # reciprocal cell
    return out, actor, ss
for depth in [1,3,6]:
    outb,actor,_=inside(depth,0)
    cfg=Cfg(trust_share=1.0, trust_multiplier=1.0, seeds={SEED}, f15=True)
    base=pct(calculate(graph_nodes(outb),outb,cfg)[actor])
    line=f"  depth {depth}: alone {base:6.3f}%  "
    for k in [1,2,3,5,9]:
        o,a,ss=inside(depth,k)
        sc=calculate(graph_nodes(o),o,cfg)
        bloc=pct(sc.get(a,0)+sum(sc.get(x,0) for x in ss))
        line+=f"| {k} socks {bloc/base:5.2f}x "
    print(line)

print("\nSeed divisor — a configured seed that is not a node still eats a share")
out=base_world()
for label,seeds in [("1 real seed", {SEED}),
                    ("1 real + 2 absent seeds", {SEED, A(0xdead), A(0xbeef)})]:
    cfg=Cfg(trust_share=1.0, trust_multiplier=1.0, seeds=seeds)
    sc=calculate(graph_nodes(out),out,cfg)
    cfgf=Cfg(trust_share=1.0, trust_multiplier=1.0, seeds=seeds, fix_seed_divisor=True)
    scf=calculate(graph_nodes(out),out,cfgf)
    print(f"  {label:<26} seed = {pct(sc[SEED]):6.3f}%   fixed = {pct(scf[SEED]):6.3f}%")

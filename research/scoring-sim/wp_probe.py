from tg import *
from wp import wp_calculate
def A(i): return '0x'+format(i,'040x')
SEED=A(1)
pctf=lambda x:100*x

print("Does the SHIPPED weighted-prior program fix P4/P5/P14? (prior = {founder: 1.0})")
print()
print("P14 — 200 unreachable socks")
out={SEED:{A(200):50*S,A(201):50*S,A(202):50*S}}
out[A(200)]={A(201):50*S}; out[A(201)]={A(202):50*S}; out[A(202)]={A(200):50*S}
socks=[A(900+i) for i in range(200)]
for i,s in enumerate(socks): out[s]={socks[(i+1)%200]:50*S}
sc=wp_calculate(graph_nodes(out),out,{SEED:1.0})
print(f"  sock bloc = {pctf(sum(sc.get(s,0) for s in socks)):.4f}%   founder = {pctf(sc[SEED]):.2f}%")

print("\nP5 — is abstaining still better than endorsing?")
def base():
    o={SEED:{A(200):50*S,A(201):50*S,A(202):50*S}}
    o[A(200)]={A(201):50*S,SEED:50*S}; o[A(201)]={A(202):50*S,SEED:50*S}; o[A(202)]={A(200):50*S}
    return o
ACT=A(300)
for label,extra in [("abstains",{}),("endorses a dead-end sock",{A(999):50*S}),("endorses the top account",{A(201):50*S})]:
    o=base(); o[SEED][ACT]=50*S
    if extra: o[ACT]=dict(extra)
    sc=wp_calculate(graph_nodes(o),o,{SEED:1.0})
    print(f"  {label:<26} actor = {pctf(sc[ACT]):6.3f}%")

print("\nP4 — does minting socks still pay?")
def world(depth=3,socks=0,recip=True):
    o={}; chain=[SEED]+[A(400+i) for i in range(depth)]
    for i in range(len(chain)-1): o[chain[i]]={chain[i+1]:50*S}
    for j in range(6): o[SEED][A(500+j)]=50*S
    for j in range(6): o[A(500+j)]={A(500+(j+1)%6):50*S}
    a=chain[-1]; ss=[A(700+i) for i in range(socks)]
    o.setdefault(a,{})
    for s in ss:
        o[a][s]=50*S
        if recip: o[s]={a:50*S}
    return o,a,ss
o,a,_=world(3,0); b=pctf(wp_calculate(graph_nodes(o),o,{SEED:1.0})[a])
print(f"  actor alone: {b:.4f}%")
for recip in (True,False):
    for k in (1,2,5,20):
        o,a,ss=world(3,k,recip); sc=wp_calculate(graph_nodes(o),o,{SEED:1.0})
        bloc=pctf(sc.get(a,0)+sum(sc.get(x,0) for x in ss))
        print(f"  {k:>2} socks, vouch back={str(recip):<5} bloc {bloc:6.3f}%  ({bloc/b:.2f}x)")

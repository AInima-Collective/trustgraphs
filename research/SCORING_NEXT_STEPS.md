# Strengthening the trust score: findings and next steps

**Status:** design proposal, 2026-08-21. No production code has been changed.

## Why this is worth doing

The trust score does something unusual and valuable. It answers the question *"how much
standing does this account have, according to people this community already trusts?"* without
anyone maintaining a list, running a committee, or checking identity documents. A newcomer who
nobody has vouched for scores exactly zero, and so does every extra account they create for
themselves. Standing has to be granted by someone who already has it. That single property is
what makes the score usable for handing out money and for choosing who holds the keys.

That property is real and it is worth protecting. This document is about protecting it better,
and about what the score could learn to say next.

Two things prompted it. A colleague, Christian Oudard, wrote a game-theory review of the
mechanism and found a set of problems worth taking seriously. Separately, we want the score to
be able to represent something it currently cannot: that someone did business with a member and
it went badly.

## How the findings were checked

Everything below is measured, not argued. We built an independent model of the scoring function
directly from the production Rust, and confirmed it reproduces the shipped reference vectors
exactly, to the last digit of every payout. Where a number appears here, it came out of the same
arithmetic the network actually runs.

For anything involving real behaviour rather than a constructed example, we used the Bitcoin OTC
web of trust: 5,881 accounts and 35,592 signed ratings collected from a real over-the-counter
trading community, 10% of which are negative. It is the closest thing available to a public
record of people rating each other's trustworthiness with money on the line.

## What already works, and must keep working

Before proposing changes, these are the properties the current design has. Nothing below should
cost us any of them.

- **Standing must be granted.** An account nobody vouched for scores zero, and an entourage of
  fifty accounts it created itself also scores zero.
- **Casting someone out reaches their fabrications.** Removing a member's support also removes
  every account that only had standing through them.
- **A withdrawn vouch really is withdrawn**, and only its author can withdraw it.
- **Splitting across identities gains nothing.** A cluster's total standing is capped by the
  vouches that admitted it, not by how many accounts it spreads across.
- **Introductions carry.** A vouch from someone with high standing is worth more than one from
  someone with low standing, and vouching indiscriminately is worth less per vouch.
- **The whole pool gets paid out**, and withdrawing support genuinely moves money to the people
  who kept theirs.

## Findings

### 1. The admission gate depends on one setting, and the setting is wrong in several places

The "starting share" setting controls how much of the initial standing goes to the founding
accounts. Whatever is left over is split evenly across every other account in the graph,
**including accounts that no trusted path reaches.** At a starting share of 100% there is no
leftover, and the gate is absolute. At anything less, an outsider holds a permanent slice simply
by existing, and can mint as many accounts as it likes, each drawing its own slice.

Measured against an honest community of ten, using the settings currently written into the
repository's reference vectors:

| accounts the outsider mints | outsider's share of all standing |
|---|---|
| 10 | 15.7% |
| 50 | 33.8% |
| 200 | **43.0%** |
| 1000 | 46.4% |

The cost is one attestation per account and no contact with any human being. At 200 accounts the
outsider holds a bloc large enough to swing governance and to take nearly half of every payout.

The network creation flow already defaults to 100% and warns twice if you lower it, which is
good. The exposure is elsewhere: the example deployment script, the shared parameter file at the
repository root, and all five cross-language reference vectors are pinned at 15%.

**Correcting one thing from the earlier review:** these settings are not frozen at creation. The
contract only freezes the fields that define an instance's identity. Starting share, damping,
distance decay and the boost can all be changed later through a governed parameter update. An
instance created at a bad setting is recoverable.

### 2. The "trusted-account boost" does the opposite of what its name says

The creation flow offers a setting labelled "how much a vouch from a starting account counts,"
defaulting to 2. Raising it does not boost anything. It multiplies what a founding account sends
out without changing what it holds, which means the founder gives away more than it has.

| boost | the founder | an account the founder vouched for | an account it did not | ratio between the last two |
|---|---|---|---|---|
| 1 | 32.50% | 32.93% | 12.18% | **2.703** |
| 2 | 19.40% | 39.32% | 14.54% | **2.703** |
| 4 | 10.75% | 43.54% | 16.11% | **2.703** |

The ratio in the last column is identical at every setting, to three decimal places. The boost
changes nothing about who ranks above whom. Its only effects are to dilute the founders and to
break the calculation's stopping rule: above a boost of about 1.18 the numbers grow every round
and the convergence check never fires. The shipped reference vector runs all 100 rounds and stops
because it hit the ceiling, not because it settled.

This appears to be a setting that was added early and never had a purpose. **The recommendation
is to remove it.**

### 3. The two problems have been hiding each other

This is the most important operational finding, because it makes the order of the fixes matter.

The mass the boost invents flows through the honest part of the graph, which makes the honest
side look larger and the outsider's fixed slice look smaller. Fix the boost on an instance that
still has a low starting share and the outsider's share roughly quadruples:

| | boost at 2 (as shipped) | boost at 1 |
|---|---|---|
| outsider bloc, 200 minted accounts | 14.0% | **51.7%** |

**Neither change should ship without the other.** Removing the boost, restricting the starting
balance, and pinning the starting share to 100% are one change, not three.

### 4. Founders hold a floor that no amount of community action can remove

A founding account's starting balance does not depend on anything anyone does. It is granted by
configuration and re-granted every round. Measured with a single founding account that nobody
ever vouches for, in a community that actively vouches among itself:

| community size | founder's share | founder's rank |
|---|---|---|
| 10 | 33.6% | 1st |
| 30 | 33.7% | 1st |
| 100 | 33.7% | 1st |
| 300 | 33.7% | 1st |

The floor does not shrink as the community grows. A founder the entire community has repudiated
still ranks first in a network of three hundred people, and still takes a third of every payout.
Using more founding accounts spreads this out (five founders puts each at 6.2% and 7th place) but
does not remove it.

### 5. Vouching costs you, and the most trustworthy people cost the most to support

Standing behaves like a fluid: it flows out along your vouches. Since the final scores are
normalised to a fixed total, sending standing to someone else lowers your own share. Measured:

| what the account does | its share |
|---|---|
| vouches for nobody | **9.04%** |
| vouches for a dead-end account it made up | 8.51% |
| vouches for the most-trusted account present | 8.18% |

Endorsing a real, well-regarded member is the worst of the three. The precise rule is that
vouching costs you unless it is reciprocated, so the mechanism rewards mutual back-scratching
rather than good judgement. A discriminating person is less likely to vouch back, which makes the
most careful members the most expensive to support.

### 6. What looked like a fake-account problem is really a closed-loop problem

The earlier review reported that minting accounts is profitable at every depth in the graph. That
is true, but the shape is different from what it looks like:

| fake accounts minted | gain if they vouch back | gain if they do not |
|---|---|---|
| 1 | 1.68x | 1.43x |
| 2 | 1.68x | 1.43x |
| 5 | 1.68x | 1.43x |
| 20 | 1.68x | 1.43x |

The gain is completely flat in the number of accounts. One is worth exactly as much as twenty.
What pays is not the head count, it is the **return path**: a fake account is somewhere your
outflow lands that you still control, and a vouch back turns it into a loop that recirculates.
This is the same disease as finding 5, seen from the other side. Any defence aimed at counting
identities will miss it.

### 7. Distance decay is the only brake on this, and it is a genuine trade-off

"Distance decay" controls how much a vouch is worth per step away from a founding account. It
turns out to be the only setting that suppresses the closed-loop gain, and it buys that
suppression by shortening how far trust travels:

| distance decay | gain from a reciprocal fake account | how far standing reaches | founder floor |
|---|---|---|---|
| 0.6 | 1.21x | 5 hops | 40.8% |
| 0.7 | 1.37x | 5 hops | 37.7% |
| **0.8 (current)** | **1.68x** | **7 hops** | **33.6%** |
| 0.9 | 2.42x | 9 hops | 28.0% |
| 1.0 | 6.17x | no distance limit | — |

There is no correct answer here. A small, tight community wants a low number. A large, sprawling
one wants a high number and accepts more gaming. This is a real product choice and it should stay
a setting, with this table published next to it so the choice is informed.

### 8. The score has no clock

Nothing in the calculation reads a timestamp except to put events in order. Consequences:

- An account whose owner has died holds its score unchanged forever, and keeps collecting its
  share of every payout into an address nobody can open.
- Its vouches never expire, so it goes on conferring standing indefinitely.
- Because the Safe's signers are chosen purely by score, and a dead account's score never moves,
  **re-running the signer sync re-installs the dead rather than replacing them.** Three dead
  signers out of five is enough to lock the Safe permanently.
- A brand-new account and an account that has just been thrown out are indistinguishable from
  each other, which is exactly the condition under which abandoning a bad reputation is free.

### 9. Punishing someone always pays, and that is arithmetic, not a bug

This one is worth stating carefully, because it explains a contradiction the earlier review left
open and it constrains everything in the next section.

Scores are shares of a fixed total. If a mechanism lowers one account's standing, the total falls
with it, and after normalising **everyone else's share rises.** Measured, in a five-member
community where one member successfully discredits another:

| | the accused | the accuser | an uninvolved bystander |
|---|---|---|---|
| change in share | -3.53% | **+0.09%** | **+0.09%** |
| change in payout | -35,333 | **+944** | **+944** |

The accuser profits, by exactly as much as everybody who did nothing. So the design principle
"accusing someone should be costly or neutral for the accuser" is **impossible in a
share-of-total metric** unless the mechanism explicitly accounts for what it removed. That is the
same reason removing a co-founder raises every remaining founder's floor.

There is a clean fix and it is measured in the next section.

## Proposal

### Tier 1: settings to change now

These need no new algorithm. They are values in configuration files and defaults in code.

| what | from | to | why |
|---|---|---|---|
| starting share, everywhere | 15% | **100%** | closes the admission gate |
| trusted-account boost | 2 (3 in the dev config) | **1**, then remove it | it does nothing useful and stops the calculation from settling |
| founding accounts | 1 | **3 to 5** | one founder means one permanent unremovable first place |
| distance decay | 0.8 | **stays a choice**, documented with the table in finding 7 | it is a real trade-off, not a mistake |
| governance quorum | 4% of voting power, counted over decisive votes | **raise the default** | as it stands, roughly 4% passes anything nobody contests |

The starting share and the boost must move together. See finding 3.

### Tier 2: changes to the algorithm

**Restrict the starting balance to accounts the network can actually reach.** Today the leftover
starting balance is divided across every account in the graph. It should be divided only across
accounts reachable from a founding account, and unreachable accounts should get nothing, which is
already how they are treated when they try to pass standing on. This is about five lines in one
function, mirrored in the browser implementation.

It changes nothing at a starting share of 100%, and at every other setting it is the difference
between an absolute admission gate and a stranger holding half the network. It makes tier 1's
first row a safety belt rather than the only defence.

**Make the founders' starting balance conditional on being vouched for.** Configuration would say
who *may* hold a founder's share, and the graph would say who actually does. A founder that
nobody vouches for gets nothing and falls like anyone else.

One correction to how this was originally proposed: the fallback matters enormously. If it falls
back to spreading the balance evenly when no founder is vouched for, **it reopens the admission
gate on day one**, before anyone has had a chance to vouch for the founder. Measured with 200
fabricated accounts against a brand-new network, the fabricated bloc takes 93.9% and the founder
drops to 0.5%. The fallback must be *keep the configured balance*, never *spread it evenly*.

With that correction it is a strong change:

| | founder's share | founder's rank |
|---|---|---|
| today | 33.6% | 1st of 31 |
| with an earned starting balance | 2.4% | 31st of 31 |

**Give the signer sync a liveness signal.** The dead-signer deadlock is not reachable from any
scoring change, because the problem is that a score cannot know its holder stopped acting. The
module needs a per-account last-activity input of its own.

**Weight vouches by how long they have stood.** Timestamps are already recorded and already
ordered by consensus. Even a simple rule (a vouch reaches full weight after some months) removes
the freshness advantage that makes abandoning a bad reputation attractive.

**Fix the timelock deployment script.** Independent of everything else. One command-line argument
currently sets both the proposer and the canceller on both tiers of timelock, and a comment in
that script states that the timelock has no administrator. That is not correct for the version of
OpenZeppelin in use: the constructor grants the contract administration over itself
unconditionally, and grants cancellation rights to every proposer. With a two-person founding
multisig, either configuration deadlocks if one of them turns hostile.

### Here is what tier 1 and tier 2 add up to

| | shipped today | tier 1 settings | plus an earned starting balance |
|---|---|---|---|
| a stranger with 200 fabricated accounts | 24.5% | **0.00%** | **0.00%** |
| a founder nobody vouches for | 8.4%, 2nd place | 12.1%, 3rd place | **1.8%, 41st place** |
| gain from one reciprocal fake account | 2.00x | **1.37x** | **1.37x** |
| rounds needed to settle | 89 | **26** | **26** |

Note the second row. Closing the admission gate *makes founder entrenchment worse*, because all
the initial standing now sits with the founders by construction. The earned starting balance is
what pays that back. This is the clearest argument that these changes belong in one release.

### Tier 3: new capability, complaints

This is the part that is genuinely new, and the rest of this document is about it.

## Complaints: letting the graph say that something went wrong

Right now the graph can say "I vouch for you" and it can say "I take that back." It cannot say
"I did business with this person and they defrauded me." Withdrawing a vouch and never having
made one produce byte-identical results.

That blind spot has a specific shape. Accounts with many complaints and few vouches already rank
low, but only because they lack support, not because the complaints registered. The profile the
mechanism genuinely cannot see is the ordinary scam: **a high-volume actor with many satisfied
counterparties and many defrauded ones.** In the Bitcoin OTC data, 10% of all ratings are
negative and are simply discarded, and two accounts with more than forty complaints each sit in
the top 1% of the scoreboard.

### The design

A complaint is a new kind of attestation alongside a vouch. It carries a weight, it can be
withdrawn by its author, and it reconciles exactly the way vouches already do. The attestation
format already has a spare field for exactly this kind of extension, so nothing about how inputs
are committed or proven has to change.

Scoring it is the hard part, and there is one rule that makes it behave:

> **A complaint's force is its author's standing.** What is scored is not how many complaints an
> account has, but what share of the standing-weighted evidence about it is positive.

Concretely, each account gets a multiplier between 0 and 1 applied to the trust flowing *into*
it, equal to the standing behind its vouches divided by the standing behind its vouches plus its
complaints. A settable "complaint weight" says how many compliments one complaint is worth.
Because an account's standing is itself an output, this is solved by alternating between the two
until both settle, which it does reliably in every case we measured.

Three properties fall out of this rule rather than being bolted on:

- **Scores never go negative,** so everything downstream keeps working unchanged.
- **Complaints do not propagate.** Yours counts against the person you name, and stops there. The
  research literature on trust and distrust reached this conclusion twenty years ago: "the enemy
  of my enemy" has no coherent meaning in a trust graph.
- **A complaint from a stranger is worth nothing,** for the same reason a vouch from a stranger
  is worth nothing. The admission gate protects the complaint channel automatically.

### What it does on real data

Running this over the Bitcoin OTC graph, with the five earliest accounts as founders:

| complaint weight | account A (41 complaints, 270 vouches) | account B (45 complaints, 234 vouches) | account C (75 complaints, 6 vouches) |
|---|---|---|---|
| complaints ignored (today) | rank 21 | rank 33 | rank 1101 |
| 1 | rank 21 | rank 99 | rank 5211 |
| 3 | rank 22 | rank 190 | rank 5225 |
| 10 | rank 23 | rank 456 | rank 5247 |
| 20 | rank 24 | rank 728 | rank 5248 |

Account C, the obvious case, falls to the bottom of the 5,411 accounts that score at all, and stays there. Account B
falls out of the top 100 as soon as complaints count at all.

**Account A does not move at any setting, and understanding why is the most important result in
this document.**

| | who is complaining |
|---|---|
| account A | 41 complainants, holding **0.157%** of all standing between them, median rank 5107 |
| account B | 45 complainants, holding **11.8%** of all standing, median rank 316 |
| account C | 75 complainants, holding 8.3% of all standing, median rank 324 |

The rule that makes complaints immune to fabricated accounts is the same rule that makes them
blind to a scammer who only ever defrauds newcomers. This is not a tuning problem. It is the
honest price of the design, and it needs to be said plainly in the product: **complaints protect
the people the network already trusts. They do not protect strangers.**

### Making sure complaints cannot be used as a weapon

**Can fabricated accounts smear someone?** They can try, and their combined force is capped by
the standing of whoever admitted them, so it saturates quickly:

| fabricated accounts complaining | damage done to the target |
|---|---|
| 1 | -0.63% |
| 5 | -1.70% |
| 20 | -2.44% |
| 100 | -2.72% |

One real member complaining does -3.91%. A hundred fabricated accounts do less than one real
person, and the twenty-first adds almost nothing.

**Does retaliation spiral?** No. Every configuration we ran settles:

| | the accuser | the accused | an uninvolved bystander |
|---|---|---|---|
| nobody complains | 9.58% | 9.58% | 9.58% |
| A complains about B | 9.40% | 7.32% | 9.40% |
| A and B complain about each other | 7.53% | 7.53% | 9.28% |
| A complains about B, B's two allies complain about A | 5.87% | 7.75% | 9.18% |

Mutual accusation is symmetric: both parties lose and neither gains an advantage over the other.

**Can a majority silence someone?** Yes, and it should be able to. Five members out of six can
take a target from 9.6% to 3.8%. That is the same power the community already has by all
withdrawing their vouches. Complaints make it faster and more legible, not newly possible. Worth
noting that complaints alone never reach zero: the multiplier approaches zero but never gets
there, so **complaints degrade standing while withdrawal removes it.** The two do different jobs
and both should exist.

### Choosing the complaint weight is the network's choice

The complaint weight says how many compliments one complaint is worth. Like distance decay,
there is no single right answer, so it belongs to the network rather than to the protocol.

Measured on a nine-member network, showing what happens to the account being complained about:

| complaint weight | one complaint | a third of the network | two thirds | everyone else | pool left unspent |
|---|---|---|---|---|---|
| **0 (complaints ignored)** | 7.58% | 7.58% | 7.58% | 7.58% | 0.00% |
| 1 | 7.01% | 6.11% | 5.13% | 4.64% | 1.49% |
| **2** | 6.53% | 5.13% | 3.89% | 3.36% | 2.47% |
| **3** | 6.11% | 4.43% | 3.14% | 2.64% | 3.18% |
| 5 | 5.42% | 3.48% | 2.27% | 1.85% | 4.14% |
| 10 | 4.23% | 2.27% | 1.35% | 1.06% | 5.35% |
| 20 | 2.96% | 1.35% | 0.74% | 0.57% | 6.29% |

The same dial read as risk rather than as effect, which is the number a network should actually
be looking at when it chooses:

| complaint weight | standing a single member can remove on their own say-so |
|---|---|
| 1 | 7.5% |
| 2 | 13.9% |
| 3 | 19.4% |
| 5 | 28.6% |
| 10 | 44.2% |
| 20 | 61.0% |
| 50 | 79.5% |

Four things follow.

**Zero is a real setting, and it should be the migration path.** A network that sets the weight to
zero behaves exactly as it does today. That makes complaints opt-in per network, and it means
existing networks are unaffected until their members decide otherwise.

**There should be an upper bound in the validator.** Above roughly 10, one member of nine can take
nearly half of a peer's standing on their own say-so, which is more power than any single account
should have. Cap it the way the other scoring parameters are capped. A default of 2 to 3 puts a
lone complaint at 14% to 19% of a target's standing, which is enough to be worth reading and not
enough to be worth abusing.

**Piling on with fabricated accounts saturates below 2x.** A member who mints accounts to make the
same complaint many times gains less than one extra voice, because fabricated accounts can only
re-spend standing their owner already had:

| accounts minted to pile on | force compared to complaining once |
|---|---|
| 5 | 1.24x |
| 20 | 1.45x |
| 100 | 1.57x |
| 500 | 1.60x |

**Governance can change it, and that cuts both ways.** Like the other scoring parameters, the
weight is mutable through a governed update. A captured governance could set it to zero to shield
an insider, or raise it to use complaints as a weapon. This is not a new power, since governance
can already change which accounts are the founding accounts, but it belongs on the list of
settings a network's members should watch.

### The withheld share: making punishment cost something

Finding 9 showed that lowering someone's score is a windfall for everyone else, including
whoever caused it. The fix is to stop pretending the removed standing went somewhere.

Instead of renormalising it away, **track it.** The standing a complaint removes goes into a
withheld slot that counts in the denominator and receives no payout. Its share of the pool is
simply not spent.

| | the accused | the accuser | a bystander | withheld | pool paid out |
|---|---|---|---|---|---|
| as the metric works today | -35,333 | **+944** | **+944** | 0 | 1,000,000 |
| with a withheld share | -39,086 | **-4,245** | **-4,245** | 3.96% | 960,420 |

The windfall becomes a shared cost. Nobody profits from a complaint, and the accounting now says
something true: the community really did lose something when it lost confidence in a member, and
that loss should show up as unspent, not as a bonus for everyone still standing.

This also resolves the founder question directly. Removing a founder should not be a raise for
the remaining founders, and with a withheld share it is not.

## Honest limits

Things this proposal does not fix, stated plainly so nobody has to rediscover them.

- **Complaints protect insiders, not strangers.** Covered above. It follows from the same
  property that makes them resistant to fabricated accounts, and we do not think you can have one
  without the other.
- **A correct minority is still unrepresentable.** The score aggregates agreement, so being early
  and right is indistinguishable from being wrong. Anyone using this to protect whistleblowers or
  dissenting positions should know that going in.
- **Redemption and whitewashing are the same operation.** Someone who was wrongly suspected and
  then vindicated, and someone who was guilty and talked their way back, produce identical graphs.
  Anything that makes it expensive to shed a bad reputation makes it equally expensive to recover
  from a false accusation, and hits the wrongly accused hardest. Complaints need an expiry or a
  recovery path, and the honest version decays with sustained re-endorsement rather than with time
  alone.
- **Closed loops still pay.** Findings 5 and 6 have no fix here. Distance decay bounds the gain
  and nothing else does. This is the most interesting remaining research question and it needs a
  cycle-aware approach rather than an identity-aware one.
- **Optimal attack size is public.** The scoreboard is published and its integrity is proven, so
  an attacker can read the exact rank cutoff. This is inherent to verifiability and is not a
  defect, but it does mean defences have to be structural, because anything statistical is being
  published against.

## Things considered and rejected

**A max-flow capacity metric.** The academic literature points here, and it does bound fabricated
accounts properly. It was measured and it starves honest communities: at 150 honest members, 122
of them score zero, not because they are untrusted but because the founding accounts' capacity ran
out, and which 122 depends on the order the algorithm happened to explore paths. Raising the
capacity budget to fix that puts back exactly the headroom the metric exists to remove. This trades
a bounded fabrication problem for an unbounded membership problem, which is worse for a system
whose job is to enrol people and pay them.

**Making a voucher liable for a bad vouch.** Four separate approaches were tried and all failed
for the same reason: scores are normalised to a fixed total, so a penalty that multiplies an
account's standing shrinks everyone downstream of it by the same factor and the ratio does not
move. A penalty that works has to be additive against a fixed reference point, and a
share-of-total metric does not have one. The withheld share is the first thing we have found that
creates such a reference, so this is worth revisiting once it exists, but not before.

## Sequencing

1. **Settings and the deployment script.** No algorithm change, no new proof key, no coordination.
   Correct the starting share and the boost everywhere, add more founding accounts to the
   templates, publish the distance-decay guidance, and split the timelock roles.
2. **The scoring changes, as one release.** Restrict the starting balance to reachable accounts,
   remove the boost, make the founders' balance earned. These change the reference vectors and
   produce a new proof key, so they ship together and go out to existing networks through the
   governed verifier swap.
3. **Liveness for the signer sync, and vouch age.** Independent of the above and of each other.
4. **Complaints.** The largest piece. Needs a new attestation kind, the scoring rule, the withheld
   share, a per-network complaint weight with a validator bound, and a decision about the recovery
   path before anything is built. Worth prototyping
   against the Bitcoin OTC data first, since that is where the interesting failures showed up.

## Sources

The measurements come from an independent model of the production scoring code, verified against
the shipped reference vectors. The real-data results use the Bitcoin OTC web-of-trust dataset
(Kumar et al., Stanford SNAP), 5,881 accounts and 35,592 signed ratings.

Prior work that shaped the design: Cheng and Friedman on why no rename-invariant reputation
function can be immune to fabricated identities, and why a trust anchor is what puts a design in
the class where it is achievable. Guha and colleagues on why distrust should propagate at most one
step. Friedman and Resnick on the social cost of cheap pseudonyms, which is the source of the
observation that a newcomer and a maximally-punished account sitting at the same score is what
makes abandoning a bad reputation free. Levien's attack-resistant trust metrics for the capacity
construction that was measured and rejected. Kamvar and colleagues' EigenTrust, which is this
design's direct ancestor.

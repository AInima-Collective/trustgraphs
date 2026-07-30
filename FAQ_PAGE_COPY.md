# trustgraphs FAQ page copy

Route `/faq`, linked from the footer. `[brackets]` are design direction, not copy.
Same voice rules as the landing page: short declaratives, no em-dashes, no jargon before
it's defined.

---

**Page title:** Questions

**Standfirst:** What people ask before they trust a scoreboard.

`[one column, ruled rows, questions open on click. no hero.]`

---

## Basics

**What is an attestation?**
A signed public statement about someone, recorded on-chain through the Ethereum Attestation
Service. A vouch is one kind. You can revoke it later.

**Who picks the starting accounts?**
Your community does, when the network is created. They anchor the whole graph, so choosing
them well is the real work. Everything downstream is math.

**How often do scores update?**
In rounds. Each round freezes the set of vouches at a cut-off, someone proves the new
scores, and the result goes on-chain. Every network sets its own pace, and a settled round
is never recalculated.

---

## Trust and gaming

**Can someone buy a high score?**
Not with money. Buying score means getting genuinely trusted people to vouch for you. What
no algorithm stops is a trusted person vouching badly, which is a problem every community
already has.

**Why don’t bot armies work?**
Score comes from trust flowing out of the starting accounts. A thousand bots vouching for
each other form an island with lots of arrows and nothing flowing in, so none of those
vouches earns any trust. They do still land on the scoreboard. Every account a round has
seen gets an equal slice of whatever head start you did not reserve for your starting
accounts, and the create form reserves 15% by default, so a big enough island can hold a
real share. Set “Head start for your starting accounts” to 100% and an island nobody
vouched for from outside holds nothing.

**Is my data private?**
No. Vouches, rules, code, and scores are all public. That is what makes the scoreboard
checkable by anyone.

**Then what does the zero-knowledge proof hide?**
Nothing. It isn’t there for privacy. It’s there so a whole scoreboard can be verified in
one cheap on-chain check instead of everyone recomputing millions of scores.

**How do you know a prover didn’t leave someone out?**
The chain keeps a running commitment to every attestation as it lands. A proof only
verifies if it consumed exactly that set, so a prover can’t quietly drop the vouches they
dislike or add ones that never happened.

---

## Running a network

**Who can create one?**
Anyone. It takes one transaction and nobody approves it. It appears in the app once the
indexer has caught up with the chain, which takes a minute or two.

**What does it cost?**
Proving costs real money, so each network has a tank to pay whoever produces its
scoreboard, once someone sets its per-round limit. Networks we curate will be proven at our
expense. Pricing for everyone else is still being worked out.

**Do I have to run a server?**
Only if nobody else proves your rounds. Proving is permissionless, so anyone can freeze a
round and land the result, and no operator can lock you out. Today that mostly means you or
us: a tank cannot pay a bounty until someone sets its per-round limit with a direct
contract call, and the networks we curate are proven at our expense. If every machine we
run vanished, anyone could recompute the scores from public data and prove them.

**Can I use the scores somewhere else?**
Yes. The scoreboard downloads as CSV or JSON, and any contract can check one account’s
score against the on-chain root, given the score and its proof.

---

## Status

**Is this ready for production?**
No. The proof loop is built and runs end to end on a test chain, and the pieces around it
are not finished. A network created through the app is governed by one wallet: the timelock
that should hold those powers exists but is not wired up yet. More attestation sources are
in progress.

**Has it been audited?**
Not by an outside firm. Point a network at something you can afford to get wrong.

**Where do I read the details?**
The code and the design docs are open. Start with the plain-language explainer, then the
algorithm spec.

`[link out to the repo, docs/ELI5.md, docs/ALGORITHM.md]`

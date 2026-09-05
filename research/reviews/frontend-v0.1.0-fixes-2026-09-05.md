# Trustgraphs v0.1.0 frontend fixes

Implementation follow-up to [the release review](frontend-v0.1.0-2026-09-05.md), on `next-trustgraphs`.

## Changes

| Review finding | Implemented response |
| --- | --- |
| F01 — Application chain correctness | Application writes, native value, signature requests and receipt tracking explicitly bind to the configured application chain. Application reads in creation, funding, claims and settings use that chain too. Wallet network changes during confirmation cannot redirect receipt polling. |
| F02 — First mainnet application target | Added an explicit Ethereum mainnet target alongside Sepolia and local, including RPC routing and configuration/linker validation. Mainnet requires its own validated deployment manifest; missing configuration fails closed. No mainnet addresses or deployment were invented. |
| F03 — Token precision | Funding history, fees and both claim views share token metadata and exact bigint amount formatting. Each distribution uses its own token's decimals. Failed metadata reads display an unavailable amount and prevent submission. |
| F04 — Financial and health read failures | Initial errors, failed refreshes, loading and successful empty results remain distinct. Failed claims/proofs cannot appear as a confirmed absence of rewards; unreadable settings health cannot appear healthy. Retry actions recover the required reads. |
| F05 — Funding readiness | Funding explains the current prerequisite: connection, correct chain, token metadata, fee quote, proven scores, funding access, balance or allowance. An unresolved prerequisite cannot silently consume a click. Amount parsing rejects unrepresentable token precision. |
| F06 — Keyboard controls | Switches are native buttons with switch semantics and accessible names; decorative tracks are excluded from interaction. Table sorting uses buttons and `aria-sort`. Records expose actual keyboard-accessible links. |
| F07 — Creation recovery and focus | Editable drafts can be restored or discarded after reload. Drafts preserve input, not previously verified metadata, simulations or authority. Standard wizard transitions focus the new heading; invalid submissions focus the first invalid field. Labels, hints and errors are associated with controls. |
| F08 — Mobile reflow | Text inputs default to text, coarse-pointer inputs use readable 16px text, shared controls have larger touch targets, busy action labels wrap within the viewport, and narrow scoring controls stack. |
| F09 — Address interactions | Copy controls and record links are separate interactive elements. Copy failures are visible and touch users can discover copy actions. |
| F10 — Wallet recovery | Contextual actions offer connection and preserve the intended vouch. Wallet switching reports rejected or failed requests; only an unknown-chain response prompts adding a chain. Creation review exposes connection and switching at the point of submission. |
| F11 — Creation expectations | Review states the actual optional ETH prepayment plus gas. Proof pricing must be verified before prepaid creation. Success explains proof eligibility without promising an automatic first proof, offers an invite link, and groups contract records in a disclosure. |
| F12 — Gasless signing clarity | The two signatures explain the vouch and its recording separately. The human summary uses the prepared signed payload. Exact typed-message fields remain available in disclosures; the unrelated schema prompt no longer appears during signature review. Verification states still distinguish recording from finalized independent verification. |
| F13 — Popup bounds | Popups consider the visual viewport, flip above the trigger when appropriate, and scroll internally within available space, including short landscape viewports. |
| F14 — Contrast and labels | Revised shared light/dark muted, warning and error colors; removed additional opacity on affected text; named filtering, token and popup controls. |

## Additional polish and maintenance

- Mobile network members show names and scores together; the graph is shorter and a direct member link avoids unnecessary scrolling. Raw hybrid audit records are collapsed after the primary member view.
- Landing-page navigation remains available outside the graph's JavaScript island. Browsers without WebGL receive a graph fallback linked to the member list. A standard-only creation deployment explains the one available path directly.
- Submitted claims retain transaction progress through reload and indexer lag, with progress per claim for batches. Repriced hashes update immediately; an explicit receipt check and local tracking recovery handle wallet cancellations while the browser was closed. Captured accounts prevent a wallet change from submitting an old claim plan.
- Scoring previews run in a debounced worker. A new input revision terminates obsolete calculation; only the matching result can enable review. The parity-tested scoring algorithm is unchanged.
- Shared draft, token metadata, financial readiness, reward derivation, transaction and wallet-switch helpers reduce duplicated decisions across screens.
- Screenshot builds use the same webpack mode as the application build. CI includes frontend lint and domain/release regression tests, with a dedicated browser regression harness.

## Verification

- `pnpm --dir packages/frontend test` passed the complete domain/source suites and **30 release regressions**. These cover chain/account binding, native value, replacement receipts, wallet switch rejection, configuration isolation, stale signing reviews, financial precision/read failures, pending-claim recovery and draft parsing.
- `pnpm --dir packages/frontend exec tsc --noEmit --incremental false` and `pnpm --dir packages/frontend lint` passed. The native TypeScript 7 compiler was used; generated Next declarations and build directories are excluded from lint.
- The release-manifest validator's **13 tests** passed, preserving the existing default Sepolia contract and requiring explicit mainnet selection.
- A production webpack build passed in a disposable copy with synthetic configuration. The browser harness owns its local API/RPC fixtures, rejects signing/submission requests, and intercepts the wizard's metadata upload.
- The initial **90 viewport/theme samples** covered 15 routes at 320, 390, 768 and 1440px. No initial document overflow or page errors occurred. Twelve reward/funding samples were fixture 404s; the fixture was corrected and those financial screens were subsequently verified at 200 with no overflow.
- The follow-up Chromium check covered nine journeys in both themes: **18 scans with no automated axe violations**, no page errors and no document overflow. WebKit passed all eight targeted journey/theme checks, including invalid-field focus. Firefox passed the form, proposal and reward checks; its unavailable WebGL context exposed the graph fallback fixed in this change. The final home/overview rerun passed all **12 browser/theme checks** across Chromium, WebKit and Firefox, with no page errors or overflow. A forced no-WebGL check also passed.
- The production scoring worker reproduced the existing golden root and returned a 2,000-node preview while the main thread continued responding (20 timer ticks during the final 235ms sample). This verifies the worker/bigint boundary; it is not a performance comparison across devices.

The full self-contained browser harness passed end to end, including the late popup scroll/focus and draft scope regressions. [Verification data](frontend-v0.1.0-fixes-evidence/verification.json), [accessibility log](frontend-v0.1.0-fixes-evidence/accessibility.log), [governance log](frontend-v0.1.0-fixes-evidence/governance.log) and [worker log](frontend-v0.1.0-fixes-evidence/scoring-worker.log) are committed with this report.

Visual examples: [320px busy creation](frontend-v0.1.0-fixes-evidence/saving-320.png), [320px members](frontend-v0.1.0-fixes-evidence/members-320.png), [landscape popup](frontend-v0.1.0-fixes-evidence/simulation-landscape.png), [light overview](frontend-v0.1.0-fixes-evidence/overview-390-light.png), and [graph fallback](frontend-v0.1.0-fixes-evidence/no-webgl-320.png).

Automated accessibility checks supplement keyboard and responsive interaction checks; they do not establish complete accessibility conformance.

To reproduce the self-contained browser checks after installing workspace dependencies:

```sh
pnpm --dir packages/frontend exec playwright install chromium
pnpm --dir packages/frontend smoke:review
```

The browser CI workflow installs Chromium, runs the same harness and uploads its screenshots/logs. It exercises draft restore/clear/scope changes, narrow input and busy-button reflow, error/step focus, keyboard switches and sorting, popup scrolling and focus return, graph fallback, governance editing and the production scoring worker.

## Release checks that require deployed environments

These code changes do not tag or deploy v0.1.0. Mainnet configuration must be generated from the actual Ethereum mainnet deployment. The frontend review does not replace contract, governance or proof-system audits.

Before mainnet, exercise the release against the real testnet contracts, RPC, indexer, storage and relayers: connect and reject wallet requests, switch chains during a pending transaction, fund and claim six-decimal and eighteen-decimal tokens, interrupt a claim batch, restore creation drafts, and complete both gasless signatures through finalized verification. Browser fixtures cannot establish those live service guarantees. Check the main journeys on a physical iPhone and Android phone, including the wallet-app round trip and on-screen keyboard.
